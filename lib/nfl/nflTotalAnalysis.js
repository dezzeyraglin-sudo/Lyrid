// nflTotalAnalysis.js
// Lyrid NFL engine — GAME TOTAL analyst (team-level, not player-level).
//
// A total is team A points + team B points. Each team's points = their OFFENSE vs the
// opponent's DEFENSE, scaled by pace. We project each side from real scoring anchors
// (points_for / points_against per game) plus EPA and pace, then layer additive,
// correlation-shrunk "compounding factors" on top and compare to the posted line.
//
// DISCIPLINE (same as the prop engine):
//   * Factors are ADDITIVE, never multiplicative. Multiplying correlated signals (fast
//     pace × shootout script are partly the SAME thing) manufactures fake locks.
//   * When factors strongly ALIGN, the projection is SHRUNK — aligned signals are
//     correlated, so a board that says "everything over" is when to trust it LEAST.
//   * Near-total plays (projection sitting on the line) are no-plays, not coin flips.
//   * Tiers are PROVISIONAL and START CONSERVATIVE — totals are a thinner edge than props.

// league baselines (stable NFL priors; refine on backtest)
const LG = { ppg: 22.5, total: 45.0, plays_pg: 63.5, off_epa: 0.0, def_epa_allowed: 0.0 };
const PTS_PER_PLAY = 0.32;          // ~ marginal points per extra offensive play
const NEAR_TOTAL_FLOOR = 3.0;       // |proj - line| under this = coin flip = no play
const CAP = 4.0;                    // per-factor point cap (no single signal runs away)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// project one team's points: its offense vs the opponent's defense, averaged (the classic
// "what A scores" + "what B allows" baseline), nudged by offensive EPA edge.
function teamPoints(off, oppDef) {
  const pf = num(off && off.points_for_pg);
  const pa = num(oppDef && oppDef.points_against_pg);
  if (pf == null && pa == null) return null;
  let base = (pf != null && pa != null) ? 0.5 * (pf + pa) : (pf != null ? pf : pa);
  // small EPA shading (offense efficiency above/below league), kept light so it doesn't
  // double-count the points anchors it partly overlaps with
  const epa = num(off && off.off_epa_play);
  if (epa != null) base += clamp((epa - LG.off_epa) * 14, -2.5, 2.5);
  return base;
}

// Build the additive compounding-factor ledger. Each factor is a signed point nudge to the
// TOTAL (+ = toward OVER), z-scored to league and capped. Returns { factors, rawSum }.
function buildFactors({ home, away, homeDef, awayDef, spread, roof, weather }) {
  const F = [];
  const push = (label, pts, note) => { if (pts != null && isFinite(pts) && Math.abs(pts) >= 0.3) F.push({ label, pts: +clamp(pts, -CAP, CAP).toFixed(2), dir: pts >= 0 ? 'over' : 'under', note }); };

  // PACE — combined offensive plays vs league
  const paceH = num(home && home.plays_pg), paceA = num(away && away.plays_pg);
  if (paceH != null && paceA != null) {
    const extraPlays = ((paceH + paceA) / 2 - LG.plays_pg) * 2; // both teams => ~2x the per-team delta
    push('Pace', extraPlays * PTS_PER_PLAY, `${((paceH + paceA) / 2).toFixed(1)} plays/gm vs ${LG.plays_pg} league`);
  }
  // OFFENSE — combined offensive EPA/play
  const oeH = num(home && home.off_epa_play), oeA = num(away && away.off_epa_play);
  if (oeH != null && oeA != null) push('Offenses', ((oeH + oeA) / 2 - LG.off_epa) * 20, `avg off EPA/play ${(((oeH + oeA) / 2)).toFixed(3)}`);

  // DEFENSE — combined pass+rush EPA ALLOWED by both defenses (leaky D => over). Low weight:
  // the points anchors already encode most of the defense, so this only SHADES + shows on the ledger.
  const dEpa = (d) => { const p = num(d && d.pass_epa_allowed), r = num(d && d.rush_epa_allowed); return (p != null && r != null) ? (0.6 * p + 0.4 * r) : null; };
  const dH = dEpa(homeDef), dA = dEpa(awayDef);
  if (dH != null && dA != null) push('Defenses', ((dH + dA) / 2 - LG.def_epa_allowed) * 12, `both D EPA allowed ${(((dH + dA) / 2)).toFixed(3)}`);

  // SCRIPT — a big spread invites a blowout (garbage-time/clock-kill nets fewer points);
  // a tight spread keeps both offenses honest deeper. Signed toward under as |spread| grows.
  if (spread != null && isFinite(spread)) {
    const absS = Math.abs(spread);
    if (absS >= 9) push('Script', -clamp((absS - 9) * 0.35 + 1.0, 0, 3.5), `blowout risk (spread ${absS}) trims garbage-time scoring`);
    else if (absS <= 3) push('Script', 0.8, `tight spread (${absS}) keeps both offenses engaged late`);
  }
  // ENVIRONMENT — dome/closed roof helps scoring; wind/precip hurts it
  const rf = String(roof || '').toLowerCase();
  if (rf === 'dome' || rf === 'closed' || rf === 'indoor') push('Environment', 1.2, 'indoor — no weather drag on passing');
  if (weather) {
    if (num(weather.wind) != null && weather.wind >= 15) push('Weather', -clamp((weather.wind - 15) * 0.18 + 1.0, 0, 3.5), `wind ${weather.wind}mph suppresses passing/kicking`);
    if (weather.precip) push('Weather', -1.5, 'precip — ball security / passing drag');
  }

  const rawSum = +F.reduce((s, f) => s + f.pts, 0).toFixed(2);
  return { factors: F.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)), rawSum };
}

