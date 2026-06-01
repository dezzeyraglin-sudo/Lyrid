// api/_lib/basketball/pointsEngine.js
//
// POINTS PROJECTION ENGINE (June 1, 2026)
//
// A league-agnostic points-prop engine for the Lyrid basketball stack. Reads
// every league-specific constant from leagueConfig.js, so the same code runs
// WNBA today and NBA after a config swap.
//
// DESIGN PRINCIPLE — model only what you can source.
//   This engine implements the layers that have a real data source in the
//   current stack (basketball-reference + ESPN + DraftKings):
//     - Volume:        minutes projection, pace, possessions implied
//     - Shot env:      coarse opponent-defense efficiency adjustment
//     - Whistle:       FTA / FT-rate matchup bump (when FTA data is present)
//     - Recent form:   last-N scoring-rate blend
//     - Risk:          blowout / back-to-back minutes haircuts
//   It does NOT fake coverage prediction, play-type splits, defender tracking,
//   or matchup-vs-scheme — those have no source and are left out rather than
//   guessed. Every factor reports whether its inputs were actually present.
//
// INPUT SHAPE (matches the merged objects produced by the data layer):
//   {
//     player: {
//       name, team, seasonAvg, minutesAvg, expectedMinutes, usageRate,
//       starter, closingRole, gamesPlayed, foulRate, minutesCv,
//       last5Avg, last10Avg, minutesLast5,
//       fta, ftPct,            // OPTIONAL — needed for the whistle layer
//       _raw: { PTS, MIN, FGA, FTA, FT_PCT, ... }
//     },
//     market: 'points',
//     line: <number>,
//     team:     { abbr, pace, impliedTotal },
//     opponent: { abbr, pace, defRating, rimProtection, foulRate, ftaAllowed },
//     game:     { spread, total, home, restDays, backToBack }
//   }
//
// OUTPUT: see analyzePoints() return shape at the bottom.

import { getLeagueConfig } from './leagueConfig.js';

