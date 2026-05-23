/**
 * altitudeEngine.js
 *
 * Air density and per-pitch movement adjustment engine.
 *
 * Why this exists:
 *   Pitch movement depends on the Magnus effect, which scales with air density.
 *   At Coors Field (5,200 ft, ~17% lower density than sea level), four-seam
 *   fastballs lose ~20% of their "rise" relative to sea level. Curveballs lose
 *   depth. Sweepers lose horizontal bite. Pitchers whose arsenals rely on
 *   movement (4-seam dominant, breaking-ball heavy) get punished in thin air.
 *   Pitchers whose arsenals rely on command and contact (sinker, cutter) hold
 *   up better. The previous engine ignored this entirely.
 *
 *   Domes add a different signal: stable temperature, humidity, no wind.
 *   Pitch shapes become more predictable, helping command-based pitchers.
 *
 * What this engine does:
 *   1. computeAirDensity(parkId, weather) → density ratio (1.0 = sea level)
 *   2. adjustPitcherArsenal(arsenal, density) → arsenal with adjusted xwOBA
 *      per pitch type, based on each pitch's Magnus sensitivity
 *   3. getEnvironmentNarrative(density, dominantPitchType) → string for UI
 *
 * What it does NOT do:
 *   - Model individual pitchers' historical Coors performance (no per-pitcher
 *     adjustments — only per-pitch-type)
 *   - Adjust hitter performance directly (handled in park run multiplier elsewhere)
 *   - Modify outside the .92 - 1.08 range for non-Coors parks (we don't want
 *     small adjustments stacking into noise)
 *
 * IMPORTANT — calibration philosophy:
 *   Only Coors produces meaningfully large adjustments (~10-15% on Magnus pitches).
 *   ARI/TEX in summer heat add a few percent. Domes apply a small stabilization
 *   bonus to command pitchers. Sea-level temperate parks are essentially 1.000×.
 *   This is intentional: the league-wide noise floor should not move when the
 *   air density is normal.
 */

// =============================================================
// PARK AIR PROFILES
// =============================================================
//
// Each park entry:
//   - elevation_ft: ground elevation above sea level
//   - dome: true if fully enclosed (no weather penetration)
//   - retractable: true if has retractable roof (treated as dome when closed)
//   - typical_temp_f: median game-time temperature (used for fallback)
//   - typical_humidity: median game-time relative humidity (0-1)
//   - density_base: precomputed density ratio at typical conditions (1.0 = sea level reference)
//
// The density_base is the precomputed product of elevation effect + typical
// weather. At game time we adjust this with the day's actual weather.
//
// Sources: MLB park elevation data, NOAA climate normals, published park
// effect studies. Numbers verified Dec 2024.

