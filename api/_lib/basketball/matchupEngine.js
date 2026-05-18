/**
 * Basketball Matchup Engine
 *
 * Converts "pitcher arsenal vs hitter pitch-type skill" into:
 * "player archetype vs defensive coverage / suppression profile."
 */

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));
const clampMultiplier = (n, min = 0.94, max = 1.06) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 1));
//
// MATCHUP MULTIPLIER CAPPED AT ±6% (May 16, 2026 calibration).
// Combined with environment multiplier (±8%), total projection swing is ±14%.
// Original ±18% × ±18% = ±33% effective which was producing career-high
// projections on routine props. The score still uses full 0-100 range; this
// only constrains how much matchup directly modifies projection.

function marketKey(market = "") {
  const m = String(market).toLowerCase();
  if (m.includes("rebound") || m === "reb") return "rebounds";
  if (m.includes("assist") || m === "ast") return "assists";
  if (m.includes("three") || m.includes("3pm")) return "threes";
  if (m.includes("pra")) return "pra";
  if (m.includes("pa")) return "pointsAssists";
  if (m.includes("pr")) return "pointsRebounds";
  return "points";
}

export function evaluateBasketballMatchup(player = {}, opponent = {}, context = {}) {
  const market = marketKey(context.market);
  const position = String(player.position ?? "").toUpperCase();
  const archetype = String(player.archetype ?? "").toLowerCase();

  const defRating = Number(opponent.defRating ?? 0);
  const pace = Number(opponent.pace ?? 0);
  const rimProtection = Number(opponent.rimProtection ?? 50); // 0 weak, 100 elite
  const reboundAllowed = Number(opponent.reboundAllowed ?? opponent.rebAllowed ?? 50); // higher = more boards allowed
  const assistAllowed = Number(opponent.assistAllowed ?? 50);
  const threeAllowed = Number(opponent.threeAllowed ?? opponent.threesAllowed ?? 50);
  const paintPointsAllowed = Number(opponent.paintPointsAllowed ?? 50);
  const switchRate = Number(opponent.switchRate ?? 50);
  const dropRate = Number(opponent.dropRate ?? 50);
  const turnoverPressure = Number(opponent.turnoverPressure ?? 50);

  let score = 50;
  let multiplier = 1.0;
  const reasons = [];
  const chips = [];

  // General defense quality adjustment.
  if (defRating && defRating <= 110) {
    score -= 6;
    multiplier -= 0.010;
    reasons.push("strong opponent defense");
  } else if (defRating >= 118) {
    score += 7;
    multiplier += 0.015;
    reasons.push("weak opponent defense");
    chips.push("DEFENSE LEAK");
  }

  // Identify common archetype patterns. The original `archetype.includes("rim")`
  // missed equivalent terms ("post", "interior", "big", "center"). Now any of
  // these signal interior/rim-attacking play.
  const isInterior = archetype.includes("rim") || archetype.includes("post") ||
                     archetype.includes("interior") || archetype.includes("big") ||
                     position === "C" || position === "F-C";
  const isPaintAttacker = archetype.includes("slasher") || archetype.includes("paint") ||
                          archetype.includes("driver") || archetype.includes("attack");
  const isPnrHandler = archetype.includes("p&r") || archetype.includes("pnr") ||
                       archetype.includes("pick-and-roll") || archetype.includes("guard");

  if (market === "points" || market === "pra" || market === "pointsAssists" || market === "pointsRebounds") {
    if (isInterior && rimProtection <= 42) {
      score += 10;
      multiplier += 0.025;
      reasons.push("weak rim protection");
      chips.push("RIM EDGE");
    }
    if (isPaintAttacker && paintPointsAllowed >= 58) {
      score += 8;
      multiplier += 0.020;
      reasons.push("paint scoring allowed");
      chips.push("PAINT EDGE");
    }
    if (isPnrHandler && dropRate >= 60) {
      score += 7;
      multiplier += 0.015;
      reasons.push("drop coverage target");
      chips.push("DROP TARGET");
    }
  }

  if (market === "threes" || market === "points") {
    if (threeAllowed >= 58) {
      score += 8;
      multiplier += 0.020;
      reasons.push("three-point allowance");
      chips.push("3PT EDGE");
    } else if (threeAllowed <= 42) {
      score -= 7;
      multiplier -= 0.015;
      reasons.push("three-point suppression");
    }
  }

  if (market === "assists" || market === "pra" || market === "pointsAssists") {
    if (assistAllowed >= 58) {
      score += 9;
      multiplier += 0.020;
      reasons.push("assist allowance");
      chips.push("ASSIST EDGE");
    }
    if (turnoverPressure >= 65) {
      score -= 7;
      multiplier -= 0.015;
      reasons.push("turnover pressure risk");
      chips.push("PRESSURE RISK");
    }
  }

  if (market === "rebounds" || market === "pra" || market === "pointsRebounds") {
    if (reboundAllowed >= 58) {
      score += 10;
      multiplier += 0.025;
      reasons.push("rebound allowance");
      chips.push("REB EDGE");
    } else if (reboundAllowed <= 42) {
      score -= 8;
      multiplier -= 0.020;
      reasons.push("rebound suppression");
    }
  }

  if (switchRate >= 65 && (archetype.includes("iso") || archetype.includes("mismatch"))) {
    score -= 5;
    multiplier -= 0.010;
    reasons.push("switchability reduces mismatch");
  }

  return {
    score: clamp(Math.round(score)),
    multiplier: Number(clampMultiplier(multiplier).toFixed(3)),
    market,
    chips: [...new Set(chips)],
    reasons: [...new Set(reasons)]
  };
}

export default evaluateBasketballMatchup;