// =============================================================
// SMALL MATH HELPERS
// =============================================================

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function num(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Abramowitz & Stegun 7.1.26 error-function approximation (max error ~1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

// Standard normal CDF.
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// =============================================================
// FACTOR: MINUTES PROJECTION
// =============================================================

function projectMinutes(player, game, cfg) {
  const w = cfg.weights;
  const seasonMin = num(player.minutesAvg, 0);
  const primary = num(player.expectedMinutes, seasonMin);   // day-of beats season
  const recentMin = num(player.minutesLast5, seasonMin);

  let minutes;
  let recentUsed = false;
  if (Number.isFinite(player.minutesLast5)) {
    minutes = primary * (1 - w.minutesRecentBlend) + recentMin * w.minutesRecentBlend;
    recentUsed = true;
  } else {
    minutes = primary;
  }

  // Blowout haircut: starters / closers sit when the game is out of hand.
  let blowoutApplied = false;
  const spread = Math.abs(num(game?.spread, 0));
  if (spread >= w.blowoutThresholdSpread && (player.closingRole || player.starter)) {
    minutes *= (1 - w.blowoutMinutesHaircut);
    blowoutApplied = true;
  }

  // Back-to-back haircut (second night).
  let b2bApplied = false;
  if (game?.backToBack === true) {
    minutes *= (1 - w.b2bMinutesHaircut);
    b2bApplied = true;
  }

  minutes = clamp(minutes, 0, cfg.maxMinutes);
  return { minutes, recentUsed, blowoutApplied, b2bApplied, seasonMin };
}

// =============================================================
// FACTOR: BASE SCORING RATE (points per minute, recent-blended)
// =============================================================

function scoringRate(player, cfg) {
  const w = cfg.weights;
  const seasonMin = num(player.minutesAvg, 0);
  const seasonPts = num(player.seasonAvg, 0);
  const seasonRate = seasonMin > 0 ? seasonPts / seasonMin : 0;

  // Recent rate from last-5 if we have both points and minutes for it.
  const l5Pts = num(player.last5Avg, NaN);
  const l5Min = num(player.minutesLast5, NaN);
  let blendedRate = seasonRate;
  let recentUsed = false;
  if (Number.isFinite(l5Pts) && Number.isFinite(l5Min) && l5Min > 0 && seasonRate > 0) {
    const recentRate = l5Pts / l5Min;
    // Clamp the recent multiplier so a hot/cold streak can't run away with it.
    const ratio = clamp(recentRate / seasonRate, cfg.clamps.recentRate[0], cfg.clamps.recentRate[1]);
    blendedRate = seasonRate * (1 - w.recentFormBlend) + (seasonRate * ratio) * w.recentFormBlend;
    recentUsed = true;
  }
  return { seasonRate, blendedRate, recentUsed };
}

// =============================================================
// FACTOR: PACE
// =============================================================

function paceMultiplier(team, opponent, cfg) {
  const w = cfg.weights;
  const tp = num(team?.pace, NaN);
  const op = num(opponent?.pace, NaN);

  let gamePace;
  if (Number.isFinite(tp) && Number.isFinite(op)) gamePace = (tp + op) / 2;
  else if (Number.isFinite(tp)) gamePace = tp;
  else if (Number.isFinite(op)) gamePace = op;
  else return { mult: 1, active: false };

  const raw = gamePace / cfg.leagueAvgPace;
  const damped = 1 + (raw - 1) * w.paceSensitivity;
  return { mult: clamp(damped, cfg.clamps.pace[0], cfg.clamps.pace[1]), active: true, gamePace };
}

// =============================================================
// FACTOR: OPPONENT DEFENSE (coarse efficiency)
// =============================================================
// Prefer defensive rating (points allowed per 100 poss). Fall back to the
// rimProtection 0-100 proxy that wnbaTeamData already computes. No zone splits
// available, so this is intentionally coarse.

function defenseMultiplier(opponent, cfg) {
  const w = cfg.weights;
  const defRating = num(opponent?.defRating, NaN);

  if (Number.isFinite(defRating) && defRating > 0) {
    const raw = defRating / cfg.leagueAvgDefRating;   // >1 => leaky defense => more points
    const damped = 1 + (raw - 1) * w.defenseSensitivity;
    return { mult: clamp(damped, cfg.clamps.defense[0], cfg.clamps.defense[1]), active: true, source: 'defRating' };
  }

  // rimProtection: 100 = elite (suppresses scoring), 0 = leaky.
  const rim = num(opponent?.rimProtection, NaN);
  if (Number.isFinite(rim)) {
    // Map 0..100 -> +6%..-6% before damping (50 = neutral).
    const raw = 1 + ((50 - rim) / 50) * 0.06;
    const damped = 1 + (raw - 1) * w.defenseSensitivity;
    return { mult: clamp(damped, cfg.clamps.defense[0], cfg.clamps.defense[1]), active: true, source: 'rimProtection' };
  }

  return { mult: 1, active: false, source: null };
}

// =============================================================
// FACTOR: WHISTLE (FTA-driven)
// =============================================================
// Only active when we have the player's FTA + FGA (to gauge how much they live
// at the line) AND an opponent foul signal. Otherwise returns a neutral 1.0 and
// reports inactive — FTA is already inside seasonAvg, so skipping it is safe;
// what we'd be ADDING here is the matchup bump for foul-prone opponents.

function whistleMultiplier(player, opponent, cfg) {
  const w = cfg.weights;

  const fta = num(player.fta ?? player._raw?.FTA, NaN);
  const fga = num(player._raw?.FGA, NaN);
  const oppFoul = num(opponent?.foulRate, NaN);
  const oppFtaAllowed = num(opponent?.ftaAllowed, NaN);

  const havePlayerFt = Number.isFinite(fta) && Number.isFinite(fga) && fga > 0;
  const haveOppFoul = Number.isFinite(oppFoul) || Number.isFinite(oppFtaAllowed);
  if (!havePlayerFt || !haveOppFoul) {
    return { mult: 1, active: false };
  }

  // How much more (or less) than league-average this player gets to the line.
  const playerFtRate = fta / fga;
  const ftRateRel = clamp(playerFtRate / cfg.leagueAvgFtRate - 1, -0.6, 0.6); // -0.6..0.6

  // How foul-prone the opponent is vs league.
  let oppRel;
  if (Number.isFinite(oppFoul)) oppRel = clamp(oppFoul / cfg.leagueAvgFoulRate - 1, -0.3, 0.3);
  else oppRel = clamp(oppFtaAllowed / (cfg.leagueAvgFtRate * 80) - 1, -0.3, 0.3); // rough fallback scale

  // The bump only matters when a high-FT-rate player meets a foul-prone defense.
  const raw = 1 + (ftRateRel * oppRel) * w.whistleSensitivity * 4; // *4 to bring small products into range
  return { mult: clamp(raw, cfg.clamps.whistle[0], cfg.clamps.whistle[1]), active: true, playerFtRate };
}

// =============================================================
// MAIN ENTRY
// =============================================================

/**
 * Project points for a single player prop.
 *
 * @param {Object} input - see file header for shape
 * @param {string} league - 'WNBA' | 'NBA' (defaults to WNBA)
 * @returns {Object} projection + edge + probabilities + confidence + factors
 */
export function analyzePoints(input, league = 'WNBA') {
  const cfg = getLeagueConfig(league);

  const player = input?.player || {};
  const team = input?.team || {};
  const opponent = input?.opponent || {};
  const game = input?.game || {};
  const line = num(input?.line, NaN);

  if (!Number.isFinite(num(player.seasonAvg)) || !Number.isFinite(num(player.minutesAvg))) {
    return { error: 'Missing required player.seasonAvg or player.minutesAvg', league: cfg.league };
  }

  // --- Factors ---
  const min = projectMinutes(player, game, cfg);
  const rate = scoringRate(player, cfg);
  const pace = paceMultiplier(team, opponent, cfg);
  const def = defenseMultiplier(opponent, cfg);
  const whistle = whistleMultiplier(player, opponent, cfg);

  // --- Projection ---
  const basePoints = rate.blendedRate * min.minutes;
  const projection = basePoints * pace.mult * def.mult * whistle.mult;

  // --- Distribution ---
  const minutesCv = clamp(num(player.minutesCv, 0), 0, 1);
  const sigma = Math.max(
    0.5,
    projection * cfg.variance.baseScoringCv * (1 + minutesCv * cfg.variance.minutesCvInflation)
  );

  // --- Edge + probabilities (only if a line is present) ---
  let edge = null, probOver = null, probUnder = null, recommendation = 'NO_LINE';
  if (Number.isFinite(line)) {
    edge = projection - line;
    probOver = normalCdf((projection - line) / sigma);
    probUnder = 1 - probOver;
    recommendation = decide(edge, probOver, probUnder, cfg);
  }

  // --- Data completeness (surfaces silent degradation) ---
  const dataCompleteness = {
    recentForm: rate.recentUsed || min.recentUsed,
    pace: pace.active,
    opponentDefense: def.active,
    whistle: whistle.active,
    line: Number.isFinite(line),
  };

  // --- Confidence ---
  const confidence = scoreConfidence({ player, edge, sigma, dataCompleteness, cfg });

  // --- Risk flags ---
  const flags = [];
  if (min.blowoutApplied) flags.push('BLOWOUT_RISK');
  if (min.b2bApplied) flags.push('BACK_TO_BACK');
  if (Number.isFinite(line) && Number.isFinite(num(player.seasonAvg))) {
    // Informational divergence flag — NOT an ownership-based "trap" detector
    // (we have no ownership data). Just notes line/season disagreement.
    const seasonGap = Math.abs(line - num(player.seasonAvg));
    if (seasonGap >= Math.max(cfg.thresholds.minEdge * 1.5, sigma)) flags.push('LINE_SEASON_DIVERGENCE');
  }

  return {
    league: cfg.league,
    market: input?.market || 'points',
    player: player.name || null,
    line: Number.isFinite(line) ? line : null,

    projection: round(projection, 2),
    edge: edge === null ? null : round(edge, 2),
    probabilityOver: probOver === null ? null : round(probOver, 4),
    probabilityUnder: probUnder === null ? null : round(probUnder, 4),
    sigma: round(sigma, 2),
    confidence,
    recommendation,
    flags,

    factors: {
      projectedMinutes: round(min.minutes, 1),
      scoringRatePerMin: round(rate.blendedRate, 3),
      basePoints: round(basePoints, 2),
      paceMult: round(pace.mult, 3),
      defenseMult: round(def.mult, 3),
      defenseSource: def.source,
      whistleMult: round(whistle.mult, 3),
    },

    dataCompleteness,
    engineVersion: 'points-1.0.0',
    note: 'Models only sourceable layers (volume, pace, coarse defense, whistle, recent form). '
        + 'Coverage / play-type / defender-tracking layers are intentionally excluded (no data source).',
  };
}

// =============================================================
// RECOMMENDATION + CONFIDENCE
// =============================================================

function decide(edge, probOver, probUnder, cfg) {
  const t = cfg.thresholds;
  if (Math.abs(edge) < t.minEdge) return 'PASS';
  if (edge > 0) {
    if (probOver >= t.minProbability) return 'OVER';
    if (probOver >= t.leanProbability) return 'LEAN_OVER';
    return 'PASS';
  } else {
    if (probUnder >= t.minProbability) return 'UNDER';
    if (probUnder >= t.leanProbability) return 'LEAN_UNDER';
    return 'PASS';
  }
}

function scoreConfidence({ player, edge, sigma, dataCompleteness, cfg }) {
  let c = 55;

  // Sample size: more games => steadier inputs.
  const gp = num(player.gamesPlayed, 0);
  c += clamp(gp, 0, 15);                       // up to +15

  // Edge relative to noise.
  if (edge !== null && sigma > 0) {
    c += clamp((Math.abs(edge) / sigma) * 20, 0, 18);  // up to +18
  }

  // Penalize missing feeds — this is where Phase-0 data gaps show up.
  if (!dataCompleteness.pace) c -= 8;
  if (!dataCompleteness.opponentDefense) c -= 8;
  if (!dataCompleteness.recentForm) c -= 6;
  if (!dataCompleteness.whistle) c -= 3;
  if (!dataCompleteness.line) c -= 10;

  // Minutes volatility erodes confidence.
  c -= clamp(num(player.minutesCv, 0) * 20, 0, 12);

  return Math.round(clamp(c, 0, 100));
}

function round(x, dp) {
  if (!Number.isFinite(x)) return null;
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

// =============================================================
// EXPORTS FOR TESTING
// =============================================================

export const _testing = {
  projectMinutes, scoringRate, paceMultiplier, defenseMultiplier,
  whistleMultiplier, decide, scoreConfidence, normalCdf, erf,
};
