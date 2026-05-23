/**
 * pointsProjection.js
 *
 * Per-player points projection. Sits downstream of minutesProjection + teammateRedistribution
 * so it picks up injury-driven minute changes AND backup usage boosts automatically.
 *
 * Core formula (possession-based decomposition):
 *
 *   proj_points = proj_minutes
 *                 x team_pace_per_min
 *                 x usage_rate
 *                 x points_per_possession
 *                 x pace_factor (opponent influence)
 *                 x matchup_factor (opponent defensive efficiency vs position)
 *                 x recent_form_factor
 *                 x b2b_efficiency_penalty
 *
 * Each factor is multiplicative and bounded. Final value is clamped to a sane range
 * (0 to player-specific ceiling = season_ppg * 2.0) to prevent compounding adjustments
 * from producing absurd projections.
 *
 * Why possession-based instead of points-per-minute (ppm)?
 *   - When redistribution boosts a backup's usage from 18% to 24%, ppm doesn't capture
 *     that -- the backup's historical ppm reflects their historical usage, not their
 *     new role. Possession-based math picks up usage shifts automatically.
 *   - When opponent pace differs from average, total team possessions shift, which
 *     should flow through to every player's projection proportionally. ppm misses this.
 *   - When a player faces a tougher position-specific defense, matchup_factor adjusts
 *     points_per_possession directly. ppm has no clean way to apply this.
 *
 * Confidence: inherits from minutesProjection (we don't double-count those penalties)
 * then applies points-specific multipliers for: thin efficiency sample, cold streak,
 * new role (usage delta > 0.05 since last 5 games).
 *
 * Inputs expected on the player object (most come from wnbaPlayerData / redistribution):
 *   Required from minutes engine: projMinutes, confidence
 *   Required season stats: season_ppg, usage, ts_pct  (true shooting %)
 *   Optional: last5_ppg, last5_usage, position
 *
 * Inputs expected on gameContext:
 *   Required: team_pace, opp_pace, opp_def_rating  (per-100 possessions)
 *   Optional: opp_def_vs_position (defensive rating allowed by opponent vs this position)
 *   Optional: spread (already used in minutesProjection but we re-read for efficiency tweaks)
 *   Optional: is_b2b
 */

// League-average baselines (WNBA 2025 season approximations).
// These exist so a single missing opponent stat doesn't crater the whole projection -- we fall
// back to league average and flag it in audit.
const LEAGUE_AVG_PACE = 80;              // possessions per 40 minutes
const LEAGUE_AVG_DEF_RATING = 104;       // points allowed per 100 possessions
const LEAGUE_AVG_TS_PCT = 0.535;         // true shooting % across the league
const LEAGUE_AVG_USAGE = 0.20;           // 20% usage = average role player

// Tuning constants
const PACE_FACTOR_CLAMP = 0.12;          // pace adjustment bounded at +/-12%
const MATCHUP_FACTOR_CLAMP = 0.18;       // matchup swing bounded at +/-18%
const RECENT_FORM_CLAMP = 0.15;          // recent form bounded at +/-15%
const RECENT_FORM_WEIGHT = 0.5;          // half-trust recent form, regress to mean
const B2B_EFFICIENCY_PENALTY = 0.97;     // 3% efficiency drop on tired legs
const CEILING_MULTIPLIER = 2.0;          // proj never exceeds 2x season_ppg
const FLOOR_MULTIPLIER = 0.0;            // proj never goes below 0

// Confidence deductions (applied on top of minutes engine's confidence)
const COLD_STREAK_DEDUCTION = 10;        // last5_ppg < 70% of season_ppg
const ROLE_SHIFT_DEDUCTION = 15;         // usage moved >5pp from season norm
const THIN_EFFICIENCY_SAMPLE_DEDUCTION = 12;  // ts_pct based on < 5 games

function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Project points for one player.
 *
 * @param {Object} player - player with minutes already projected
 *   Required: { projMinutes, confidence, season_ppg, usage, ts_pct }
 *   Optional: { last5_ppg, last5_usage, position, gp }
 * @param {Object} gameContext - { team_pace, opp_pace, opp_def_rating, opp_def_vs_position?, is_b2b? }
 * @returns {Object} { projPoints, confidence, floor, ceiling, factors, audit }
 */
