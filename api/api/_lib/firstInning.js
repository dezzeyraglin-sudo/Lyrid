// api/_lib/firstInning.js
// YRFI (Yes Run First Inning) / NRFI (No Run First Inning) projections and recommendations.
//
// Uses: 1st-inning xwOBA-against for both starters (from inningSplits),
//       top-of-lineup tier quality, park factor (runs + HR), weather, umpire K-rate.
//
// Returns: { awayScoresFirstProb, homeScoresFirstProb, yrfiProb, nrfiProb, recommendation }

// League baselines from 2024-25 data:
//   YRFI rate: ~57%  (53-60% varies by season)
//   P(away scores 1st inning) ≈ 0.32
//   P(home scores 1st inning) ≈ 0.30  (slight home-field disadvantage for scoring since home pitcher is fresher)
const LEAGUE_YRFI = 0.57;
const LEAGUE_AWAY_SCORES_FIRST = 0.325;
const LEAGUE_HOME_SCORES_FIRST = 0.305;

/**
 * Compute first-inning scoring probabilities.
 *
 * @param {Object} awaySide    awayVsHome side data (away hitters vs home SP)
 * @param {Object} homeSide    homeVsAway side data (home hitters vs away SP)
 * @param {Object} context     { parkFactor, weatherImpact, umpire }
 * @returns {Object} {
 *   yrfiProb,              // Prob at least one team scores
 *   nrfiProb,              // 1 - yrfiProb
 *   awayScoresProb,        // Prob the away team scores in top 1st
 *   homeScoresProb,        // Prob the home team scores in bottom 1st
 *   recommendation,        // { side: YRFI|NRFI|PASS, tier, units, probability }
 *   reasoning: string[]
 * }
 */
