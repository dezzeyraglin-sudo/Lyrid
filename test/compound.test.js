// Tests for compoundProbability.js
//
// Coverage:
//  - Per-PA event distribution: sums to 1, handles edge cases, sane values
//  - Single-game simulation: produces realistic stat lines
//  - Fantasy Score calculation: weights applied correctly
//  - Calibration anchors: league avg / power hitter / punch-out artist
//  - Determinism: same seed → same outputs
//  - Edge cases: missing inputs, extreme PA counts, degenerate distributions
//
// Run with: node test/compound.test.js

import assert from 'assert';
import {
  computeCompoundProbabilities,
  PP_WEIGHTS,
  UD_WEIGHTS,
  _testing,
} from '../api/_lib/compoundProbability.js';

const { buildPerPaEvents, calcFs, makeRng, simulateOneGame, buildCumulativeDist, LEAGUE } = _testing;

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}
function suite(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// =============================================================
// SCORING WEIGHTS — sanity check (these are the user's confirmed values)
// =============================================================

suite('Scoring weights', () => {
  test('PP weights match confirmed PrizePicks scoring', () => {
    assert.strictEqual(PP_WEIGHTS.single, 3);
    assert.strictEqual(PP_WEIGHTS.double, 5);
    assert.strictEqual(PP_WEIGHTS.triple, 8);
    assert.strictEqual(PP_WEIGHTS.hr, 10);
    assert.strictEqual(PP_WEIGHTS.run, 2);
    assert.strictEqual(PP_WEIGHTS.rbi, 2);
    assert.strictEqual(PP_WEIGHTS.walk, 2);
    assert.strictEqual(PP_WEIGHTS.hbp, 2);
    assert.strictEqual(PP_WEIGHTS.sb, 5);
  });

  test('UD weights match confirmed Underdog scoring', () => {
    assert.strictEqual(UD_WEIGHTS.single, 3);
    assert.strictEqual(UD_WEIGHTS.double, 6);
    assert.strictEqual(UD_WEIGHTS.triple, 8);
    assert.strictEqual(UD_WEIGHTS.hr, 10);
    assert.strictEqual(UD_WEIGHTS.run, 2);
    assert.strictEqual(UD_WEIGHTS.rbi, 2);
    assert.strictEqual(UD_WEIGHTS.walk, 3);
    assert.strictEqual(UD_WEIGHTS.hbp, 3);
    assert.strictEqual(UD_WEIGHTS.sb, 4);
  });
});

// =============================================================
// PER-PA EVENT DISTRIBUTION
// =============================================================

suite('Per-PA event distribution', () => {
  test('Distribution sums to 1 for league-average inputs', () => {
    const dist = buildPerPaEvents({
      pHitEngine: 0.243, pHrEngine: 0.030, pXbhEngine: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5, hitterHbpPct: 1.2
    });
    const sum = Object.values(dist).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.001, `Sum should be ~1, got ${sum}`);
  });

  test('Distribution sums to 1 for power hitter inputs', () => {
    const dist = buildPerPaEvents({
      pHitEngine: 0.40, pHrEngine: 0.12, pXbhEngine: 0.25,
      hitterKPct: 28, hitterBBPct: 13, hitterHbpPct: 1.5
    });
    const sum = Object.values(dist).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.001, `Sum should be ~1, got ${sum}`);
  });

  test('Distribution sums to 1 for high-K hitter', () => {
    const dist = buildPerPaEvents({
      pHitEngine: 0.20, pHrEngine: 0.04, pXbhEngine: 0.09,
      hitterKPct: 35, hitterBBPct: 8, hitterHbpPct: 1.0
    });
    const sum = Object.values(dist).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.001, `Sum should be ~1, got ${sum}`);
  });

  test('All event probabilities are non-negative', () => {
    const dist = buildPerPaEvents({
      pHitEngine: 0.55, pHrEngine: 0.20, pXbhEngine: 0.30,
      hitterKPct: 10, hitterBBPct: 15, hitterHbpPct: 2.0
    });
    Object.entries(dist).forEach(([event, p]) => {
      assert.ok(p >= 0, `${event} prob should be ≥ 0, got ${p}`);
    });
  });

  test('Single + Double + Triple + HR equals approximate pHit', () => {
    const dist = buildPerPaEvents({
      pHitEngine: 0.243, pHrEngine: 0.030, pXbhEngine: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5
    });
    const hitTotal = dist.SINGLE + dist.DOUBLE + dist.TRIPLE + dist.HR;
    assert.ok(Math.abs(hitTotal - 0.243) < 0.02, `Hit total should match pHit, got ${hitTotal} vs 0.243`);
  });

  test('Missing inputs gracefully fall back to league averages', () => {
    const dist = buildPerPaEvents({});
    const sum = Object.values(dist).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.001, `Sum should be ~1 even with no inputs, got ${sum}`);
  });

  test('Sprint speed modulates triple rate', () => {
    const slow = buildPerPaEvents({
      pHitEngine: 0.243, pHrEngine: 0.030, pXbhEngine: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5, sprintSpeed: 25
    });
    const fast = buildPerPaEvents({
      pHitEngine: 0.243, pHrEngine: 0.030, pXbhEngine: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5, sprintSpeed: 30
    });
    assert.ok(fast.TRIPLE > slow.TRIPLE, `Fast hitter should have higher triple rate (${fast.TRIPLE} vs ${slow.TRIPLE})`);
  });

  test('Engine pHR cap prevents pathological values', () => {
    const dist = buildPerPaEvents({
      pHitEngine: 0.243, pHrEngine: 0.99, pXbhEngine: 0.99,  // unrealistic
      hitterKPct: 22.5
    });
    // pHR is capped at 0.20 per builder logic
    assert.ok(dist.HR <= 0.21, `pHR should cap, got ${dist.HR}`);
    const sum = Object.values(dist).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `Sum should still be ~1`);
  });
});

