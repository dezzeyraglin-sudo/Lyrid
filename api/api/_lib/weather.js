// api/_lib/weather.js
// Fetches weather forecast for a ballpark at game time, computes wind-relative-to-field.
// Open-Meteo free API (no key, no rate limit for low volume).

const weatherCache = new Map();  // key: `${lat.toFixed(2)}-${lng.toFixed(2)}-${dateHour}`, val: { timestamp, data }
const CACHE_TTL = 30 * 60 * 1000;  // 30 min

/**
 * Fetch weather forecast at a given location & first-pitch ET time.
 * @param {number} lat
 * @param {number} lng
 * @param {string} gameDateET  YYYY-MM-DD
 * @param {string} gameTime    e.g. "7:05 PM ET"
 * @returns {Promise<Object|null>} { tempF, windSpeedMph, windDirDeg, precipMm, humidity, conditions } or null
 */
export async function getWeatherForecast(lat, lng, gameDateET, gameTime) {
  if (!lat || !lng) return null;

  // Parse game time to ET hour
  const etHour = parseGameTimeToHour(gameTime);
  if (etHour === null) return null;

  const cacheKey = `${lat.toFixed(2)}-${lng.toFixed(2)}-${gameDateET}-${etHour}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  // Open-Meteo forecast endpoint
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lng}` +
    `&hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,cloud_cover` +
    `&timezone=America/New_York` +
    `&temperature_unit=fahrenheit` +
    `&wind_speed_unit=mph` +
    `&precipitation_unit=inch` +
    `&forecast_days=7`;

  let json;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    json = await res.json();
  } catch (err) {
    console.warn('Weather fetch failed:', err.message);
    return null;
  }

  if (!json?.hourly?.time) return null;

  // Find the hour index matching our game time
  const targetISO = `${gameDateET}T${String(etHour).padStart(2, '0')}:00`;
  const hourlyTimes = json.hourly.time;
  let idx = hourlyTimes.findIndex(t => t === targetISO);
  if (idx < 0) {
    // Fallback: nearest available hour on same date
    idx = hourlyTimes.findIndex(t => t.startsWith(gameDateET) && parseInt(t.split('T')[1]) >= etHour);
    if (idx < 0) return null;
  }

  const weather = {
    tempF: json.hourly.temperature_2m[idx],
    humidity: json.hourly.relative_humidity_2m[idx],
    precipIn: json.hourly.precipitation[idx],
    windSpeedMph: json.hourly.wind_speed_10m[idx],
    windGustsMph: json.hourly.wind_gusts_10m[idx],
    windDirDeg: json.hourly.wind_direction_10m[idx],    // compass bearing wind is FROM, in degrees
    weatherCode: json.hourly.weather_code[idx],
    cloudCover: json.hourly.cloud_cover[idx],
    conditions: wmoCodeToText(json.hourly.weather_code[idx]),
    timestamp: targetISO,
    fetchedAt: Date.now()
  };

  weatherCache.set(cacheKey, { timestamp: Date.now(), data: weather });
  return weather;
}

/**
 * Convert raw wind direction (compass) to field-relative direction
 * given the park's home-plate-to-center-field bearing.
 *
 * @param {number} windDirDeg  direction wind is FROM (0-360)
 * @param {number} parkBearing compass bearing from home plate toward CF (0-360)
 * @returns {Object} { relativeDeg, category, symbol }
 *
 * Categories:
 *   OUT_TO_CF   (wind blowing toward CF — helps fly balls to CF)
 *   OUT_TO_LF   (wind blowing toward LF — big HR boost for RHB pull)
 *   OUT_TO_RF   (wind blowing toward RF — big HR boost for LHB pull)
 *   IN_FROM_CF  (wind blowing in from CF toward home plate — suppresses fly balls)
 *   IN_FROM_LF  (wind blowing in from LF — suppresses RHB pull HRs)
 *   IN_FROM_RF  (wind blowing in from RF — suppresses LHB pull HRs)
 *   CROSS_LTR   (wind blowing left-to-right across field)
 *   CROSS_RTL   (wind blowing right-to-left across field)
 */
export function windRelativeToField(windDirDeg, parkBearing) {
  if (windDirDeg == null || parkBearing == null) return null;
  // Wind direction in meteorology is "FROM" — convert to "TOWARD" by adding 180
  const windToward = (windDirDeg + 180) % 360;
  // Angle of wind-toward relative to CF bearing (0 = blowing straight out to CF)
  let rel = (windToward - parkBearing + 360) % 360;
  if (rel > 180) rel -= 360;   // normalize to [-180, 180]

  // Categorize (each outfield wedge is ~30° wide; infield wedges ~30° on each side)
  let category, symbol;
  const absRel = Math.abs(rel);
  if (absRel <= 22) { category = 'OUT_TO_CF'; symbol = '↑'; }
  else if (absRel >= 158) { category = 'IN_FROM_CF'; symbol = '↓'; }
  else if (rel < 0 && rel > -68) { category = 'OUT_TO_LF'; symbol = '↖'; }     // wind toward LF
  else if (rel > 0 && rel < 68) { category = 'OUT_TO_RF'; symbol = '↗'; }       // wind toward RF
  else if (rel <= -68 && rel >= -112) { category = 'CROSS_RTL'; symbol = '←'; } // right-to-left cross
  else if (rel >= 68 && rel <= 112) { category = 'CROSS_LTR'; symbol = '→'; }   // left-to-right cross
  else if (rel < -112) { category = 'IN_FROM_LF'; symbol = '↘'; }               // wind blowing in from LF
  else { category = 'IN_FROM_RF'; symbol = '↙'; }                               // wind blowing in from RF

  return { relativeDeg: Math.round(rel), category, symbol };
}

