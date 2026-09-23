// api/_lib/nba/calibration.js
// SELF-CALIBRATION LAYER (v4 §3/§6) — the guardrail, built first.
// Consumes graded history, computes rolling hit-rate per cohort/signal on the FULL window,
// and gates every tier/badge from the LIVE rate. Promotes nothing on a small sample and
// auto-demotes anything below breakeven. Stops the engine (or me) from over-fitting a
// recent, salient slate — the failure mode that killed six "edges" in WNBA.
//
// Graded pick row: { market, side, regime, signalsFired:[], result:'win'|'loss'|'push' }
// Disrupted-regime picks live in their own cohorts (regime is in the key), so they are never
// pooled into the settled baseline — exactly what v4 §1 requires.

function bump(map, key, win) { const e = map[key] || (map[key] = { n: 0, w: 0 }); e.n += 1; if (win) e.w += 1; }
function finalize(map) {
  const out = {};
  for (const k of Object.keys(map)) { const e = map[k]; out[k] = { n: e.n, rate: +(e.w / e.n).toFixed(3) }; }
  return out;
}
const cohortKey = (r) => `${r.market}|${r.side}|${r.regime || 'unk'}`;
const coarseKey = (r) => `${r.market}|${r.side}`;

export function buildCalibration(gradedHistory, cfg) {
  const rows = (gradedHistory || []).filter((r) => r && (r.result === 'win' || r.result === 'loss'));
  const cohorts = {}, signals = {};
  for (const r of rows) {
    const win = r.result === 'win';
    bump(cohorts, cohortKey(r), win);
    bump(cohorts, coarseKey(r), win);
    for (const s of r.signalsFired || []) bump(signals, `${s}|${r.side}`, win);
  }
  return { cohorts: finalize(cohorts), signals: finalize(signals), n: rows.length };
}

export function gradeTier(pick, calibration, cfg) {
  const c = cfg.calibration;
  if (!calibration || !calibration.cohorts) return { tier: 'PROVISIONAL', liveRate: null, n: 0, provisional: true };
  const specific = calibration.cohorts[`${pick.market}|${pick.side}|${pick.regime || 'unk'}`];
  const coarse = calibration.cohorts[`${pick.market}|${pick.side}`];
  const use = specific && specific.n >= c.minSample ? specific : coarse && coarse.n >= c.minSample ? coarse : null;
  if (!use) {
    const seen = specific || coarse || null;
    return { tier: 'PROVISIONAL', liveRate: seen ? seen.rate : null, n: seen ? seen.n : 0, provisional: true };
  }
  if (use.rate < c.breakeven) return { tier: 'PASS', liveRate: use.rate, n: use.n, provisional: false, demoted: true };
  let tier = 'LEAN';
  if (use.rate >= c.strongRate) tier = 'STRONG';
  if (use.rate >= c.eliteRate) tier = 'ELITE';
  return { tier, liveRate: use.rate, n: use.n, provisional: false };
}

export default { buildCalibration, gradeTier };
