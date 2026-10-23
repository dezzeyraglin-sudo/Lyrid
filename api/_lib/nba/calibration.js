// api/_lib/nba/calibration.js
// SELF-CALIBRATION LAYER (v4 §3/§6) + BASE-RATE GRADER (WNBA 2026 carry-forward).
//
// Consumes graded history, computes rolling hit-rate per cohort/signal on the FULL window,
// and gates every tier/badge from the LIVE rate. Promotes nothing on a small sample and
// auto-demotes anything below breakeven OR below its market's empirical base rate.
//
// Base-rate lesson: WNBA unders already won ~55%/53%/52% (AST/REB/PTS) with no model.
// A 54% tool hit rate on rebound unders is not an edge.
//
// Graded pick row: { market, side, regime, signalsFired:[], result:'win'|'loss'|'push',
//                    line?, actual?, projection? }
// Disrupted-regime picks live in their own cohorts (regime is in the key), so they are never
// pooled into the settled baseline.

import { buildBaseRateReport, gradeAgainstBaseRate } from './baseRateGrader.js';

function bump(map, key, win) {
  const e = map[key] || (map[key] = { n: 0, w: 0 });
  e.n += 1;
  if (win) e.w += 1;
}
function finalize(map) {
  const out = {};
  for (const k of Object.keys(map)) {
    const e = map[k];
    out[k] = { n: e.n, rate: +(e.w / e.n).toFixed(3) };
  }
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

  const baseReport = buildBaseRateReport(gradedHistory, cfg || {});

  return {
    cohorts: finalize(cohorts),
    signals: finalize(signals),
    n: rows.length,
    // base-rate grader surfaces
    baseRates: baseReport.baseRates,
    lifts: baseReport.lifts,
    demotedCohorts: baseReport.demotedCohorts,
    demotedSignals: baseReport.demotedSignals,
    baseRateSummary: baseReport.summary,
    baseRateReport: baseReport,
  };
}

export function gradeTier(pick, calibration, cfg) {
  const c = (cfg && cfg.calibration) || {};
  const minSample = c.minSample != null ? c.minSample : 20;
  const breakeven = c.breakeven != null ? c.breakeven : 0.577;
  const strongRate = c.strongRate != null ? c.strongRate : 0.62;
  const eliteRate = c.eliteRate != null ? c.eliteRate : 0.67;

  if (!calibration || !calibration.cohorts) {
    return { tier: 'PROVISIONAL', liveRate: null, n: 0, provisional: true, baseRate: null, lift: null };
  }

  // Base-rate gate first (WNBA lesson)
  const br = gradeAgainstBaseRate(pick, calibration.baseRateReport || calibration, cfg);
  if (br.demoted) {
    return {
      tier: 'PASS',
      liveRate: br.liveRate,
      n: br.n,
      provisional: false,
      demoted: true,
      demoteReason: br.reason,
      baseRate: br.baseRate,
      lift: br.lift,
    };
  }

  const specific = calibration.cohorts[`${pick.market}|${pick.side}|${pick.regime || 'unk'}`];
  const coarse = calibration.cohorts[`${pick.market}|${pick.side}`];
  const use = specific && specific.n >= minSample ? specific
    : coarse && coarse.n >= minSample ? coarse
    : null;

  if (!use) {
    const seen = specific || coarse || null;
    return {
      tier: 'PROVISIONAL',
      liveRate: seen ? seen.rate : br.liveRate,
      n: seen ? seen.n : br.n,
      provisional: true,
      baseRate: br.baseRate,
      lift: br.lift,
    };
  }

  // Absolute breakeven demotion (2-pick @ 3x bar)
  if (use.rate < breakeven) {
    return {
      tier: 'PASS',
      liveRate: use.rate,
      n: use.n,
      provisional: false,
      demoted: true,
      demoteReason: 'below_breakeven',
      baseRate: br.baseRate,
      lift: br.lift,
    };
  }

  // Require lift over base rate when we have a reliable base
  if (br.baseRate != null && use.rate < br.baseRate) {
    return {
      tier: 'PASS',
      liveRate: use.rate,
      n: use.n,
      provisional: false,
      demoted: true,
      demoteReason: 'below_base_rate',
      baseRate: br.baseRate,
      lift: br.lift,
    };
  }

  let tier = 'LEAN';
  if (use.rate >= strongRate) tier = 'STRONG';
  if (use.rate >= eliteRate) tier = 'ELITE';

  // If we're only matching base rate (no real lift), keep LEAN max — don't STRONG/ELITE on noise
  if (br.lift != null && br.lift < 0.02 && (tier === 'STRONG' || tier === 'ELITE')) {
    tier = 'LEAN';
  }

  return {
    tier,
    liveRate: use.rate,
    n: use.n,
    provisional: false,
    baseRate: br.baseRate,
    lift: br.lift,
    hasEdge: br.hasEdge === true || (br.lift != null && br.lift >= 0.02),
  };
}

export { buildBaseRateReport, gradeAgainstBaseRate };
export default { buildCalibration, gradeTier, buildBaseRateReport, gradeAgainstBaseRate };