/**
 * Compute HR multiplier and run multiplier from weather + field-relative wind.
 * Calibrated from:
 *   - Rotogrinders/Baseball Reference study: wind out to LF = +5.8% runs, +7.6% HRs
 *   - 16+ mph out to LF = +10.7% HRs
 *   - Statcast: wind can shift ball ±50 ft
 *   - Temperature: ~3-4 ft per 10°F above 70°F (ball carry, Alan Nathan physics)
 *
 * @param {Object} weather      { tempF, windSpeedMph, windDirDeg, humidity, precipIn }
 * @param {Object} parkWindProfile { bearing, roofType, exposure (0.7-1.5) }
 * @returns {Object} {
 *   runMult,                 overall run environment multiplier (applied game-wide)
 *   hrMultLHH,               HR multiplier for left-handed hitters
 *   hrMultRHH,               HR multiplier for right-handed hitters
 *   windRelative,            { relativeDeg, category, symbol }
 *   narrative,               string[] of reasons for the multipliers
 *   isDome                   true if dome is closed, no weather effect
 * }
 */
export function computeWeatherImpact(weather, parkWindProfile) {
  const result = {
    runMult: 1.0,
    hrMultLHH: 1.0,
    hrMultRHH: 1.0,
    windRelative: null,
    narrative: [],
    isDome: false,
    tempF: weather?.tempF,
    windSpeedMph: weather?.windSpeedMph,
    conditions: weather?.conditions
  };

  // Domes with closed roof = no weather effect at all
  if (parkWindProfile?.roofType === 'fixed-dome') {
    result.isDome = true;
    result.narrative.push('Fixed dome — no weather factors');
    return result;
  }
  // Retractable domes: assume closed if rain or cold. Imperfect but better than nothing.
  if (parkWindProfile?.roofType === 'retractable') {
    const likelyClosed = (weather?.precipIn || 0) >= 0.05 || (weather?.tempF || 70) <= 55;
    if (likelyClosed) {
      result.isDome = true;
      result.narrative.push('Retractable roof likely closed (rain/cold) — neutral weather');
      return result;
    } else {
      result.narrative.push('Retractable roof likely open');
    }
  }

  if (!weather || weather.tempF == null) return result;

  // ---- TEMPERATURE EFFECT ----
  // Baseline 70°F. Every 10°F above adds ~3-4 feet to fly balls (Alan Nathan physics).
  // Translate to multipliers: +1% HRs per 10°F above 70, -1.5% per 10°F below 60
  const tempDelta = weather.tempF - 70;
  if (tempDelta >= 10) {
    const tempBoost = Math.min(0.10, (tempDelta / 10) * 0.012);  // cap at +10%
    result.hrMultLHH *= (1 + tempBoost);
    result.hrMultRHH *= (1 + tempBoost);
    result.runMult *= (1 + tempBoost * 0.5);
    if (weather.tempF >= 85) result.narrative.push(`Hot day (${Math.round(weather.tempF)}°F) — ball carries further (+${(tempBoost*100).toFixed(1)}% HRs)`);
    else result.narrative.push(`Warm (${Math.round(weather.tempF)}°F) — modest carry boost`);
  } else if (tempDelta <= -10) {
    const tempPenalty = Math.min(0.10, Math.abs(tempDelta / 10) * 0.015);
    result.hrMultLHH *= (1 - tempPenalty);
    result.hrMultRHH *= (1 - tempPenalty);
    result.runMult *= (1 - tempPenalty * 0.5);
    if (weather.tempF <= 45) result.narrative.push(`Cold (${Math.round(weather.tempF)}°F) — ball dies in the air (-${(tempPenalty*100).toFixed(1)}% HRs)`);
    else result.narrative.push(`Cool (${Math.round(weather.tempF)}°F) — slight carry penalty`);
  }

  // ---- WIND EFFECT ----
  const speed = weather.windSpeedMph || 0;
  const exposure = parkWindProfile?.exposure || 1.0;
  const bearing = parkWindProfile?.bearing;

  if (bearing != null && speed >= 3) {
    const rel = windRelativeToField(weather.windDirDeg, bearing);
    result.windRelative = rel;

    // Base impact scales with (speed * exposure). At 15mph, baseline is 7.6% HR boost out to LF.
    // Use: impact = min(0.15, speed * 0.005) * exposure  → at 15mph, 7.5% * exposure
    const baseImpact = Math.min(0.15, speed * 0.005) * exposure;

    switch (rel.category) {
      case 'OUT_TO_CF':
        result.hrMultLHH *= (1 + baseImpact * 0.6);    // out to CF = ~60% of LF-boost magnitude
        result.hrMultRHH *= (1 + baseImpact * 0.6);
        result.runMult *= (1 + baseImpact * 0.4);
        result.narrative.push(`Wind ${rel.symbol} out to CF at ${Math.round(speed)}mph — fly balls carry (+${(baseImpact*60).toFixed(1)}% HRs)`);
        break;
      case 'OUT_TO_LF':
        result.hrMultRHH *= (1 + baseImpact * 1.2);    // RHH pull boost
        result.hrMultLHH *= (1 + baseImpact * 0.4);
        result.runMult *= (1 + baseImpact * 0.7);
        result.narrative.push(`Wind ${rel.symbol} out to LF at ${Math.round(speed)}mph — RHH power boost (+${(baseImpact*120).toFixed(1)}% HRs for RHH)`);
        break;
      case 'OUT_TO_RF':
        result.hrMultLHH *= (1 + baseImpact * 1.2);    // LHH pull boost
        result.hrMultRHH *= (1 + baseImpact * 0.4);
        result.runMult *= (1 + baseImpact * 0.7);
        result.narrative.push(`Wind ${rel.symbol} out to RF at ${Math.round(speed)}mph — LHH power boost (+${(baseImpact*120).toFixed(1)}% HRs for LHH)`);
        break;
      case 'IN_FROM_CF':
        result.hrMultLHH *= (1 - baseImpact * 0.7);
        result.hrMultRHH *= (1 - baseImpact * 0.7);
        result.runMult *= (1 - baseImpact * 0.5);
        result.narrative.push(`Wind ${rel.symbol} IN from CF at ${Math.round(speed)}mph — suppresses fly balls (-${(baseImpact*70).toFixed(1)}% HRs)`);
        break;
      case 'IN_FROM_LF':
        result.hrMultRHH *= (1 - baseImpact * 1.0);
        result.hrMultLHH *= (1 - baseImpact * 0.3);
        result.runMult *= (1 - baseImpact * 0.4);
        result.narrative.push(`Wind ${rel.symbol} IN from LF at ${Math.round(speed)}mph — kills RHH pull HRs (-${(baseImpact*100).toFixed(1)}%)`);
        break;
      case 'IN_FROM_RF':
        result.hrMultLHH *= (1 - baseImpact * 1.0);
        result.hrMultRHH *= (1 - baseImpact * 0.3);
        result.runMult *= (1 - baseImpact * 0.4);
        result.narrative.push(`Wind ${rel.symbol} IN from RF at ${Math.round(speed)}mph — kills LHH pull HRs (-${(baseImpact*100).toFixed(1)}%)`);
        break;
      case 'CROSS_LTR':
      case 'CROSS_RTL':
        // Cross winds push balls foul one way, helping the opposite-side hitters marginally
        result.narrative.push(`Crosswind ${rel.symbol} at ${Math.round(speed)}mph — minimal HR impact`);
        break;
    }
  } else if (speed < 3) {
    result.narrative.push(`Light wind (${Math.round(speed)}mph) — minimal impact`);
  }

  // ---- PRECIPITATION ----
  if ((weather.precipIn || 0) >= 0.05 && parkWindProfile?.roofType !== 'fixed-dome') {
    result.narrative.push(`Precipitation expected (${weather.precipIn.toFixed(2)}" )  — possible delay/dampened conditions`);
    result.runMult *= 0.97;  // wet balls don't travel as well
  }

  // ---- HUMIDITY (small effect) ----
  if (weather.humidity != null && weather.humidity >= 85 && weather.tempF >= 75) {
    // Hot + humid = heavy, wet air = ball doesn't carry as well
    result.hrMultLHH *= 0.98;
    result.hrMultRHH *= 0.98;
    result.narrative.push(`Humid (${Math.round(weather.humidity)}%) — thick air slightly suppresses HRs`);
  }

  return result;
}

// ---- HELPERS ----

// Parse "7:05 PM ET" or "1:20 PM ET" into hour 0-23
function parseGameTimeToHour(gameTime) {
  if (!gameTime) return null;
  const m = gameTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h;
}

// WMO weather code to text (Open-Meteo spec)
function wmoCodeToText(code) {
  const codes = {
    0: 'Clear', 1: 'Mostly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime Fog',
    51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle',
    61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain',
    71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow',
    80: 'Light Showers', 81: 'Showers', 82: 'Heavy Showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ Hail', 99: 'Heavy Thunderstorm'
  };
  return codes[code] || 'Unknown';
}
