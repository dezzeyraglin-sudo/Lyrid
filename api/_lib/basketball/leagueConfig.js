// api/_lib/basketball/leagueConfig.js
//
// LEAGUE CONFIG (June 1, 2026)
//
// Single source of truth for every league-specific constant the points engine
// touches. The engine is league-agnostic; it reads everything from here.
//
// WHY THIS EXISTS:
//   The WNBA build is the testbed for an eventual NBA engine. The architecture
//   ports cleanly, but the constants do not — WNBA games are 40 minutes at
//   ~80 possessions; NBA is 48 minutes at ~99. Baking those numbers into the
//   engine means the NBA port is a hunt-and-replace through every module.
//   Parameterizing them here means the port is: pick a different preset.
//
// CALIBRATION NOTE:
//   The `weights` and `variance` blocks are HEURISTIC PRIORS, not truth. They
//   are the knobs the MAE validation tunes. WNBA-tuned weights are NOT valid
//   for NBA — each league re-tunes from scratch. Treat the NBA preset's weights
//   as copies of the WNBA priors until NBA has its own validation history.

// =============================================================
// WNBA PRESET (in-season — the testbed)
// =============================================================

const WNBA = {
  league: 'WNBA',

  // --- Game structure ---
  regulationMinutes: 40,
  rosterDepth: 9,                 // typical games-played rotation size

  // --- League baselines (for normalization) ---
  leagueAvgPace: 80,              // possessions per game
  leagueAvgTotal: 164,            // game total
  leagueAvgTeamTotal: 82,
  leagueAvgDefRating: 100,        // points allowed per 100 possessions
  leagueAvgFoulRate: 21,         // team fouls per game
  leagueAvgFtRate: 0.22,          // league FTA / FGA

  // --- Minutes / role heuristics (game-length sensitive) ---
  starterMinutes: 20,
  closingRoleMinutes: 28,
  maxMinutes: 40,

  // --- Usage ---
  primaryCreatorUsage: 28,

  // --- Touches approximation (bbref has no tracking touches) ---
  touchesUsageCoef: 0.7,
  touchesMinutesCoef: 1.2,
  touchesCap: 100,

  // --- Calibration weights (TUNE VIA MAE) ---
  weights: {
    recentFormBlend: 0.35,        // weight on last-N scoring rate vs season
    minutesRecentBlend: 0.40,     // weight on recent minutes vs season minutes
    paceSensitivity: 0.50,        // dampening on the raw pace multiplier
    defenseSensitivity: 0.50,     // dampening on the raw opponent-defense multiplier
    whistleSensitivity: 0.30,     // dampening on the whistle multiplier
    coverageSensitivity: 0.40,    // dampening on the coaching-coverage scheme multiplier
    shootingFormSensitivity: 0.35, // dampening on recent-vs-season FG% (hot/cold hand)
    blowoutThresholdSpread: 12,   // |spread| beyond which a blowout is likely
    blowoutMinutesHaircut: 0.12,  // fraction of minutes shaved off starters in projected blowouts
    b2bMinutesHaircut: 0.04,      // minutes shaved on the back end of a back-to-back
  },

  // --- Points blend: how the unified engine combines the two scoring cores ---
  // possession = minutes x pace x usage x points-per-possession (catches usage spikes)
  // rate       = realized PPG blended with recent form (robust, lags role change)
  pointsBlend: { possession: 0.55, rate: 0.45 },

  // --- Multiplier clamps (sanity rails; keep adjustments honest) ---
  clamps: {
    pace: [0.90, 1.12],
    defense: [0.90, 1.12],
    whistle: [0.95, 1.06],
    coverage: [0.95, 1.05],       // coaching scheme effect; neutral (1.0) until coverage data exists
    shootingForm: [0.93, 1.08],   // recent FG% hot/cold adjustment to scoring efficiency
    reboundEquity: [0.78, 1.22],  // archetype rebound-equity swing from shot geography
    recentRate: [0.80, 1.25],
    combined: [0.82, 1.25],       // overall cap on the stacked multiplier (anti career-high rail)
  },

  // League-typical gap between FG% and TS% (TS sits above FG% due to 3PT + FT
  // value). Used to derive a TS proxy from FG% when advanced TS% is missing,
  // so the possession core stays alive. WNBA: ~0.535 TS vs ~0.435 FG ≈ 0.10.
  fgToTsGap: 0.10,

  // --- Variance / distribution ---
  variance: {
    baseScoringCv: 0.32,          // game-to-game points CV for a rotation scorer
    baseReboundCv: 0.42,          // rebounds are noisier than points
    minutesCvInflation: 1.0,      // how strongly minutes volatility widens the distribution
  },

  // --- Rebound-environment engine ---
  rebound: {
    centerShortSensitivity: 0.55, // center gains as short-miss share rises above 50%
    centerLongPenalty: 0.65,      // center loses as long-miss share rises above 50%
    guardLongSensitivity: 0.45,   // guard gains on long misses (perimeter boards)
    wingLongSensitivity: 0.30,    // wing gains moderately on long misses
  },
  reboundLeagueAvg: {
    // League-average shot diet (shares 0–1) — the classifier types each opponent
    // relative to these. WNBA-typical; refine from data as the season matures.
    threeShare: 0.32,
    interiorShare: 0.42,          // rim + paint
    midShare: 0.26,
    ftRate: 0.22,                 // FTA per FGA
    avgDist: 13.5,
  },

  // --- Recommendation thresholds ---
  thresholds: {
    minEdge: 1.5,                 // |proj - line| in points required to act
    minProbability: 0.56,         // model prob required for OVER/UNDER (else LEAN/PASS)
    leanProbability: 0.53,
  },

  // --- bbref source layer (league-specific paths + table ids) ---
  bbref: {
    perGamePath: (season) => `/wnba/years/${season}_per_game.html`,
    advancedPath: (season) => `/wnba/years/${season}_advanced.html`,
    perGameTableIds: ['per_game_stats', 'per_game', 'players_per_game'],
    advancedTableIds: ['advanced_stats', 'advanced', 'players_advanced'],
    teamPath: (abbr, season) => `/wnba/teams/${abbr}/${season}.html`,
    playerSlugFromLink: /href="\/wnba\/players\/[a-z0-9]\/([a-z0-9]+\.html)"/i,
  },
};