export function computeFirstInningProbability(awaySide, homeSide, context = {}) {
  const reasoning = [];

  // ====== Per-side scoring probabilities ======
  // Start with league averages, apply multipliers from context
  let awayScoresProb = LEAGUE_AWAY_SCORES_FIRST;
  let homeScoresProb = LEAGUE_HOME_SCORES_FIRST;

  // --- Pitcher 1st-inning vulnerability (strongest single signal) ---
  // awayVsHome = away hitters vs home SP. So home SP's 1st-inning xwOBA-against affects awayScoresProb.
  const homeSp1stXw = getFirstInningXw(awaySide?.inningSplits);
  const awaySp1stXw = getFirstInningXw(homeSide?.inningSplits);

  if (homeSp1stXw?.xwoba != null && homeSp1stXw.pa >= 15) {
    // Baseline 1st-inning xwOBA ~= .320. Each .030 above/below = ~15% relative change
    const delta = homeSp1stXw.xwoba - 0.320;
    const mult = 1.0 + (delta * 5.0);  // .350 xwoba → 1.15x; .290 → 0.85x
    awayScoresProb *= Math.max(0.50, Math.min(1.80, mult));
    if (homeSp1stXw.xwoba >= 0.360) reasoning.push(`Home SP slow starter (1st inn xwOBA ${homeSp1stXw.xwoba.toFixed(3)}, ${homeSp1stXw.pa} PA)`);
    else if (homeSp1stXw.xwoba <= 0.270) reasoning.push(`Home SP dominant early (1st inn xwOBA ${homeSp1stXw.xwoba.toFixed(3)})`);
  }

  if (awaySp1stXw?.xwoba != null && awaySp1stXw.pa >= 15) {
    const delta = awaySp1stXw.xwoba - 0.320;
    const mult = 1.0 + (delta * 5.0);
    homeScoresProb *= Math.max(0.50, Math.min(1.80, mult));
    if (awaySp1stXw.xwoba >= 0.360) reasoning.push(`Away SP slow starter (1st inn xwOBA ${awaySp1stXw.xwoba.toFixed(3)}, ${awaySp1stXw.pa} PA)`);
    else if (awaySp1stXw.xwoba <= 0.270) reasoning.push(`Away SP dominant early (1st inn xwOBA ${awaySp1stXw.xwoba.toFixed(3)})`);
  }

  // --- Top-of-order strength (1st-3rd batters) ---
  // Use lineup tier as proxy: EXPLOITABLE/HIGHLY_EXPLOITABLE = strong top, SUPPRESSED/LOCKED_DOWN = weak
  const awayLineupBoost = getLineupFirstInnBoost(awaySide?.lineupTier);
  const homeLineupBoost = getLineupFirstInnBoost(homeSide?.lineupTier);
  awayScoresProb *= awayLineupBoost.mult;
  homeScoresProb *= homeLineupBoost.mult;
  if (awayLineupBoost.reason) reasoning.push(`Away offense: ${awayLineupBoost.reason}`);
  if (homeLineupBoost.reason) reasoning.push(`Home offense: ${homeLineupBoost.reason}`);

  // --- Pitcher control (walks drive early runs heavily in 1st inning) ---
  const homeControlMult = getControlFirstInnMult(awaySide?.inningSplits?.controlTier);
  const awayControlMult = getControlFirstInnMult(homeSide?.inningSplits?.controlTier);
  awayScoresProb *= homeControlMult;
  homeScoresProb *= awayControlMult;

  // --- Park factor (runs-friendly parks see more 1st inning scoring) ---
  const park = context.parkFactor;
  if (park?.runs) {
    const runsFactor = (park.runs / 100) ** 0.7;  // dampened since 1st-inning is just one frame
    awayScoresProb *= runsFactor;
    homeScoresProb *= runsFactor;
    if (park.runs >= 108) reasoning.push(`${park.name || 'Park'} hitter-friendly (+${park.runs - 100}% runs)`);
    else if (park.runs <= 92) reasoning.push(`${park.name || 'Park'} pitcher-friendly (${park.runs - 100}% runs)`);
  }

  // --- Weather (HR-heavy wind, hot temp boost YRFI; dome games suppress) ---
  const wi = context.weatherImpact;
  if (wi && !wi.isDome && wi.runMult) {
    const weatherFactor = Math.pow(wi.runMult, 0.7);  // dampened for single-frame
    awayScoresProb *= weatherFactor;
    homeScoresProb *= weatherFactor;
    if (wi.runMult >= 1.04) reasoning.push(`Weather boosts scoring (+${((wi.runMult-1)*100).toFixed(1)}%)`);
    else if (wi.runMult <= 0.96) reasoning.push(`Weather suppresses scoring (${((wi.runMult-1)*100).toFixed(1)}%)`);
  }
  if (wi?.isDome) reasoning.push('Dome game — no weather effect');

  // --- Umpire (tight K-zone = more Ks = fewer early runs) ---
  const ump = context.umpire?.factors;
  if (ump?.k) {
    const umpFactor = 1 / ump.k;  // K-happy umps suppress runs
    const scaled = Math.pow(umpFactor, 0.5);  // dampen
    awayScoresProb *= scaled;
    homeScoresProb *= scaled;
    if (ump.k >= 1.04) reasoning.push(`K-friendly ump suppresses 1st-inn scoring`);
    else if (ump.k <= 0.96) reasoning.push(`Tight-zone ump inflates 1st-inn scoring`);
  }

  // Clamp individual probs
  awayScoresProb = Math.max(0.05, Math.min(0.75, awayScoresProb));
  homeScoresProb = Math.max(0.05, Math.min(0.75, homeScoresProb));

  // ====== YRFI = P(at least one team scores) = 1 - P(neither scores) ======
  // Assume independence (close enough — the starters are different people)
  const nrfiProb = (1 - awayScoresProb) * (1 - homeScoresProb);
  const yrfiProb = 1 - nrfiProb;

  // ====== Recommendation ======
  // Compare our YRFI probability to league baseline of 57%.
  // Because sportsbooks typically price YRFI ~-110 to +120 (implied 47-52%), and NRFI ~-130 to -155 (56-60%),
  // our edge comes from meaningful divergence from the league average.
  //
  // Threshold tiers:
  //   STRONG: ≥8pp edge from 57%  (e.g. projected 67%+ or 49%-)  → 2u
  //   MODERATE: ≥5pp edge from 57%  → 1u
  //   SLIGHT: ≥3pp edge from 57%   → 0.5u
  //   PASS: <3pp edge (market is near fair)
  const deltaFromBase = yrfiProb - LEAGUE_YRFI;
  const absDelta = Math.abs(deltaFromBase);
  let side = null, tier = 'PASS', units = 0;
  if (absDelta >= 0.08) { tier = 'STRONG'; units = 2; }
  else if (absDelta >= 0.05) { tier = 'MODERATE'; units = 1; }
  else if (absDelta >= 0.03) { tier = 'SLIGHT'; units = 0.5; }
  if (tier !== 'PASS') side = deltaFromBase > 0 ? 'YRFI' : 'NRFI';

  const recommendation = {
    side,
    tier,
    units,
    probability: side === 'YRFI' ? +yrfiProb.toFixed(3) : side === 'NRFI' ? +nrfiProb.toFixed(3) : +yrfiProb.toFixed(3),
    pick: side ? `${side}` : null,
    deltaFromBaseline: +deltaFromBase.toFixed(3)
  };

  return {
    yrfiProb: +yrfiProb.toFixed(3),
    nrfiProb: +nrfiProb.toFixed(3),
    awayScoresProb: +awayScoresProb.toFixed(3),
    homeScoresProb: +homeScoresProb.toFixed(3),
    recommendation,
    reasoning
  };
}

