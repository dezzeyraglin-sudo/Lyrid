// api/_lib/hrEmpirical.js
//
// EMPIRICALLY-CALIBRATED HR PROJECTION (C-LITE)
//
// Replaces the hand-tuned integer scoring (`barrel * 2`, `elite matchup +20`, etc.)
// with multipliers calibrated against league HR rates by feature band. The output
// is a projected HR/PA probability — interpretable, auditable, and tier-mapped
// to actual league frequencies rather than arbitrary score thresholds.
//
// METHODOLOGY:
//   1. Start from league baseline HR/PA rate (~3.0% in modern MLB)
//   2. For each feature (barrel%, park, weather, etc.), apply a multiplier
//      grounded in publicly-known sabermetric findings:
//        - Barrel% → HR conversion rate is ~50% per barrel (well-documented)
//        - Park HR factor is directly observed from years of data
//        - Wind direction effects are quantified by multiple studies
//        - Temperature effects on flyball carry are linear ~1% per 10°F
//   3. Multiply the chained multipliers against the baseline to get projected HR/PA
//   4. Tier by actual rate, not arbitrary scores:
//        - ELITE: projected ≥ 9% HR/PA (~3x league)
//        - STRONG: projected ≥ 6%
//        - SOLID: projected ≥ 4%
//        - (under 4% gets no badge)
//
// HONEST SCOPE NOTE:
// This is "C-lite" — empirically grounded but not regression-fitted. The multipliers
// are derived from public sabermetric research (Fangraphs, Statcast literature,
// established park factors), not from a regression I run on raw event data.
// Improvements expected after 2 weeks of graded outcomes inform tuning.
//
// The output produces a `drivers` array showing which features contributed most
// to the projection — surfaced in UI as the audit trail.

// =============================================================
// LEAGUE BASELINES (2024-25 MLB averages)
// =============================================================
const LEAGUE_HR_PER_PA = 0.030;     // ~3.0% — reasonable for current era
const LEAGUE_BARREL_PCT = 7.5;      // mean barrel rate among qualified hitters
const LEAGUE_HARD_HIT_PCT = 38.0;   // mean hard-hit rate

// Sample-size guard: hitters with fewer than this many PAs get the badge
// but with INSUFFICIENT_DATA labeled. The model still runs (per user preference)
// but the user is alerted that the projection is on thin data.
const MIN_PA_FOR_RELIABLE = 50;

// =============================================================
// FEATURE MULTIPLIERS
// Each function takes a feature value and returns a multiplier on baseline HR/PA,
// plus a "driver" record describing what it means in plain English.
// Drivers with `weight ≥ 1.10` or `weight ≤ 0.90` get surfaced in the UI.
// =============================================================

/**
 * Barrel% → HR multiplier.
 * Sabermetric finding: each barrel converts to HR at ~50%, so a hitter's barrel
 * rate is roughly twice their barrel-driven HR/PA rate. We compare to league mean.
 *
 * Examples:
 *   - Aaron Judge ~22% barrel → 22/7.5 ≈ 2.93x baseline
 *   - Average hitter 7.5% → 1.0x baseline
 *   - Contact hitter 3% → 0.40x baseline
 */
function barrelMultiplier(barrelPct) {
  // Missing or invalid → neutral, don't surface a driver
  if (barrelPct == null || isNaN(barrelPct)) return { mult: 1.0, driver: null };
  // Exactly zero barrel% almost always indicates missing-data fallthrough
  // (real hitters with PAs measured by Statcast almost never have a true 0% barrel rate
  // on a meaningful sample). Treat as no information rather than as evidence of zero power.
  // Without this guard, a missing-data row would falsely flag every hitter as "Limited power"
  // and tank the HR projection across the board.
  if (barrelPct === 0) return { mult: 1.0, driver: null };
  const ratio = barrelPct / LEAGUE_BARREL_PCT;
  // Cap at 3.0 to prevent extreme outliers from dominating
  const mult = Math.max(0.30, Math.min(3.0, ratio));
  if (mult >= 1.50) {
    return { mult, driver: { feature: 'Power profile', detail: `${barrelPct.toFixed(1)}% Barrel% (${(mult).toFixed(1)}x league)`, weight: mult } };
  } else if (mult >= 1.10) {
    return { mult, driver: { feature: 'Power profile', detail: `${barrelPct.toFixed(1)}% Barrel% (above avg)`, weight: mult } };
  } else if (mult <= 0.60) {
    return { mult, driver: { feature: 'Limited power', detail: `${barrelPct.toFixed(1)}% Barrel% (below avg)`, weight: mult } };
  }
  return { mult, driver: null };  // neutral, don't surface
}

