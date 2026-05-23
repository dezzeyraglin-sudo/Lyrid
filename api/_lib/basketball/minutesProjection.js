/**
 * minutesProjection.js
 *
 * Per-player minutes projection. This is the foundation for points/rebounds: you can't
 * project counting stats without first knowing how long a player will be on the floor.
 *
 * Core formula (from LYRID_RECON_AND_MINUTES_SPEC.md):
 *
 *   proj_minutes = season_mpg
 *                  x role_stability_factor
 *                  x b2b_penalty
 *                  x rest_bonus
 *                  x recent_trend_factor
 *                  x blowout_risk_factor
 *                  x position_cap_factor(38)
 *
 * Each factor is documented inline with rationale. The position cap is applied at the end
 * to prevent unrealistic minutes from compounding adjustments.
 *
 * The injury status modifier:
 *   - OUT      -> caller should not invoke this (player excluded from rotation entirely)
 *   - DOUBTFUL -> minutes x 0.5, confidence x 0.4
 *   - GTD      -> full projection, confidence x 0.6
 *   - PROBABLE -> full projection, confidence x 0.9
 *   - AVAILABLE -> full projection, confidence x 1.0
 *
 * Confidence starts at 100 and is deducted per the spec:
 *   - gp < 5         -> -30 (small sample)
 *   - 0.3 < gs/gp < 0.7 -> -15 (role ambiguity)
 *   - last5_std > 4  -> -10 (high variance)
 *   - first game back -> -10
 *   - then multiplied by injury modifier
 *   - floored at 30
 */

const POSITION_CAP_MINUTES = 38; // WNBA games are 40min, top players cap around 36-38
const B2B_PENALTY = 0.96;
const REST_BONUS = 1.02;
const REST_BONUS_THRESHOLD_DAYS = 3;
const ROLE_STABILITY_FLOOR = 0.85;
const ROLE_STABILITY_RANGE = 0.15; // 0.85 to 1.00 across gs/gp ratio
const RECENT_TREND_HALF_WEIGHT = 0.5; // we regress half-way to the season mean
const RECENT_TREND_CLAMP = 0.15; // recent_mpg can move season_mpg by at most +/- 15%
const BLOWOUT_SPREAD_THRESHOLD = 10;
const BLOWOUT_STARTER_PENALTY_PER_POINT = 0.005; // 0.5% reduction per extra point of spread
const BLOWOUT_BENCH_BOOST_PER_POINT = 0.008; // bench gets a bigger boost than starters lose
const BLOWOUT_STARTER_FLOOR = 0.85; // never reduce starters by more than 15%
const BLOWOUT_BENCH_CEILING = 1.30; // never boost bench by more than 30%

const INJURY_MINUTES_MULTIPLIER = {
  AVAILABLE: 1.00,
  PROBABLE: 1.00,
  GTD: 1.00,        // play at full role if active; the risk is in confidence, not minutes
  DOUBTFUL: 0.50,   // wide band -- caller should also flag for manual review
  OUT: 0.00,        // caller should skip this; here for completeness
};

const INJURY_CONFIDENCE_MULTIPLIER = {
  AVAILABLE: 1.00,
  PROBABLE: 0.90,
  GTD: 0.60,
  DOUBTFUL: 0.40,
  OUT: 0.00,
};

function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Project minutes for one player.
 *
 * @param {Object} player - season-aggregate player data
 *   Required: { season_mpg: number, gp: number, gs: number }
 *   Optional: { last5_mpg, last5_std, days_rest, is_b2b, first_game_back, is_starter }
 * @param {Object} gameContext - game-level context
 *   Optional: { spread: number }  // signed: positive = home favored, magnitude = points
 * @param {Object} injuryRecord - normalized injury record (or null/undefined for AVAILABLE)
 *   Expected shape: { status: 'AVAILABLE'|'PROBABLE'|'GTD'|'DOUBTFUL'|'OUT', ... }
 * @returns {Object} { projMinutes, confidence, floor, ceiling, factors, audit }
 */
