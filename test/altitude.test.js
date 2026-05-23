/**
 * Tests for altitudeEngine.js
 *
 * Coverage:
 *  - Air density: Coors (~0.82), sea-level (~1.0), dome stabilization, hot park
 *  - Per-pitch sensitivity: 4-seam (high), sinker (low), curveball (high)
 *  - Arsenal adjustment: total xwOBA shift on Coors-heavy four-seamer vs sinker
 *  - Narratives: triggered at the right thresholds
 *  - Edge cases: unknown park, missing weather, empty arsenal
 *
 * Run with: node test/altitude.test.js
 */

import assert from 'assert';
import {
  computeAirDensity,
  adjustPitcherArsenal,
  getEnvironmentNarrative,
  getSensitivity,
  PARK_AIR_PROFILES,
  PITCH_TYPE_SENSITIVITY,
} from '../api/_lib/baseball/altitudeEngine.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    if (e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  }
}
function suite(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ============================================================================
// Air density computation
// ============================================================================

suite('computeAirDensity: park-specific baselines', () => {
  test('Coors Field produces meaningfully thin air (~0.82)', () => {
    const { density, audit } = computeAirDensity('COL', { temp_f: 72, humidity: 0.32 });
    assert.ok(audit.profileFound, 'COL profile should be found');
    assert.ok(density < 0.85, `Coors density should be < 0.85, got ${density}`);
    assert.ok(density > 0.80, `Coors density should be > 0.80, got ${density}`);
  });

  test('Sea-level Boston produces density very close to 1.0 at typical conditions', () => {
    const { density } = computeAirDensity('BOS', { temp_f: 68, humidity: 0.62 });
    assert.ok(Math.abs(density - 1.0) < 0.005, `BOS at typical conditions should be ~1.0, got ${density}`);
  });

  test('Hot day in Texas reduces density meaningfully', () => {
    const { density } = computeAirDensity('TEX', { temp_f: 100, humidity: 0.45, isDome: false });
    // typical 86F, hot game at 100F adds ~2.8% more drop on top of 0.972 base
    assert.ok(density < 0.965, `Hot TEX should be < 0.965, got ${density}`);
  });

  test('Cool day at the same park reverses the temp effect', () => {
    const hot = computeAirDensity('TEX', { temp_f: 100, humidity: 0.55, isDome: false }).density;
    const cold = computeAirDensity('TEX', { temp_f: 60, humidity: 0.55, isDome: false }).density;
    assert.ok(cold > hot, `Cold day (${cold}) should be denser than hot day (${hot})`);
  });
});

suite('computeAirDensity: dome handling', () => {
  test('Tropicana dome ignores outside weather entirely', () => {
    // If the dome is closed, outside 100°F shouldn't matter
    const tampaHot = computeAirDensity('TB', { temp_f: 100, humidity: 0.85, isDome: true });
    const tampaCold = computeAirDensity('TB', { temp_f: 40, humidity: 0.20, isDome: true });
    assert.strictEqual(tampaHot.density, tampaCold.density, 'Dome should ignore weather');
    assert.ok(tampaHot.audit.closed, 'audit should flag closed');
  });

  test('Retractable roof CLOSED behaves like dome', () => {
    const result = computeAirDensity('TOR', { temp_f: 100, humidity: 0.85, isDome: true });
    assert.ok(result.audit.closed, 'Closed retractable should be flagged as closed');
    // density_base for TOR is 0.992 — should be used directly
    assert.strictEqual(result.density, 0.992);
  });

  test('Retractable roof OPEN responds to weather', () => {
    const hot = computeAirDensity('TOR', { temp_f: 95, humidity: 0.50, isDome: false }).density;
    const cool = computeAirDensity('TOR', { temp_f: 65, humidity: 0.50, isDome: false }).density;
    assert.ok(cool > hot, 'Open retractable should respond to temp');
  });
});

suite('computeAirDensity: edge cases', () => {
  test('Unknown park falls back to 1.0 with audit flag', () => {
    const { density, audit } = computeAirDensity('XXX', { temp_f: 72, humidity: 0.5 });
    assert.strictEqual(density, 1.0);
    assert.ok(audit.fallback === 'unknown_park_sea_level_default');
  });

  test('Missing weather uses park base density', () => {
    const { density } = computeAirDensity('COL', {});
    // No weather adjustments; should equal density_base = 0.825
    assert.strictEqual(density, 0.825);
  });

  test('Team alias resolution: TBR/WSH/CHW/etc all map correctly', () => {
    // These aliases should produce identical results to their primary code
    const tb = computeAirDensity('TB', { isDome: true });
    const tbr = computeAirDensity('TBR', { isDome: true });
    assert.strictEqual(tb.density, tbr.density, 'TB and TBR should match');

    const sf = computeAirDensity('SF', {});
    const sfg = computeAirDensity('SFG', {});
    assert.strictEqual(sf.density, sfg.density, 'SF and SFG should match');
  });
});

// ============================================================================
// Pitch sensitivity lookup
// ============================================================================

suite('getSensitivity: pitch type lookups', () => {
  test('4-seam has highest sensitivity (1.0)', () => {
    assert.strictEqual(getSensitivity('FF'), 1.0);
    assert.strictEqual(getSensitivity('FOUR_SEAM'), 1.0);
  });

  test('Sinker has low sensitivity (~0.3)', () => {
    assert.strictEqual(getSensitivity('SI'), 0.3);
    assert.strictEqual(getSensitivity('SINKER'), 0.3);
  });

  test('Cutter has low sensitivity (~0.35)', () => {
    assert.strictEqual(getSensitivity('FC'), 0.35);
  });

  test('Sweeper distinguished from slider (sweepers more sensitive)', () => {
    const slider = getSensitivity('SL');
    const sweeper = getSensitivity('ST');
    assert.ok(sweeper > slider, 'Sweepers (ST) should be more sensitive than sliders (SL)');
  });

  test('Curveball has high sensitivity (depth lost in thin air)', () => {
    assert.strictEqual(getSensitivity('CU'), 0.85);
  });

  test('Case insensitive', () => {
    assert.strictEqual(getSensitivity('ff'), getSensitivity('FF'));
    assert.strictEqual(getSensitivity('Sinker'), getSensitivity('SINKER'));
  });

  test('Unknown pitch type returns default (moderate)', () => {
    const unknown = getSensitivity('XYZ');
    assert.strictEqual(unknown, PITCH_TYPE_SENSITIVITY._default);
  });

  test('Null/undefined returns default', () => {
    assert.strictEqual(getSensitivity(null), PITCH_TYPE_SENSITIVITY._default);
    assert.strictEqual(getSensitivity(undefined), PITCH_TYPE_SENSITIVITY._default);
  });
});

// ============================================================================
// Arsenal adjustment — the math that affects pitcherMult
// ============================================================================

suite('adjustPitcherArsenal: Coors Field cases', () => {
  test('4-seam-heavy pitcher at Coors: significant xwOBA inflation', () => {
    const arsenal = [
      { pitchType: 'FF', xwoba: 0.300, pitches: 600 },
      { pitchType: 'SL', xwoba: 0.290, pitches: 200 },
      { pitchType: 'CH', xwoba: 0.280, pitches: 100 },
    ];
    const { adjustedArsenal, audit } = adjustPitcherArsenal(arsenal, 0.825);

    const fourSeam = adjustedArsenal.find(p => p.pitchType === 'FF');
    // densityDelta = -0.175, sensitivity 1.0, scale 0.40
    // xwobaShift = -1.0 × -0.175 × 0.40 = +0.070
    assert.ok(fourSeam.xwoba > 0.365, `4-seam should inflate significantly, got ${fourSeam.xwoba}`);
    assert.strictEqual(fourSeam.originalXwoba, 0.300);
    assert.ok(fourSeam.altitudeAdjustment > 0.06);
  });

  test('Sinker-heavy command pitcher at Coors: modest adjustment', () => {
    const arsenal = [
      { pitchType: 'SI', xwoba: 0.300, pitches: 500 },
      { pitchType: 'FC', xwoba: 0.290, pitches: 250 },
      { pitchType: 'CH', xwoba: 0.310, pitches: 150 },
    ];
    const { adjustedArsenal } = adjustPitcherArsenal(arsenal, 0.825);

    const sinker = adjustedArsenal.find(p => p.pitchType === 'SI');
    // densityDelta = -0.175, sensitivity 0.30, scale 0.40
    // xwobaShift = -0.30 × -0.175 × 0.40 = +0.021
    assert.ok(sinker.xwoba > 0.310 && sinker.xwoba < 0.330, `Sinker should inflate modestly, got ${sinker.xwoba}`);

    const cutter = adjustedArsenal.find(p => p.pitchType === 'FC');
    // sensitivity 0.35
    assert.ok(cutter.xwoba > 0.295 && cutter.xwoba < 0.320, `Cutter should inflate modestly, got ${cutter.xwoba}`);
  });

  test('Sinker pitcher at Coors fares meaningfully better than 4-seam pitcher', () => {
    const fourSeamHeavy = [{ pitchType: 'FF', xwoba: 0.290, pitches: 700 }];
    const sinkerHeavy = [{ pitchType: 'SI', xwoba: 0.290, pitches: 700 }];

    const ff = adjustPitcherArsenal(fourSeamHeavy, 0.825).adjustedArsenal[0];
    const si = adjustPitcherArsenal(sinkerHeavy, 0.825).adjustedArsenal[0];

    assert.ok(ff.xwoba > si.xwoba + 0.04, `4-seam (${ff.xwoba}) should be much worse than sinker (${si.xwoba}) at Coors`);
  });

  test('Curveball-heavy pitcher at Coors: depth loss penalty', () => {
    const arsenal = [{ pitchType: 'CU', xwoba: 0.250, pitches: 500 }];
    const { adjustedArsenal } = adjustPitcherArsenal(arsenal, 0.825);
    // sensitivity 0.85, shift = +0.0595
    assert.ok(adjustedArsenal[0].xwoba > 0.305, `Curveball should inflate at Coors, got ${adjustedArsenal[0].xwoba}`);
  });
});

suite('adjustPitcherArsenal: sea-level and edge cases', () => {
  test('Sea-level density skips adjustment entirely (no noise)', () => {
    const arsenal = [
      { pitchType: 'FF', xwoba: 0.300, pitches: 500 },
      { pitchType: 'SL', xwoba: 0.290, pitches: 200 },
    ];
    const { adjustedArsenal, audit } = adjustPitcherArsenal(arsenal, 1.000);
    assert.strictEqual(adjustedArsenal[0].xwoba, 0.300, 'Should not adjust at sea level');
    assert.ok(audit.reason && audit.reason.includes('near_sea_level'));
  });

  test('Tiny density deviation (within 1%) does not trigger adjustment', () => {
    const arsenal = [{ pitchType: 'FF', xwoba: 0.300, pitches: 500 }];
    const { adjustedArsenal, audit } = adjustPitcherArsenal(arsenal, 1.008);
    assert.strictEqual(adjustedArsenal[0].xwoba, 0.300);
    assert.ok(audit.reason.includes('near_sea_level'));
  });

  test('Dense air (>1.02) does trigger a small favorable adjustment', () => {
    // A cold game in SF (density ~1.03 with cold + humid)
    const arsenal = [{ pitchType: 'FF', xwoba: 0.300, pitches: 500 }];
    const { adjustedArsenal } = adjustPitcherArsenal(arsenal, 1.030);
    // densityDelta = +0.030, shift = -0.012 (favorable to pitcher)
    assert.ok(adjustedArsenal[0].xwoba < 0.295, `Dense air should help pitcher, got ${adjustedArsenal[0].xwoba}`);
  });

  test('Empty arsenal handled gracefully', () => {
    const { adjustedArsenal, audit } = adjustPitcherArsenal([], 0.825);
    assert.strictEqual(adjustedArsenal.length, 0);
    assert.ok(audit.reason === 'no_arsenal');
  });

  test('Null arsenal handled gracefully', () => {
    const { adjustedArsenal, audit } = adjustPitcherArsenal(null, 0.825);
    assert.deepStrictEqual(adjustedArsenal, []);
    assert.ok(audit.reason === 'no_arsenal');
  });

  test('Original xwoba preserved for diagnostics', () => {
    const arsenal = [{ pitchType: 'FF', xwoba: 0.310, pitches: 500 }];
    const { adjustedArsenal } = adjustPitcherArsenal(arsenal, 0.825);
    assert.strictEqual(adjustedArsenal[0].originalXwoba, 0.310);
  });

  test('Per-pitch audit emitted with shift breakdown', () => {
    const arsenal = [
      { pitchType: 'FF', xwoba: 0.300, pitches: 500 },
      { pitchType: 'SI', xwoba: 0.310, pitches: 200 },
    ];
    const { audit } = adjustPitcherArsenal(arsenal, 0.825);
    assert.strictEqual(audit.perPitchAdjustments.length, 2);
    assert.ok(audit.perPitchAdjustments[0].sensitivity === 1.0);
    assert.ok(audit.perPitchAdjustments[1].sensitivity === 0.3);
  });
});

// ============================================================================
// Narratives
// ============================================================================

suite('getEnvironmentNarrative', () => {
  test('Coors + 4-seam-heavy arsenal produces thin-air warning', () => {
    const arsenal = [
      { pitchType: 'FF', xwoba: 0.300, pitches: 600 },
      { pitchType: 'SL', xwoba: 0.290, pitches: 200 },
    ];
    const narrative = getEnvironmentNarrative(0.825, arsenal, { closed: false });
    assert.ok(narrative, 'Should produce a narrative');
    assert.ok(narrative.toLowerCase().includes('thin air'));
    assert.ok(narrative.toLowerCase().includes('four-seam'));
  });

  test('Coors + sinker-heavy arsenal produces softer narrative', () => {
    const arsenal = [
      { pitchType: 'SI', xwoba: 0.300, pitches: 500 },
      { pitchType: 'FC', xwoba: 0.290, pitches: 200 },
    ];
    const narrative = getEnvironmentNarrative(0.825, arsenal, { closed: false });
    assert.ok(narrative);
    assert.ok(narrative.toLowerCase().includes('partially holds up') || narrative.toLowerCase().includes('sinker'));
  });

  test('Dome produces stabilization narrative', () => {
    const arsenal = [{ pitchType: 'FF', xwoba: 0.300, pitches: 500 }];
    const narrative = getEnvironmentNarrative(0.995, arsenal, { closed: true });
    assert.ok(narrative);
    assert.ok(narrative.toLowerCase().includes('dome'));
  });

  test('Sea level open air produces no narrative (avoids noise)', () => {
    const arsenal = [{ pitchType: 'FF', xwoba: 0.300, pitches: 500 }];
    const narrative = getEnvironmentNarrative(1.000, arsenal, { closed: false });
    assert.strictEqual(narrative, null);
  });

  test('Modestly reduced density + Magnus pitcher: narrative fires', () => {
    const arsenal = [{ pitchType: 'CU', xwoba: 0.260, pitches: 400 }];
    const narrative = getEnvironmentNarrative(0.96, arsenal, { closed: false });
    assert.ok(narrative);
    assert.ok(narrative.toLowerCase().includes('movement') || narrative.toLowerCase().includes('density'));
  });
});

// ============================================================================
// Sanity calibration tests — the numbers should match research expectations
// ============================================================================

suite('Calibration: published research benchmarks', () => {
  test('MLB published "Coors 4-seam at 81% of sea-level rise" — our 4-seam Magnus loss is consistent', () => {
    // The research said 4-seam carry at Coors is ~81% of sea level (~19% Magnus loss).
    // Our model gives a +0.070 xwOBA shift on a 4-seamer at Coors density 0.825.
    // For a baseline .300 xwOBA pitcher, that's a 23% relative increase. That's
    // bigger than the published Magnus loss because xwOBA captures more than just
    // raw movement (it also captures hitters' ability to square up the pitch).
    // The ratio of pitch-effectiveness loss : raw-movement loss should be ~1.0-1.3.
    const arsenal = [{ pitchType: 'FF', xwoba: 0.300, pitches: 700 }];
    const { adjustedArsenal } = adjustPitcherArsenal(arsenal, 0.825);
    const relativeIncrease = (adjustedArsenal[0].xwoba - 0.300) / 0.300;
    // Expected magnus loss ~19%, expected xwOBA increase ~19-25%
    assert.ok(relativeIncrease >= 0.18 && relativeIncrease <= 0.28,
      `4-seam xwOBA relative increase should be 18-28%, got ${(relativeIncrease*100).toFixed(1)}%`);
  });

  test('A typical "balanced" pitcher (mixed arsenal) at Coors gets a noticeable but not catastrophic hit', () => {
    const arsenal = [
      { pitchType: 'FF', xwoba: 0.300, pitches: 350 },  // 35% usage
      { pitchType: 'SL', xwoba: 0.280, pitches: 250 },  // 25%
      { pitchType: 'CH', xwoba: 0.290, pitches: 200 },  // 20%
      { pitchType: 'SI', xwoba: 0.310, pitches: 200 },  // 20%
    ];
    const { adjustedArsenal } = adjustPitcherArsenal(arsenal, 0.825);
    // Weighted average xwOBA shift
    const totalPitches = arsenal.reduce((s, p) => s + p.pitches, 0);
    let weightedShift = 0;
    for (let i = 0; i < arsenal.length; i++) {
      const shift = adjustedArsenal[i].xwoba - arsenal[i].xwoba;
      weightedShift += shift * (arsenal[i].pitches / totalPitches);
    }
    // Should be somewhere between 0.030-0.060 for a balanced arsenal at Coors
    assert.ok(weightedShift >= 0.030 && weightedShift <= 0.060,
      `Balanced arsenal xwOBA shift should be 0.030-0.060, got ${weightedShift.toFixed(3)}`);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
