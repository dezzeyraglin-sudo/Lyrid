/**
 * Mismatch Finder — Prop Formula Engine
 *
 * Safe add-on module. It does not call external APIs and does not mutate your existing
 * analyze output. Import these helpers inside api/analyze.js after your normal matchup
 * calculations are already complete.
 */

export const PROP_TYPES = Object.freeze({
  PITCHER_KS: "pitcher_ks",
  HITS: "hits",
  HRR: "hrr", // Hits + Runs + RBIs
  FANTASY_SCORE: "fantasy_score",
  RUNS: "runs",
  RBI: "rbi",
  HR: "hr",
  WALKS_ALLOWED: "walks_allowed",
  EARNED_RUNS_ALLOWED: "earned_runs_allowed",
  HITS_ALLOWED: "hits_allowed"
});

export const SIDES = Object.freeze({
  MORE: "more",
  LESS: "less"
});

export const GAME_TYPES = Object.freeze({
  POWER: "Power Scoring",
  CONTACT: "Contact/Sequencing Scoring",
  FULL_OFFENSE: "Full Offensive Environment",
  SUPPRESSED: "Suppressed Game",
  MIXED: "Mixed"
});

export function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function safeRatio(numerator, denominator, fallback = 1) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return fallback;
  return n / d;
}

export function toIndex(value, leagueAverage, fallback = 100) {
  return clamp(safeRatio(value, leagueAverage, fallback / 100) * 100, 0, 200);
}

/**
 * Run Power Index. Higher = runs more likely from HR/XBH/power paths.
 * Pass pre-normalized indexes if available; otherwise raw rates + league averages.
 */
export function calculateRunPowerIndex(input = {}) {
  const teamHRIndex = input.teamHRIndex ?? toIndex(input.teamHRPerPA, input.leagueHRPerPA);
  const xbhIndex = input.xbhIndex ?? toIndex(input.teamXBHPerPA, input.leagueXBHPerPA);
  const parkHRFactor = input.parkHRFactor ?? 100;
  const weatherHRFactor = input.weatherHRFactor ?? 100;
  const pitcherHRWeakness = input.pitcherHRWeakness ?? toIndex(input.pitcherHRAllowedPerPA, input.leagueHRAllowedPerPA);

  return clamp(
    0.35 * teamHRIndex +
      0.25 * xbhIndex +
      0.20 * parkHRFactor +
      0.10 * weatherHRFactor +
      0.10 * pitcherHRWeakness,
    0,
    200
  );
}

/**
 * Run Contact Index. Higher = runs more likely from balls in play, OBP, sequencing.
 */
export function calculateRunContactIndex(input = {}) {
  const contactRateIndex = input.contactRateIndex ?? toIndex(input.teamContactRate, input.leagueContactRate);
  const obpIndex = input.obpIndex ?? toIndex(input.teamOBP, input.leagueOBP);
  const kSuppressionIndex = input.kSuppressionIndex ?? toIndex(input.leagueKRate, input.teamKRate);
  const bullpenXwOBAIndex = input.bullpenXwOBAIndex ?? toIndex(input.bullpenXwOBAAllowed, input.leagueBullpenXwOBA);
  const babipRunProfile = input.babipRunProfile ?? toIndex(input.teamBABIP, input.leagueBABIP);

  return clamp(
    0.30 * contactRateIndex +
      0.20 * obpIndex +
      0.20 * kSuppressionIndex +
      0.15 * bullpenXwOBAIndex +
      0.15 * babipRunProfile,
    0,
    200
  );
}

export function classifyGameType({ rpi, rci }) {
  const delta = rpi - rci;
  if (rpi >= 110 && delta >= 8) return GAME_TYPES.POWER;
  if (rci >= 110 && delta <= -8) return GAME_TYPES.CONTACT;
  if (rpi >= 105 && rci >= 105) return GAME_TYPES.FULL_OFFENSE;
  if (rpi < 95 && rci < 95) return GAME_TYPES.SUPPRESSED;
  return GAME_TYPES.MIXED;
}

export function calculateEnvironment(input = {}) {
  const rpi = calculateRunPowerIndex(input);
  const rci = calculateRunContactIndex(input);
  return {
    rpi,
    rci,
    delta: rpi - rci,
    gameType: classifyGameType({ rpi, rci })
  };
}

export function calculatePropEdge({ projection, line, side = SIDES.MORE }) {
  const p = Number(projection);
  const l = Number(line);
  if (!Number.isFinite(p) || !Number.isFinite(l) || l <= 0) {
    return { rawEdge: 0, edgePercent: 0, valid: false };
  }

  const rawEdge = side === SIDES.LESS ? l - p : p - l;
  return {
    rawEdge,
    edgePercent: rawEdge / l,
    valid: true
  };
}

