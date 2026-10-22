// api/_lib/nba/schemeRisk.js
//
// High-floor checklist / scheme-risk guard.
// Runs after form-floor + cadence inside nbaVerdict.decide().
// Goals:
//   1. Force PASS (or heavy edge reduction) on pure Points overs that fail stress tests
//   2. Strengthen Unders when multiple compounding factors stack
//   3. Attach clear human-readable flags for the frontend
//
// All thresholds are intentionally conservative and tunable via leagueConfig later.

/**
 * @param {object} mp          - merged player object
 * @param {string} market      - 'points' | 'rebounds' | 'assists' | 'pra' | etc.
 * @param {number} line
 * @param {object} rec         - current recommendation { side, prob, edge, lean, ... }
 * @param {object} ctx         - { gameScript, shotZone, league, ... }
 * @returns {object}           - { rec, flags, reasons, score }
 */
export function applySchemeRisk(mp, market, line, rec, ctx = {}) {
  const flags = {
    purePointsRisk: false,
    schemeHostile: false,
    minutesRisk: false,
    scriptDependent: false,
    compoundingUnder: false,
    openingNightDiscount: false,
    forcedPass: false,
    underBoosted: false,
  };
  const reasons = [];
  let score = 50; // 0 = high risk / avoid, 100 = high floor / preferred
  let newRec = { ...rec };

  const isPurePoints = market === 'points';
  const isCombo = ['pra', 'pts_rebs', 'pts_asts', 'rebs_asts'].includes(market);
  const isCounting = market === 'rebounds' || market === 'assists';

  // ----- 1. Minutes / foul / role risk -----
  const mf = mp.minutes?.flags || {};
  const projMin = mp.projMinutes ?? mp.minutes?.mean ?? null;
  const profileMin = mp.shotProfile?.minutes?.mean ?? mp.profile?.minutes?.mean ?? null;
  const minutesHaircut = (projMin != null && profileMin != null && profileMin > 0)
    ? (projMin / profileMin)
    : 1;

  if (mf.reducedMinutes || mf.designation || mf.b2b || minutesHaircut < 0.88) {
    flags.minutesRisk = true;
    score -= 18;
    reasons.push('minutes risk (foul / designation / B2B / projected cut)');
  }
  if (mf.roleUncertain || mp.flags?.roleUncertain) {
    flags.minutesRisk = true;
    score -= 12;
    reasons.push('role uncertain');
  }

  // ----- 2. Scheme / matchup hostility -----
  // We use whatever opponent adjustment + archetype signals already exist.
  const oppAdj = mp.oppAdj || ctx.oppAdj || {};
  const matchup = mp.matchup || ctx.matchup || {};
  const archetype = mp.archetype || {};

  // Hostile if opponent adjustment is clearly negative for this market
  const oppPenalty = (oppAdj.pointsAdj ?? oppAdj.pts ?? 0);
  if (isPurePoints && oppPenalty < -1.2) {
    flags.schemeHostile = true;
    score -= 15;
    reasons.push('opponent defensive adjustment hostile to scoring');
  }
  if ((market === 'assists' || market === 'pts_asts') && (oppAdj.astAdj ?? 0) < -0.6) {
    flags.schemeHostile = true;
    score -= 12;
    reasons.push('opponent limits assist opportunities');
  }
  if ((market === 'rebounds' || market === 'pts_rebs' || market === 'pra') && (oppAdj.rebAdj ?? 0) < -0.8) {
    flags.schemeHostile = true;
    score -= 10;
    reasons.push('opponent rebounding environment tough');
  }

  // Archetype signals (if present)
  if (archetype.signalHint && /switch|pack|paint|length|physical/i.test(archetype.signalHint)) {
    flags.schemeHostile = true;
    score -= 8;
    reasons.push('matchup archetype: ' + archetype.signalHint);
  }

  // ----- 3. Game-script dependency -----
  const script = ctx.gameScript || {};
  const totalLine = script.total ?? mp.totalLine ?? null;
  const spread = script.spread ?? mp.spread ?? null;
  const isLowPace = totalLine != null && totalLine < 218;
  const isBlowoutRisk = spread != null && Math.abs(spread) >= 9.5;

  if (isPurePoints && isLowPace) {
    flags.scriptDependent = true;
    score -= 14;
    reasons.push('low total / slow pace environment');
  }
  if (isPurePoints && isBlowoutRisk) {
    flags.scriptDependent = true;
    score -= 10;
    reasons.push('blowout risk (minutes / garbage time uncertainty)');
  }

  // Pure points that need high pace + competitive script to clear are high variance
  if (isPurePoints && (flags.schemeHostile || flags.scriptDependent)) {
    flags.purePointsRisk = true;
    score -= 12;
    reasons.push('pure points over in hostile or script-sensitive spot');
  }

  // ----- 4. Opening-night / early-season volatility -----
  // Simple calendar heuristic; can be replaced with a proper season-day flag later.
  const dateStr = ctx.date || mp.date || '';
  const isVeryEarly = /2026-10-(2[0-5])/.test(dateStr); // first week of season
  if (isVeryEarly && isPurePoints) {
    flags.openingNightDiscount = true;
    score -= 8;
    reasons.push('early-season / opening-week volatility discount');
  }

  // ----- 5. Compounding UNDER factors -----
  // Stack: low pace + hostile scheme + minutes risk + pure volume market
  let underFactors = 0;
  if (isLowPace) underFactors++;
  if (flags.schemeHostile) underFactors++;
  if (flags.minutesRisk) underFactors++;
  if (isPurePoints || market === 'pts_asts') underFactors++;
  if (isBlowoutRisk) underFactors++;

  if (underFactors >= 3 && (newRec.side === 'under' || newRec.lean === 'under' || newRec.edge < 0)) {
    flags.compoundingUnder = true;
    flags.underBoosted = true;
    score += 18;
    // Boost the under edge modestly
    if (newRec.side === 'under' || newRec.lean === 'under') {
      newRec.edge = Math.min(0.28, (newRec.edge || 0) + 0.045);
      newRec.prob = Math.min(0.72, (newRec.prob || 0.5) + 0.04);
    }
    reasons.push(`compounding under factors (${underFactors})`);
  }

  // ----- 6. Force PASS on high-risk pure Points overs -----
  // This is the core lesson from Miller / Coward / similar misses.
  if (isPurePoints && newRec.side === 'over' && newRec.lean !== 'pass') {
    const highRisk = flags.purePointsRisk && (flags.schemeHostile || flags.scriptDependent || flags.minutesRisk);
    const veryHighRisk = (score <= 28) || (flags.purePointsRisk && underFactors >= 3);

    if (veryHighRisk) {
      newRec = {
        ...newRec,
        side: 'over',          // keep original side for logging
        lean: 'pass',
        edge: 0,
        prob: 0.5,
        formKill: true,        // reuse existing kill path so downstream treats it as non-actionable
      };
      flags.forcedPass = true;
      reasons.push('FORCED PASS — pure points over failed checklist stress test');
      score = Math.min(score, 22);
    } else if (highRisk && (newRec.edge || 0) < 0.11) {
      // Soften weak pure-points overs that already look marginal
      newRec.edge = Math.max(0, (newRec.edge || 0) - 0.04);
      newRec.lean = (newRec.edge < 0.06) ? 'pass' : newRec.lean;
      reasons.push('pure points over edge reduced by checklist');
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    rec: newRec,
    flags,
    reasons,
    score,
    underFactors,
  };
}