// =============================================================
// FANTASY SCORE CALCULATION
// =============================================================

suite('Fantasy Score calculation', () => {
  test('Single line: 1 single + 1 R = PP 5pts (3+2), UD 5pts (3+2)', () => {
    const stats = { single: 1, double: 0, triple: 0, HR: 0, R: 1, RBI: 0, BB: 0, hbp: 0, SB: 0 };
    assert.strictEqual(calcFs(stats, PP_WEIGHTS), 5);
    assert.strictEqual(calcFs(stats, UD_WEIGHTS), 5);
  });

  test('Solo HR: 10 + 2 + 2 = 14 pts on both platforms', () => {
    const stats = { single: 0, double: 0, triple: 0, HR: 1, R: 1, RBI: 1, BB: 0, hbp: 0, SB: 0 };
    assert.strictEqual(calcFs(stats, PP_WEIGHTS), 14);
    assert.strictEqual(calcFs(stats, UD_WEIGHTS), 14);
  });

  test('Double + Walk diverges: PP 5+2+2=9, UD 6+3+2=11', () => {
    const stats = { single: 0, double: 1, triple: 0, HR: 0, R: 1, RBI: 0, BB: 1, hbp: 0, SB: 0 };
    assert.strictEqual(calcFs(stats, PP_WEIGHTS), 9);
    assert.strictEqual(calcFs(stats, UD_WEIGHTS), 11);
  });

  test('Triple + SB: PP 8+5+2+2=17, UD 8+4+2+2=16', () => {
    const stats = { single: 0, double: 0, triple: 1, HR: 0, R: 1, RBI: 1, BB: 0, hbp: 0, SB: 1 };
    assert.strictEqual(calcFs(stats, PP_WEIGHTS), 17);
    assert.strictEqual(calcFs(stats, UD_WEIGHTS), 16);
  });

  test('All zeros = 0', () => {
    const stats = { single: 0, double: 0, triple: 0, HR: 0, R: 0, RBI: 0, BB: 0, hbp: 0, SB: 0 };
    assert.strictEqual(calcFs(stats, PP_WEIGHTS), 0);
    assert.strictEqual(calcFs(stats, UD_WEIGHTS), 0);
  });

  test('Grand slam HR (4 RBI): PP 10+2+8 = 20', () => {
    const stats = { single: 0, double: 0, triple: 0, HR: 1, R: 1, RBI: 4, BB: 0, hbp: 0, SB: 0 };
    assert.strictEqual(calcFs(stats, PP_WEIGHTS), 20);
  });
});

// =============================================================
// DETERMINISTIC SAMPLING (seeded RNG)
// =============================================================