export function minimumEdgeForProp(propType) {
  const table = {
    [PROP_TYPES.FANTASY_SCORE]: 0.12,
    [PROP_TYPES.HRR]: 0.10,
    [PROP_TYPES.HITS]: 0.08,
    [PROP_TYPES.PITCHER_KS]: 0.10,
    [PROP_TYPES.WALKS_ALLOWED]: 0.15,
    [PROP_TYPES.EARNED_RUNS_ALLOWED]: 0.15,
    [PROP_TYPES.HITS_ALLOWED]: 0.15,
    [PROP_TYPES.HR]: 0.20,
    [PROP_TYPES.RUNS]: 0.15,
    [PROP_TYPES.RBI]: 0.15
  };
  return table[propType] ?? 0.12;
}

export function baseVolatility(propType) {
  const table = {
    [PROP_TYPES.PITCHER_KS]: 35,
    [PROP_TYPES.HITS]: 45,
    [PROP_TYPES.HRR]: 55,
    [PROP_TYPES.FANTASY_SCORE]: 65,
    [PROP_TYPES.RUNS]: 70,
    [PROP_TYPES.RBI]: 75,
    [PROP_TYPES.HR]: 95,
    [PROP_TYPES.WALKS_ALLOWED]: 80,
    [PROP_TYPES.EARNED_RUNS_ALLOWED]: 85,
    [PROP_TYPES.HITS_ALLOWED]: 70
  };
  return table[propType] ?? 60;
}

export function calculateVolatility({
  propType,
  playerRoleVolatility = 0,
  environmentVolatility = 0,
  lineSensitivity = 0
} = {}) {
  return clamp(baseVolatility(propType) + playerRoleVolatility + environmentVolatility + lineSensitivity, 0, 100);
}

export function roleStabilityScore(input = {}) {
  const lineupSpot = Number(input.lineupSpot);
  let lineupSpotStability = 55;
  if (lineupSpot >= 1 && lineupSpot <= 4) lineupSpotStability = 100;
  else if (lineupSpot >= 5 && lineupSpot <= 6) lineupSpotStability = 80;
  else if (lineupSpot >= 7 && lineupSpot <= 9) lineupSpotStability = 55;
  if (input.benchRisk) lineupSpotStability = 25;

  const paProjectionIndex = clamp(safeRatio(input.projectedPA ?? 4.2, 4.2) * 100, 0, 125);
  const recentStartRate = clamp(safeRatio(input.startsLast10 ?? 8, 10) * 100, 0, 100);

  const pinchHitRisk = input.pinchHitRisk ?? "low";
  const pinchHitSafety = pinchHitRisk === "high" ? 40 : pinchHitRisk === "medium" ? 70 : 100;

  return clamp(
    0.35 * lineupSpotStability +
      0.30 * paProjectionIndex +
      0.20 * recentStartRate +
      0.15 * pinchHitSafety,
    0,
    100
  );
}

export function kSuppressionIndex(input = {}) {
  const lineupKResistance = input.lineupKResistance ?? toIndex(input.leagueKRate, input.opponentKRate);
  const contactVsArsenal = input.contactVsArsenal ?? toIndex(input.opponentContactVsPitchMix, input.leagueContactRate);
  const pitcherLeashRisk = input.pitcherLeashRisk ?? toIndex(input.leagueAvgIP, input.pitcherRecentIP);
  const recentKDowntrend = input.recentKDowntrend ?? toIndex(input.pitcherSeasonKPerStart, input.pitcherLast3KPerStart);

  return clamp(
    0.35 * lineupKResistance +
      0.25 * contactVsArsenal +
      0.20 * pitcherLeashRisk +
      0.20 * recentKDowntrend,
    0,
    200
  );
}

export function lateInningEquity(input = {}) {
  const starterShortness = input.starterShortness ?? toIndex(input.leagueAvgSPIP, input.pitcherRecentIP);
  const bullpenWeakness = input.bullpenWeakness ?? toIndex(input.bullpenXwOBAAllowed, input.leagueBullpenXwOBA);
  const bullpenFatigue = input.bullpenFatigue ?? toIndex(input.bullpenPitchesLast3Days, input.leagueAvgBullpenPitchesLast3Days);
  const lineupLateScoring = input.lineupLateScoring ?? toIndex(input.teamRunsInnings6to9, input.leagueAvgRunsInnings6to9);

  return clamp(
    0.35 * starterShortness +
      0.30 * bullpenWeakness +
      0.20 * bullpenFatigue +
      0.15 * lineupLateScoring,
    0,
    200
  );
}

