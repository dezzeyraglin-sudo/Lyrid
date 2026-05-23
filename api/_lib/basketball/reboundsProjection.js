/**
 * reboundsProjection.js
 *
 * Per-player rebound projection. Sits downstream of minutesProjection + teammateRedistribution.
 *
 * ARCHITECTURE NOTE: This is Stage 1 of a planned three-stage rebound model.
 *
 *   Stage 1 (current): proj_reb = proj_minutes * player_reb_per_min * matchup_multiplier
 *     Where matchup_multiplier = (opp_pace_factor) * (opp_miss_rate_factor)
 *     Inputs needed: just opp_pace and opp_miss_rate (already in season-level box scores)
 *
 *   Stage 2 (future): decompose into ORB and DRB separately, factor in opponent shot profile
 *     (3PA rate vs paint rate, since 3pt misses produce long rebounds favoring perimeter
 *     players while paint misses produce short rebounds favoring bigs)
 *
 *   Stage 3 (future): tracking-data zones, position-on-court rebound geometry
 *
 * The function `computeMatchupMultiplier` is exported separately so it can be swapped wholesale
 * when Stage 2 data arrives, without touching the public API of computeProjRebounds.
 *
 * Why per-minute rate instead of possession-based like points?
 *   - Rebounds aren't usage-driven the way points are. A player's rebound rate is a function
 *     of their physical role (positioning, rebound chasing) not their offensive role.
 *   - Per-minute is the standard rebound metric (RPG/MP is on bbref, basketball-reference, etc).
 *   - When redistribution boosts a backup's minutes from 18 to 28, their rebounds should scale
 *     roughly linearly with minutes (modulo position cap and fatigue), which per-min captures.
 *   - We DON'T multiply by usage like points does because rebounds aren't a usage event.
 *
 * The TWO real adjustments on top of minutes-scaled rebounds:
 *   1. matchup_multiplier: opponent context (pace + miss rate)
 *   2. b2b_rebound_penalty: small efficiency drop on tired legs (less aggressive crashing)
 *
 * Inputs expected on player object:
 *   Required from minutes engine: projMinutes, confidence
 *   Required season stats: season_reb_per_min (= season_rpg / season_mpg), position
 *   Optional: last5_reb_per_min, gp, oreb_rate, dreb_rate (Stage 2 prep)
 *
 * Inputs expected on gameContext:
 *   Stage 1: opp_pace, opp_miss_rate (= 1 - opp_fg_pct, weighted by attempts)
 *   Stage 2 prep (optional, currently unused): opp_3pa_rate, opp_paint_rate, own_team_pace
 */

// League-average baselines (WNBA 2025 approximations)
const LEAGUE_AVG_PACE = 80;            // possessions per 40 min
const LEAGUE_AVG_MISS_RATE = 0.555;    // 1 - league avg FG% (~0.445)

// Tuning constants
const MATCHUP_PACE_CLAMP = 0.15;       // opp pace adjustment bounded at +/-15%
const MATCHUP_MISS_RATE_CLAMP = 0.12;  // opp miss rate adjustment bounded at +/-12%
const B2B_REBOUND_PENALTY = 0.96;      // 4% reduction on tired legs (crashing fatigue)
const RECENT_FORM_CLAMP = 0.12;        // recent rebound rate bounded at +/-12%
const RECENT_FORM_WEIGHT = 0.5;        // half-trust recent form

// Confidence deductions (applied on top of minutes engine's confidence)
const POSITION_VOLATILITY_DEDUCTION = 8;   // guards have higher rebound variance than centers
const THIN_REBOUND_SAMPLE_DEDUCTION = 12;  // gp < 5
const HIGH_VARIANCE_DEDUCTION = 10;        // last5 std-dev high (deferred -- needs game-by-game data)

// Position rebound-volatility ranking (higher = more variance, more confidence deduction)
const POSITION_VOLATILITY = {
  'PG': 1.0,
  'G':  1.0,
  'SG': 0.9,
  'SF': 0.7,
  'F':  0.6,
  'PF': 0.4,
  'C':  0.2,
};

