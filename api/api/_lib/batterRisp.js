// api/_lib/batterRisp.js
//
// Per-batter RISP (Runners In Scoring Position) performance fetcher.
// Used in DEEP MODE only to refine RBI / H+R+RBI prop probabilities.
//
// Methodology:
//   - Fetch career and season-to-date RISP splits from MLB Stats API
//   - Blend career & season weighted by sample size
//   - Regress the blended signal toward league mean based on total RISP AB sample
//   - Cap influence at ±15% on prop probability
//
// Why blend career + season:
//   - Early season has tiny samples (20-40 RISP AB by late April)
//   - Random variance on 20 ABs is ±.080 in batting average — noise dominates
//   - Career data on established players has 500-2000 RISP AB — a real distribution
//   - Blending captures "this player has a real RISP track record" while adapting to
//     current season form for guys who have changed
//
// Why regression to mean:
//   - Sabermetric research (Tango, Carleton) puts true RISP "clutch skill" at 5-15%
//     of observed variance. Most year-over-year correlation is just regression to
//     the player's overall ability level.
//   - Treating RISP as a separate "clutch stat" overrates noise. Regression
//     pulls extreme values back toward the player's overall xwOBA expectation.
//
// IMPORTANT: This is a SECONDARY signal that fine-tunes RBI prop projections when
// overall stats are similar. It should NEVER override the primary xwOBA-vs-arsenal
// analysis. A great hitter with poor RISP-AVG is still a great hitter — we just
// nudge the RBI prop down a touch.

const SEASON = new Date().getFullYear();
const LEAGUE_AVG_RISP_AVG = 0.252;       // MLB 2024-2025 typical RISP AVG
const LEAGUE_AVG_AVG = 0.245;            // Overall MLB AVG (slightly lower than RISP because RISP often faces more pressure pitches but better fielding positions)

// In-memory cache. Per-batter RISP changes daily at most. 12-hour TTL.
const _cache = new Map();
const TTL_MS = 12 * 60 * 60 * 1000;

function cacheKey(playerId) { return `${playerId}-${SEASON}`; }

/**
 * Fetch career and season-to-date RISP stats for a single batter.
 * Returns null if data is unavailable or the player has no meaningful sample.
 *
 * @param {number} playerId — MLBAM player ID
 * @returns {Promise<null | {
 *   careerRispAvg, careerRispAb,
 *   seasonRispAvg, seasonRispAb,
 *   blendedRispAvg, totalRispAb,
 *   regressedRispAvg, sampleTier,
 *   rispDeviation, signal, detail
 * }>}
 */