/**
 * Hard-Hit% → HR multiplier (secondary signal).
 * Less correlated with HR than barrels but adds incremental signal.
 * Effect is dampened — barrel% already captures most of the power signal.
 */
function hardHitMultiplier(hardHitPct) {
  if (hardHitPct == null || isNaN(hardHitPct)) return { mult: 1.0, driver: null };
  const deviation = (hardHitPct - LEAGUE_HARD_HIT_PCT) / LEAGUE_HARD_HIT_PCT;
  // Scale by 0.30 — hardhit alone shouldn't move much beyond 10% either way
  const mult = Math.max(0.85, Math.min(1.20, 1.0 + (deviation * 0.30)));
  if (mult >= 1.10) {
    return { mult, driver: { feature: 'Hard contact', detail: `${hardHitPct.toFixed(0)}% Hard-Hit (above avg)`, weight: mult } };
  }
  return { mult, driver: null };
}

/**
 * Pitcher HR/9 → HR multiplier for the matchup.
 * Pitcher's seasonal HR-allowed rate scaled against league avg of ~1.20 HR/9.
 * Capped at 2.0x so even bad pitchers don't completely dominate the projection.
 */
function pitcherHrMultiplier(pitcherHrPer9) {
  const LEAGUE_HR_PER_9 = 1.20;
  if (pitcherHrPer9 == null || isNaN(pitcherHrPer9)) return { mult: 1.0, driver: null };
  const ratio = pitcherHrPer9 / LEAGUE_HR_PER_9;
  const mult = Math.max(0.50, Math.min(2.0, ratio));
  if (mult >= 1.30) {
    return { mult, driver: { feature: 'Pitcher HR-prone', detail: `${pitcherHrPer9.toFixed(2)} HR/9 (vulnerable)`, weight: mult } };
  } else if (mult <= 0.70) {
    return { mult, driver: { feature: 'Pitcher HR-stingy', detail: `${pitcherHrPer9.toFixed(2)} HR/9 (suppressing)`, weight: mult } };
  }
  return { mult, driver: null };
}

/**
 * Park HR factor → HR multiplier.
 * Already calibrated as a multiplier (handedness-specific) by the park factor data.
 * We just surface it as a driver if the value is meaningfully different from neutral.
 */
function parkMultiplier(parkHrMult, parkName) {
  if (parkHrMult == null || isNaN(parkHrMult)) return { mult: 1.0, driver: null };
  const mult = Math.max(0.70, Math.min(1.40, parkHrMult));
  if (mult >= 1.10) {
    return { mult, driver: { feature: 'Power park', detail: `${parkName || 'Park'} (+${((mult - 1) * 100).toFixed(0)}% HR)`, weight: mult } };
  } else if (mult <= 0.90) {
    return { mult, driver: { feature: 'Pitcher park', detail: `${parkName || 'Park'} (${((mult - 1) * 100).toFixed(0)}% HR)`, weight: mult } };
  }
  return { mult, driver: null };
}

/**
 * Weather → HR multiplier.
 * Combined effect of:
 *   - Wind direction × ballpark orientation × handedness
 *   - Temperature (each 10°F roughly +1% HR rate)
 *   - Humidity (largely captured by temperature in published research)
 */
