// api/_lib/nba/baseRateGrader.js
//
// BASE-RATE GRADER — carry-forward from WNBA 2026 season review.
//
// Rule: grade every signal against its market's base rate, not 50%.
// WNBA unders already won ~55% (AST) / 53% (REB) / 52% (PTS) with no model.
// A tool that hits 54% on rebound unders has almost no edge.
//
// Graded row shape (from propLog / nba-grade cron):
//   { market, side, regime, result:'win'|'loss'|'push',
//     line, actual, projection, signalsFired?: string[] }
//
// Outputs:
//   - market base rates  (how often the line goes under, independent of our side)
//   - tool rates         (our hit rate by market|side, settled regime only)
//   - lift               (toolRate - baseRate)
//   - demotions          (signal or cohort below base rate or below breakeven)
//   - board summary      (safe to show customers)

const SETTLED = 'settled';
const SINGLE_MARKETS = ['points', 'rebounds', 'assists', 'threes'];

function isWin(r) { return r && r.result === 'win'; }
function isLoss(r) { return r && r.result === 'loss'; }
function isGraded(r) { return isWin(r) || isLoss(r); }

function lineWentUnder(r) {
  if (r == null) return null;
  if (r.actual == null || r.line == null) return null;
  return Number(r.actual) < Number(r.line);
}

function regimeOf(r) {
  return (r && r.regime) ? String(r.regime) : 'unk';
}

function isDisrupted(r, disruptedSet) {
  const reg = regimeOf(r);
  if (reg === SETTLED) return false;
  if (reg === 'unk') return false; // unknown kept out of settled baseline but not forced disrupted
  return (disruptedSet || []).includes(reg);
}

/**
 * Build empirical base rates + tool performance + lift table.
 * @param {Array} gradedHistory
 * @param {object} cfg - leagueConfig.NBA (uses calibration + regime)
 */
export function buildBaseRateReport(gradedHistory, cfg = {}) {
  const cal = cfg.calibration || {};
  const reg = cfg.regime || {};
  const disruptedSet = reg.disrupted || ['opening', 'playoffs', 'deadline', 'b2b', 'tanking'];
  const minSample = cal.minSample != null ? cal.minSample : 20;
  const breakeven = cal.breakeven != null ? cal.breakeven : 0.577; // 2-pick @ 3x

  const rows = (gradedHistory || []).filter(isGraded);
  const settled = rows.filter((r) => regimeOf(r) === SETTLED);
  const disrupted = rows.filter((r) => isDisrupted(r, disruptedSet));

  // --- Market base rate: how often the line goes under (outcome, not our pick) ---
  // Prefer settled window; fall back to all graded if settled is thin.
  const baseSource = settled.length >= minSample ? settled : rows;
  const baseAcc = {}; // market -> { n, under }
  for (const r of baseSource) {
    const m = r.market;
    if (!m) continue;
    const under = lineWentUnder(r);
    if (under == null) continue;
    const e = baseAcc[m] || (baseAcc[m] = { n: 0, under: 0 });
    e.n += 1;
    if (under) e.under += 1;
  }
  const baseRates = {};
  for (const m of Object.keys(baseAcc)) {
    const e = baseAcc[m];
    baseRates[m] = {
      n: e.n,
      underRate: +(e.under / e.n).toFixed(3),
      overRate: +((e.n - e.under) / e.n).toFixed(3),
      source: settled.length >= minSample ? 'settled' : 'all_graded',
    };
  }

  // --- Tool rates by market|side (settled only for promotion; all for visibility) ---
  function toolTable(source) {
    const acc = {}; // key -> { n, w }
    for (const r of source) {
      if (!r.market || !r.side) continue;
      const key = `${r.market}|${r.side}`;
      const e = acc[key] || (acc[key] = { n: 0, w: 0 });
      e.n += 1;
      if (isWin(r)) e.w += 1;
    }
    const out = {};
    for (const k of Object.keys(acc)) {
      const e = acc[k];
      out[k] = { n: e.n, rate: +(e.w / e.n).toFixed(3) };
    }
    return out;
  }

  const toolSettled = toolTable(settled);
  const toolAll = toolTable(rows);

  // --- Lift table (unders vs market under base rate; overs vs over base rate) ---
  const markets = new Set([
    ...Object.keys(baseRates),
    ...Object.keys(toolAll).map((k) => k.split('|')[0]),
  ]);

  const lifts = {};
  for (const m of markets) {
    const base = baseRates[m] || null;
    const under = toolSettled[`${m}|under`] || toolAll[`${m}|under`] || null;
    const over = toolSettled[`${m}|over`] || toolAll[`${m}|over`] || null;
    const underLift = under && base
      ? +(under.rate - base.underRate).toFixed(3)
      : null;
    const overLift = over && base
      ? +(over.rate - base.overRate).toFixed(3)
      : null;
    lifts[m] = {
      baseUnder: base ? base.underRate : null,
      baseOver: base ? base.overRate : null,
      baseN: base ? base.n : 0,
      toolUnder: under ? under.rate : null,
      toolUnderN: under ? under.n : 0,
      underLift,
      toolOver: over ? over.rate : null,
      toolOverN: over ? over.n : 0,
      overLift,
      // edge only if sample clear and lift clearly positive vs base
      underHasEdge: !!(under && base && under.n >= minSample && underLift != null && underLift >= 0.02
        && under.rate >= breakeven),
      overHasEdge: !!(over && base && over.n >= minSample && overLift != null && overLift >= 0.02
        && over.rate >= breakeven),
    };
  }

  // --- Signal demotions (signal|side below base under/over or below breakeven) ---
  const signalAcc = {};
  for (const r of settled.length ? settled : rows) {
    for (const s of r.signalsFired || []) {
      const key = `${s}|${r.side}`;
      const e = signalAcc[key] || (signalAcc[key] = { n: 0, w: 0, market: r.market, side: r.side });
      e.n += 1;
      if (isWin(r)) e.w += 1;
    }
  }
  const demotedSignals = [];
  const signalRates = {};
  for (const key of Object.keys(signalAcc)) {
    const e = signalAcc[key];
    const rate = +(e.w / e.n).toFixed(3);
    signalRates[key] = { n: e.n, rate, market: e.market, side: e.side };
    if (e.n < minSample) continue;
    const base = baseRates[e.market];
    const baseForSide = base
      ? (e.side === 'under' ? base.underRate : base.overRate)
      : null;
    const belowBreakeven = rate < breakeven;
    const belowBase = baseForSide != null && rate < baseForSide;
    if (belowBreakeven || belowBase) {
      demotedSignals.push({
        key,
        n: e.n,
        rate,
        base: baseForSide,
        reason: belowBreakeven ? 'below_breakeven' : 'below_base_rate',
      });
    }
  }

  // --- Cohort demotions (market|side) ---
  const demotedCohorts = [];
  for (const key of Object.keys(toolSettled)) {
    const e = toolSettled[key];
    if (e.n < minSample) continue;
    const [market, side] = key.split('|');
    const base = baseRates[market];
    const baseForSide = base ? (side === 'under' ? base.underRate : base.overRate) : null;
    if (e.rate < breakeven || (baseForSide != null && e.rate < baseForSide)) {
      demotedCohorts.push({
        key,
        n: e.n,
        rate: e.rate,
        base: baseForSide,
        reason: e.rate < breakeven ? 'below_breakeven' : 'below_base_rate',
      });
    }
  }

  // --- Board-facing summary ---
  const summary = {
    graded: rows.length,
    settled: settled.length,
    disrupted: disrupted.length,
    minSample,
    breakeven,
    posture: rows.length < minSample ? 'shadow' : 'live',
    markets: Object.keys(lifts).map((m) => {
      const L = lifts[m];
      return {
        market: m,
        baseUnder: L.baseUnder,
        toolUnder: L.toolUnder,
        underLift: L.underLift,
        underN: L.toolUnderN,
        underHasEdge: L.underHasEdge,
        baseOver: L.baseOver,
        toolOver: L.toolOver,
        overLift: L.overLift,
        overN: L.toolOverN,
        overHasEdge: L.overHasEdge,
      };
    }),
    demotedCohorts,
    demotedSignals: demotedSignals.slice(0, 30),
    lesson: 'Edge = tool rate − market base rate. Unders already win ~52–55% with no model. Only promote when lift is real and sample ≥ minSample on settled regime.',
  };

  return {
    baseRates,
    toolSettled,
    toolAll,
    lifts,
    signalRates,
    demotedSignals,
    demotedCohorts,
    summary,
    n: rows.length,
    settledN: settled.length,
  };
}