export async function getBatterRispPerformance(playerId) {
  if (!playerId) return null;
  const k = cacheKey(playerId);
  const hit = _cache.get(k);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.data;

  try {
    // MLB Stats API exposes situational splits via the player stats endpoint with
    // sitCodes. The "rsp" code returns Runners In Scoring Position splits.
    // We fetch both career and season-to-date in parallel.
    const careerUrl = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=careerRegularSeason&group=hitting&sitCodes=rsp`;
    const seasonUrl = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=statSplits&group=hitting&sitCodes=rsp&season=${SEASON}`;

    const [careerRes, seasonRes] = await Promise.all([
      fetch(careerUrl, { signal: AbortSignal.timeout(5000) }).catch(() => null),
      fetch(seasonUrl, { signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);

    let careerRispAvg = null, careerRispAb = 0;
    let seasonRispAvg = null, seasonRispAb = 0;

    if (careerRes && careerRes.ok) {
      const json = await careerRes.json();
      const split = json?.stats?.[0]?.splits?.[0]?.stat;
      if (split && split.atBats) {
        careerRispAb = parseInt(split.atBats) || 0;
        careerRispAvg = parseFloat(split.avg) || null;
      }
    }

    if (seasonRes && seasonRes.ok) {
      const json = await seasonRes.json();
      const split = json?.stats?.[0]?.splits?.[0]?.stat;
      if (split && split.atBats) {
        seasonRispAb = parseInt(split.atBats) || 0;
        seasonRispAvg = parseFloat(split.avg) || null;
      }
    }

    // No data at all — return a neutral/insufficient response
    if (careerRispAb === 0 && seasonRispAb === 0) {
      const data = {
        careerRispAvg: null, careerRispAb: 0,
        seasonRispAvg: null, seasonRispAb: 0,
        blendedRispAvg: null, totalRispAb: 0,
        regressedRispAvg: LEAGUE_AVG_RISP_AVG,
        sampleTier: 'none',
        rispDeviation: 0,
        signal: 'no-data',
        detail: 'No RISP data available'
      };
      _cache.set(k, { data, fetchedAt: Date.now() });
      return data;
    }

    // Blend career + season weighted by sample size
    // This naturally weights career heavily early in season (when season AB is small)
    // and weights season more as the year progresses
    const totalAb = careerRispAb + seasonRispAb;
    let blendedRispAvg;
    if (careerRispAvg != null && seasonRispAvg != null) {
      blendedRispAvg = ((careerRispAvg * careerRispAb) + (seasonRispAvg * seasonRispAb)) / totalAb;
    } else if (careerRispAvg != null) {
      blendedRispAvg = careerRispAvg;
    } else {
      blendedRispAvg = seasonRispAvg;
    }

    // Regress to league mean based on sample size.
    // Regression strength: at 20 AB regress 70%, at 100 AB regress 40%, at 500+ AB regress 15%.
    // Formula: regression weight = 100 / (totalAb + 100), so:
    //   - 20 AB → weight 100/120 = 0.83 (83% regressed)
    //   - 50 AB → weight 100/150 = 0.67 (67% regressed)
    //   - 100 AB → weight 100/200 = 0.50 (50% regressed)
    //   - 500 AB → weight 100/600 = 0.17 (17% regressed)
    //   - 1500 AB → weight 100/1600 = 0.06 (6% regressed)
    const regressionWeight = 100 / (totalAb + 100);
    const regressedRispAvg = (blendedRispAvg * (1 - regressionWeight)) + (LEAGUE_AVG_RISP_AVG * regressionWeight);

    // Sample tier — used by UI to decide whether to show "SMALL" flag
    let sampleTier;
    if (totalAb < 20) sampleTier = 'insufficient';
    else if (totalAb < 50) sampleTier = 'small';
    else if (totalAb < 200) sampleTier = 'moderate';
    else sampleTier = 'reliable';

    // Deviation from league mean — drives the prop probability adjustment
    // Positive = above-average RISP performer (good for RBI props)
    // Negative = below-average RISP performer (bad for RBI props)
    const rispDeviation = (regressedRispAvg - LEAGUE_AVG_RISP_AVG) / LEAGUE_AVG_RISP_AVG;

    // Signal classification
    let signal, detail;
    if (sampleTier === 'insufficient') {
      signal = 'insufficient';
      detail = `${totalAb} RISP AB — too small to trust`;
    } else if (rispDeviation >= 0.12) {
      signal = 'elite-risp';
      detail = `Elite RISP: .${Math.round(regressedRispAvg * 1000).toString().padStart(3, '0')} (${totalAb} AB)`;
    } else if (rispDeviation >= 0.05) {
      signal = 'strong-risp';
      detail = `Strong RISP: .${Math.round(regressedRispAvg * 1000).toString().padStart(3, '0')} (${totalAb} AB)`;
    } else if (rispDeviation <= -0.12) {
      signal = 'weak-risp';
      detail = `Weak RISP: .${Math.round(regressedRispAvg * 1000).toString().padStart(3, '0')} (${totalAb} AB)`;
    } else if (rispDeviation <= -0.05) {
      signal = 'below-risp';
      detail = `Below RISP: .${Math.round(regressedRispAvg * 1000).toString().padStart(3, '0')} (${totalAb} AB)`;
    } else {
      signal = 'neutral-risp';
      detail = `Avg RISP: .${Math.round(regressedRispAvg * 1000).toString().padStart(3, '0')} (${totalAb} AB)`;
    }

    const data = {
      careerRispAvg: careerRispAvg != null ? parseFloat(careerRispAvg.toFixed(3)) : null,
      careerRispAb,
      seasonRispAvg: seasonRispAvg != null ? parseFloat(seasonRispAvg.toFixed(3)) : null,
      seasonRispAb,
      blendedRispAvg: blendedRispAvg != null ? parseFloat(blendedRispAvg.toFixed(3)) : null,
      totalRispAb: totalAb,
      regressedRispAvg: parseFloat(regressedRispAvg.toFixed(3)),
      sampleTier,
      rispDeviation: parseFloat(rispDeviation.toFixed(3)),
      signal,
      detail,
    };
    _cache.set(k, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.warn(`[batterRisp] Failed for player ${playerId}:`, err.message);
    return null;
  }
}

/**
 * Fetch RISP performance for an entire lineup in parallel.
 * Returns a map keyed by player ID.
 */
export async function getLineupRispPerformance(lineupPlayerIds) {
  if (!lineupPlayerIds || lineupPlayerIds.length === 0) return {};

  const results = await Promise.all(
    lineupPlayerIds.map(pid => getBatterRispPerformance(pid).catch(() => null))
  );

  const map = {};
  lineupPlayerIds.forEach((pid, i) => {
    if (results[i]) map[pid] = results[i];
  });
  return map;
}

/**
 * Apply RISP adjustment to an RBI prop probability.
 * Cap influence at ±15% (configurable via the constant below).
 *
 * @param {number} baseProb — original probability 0-1
 * @param {object} rispData — output from getBatterRispPerformance
 * @param {string} propLabel — used to determine if RISP applies (RBI / H+R+RBI primary targets)
 * @returns {{ adjustedProb, adjustment, applied }}
 */
const RISP_INFLUENCE_CAP = 0.15;  // ±15% — adjust here if calibration data warrants

export function applyRispAdjustment(baseProb, rispData, propLabel) {
  if (!baseProb || !rispData) return { adjustedProb: baseProb, adjustment: 0, applied: false };
  if (rispData.signal === 'insufficient' || rispData.signal === 'no-data') {
    return { adjustedProb: baseProb, adjustment: 0, applied: false };
  }

  // Determine prop applicability — RBI is the primary target, H+R+RBI is secondary,
  // R is tertiary, H is not affected (hits are independent of RISP situation).
  const label = (propLabel || '').toUpperCase();
  let propWeight = 0;
  if (label.includes('RBI') && !label.includes('R+')) propWeight = 1.0;        // pure RBI prop
  else if (label.includes('H+R+RBI') || label.includes('HRR')) propWeight = 0.6; // combo
  else if (label.includes('RUNS') || label.match(/\bR\b/)) propWeight = 0.3;     // runs
  else return { adjustedProb: baseProb, adjustment: 0, applied: false };        // not applicable

  // RISP deviation already capped indirectly by regression-to-mean, but cap explicitly here
  // for safety against any edge cases
  const cappedDev = Math.max(-RISP_INFLUENCE_CAP, Math.min(RISP_INFLUENCE_CAP, rispData.rispDeviation));

  // Apply scaled by prop weight
  // For an RBI prop with a great RISP hitter (rispDev = +0.15), this adds 15% to base prob
  // capped at the original probability * cappedDev * propWeight
  const adjustment = baseProb * cappedDev * propWeight;
  const adjustedProb = Math.max(0.05, Math.min(0.95, baseProb + adjustment));

  return {
    adjustedProb: parseFloat(adjustedProb.toFixed(3)),
    adjustment: parseFloat(adjustment.toFixed(3)),
    applied: true,
    signal: rispData.signal,
    detail: rispData.detail,
  };
}

/**
 * Build a lineup-level "Conversion Tier" — counts batters by RISP signal class.
 * Surfaced alongside the existing lineup arsenal tier.
 */
export function buildLineupConversionTier(rispMap, lineup) {
  if (!rispMap || !lineup) return null;

  let elite = 0, strong = 0, weak = 0, total = 0;
  for (const batter of lineup) {
    const risp = rispMap[batter.id];
    if (!risp || risp.signal === 'insufficient' || risp.signal === 'no-data') continue;
    total++;
    if (risp.signal === 'elite-risp') elite++;
    else if (risp.signal === 'strong-risp') strong++;
    else if (risp.signal === 'weak-risp') weak++;
  }

  // Tier: based on count of above-average converters minus below-average
  const positive = elite + strong;
  const tier = positive >= 4 ? 'CLUTCH'
             : positive >= 2 ? 'CAPABLE'
             : weak >= 3 ? 'STRANDED'
             : 'AVERAGE';

  return {
    eliteCount: elite,
    strongCount: strong,
    weakCount: weak,
    sampleSize: total,
    tier,
    label: tier === 'CLUTCH' ? `${positive} above-avg RISP performers`
         : tier === 'CAPABLE' ? `${positive} above-avg RISP performers`
         : tier === 'STRANDED' ? `${weak} below-avg RISP performers`
         : `Mostly average RISP performance`,
  };
}