function weatherMultiplier(weatherImpact, batSide) {
  if (!weatherImpact || weatherImpact.isDome) return { mult: 1.0, driver: null };

  // Wind multiplier from existing weather module — calibrated by handedness
  const windMult = batSide === 'L' ? (weatherImpact.hrMultLHH || 1.0) : (weatherImpact.hrMultRHH || 1.0);

  // Temperature multiplier — linear ~1% per 10°F
  let tempMult = 1.0;
  if (weatherImpact.tempF != null) {
    const tempDeviation = (weatherImpact.tempF - 70) / 10;  // baseline 70°F
    tempMult = 1.0 + (tempDeviation * 0.010);
    tempMult = Math.max(0.92, Math.min(1.10, tempMult));
  }

  const combined = windMult * tempMult;

  // Build the driver text — most users care about wind, surface that detail
  if (combined >= 1.10) {
    const windDir = weatherImpact.windRelative?.symbol || '';
    const detail = weatherImpact.tempF >= 80 && windMult >= 1.05
      ? `Hot (${Math.round(weatherImpact.tempF)}°F) + wind ${windDir} (+${((combined - 1) * 100).toFixed(0)}% HR)`
      : windMult >= 1.05
      ? `Wind ${windDir} (+${((windMult - 1) * 100).toFixed(0)}% HR)`
      : `Hot weather (${Math.round(weatherImpact.tempF)}°F) carries`;
    return { mult: combined, driver: { feature: 'Weather boost', detail, weight: combined } };
  } else if (combined <= 0.92) {
    const detail = weatherImpact.tempF <= 55
      ? `Cold (${Math.round(weatherImpact.tempF)}°F) suppresses fly balls`
      : `Wind kills fly balls (${((combined - 1) * 100).toFixed(0)}%)`;
    return { mult: combined, driver: { feature: 'Weather suppresses', detail, weight: combined } };
  }
  return { mult: combined, driver: null };
}

/**
 * Best-matched pitch xwOBA → HR multiplier.
 * Captures "this batter crushes this pitcher's primary pitch" signal.
 * Uses xSLG correlation: each .100 above league mean (~.420) maps to ~+15% HR rate.
 */
function pitchMatchupMultiplier(bestMatchedXwoba, dominantPitch) {
  if (bestMatchedXwoba == null || isNaN(bestMatchedXwoba)) return { mult: 1.0, driver: null };
  const x = parseFloat(bestMatchedXwoba);
  if (x === 0) return { mult: 1.0, driver: null };
  // Each .100 above .420 = +15% HR rate. Each .100 below = -10%.
  const deviation = x - 0.420;
  const mult = deviation >= 0
    ? Math.max(1.0, Math.min(2.0, 1.0 + (deviation * 1.5)))
    : Math.max(0.50, Math.min(1.0, 1.0 + (deviation * 1.0)));
  if (mult >= 1.20) {
    return {
      mult,
      driver: {
        feature: 'Pitch matchup',
        detail: dominantPitch
          ? `Crushes ${dominantPitch} (xwOBA ${x.toFixed(3)})`
          : `Strong matchup (xwOBA ${x.toFixed(3)})`,
        weight: mult
      }
    };
  } else if (mult <= 0.80) {
    return { mult, driver: { feature: 'Weak matchup', detail: `Struggles vs primary pitch (xwOBA ${x.toFixed(3)})`, weight: mult } };
  }
  return { mult, driver: null };
}

/**
 * Platoon advantage → HR multiplier.
 * Sabermetric research: hitters with platoon advantage hit ~15-20% more HRs vs same-hand pitching.
 */
function platoonMultiplier(platoonAdjustment) {
  if (!platoonAdjustment || platoonAdjustment.favor !== 'hitter') return { mult: 1.0, driver: null };
  const platMult = parseFloat(platoonAdjustment.multiplier || 1.0);
  if (platMult >= 1.15) {
    return { mult: 1.15, driver: { feature: 'Platoon edge', detail: 'Strong platoon advantage', weight: 1.15 } };
  } else if (platMult >= 1.05) {
    return { mult: 1.08, driver: null };  // mild platoon, neutral driver
  }
  return { mult: 1.0, driver: null };
}

/**
 * K% → HR penalty.
 * High-K hitters need to make contact to HR. League avg ~22% K. Above 30% K starts
 * meaningfully reducing HR opportunities.
 */
function strikeoutPenalty(kPct) {
  if (kPct == null || isNaN(kPct)) return { mult: 1.0, driver: null };
  if (kPct <= 22) return { mult: 1.0, driver: null };  // at or below league avg = no penalty
  // Each percentage point above 22 reduces HR rate by ~0.8%
  const penalty = (kPct - 22) * 0.008;
  const mult = Math.max(0.75, 1.0 - penalty);
  if (mult <= 0.85) {
    return { mult, driver: { feature: 'High K rate', detail: `${kPct.toFixed(0)}% K (limits opportunities)`, weight: mult } };
  }
  return { mult, driver: null };
}