/**
 * Judge a single pick against base rate + live tool cohort.
 * Returns demotion / provisional flags for the verdict pipeline.
 */
export function gradeAgainstBaseRate(pick, report, cfg = {}) {
  const cal = cfg.calibration || {};
  const minSample = cal.minSample != null ? cal.minSample : 20;
  const breakeven = cal.breakeven != null ? cal.breakeven : 0.577;

  if (!report || !pick || !pick.market || !pick.side) {
    return { provisional: true, demoted: false, liveRate: null, baseRate: null, lift: null, n: 0, reason: 'no_report' };
  }

  const key = `${pick.market}|${pick.side}`;
  const tool = (report.toolSettled && report.toolSettled[key])
    || (report.toolAll && report.toolAll[key])
    || null;
  const base = report.baseRates && report.baseRates[pick.market];
  const baseRate = base
    ? (pick.side === 'under' ? base.underRate : base.overRate)
    : null;
  const liveRate = tool ? tool.rate : null;
  const n = tool ? tool.n : 0;
  const lift = (liveRate != null && baseRate != null) ? +(liveRate - baseRate).toFixed(3) : null;

  if (n < minSample) {
    return {
      provisional: true,
      demoted: false,
      liveRate,
      baseRate,
      lift,
      n,
      reason: 'thin_sample',
    };
  }

  // Auto-demote: below breakeven OR below market base rate
  if (liveRate < breakeven) {
    return {
      provisional: false,
      demoted: true,
      liveRate,
      baseRate,
      lift,
      n,
      reason: 'below_breakeven',
      tier: 'PASS',
    };
  }
  if (baseRate != null && liveRate < baseRate) {
    return {
      provisional: false,
      demoted: true,
      liveRate,
      baseRate,
      lift,
      n,
      reason: 'below_base_rate',
      tier: 'PASS',
    };
  }

  // Edge requires clear lift over base
  const hasEdge = lift != null && lift >= 0.02;
  return {
    provisional: false,
    demoted: false,
    liveRate,
    baseRate,
    lift,
    n,
    hasEdge,
    reason: hasEdge ? 'above_base' : 'at_base',
  };
}

/**
 * Merge base-rate report into the existing calibration object so gradeTier
 * can demote using market base rates as well as absolute breakeven.
 */
export function enhanceCalibration(calibration, gradedHistory, cfg) {
  const report = buildBaseRateReport(gradedHistory, cfg);
  return {
    ...(calibration || { cohorts: {}, signals: {}, n: 0 }),
    baseRates: report.baseRates,
    lifts: report.lifts,
    demotedCohorts: report.demotedCohorts,
    demotedSignals: report.demotedSignals,
    baseRateSummary: report.summary,
    baseRateReport: report,
  };
}

export default {
  buildBaseRateReport,
  gradeAgainstBaseRate,
  enhanceCalibration,
};