export function trapScore(input = {}) {
  const lowEdgeFlag = input.edgePercent < 0.10 ? 100 : 0;
  const highVolatilityFlag = input.volatility >= 65 ? 100 : 0;
  const demonGoblinFlag = input.isDemon || input.isGoblin ? 100 : 0;

  return clamp(
    0.30 * (input.popularityIndex ?? 0) +
      0.25 * (input.lineInflationIndex ?? 0) +
      0.20 * lowEdgeFlag +
      0.15 * highVolatilityFlag +
      0.10 * demonGoblinFlag,
    0,
    100
  );
}

export function environmentFitAdjustment({ gameType, propType, side }) {
  if (gameType === GAME_TYPES.POWER) {
    if (side === SIDES.MORE && propType === PROP_TYPES.FANTASY_SCORE) return 8;
    if (side === SIDES.MORE && propType === PROP_TYPES.HRR) return 5;
    if (side === SIDES.LESS && [PROP_TYPES.FANTASY_SCORE, PROP_TYPES.HRR, PROP_TYPES.HITS].includes(propType)) return -6;
  }

  if (gameType === GAME_TYPES.CONTACT) {
    if (side === SIDES.MORE && propType === PROP_TYPES.HRR) return 5;
    if (side === SIDES.MORE && propType === PROP_TYPES.FANTASY_SCORE) return -8;
    if (side === SIDES.LESS && propType === PROP_TYPES.PITCHER_KS) return 6;
  }

  if (gameType === GAME_TYPES.SUPPRESSED) {
    if (side === SIDES.LESS && propType === PROP_TYPES.FANTASY_SCORE) return 8;
    if (side === SIDES.MORE && [PROP_TYPES.FANTASY_SCORE, PROP_TYPES.HRR, PROP_TYPES.HITS].includes(propType)) return -8;
  }

  return 0;
}

export function prizePicksSideAllowed({ desiredSide, projectionType }) {
  // projectionType examples: "normal", "demon", "goblin".
  // User rule: PrizePicks does not allow unders on Demon/Goblin projections.
  if ((projectionType === "demon" || projectionType === "goblin") && desiredSide === SIDES.LESS) {
    return false;
  }
  return true;
}

export function finalPickScore(input = {}) {
  const edgeScore = clamp(safeRatio(input.edgePercent, 0.20) * 100, 0, 100);
  const varianceSafety = 100 - clamp(input.volatility ?? 60, 0, 100);
  const trapPenalty = input.trapTag === "Trap" ? 20 : input.trapTag === "Caution" ? 10 : 0;

  const score = clamp(
    0.30 * edgeScore +
      0.20 * (input.roleStability ?? 80) +
      0.20 * (input.matchupScore ?? 70) +
      0.15 * (input.environmentFit ?? 70) +
      0.15 * varianceSafety -
      trapPenalty,
    0,
    100
  );

  let label = "PASS";
  let useCase = "Avoid";
  if (score >= 85) {
    label = "NUKE";
    useCase = "Flex-safe / Power-eligible";
  } else if (score >= 75) {
    label = "STRONG";
    useCase = "Flex-safe";
  } else if (score >= 65) {
    label = "STANDARD";
    useCase = "Flex-only";
  }

  return { score: Number(score.toFixed(1)), label, useCase };
}

export function tagTrap(score) {
  if (score >= 75) return "Trap";
  if (score >= 60) return "Caution";
  return "Clean";
}

export function gradeProp(input = {}) {
  const allowed = prizePicksSideAllowed({ desiredSide: input.side, projectionType: input.projectionType });
  const edge = calculatePropEdge(input);
  const minEdge = minimumEdgeForProp(input.propType);
  const volatility = calculateVolatility(input);
  const environmentAdjustment = environmentFitAdjustment(input);
  const environmentFit = clamp((input.environmentFitBase ?? 70) + environmentAdjustment, 0, 100);
  const roleStability = input.roleStability ?? roleStabilityScore(input);
  const trap = trapScore({ ...input, edgePercent: edge.edgePercent, volatility });
  const trapTag = tagTrap(trap);

  const thinEdge = edge.edgePercent < minEdge;
  const volatilityFail = volatility >= 65 && edge.edgePercent < 0.15;

  if (!allowed) {
    return {
      allowed: false,
      decision: "PASS",
      reason: "Desired side is blocked by Demon/Goblin projection rules.",
      edge,
      minEdge,
      volatility,
      trap,
      trapTag
    };
  }

  const final = finalPickScore({
    edgePercent: edge.edgePercent,
    volatility,
    roleStability,
    matchupScore: input.matchupScore ?? 70,
    environmentFit,
    trapTag
  });

  if (thinEdge || volatilityFail) {
    final.label = "PASS";
    final.useCase = "Avoid";
  }

  return {
    allowed: true,
    decision: final.label,
    useCase: final.useCase,
    score: final.score,
    edge,
    minEdge,
    volatility,
    roleStability,
    environmentFit,
    trap,
    trapTag,
    gameType: input.gameType
  };
}