/**
 * Bullpen HR vulnerability → boost.
 * If bullpen is in the same elite/strong tier the hitter has against the starter,
 * the FULL GAME HR potential is materially higher (50%+ of HRs come off bullpens).
 */
function bullpenMultiplier(bullpenTier) {
  if (bullpenTier === 'elite' || bullpenTier === 'strong') {
    return { mult: 1.18, driver: { feature: 'Bullpen edge', detail: 'FULL GAME HR vulnerable', weight: 1.18 } };
  } else if (bullpenTier === 'solid') {
    return { mult: 1.06, driver: null };
  }
  return { mult: 1.0, driver: null };
}

// =============================================================
// MAIN SCORING FUNCTION
// =============================================================

/**
 * Compute empirical HR projection for a single hitter-vs-pitcher matchup.
 *
 * @param {Object} ctx
 *   @param {number} ctx.barrelPct
 *   @param {number} ctx.hardHitPct
 *   @param {number} ctx.kPct
 *   @param {number} ctx.seasonPa  — total season PAs for sample-size guard
 *   @param {number} ctx.bestMatchedXwoba
 *   @param {string} ctx.dominantPitch — name of pitcher's primary pitch
 *   @param {number} ctx.pitcherHrPer9
 *   @param {number} ctx.parkHrMult
 *   @param {string} ctx.parkName
 *   @param {Object} ctx.weatherImpact
 *   @param {string} ctx.batSide  — 'L' or 'R'
 *   @param {Object} ctx.platoonAdjustment
 *   @param {string} ctx.bullpenTier
 * @returns {{
 *   projectedHrPerPa,
 *   tier,
 *   tierLabel,
 *   emoji,
 *   confidence,
 *   drivers,
 *   multiplier,
 *   sampleWarning
 * } | null}
 */
/**
 * Internal: compute projection + drivers + multiplier WITHOUT the tier gate.
 * This always returns a result, regardless of whether the projection is high
 * enough to warrant a badge. Used by both:
 *   - computeHrProjection (which then applies the tier gate, returns null below)
 *   - computeHrAudit (which returns the raw projection always — diagnostic use)
 */