function computeProjMinutes(player, gameContext = {}, injuryRecord = null) {
  if (!player || typeof player.season_mpg !== 'number') {
    throw new Error('computeProjMinutes: player.season_mpg required (number)');
  }
  if (typeof player.gp !== 'number' || typeof player.gs !== 'number') {
    throw new Error('computeProjMinutes: player.gp and player.gs required (numbers)');
  }

  const status = (injuryRecord && injuryRecord.status) || 'AVAILABLE';

  // OUT short-circuits: this player isn't playing. Return zeros so the caller can detect
  // and route them to teammateRedistribution instead.
  if (status === 'OUT') {
    return {
      projMinutes: 0,
      confidence: 0,
      floor: 0,
      ceiling: 0,
      factors: {},
      audit: {
        status: 'OUT',
        reason: 'player is OUT -- minutes should be redistributed via teammateRedistribution',
      },
    };
  }

  // --- Role stability factor ---
  // Starters (gs/gp near 1.0) get full weight (1.00). Pure bench (gs/gp near 0) get 0.85.
  // Rationale: starters have stable minutes by definition. Bench minutes fluctuate with
  // matchups, foul trouble, blowouts. We don't want to project a bench player to their
  // exact season MPG with full confidence -- they could play 0 or 25 in any given game.
  const startProb = player.gp > 0 ? player.gs / player.gp : 0;
  const roleStability = ROLE_STABILITY_FLOOR + ROLE_STABILITY_RANGE * clamp(startProb, 0, 1);

  // --- B2B penalty ---
  const b2bPenalty = player.is_b2b ? B2B_PENALTY : 1.00;

  // --- Rest bonus ---
  const restBonus = (player.days_rest && player.days_rest >= REST_BONUS_THRESHOLD_DAYS) ? REST_BONUS : 1.00;

  // --- Recent trend factor ---
  // If recent MPG is meaningfully different from season MPG, half-trust the trend.
  // We clamp the deviation to +/-15% so a hot streak can't double a player's projection.
  let recentTrend = 1.00;
  if (typeof player.last5_mpg === 'number' && player.season_mpg > 0) {
    const rawDev = (player.last5_mpg - player.season_mpg) / player.season_mpg;
    const clampedDev = clamp(rawDev, -RECENT_TREND_CLAMP, RECENT_TREND_CLAMP);
    recentTrend = 1 + RECENT_TREND_HALF_WEIGHT * clampedDev;
  }

  // --- Blowout risk factor ---
  // Only fires when the spread is large enough that the game is likely uncompetitive.
  // Starters lose minutes (rest in 4th quarter), bench gains them (garbage time).
  let blowoutFactor = 1.00;
  if (typeof gameContext.spread === 'number') {
    const absSpread = Math.abs(gameContext.spread);
    if (absSpread > BLOWOUT_SPREAD_THRESHOLD) {
      const extraPoints = absSpread - BLOWOUT_SPREAD_THRESHOLD;
      const isStarter = (typeof player.is_starter === 'boolean') ? player.is_starter : (startProb >= 0.7);
      if (isStarter) {
        blowoutFactor = Math.max(BLOWOUT_STARTER_FLOOR, 1.00 - BLOWOUT_STARTER_PENALTY_PER_POINT * extraPoints);
      } else {
        blowoutFactor = Math.min(BLOWOUT_BENCH_CEILING, 1.00 + BLOWOUT_BENCH_BOOST_PER_POINT * extraPoints);
      }
    }
  }

  // --- Injury modifier (multiplicative on minutes; status-specific) ---
  const injuryMinMult = INJURY_MINUTES_MULTIPLIER[status] !== undefined
    ? INJURY_MINUTES_MULTIPLIER[status] : 1.00;

  // --- Combine ---
  const rawMinutes = player.season_mpg
    * roleStability
    * b2bPenalty
    * restBonus
    * recentTrend
    * blowoutFactor
    * injuryMinMult;

  // Apply position cap last so factor stacking can't push past realistic ceiling.
  const projMinutes = Math.min(POSITION_CAP_MINUTES, Math.max(0, rawMinutes));

  // --- Confidence calculation ---
  let confidence = 100;
  const confidenceDeductions = [];

  if (player.gp < 5) { confidence -= 30; confidenceDeductions.push({ reason: 'small_sample_gp_lt_5', delta: -30 }); }
  if (startProb > 0.3 && startProb < 0.7) { confidence -= 15; confidenceDeductions.push({ reason: 'role_ambiguity', delta: -15 }); }
  if (typeof player.last5_std === 'number' && player.last5_std > 4) {
    confidence -= 10; confidenceDeductions.push({ reason: 'high_recent_variance', delta: -10 });
  }
  if (player.first_game_back) { confidence -= 10; confidenceDeductions.push({ reason: 'first_game_back', delta: -10 }); }

  // Apply injury confidence multiplier
  const injuryConfMult = INJURY_CONFIDENCE_MULTIPLIER[status] !== undefined
    ? INJURY_CONFIDENCE_MULTIPLIER[status] : 1.00;
  confidence = confidence * injuryConfMult;

  // Floor at 30 (per spec) unless OUT (which short-circuited above)
  confidence = Math.max(30, confidence);

  // --- Floor/ceiling band ---
  // Wider for DOUBTFUL/GTD, tighter for AVAILABLE/PROBABLE.
  // Target: 75-85% of outcomes within the band per spec.
  // Empirically a +/-15% band catches ~80% for stable rotation players; widen by status.
  let bandWidth = 0.15;
  if (status === 'GTD') bandWidth = 0.25;
  else if (status === 'DOUBTFUL') bandWidth = 0.40;
  else if (player.gp < 5) bandWidth = 0.25;

  const floor = Math.max(0, projMinutes * (1 - bandWidth));
  const ceiling = Math.min(POSITION_CAP_MINUTES, projMinutes * (1 + bandWidth));

  return {
    projMinutes: round1(projMinutes),
    confidence: Math.round(confidence),
    floor: round1(floor),
    ceiling: round1(ceiling),
    factors: {
      season_mpg: player.season_mpg,
      roleStability: round3(roleStability),
      b2bPenalty,
      restBonus,
      recentTrend: round3(recentTrend),
      blowoutFactor: round3(blowoutFactor),
      injuryMinMult,
    },
    audit: {
      status,
      startProb: round3(startProb),
      injuryConfMult,
      confidenceDeductions,
      rawMinutes: round1(rawMinutes),
      cappedAt: rawMinutes > POSITION_CAP_MINUTES ? POSITION_CAP_MINUTES : null,
    },
  };
}

function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }

export {
  computeProjMinutes,
  // exported for tests + tuning
  POSITION_CAP_MINUTES,
  INJURY_MINUTES_MULTIPLIER,
  INJURY_CONFIDENCE_MULTIPLIER,
};
