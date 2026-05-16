/**
 * Basketball Probability Helpers
 *
 * Converts projection vs market line into hit rate, confidence, and labels.
 */

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));

function normalCdf(x) {
  // Abramowitz and Stegun approximation
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

export function estimateStatStdDev(market = "points", line = 10, varianceScore = 35, league = "NBA") {
  const m = String(market).toLowerCase();
  const baseByMarket = {
    points: 5.2,
    rebounds: 3.0,
    assists: 2.8,
    threes: 1.4,
    pra: 7.0,
    pa: 6.2,
    pr: 6.0,
    ra: 4.6
  };

  let base = baseByMarket.points;
  if (m.includes("rebound")) base = baseByMarket.rebounds;
  else if (m.includes("assist")) base = baseByMarket.assists;
  else if (m.includes("three") || m.includes("3pm")) base = baseByMarket.threes;
  else if (m.includes("pra")) base = baseByMarket.pra;
  else if (m.includes("pa")) base = baseByMarket.pa;
  else if (m.includes("pr")) base = baseByMarket.pr;

  // WNBA STD-DEV CALIBRATION (May 16, 2026):
  // WNBA games have ~80 possessions vs NBA's ~99, AND rotations are shorter
  // so top players get a higher % of their team's plays. Net effect on game-
  // to-game variance for top WNBA props is meaningfully lower than NBA. The
  // previous 0.92 factor was directionally right but too conservative.
  // Adjusted to 0.88 to reflect tighter prop distributions.
  const leagueFactor = league === "WNBA" ? 0.88 : 1.0;
  const lineFactor = Math.max(0.8, Math.sqrt(Math.max(Number(line), 1)) / 4);
  const varianceFactor = 0.75 + (clamp(varianceScore) / 100) * 0.75;

  return Math.max(0.75, base * lineFactor * varianceFactor * leagueFactor);
}

export function probabilityFromProjection({
  projection,
  line,
  market = "points",
  varianceScore = 35,
  league = "NBA"
}) {
  const proj = Number(projection);
  const ln = Number(line);
  if (!Number.isFinite(proj) || !Number.isFinite(ln)) {
    return { over: 50, under: 50, edge: 0, stdDev: null };
  }

  const stdDev = estimateStatStdDev(market, ln, varianceScore, league);
  const z = (proj - ln) / stdDev;
  const over = clamp(Math.round(normalCdf(z) * 100), 1, 99);
  const under = 100 - over;

  return {
    over,
    under,
    edge: Number((proj - ln).toFixed(2)),
    z: Number(z.toFixed(3)),
    stdDev: Number(stdDev.toFixed(2))
  };
}

export function confidenceFromHitRate(hitRate, finalEdgeScore = 50) {
  const h = Number(hitRate);
  const e = Number(finalEdgeScore);

  // CONFIDENCE THRESHOLD CALIBRATION (May 16, 2026):
  // PrizePicks/Underdog pricing typically requires ~58% hit rate (after demon/goblin
  // adjustments) to break even after platform vig. Original thresholds rated 54%+
  // as "Lean" which is literally break-even territory — net-negative EV after
  // selection effects. Raised all tiers by 4-5 points so labels actually
  // correspond to profitable confidence levels.
  //
  // New tier rationale:
  //   5★ Nuke      ≥72% hit + ≥86 finalEdge   →  +14% over break-even
  //   4★ Strong    ≥66% + ≥78                 →  +8% over break-even
  //   3★ Standard  ≥61% + ≥68                 →  +3% over break-even
  //   2★ Lean      ≥58% + ≥58                 →  at break-even (small edge)
  //   1★ Pass      below                       →  no edge, recommend skip
  if (h >= 72 && e >= 86) return { stars: "5★", label: "Nuke", nuke: "Nuke" };
  if (h >= 66 && e >= 78) return { stars: "4★", label: "Strong", nuke: "Strong" };
  if (h >= 61 && e >= 68) return { stars: "3★", label: "Standard", nuke: "Standard" };
  if (h >= 58 && e >= 58) return { stars: "2★", label: "Lean", nuke: "Pass/Lean" };
  return { stars: "1★", label: "Pass", nuke: "Pass" };
}

export function gradeFinalEdge({
  roleScore = 50,
  funnelScore = 50,
  environmentScore = 50,
  matchupScore = 50,
  varianceScore = 35,
  rawEdge = 0,
  hitRate = 50
}) {
  const edgeBoost = clamp((Number(rawEdge) || 0) * 8 + 50, 0, 100);
  const hitBoost = clamp((Number(hitRate) - 50) * 3 + 50, 0, 100);

  // WEIGHT NORMALIZATION (May 16, 2026):
  // Original weights summed to 1.05 (>1.0), allowing the score to exceed 100
  // in extreme inputs. Now normalized to sum to exactly 1.00 so the score
  // remains a true 0-100 percentage with variance score as a separate
  // subtractive risk adjustment.
  //
  // Weight rationale:
  //   roleScore     0.22 — does the player's role survive the game?
  //   hitBoost      0.18 — projected vs market line proximity
  //   funnelScore   0.18 — concentrated production environment
  //   matchupScore  0.14 — favorable archetype vs defense
  //   edgeBoost     0.14 — raw projection edge over line
  //   environment   0.14 — pace/total/fatigue context
  //                 ───── = 1.00
  //
  // varianceScore is subtracted at 0.15 weight, representing risk discount.
  const score =
    roleScore        * 0.22 +
    hitBoost         * 0.18 +
    funnelScore      * 0.18 +
    matchupScore     * 0.14 +
    edgeBoost        * 0.14 +
    environmentScore * 0.14 -
    varianceScore    * 0.15;

  return clamp(Math.round(score));
}

export default {
  estimateStatStdDev,
  probabilityFromProjection,
  confidenceFromHitRate,
  gradeFinalEdge
};
