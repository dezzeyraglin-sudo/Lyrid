// api/_lib/pitcherKProjection.js
//
// Per-batter, per-pitch-type K projection rollup.
//
// The core insight: a pitcher's K total is not just "K% × PAs faced". It depends on
// HOW each batter handles each pitch type the pitcher actually throws.
//
// Example:
//   Skubal throws: 50% 4-Seam, 38% Changeup, 12% Slider
//   Detroit lineup has 4 LHB, 5 RHB
//   - Tonight's 4 LHB struggle vs his Changeup (32% K rate)
//   - The 5 RHB are average vs his 4-Seam (22% K rate) but weak vs Slider (35% K rate)
//
// Rolled up: project ~7.2 Ks for the night, vs the flat-K%-based projection of 5.5.
// That's a meaningful prop edge.
//
// Methodology:
//   1. For each batter in expected lineup, look up their per-pitch-type K-rate vs the
//      pitcher's hand (the data we already fetch in deep mode for hitter analysis)
//   2. Weight by pitcher's actual pitch-mix usage (NOT 1/3 across types — pitchers don't
//      throw evenly)
//   3. Sum weighted K probability per batter, scaled by expected PAs
//   4. Compare to baseline (raw pitcher K% × PAs) to derive an "edge factor"
//
// Sample-size guards:
//   - Per-pitch K rate requires ≥ 8 PAs for that batter against that pitch type
//   - When sample is small, regress 60% toward batter's overall K rate
//   - When batter has no per-pitch data, fall back to lineup-tier-based estimate
//
// Cap on adjustment vs baseline: ±18% (more aggressive than projection caps because
// pitcher K props are volatile and even sharp models over/under by ~1.5 Ks per game).

const LEAGUE_AVG_K_RATE = 0.225;  // MLB avg K% per PA, 2024-25
const MIN_PA_PER_PITCH = 8;       // Minimum PAs per batter-vs-pitch-type to trust the K rate
const REGRESSION_WEIGHT = 0.60;   // How hard to regress when sample is small
const ADJUSTMENT_CAP = 0.18;      // Max ±18% deviation from flat-K% baseline

/**
 * Compute the per-batter weighted K probability based on pitcher's pitch mix
 * and the batter's vulnerability to each pitch type.
 *
 * @param {Object} batter — { id, name, deepPitchTypes: [{ typeCode, kRate, pa, ... }] }
 * @param {Array}  pitcherArsenal — [{ typeCode, pitcherUsage, pitcherK }]
 * @param {number} batterOverallKRate — fallback K rate when per-pitch data is sparse
 * @returns {{ kRate, confidence, byPitch }} weighted K rate per PA
 */
function computeBatterKRate(batter, pitcherArsenal, batterOverallKRate) {
  const deepPitches = batter.deepPitchTypes || [];
  if (deepPitches.length === 0 || pitcherArsenal.length === 0) {
    // No per-pitch data — fall back to overall K rate
    return {
      kRate: batterOverallKRate || LEAGUE_AVG_K_RATE,
      confidence: 'low',
      byPitch: []
    };
  }

  // Build a lookup map for fast access: pitch code -> batter's K rate vs that pitch
  const batterByPitch = {};
  for (const dp of deepPitches) {
    batterByPitch[dp.typeCode] = dp;
  }

  // Walk the pitcher's arsenal and weight by usage
  let weightedKRate = 0;
  let totalUsage = 0;
  let confidence = 'high';
  const byPitch = [];

  for (const arrow of pitcherArsenal) {
    const usage = parseFloat(arrow.pitcherUsage) || 0;
    if (usage <= 0) continue;
    const usageWeight = usage / 100;

    const batterStat = batterByPitch[arrow.typeCode];

    let kRateForThisPitch;
    let source;

    if (batterStat && batterStat.kRate != null && batterStat.pa >= MIN_PA_PER_PITCH) {
      // We have meaningful per-pitch data for this batter
      kRateForThisPitch = batterStat.kRate;
      source = 'deep';
    } else if (batterStat && batterStat.kRate != null && batterStat.pa > 0) {
      // Some data but small sample — regress toward batter's overall K rate
      const overallRate = batterOverallKRate || LEAGUE_AVG_K_RATE;
      kRateForThisPitch = (batterStat.kRate * (1 - REGRESSION_WEIGHT)) + (overallRate * REGRESSION_WEIGHT);
      source = 'regressed';
      if (confidence === 'high') confidence = 'medium';
    } else {
      // No data for this pitch type — use batter's overall K rate as proxy
      kRateForThisPitch = batterOverallKRate || LEAGUE_AVG_K_RATE;
      source = 'fallback';
      if (confidence !== 'low') confidence = 'medium';
    }

    weightedKRate += kRateForThisPitch * usageWeight;
    totalUsage += usageWeight;

    byPitch.push({
      pitchType: arrow.type,
      typeCode: arrow.typeCode,
      pitcherUsage: usage,
      batterKRate: kRateForThisPitch,
      sampleSize: batterStat?.pa || 0,
      source
    });
  }

  // Normalize if pitcher arsenal usage doesn't sum to 100% (rare data quality issue)
  if (totalUsage > 0 && totalUsage < 0.95) {
    weightedKRate = weightedKRate / totalUsage;
  }

  return {
    kRate: parseFloat(weightedKRate.toFixed(3)),
    confidence,
    byPitch
  };
}