const PARK_AIR_PROFILES = {
  // === HIGH ALTITUDE ===
  'COL': { elevation_ft: 5200, dome: false, retractable: false, typical_temp_f: 72, typical_humidity: 0.32, density_base: 0.825 },

  // === DOMES (closed environment, no weather penetration) ===
  'TB':  { elevation_ft: 15,   dome: true,  retractable: false, typical_temp_f: 72, typical_humidity: 0.55, density_base: 0.995 },
  'TOR': { elevation_ft: 250,  dome: false, retractable: true,  typical_temp_f: 70, typical_humidity: 0.55, density_base: 0.992 },
  'MIL': { elevation_ft: 635,  dome: false, retractable: true,  typical_temp_f: 70, typical_humidity: 0.60, density_base: 0.985 },
  'HOU': { elevation_ft: 22,   dome: false, retractable: true,  typical_temp_f: 78, typical_humidity: 0.65, density_base: 0.990 },
  'SEA': { elevation_ft: 134,  dome: false, retractable: true,  typical_temp_f: 65, typical_humidity: 0.62, density_base: 1.000 },
  'ARI': { elevation_ft: 1100, dome: false, retractable: true,  typical_temp_f: 88, typical_humidity: 0.25, density_base: 0.955 },
  'MIA': { elevation_ft: 8,    dome: false, retractable: true,  typical_temp_f: 82, typical_humidity: 0.72, density_base: 0.985 },

  // === HOT/DRY OPEN AIR (meaningful summer density reduction) ===
  'TEX': { elevation_ft: 545,  dome: false, retractable: true,  typical_temp_f: 86, typical_humidity: 0.55, density_base: 0.972 },

  // === ELEVATED OPEN AIR (modest altitude effect) ===
  'ATL': { elevation_ft: 1050, dome: false, retractable: false, typical_temp_f: 78, typical_humidity: 0.65, density_base: 0.970 },
  'KC':  { elevation_ft: 750,  dome: false, retractable: false, typical_temp_f: 76, typical_humidity: 0.55, density_base: 0.978 },
  'CIN': { elevation_ft: 480,  dome: false, retractable: false, typical_temp_f: 74, typical_humidity: 0.60, density_base: 0.985 },
  'PIT': { elevation_ft: 730,  dome: false, retractable: false, typical_temp_f: 70, typical_humidity: 0.60, density_base: 0.983 },
  'STL': { elevation_ft: 466,  dome: false, retractable: false, typical_temp_f: 76, typical_humidity: 0.60, density_base: 0.985 },
  'MIN': { elevation_ft: 815,  dome: false, retractable: false, typical_temp_f: 68, typical_humidity: 0.55, density_base: 0.985 },

  // === SEA-LEVEL OPEN AIR (essentially baseline) ===
  'NYY': { elevation_ft: 55,   dome: false, retractable: false, typical_temp_f: 72, typical_humidity: 0.60, density_base: 1.000 },
  'NYM': { elevation_ft: 30,   dome: false, retractable: false, typical_temp_f: 72, typical_humidity: 0.60, density_base: 1.000 },
  'BOS': { elevation_ft: 18,   dome: false, retractable: false, typical_temp_f: 68, typical_humidity: 0.62, density_base: 1.000 },
  'BAL': { elevation_ft: 30,   dome: false, retractable: false, typical_temp_f: 72, typical_humidity: 0.62, density_base: 1.000 },
  'TBR': { elevation_ft: 15,   dome: true,  retractable: false, typical_temp_f: 72, typical_humidity: 0.55, density_base: 0.995 },  // alias for TB
  'PHI': { elevation_ft: 39,   dome: false, retractable: false, typical_temp_f: 74, typical_humidity: 0.62, density_base: 0.998 },
  'WSH': { elevation_ft: 12,   dome: false, retractable: false, typical_temp_f: 76, typical_humidity: 0.65, density_base: 0.997 },
  'WAS': { elevation_ft: 12,   dome: false, retractable: false, typical_temp_f: 76, typical_humidity: 0.65, density_base: 0.997 },  // alias
  'DET': { elevation_ft: 585,  dome: false, retractable: false, typical_temp_f: 70, typical_humidity: 0.58, density_base: 0.985 },
  'CLE': { elevation_ft: 660,  dome: false, retractable: false, typical_temp_f: 70, typical_humidity: 0.62, density_base: 0.983 },
  'CWS': { elevation_ft: 595,  dome: false, retractable: false, typical_temp_f: 72, typical_humidity: 0.62, density_base: 0.984 },
  'CHW': { elevation_ft: 595,  dome: false, retractable: false, typical_temp_f: 72, typical_humidity: 0.62, density_base: 0.984 },  // alias
  'CHC': { elevation_ft: 600,  dome: false, retractable: false, typical_temp_f: 70, typical_humidity: 0.60, density_base: 0.984 },
  'OAK': { elevation_ft: 50,   dome: false, retractable: false, typical_temp_f: 68, typical_humidity: 0.62, density_base: 1.005 },
  'ATH': { elevation_ft: 50,   dome: false, retractable: false, typical_temp_f: 68, typical_humidity: 0.62, density_base: 1.005 },  // A's rebrand
  'LAA': { elevation_ft: 160,  dome: false, retractable: false, typical_temp_f: 72, typical_humidity: 0.55, density_base: 1.000 },
  'LAD': { elevation_ft: 510,  dome: false, retractable: false, typical_temp_f: 74, typical_humidity: 0.55, density_base: 0.987 },
  'SD':  { elevation_ft: 13,   dome: false, retractable: false, typical_temp_f: 70, typical_humidity: 0.65, density_base: 1.005 },
  'SDP': { elevation_ft: 13,   dome: false, retractable: false, typical_temp_f: 70, typical_humidity: 0.65, density_base: 1.005 },  // alias
  'SF':  { elevation_ft: 12,   dome: false, retractable: false, typical_temp_f: 64, typical_humidity: 0.70, density_base: 1.010 },
  'SFG': { elevation_ft: 12,   dome: false, retractable: false, typical_temp_f: 64, typical_humidity: 0.70, density_base: 1.010 },  // alias
};

