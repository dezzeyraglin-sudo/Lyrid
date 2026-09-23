// api/_lib/nba/gameTotals.js
// Mechanistic game & team totals: pace interaction × efficiency (each team's offense vs
// the other's defense), with injury haircuts (by usage) and a free-throw matchup nudge.
// DELIBERATELY does NOT suppress the total for a projected blowout — the WNBA finding was
// margin↔total ≈ 0. A blowout redistributes player minutes; it does not lower the total.

function clampMult(x, cap) { return Math.max(1 - cap, Math.min(1 + cap, x)); }
function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

function injuryFactor(teamAbbr, ctx, cfg) {
  const c = cfg.totals, idx = ctx.injuryIdx, byId = ctx.rosterIndex?.byId, adv = ctx.bbrefAdv;
  const out = [];
  if (!idx || !byId) return { factor: 1, out };
  let usgLost = 0;
  for (const id of Object.keys(idx)) {
    const r = byId[id];
    if (!r || r.team !== teamAbbr) continue;
    const raw = idx[id]?.status || idx[id] || '';
    const status = String(raw).toLowerCase();
    const sev = c.injurySeverity[status] ?? (status.includes('out') ? 1 : status.includes('doubt') ? 0.5 : (status.includes('question') || status.includes('gtd')) ? 0.2 : 0);
    if (!sev) continue;
    const usg = adv?.get?.(r.nameKey)?.usgPct;
    if (usg == null) continue;
    usgLost += (usg / 100) * sev;
    out.push({ name: r.name, status: raw, usgPct: usg });
  }
  const factor = Math.max(1 - c.injuryCap, 1 - usgLost * c.injuryCoef);
  return { factor: +factor.toFixed(3), out };
}

function ftNudge(drawFtr, allowFtr, c) {
  if (drawFtr == null && allowFtr == null) return 1;
  const d = drawFtr != null ? (drawFtr - c.leagueFtr) / c.leagueFtr : 0;
  const a = allowFtr != null ? (allowFtr - c.leagueFtr) / c.leagueFtr : 0;
  return clampMult(1 + c.ftCoef * ((d + a) / 2), c.ftCap);
}

export function projectGameTotal(game, ctx, cfg) {
  const c = cfg.totals, T = ctx.bbrefTeams || {};
  const home = game.home, away = game.away, A = T[home], B = T[away];
  if (!A || !B || A.pace == null || B.pace == null || A.offRtg == null || B.offRtg == null || A.defRtg == null || B.defRtg == null) {
    return { ok: false, home, away, line: game.total ?? null, reason: 'missing team context' };
  }
  const pace = (A.pace * B.pace) / c.leaguePace;
  const ortgA = A.offRtg * (B.defRtg / c.leagueRtg);   // A offense vs B defense
  const ortgB = B.offRtg * (A.defRtg / c.leagueRtg);   // B offense vs A defense
  let ptsA = (ortgA * pace) / 100, ptsB = (ortgB * pace) / 100;
  const injA = injuryFactor(home, ctx, cfg), injB = injuryFactor(away, ctx, cfg);
  ptsA *= injA.factor; ptsB *= injB.factor;
  const ftA = ftNudge(A.ftr, B.oppFtr, c), ftB = ftNudge(B.ftr, A.oppFtr, c);
  ptsA *= ftA; ptsB *= ftB;
  const total = ptsA + ptsB, line = game.total ?? null;
  const diff = line != null ? total - line : null;
  const pOver = diff != null ? +normCdf(diff / (c.sigma || 10)).toFixed(3) : null;
  const lean = diff == null ? 'no-line' : Math.abs(diff) >= c.minEdgePts ? (diff > 0 ? 'over' : 'under') : 'pass';
  const reasons = [];
  if (injA.out.length) reasons.push(`${home} out: ${injA.out.map((o) => o.name).join(', ')}`);
  if (injB.out.length) reasons.push(`${away} out: ${injB.out.map((o) => o.name).join(', ')}`);
  if ((ftA > 1.005 || ftB > 1.005)) reasons.push('foul-heavy matchup (FT)');
  return {
    ok: true, home, away,
    pace: +pace.toFixed(1),
    teamTotals: { [home]: +ptsA.toFixed(1), [away]: +ptsB.toFixed(1) },
    total: +total.toFixed(1), line, diff: diff != null ? +diff.toFixed(1) : null, pOver, lean,
    injuries: { [home]: injA.out, [away]: injB.out },
    injuryFactor: { [home]: injA.factor, [away]: injB.factor },
    reasons,
  };
}

export function projectSlateTotals(schedule, ctx, cfg) {
  return (schedule || []).map((g) =>
    projectGameTotal({ home: g.home?.abbr || g.home, away: g.away?.abbr || g.away, total: g.total, spread: g.spread }, ctx, cfg));
}

export default { projectGameTotal, projectSlateTotals };
