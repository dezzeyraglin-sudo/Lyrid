// api/_lib/environmentImpact.js
//
// Composite environment multiplier — combines park, weather, altitude, and roof
// state into a single coherent run/HR multiplier with interaction terms.
//
// Replaces the previous flat `parkRunMult * weatherRunMult` chain in
// analyze.js's buildGameProjection. Surfaces interactions the flat product
// misses:
//
//   - Hot × wind-out (compounding carry — hot air with wind helping
//     produces more than the linear product suggests)
//   - Hitter-park × hot weather (Coors plays even bigger when hot, smaller
//     when cold)
//   - Altitude × hot (altitude amplifies temperature carry effects)
//   - Pitcher-park × cold (cold suppresses already-suppressive parks more)
//   - Hitter-park × wind-in (partial neutralization of park boost)
//
// FEATURE FLAG: Gated behind `process.env.ENV_REFACTOR_ENABLED`. When false
// (default), this module returns a passthrough — `parkRunMult * weatherRunMult`
// with no interactions, exactly the old math. When true, the full composite
// fires.
//
// Why flagged: the original premise for this refactor was correcting a "+2.9
// runs UNDER" calibration bias. After shipping, we discovered that bias figure
// was computed from a user-curated sample (`projectionAudit` only contains
// games the user manually analyzed, not all MLB games), so it doesn't reliably
// represent population-level model behavior. We need representative calibration
// data — likely from a batch backfill that runs analyze across full slates —
// before flipping the flag and trusting the asymmetric correction.
//
// To flip the flag: set ENV_REFACTOR_ENABLED=true in Vercel env vars (no code
// change required). When the flag is on, the asymmetric design assumes the
// model under-projects on average; if real calibration data shows the opposite,
// the asymmetry would need to be inverted before enabling.
//
// The diagnostic UI (env audit panel in deep mode) renders regardless of flag
// state — when off, it shows interactionMult: 1.000 and "No interactions
// fired", which is useful for verifying the flag is doing what it claims.
//
// Returns a structured object that:
//   - Replaces the runMult chain in buildGameProjection
//   - Preserves all existing weatherImpact fields (hrMultLHH, hrMultRHH,
//     narrative, etc.) so the HR module is unaffected
//   - Surfaces interactions array for diagnostics

// Read flag at module load. Vercel env vars come in as strings, so we
// explicitly check for the truthy string values rather than relying on
// JS truthiness (the string "false" is truthy by default).
const ENV_REFACTOR_ENABLED = (() => {
  const v = process.env.ENV_REFACTOR_ENABLED;
  return v === 'true' || v === '1' || v === 'yes';
})();

/**
 * @param {Object} parkFactor   { runs, hr, lhbHr, rhbHr, name, ... }
 * @param {Object} weatherImpact { runMult, hrMultLHH, hrMultRHH, isDome,
 *                                tempF, windSpeedMph, windRelative, narrative }
 * @param {Object} parkGeo      { exposure, roofType, ... } — used for altitude proxy
 * @returns {{
 *   runMult,           composite run multiplier (replaces parkRunMult * weatherRunMult)
 *   hrMultLHH,         passthrough from weatherImpact (HR module already consumes this)
 *   hrMultRHH,         passthrough from weatherImpact
 *   interactions[],    array of { name, magnitude, narrative }
 *   _debug             full breakdown for diagnostic surfacing
 * }}
 */