// =============================================================
// NBA PRESET (offseason — starter values for the future build)
// =============================================================
// These are reasonable league baselines, NOT validated weights. The weights
// block is copied from WNBA as a starting prior. Re-tune against NBA MAE.

const NBA = {
  league: 'NBA',

  regulationMinutes: 48,
  rosterDepth: 10,

  leagueAvgPace: 99,
  leagueAvgTotal: 230,
  leagueAvgTeamTotal: 115,
  leagueAvgDefRating: 114,
  leagueAvgFoulRate: 19,
  leagueAvgFtRate: 0.24,

  starterMinutes: 25,
  closingRoleMinutes: 32,
  maxMinutes: 42,

  primaryCreatorUsage: 28,

  touchesUsageCoef: 0.7,
  touchesMinutesCoef: 1.2,
  touchesCap: 120,

  // Copied from WNBA as a prior. DO NOT trust on NBA until re-validated.
  weights: {
    recentFormBlend: 0.35,
    minutesRecentBlend: 0.40,
    paceSensitivity: 0.50,
    defenseSensitivity: 0.50,
    whistleSensitivity: 0.30,
    coverageSensitivity: 0.40,
    shootingFormSensitivity: 0.35,
    blowoutThresholdSpread: 14,   // NBA blowouts run a bit wider
    blowoutMinutesHaircut: 0.14,
    b2bMinutesHaircut: 0.05,
  },

  pointsBlend: { possession: 0.55, rate: 0.45 },

  clamps: {
    pace: [0.90, 1.12],
    defense: [0.90, 1.15],
    whistle: [0.95, 1.06],
    coverage: [0.95, 1.05],
    shootingForm: [0.93, 1.08],
    reboundEquity: [0.78, 1.22],
    recentRate: [0.80, 1.25],
    combined: [0.82, 1.28],
  },

  // NBA: ~0.57 TS vs ~0.46 FG ≈ 0.11.
  fgToTsGap: 0.11,

  variance: {
    baseScoringCv: 0.30,
    baseReboundCv: 0.40,
    minutesCvInflation: 1.0,
  },

  rebound: {
    centerShortSensitivity: 0.55,
    centerLongPenalty: 0.65,
    guardLongSensitivity: 0.45,
    wingLongSensitivity: 0.30,
  },
  reboundLeagueAvg: {
    threeShare: 0.39,             // NBA shoots more 3s than WNBA
    interiorShare: 0.40,
    midShare: 0.21,
    ftRate: 0.24,
    avgDist: 14.5,
  },

  thresholds: {
    minEdge: 2.0,                 // NBA points lines are higher; require a bigger edge
    minProbability: 0.56,
    leanProbability: 0.53,
  },

  bbref: {
    perGamePath: (season) => `/leagues/NBA_${season}_per_game.html`,
    advancedPath: (season) => `/leagues/NBA_${season}_advanced.html`,
    perGameTableIds: ['per_game_stats', 'per_game'],
    advancedTableIds: ['advanced_stats', 'advanced'],
    teamPath: (abbr, season) => `/teams/${abbr}/${season}.html`,
    playerSlugFromLink: /href="\/players\/[a-z]\/([a-z0-9]+\.html)"/i,
  },
};

const PRESETS = { WNBA, NBA };

/**
 * Get the config for a league.
 * @param {string} league - 'WNBA' | 'NBA'
 * @returns {Object} league config (throws on unknown league)
 */
export function getLeagueConfig(league = 'WNBA') {
  const key = String(league).toUpperCase();
  const cfg = PRESETS[key];
  if (!cfg) throw new Error(`Unknown league "${league}". Known: ${Object.keys(PRESETS).join(', ')}`);
  return cfg;
}

export { WNBA, NBA };