function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Matchup multiplier: encapsulates ALL opponent-context adjustments to rebound expectancy.
 *
 * Stage 1: opp_pace * opp_miss_rate
 *   - Faster pace = more possessions = more total shot attempts = more total rebounds available
 *   - Higher opp miss rate = more rebound opportunities (especially DRB)
 *
 * Stage 2 (future, not yet implemented):
 *   - opponent shot profile: 3pa_rate, paint_rate, mid_range_rate
 *   - position-aware: long rebounds favor perimeter players, short rebounds favor bigs
 *   - own team's offensive shot profile (for ORB chances)
 *
 * Stage 3 (future):
 *   - tracking-data zones, player positioning, defensive rebound assignments
 *
 * SWAP INSTRUCTIONS: When Stage 2 data is ready, rewrite this function. The function signature
 * (player, gameContext) -> { multiplier, audit } must NOT change.
 */
function computeMatchupMultiplier(player, gameContext) {
  const oppPace = typeof gameContext.opp_pace === 'number' ? gameContext.opp_pace : LEAGUE_AVG_PACE;
  const oppMissRate = typeof gameContext.opp_miss_rate === 'number' ? gameContext.opp_miss_rate : LEAGUE_AVG_MISS_RATE;

  const fallbacksUsed = [];
  if (typeof gameContext.opp_pace !== 'number') fallbacksUsed.push('opp_pace');
  if (typeof gameContext.opp_miss_rate !== 'number') fallbacksUsed.push('opp_miss_rate');

  // Pace factor: more possessions = more rebounds available
  const paceDelta = (oppPace - LEAGUE_AVG_PACE) / LEAGUE_AVG_PACE;
  const paceFactor = 1 + clamp(paceDelta, -MATCHUP_PACE_CLAMP, MATCHUP_PACE_CLAMP);

  // Miss rate factor: more misses = more rebound opportunities
  const missRateDelta = (oppMissRate - LEAGUE_AVG_MISS_RATE) / LEAGUE_AVG_MISS_RATE;
  const missRateFactor = 1 + clamp(missRateDelta, -MATCHUP_MISS_RATE_CLAMP, MATCHUP_MISS_RATE_CLAMP);

  const multiplier = paceFactor * missRateFactor;

  return {
    multiplier: round3(multiplier),
    audit: {
      stage: 1,
      paceFactor: round3(paceFactor),
      missRateFactor: round3(missRateFactor),
      fallbacksUsed,
      note: 'Stage 1 matchup model. Stage 2 adds opponent shot profile (3PA rate, paint rate) and position-aware rebound geometry.',
    },
  };
}

/**
 * Project rebounds for one player.
 *
 * @param {Object} player - player with minutes already projected
 *   Required: { projMinutes, confidence, season_reb_per_min }
 *   Optional: { position, last5_reb_per_min, gp, last5_reb_std }
 * @param {Object} gameContext - { opp_pace, opp_miss_rate, is_b2b? }
 * @param {Object} injuryRecord - optional, used for confidence inheritance only (minutes already handles status)
 * @returns {Object} { projRebounds, confidence, floor, ceiling, factors, audit }
 */
