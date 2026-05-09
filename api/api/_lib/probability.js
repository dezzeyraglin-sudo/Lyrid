// api/_lib/probability.js
// Probability estimation for props and game-line bets.
// Design principle: probabilities are ADDITIVE to tiers — tiers drive decisions,
// probabilities give confidence numbers you can compare to market implied probabilities.

// ================== MLB BASELINE RATES ==================
// Empirical per-game rates for a league-average qualified hitter (2024-25 seasons).
// Derived from: ~4.1 PA/game, .248 BA, .247 wOBA, ~0.15 HR/G, ~1.1 TB/G, ~0.65 RBI/G.

const BASELINES = {
  // P(1+ hit in the game)
  H: 0.68,
  // P(1+ HR in the game)
  HR: 0.125,
  // P(2+ TB in game, "TB 1.5" over)
  TB: 0.40,
  // P(1+ RBI in the game) — slot-dependent; this is league average
  RBI: 0.42,
  // P(1+ Run scored in the game) — slot-dependent
  R: 0.38,
  // P(H+R+RBI ≥ 2, "HRR 1.5" over)
  HRR: 0.58
};

// Slot adjustments (multiplicative) for RBI / R props which are heavily slot-sensitive.
// Batting order 1 (leadoff) through 9.
const SLOT_ADJ_RBI = { 1: 0.75, 2: 0.88, 3: 1.20, 4: 1.30, 5: 1.15, 6: 1.00, 7: 0.88, 8: 0.80, 9: 0.70 };
const SLOT_ADJ_R   = { 1: 1.25, 2: 1.22, 3: 1.15, 4: 1.05, 5: 0.95, 6: 0.88, 7: 0.82, 8: 0.75, 9: 0.70 };

/**
 * Estimate the probability that a hitter's prop hits.
 *
 * @param {Object} hitter  The analyzed hitter object from analyze.js
 * @param {string} propKey 'H' | 'HR' | 'TB' | 'RBI' | 'R' | 'HRR'
 * @param {Object} ctx     { parkFactor, weatherImpact, umpire, pitcherRole }
 * @returns {Object} { probability (0-1), baseline, modifiers: [{name, factor}] }
 */
