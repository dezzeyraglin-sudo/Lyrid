// nflMatchupAnalysis.js
// Lyrid NFL engine — matchup analysis layer (Layer 5d).
// Three related outputs sharing opponent-defense + team-tendency inputs:
//   1. suppressionScore(prop)  — how much the opponent defense drags this prop family
//   2. qbOutlook(qb, matchup)  — will this QB struggle or flourish, and WHY (explainable)
//   3. shootoutProbability(game) — likelihood of a pass-heavy high-total shootout
//
// HONESTY: these are probabilistic LEANS, not certainties. Single games have huge
// irreducible variance. Outputs feed the comp engine / tiering as weighted signals,
// never as standalone guarantees. All scores are documented as leans.

// League baselines (2024-derived; tune per season). Used to standardize opponent rates.
const LG = {
  pass_epa_allowed: 0.04, pass_success_allowed: 0.455, sack_rate: 0.065, qb_hit_rate: 0.14,
  rush_epa_allowed: -0.10, ypc_allowed: 4.3,
  proe: 0.0, total: 44.5,
};

const z = (v, mean, spread) => (v == null ? 0 : (v - mean) / spread);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------------------------------------------------------------------------
// 1. SUPPRESSION SCORE
// Returns a signed z-nudge: NEGATIVE = opponent suppresses this prop (fade overs),
// POSITIVE = opponent is a soft matchup (favor overs). Additive, capped.
// ---------------------------------------------------------------------------
export function suppressionScore({ defSuppression, propFamily }) {
  const d = defSuppression;
  if (!d) return { nudge: 0, tag: 'unknown', reason: 'no suppression data' };
  let nudge = 0; const reasons = [];

  if (propFamily === 'passing_yards' || propFamily === 'receiving_yards') {
    // higher EPA/success allowed = softer = positive for overs; more pressure = negative
    const epaZ = z(d.pass_epa_allowed, LG.pass_epa_allowed, 0.08);   // +ve = soft D
    const pressZ = z((d.sack_rate + d.qb_hit_rate) / 2, (LG.sack_rate + LG.qb_hit_rate) / 2, 0.03);
    nudge += epaZ * 0.22;
    nudge -= pressZ * 0.15;
    if (epaZ > 0.6) reasons.push('soft pass defense (high EPA allowed)');
    if (epaZ < -0.6) reasons.push('stingy pass defense (low EPA allowed)');
    if (pressZ > 0.6) reasons.push('high pressure/sack rate (suppresses passing)');
  }
  if (propFamily === 'rushing_yards' || propFamily === 'rush_rec_yards') {
    const rEpaZ = z(d.rush_epa_allowed, LG.rush_epa_allowed, 0.06);
    const ypcZ = z(d.ypc_allowed, LG.ypc_allowed, 0.4);
    nudge += (rEpaZ * 0.15 + ypcZ * 0.18) * (propFamily === 'rush_rec_yards' ? 0.6 : 1);
    if (ypcZ > 0.6) reasons.push('soft run defense (high YPC allowed)');
    if (ypcZ < -0.6) reasons.push('stout run defense (low YPC allowed)');
  }

  nudge = +clamp(nudge, -0.4, 0.4).toFixed(4);
  const tag = nudge > 0.12 ? 'soft_matchup' : (nudge < -0.12 ? 'suppressed' : 'neutral');
  return { nudge, tag, reason: reasons.join('; ') || 'neutral suppression matchup' };
}

