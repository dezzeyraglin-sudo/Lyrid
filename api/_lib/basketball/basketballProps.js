import { calculateRoleStability } from "./roleStability.js";
import { detectUsageFunnel } from "./usageFunnel.js";
import { calculatePossessionEnvironment } from "./possessionEnvironment.js";
import { evaluateBasketballMatchup } from "./matchupEngine.js";
import { probabilityFromProjection, confidenceFromHitRate, gradeFinalEdge } from "./basketballProbability.js";

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));

function normalizeMarket(market = "points") {
  const m = String(market).toLowerCase();
  if (m.includes("rebound") || m === "reb") return "rebounds";
  if (m.includes("assist") || m === "ast") return "assists";
  if (m.includes("three") || m.includes("3pm")) return "threes";
  if (m.includes("pra")) return "pra";
  if (m.includes("pa")) return "pa";
  if (m.includes("pr")) return "pr";
  return "points";
}

function baseProjection(player = {}, market = "points") {
  const key = normalizeMarket(market);

  if (Number.isFinite(Number(player.projection))) return Number(player.projection);

  const seasonAvg = Number(player.seasonAvg ?? player.avg ?? player[key] ?? 0);
  const last5Avg = Number(player.last5Avg ?? player.last5 ?? seasonAvg);
  const last10Avg = Number(player.last10Avg ?? player.last10 ?? seasonAvg);
  const minutesAvg = Number(player.minutesAvg ?? player.minutes ?? 30);
  const expectedMinutes = Number(player.expectedMinutes ?? minutesAvg);
  const usageRate = Number(player.usageRate ?? player.usage ?? 22);
  const seasonUsage = Number(player.seasonUsage ?? usageRate);  // baseline usage from season

  // BASE PROJECTION MATH (May 16, 2026 calibration):
  //
  // Weighted blend of season + recent. Season gets 50% (the "true talent" signal),
  // last10 gets 20%, last5 gets 30%. Bias toward recent because role/health/form
  // matters more than career baseline for prop projection.
  let projection = seasonAvg * 0.50 + last10Avg * 0.20 + last5Avg * 0.30;

  // MINUTES ADJUSTMENT: scale by ratio of expected vs average minutes.
  // Capped ±20% so a player getting unexpected start doesn't 2x their projection.
  if (minutesAvg > 0) projection *= Math.max(0.80, Math.min(1.20, expectedMinutes / minutesAvg));

  // USAGE ADJUSTMENT (FIXED May 16, 2026):
  // Previously: `projection *= clamp(usageRate / 24, 0.90, 1.12)` —
  //   This was DOUBLE-COUNTING usage. A'ja Wilson at 31% usage got a 1.12
  //   multiplier on top of a season avg (24.1) that already reflects her 31%
  //   usage. Result: 24.1 → 27.0 just from this line, before any other multiplier.
  //
  // Corrected: usage adjustment now scales by CHANGE from baseline usage,
  // not absolute usage. If a player normally has 26% usage and today is
  // expected at 31% (e.g. teammate injured), THEN we boost projection by
  // 31/26 = 1.19 (clamped to 1.10). If usage is at season average, no boost.
  // This is what the variable was always supposed to represent.
  if (["points", "pra", "pa", "pr"].includes(key) && usageRate > 0 && seasonUsage > 0) {
    const usageRatio = usageRate / seasonUsage;
    const usageMultiplier = Math.max(0.92, Math.min(1.10, usageRatio));
    projection *= usageMultiplier;
  }

  return Number(projection.toFixed(2));
}

function varianceRisk(player = {}, game = {}, market = "points", roleScore = 50) {
  const minutesCv = Number(player.minutesCv ?? player.minutesCV ?? 0);
  const spread = Math.abs(Number(game.spread ?? 0));
  const injuryTag = String(player.injuryTag ?? player.status ?? "").toLowerCase();
  const m = normalizeMarket(market);

  let risk = 30;

  if (roleScore < 60) risk += 20;
  if (minutesCv >= 0.18) risk += 16;
  else if (minutesCv >= 0.12) risk += 8;

  if (spread >= 13) risk += 16;
  else if (spread >= 9) risk += 8;

  if (injuryTag.includes("questionable") || injuryTag.includes("minutes")) risk += 22;

  if (m === "pra") risk += 10; // combo lines carry shared minutes failure.
  if (m === "assists" && Number(player.assistShare ?? 0) < 20) risk += 8;
  if (m === "threes") risk += 12;

  return clamp(Math.round(risk));
}

function buildChips(...groups) {
  const chips = [];
  for (const group of groups) {
    if (Array.isArray(group)) chips.push(...group);
    else if (group?.chips) chips.push(...group.chips);
  }
  return [...new Set(chips)];
}

