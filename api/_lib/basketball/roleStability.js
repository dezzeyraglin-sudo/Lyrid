/**
 * Basketball Role Stability Engine
 *
 * Purpose:
 * Measures whether a player's role is stable enough to trust a prop edge.
 *
 * This is the basketball equivalent of asking:
 * "Does this edge survive variance?"
 */

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));

function pctDiff(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return 0;
  return Math.abs(x - y) / Math.abs(y);
}

export function calculateRoleStability(player = {}, game = {}, league = "NBA") {
  const minutesAvg = Number(player.minutesAvg ?? player.minutes ?? 0);
  const minutesLast5 = Number(player.minutesLast5 ?? minutesAvg);
  const minutesFloor = Number(player.minutesFloor ?? Math.max(0, minutesAvg - 4));
  const usageRate = Number(player.usageRate ?? player.usage ?? 0);
  const touches = Number(player.touches ?? 0);
  const starter = Boolean(player.starter ?? minutesAvg >= (league === "WNBA" ? 26 : 28));
  const closingRole = Boolean(player.closingRole ?? player.closer ?? minutesAvg >= (league === "WNBA" ? 28 : 30));
  const injuryTag = String(player.injuryTag ?? player.status ?? "healthy").toLowerCase();
  const foulRate = Number(player.foulRate ?? player.foulsPer36 ?? 0);
  const spread = Math.abs(Number(game.spread ?? 0));

  // ROLE STABILITY CALIBRATION (May 16, 2026):
  // Base lowered from 50 to 35. The previous math + every positive attribute
  // added up to 127 (clamped to 100), meaning a player with all-positive
  // attributes scored identically to one with most-positive. No differentiation
  // at the top tier where it matters most. Adjusted weights still preserve
  // the ranking but now the ceiling is reachable only by genuine across-the-board
  // elites (think A'ja Wilson playing 36 with 31% usage as primary creator
  // on a no-rest-disadvantage night).
  let score = 35;
  const reasons = [];

  // Minutes are the strongest basketball prop stabilizer.
  if (minutesAvg >= 34) { score += 22; reasons.push("elite minutes"); }
  else if (minutesAvg >= 31) { score += 16; reasons.push("strong minutes"); }
  else if (minutesAvg >= 28) { score += 9; reasons.push("playable minutes"); }
  else if (minutesAvg < 24) { score -= 18; reasons.push("thin minutes"); }

  // WNBA rotations are often tighter; give stable high-minute starters more credit.
  // Threshold lowered from 30 to 32 to reflect that WNBA "elite minutes" is 33+,
  // not 30+ (which is just "solid starter"). Top WNBA starters routinely play 33-35.
  if (league === "WNBA" && minutesAvg >= 32) {
    score += 5;
    reasons.push("WNBA rotation concentration");
  }

  // Recent minutes should not be wildly different unless a role change is known.
  const minDrift = pctDiff(minutesLast5, minutesAvg);
  if (minDrift <= 0.06) { score += 8; reasons.push("minutes stable"); }
  else if (minDrift <= 0.12) { score += 3; reasons.push("minor minutes drift"); }
  else { score -= 10; reasons.push("minutes volatility"); }

  // Floor matters more than average.
  if (minutesFloor >= 30) { score += 8; reasons.push("strong minutes floor"); }
  else if (minutesFloor < 24) { score -= 10; reasons.push("weak minutes floor"); }

  if (starter) { score += 5; reasons.push("starter"); }
  else { score -= 8; reasons.push("bench role"); }

  if (closingRole) { score += 8; reasons.push("closing role"); }
  else { score -= 6; reasons.push("not confirmed closer"); }

  // Usage/touch role confirms production path.
  if (usageRate >= 30) { score += 8; reasons.push("primary usage"); }
  else if (usageRate >= 24) { score += 5; reasons.push("strong usage"); }
  else if (usageRate < 16 && usageRate > 0) { score -= 8; reasons.push("low usage"); }

  if (touches >= 70) { score += 7; reasons.push("elite touch volume"); }
  else if (touches >= 55) { score += 4; reasons.push("strong touch volume"); }

  // Status / injury uncertainty.
  // NOTE: the "out" case is also caught by the hard-flag system in basketballProps.js
  // as PLAYER OUT, but we keep this score penalty as defense-in-depth in case
  // someone calls roleStability directly.
  if (injuryTag.includes("questionable") || injuryTag.includes("minutes")) {
    score -= 22;
    reasons.push("injury/minutes uncertainty");
  } else if (injuryTag.includes("probable")) {
    score -= 5;
    reasons.push("probable tag");
  } else if (injuryTag.includes("out") || injuryTag.includes("doubtful")) {
    score -= 100;
    reasons.push("not playable");
  }

  // Foul-prone players create sudden minutes downside.
  if (foulRate >= 5.0) { score -= 10; reasons.push("foul volatility"); }
  else if (foulRate >= 4.0) { score -= 5; reasons.push("moderate foul risk"); }

  // Blowouts crush overs. Note: 13+ spreads now also trigger a hard flag in
  // basketballProps.js which overrides the recommendation to PASS regardless
  // of role score. This penalty remains so the underlying score reflects the
  // risk for analysts inspecting the diagnostic output.
  if (spread >= 13) { score -= 12; reasons.push("major blowout risk"); }
  else if (spread >= 9) { score -= 6; reasons.push("moderate blowout risk"); }

  const finalScore = clamp(Math.round(score));

  return {
    score: finalScore,
    tier: finalScore >= 85 ? "Elite" : finalScore >= 72 ? "Strong" : finalScore >= 58 ? "Playable" : "Fragile",
    volatility: finalScore >= 80 ? "Low" : finalScore >= 65 ? "Medium" : "High",
    reasons
  };
}

export default calculateRoleStability;