function computeProjPoints(player, gameContext = {}) {
  if (!player) throw new Error('computeProjPoints: player required');
  if (typeof player.projMinutes !== 'number') {
    throw new Error('computeProjPoints: player.projMinutes required (run minutesProjection first)');
  }
  if (typeof player.season_ppg !== 'number') {
    throw new Error('computeProjPoints: player.season_ppg required');
  }

  // Short-circuit: zero minutes = zero points.
  if (player.projMinutes === 0) {
    return {
      projPoints: 0,
      confidence: 0,
      floor: 0,
      ceiling: 0,
      factors: {},
      audit: { reason: 'projMinutes is 0 -- player not playing' },
    };
  }

  // --- Gather inputs with league-average fallbacks ---
  const usage = typeof player.usage === 'number' ? player.usage : LEAGUE_AVG_USAGE;
  const tsPct = typeof player.ts_pct === 'number' ? player.ts_pct : LEAGUE_AVG_TS_PCT;
  const teamPace = typeof gameContext.team_pace === 'number' ? gameContext.team_pace : LEAGUE_AVG_PACE;
  const oppPace = typeof gameContext.opp_pace === 'number' ? gameContext.opp_pace : LEAGUE_AVG_PACE;
  const oppDefRating = typeof gameContext.opp_def_rating === 'number' ? gameContext.opp_def_rating : LEAGUE_AVG_DEF_RATING;

  const fallbacksUsed = [];
  if (typeof player.usage !== 'number') fallbacksUsed.push('usage');
  if (typeof player.ts_pct !== 'number') fallbacksUsed.push('ts_pct');
  if (typeof gameContext.team_pace !== 'number') fallbacksUsed.push('team_pace');
  if (typeof gameContext.opp_pace !== 'number') fallbacksUsed.push('opp_pace');
  if (typeof gameContext.opp_def_rating !== 'number') fallbacksUsed.push('opp_def_rating');

  // --- Possessions estimate ---
  // pace_per_min = team_pace / 40 (WNBA games are 40 min)
  // possessions = projMinutes * pace_per_min
  const pacePerMin = teamPace / 40;
  const playerPossessions = player.projMinutes * pacePerMin;

  // --- Pace factor (opponent influence on total possessions) ---
  // Average of own team's pace and opponent's pace, normalized to league avg.
  // If opp plays slow (low pace), total possessions drop, every player's expected scoring drops.
  const blendedPace = (teamPace + oppPace) / 2;
  const rawPaceFactor = blendedPace / LEAGUE_AVG_PACE;
  // We already used team_pace in possession calc, so this is the *incremental* opponent adjustment.
  // Apply only the opponent half, clamped.
  const oppPaceDelta = (oppPace - LEAGUE_AVG_PACE) / LEAGUE_AVG_PACE;
  const paceFactor = 1 + clamp(oppPaceDelta, -PACE_FACTOR_CLAMP, PACE_FACTOR_CLAMP) * 0.5;

  // --- Matchup factor (opponent defensive efficiency) ---
  // If opponent has a tough defense (low def_rating, allowing fewer pts/100), reduce projection.
  // We prefer position-specific def rating when available.
  const effectiveDefRating = typeof gameContext.opp_def_vs_position === 'number'
    ? gameContext.opp_def_vs_position
    : oppDefRating;
  // Lower def_rating = tougher defense = lower matchup factor
  const matchupRawFactor = effectiveDefRating / LEAGUE_AVG_DEF_RATING;
  const matchupFactor = 1 + clamp(matchupRawFactor - 1, -MATCHUP_FACTOR_CLAMP, MATCHUP_FACTOR_CLAMP);

  // --- Recent form factor ---
  // If last5_ppg differs from season_ppg, half-trust the trend (regress to mean).
  let recentForm = 1.00;
  if (typeof player.last5_ppg === 'number' && player.season_ppg > 0) {
    const rawDev = (player.last5_ppg - player.season_ppg) / player.season_ppg;
    const clampedDev = clamp(rawDev, -RECENT_FORM_CLAMP, RECENT_FORM_CLAMP);
    recentForm = 1 + RECENT_FORM_WEIGHT * clampedDev;
  }

  // --- B2B efficiency penalty (separate from b2b minutes penalty in minutesProjection) ---
  const b2bEfficiency = gameContext.is_b2b ? B2B_EFFICIENCY_PENALTY : 1.00;

  // --- Points per possession ---
  // ppp = 2 * ts_pct (true shooting accounts for FG%, 3P%, and FT% in one number)
  // This is the WNBA-standard derivation: TS measures points per shooting possession,
  // multiplied by 2 because each possession yields 0 or 2+ points on average.
  // For a player at .535 TS (league avg), ppp ~= 1.07, which matches league offensive rating.
  const pointsPerPossession = 2 * tsPct;

  // --- Combine ---
  const rawPoints = playerPossessions * usage * pointsPerPossession * paceFactor * matchupFactor * recentForm * b2bEfficiency;

  // Clamp to sane range
  const ceiling = player.season_ppg * CEILING_MULTIPLIER;
  const projPoints = clamp(rawPoints, FLOOR_MULTIPLIER, ceiling);

  // --- Confidence: inherit from minutes engine, apply points-specific deductions ---
  let confidence = typeof player.confidence === 'number' ? player.confidence : 100;
  const confidenceDeductions = [];

  // Cold streak: recent scoring is way below norm
  if (typeof player.last5_ppg === 'number' && player.season_ppg > 0) {
    if (player.last5_ppg < player.season_ppg * 0.70) {
      confidence -= COLD_STREAK_DEDUCTION;
      confidenceDeductions.push({ reason: 'cold_streak', delta: -COLD_STREAK_DEDUCTION });
    }
  }

  // Role shift: usage has moved meaningfully from season norm
  if (typeof player.last5_usage === 'number' && typeof player.usage === 'number') {
    if (Math.abs(player.last5_usage - player.usage) > 0.05) {
      confidence -= ROLE_SHIFT_DEDUCTION;
      confidenceDeductions.push({ reason: 'role_shift', delta: -ROLE_SHIFT_DEDUCTION });
    }
  }

  // Thin efficiency sample
  if (typeof player.gp === 'number' && player.gp < 5) {
    confidence -= THIN_EFFICIENCY_SAMPLE_DEDUCTION;
    confidenceDeductions.push({ reason: 'thin_efficiency_sample', delta: -THIN_EFFICIENCY_SAMPLE_DEDUCTION });
  }

  confidence = Math.max(20, confidence); // floor lower than minutes since points is noisier

  // --- Floor/ceiling band ---
  // Points has more variance than minutes; band wider.
  // Use std-dev-style approach: wider band when usage is high (more shots = more variance from single hot/cold game).
  let bandWidth = 0.22;
  if (usage > 0.25) bandWidth = 0.28;     // high-usage = bigger swings
  if (typeof player.gp === 'number' && player.gp < 5) bandWidth = 0.35;
  if (gameContext.is_b2b) bandWidth += 0.04;

  const floor = Math.max(0, projPoints * (1 - bandWidth));
  const ceilingBand = Math.min(ceiling, projPoints * (1 + bandWidth));

  return {
    projPoints: round1(projPoints),
    confidence: Math.round(confidence),
    floor: round1(floor),
    ceiling: round1(ceilingBand),
    factors: {
      projMinutes: player.projMinutes,
      possessions: round1(playerPossessions),
      usage: round3(usage),
      pointsPerPossession: round3(pointsPerPossession),
      paceFactor: round3(paceFactor),
      matchupFactor: round3(matchupFactor),
      recentForm: round3(recentForm),
      b2bEfficiency,
    },
    audit: {
      rawPoints: round1(rawPoints),
      clampedAt: rawPoints > ceiling ? ceiling : (rawPoints < 0 ? 0 : null),
      confidenceDeductions,
      fallbacksUsed,
      formula: 'possessions * usage * ppp * paceFactor * matchupFactor * recentForm * b2bEff',
    },
  };
}

function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }

module.exports = {
  computeProjPoints,
  LEAGUE_AVG_PACE,
  LEAGUE_AVG_DEF_RATING,
  LEAGUE_AVG_TS_PCT,
  LEAGUE_AVG_USAGE,
};