/**
 * Roll up per-batter K projections across the expected lineup to project total Ks.
 *
 * @param {Object} opts
 *   @param {Array}  opts.lineup           — opposing batters with deepPitchTypes attached
 *   @param {Array}  opts.pitcherArsenal   — pitcher's arsenal with usage + K%
 *   @param {number} opts.baselineKRate    — pitcher's flat K% per PA (fallback)
 *   @param {number} opts.projectedPAs     — total PAs expected for the start
 * @returns {{
 *   projectedKs,
 *   baselineKs,
 *   matchupEdge,
 *   confidence,
 *   batterBreakdown,
 *   sharpProjection
 * }}
 */
export function projectPitcherKsFromLineup({ lineup = [], pitcherArsenal = [], baselineKRate, projectedPAs }) {
  if (!lineup.length || !pitcherArsenal.length || !projectedPAs) {
    return {
      projectedKs: null,
      baselineKs: null,
      matchupEdge: 0,
      confidence: 'unavailable',
      batterBreakdown: [],
      sharpProjection: false,
      detail: 'Insufficient data for sharp projection'
    };
  }

  // Compute weighted K rate for each batter
  const batterBreakdown = lineup.map(batter => {
    // Batter's overall K rate from their season stats (if available)
    const overallK = parseFloat(batter.stats?.overall?.kPct) / 100 || null;

    const result = computeBatterKRate(batter, pitcherArsenal, overallK);

    return {
      hitterId: batter.id,
      name: batter.fullName || batter.name,
      battingOrder: batter.battingOrder,
      kRatePerPA: result.kRate,
      confidence: result.confidence,
      byPitch: result.byPitch
    };
  });

  // Average K rate across the lineup, weighted by expected PAs per slot.
  // Top of the order sees more PAs (4.5 avg for slot 1, dropping to ~3.6 for slot 9).
  const slotPAWeights = [4.5, 4.4, 4.3, 4.2, 4.1, 4.0, 3.9, 3.8, 3.6];

  let weightedSum = 0;
  let totalWeight = 0;
  let highConfidenceCount = 0;
  let mediumConfidenceCount = 0;
  let lowConfidenceCount = 0;

  for (let i = 0; i < batterBreakdown.length && i < 9; i++) {
    const slotWeight = slotPAWeights[i] || 3.5;
    weightedSum += batterBreakdown[i].kRatePerPA * slotWeight;
    totalWeight += slotWeight;
    if (batterBreakdown[i].confidence === 'high') highConfidenceCount++;
    else if (batterBreakdown[i].confidence === 'medium') mediumConfidenceCount++;
    else lowConfidenceCount++;
  }

  const lineupKRate = totalWeight > 0 ? weightedSum / totalWeight : LEAGUE_AVG_K_RATE;

  // Sharp projection: lineup-vs-arsenal weighted K rate × expected PAs
  const sharpProjectedKs = lineupKRate * projectedPAs;

  // Baseline projection: pitcher's flat K% × expected PAs
  const baselineKs = (baselineKRate || LEAGUE_AVG_K_RATE) * projectedPAs;

  // Matchup edge: how much does lineup matchup deviate from baseline?
  // Positive = pitcher should K more than baseline (good lineup matchup for pitcher)
  // Negative = pitcher should K less (lineup is K-resistant vs his pitch mix)
  const rawEdge = (sharpProjectedKs - baselineKs) / Math.max(0.1, baselineKs);
  const cappedEdge = Math.max(-ADJUSTMENT_CAP, Math.min(ADJUSTMENT_CAP, rawEdge));

  // Final projection: blend baseline with sharp using confidence-based weight.
  // High confidence (most batters have reliable per-pitch data) → trust sharp 80%
  // Medium → trust sharp 50%
  // Low → trust sharp 20%
  let sharpWeight;
  let confidenceLabel;
  if (highConfidenceCount >= 6) {
    sharpWeight = 0.80;
    confidenceLabel = 'high';
  } else if (highConfidenceCount >= 3 || mediumConfidenceCount >= 5) {
    sharpWeight = 0.50;
    confidenceLabel = 'medium';
  } else {
    sharpWeight = 0.20;
    confidenceLabel = 'low';
  }

  const blendedAdjustment = baselineKs * cappedEdge * sharpWeight;
  const projectedKs = baselineKs + blendedAdjustment;

  return {
    projectedKs: parseFloat(projectedKs.toFixed(2)),
    baselineKs: parseFloat(baselineKs.toFixed(2)),
    sharpProjectedKs: parseFloat(sharpProjectedKs.toFixed(2)),
    matchupEdge: parseFloat((cappedEdge * 100).toFixed(1)),  // as percentage
    confidence: confidenceLabel,
    sharpProjection: confidenceLabel !== 'low',
    batterBreakdown,
    detail: cappedEdge > 0.05
      ? `Lineup K-vulnerable vs arsenal (+${(cappedEdge * 100).toFixed(1)}%)`
      : cappedEdge < -0.05
      ? `Lineup K-resistant vs arsenal (${(cappedEdge * 100).toFixed(1)}%)`
      : `Lineup roughly neutral vs arsenal`
  };
}