// ---------------------------------------------------------------------------
// 2. QB OUTLOOK — struggle vs flourish, explainable
// Combines the QB's own profile with opponent suppression, game script, environment.
// Returns { outlook, score (-1..+1), drivers[] } — the drivers ARE the "why".
// ---------------------------------------------------------------------------
export function qbOutlook({ qb, oppSuppression, teamTendency, gameScript, envNudge }) {
  // qb: { volumeFloor (0-1), cpoeBaseline, isMobile }
  // teamTendency: { proe_pct } (own team pass identity)
  const drivers = [];
  let score = 0;

  // Own volume floor: secure attempts = higher floor
  if (qb?.volumeFloor != null) {
    const c = (qb.volumeFloor - 0.6) * 0.6;
    score += c;
    if (qb.volumeFloor >= 0.8) drivers.push({ f: 'secure attempt volume', dir: '+', w: +c.toFixed(2) });
    else if (qb.volumeFloor < 0.5) drivers.push({ f: 'shaky attempt volume', dir: '-', w: +c.toFixed(2) });
  }
  // Own efficiency baseline (CPOE)
  if (qb?.cpoeBaseline != null) {
    const c = clamp(qb.cpoeBaseline / 6, -0.3, 0.3); // CPOE ~±6 is large
    score += c;
    if (Math.abs(c) > 0.08) drivers.push({ f: c > 0 ? 'above-expected accuracy' : 'below-expected accuracy', dir: c > 0 ? '+' : '-', w: +c.toFixed(2) });
  }
  // Team pass identity: pass-heavy lifts the QB
  if (teamTendency?.proe_pct != null) {
    const c = clamp(teamTendency.proe_pct / 100 * 2.5, -0.25, 0.25);
    score += c;
    if (Math.abs(c) > 0.06) drivers.push({ f: c > 0 ? 'pass-first offense' : 'run-first offense', dir: c > 0 ? '+' : '-', w: +c.toFixed(2) });
  }
  // Opponent pass suppression (reuse suppressionScore on passing)
  if (oppSuppression) {
    const s = suppressionScore({ defSuppression: oppSuppression, propFamily: 'passing_yards' });
    score += s.nudge;
    if (Math.abs(s.nudge) > 0.08) drivers.push({ f: s.reason, dir: s.nudge > 0 ? '+' : '-', w: +s.nudge.toFixed(2) });
  }
  // Game script: blowout/underdog risk drags a QB down
  if (gameScript?.risk != null && gameScript.risk > 0.25) {
    const c = -gameScript.risk * 0.4;
    score += c;
    drivers.push({ f: gameScript.reasons?.[0] || 'game-script risk', dir: '-', w: +c.toFixed(2) });
  }
  // Environment (wind etc.)
  if (envNudge) {
    score += envNudge;
    if (Math.abs(envNudge) > 0.1) drivers.push({ f: envNudge < 0 ? 'adverse weather' : 'favorable environment', dir: envNudge > 0 ? '+' : '-', w: +envNudge.toFixed(2) });
  }

  score = +clamp(score, -1, 1).toFixed(3);
  const outlook = score > 0.25 ? 'flourish' : (score < -0.25 ? 'struggle' : 'neutral');
  // sort drivers by absolute weight (biggest reasons first)
  drivers.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return { outlook, score, drivers };
}

// ---------------------------------------------------------------------------
// 3. SHOOTOUT PROBABILITY — pass-heavy, high-total, competitive, soft pass Ds
// Vegas total does most of the work; PROE + pass-defense softness + weather refine.
// Returns { prob (0-1), lean, factors[] }. A LEAN, not a guarantee.
// ---------------------------------------------------------------------------
export function shootoutProbability({ gameTotal, spread, homeTendency, awayTendency, homeDefSupp, awayDefSupp, weatherApplies, windMph, roof }) {
  const factors = [];
  // base from total (logistic-ish around league avg 44.5, steep above 48)
  let p = clamp((gameTotal != null ? (gameTotal - LG.total) / 14 : 0) + 0.35, 0.05, 0.95);
  if (gameTotal != null && gameTotal >= 49) factors.push(`high total (${gameTotal})`);
  if (gameTotal != null && gameTotal <= 40) factors.push(`low total (${gameTotal})`);

  // both teams pass-heavy raises it
  const proeAvg = ((homeTendency?.proe_pct ?? 0) + (awayTendency?.proe_pct ?? 0)) / 2;
  p += clamp(proeAvg / 100 * 1.5, -0.15, 0.15);
  if (proeAvg >= 3) factors.push('both offenses pass-lean');
  if (proeAvg <= -3) factors.push('both offenses run-lean');

  // both pass defenses soft raises it (avg pass EPA allowed above league)
  const dAvg = ((homeDefSupp?.pass_epa_allowed ?? LG.pass_epa_allowed) + (awayDefSupp?.pass_epa_allowed ?? LG.pass_epa_allowed)) / 2;
  p += clamp((dAvg - LG.pass_epa_allowed) / 0.12 * 0.15, -0.15, 0.15);
  if (dAvg - LG.pass_epa_allowed > 0.05) factors.push('both pass defenses soft');
  if (dAvg - LG.pass_epa_allowed < -0.05) factors.push('both pass defenses stingy');

  // competitive spread keeps both aggressive; blowout spread caps shootout upside
  if (spread != null && Math.abs(spread) >= 10) { p -= 0.10; factors.push('lopsided spread caps shootout'); }
  if (spread != null && Math.abs(spread) <= 3) { p += 0.05; factors.push('close spread (both stay aggressive)'); }

  // weather: high wind / bad weather kills shootouts
  if (weatherApplies && windMph != null && windMph >= 18) { p -= 0.15; factors.push(`wind ${windMph}mph suppresses`); }
  if (roof === 'dome') { p += 0.05; factors.push('dome (controlled conditions)'); }

  p = +clamp(p, 0.02, 0.98).toFixed(3);
  const lean = p >= 0.62 ? 'shootout_likely' : (p <= 0.35 ? 'low-scoring_likely' : 'neutral');
  return { prob: p, lean, factors };
}

export { LG as MATCHUP_BASELINES };