// Correlation shrink: aligned factors are partly the same signal, so shrink a heavily
// one-sided stack. alignment = |net| / |gross| in [0..1]; 1 = every factor same direction.
function correlationShrink(factors, rawSum) {
  if (!factors.length) return { adjSum: 0, alignment: 0, shrunk: false };
  const gross = factors.reduce((s, f) => s + Math.abs(f.pts), 0) || 1;
  const alignment = Math.abs(rawSum) / gross;                  // 1 = fully aligned
  const shrink = 1 - 0.35 * alignment;                          // up to -35% when fully aligned
  const adjSum = +(rawSum * shrink).toFixed(2);
  return { adjSum, alignment: +alignment.toFixed(2), shrunk: alignment >= 0.6 };
}

export function analyzeTotal(ctx) {
  const { line, homeTeam, awayTeam, scoringByTeam = {}, suppressionByTeam = {}, spread, roof, weather } = ctx;
  const home = scoringByTeam[homeTeam], away = scoringByTeam[awayTeam];
  const out = { line: num(line), homeTeam, awayTeam, projected: null, lean: null, softness: null,
                tier_candidate: 'none', factors: [], summary: '', missing: [], provisional: true };

  const missing = [];
  if (!home) missing.push(`scoring for ${homeTeam}`);
  if (!away) missing.push(`scoring for ${awayTeam}`);
  out.missing = missing;
  if (!home || !away) { out.summary = 'baseline pending — team scoring not loaded for both teams'; return out; }

  // base projection: each team's offense vs the other's defense
  const projHome = teamPoints(home, away);
  const projAway = teamPoints(away, home);
  if (projHome == null || projAway == null) { out.summary = 'insufficient scoring data'; return out; }
  const base = projHome + projAway;

  // compounding factors (additive) + correlation shrink
  const { factors, rawSum } = buildFactors({
    home, away, homeDef: suppressionByTeam[homeTeam], awayDef: suppressionByTeam[awayTeam], spread, roof, weather });
  const { adjSum, alignment, shrunk } = correlationShrink(factors, rawSum);

  // injury adjustment (computed server-side by the slate: QB out drops a team's points;
  // an impact-weighted key defender out raises the opponent's) — folded in + shown on the ledger
  const injF = Array.isArray(ctx.injuryFactors) ? ctx.injuryFactors : [];
  const injD = num(ctx.injuryDelta) || 0;
  const projected = +(base + adjSum + injD).toFixed(1);
  out.projected = projected;
  out.factors = injF.concat(factors);
  out.injuryApplied = injF.length > 0;

  if (line == null) { out.summary = `projected total ${projected} (no line to compare)`; return out; }
  const softness = +(projected - line).toFixed(1);       // + => lean OVER
  out.softness = softness;
  out.lean = softness >= 0 ? 'over' : 'under';

  // near-total guard + conservative provisional tiers (totals are a thin edge)
  const mag = Math.abs(softness);
  if (mag < NEAR_TOTAL_FLOOR) {
    out.tier_candidate = 'none';
    out.blocked = [`near-total — projection ${projected} sits within ${NEAR_TOTAL_FLOOR} of the line (coin flip)`];
  } else if (mag < 5) out.tier_candidate = 'GOLD';
  else if (mag < 7.5) out.tier_candidate = 'PLATINUM';
  else out.tier_candidate = 'GUARANTEED';

  // ---- COMPOUNDING-FACTORS SUMMARY (the ledger synthesis) ----
  const overs = factors.filter(f => f.dir === 'over');
  const unders = factors.filter(f => f.dir === 'under');
  const nameList = (arr) => arr.slice(0, 3).map(f => f.label.toLowerCase()).join(', ') || 'none';
  let s = `Projected ${projected} vs line ${line} — lean ${out.lean.toUpperCase()} by ${mag}. `;
  s += `${overs.length} factor${overs.length === 1 ? '' : 's'} push over (${nameList(overs)}); `;
  s += `${unders.length} push under (${nameList(unders)}). `;
  if (shrunk) s += `Factors are highly aligned (${Math.round(alignment * 100)}%) — projection shrunk ${Math.round((1 - adjSum / (rawSum || 1)) * 100)}% for correlation, so the real edge is smaller than the raw stack suggests. `;
  if (out.tier_candidate === 'none') s += `Too close to the line to play.`;
  else s += `Provisional ${out.tier_candidate} (totals are a thinner market than props — treat as a lean, not a lock).`;
  out.summary = s;
  out.correlation = { alignment, shrunk, rawSum, adjSum };
  return out;
}

export { LG, buildFactors, correlationShrink, teamPoints };