function getFirstInningXw(inningSplits) {
  if (!inningSplits?.perInning?.[1]) return null;
  return {
    xwoba: inningSplits.perInning[1].xwobaAgainst,
    pa: inningSplits.perInning[1].pa,
    bbPct: inningSplits.perInning[1].bbPct,
    kPct: inningSplits.perInning[1].kPct
  };
}

function getLineupFirstInnBoost(lineupTier) {
  if (!lineupTier) return { mult: 1.0, reason: null };
  switch (lineupTier.label) {
    case 'HIGHLY_EXPLOITABLE': return { mult: 1.20, reason: 'elite top-of-order quality' };
    case 'EXPLOITABLE':        return { mult: 1.10, reason: 'strong lineup' };
    case 'NEUTRAL':            return { mult: 1.00, reason: null };
    case 'SUPPRESSED':         return { mult: 0.90, reason: 'weak lineup' };
    case 'LOCKED_DOWN':        return { mult: 0.82, reason: 'very weak lineup' };
    default:                   return { mult: 1.0, reason: null };
  }
}

function getControlFirstInnMult(controlTier) {
  switch (controlTier) {
    case 'elite':          return 0.93;  // elite control = fewer walks = fewer early runs
    case 'above-average':  return 0.97;
    case 'average':        return 1.00;
    case 'below-average':  return 1.06;
    case 'wild':           return 1.12;  // wild pitchers inflate 1st-inn scoring
    default:               return 1.00;
  }
}

/**
 * Grade a YRFI/NRFI bet against the final linescore.
 * @param {string} side 'YRFI' | 'NRFI'
 * @param {number} awayRunsInn1
 * @param {number} homeRunsInn1
 */
export function gradeFirstInningBet(side, awayRunsInn1, homeRunsInn1) {
  const totalRuns = (awayRunsInn1 || 0) + (homeRunsInn1 || 0);
  const scored = totalRuns > 0;
  if (side === 'YRFI') return scored ? 'win' : 'loss';
  if (side === 'NRFI') return scored ? 'loss' : 'win';
  return null;
}