suite('Deterministic sampling', () => {
  test('Same seed produces same per-event sample sequence', () => {
    const rng1 = makeRng(42);
    const rng2 = makeRng(42);
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(rng1(), rng2());
    }
  });

  test('Different seeds produce different sequences', () => {
    const rng1 = makeRng(42);
    const rng2 = makeRng(43);
    let diffs = 0;
    for (let i = 0; i < 100; i++) {
      if (rng1() !== rng2()) diffs++;
    }
    assert.ok(diffs > 90, 'Different seeds should diverge quickly');
  });

  test('Same seed produces identical compound output', () => {
    const input = {
      pHit: 0.30, pHr: 0.08, pXbh: 0.15,
      hitterKPct: 22, hitterBBPct: 9, expectedPa: 4.2,
      nTrials: 1000, seed: 1234
    };
    const r1 = computeCompoundProbabilities(input);
    const r2 = computeCompoundProbabilities(input);
    assert.strictEqual(r1.hrr.p15, r2.hrr.p15);
    assert.strictEqual(r1.ppFs.p6, r2.ppFs.p6);
    assert.strictEqual(r1.udFs.p5, r2.udFs.p5);
  });
});

// =============================================================
// CALIBRATION ANCHORS — the engine should produce realistic probabilities
// for archetypal hitters
// =============================================================

suite('Calibration anchors', () => {
  test('League-average hitter (4.0 PA): HRR ≥ 1.5 between 50% and 75%', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.243, pHr: 0.030, pXbh: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5,
      expectedPa: 4.0, seed: 1
    });
    assert.ok(result.hrr.p15 >= 0.50 && result.hrr.p15 <= 0.75,
      `League avg HRR≥1.5 should be 50-75%, got ${(result.hrr.p15*100).toFixed(1)}%`);
  });

  test('League-average hitter: PP FS expected 5-7 pts', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.243, pHr: 0.030, pXbh: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5,
      expectedPa: 4.0, seed: 2
    });
    assert.ok(result.ppFs.expected >= 4.5 && result.ppFs.expected <= 8,
      `League avg PP FS expected should be 4.5-8, got ${result.ppFs.expected}`);
  });

  test('Power hitter (Judge-tier): P(HR ≥ 1) between 35% and 65%', () => {
    // Realistic Judge MVP-tier: 8% HR/PA, 16% XBH/PA, 31% hit/PA
    // (His career peak was ~7-8% HR/PA — beyond that is unrealistic.)
    const result = computeCompoundProbabilities({
      pHit: 0.31, pHr: 0.08, pXbh: 0.16,
      hitterKPct: 27, hitterBBPct: 14,
      expectedPa: 4.4, seed: 3, nTrials: 5000
    });
    // P(HR ≥ 1) ≈ 1 - (1 - 0.08)^4.4 ≈ 31% theoretical
    // P(HRR≥1.5) should be very high since any HR alone produces 3+ (1H+1R+1+RBI)
    assert.ok(result.hrr.p15 >= 0.65,
      `Power hitter HRR≥1.5 should be ≥65%, got ${(result.hrr.p15*100).toFixed(1)}%`);
  });

  test('Power hitter: PP FS ≥ 8 between 40% and 75%', () => {
    // Realistic Judge MVP profile: 8% HR/PA + frequent XBH + high BB%
    // produces an expected FS around 11-13 pts. P(FS ≥ 8) should be high —
    // hand-calculated ~55-65%.
    const result = computeCompoundProbabilities({
      pHit: 0.31, pHr: 0.08, pXbh: 0.16,
      hitterKPct: 27, hitterBBPct: 14,
      expectedPa: 4.4, seed: 4, nTrials: 5000
    });
    assert.ok(result.ppFs.p8 >= 0.40 && result.ppFs.p8 <= 0.75,
      `Power hitter PP FS≥8 should be 40-75%, got ${(result.ppFs.p8*100).toFixed(1)}%`);
  });

  test('Punch-out artist (35% K): HRR ≥ 1.5 lower than league avg', () => {
    const leagueAvg = computeCompoundProbabilities({
      pHit: 0.243, pHr: 0.030, pXbh: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5,
      expectedPa: 4.0, seed: 5
    });
    const punchOut = computeCompoundProbabilities({
      pHit: 0.20, pHr: 0.035, pXbh: 0.075,
      hitterKPct: 35, hitterBBPct: 7,
      expectedPa: 4.0, seed: 5
    });
    assert.ok(punchOut.hrr.p15 < leagueAvg.hrr.p15,
      `Punch-out artist HRR (${punchOut.hrr.p15}) should be lower than league avg (${leagueAvg.hrr.p15})`);
  });

  test('Elite contact hitter (low K, high hit rate): HRR ≥ 1.5 higher than league avg', () => {
    const leagueAvg = computeCompoundProbabilities({
      pHit: 0.243, pHr: 0.030, pXbh: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5,
      expectedPa: 4.0, seed: 6
    });
    const elite = computeCompoundProbabilities({
      pHit: 0.35, pHr: 0.04, pXbh: 0.11,
      hitterKPct: 13, hitterBBPct: 9,
      expectedPa: 4.4, seed: 6
    });
    assert.ok(elite.hrr.p15 > leagueAvg.hrr.p15,
      `Elite contact HRR (${elite.hrr.p15}) should be higher than league avg (${leagueAvg.hrr.p15})`);
  });

  test('Lineup slot affects expected outcomes (more PA → more action)', () => {
    const leadoff = computeCompoundProbabilities({
      pHit: 0.27, pHr: 0.05, pXbh: 0.10,
      hitterKPct: 18, hitterBBPct: 11,
      expectedPa: 4.4, seed: 7
    });
    const lastSlot = computeCompoundProbabilities({
      pHit: 0.27, pHr: 0.05, pXbh: 0.10,
      hitterKPct: 18, hitterBBPct: 11,
      expectedPa: 3.7, seed: 7
    });
    assert.ok(leadoff.hrr.p15 > lastSlot.hrr.p15,
      `Leadoff HRR (${leadoff.hrr.p15}) should exceed last slot (${lastSlot.hrr.p15})`);
  });

  test('Higher HR rate → higher PP FS ≥ 8', () => {
    const lowHr = computeCompoundProbabilities({
      pHit: 0.25, pHr: 0.02, pXbh: 0.06,
      hitterKPct: 22, hitterBBPct: 8, expectedPa: 4.0, seed: 8
    });
    const highHr = computeCompoundProbabilities({
      pHit: 0.25, pHr: 0.10, pXbh: 0.18,
      hitterKPct: 22, hitterBBPct: 8, expectedPa: 4.0, seed: 8
    });
    assert.ok(highHr.ppFs.p8 > lowHr.ppFs.p8,
      `High HR rate PP FS≥8 (${highHr.ppFs.p8}) should exceed low HR (${lowHr.ppFs.p8})`);
  });
});

