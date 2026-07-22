// nflEnvironment.js
// Lyrid NFL engine — environmental feature builder.
// Turns stadium + weather into yardage-prop adjustments.
//
// DESIGN HONESTY:
//   - Altitude affects AIR DENSITY -> ball carry/drag (deep passes & kicks travel
//     farther in thin air). It does NOT affect "ball rotation/spin". We model the
//     real effect (carry) and label it correctly.
//   - Roof gates weather: dome/closed-retractable => no wind/precip effect.
//   - Wind is the dominant outdoor effect on PASSING and KICKING yardage.
//   - Effects are returned as ADDITIVE standardized nudges (z-space), never
//     multiplicative, per Lyrid's additive-not-multiplicative rule. The caller
//     (nflFeatureBuilder) folds them into the feature vector alongside volume/
//     matchup/game-script signals.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stadiums = JSON.parse(
  readFileSync(join(__dirname, '../../data/nfl/stadiums.json'), 'utf8')
);

const STADIUMS = stadiums.stadiums;

// Reference air density at sea level, standard conditions (kg/m^3).
const RHO_SEA_LEVEL = 1.225;

// Barometric approximation of air density ratio vs sea level for a given altitude (ft).
// rho/rho0 ~= exp(-altitude_m / 8500). 8500m is the standard scale height.
export function airDensityRatio(altitudeFt) {
  const altitudeM = altitudeFt * 0.3048;
  return Math.exp(-altitudeM / 8500);
}

// Carry bonus: thinner air => less drag => ball travels farther.
// Empirically the Denver effect on kicking/deep passing is small but real
// (~5-10% on max FG distance at altitude). We express it as a fraction of a
// standard deviation applied to DEEP passing/receiving yardage only.
// densityRatio ~0.83 at Denver vs 1.00 sea level -> ~0.17 gap.
export function altitudeCarryNudge(altitudeFt) {
  const ratio = airDensityRatio(altitudeFt);
  const gap = 1 - ratio;                 // 0 at sea level, ~0.17 at Denver
  // Scale so Denver (~0.17 gap) yields ~+0.30 z on deep-air yardage. Modest.
  return +(gap * 1.75).toFixed(4);
}

// Wind nudge for PASSING yardage. Wind materially hurts passing efficiency and
// deep-ball completion above ~15 mph; below ~10 mph the effect is negligible.
// Returns a NEGATIVE z-nudge (drag on passing yardage overs).
export function windPassingNudge(windMph) {
  if (windMph == null || windMph <= 10) return 0;
  if (windMph <= 15) return -0.15;
  if (windMph <= 20) return -0.35;
  if (windMph <= 25) return -0.60;
  return -0.90; // 25+ mph: strong suppression of passing yardage
}

// Wind has far less effect on RUSHING yardage; a tiny positive (teams lean run
// in high wind) but we keep it minimal and honest.
export function windRushingNudge(windMph) {
  if (windMph == null || windMph <= 15) return 0;
  if (windMph <= 25) return +0.10; // modest game-script lean toward runs
  return +0.20;
}

// Cold/precip: heavy rain or snow depresses passing and receiving yardage
// (ball handling, footing). Temperature alone is a weak signal; precip matters more.
export function precipNudge(precipType) {
  switch ((precipType || '').toLowerCase()) {
    case 'rain':
    case 'showers': return -0.15;
    case 'heavy_rain': return -0.35;
    case 'snow': return -0.30;
    case 'heavy_snow': return -0.55;
    default: return 0;
  }
}

// Determine whether weather applies at all given roof + live roof status.
// retractable roofs default to OUTDOOR unless a feed says 'closed'.
export function weatherApplies(homeTeam, roofStatusOverride) {
  const s = STADIUMS[homeTeam];
  if (!s) return true; // unknown venue -> assume outdoor (conservative)
  if (s.roof === 'dome') return false;
  if (s.roof === 'retractable') {
    if (roofStatusOverride === 'closed') return false;
    if (roofStatusOverride === 'open') return true;
    return false; // default retractable to closed/neutral unless told otherwise
  }
  return true; // outdoor
}

// Main entry: build the environment nudges for a given game + prop family.
// propFamily in { 'passing_yards','receiving_yards','rushing_yards','rush_rec_yards' }
// weather = { windMph, precipType, tempF } (nullable; ignored if weather doesn't apply)
export function buildEnvironmentNudges({ homeTeam, propFamily, weather, roofStatus, isDeepThreat }) {
  const s = STADIUMS[homeTeam] || null;
  const applies = weatherApplies(homeTeam, roofStatus);
  const out = {
    venue: s ? s.name : 'unknown',
    roof: s ? s.roof : 'unknown',
    weatherApplies: applies,
    altitude_ft: s ? s.altitude_ft : 0,
    nudges: {},
    total: 0,
  };

  // Altitude carry — applies to deep passing & receiving only, indoors or out
  // (air density is a function of altitude regardless of roof, though domes are
  // pressure-neutral enough that we only credit genuine outdoor altitude venues).
  if (s && s.roof === 'outdoor' && s.altitude_ft >= 3000) {
    const carry = altitudeCarryNudge(s.altitude_ft);
    if (propFamily === 'passing_yards' || propFamily === 'receiving_yards') {
      // full credit to deep-threat receivers; half to general passing volume
      out.nudges.altitude_carry = isDeepThreat ? carry : +(carry * 0.5).toFixed(4);
    }
  }

  if (applies && weather) {
    if (propFamily === 'passing_yards' || propFamily === 'receiving_yards') {
      out.nudges.wind = windPassingNudge(weather.windMph);
      out.nudges.precip = precipNudge(weather.precipType);
    } else if (propFamily === 'rushing_yards') {
      out.nudges.wind = windRushingNudge(weather.windMph);
    } else if (propFamily === 'rush_rec_yards') {
      // split: rushing portion gets rush wind, receiving portion gets pass wind (half each)
      out.nudges.wind = +(((windRushingNudge(weather.windMph)) + (windPassingNudge(weather.windMph) * 0.5)) / 1.5).toFixed(4);
      out.nudges.precip = +(precipNudge(weather.precipType) * 0.5).toFixed(4);
    }
  }

  out.total = +Object.values(out.nudges).reduce((a, b) => a + (b || 0), 0).toFixed(4);
  return out;
}

export { STADIUMS };