/**
 * Project pitcher Outs from lineup quality + role + recent workload.
 *
 * Outs is structurally different from Ks — dominated by manager hook tendency
 * and pitch efficiency, not just pitching ability. We can't see manager intent
 * directly, but we can use:
 *   - Role baseline (starter vs short-starter vs opener) — biggest single factor
 *   - Lineup quality (weaker lineup = fewer pitches per inning = more outs)
 *   - Recent IP trend (if last 3 starts went 5/4/4 IP, expect ~4.3 IP tonight)
 *   - Pitch efficiency from inning splits (lower P/IP = more outs per game)
 *
 * @param {Object} opts
 *   @param {Object} opts.role           — pitcher role result from detectPitcherRole
 *   @param {Object} opts.lineupTier     — opposing lineup tier
 *   @param {Object} opts.inningSplits   — blended inning splits (for pitch efficiency)
 *   @param {Array}  opts.recentStarts   — last 3-5 starts with IP recorded
 *   @param {Object} opts.weatherImpact  — for hot weather pitch-count effect
 * @returns {{ projectedOuts, projectedIp, confidence, reasoning }}
 */
export function projectPitcherOuts({ role, lineupTier, inningSplits, recentStarts = [], weatherImpact }) {
  // Step 1: baseline outs from role
  let baselineOuts;
  if (role?.role === 'opener') baselineOuts = 6;        // ~2 IP
  else if (role?.role === 'short-starter') baselineOuts = 13;  // ~4.1 IP
  else if (role?.role === 'bulk') baselineOuts = 9;     // ~3 IP
  else baselineOuts = 16;                                // ~5.1 IP standard starter

  let projOuts = baselineOuts;
  const reasoning = [];

  // Step 2: recent IP trend (high signal)
  if (recentStarts && recentStarts.length >= 2) {
    const recentIps = recentStarts.slice(0, 3).map(s => s.ip || 0).filter(ip => ip > 0);
    if (recentIps.length >= 2) {
      const avgRecentIp = recentIps.reduce((a, b) => a + b, 0) / recentIps.length;
      const recentOuts = avgRecentIp * 3;
      // Blend baseline with recent trend (60% recent, 40% baseline)
      projOuts = (recentOuts * 0.60) + (baselineOuts * 0.40);
      if (avgRecentIp < 4.5) {
        reasoning.push(`Trending short — last ${recentIps.length} starts avg ${avgRecentIp.toFixed(1)} IP`);
      } else if (avgRecentIp >= 6.0) {
        reasoning.push(`Going deep — last ${recentIps.length} starts avg ${avgRecentIp.toFixed(1)} IP`);
      }
    }
  }

  // Step 3: lineup quality adjustment
  if (lineupTier?.label === 'EXPLOITABLE' || lineupTier?.label === 'HIGHLY_EXPLOITABLE') {
    projOuts *= 0.95;  // tougher lineup = more pitches per inning = fewer outs before pull
    reasoning.push('Strong lineup may shorten outing');
  } else if (lineupTier?.label === 'SUPPRESSED' || lineupTier?.label === 'LOCKED_DOWN') {
    projOuts *= 1.04;
    reasoning.push('Weak lineup supports longer outing');
  }

  // Step 4: pitch efficiency (lower P/IP = more outs achievable before pitch limit)
  if (inningSplits?.season_stats?.pitchesPerInning != null) {
    const ppi = inningSplits.season_stats.pitchesPerInning;
    // League avg ~16 P/IP; <14 is efficient, >18 is inefficient
    if (ppi < 14) {
      projOuts *= 1.03;
      reasoning.push(`Efficient (~${ppi.toFixed(1)} P/IP) — extra outs likely`);
    } else if (ppi > 18) {
      projOuts *= 0.96;
      reasoning.push(`Inefficient (~${ppi.toFixed(1)} P/IP) — pitch limit comes early`);
    }
  }

  // Step 5: weather pitch-count effect (heat increases pitch counts)
  if (weatherImpact?.tempF != null && weatherImpact.tempF > 88) {
    projOuts *= 0.97;
    reasoning.push(`Hot weather (${weatherImpact.tempF}°F) tends to shorten outings`);
  }

  // Confidence: how reliable is the projection?
  // - With recent starts data and pitcher splits, high confidence
  // - Without recent starts data, medium
  // - Without splits or recent data, low
  let confidence;
  if (recentStarts.length >= 2 && inningSplits) confidence = 'high';
  else if (recentStarts.length >= 1 || inningSplits) confidence = 'medium';
  else confidence = 'low';

  return {
    projectedOuts: parseFloat(projOuts.toFixed(2)),
    projectedIp: parseFloat((projOuts / 3).toFixed(2)),
    confidence,
    reasoning,
    baselineOuts,
    role: role?.role || 'starter'
  };
}