export function estimatePropProbability(hitter, propKey, ctx = {}) {
  if (!hitter || !propKey || !BASELINES[propKey]) return null;

  const base = BASELINES[propKey];
  const modifiers = [];

  // === Matchup quality (xwOBA-based tier signal) ===
  const adjXw = parseFloat(hitter.adjustedMaxXwoba) || 0.320;
  let matchupMult = 1.0;
  if (propKey === 'H' || propKey === 'HRR') {
    // Hits/HRR are driven by overall matchup quality
    if (adjXw >= 0.460) matchupMult = 1.25;
    else if (adjXw >= 0.400) matchupMult = 1.15;
    else if (adjXw >= 0.350) matchupMult = 1.08;
    else if (adjXw <= 0.260) matchupMult = 0.85;
    else if (adjXw <= 0.290) matchupMult = 0.93;
  } else if (propKey === 'HR' || propKey === 'TB') {
    // HR/TB driven more by SLG component of xwOBA and barrel rate
    const barrel = parseFloat(hitter.seasonStats?.barrel) || 7;
    if (adjXw >= 0.460 && barrel >= 12) matchupMult = 1.50;
    else if (adjXw >= 0.400 && barrel >= 10) matchupMult = 1.30;
    else if (adjXw >= 0.350) matchupMult = 1.12;
    else if (adjXw <= 0.260) matchupMult = 0.75;
    else if (adjXw <= 0.290) matchupMult = 0.88;
  } else {  // RBI, R
    if (adjXw >= 0.420) matchupMult = 1.20;
    else if (adjXw >= 0.370) matchupMult = 1.10;
    else if (adjXw <= 0.280) matchupMult = 0.88;
  }
  if (matchupMult !== 1.0) modifiers.push({ name: `Matchup ${adjXw.toFixed(3)} xwOBA`, factor: matchupMult });

  // === Platoon advantage ===
  if (hitter.platoonMeta?.boost && hitter.platoonMeta.boost !== 1.0) {
    modifiers.push({ name: `Platoon ${hitter.platoonMeta.boost > 1 ? '+' : ''}${((hitter.platoonMeta.boost - 1) * 100).toFixed(0)}%`, factor: hitter.platoonMeta.boost });
  }

  // === Bullpen ===
  // Full-game edge boosts all props slightly, since the lineup faces good matchups even late.
  if (hitter.bullpenTier === 'FULL_GAME') {
    modifiers.push({ name: 'FULL GAME edge', factor: 1.08 });
  }

  // === Park factor (prop-specific) ===
  const park = ctx.parkFactor;
  if (park) {
    if (propKey === 'HR' || propKey === 'TB') {
      const hrFactor = (park.hr || 100) / 100;
      if (hrFactor !== 1.0) modifiers.push({ name: `Park HR ${hrFactor >= 1 ? '+' : ''}${((hrFactor - 1) * 100).toFixed(0)}%`, factor: hrFactor });
    } else {
      const runsFactor = (park.runs || 100) / 100;
      if (Math.abs(runsFactor - 1.0) > 0.03) modifiers.push({ name: `Park runs ${runsFactor >= 1 ? '+' : ''}${((runsFactor - 1) * 100).toFixed(0)}%`, factor: runsFactor });
    }
  }

  // === Weather (HR props only, handedness-aware) ===
  const wi = ctx.weatherImpact;
  if (wi && !wi.isDome && (propKey === 'HR' || propKey === 'TB')) {
    const hand = hitter.hand || 'R';
    const weatherHr = hand === 'L' ? wi.hrMultLHH : wi.hrMultRHH;
    if (weatherHr && Math.abs(weatherHr - 1.0) > 0.02) {
      modifiers.push({ name: `Weather ${weatherHr >= 1 ? '+' : ''}${((weatherHr - 1) * 100).toFixed(1)}%`, factor: weatherHr });
    }
  }

  // === Umpire (K props affect hit probability) ===
  if (ctx.umpire?.factors) {
    if (propKey === 'H' || propKey === 'HRR') {
      const kMult = ctx.umpire.factors.k || 1.0;
      // Higher ump K-factor hurts hitters getting on base
      if (Math.abs(kMult - 1.0) >= 0.03) {
        const hitterMult = 1 - ((kMult - 1) * 0.3);
        modifiers.push({ name: `Ump K ${kMult >= 1 ? '+' : ''}${((kMult - 1) * 100).toFixed(0)}%`, factor: hitterMult });
      }
    }
  }

  // === Batting order slot (RBI / R only) ===
  const slot = parseInt(hitter.battingOrder);
  if (slot >= 1 && slot <= 9) {
    if (propKey === 'RBI') {
      modifiers.push({ name: `Batting ${slot}`, factor: SLOT_ADJ_RBI[slot] });
    } else if (propKey === 'R') {
      modifiers.push({ name: `Batting ${slot}`, factor: SLOT_ADJ_R[slot] });
    }
  }

  // === Opener / role adjustment ===
  // Facing a traditional starter = normal. Facing an opener = facing bulk reliever most of the game;
  // bullpen is already factored into full-game metric.

  // === Situational signals (actionable BRef splits) ===
  const sit = hitter.situational?.signals;
  if (sit) {
    if (propKey === 'RBI' && sit.risp?.actionable) {
      const rispMult = 1 + (sit.risp.delta * 0.5);  // 50% of OPS delta as probability delta
      modifiers.push({ name: `RISP ${sit.risp.delta > 0 ? '+' : ''}${sit.risp.delta.toFixed(3)}`, factor: Math.max(0.7, Math.min(1.4, rispMult)) });
    }
    if ((propKey === 'HR' || propKey === 'TB') && sit.runnersOn?.actionable && sit.runnersOn.delta < -0.050) {
      // Pitchers attack differently with runners on — less HR-friendly
      modifiers.push({ name: 'Runners-on splits', factor: 0.93 });
    }
  }

  // ===== Apply all modifiers =====
  let probability = base;
  for (const m of modifiers) probability *= m.factor;
  // Clamp to reasonable ranges
  probability = Math.max(0.02, Math.min(0.95, probability));

  return {
    probability: +probability.toFixed(3),
    baseline: base,
    modifiers,
    summary: describe(probability, propKey)
  };
}

