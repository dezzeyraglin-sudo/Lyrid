/**
 * Usage Funnel Detector
 *
 * Detects concentrated production environments:
 * - lone creators
 * - injury boosted roles
 * - primary rebounders
 * - primary ball-handlers
 * - high touch / high usage anchors
 */

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));

export function detectUsageFunnel(player = {}, team = {}, context = {}, league = "NBA") {
  const usageRate = Number(player.usageRate ?? player.usage ?? 0);
  const touches = Number(player.touches ?? 0);
  const assistShare = Number(player.assistShare ?? 0);
  const reboundShare = Number(player.reboundShare ?? 0);
  const shotShare = Number(player.shotShare ?? player.fgaShare ?? 0);
  const injuriesToTeammates = Number(context.injuriesToTeammates ?? team.injuriesToTeammates ?? 0);
  const missingUsage = Number(context.missingUsage ?? team.missingUsage ?? 0);
  const primaryCreator = Boolean(player.primaryCreator ?? false);
  const primaryBig = Boolean(player.primaryBig ?? false);
  const market = String(context.market ?? "").toLowerCase();

  let score = 35;
  const reasons = [];
  const chips = [];

  if (usageRate >= 32) { score += 25; reasons.push("elite usage"); chips.push("USAGE FUNNEL"); }
  else if (usageRate >= 28) { score += 19; reasons.push("primary usage"); chips.push("PRIMARY OPTION"); }
  else if (usageRate >= 24) { score += 12; reasons.push("strong usage"); }
  else if (usageRate > 0 && usageRate < 17) { score -= 12; reasons.push("thin usage"); }

  // TOUCHES THRESHOLDS BY LEAGUE (May 16, 2026):
  // NBA elite touches: 75+. WNBA elite touches: 60+ (shorter games + fewer possessions
  // mean raw touch counts are naturally lower). The original 75 threshold was
  // NBA-only and effectively never fired for WNBA players.
  const eliteTouchThreshold = league === "WNBA" ? 60 : 75;
  const strongTouchThreshold = league === "WNBA" ? 48 : 60;

  if (touches >= eliteTouchThreshold) { score += 15; reasons.push("elite touches"); chips.push("TOUCH VOLUME"); }
  else if (touches >= strongTouchThreshold) { score += 9; reasons.push("strong touches"); }

  if (primaryCreator) { score += 14; reasons.push("primary creator"); chips.push("PRIMARY CREATOR"); }
  if (primaryBig) { score += 8; reasons.push("primary big role"); }

  if (missingUsage >= 20) { score += 18; reasons.push("major teammate usage removed"); chips.push("INJURY FUNNEL"); }
  else if (missingUsage >= 10) { score += 10; reasons.push("teammate usage boost"); chips.push("USAGE BOOST"); }

  if (injuriesToTeammates >= 2) { score += 7; reasons.push("rotation thinned"); }

  if (market.includes("assist") && assistShare >= 32) {
    score += 15;
    reasons.push("assist funnel");
    chips.push("ASSIST FUNNEL");
  }

  if (market.includes("rebound") && reboundShare >= 20) {
    score += 15;
    reasons.push("rebound funnel");
    chips.push("REBOUND FUNNEL");
  }

  if ((market.includes("point") || market === "pts") && shotShare >= 28) {
    score += 12;
    reasons.push("shot funnel");
    chips.push("SHOT VOLUME");
  }

  // WNBA market tends to lag role changes more; reward clean concentrated roles.
  if (league === "WNBA" && (usageRate >= 27 || primaryCreator || primaryBig)) {
    score += 6;
    reasons.push("WNBA concentrated role");
  }

  const finalScore = clamp(Math.round(score));

  return {
    score: finalScore,
    isFunnel: finalScore >= 70,
    tier: finalScore >= 85 ? "Elite" : finalScore >= 70 ? "Strong" : finalScore >= 55 ? "Moderate" : "Weak",
    reasons,
    chips: [...new Set(chips)]
  };
}

export default detectUsageFunnel;
