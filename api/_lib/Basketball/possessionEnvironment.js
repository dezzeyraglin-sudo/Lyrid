/**
 * Basketball Possession Environment
 *
 * Replaces MLB park/weather/umpire context with:
 * - pace
 * - projected possessions
 * - spread / blowout risk
 * - total / scoring environment
 * - rest/travel fatigue
 * - foul environment
 */

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));
const clampMultiplier = (n, min = 0.92, max = 1.08) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : 1));
//
// MULTIPLIER CEILING DESIGN (May 16, 2026 calibration):
// Originally 0.82-1.18 (±18%) but combined with matchup multiplier this meant
// effective projection swing could be ±33%. That produced A'ja Wilson at 31.4
// on a 24.5 line in testing — career-high territory, not edge. Tightened to
// ±8% so environment + matchup combined caps at ~±14%, matching real prop
// variance better. The score (0-100) still uses the full range; this only
// affects the projection multiplier itself.

const LEAGUE_BASELINE = {
  NBA: { pace: 99.5, total: 224, possessions: 100 },
  WNBA: { pace: 80.0, total: 164, possessions: 80 }
};

export function calculatePossessionEnvironment(team = {}, opponent = {}, game = {}, league = "NBA") {
  const baseline = LEAGUE_BASELINE[league] ?? LEAGUE_BASELINE.NBA;

  const teamPace = Number(team.pace ?? baseline.pace);
  const oppPace = Number(opponent.pace ?? baseline.pace);
  const projectedPace = Number(game.projectedPace ?? ((teamPace + oppPace) / 2));
  const total = Number(game.total ?? team.total ?? baseline.total);
  const spread = Math.abs(Number(game.spread ?? 0));
  const home = Boolean(game.home ?? false);
  const restDays = Number(game.restDays ?? 1);
  const backToBack = Boolean(game.backToBack ?? restDays === 0);
  const travelMiles = Number(game.travelMiles ?? 0);
  const foulRate = Number(opponent.foulRate ?? game.foulRate ?? 0);
  const impliedTotal = Number(team.impliedTotal ?? game.teamTotal ?? (total / 2));

  const paceMultiplier = clampMultiplier(projectedPace / baseline.pace, 0.94, 1.06);
  const totalMultiplier = clampMultiplier(total / baseline.total, 0.95, 1.06);
  const impliedMultiplier = clampMultiplier(impliedTotal / (baseline.total / 2), 0.94, 1.07);

  let fatiguePenalty = 1.0;
  const fatigueReasons = [];
  if (backToBack) { fatiguePenalty -= league === "WNBA" ? 0.035 : 0.025; fatigueReasons.push("back-to-back"); }
  if (restDays >= 2) { fatiguePenalty += 0.015; fatigueReasons.push("rest edge"); }
  if (travelMiles >= 1200) { fatiguePenalty -= 0.015; fatigueReasons.push("long travel"); }

  const blowoutRisk = spread >= 13 ? "High" : spread >= 9 ? "Medium" : "Low";
  const blowoutPenalty = spread >= 13 ? 0.92 : spread >= 9 ? 0.96 : 1.0;

  // FOUL ENVIRONMENT: league average is ~21 PF/game. Real "foul-prone" teams
  // are at 24+. The previous 22 threshold caught average teams as "high fouling".
  const foulMultiplier = foulRate >= 24 ? 1.04 : foulRate >= 22 ? 1.025 : foulRate > 0 && foulRate <= 17 ? 0.975 : 1.0;
  const homeMultiplier = home ? 1.01 : 1.0;

  const rawMultiplier = paceMultiplier * totalMultiplier * impliedMultiplier * fatiguePenalty * foulMultiplier * homeMultiplier;
  const environmentMultiplier = clampMultiplier(rawMultiplier, 0.92, 1.08);

  let score = 50;
  const chips = [];
  const reasons = [];

  if (paceMultiplier >= 1.04) { score += 12; chips.push("PACE UP"); reasons.push("pace boost"); }
  else if (paceMultiplier <= 0.96) { score -= 10; chips.push("PACE DOWN"); reasons.push("pace drag"); }

  if (totalMultiplier >= 1.04) { score += 9; chips.push("TOTAL UP"); reasons.push("strong scoring environment"); }
  else if (totalMultiplier <= 0.96) { score -= 8; chips.push("TOTAL DOWN"); reasons.push("low total"); }

  if (impliedMultiplier >= 1.04) { score += 8; chips.push("TEAM TOTAL UP"); reasons.push("team total boost"); }
  else if (impliedMultiplier <= 0.96) { score -= 7; chips.push("TEAM TOTAL DOWN"); reasons.push("team total drag"); }

  if (foulMultiplier > 1.0) { score += 6; chips.push("FOUL BOOST"); reasons.push("free throw path"); }

  if (blowoutRisk === "High") { score -= 14; chips.push("BLOWOUT RISK"); reasons.push("major blowout risk"); }
  else if (blowoutRisk === "Medium") { score -= 7; chips.push("SPREAD RISK"); reasons.push("moderate spread risk"); }

  if (fatiguePenalty < 1) { score -= 5; chips.push("FATIGUE"); reasons.push(...fatigueReasons); }
  if (home) { score += 2; }

  return {
    score: clamp(Math.round(score)),
    projectedPace: Number(projectedPace.toFixed(1)),
    // Projected possessions: pace IS approximately possessions per 48min in NBA / 40min in WNBA
    // (basketball-reference defines pace as possessions per 48). For practical purposes,
    // pace ≈ possessions for a team in a normal-paced game. The earlier ternary
    // `projectedPace * (league === "WNBA" ? 1 : 1)` was a no-op typo.
    projectedPossessions: Number(projectedPace.toFixed(1)),
    multiplier: Number(environmentMultiplier.toFixed(3)),
    paceMultiplier: Number(paceMultiplier.toFixed(3)),
    totalMultiplier: Number(totalMultiplier.toFixed(3)),
    impliedMultiplier: Number(impliedMultiplier.toFixed(3)),
    foulMultiplier: Number(foulMultiplier.toFixed(3)),
    blowoutRisk,
    chips: [...new Set(chips)],
    reasons: [...new Set(reasons)]
  };
}

export default calculatePossessionEnvironment;