function describe(p, propKey) {
  // Rough verbal tier for the prob (for UI tooltip, not the tier system)
  if (p >= 0.75) return 'very likely';
  if (p >= 0.60) return 'likely';
  if (p >= 0.45) return 'coin flip';
  if (p >= 0.30) return 'longshot';
  return 'unlikely';
}

/**
 * Estimate probability that a game goes OVER / UNDER the market total.
 * Uses normal distribution around projection with MLB total stddev ~3.1 runs.
 *
 * @param {number} projectedTotal
 * @param {number} marketLine
 * @returns {Object} { overProb, underProb }
 */
export function estimateTotalProbability(projectedTotal, marketLine) {
  if (projectedTotal == null || marketLine == null) return null;
  const stddev = 3.1;  // MLB total stddev empirical
  const z = (marketLine - projectedTotal) / stddev;
  const overProb = 1 - normalCDF(z);
  return {
    overProb: +overProb.toFixed(3),
    underProb: +(1 - overProb).toFixed(3)
  };
}

/**
 * Estimate probability of a specific team winning (moneyline).
 * The projection.homeWinProb already exists via Pythagorean — this wraps it for consistency.
 */
export function estimateMoneylineProbability(homeWinProb, side) {
  if (homeWinProb == null) return null;
  return side === 'HOME' ? +homeWinProb.toFixed(3) : +(1 - homeWinProb).toFixed(3);
}

/**
 * Estimate probability that the favorite covers the run line (-1.5) or underdog beats it (+1.5).
 * Uses run margin projection with MLB margin stddev ~4.2 runs.
 */
export function estimateSpreadProbability(projectedMargin, runLine, favored, side) {
  if (projectedMargin == null) return null;
  const stddev = 4.2;
  // If "home -1.5" → need home to win by 2+ → margin > 1.5
  // If "away +1.5" → home must lose OR win by 1 → margin < 2
  const threshold = runLine + 0.5;  // 1.5 + 0.5 = 2 for run line betting math
  let prob;
  if (side?.includes('_-')) {
    // Taking favorite to cover
    const favMargin = favored === 'home' ? projectedMargin : -projectedMargin;
    const z = (threshold - favMargin) / stddev;
    prob = 1 - normalCDF(z);
  } else {
    // Taking underdog +1.5
    const favMargin = favored === 'home' ? projectedMargin : -projectedMargin;
    const z = (threshold - favMargin) / stddev;
    prob = normalCDF(z);
  }
  return +Math.max(0.01, Math.min(0.99, prob)).toFixed(3);
}

// Standard normal CDF via Abramowitz-Stegun approximation
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Convert American odds to implied probability (with optional vig removal).
 */
export function americanToImpliedProb(price) {
  if (price == null) return null;
  if (price > 0) return 100 / (price + 100);
  return -price / (-price + 100);
}

/**
 * Given our probability estimate and the market price, compute the EV edge.
 * Positive edge means we project the bet to be profitable long-term.
 */
export function computeEdge(ourProb, americanPrice) {
  if (ourProb == null || americanPrice == null) return null;
  const implied = americanToImpliedProb(americanPrice);
  return +((ourProb - implied) * 100).toFixed(1);
}
