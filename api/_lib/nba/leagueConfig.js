// api/_lib/basketball/leagueConfig.js
// FINAL complete config — covers every key currently required by
// minutesModel, pointsEngine, reboundsAssistsEngine, gameTotals, nbaVerdict, schemeRisk

const WNBA = {
  league: 'WNBA',
  regulationMinutes: 40,
  rosterDepth: 9,
  leagueAvgPace: 80,
  leagueAvgTotal: 164,
  leagueAvgTeamTotal: 82,
  leagueAvgDefRating: 100,
  leagueAvgFoulRate: 21,
  leagueAvgFtRate: 0.22,
  starterMinutes: 20,
  closingRoleMinutes: 28,
  maxMinutes: 40,
  primaryCreatorUsage: 28,
  touchesUsageCoef: 0.7,
  touchesMinutesCoef: 1.2,
  touchesCap: 100,
  weights: {
    recentFormBlend: 0.35,
    minutesRecentBlend: 0.40,
    paceSensitivity: 0.30,
    defenseSensitivity: 0.20,
    whistleSensitivity: 0.30,
    coverageSensitivity: 0.40,
    shootingFormSensitivity: 0.35,
    blowoutThresholdSpread: 12,
    blowoutMinutesHaircut: 0.12,
    b2bMinutesHaircut: 0.04
  },
  pointsBlend: { possession: 0.55, rate: 0.45 },
  clamps: {
    pace: [0.90, 1.12],
    defense: [0.95, 1.06],
    whistle: [0.95, 1.06],
    coverage: [0.95, 1.05],
    shootingForm: [0.93, 1.08],
    reboundEquity: [0.92, 1.08],
    gameLineFactor: [0.96, 1.04],
    gameLineCombined: [0.93, 1.07],
    recentRate: [0.80, 1.25],
    combined: [0.82, 1.25],
  },
  fgToTsGap: 0.10,
  variance: {
    baseScoringCv: 0.32,
    baseReboundCv: 0.42,
    minutesCvInflation: 1.0,
  },
  rebound: {
    centerShortSensitivity: 0.55,
    centerLongPenalty: 0.65,
    guardLongSensitivity: 0.45,
    wingLongSensitivity: 0.30,
  },
  reboundLeagueAvg: {
    threeShare: 0.32,
    interiorShare: 0.42,
    midShare: 0.26,
    ftRate: 0.22,
    avgDist: 13.5,
  },
  gameLine: {
    ppgBlend: 0.70,
    homeCourtPoints: 2.0,
    winProbScale: 9.0,
    forcedTovSensitivity: 0.10,
    stealSensitivity: 0.05,
    blockSensitivity: 0.04,
    offRebAllowedSensitivity: 0.06,
    schemeSensitivity: 0.20,
  },
  gameLineLeagueAvg: {
    pts: 82, defRating: 100,
    forcedTov: 13.5, steals: 7.5, blocks: 3.8, offRebAllowed: 9.0,
  },
  thresholds: {
    minEdge: 1.5,
    minProbability: 0.56,
    leanProbability: 0.53,
  },
  bbref: {
    perGamePath: (season) => `/wnba/years/${season}_per_game.html`,
    advancedPath: (season) => `/wnba/years/${season}_advanced.html`,
    perGameTableIds: ['per_game_stats', 'per_game', 'players_per_game'],
    advancedTableIds: ['advanced_stats', 'advanced', 'players_advanced'],
    teamPath: (abbr, season) => `/wnba/teams/${abbr}/${season}.html`,
    playerSlugFromLink: /href="\/wnba\/players\/[a-z0-9]\/([a-z0-9]+\.html)"/i,
  },
};