// =============================================================
// PER-PITCH-TYPE MOVEMENT SENSITIVITY
// =============================================================
//
// Sensitivity = how much a pitch's effectiveness changes with air density.
// Higher = more sensitive (Magnus-dependent). Lower = less sensitive (command-based).
//
// Interpretation: for a density delta of ΔD (where ΔD = density - 1.0),
//   xwOBA_adjustment = -sensitivity × ΔD × MAGNITUDE_SCALE
//
// Sign convention: negative ΔD (thinner air, like Coors) → positive xwOBA shift
//   (worse for pitcher). Positive ΔD (dense, cold air) → negative xwOBA shift
//   (better for pitcher).
//
// MAGNITUDE_SCALE calibrates the overall effect. With scale = 0.40:
//   - 4-seam at Coors (ΔD = -0.175, sensitivity 1.0) → xwOBA +0.070 (significant)
//   - Sinker at Coors (sensitivity 0.3) → xwOBA +0.021 (modest)
//   - Curveball at Coors (sensitivity 0.85) → xwOBA +0.060 (significant)
//
// Pitch types follow MLB Statcast naming conventions.

const MAGNITUDE_SCALE = 0.40;

const PITCH_TYPE_SENSITIVITY = {
  // Magnus-heavy: lose effectiveness in thin air
  'FF':       1.00,   // 4-seam fastball: pure ride/carry, Magnus-dependent
  'FOUR_SEAM': 1.00,  // alias
  'CU':       0.85,   // curveball: depth/12-6 break, Magnus-dependent
  'CURVE':    0.85,   // alias
  'KC':       0.85,   // knuckle-curve
  'SL':       0.70,   // slider: depends on grip; sweeper-style hit hard
  'SLIDER':   0.70,   // alias
  'ST':       0.95,   // sweeper (separated from slider in modern classification): very Magnus-sensitive
  'SWEEPER':  0.95,   // alias
  'CH':       0.55,   // changeup: deception+drop blend. Drop fades; deception holds
  'CHANGEUP': 0.55,   // alias
  'FS':       0.50,   // splitter: similar to changeup
  'SPLIT':    0.50,   // alias
  'EP':       0.60,   // eephus: just funky, hard to model
  'KN':       0.70,   // knuckleball: depends on air for flutter

  // Command/contact-heavy: hold up better in thin air
  'FC':       0.35,   // cutter: small movement, command-based
  'CUTTER':   0.35,   // alias
  'SI':       0.30,   // sinker: gravity + arm-side run, less Magnus
  'SINKER':   0.30,   // alias
  'FT':       0.30,   // 2-seam: similar to sinker
  'TWO_SEAM': 0.30,   // alias

  // Default for unknown pitch types: moderate sensitivity
  '_default': 0.60,
};

function getSensitivity(pitchType) {
  if (!pitchType) return PITCH_TYPE_SENSITIVITY._default;
  const key = String(pitchType).toUpperCase().trim();
  return PITCH_TYPE_SENSITIVITY[key] !== undefined ? PITCH_TYPE_SENSITIVITY[key] : PITCH_TYPE_SENSITIVITY._default;
}

// =============================================================
// AIR DENSITY COMPUTATION
// =============================================================

/**
 * Compute the effective air density ratio for a game.
 *
 * Starts from the park's density_base (precomputed for typical conditions),
 * then adjusts for actual weather. Returns a ratio relative to sea-level
 * standard atmosphere (1.0 = baseline).
 *
 * Adjustments:
 *   - Temperature: ~0.2% density drop per °F above the park's typical temp
 *   - Humidity: small positive correction for high humidity (humid air is less dense)
 *   - Dome: stabilizes — clamp toward density_base regardless of outside weather
 *
 * @param {string} parkId - team abbrev or park identifier
 * @param {Object} weather - { temp_f, humidity (0-1), isDome }
 * @returns {Object} { density, audit }
 */