export function analyzeBasketballProp(input = {}, league = "NBA") {
  const player = input.player ?? input;
  const team = input.team ?? {};
  const opponent = input.opponent ?? {};
  const game = input.game ?? {};
  const market = input.market ?? player.market ?? "points";
  const line = Number(input.line ?? player.line);

  // INPUT VALIDATION (May 16, 2026 — matches MLB banned-list-filter discipline):
  // Reject obviously invalid inputs early rather than producing recommendations
  // from garbage data. The MLB engine had banned-list filtering; this is the
  // basketball equivalent — fail fast on missing critical fields.
  const validationErrors = [];
  if (!player?.name || typeof player.name !== "string") {
    validationErrors.push("player.name is required");
  }
  if (!Number.isFinite(line)) {
    validationErrors.push("line must be a finite number");
  }
  if (!player.seasonAvg && !player.projection && !player.last5Avg) {
    validationErrors.push("at least one of seasonAvg, projection, or last5Avg required");
  }
  if (validationErrors.length) {
    return {
      league,
      error: "INVALID INPUT",
      validationErrors,
      recommendation: "PASS",
      label: "Invalid input"
    };
  }

  const role = calculateRoleStability(player, game, league);
  const funnel = detectUsageFunnel(player, team, { ...game, market }, league);
  const environment = calculatePossessionEnvironment(team, opponent, game, league);
  const matchup = evaluateBasketballMatchup(player, opponent, { market });

  let projection = baseProjection(player, market);
  projection *= environment.multiplier;
  projection *= matchup.multiplier;

  // Usage funnel gently boosts overs where role is stable; does not overfit.
  // Reduced from 1.045/1.035 (May 16, 2026) to match tightened env/matchup
  // multipliers. Stacking all three boosts no longer produces career-high
  // projections on routine props.
  if (funnel.isFunnel && role.score >= 70) projection *= league === "WNBA" ? 1.025 : 1.020;

  projection = Number(projection.toFixed(2));

  const varianceScore = varianceRisk(player, game, market, role.score);
  const probs = probabilityFromProjection({
    projection,
    line,
    market,
    varianceScore,
    league
  });

  const recommendedSide = probs.over >= probs.under ? "OVER" : "UNDER";
  const hitRate = recommendedSide === "OVER" ? probs.over : probs.under;
  const edge = recommendedSide === "OVER" ? probs.edge : Number((-probs.edge).toFixed(2));

  const finalEdge = gradeFinalEdge({
    roleScore: role.score,
    funnelScore: funnel.score,
    environmentScore: environment.score,
    matchupScore: matchup.score,
    varianceScore,
    rawEdge: edge,
    hitRate
  });

  const confidence = confidenceFromHitRate(hitRate, finalEdge);

  let recommendation = recommendedSide;
  // Match the calibrated confidence thresholds: anything below 58% hit rate
  // is sub-break-even on PP/UD vig. Was 54% — that allowed losing picks
  // through as "Lean" recommendations.
  if (!Number.isFinite(line) || hitRate < 58 || finalEdge < 58) recommendation = "PASS";

  // Hard safety rails aligned with your variance suppression philosophy.
  const hardFlags = [];
  if (role.score < 45) hardFlags.push("ROLE TOO FRAGILE");
  if (varianceScore >= 72) hardFlags.push("VARIANCE TOO HIGH");
  if (String(player.injuryTag ?? player.status ?? "").toLowerCase().includes("out")) hardFlags.push("PLAYER OUT");
  // BLOWOUT HARD FLAG (May 16, 2026 calibration):
  // 13+ point spreads are structural fades on OVER props because starters
  // sit in 4th quarter when game is decided. Previously the blowout penalty
  // only nudged the score; it didn't actually prevent the recommendation.
  // Testing showed a -16 spread game producing "4★ Strong" output — an
  // automatic bad pick. Now it's an immediate PASS.
  // For UNDER props, blowouts can actually be neutral or favorable
  // (rotation depth changes), so the flag only applies when the
  // recommendation is OVER.
  const absSpread = Math.abs(Number(game?.spread ?? 0));
  if (absSpread >= 13 && recommendedSide === "OVER") {
    hardFlags.push("BLOWOUT RISK — STARTERS LIKELY SIT");
  }
  if (hardFlags.length) recommendation = "PASS";

  const chips = buildChips(
    role.score >= 78 ? ["ROLE STABLE"] : [],
    funnel,
    environment,
    matchup,
    varianceScore <= 35 ? ["LOW VARIANCE"] : [],
    hardFlags
  );

  return {
    league,
    player: player.name ?? input.playerName ?? "Unknown Player",
    team: player.team ?? input.teamAbbr ?? team.abbr ?? null,
    opponent: opponent.abbr ?? opponent.team ?? null,
    market: normalizeMarket(market),
    line: Number.isFinite(line) ? line : null,
    projection,
    edge: Number.isFinite(line) ? Number((projection - line).toFixed(2)) : null,
    sideEdge: edge,
    hitRate,
    recommendation,
    confidence: confidence.stars,
    label: recommendation === "PASS" ? "Pass" : confidence.label,
    nuke: recommendation === "PASS" ? "Pass" : confidence.nuke,
    scores: {
      finalEdge,
      roleStability: role.score,
      usageFunnel: funnel.score,
      environment: environment.score,
      matchup: matchup.score,
      variance: varianceScore
    },
    details: {
      role,
      funnel,
      environment,
      matchup,
      probability: probs,
      hardFlags
    },
    chips
  };
}

export default analyzeBasketballProp;