export function computeEnvironmentImpact(parkFactor, weatherImpact, parkGeo) {
  // Base multipliers (current flat math, what we replace)
  const baseParkRun = parkFactor ? (parkFactor.runs || 100) / 100 : 1.0;
  const baseWeatherRun = weatherImpact?.runMult || 1.0;

  // FEATURE FLAG: when disabled (default), return a passthrough that exactly
  // matches the old `parkRunMult * weatherRunMult` math. The diagnostic UI
  // can still render — it'll show interactionMult: 1.000 and an empty
  // interactions array, which makes it clear the flag is off and the new
  // math is dormant. Flip the flag via the ENV_REFACTOR_ENABLED env var
  // when we have representative calibration data to verify the direction
  // of the asymmetric correction.
  if (!ENV_REFACTOR_ENABLED) {
    return {
      runMult: baseParkRun * baseWeatherRun,
      hrMultLHH: weatherImpact?.hrMultLHH || 1.0,
      hrMultRHH: weatherImpact?.hrMultRHH || 1.0,
      interactions: [],
      _debug: {
        baseParkRun: parseFloat(baseParkRun.toFixed(4)),
        baseWeatherRun: parseFloat(baseWeatherRun.toFixed(4)),
        interactionMult: 1.0,
        compositeRunMult: parseFloat((baseParkRun * baseWeatherRun).toFixed(4)),
        interactions: [],
        flagDisabled: true,
        conditions: {
          tempF: weatherImpact?.tempF ?? null,
          windCat: weatherImpact?.windRelative?.category ?? null,
          windSpeed: weatherImpact?.windSpeedMph || 0,
          exposure: parkGeo?.exposure ?? null,
          parkRuns: parkFactor?.runs ?? null
        }
      }
    };
  }

  // No park/weather data → return neutral
  if (!parkFactor && !weatherImpact) {
    return {
      runMult: 1.0,
      hrMultLHH: 1.0,
      hrMultRHH: 1.0,
      interactions: [],
      _debug: { baseParkRun: 1.0, baseWeatherRun: 1.0, interactions: [] }
    };
  }

  // Dome parks: skip all weather interactions, just use park factor
  if (weatherImpact?.isDome) {
    return {
      runMult: baseParkRun,
      hrMultLHH: weatherImpact.hrMultLHH || 1.0,
      hrMultRHH: weatherImpact.hrMultRHH || 1.0,
      interactions: [],
      _debug: {
        baseParkRun, baseWeatherRun: 1.0, interactions: [],
        note: 'dome — no weather interactions'
      }
    };
  }

  // ---- DETECT INTERACTIONS ----
  //
  // Each interaction is a multiplier applied ON TOP of the flat base product.
  // Magnitudes are calibrated to address the +2.9 UNDER bias without
  // overshooting on suppressive environments.

  const interactions = [];
  let interactionMult = 1.0;

  const tempF = weatherImpact?.tempF;
  const windCat = weatherImpact?.windRelative?.category;
  const windSpeed = weatherImpact?.windSpeedMph || 0;
  const exposure = parkGeo?.exposure || 1.0;
  const isHotPark = parkFactor && parkFactor.runs >= 105;        // hitter park
  const isColdPark = parkFactor && parkFactor.runs <= 95;        // pitcher park
  const isHot = tempF != null && tempF >= 80;
  const isVeryHot = tempF != null && tempF >= 88;
  const isCold = tempF != null && tempF <= 55;
  const windOut = windCat === 'OUT_TO_CF' || windCat === 'OUT_TO_LF' || windCat === 'OUT_TO_RF';
  const windIn = windCat === 'IN_FROM_CF' || windCat === 'IN_FROM_LF' || windCat === 'IN_FROM_RF';
  const isHighAltitude = exposure >= 1.25;  // Coors-tier elevation amplifier

  // Interaction 1: Hot × wind-out — compounding carry
  // The flat product undercounts. A 90°F day with 12mph wind blowing out
  // produces ~6-8% more runs than the product of independent boosts predicts.
  if (isHot && windOut && windSpeed >= 8) {
    const windFactor = Math.min(0.06, (windSpeed - 5) * 0.005);  // 8mph→1.5%, 15mph→5%, capped at 6%
    const tempFactor = isVeryHot ? 0.04 : 0.02;                  // hot: +2%, very hot: +4%
    const mag = windFactor + tempFactor;
    interactionMult *= (1 + mag);
    interactions.push({
      name: 'hot_x_wind_out',
      magnitude: mag,
      narrative: `Hot day (${Math.round(tempF)}°F) with wind blowing out — compounding carry boost (+${(mag*100).toFixed(1)}%)`
    });
  }

  // Interaction 2: Hitter park × hot — Coors/Cincinnati/Fenway play bigger when hot
  if (isHotPark && isHot) {
    const parkAmp = (parkFactor.runs - 100) / 100;  // 115 → 0.15, 108 → 0.08
    const tempBoost = isVeryHot ? 0.04 : 0.025;
    const mag = parkAmp * tempBoost * 2.5;  // amplify by park's own boost magnitude
    interactionMult *= (1 + mag);
    interactions.push({
      name: 'hot_park_x_hot_weather',
      magnitude: mag,
      narrative: `${parkFactor.name} amplifies in hot weather — extra +${(mag*100).toFixed(1)}% runs`
    });
  }

  // Interaction 3: High altitude × hot — Coors specifically
  // Above and beyond the park-x-hot interaction. Altitude reduces air density,
  // and air density drops further when hot. Real compounding physics.
  if (isHighAltitude && isHot) {
    const altBoost = (exposure - 1.0) * (isVeryHot ? 0.10 : 0.06);
    interactionMult *= (1 + altBoost);
    interactions.push({
      name: 'high_altitude_x_hot',
      magnitude: altBoost,
      narrative: `High altitude (${parkFactor?.name || 'park'}) + hot weather — compounding carry (+${(altBoost*100).toFixed(1)}%)`
    });
  }

  // Interaction 4: Pitcher park × cold — modest suppression amplifier
  // Asymmetric: smaller magnitude than the boost interactions, intentionally,
  // because the model is already correctly suppressive on these games.
  if (isColdPark && isCold) {
    const parkSupp = (100 - parkFactor.runs) / 100;  // 92 → 0.08
    const tempSupp = 0.02;
    const mag = -(parkSupp * tempSupp * 2.0);  // negative — suppress further
    interactionMult *= (1 + mag);
    interactions.push({
      name: 'cold_park_x_cold_weather',
      magnitude: mag,
      narrative: `${parkFactor.name} in cold weather — suppression amplifier (${(mag*100).toFixed(1)}%)`
    });
  }

  // Interaction 5: Wind-in × hitter park — partial neutralization
  // Wind blowing in at Coors/Yankee/Cincy doesn't fully neutralize the park
  // boost (geometry still matters), but it does cut the boost meaningfully.
  // Without this, the model treats Coors-with-wind-in as still being Coors.
  if (isHotPark && windIn && windSpeed >= 8) {
    const parkAmp = (parkFactor.runs - 100) / 100;
    const windSupp = Math.min(0.04, (windSpeed - 5) * 0.003);
    const mag = -(parkAmp * windSupp * 1.5);
    interactionMult *= (1 + mag);
    interactions.push({
      name: 'hitter_park_x_wind_in',
      magnitude: mag,
      narrative: `${parkFactor.name} with wind blowing in — park boost partially neutralized (${(mag*100).toFixed(1)}%)`
    });
  }

  // ---- COMPOSITE OUTPUT ----
  //
  // Final runMult = base flat product × interaction terms.
  // Interactions can compound but typically only 1-2 fire per game.

  const compositeRunMult = baseParkRun * baseWeatherRun * interactionMult;

  return {
    runMult: compositeRunMult,
    hrMultLHH: weatherImpact?.hrMultLHH || 1.0,
    hrMultRHH: weatherImpact?.hrMultRHH || 1.0,
    interactions,
    _debug: {
      baseParkRun: parseFloat(baseParkRun.toFixed(4)),
      baseWeatherRun: parseFloat(baseWeatherRun.toFixed(4)),
      interactionMult: parseFloat(interactionMult.toFixed(4)),
      compositeRunMult: parseFloat(compositeRunMult.toFixed(4)),
      interactions: interactions.map(i => ({
        name: i.name,
        magnitude: parseFloat(i.magnitude.toFixed(4))
      })),
      conditions: {
        tempF, windCat, windSpeed,
        exposure,
        parkRuns: parkFactor?.runs,
        isHotPark, isColdPark,
        isHot, isVeryHot, isCold,
        windOut, windIn, isHighAltitude
      }
    }
  };
}