function computeAirDensity(parkId, weather = {}) {
  const profile = PARK_AIR_PROFILES[parkId] || null;
  const audit = {
    parkId,
    profileFound: !!profile,
    inputs: { ...weather },
  };

  if (!profile) {
    // Unknown park: treat as sea-level neutral, but flag it
    audit.fallback = 'unknown_park_sea_level_default';
    audit.density = 1.0;
    return { density: 1.0, audit };
  }

  // Dome/closed roof: weather can't penetrate. Use park's density_base directly.
  const isClosed = profile.dome || (profile.retractable && weather.isDome === true);
  if (isClosed) {
    audit.closed = true;
    audit.density = profile.density_base;
    audit.adjustments = { weather_ignored: 'dome_or_closed_roof' };
    return { density: profile.density_base, audit };
  }

  // Open air: adjust from density_base for current conditions
  let density = profile.density_base;
  const adjustments = {};

  // Temperature: 0.2% density drop per °F above typical temp; same gain when cooler
  if (typeof weather.temp_f === 'number') {
    const tempDelta = weather.temp_f - profile.typical_temp_f;
    const tempEffect = -tempDelta * 0.002;
    density += tempEffect;
    adjustments.temp_delta_f = tempDelta;
    adjustments.temp_effect = round4(tempEffect);
  }

  // Humidity: humid air is slightly less dense (water vapor displaces N2/O2)
  // ~0.5% drop from 30% to 90% humidity
  if (typeof weather.humidity === 'number') {
    const humidDelta = weather.humidity - profile.typical_humidity;
    const humidEffect = -humidDelta * 0.008;  // -0.8% per 1.0 humidity delta
    density += humidEffect;
    adjustments.humidity_delta = round3(humidDelta);
    adjustments.humidity_effect = round4(humidEffect);
  }

  audit.adjustments = adjustments;
  audit.density = round4(density);
  return { density, audit };
}

// =============================================================
// ARSENAL ADJUSTMENT
// =============================================================

/**
 * Adjust a pitcher's arsenal xwOBA-against based on air density.
 *
 * For each pitch in the arsenal, compute an xwOBA shift based on:
 *   - Pitch type sensitivity to air density
 *   - Magnitude of air density deviation from sea level (ΔD)
 *
 * Returns a new arsenal array (does not mutate input) with:
 *   - All original fields preserved
 *   - xwoba field replaced with adjusted value
 *   - originalXwoba preserved for diagnostics
 *   - altitudeAdjustment field showing the per-pitch shift
 *
 * @param {Array} arsenal - [{ pitchType, xwoba, pitches, ... }, ...]
 * @param {number} density - air density ratio (1.0 = sea level)
 * @returns {Object} { adjustedArsenal, audit }
 */
function adjustPitcherArsenal(arsenal, density) {
  if (!Array.isArray(arsenal) || arsenal.length === 0) {
    return { adjustedArsenal: arsenal || [], audit: { reason: 'no_arsenal' } };
  }

  // density delta from sea level (negative = thinner air)
  const densityDelta = density - 1.0;

  // Skip when density is essentially sea-level (avoid noise adjustments)
  if (Math.abs(densityDelta) < 0.01) {
    return {
      adjustedArsenal: arsenal,
      audit: { density: round4(density), densityDelta: round4(densityDelta), reason: 'near_sea_level_no_adjustment' },
    };
  }

  const perPitchAdjustments = [];
  const adjusted = arsenal.map(pitch => {
    const sensitivity = getSensitivity(pitch.pitchType || pitch.type);
    // Negative density delta (thin air) → positive xwOBA shift (worse for pitcher)
    // The math: xwOBA_shift = -sensitivity × densityDelta × MAGNITUDE_SCALE
    const xwobaShift = -sensitivity * densityDelta * MAGNITUDE_SCALE;
    const originalXwoba = parseFloat(pitch.xwoba) || 0;
    const adjustedXwoba = originalXwoba + xwobaShift;

    perPitchAdjustments.push({
      pitchType: pitch.pitchType || pitch.type,
      sensitivity,
      originalXwoba: round3(originalXwoba),
      xwobaShift: round3(xwobaShift),
      adjustedXwoba: round3(adjustedXwoba),
    });

    return {
      ...pitch,
      xwoba: adjustedXwoba,
      originalXwoba,
      altitudeAdjustment: round3(xwobaShift),
    };
  });

  return {
    adjustedArsenal: adjusted,
    audit: {
      density: round4(density),
      densityDelta: round4(densityDelta),
      perPitchAdjustments,
    },
  };
}