function computeProjRebounds(player, gameContext = {}, injuryRecord = null) {
  if (!player) throw new Error('computeProjRebounds: player required');
  if (typeof player.projMinutes !== 'number') {
    throw new Error('computeProjRebounds: player.projMinutes required (run minutesProjection first)');
  }
  if (typeof player.season_reb_per_min !== 'number') {
    throw new Error('computeProjRebounds: player.season_reb_per_min required');
  }

  // Short-circuit: zero minutes = zero rebounds.
  if (player.projMinutes === 0) {
    return {
      projRebounds: 0,
      confidence: 0,
      floor: 0,
      ceiling: 0,
      factors: {},
      audit: { reason: 'projMinutes is 0 -- player not playing' },
    };
  }

  // --- Matchup multiplier (swappable, currently Stage 1) ---
  const matchup = computeMatchupMultiplier(player, gameContext);

  // --- Recent form factor (rebound rate trend) ---
  let recentForm = 1.00;
  if (typeof player.last5_reb_per_min === 'number' && player.season_reb_per_min > 0) {
    const rawDev = (player.last5_reb_per_min - player.season_reb_per_min) / player.season_reb_per_min;
    const clampedDev = clamp(rawDev, -RECENT_FORM_CLAMP, RECENT_FORM_CLAMP);
    recentForm = 1 + RECENT_FORM_WEIGHT * clampedDev;
  }

  // --- B2B rebound penalty ---
  const b2bPenalty = gameContext.is_b2b ? B2B_REBOUND_PENALTY : 1.00;

  // --- Combine ---
  // Base: projMinutes * season_reb_per_min gives the player's expected rebounds in their
  // role. Multipliers adjust for context.
  const rawRebounds = player.projMinutes * player.season_reb_per_min * matchup.multiplier * recentForm * b2bPenalty;

  // Floor at 0; no upper ceiling needed (rebound projections naturally bounded by minutes cap)
  const projRebounds = Math.max(0, rawRebounds);

  // --- Confidence: inherit from minutes engine, apply rebound-specific deductions ---
  let confidence = typeof player.confidence === 'number' ? player.confidence : 100;
  const confidenceDeductions = [];

  // Position volatility: guards' rebound counts are noisier than centers'
  const position = player.position || 'F';
  const volatility = POSITION_VOLATILITY[position] !== undefined ? POSITION_VOLATILITY[position] : 0.6;
  if (volatility >= 0.8) {
    confidence -= POSITION_VOLATILITY_DEDUCTION;
    confidenceDeductions.push({ reason: 'position_volatility_guard', delta: -POSITION_VOLATILITY_DEDUCTION });
  }

  // Thin sample
  if (typeof player.gp === 'number' && player.gp < 5) {
    confidence -= THIN_REBOUND_SAMPLE_DEDUCTION;
    confidenceDeductions.push({ reason: 'thin_rebound_sample', delta: -THIN_REBOUND_SAMPLE_DEDUCTION });
  }

  // High variance (if std-dev provided)
  if (typeof player.last5_reb_std === 'number' && player.last5_reb_std > 3.5) {
    confidence -= HIGH_VARIANCE_DEDUCTION;
    confidenceDeductions.push({ reason: 'high_rebound_variance', delta: -HIGH_VARIANCE_DEDUCTION });
  }

  confidence = Math.max(20, confidence);

  // --- Floor/ceiling band ---
  // Rebounds have high single-game variance. Band scales with position volatility.
  let bandWidth = 0.25 + volatility * 0.10;  // C: 0.27, G: 0.35
  if (typeof player.gp === 'number' && player.gp < 5) bandWidth += 0.08;
  if (gameContext.is_b2b) bandWidth += 0.03;

  const floor = Math.max(0, projRebounds * (1 - bandWidth));
  const ceiling = projRebounds * (1 + bandWidth);

  return {
    projRebounds: round1(projRebounds),
    confidence: Math.round(confidence),
    floor: round1(floor),
    ceiling: round1(ceiling),
    factors: {
      projMinutes: player.projMinutes,
      season_reb_per_min: round3(player.season_reb_per_min),
      matchupMultiplier: matchup.multiplier,
      recentForm: round3(recentForm),
      b2bPenalty,
      position,
    },
    audit: {
      rawRebounds: round1(rawRebounds),
      matchupBreakdown: matchup.audit,
      confidenceDeductions,
      formula: 'projMinutes * season_reb_per_min * matchupMultiplier * recentForm * b2bPenalty',
      stage: 1,
    },
  };
}

function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }

export {
  computeProjRebounds,
  computeMatchupMultiplier,  // exported for Stage 2 swap-in + direct testing
  LEAGUE_AVG_PACE,
  LEAGUE_AVG_MISS_RATE,
  POSITION_VOLATILITY,
};