function computeRawProjection(ctx) {
  const {
    barrelPct, hardHitPct, kPct, seasonPa = 0,
    bestMatchedXwoba, dominantPitch,
    pitcherHrPer9,
    parkHrMult, parkName,
    weatherImpact, batSide,
    platoonAdjustment,
    bullpenTier
  } = ctx;

  // Compute each feature multiplier and collect drivers
  // Keep names so the _debug trace can identify each multiplier source
  const featureFns = [
    ['barrel', () => barrelMultiplier(barrelPct)],
    ['hardHit', () => hardHitMultiplier(hardHitPct)],
    ['pitchMatchup', () => pitchMatchupMultiplier(bestMatchedXwoba, dominantPitch)],
    ['pitcherHr', () => pitcherHrMultiplier(pitcherHrPer9)],
    ['park', () => parkMultiplier(parkHrMult, parkName)],
    ['weather', () => weatherMultiplier(weatherImpact, batSide)],
    ['platoon', () => platoonMultiplier(platoonAdjustment)],
    ['kPenalty', () => strikeoutPenalty(kPct)],
    ['bullpen', () => bullpenMultiplier(bullpenTier)],
  ];

  // Combine multipliers + capture per-feature trace for diagnostics
  let multiplier = 1.0;
  const drivers = [];
  const multTrace = {};  // feature name → { mult, driverFired }
  for (const [name, fn] of featureFns) {
    const f = fn();
    multiplier *= f.mult;
    multTrace[name] = {
      mult: parseFloat(f.mult.toFixed(3)),
      driverFired: f.driver ? f.driver.feature : null
    };
    if (f.driver) drivers.push(f.driver);
  }

  // Final projected HR/PA
  const projectedHrPerPa = LEAGUE_HR_PER_PA * multiplier;

  // Tier classification (returned even if below threshold; caller decides what to do)
  let tier = null, tierLabel = null, emoji = null;
  if (projectedHrPerPa >= 0.09) { tier = 'elite'; tierLabel = 'ELITE'; emoji = '💣'; }
  else if (projectedHrPerPa >= 0.06) { tier = 'strong'; tierLabel = 'STRONG'; emoji = '🎯'; }
  else if (projectedHrPerPa >= 0.04) { tier = 'solid'; tierLabel = 'SOLID'; emoji = '⚡'; }

  // Sort drivers by absolute deviation from 1.0 (highest impact first)
  drivers.sort((a, b) => Math.abs(b.weight - 1) - Math.abs(a.weight - 1));

  // Sample-size warning
  const sampleWarning = seasonPa > 0 && seasonPa < MIN_PA_FOR_RELIABLE
    ? { label: 'INSUFFICIENT DATA', detail: `Only ${seasonPa} PA — projection is on thin data` }
    : null;

  // Confidence label
  let confidence;
  if (sampleWarning) confidence = 'low';
  else if (drivers.length >= 3 && multiplier >= 2.0) confidence = 'high';
  else if (drivers.length >= 2 && multiplier >= 1.5) confidence = 'medium';
  else confidence = 'medium';

  return {
    projectedHrPerPa: parseFloat(projectedHrPerPa.toFixed(4)),
    tier,
    tierLabel,
    emoji,
    confidence,
    drivers: drivers.slice(0, 4),
    multiplier: parseFloat(multiplier.toFixed(2)),
    sampleWarning,
    // Diagnostic trace — every input + every multiplier. Read from console
    // or include in audit panel to identify exactly which factor is producing
    // a wrong projection. Inputs first (what reached the function), then each
    // per-feature multiplier (what was applied), then the combined product.
    _debug: {
      inputs: {
        barrelPct: barrelPct == null ? null : parseFloat(barrelPct.toFixed ? barrelPct.toFixed(2) : barrelPct),
        hardHitPct: hardHitPct == null ? null : parseFloat(hardHitPct.toFixed ? hardHitPct.toFixed(2) : hardHitPct),
        kPct: kPct == null ? null : parseFloat(kPct.toFixed ? kPct.toFixed(2) : kPct),
        seasonPa,
        bestMatchedXwoba: bestMatchedXwoba == null ? null : parseFloat(parseFloat(bestMatchedXwoba).toFixed(3)),
        dominantPitch,
        pitcherHrPer9: pitcherHrPer9 == null ? null : parseFloat(pitcherHrPer9.toFixed(2)),
        parkHrMult: parkHrMult == null ? null : parseFloat(parkHrMult.toFixed(3)),
        parkName,
        batSide,
        weatherTempF: weatherImpact?.tempF || null,
        weatherWindCat: weatherImpact?.windRelative?.category || null,
        platoonFavor: platoonAdjustment?.favor || null,
        bullpenTier
      },
      multipliers: multTrace,
      combinedMultiplier: parseFloat(multiplier.toFixed(3)),
      projectedHrPerPa: parseFloat(projectedHrPerPa.toFixed(4))
    },
    // Legacy fields for UI backward compatibility:
    score: Math.round(multiplier * 30),
    barrelPct,
    hardHitPct,
    bestMatchedXwoba: bestMatchedXwoba ? parseFloat(bestMatchedXwoba).toFixed(3) : null,
    parkHrMult: parkHrMult ? parkHrMult.toFixed(2) : null,
    criteria: drivers.map(d => d.detail),
  };
}

export function computeHrProjection(ctx) {
  const result = computeRawProjection(ctx);
  // Existing public contract: return null when below SOLID threshold (no badge fires)
  if (!result.tier) return null;
  return result;
}

/**
 * Audit version: returns the projection regardless of tier.
 * Used for diagnostic display so we can see what the model is *almost* badging.
 * Same drivers, same multiplier, same projection — just no null gate.
 *
 * Returns the projection result with `tier === null` when below SOLID threshold,
 * but with all the projection data intact for diagnostic display.
 */
export function computeHrAudit(ctx) {
  return computeRawProjection(ctx);
}