// =============================================================
// NARRATIVE HELPER
// =============================================================

/**
 * Build a UI-ready narrative string describing the environmental impact.
 * Returns null when the environment is essentially neutral (no narrative needed).
 *
 * @param {number} density - air density ratio
 * @param {Array} arsenal - pitcher's arsenal (to identify dominant pitch type)
 * @param {Object} airAudit - audit from computeAirDensity (used for dome flag)
 * @returns {string|null}
 */
function getEnvironmentNarrative(density, arsenal, airAudit = {}) {
  const delta = density - 1.0;

  // Find dominant pitch type (highest usage)
  let dominant = null;
  let maxPitches = 0;
  for (const pitch of (arsenal || [])) {
    const p = pitch.pitches || 0;
    if (p > maxPitches) {
      maxPitches = p;
      dominant = pitch.pitchType || pitch.type;
    }
  }

  const dominantSensitivity = getSensitivity(dominant);

  // Dome: small stabilization narrative
  if (airAudit.closed) {
    return `Dome environment — stable conditions; pitcher repeatability holds.`;
  }

  // High-altitude thin air
  if (delta <= -0.10) {
    if (dominantSensitivity >= 0.7) {
      return `Thin air (density ${(density*100).toFixed(1)}% of sea level) hurts ${describePitch(dominant)} movement — expect inflated xwOBA on Magnus-dependent pitches.`;
    } else {
      return `Thin air (density ${(density*100).toFixed(1)}% of sea level) — but ${describePitch(dominant)}-led arsenal partially holds up vs the altitude.`;
    }
  }

  // Moderately reduced density (hot/humid open air)
  if (delta <= -0.03) {
    if (dominantSensitivity >= 0.7) {
      return `Reduced air density (${(density*100).toFixed(1)}%) — mild movement loss on ${describePitch(dominant)}.`;
    }
    return null; // small delta + command-based pitcher: no narrative
  }

  // Denser-than-normal air (cold game)
  if (delta >= 0.02) {
    return `Dense air (${(density*100).toFixed(1)}% of sea level) — slight movement boost.`;
  }

  return null;
}

function describePitch(pitchType) {
  if (!pitchType) return 'pitch';
  const key = String(pitchType).toUpperCase().trim();
  const labels = {
    'FF': 'four-seam', 'FOUR_SEAM': 'four-seam',
    'CU': 'curveball', 'CURVE': 'curveball', 'KC': 'knuckle-curve',
    'SL': 'slider', 'SLIDER': 'slider',
    'ST': 'sweeper', 'SWEEPER': 'sweeper',
    'CH': 'changeup', 'CHANGEUP': 'changeup',
    'FS': 'splitter', 'SPLIT': 'splitter',
    'FC': 'cutter', 'CUTTER': 'cutter',
    'SI': 'sinker', 'SINKER': 'sinker',
    'FT': 'two-seam', 'TWO_SEAM': 'two-seam',
  };
  return labels[key] || key.toLowerCase();
}

// =============================================================
// UTILITIES
// =============================================================

function round3(x) { return Math.round(x * 1000) / 1000; }
function round4(x) { return Math.round(x * 10000) / 10000; }

export {
  computeAirDensity,
  adjustPitcherArsenal,
  getEnvironmentNarrative,
  // exported for tests + tuning
  PARK_AIR_PROFILES,
  PITCH_TYPE_SENSITIVITY,
  MAGNITUDE_SCALE,
  getSensitivity,
};