const NBA = {
  league: 'NBA',
  posture: 'shadow',

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

  // ---------- minutesModel.js ----------
  minutes: {
    floor: 6,
    cap: 42,
    scenarioNodes: 5,
    teamChangeCVMult: 1.6,
  },

  minutesModel: {
    recentN: 10,
    recencyL10: 0.45,
    recencyL5: 0.55,
    b2bPenalty: 2.5,
    b2bVeteranAge: 32,
    b2bVeteranExtra: 2.0,
    blowoutSpread: 12,
    blowoutMaxPenalty: 4.0,
    blowoutAlphaExemption: 0.6,
    alphaUsgLo: 20,
    alphaUsgHi: 30,
    benchMinutes: 18,
    garbageTimeBump: 3.0,
    teammateOutBump: 2.0,
    teammateOutMaxBump: 5.0,
    designationHaircut: {
      out: 0,
      doubtful: 0.50,
      questionable: 0.88,
      gtd: 0.88,
      'day-to-day': 0.92,
      probable: 0.98,
      available: 1.0,
    },
    reducedMinutesRatio: 0.75,
    lowSecurityCVFloor: 0.28,
    roleUncertainCVMult: 1.5,
    adjustmentCap: 8.0,
    securityStarterWeight: 0.6,
  },

  // ---------- pointsEngine / reboundsAssistsEngine ----------
  dist: {
    floorPctile: 0.15,
    ceilingPctile: 0.85,
  },

  lineAboveCeiling: {
    enabled: true,
  },

  edge: {
    minEdge: 0.08,
  },

  calibration: {
    fadeOverThreshold: 0.60,
    fadeOverWeight: 0.35,
    mildOverWeight: 0.70,
    minSample: 20,
    breakeven: 0.577,
    strongRate: 0.62,
    eliteRate: 0.67,
  },

  markets: {
    rebounds: { k: 12, minEdge: 0.06 },
    assists:  { k: 6,  minEdge: 0.06 },
    points:   { minEdge: 0.08 },
  },

  combo: {
    minEdge: 0.07,
    thinGap: 1.5,
    corrInflation: 0.12,
  },

  roleGuard: {
    gapPct: 0.18,
  },

  // ---------- gameTotals.js (the current crash) ----------
  totals: {
    leagueRtg: 113,
    leaguePace: 99.5,
    leagueFtr: 0.26,
    injuryCoef: 0.12,
    injuryCap: 0.10,
    injurySeverity: {
      out: 1.0,
      doubtful: 0.5,
      questionable: 0.2,
      gtd: 0.2,
      dtd: 0.1,
      probable: 0.05,
      available: 0,
    },
    ftCoef: 0.3,
    ftCap: 0.02,
    sigma: 10,
    minEdgePts: 3.0,
    gameMinEdge: 0.04,
    teamMinEdge: 0.05,
  },

  // ---------- schemeRisk ----------
  schemeRisk: {
    foulRateHigh: 3.8,
    foulRateVeryHigh: 4.6,
    foulPenalty: 14,
    foulVeryHighPenalty: 22,
    minProjMinutes: 28,
    minutesHaircutThreshold: 0.88,
    minutesRiskPenalty: 18,
    roleUncertainPenalty: 12,
    highUsgThreshold: 26,
    highRebRateThreshold: 12,
    volumeBoost: 10,
    secondaryCompetitionPenalty: 12,
    purePointsHostilePenalty: 12,
    lowPaceTotal: 218,
    blowoutSpread: 9.5,
    forcedPassScore: 28,
    underAdviseScore: 35,
    highFloorScore: 68,

    // PTS hard filters (post 2026-11-27 lessons — Reaves return, H2H thin, etc.)
    returnMissGames: 3,
    returnActiveGamesRequired: 2,
    returnRiskPenalty: 20,
    h2hCushionPts: 1.5,
    h2hThinPenalty: 14,
    h2hSampleMin: 5,
    ptsCompoundHardLimit: 2,
    eliteDefPtsAdj: -1.5,
    eliteDefPenalty: 10,
  },

  // ---------- general ----------
  weights: {
    recentFormBlend: 0.35,
    minutesRecentBlend: 0.40,
    paceSensitivity: 0.50,
    defenseSensitivity: 0.50,
    whistleSensitivity: 0.30,
    coverageSensitivity: 0.40,
    shootingFormSensitivity: 0.35,
    blowoutThresholdSpread: 14,
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
    gameLineFactor: [0.96, 1.04],
    gameLineCombined: [0.93, 1.07],
    recentRate: [0.80, 1.25],
    combined: [0.82, 1.28],
  },

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
    threeShare: 0.39,
    interiorShare: 0.40,
    midShare: 0.21,
    ftRate: 0.24,
    avgDist: 14.5,
  },

  gameLine: {
    ppgBlend: 0.70,
    homeCourtPoints: 2.4,
    winProbScale: 11.0,
    forcedTovSensitivity: 0.10,
    stealSensitivity: 0.05,
    blockSensitivity: 0.04,
    offRebAllowedSensitivity: 0.06,
    schemeSensitivity: 0.20,
  },
  gameLineLeagueAvg: {
    pts: 113, defRating: 113,
    forcedTov: 13.5, steals: 7.8, blocks: 5.0, offRebAllowed: 10.5,
  },

  thresholds: {
    minEdge: 2.0,
    minProbability: 0.56,
    leanProbability: 0.53,
  },

  regime: {
    openingDays: 14,
    deadlineFrom: 1,
    deadlineTo: 12,
    disrupted: ['opening', 'playoffs', 'deadline', 'b2b', 'tanking'],
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

export function getLeagueConfig(league = 'WNBA') {
  const key = String(league).toUpperCase();
  const cfg = PRESETS[key];
  if (!cfg) throw new Error(`Unknown league "${league}". Known: ${Object.keys(PRESETS).join(', ')}`);
  return cfg;
}

export const CONFIGS = PRESETS;

export { WNBA, NBA };
export default NBA;