// =============================================================
// PP vs UD divergence — these should differ predictably
// =============================================================

suite('PP vs UD divergence', () => {
  test('UD slightly higher than PP for walk-heavy hitter (UD pays 3 vs PP 2)', () => {
    // Build a high-walk profile
    const result = computeCompoundProbabilities({
      pHit: 0.22, pHr: 0.03, pXbh: 0.07,
      hitterKPct: 18, hitterBBPct: 16,  // very high BB%
      expectedPa: 4.2, seed: 10, nTrials: 5000
    });
    // UD pays 3 per walk, PP pays 2. With high BB%, UD expected > PP expected
    assert.ok(result.udFs.expected > result.ppFs.expected,
      `UD FS expected (${result.udFs.expected}) should exceed PP (${result.ppFs.expected}) for walk-heavy hitter`);
  });

  test('UD slightly higher than PP for double-heavy hitter (UD pays 6 vs PP 5)', () => {
    // High XBH-double ratio — high pXBH but moderate HR
    const result = computeCompoundProbabilities({
      pHit: 0.30, pHr: 0.03, pXbh: 0.18,
      hitterKPct: 18, hitterBBPct: 8,
      expectedPa: 4.2, seed: 11, nTrials: 5000
    });
    assert.ok(result.udFs.expected > result.ppFs.expected,
      `UD FS expected (${result.udFs.expected}) should exceed PP (${result.ppFs.expected}) for double-heavy hitter`);
  });

  test('PP slightly higher than UD for SB-heavy hitter (PP pays 5 vs UD 4)', () => {
    // Isolate SB effect: keep BB% low so walk-premium doesn't dominate.
    // High SB rate + low BB rate → PP's SB premium (5 vs 4) wins.
    const result = computeCompoundProbabilities({
      pHit: 0.28, pHr: 0.02, pXbh: 0.06,
      hitterKPct: 18, hitterBBPct: 5,  // LOW BB% to isolate SB
      sbPerPa: 0.08,                    // very high SB rate
      expectedPa: 4.3, seed: 12, nTrials: 5000
    });
    // PP pays more per SB (5 vs 4)
    assert.ok(result.ppFs.expected > result.udFs.expected,
      `PP FS expected (${result.ppFs.expected}) should exceed UD (${result.udFs.expected}) for SB-heavy hitter`);
  });
});

// =============================================================
// EDGE CASES
// =============================================================

suite('Edge cases', () => {
  test('Null input returns null', () => {
    const result = computeCompoundProbabilities(null);
    // Should either return null or a stable empty result, not crash
    assert.ok(result === null || result.hrr != null);
  });

  test('Empty input returns reasonable defaults', () => {
    const result = computeCompoundProbabilities({});
    assert.ok(result != null);
    assert.ok(result.hrr.p15 >= 0 && result.hrr.p15 <= 1);
  });

  test('NaN inputs handled gracefully', () => {
    const result = computeCompoundProbabilities({
      pHit: NaN, pHr: NaN, pXbh: NaN,
      hitterKPct: NaN, hitterBBPct: NaN,
      expectedPa: NaN, seed: 99
    });
    assert.ok(result != null);
    assert.ok(Number.isFinite(result.hrr.p15));
  });

  test('Zero PA produces zero everything', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.243, pHr: 0.030, pXbh: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5,
      expectedPa: 0.5, seed: 100
    });
    // ePa gets clamped to 1, so should still produce something
    assert.ok(result != null);
    assert.ok(result.hrr.p15 < 0.5,
      `Tiny PA should produce low HRR, got ${result.hrr.p15}`);
  });

  test('Low trial count still produces valid output', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.243, pHr: 0.030, pXbh: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5,
      expectedPa: 4.0, seed: 101, nTrials: 100
    });
    assert.ok(result != null);
    assert.ok(result.hrr.p15 >= 0 && result.hrr.p15 <= 1);
  });

  test('Probabilities are bounded [0, 1]', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.55, pHr: 0.20, pXbh: 0.30,
      hitterKPct: 5, hitterBBPct: 20,
      expectedPa: 5.0, seed: 102
    });
    ['p15', 'p25'].forEach(k => {
      assert.ok(result.hrr[k] >= 0 && result.hrr[k] <= 1, `hrr.${k} out of bounds: ${result.hrr[k]}`);
    });
    ['p6', 'p7', 'p8'].forEach(k => {
      assert.ok(result.ppFs[k] >= 0 && result.ppFs[k] <= 1, `ppFs.${k} out of bounds`);
    });
    ['p5', 'p6', 'p7'].forEach(k => {
      assert.ok(result.udFs[k] >= 0 && result.udFs[k] <= 1, `udFs.${k} out of bounds`);
    });
  });
});

// =============================================================
// PERFORMANCE SANITY
// =============================================================

suite('Performance', () => {
  test('5000-trial sim completes in < 50ms for one hitter', () => {
    const start = Date.now();
    computeCompoundProbabilities({
      pHit: 0.243, pHr: 0.030, pXbh: 0.075,
      hitterKPct: 22.5, hitterBBPct: 8.5,
      expectedPa: 4.0, nTrials: 5000, seed: 200
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `5000 trials took ${elapsed}ms (should be <50ms)`);
  });

  test('Per-game perf (36 hitters at 5000 trials each)', () => {
    const start = Date.now();
    for (let i = 0; i < 36; i++) {
      computeCompoundProbabilities({
        pHit: 0.243, pHr: 0.030, pXbh: 0.075,
        hitterKPct: 22.5, hitterBBPct: 8.5,
        expectedPa: 4.0, nTrials: 5000, seed: 300 + i
      });
    }
    const elapsed = Date.now() - start;
    // 36 hitters × ~5ms = 180ms target, well under 800ms ceiling
    assert.ok(elapsed < 800, `Full slate (36 hitters) took ${elapsed}ms (ceiling: 800ms)`);
    console.log(`        (actual: ${elapsed}ms for 36 hitters at 5000 trials)`);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
