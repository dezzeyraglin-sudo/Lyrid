// Tests for ecosystem-aware compound probability (May 23, 2026)
//
// Goal: verify that ecosystem variables and fragility scoring correctly
// distinguish Sheets/Langeliers-class fragile props from Trout/Marte-class
// robust props.

import assert from 'assert';
import {
  computeCompoundProbabilities,
} from '../api/_lib/compoundProbability.js';
import {
  lineupContinuationFactor,
  teamRunConversionRate,
  inningExtensionFactor,
  LEAGUE_ECOSYSTEM
} from '../api/_lib/teamEcosystem.js';

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
// ECOSYSTEM HELPERS
// =============================================================

suite('Ecosystem helpers', () => {
  test('Lineup continuation factor: dead offense suppresses', () => {
    const dead = lineupContinuationFactor(0.260);  // White Sox tier
    const avg = lineupContinuationFactor(0.318);   // league
    const elite = lineupContinuationFactor(0.350); // Dodgers tier
    assert.ok(dead < 0.92, `Dead offense should reduce PA factor, got ${dead}`);
    assert.ok(Math.abs(avg - 1.0) < 0.001, `League avg should be 1.0, got ${avg}`);
    assert.ok(elite > 1.04, `Elite offense should boost PA factor, got ${elite}`);
  });

  test('Run conversion: high-RPG team has higher rPerOnBase', () => {
    const goodEcosystem = { runsPerGame: 5.2, lobPerGame: 6.5 };
    const badEcosystem = { runsPerGame: 3.1, lobPerGame: 7.2 };
    const goodRate = teamRunConversionRate(goodEcosystem);
    const badRate = teamRunConversionRate(badEcosystem);
    assert.ok(goodRate > badRate, `Good ecosystem (${goodRate}) should exceed bad (${badRate})`);
  });

  test('Inning extension: weighted geometric mean, bounded', () => {
    // Dead offense (low OBP, low RPG, high LOB)
    const deadFactor = inningExtensionFactor({
      obp: 0.260, runsPerGame: 3.2, lobPerGame: 7.6
    });
    // Elite offense (high OBP, high RPG, moderate LOB)
    const eliteFactor = inningExtensionFactor({
      obp: 0.345, runsPerGame: 5.4, lobPerGame: 7.0
    });
    assert.ok(deadFactor < 0.95, `Dead offense extension factor should be low, got ${deadFactor}`);
    assert.ok(eliteFactor > 1.05, `Elite offense extension factor should be high, got ${eliteFactor}`);
    assert.ok(deadFactor >= 0.85 && eliteFactor <= 1.15, `Should be clamped`);
  });

  test('Null/undefined ecosystem returns neutral', () => {
    assert.strictEqual(lineupContinuationFactor(undefined), 1.0);
    assert.strictEqual(lineupContinuationFactor(NaN), 1.0);
    assert.strictEqual(teamRunConversionRate(null), 0.31);
    assert.strictEqual(inningExtensionFactor(null), 1.0);
  });
});

// =============================================================
// COMPOUND ENGINE: ECOSYSTEM SCALING
// =============================================================

suite('Compound engine: ecosystem scaling', () => {
  // Use identical hitters; only ecosystem differs
  const baseHitter = {
    pHit: 0.27, pHr: 0.05, pXbh: 0.10,
    hitterKPct: 22, hitterBBPct: 9,
    expectedPa: 4.2,
    seed: 100, nTrials: 5000
  };

  test('Same hitter, dead ecosystem produces LOWER HRR than elite ecosystem', () => {
    const deadEcosystem = {
      obp: 0.260, runsPerGame: 3.2, lobPerGame: 7.6, ops: 0.640
    };
    const eliteEcosystem = {
      obp: 0.345, runsPerGame: 5.4, lobPerGame: 7.0, ops: 0.790
    };
    const inDead = computeCompoundProbabilities({ ...baseHitter, teamEcosystem: deadEcosystem });
    const inElite = computeCompoundProbabilities({ ...baseHitter, teamEcosystem: eliteEcosystem });

    assert.ok(inElite.hrr.p15 > inDead.hrr.p15,
      `Same hitter in elite ecosystem (${inElite.hrr.p15}) should outperform dead (${inDead.hrr.p15})`);
  });

  test('Dead ecosystem reduces expectedPa via lineup continuation', () => {
    const deadEcosystem = { obp: 0.260, runsPerGame: 3.2, lobPerGame: 7.6 };
    const result = computeCompoundProbabilities({ ...baseHitter, teamEcosystem: deadEcosystem });
    assert.ok(result.audit.expectedPa < 4.0,
      `Dead ecosystem should drop expectedPa below baseline 4.2, got ${result.audit.expectedPa}`);
  });

  test('Opposing high-K pitcher further reduces expectedPa', () => {
    const result = computeCompoundProbabilities({
      ...baseHitter,
      opposingPitcherKPct: 32  // ace strikeout pitcher
    });
    assert.ok(result.audit.expectedPa < 4.2,
      `High-K pitcher should drop expectedPa, got ${result.audit.expectedPa}`);
    assert.ok(result.audit.expectedPaAdjustment.factors.pitcherKDrag < 1.0);
  });

  test('Game total of 7 (pitcher duel) reduces expectedPa', () => {
    const result = computeCompoundProbabilities({ ...baseHitter, gameTotal: 7.0 });
    assert.ok(result.audit.expectedPaAdjustment.factors.gameTotal < 1.0,
      `Low game total should reduce PA factor`);
  });

  test('Backward compatibility: no ecosystem still works', () => {
    const result = computeCompoundProbabilities(baseHitter);
    assert.ok(result != null);
    assert.ok(result.hrr.p15 >= 0 && result.hrr.p15 <= 1);
    assert.strictEqual(result.audit.teamEcosystem, null);
  });
});

// =============================================================
// PATHWAY DECOMPOSITION
// =============================================================

suite('Pathway decomposition', () => {
  test('HR-only hitter: HR_PATH dominates clearing', () => {
    // Hitter who only generates value through HRs (rare hits, frequent walks)
    const result = computeCompoundProbabilities({
      pHit: 0.20, pHr: 0.12, pXbh: 0.16,  // HR/PA = 12%, XBH/PA = 16%
      hitterKPct: 32, hitterBBPct: 14,
      expectedPa: 4.0, seed: 200, nTrials: 5000
    });
    assert.ok(result.pathways.hrPathDominance > 0.4,
      `HR-only hitter should have HR-path dominance > 40%, got ${result.pathways.hrPathDominance}`);
  });

  test('Contact hitter: multi-hit path is significant', () => {
    // High contact, low power
    const result = computeCompoundProbabilities({
      pHit: 0.35, pHr: 0.03, pXbh: 0.08,
      hitterKPct: 13, hitterBBPct: 8,
      expectedPa: 4.4, seed: 201, nTrials: 5000
    });
    assert.ok(result.pathways.shares.MULTI_HIT_PATH > 0.15,
      `Contact hitter should clear via multi-hit, got ${result.pathways.shares.MULTI_HIT_PATH}`);
  });

  test('Pathway diversity is higher for balanced profile than HR-only', () => {
    const hrOnly = computeCompoundProbabilities({
      pHit: 0.20, pHr: 0.12, pXbh: 0.16,
      hitterKPct: 32, hitterBBPct: 14,
      expectedPa: 4.0, seed: 202, nTrials: 5000
    });
    const balanced = computeCompoundProbabilities({
      pHit: 0.30, pHr: 0.05, pXbh: 0.12,
      hitterKPct: 18, hitterBBPct: 10,
      expectedPa: 4.2, seed: 202, nTrials: 5000
    });
    assert.ok(balanced.pathways.diversity > hrOnly.pathways.diversity,
      `Balanced (${balanced.pathways.diversity}) should beat HR-only (${hrOnly.pathways.diversity})`);
  });

  test('Pathway shares sum to ~1.0 (excluding DID_NOT_CLEAR)', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.27, pHr: 0.06, pXbh: 0.12,
      hitterKPct: 20, hitterBBPct: 10,
      expectedPa: 4.2, seed: 203, nTrials: 5000
    });
    const sum = Object.values(result.pathways.shares).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `Pathway shares should sum to 1, got ${sum}`);
  });
});

// =============================================================
// FRAGILITY SCORING
// =============================================================

suite('Fragility scoring', () => {
  test('Trout/Marte-class (good hitter + elite ecosystem) has LOW fragility', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.30, pHr: 0.07, pXbh: 0.16,
      hitterKPct: 18, hitterBBPct: 12,
      expectedPa: 4.3,
      teamEcosystem: { obp: 0.335, runsPerGame: 5.0, lobPerGame: 6.9 },
      seed: 300, nTrials: 5000
    });
    assert.ok(result.fragility.score < 40,
      `Strong hitter + good ecosystem should have low fragility, got ${result.fragility.score}`);
    assert.strictEqual(result.fragility.eliminationTier, 'eligible');
  });

  test('Sheets/Langeliers-class (decent hitter + dead ecosystem) has HIGH fragility', () => {
    // Decent power hitter on a dead offense, batting against a tough pitcher
    const result = computeCompoundProbabilities({
      pHit: 0.22, pHr: 0.06, pXbh: 0.12,
      hitterKPct: 26, hitterBBPct: 7,
      expectedPa: 4.2,
      teamEcosystem: { obp: 0.265, runsPerGame: 3.3, lobPerGame: 7.4 },
      opposingPitcherKPct: 26,
      seed: 301, nTrials: 5000
    });
    assert.ok(result.fragility.score >= 25,
      `Sheets-class should have caution-or-eliminated fragility (>=25), got ${result.fragility.score}`);
    assert.notStrictEqual(result.fragility.eliminationTier, 'eligible',
      `Sheets-class should not be eligible (got ${result.fragility.eliminationTier})`);
  });

  test('HR-dependent hitter (high pHR, low pHit) has HR dependency penalty', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.18, pHr: 0.10, pXbh: 0.14,
      hitterKPct: 30, hitterBBPct: 12,
      expectedPa: 4.0,
      teamEcosystem: { obp: 0.318, runsPerGame: 4.45, lobPerGame: 6.85 },
      seed: 302, nTrials: 5000
    });
    assert.ok(result.fragility.components.hrDependency > 0,
      `HR-dependent profile should trigger HR dependency penalty, got ${result.fragility.components.hrDependency}`);
  });

  test('Punch-out hitter (high K%) has K-cluster risk penalty', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.22, pHr: 0.05, pXbh: 0.10,
      hitterKPct: 33, hitterBBPct: 9,
      expectedPa: 4.0,
      teamEcosystem: { obp: 0.318, runsPerGame: 4.45, lobPerGame: 6.85 },
      seed: 303, nTrials: 5000
    });
    assert.ok(result.fragility.components.kClusterRisk > 0,
      `High-K hitter should trigger K-cluster penalty, got ${result.fragility.components.kClusterRisk}`);
  });

  test('Low expected PA triggers PA-shortfall penalty', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.25, pHr: 0.05, pXbh: 0.10,
      hitterKPct: 20, hitterBBPct: 8,
      expectedPa: 3.5,  // 7-9 hitter
      teamEcosystem: { obp: 0.260, runsPerGame: 3.2, lobPerGame: 7.6 },  // dead offense further reduces
      seed: 304, nTrials: 5000
    });
    assert.ok(result.fragility.components.lowExpectedPa > 0,
      `Low PA hitter should trigger PA penalty, got ${result.fragility.components.lowExpectedPa}`);
  });

  test('Missing ecosystem yields uncertainty penalty (but not catastrophic)', () => {
    const result = computeCompoundProbabilities({
      pHit: 0.27, pHr: 0.05, pXbh: 0.10,
      hitterKPct: 20, hitterBBPct: 9,
      expectedPa: 4.2,
      seed: 305, nTrials: 5000
      // no teamEcosystem
    });
    assert.strictEqual(result.fragility.components.ecosystemWeakness, 8,
      `Missing ecosystem should add 8pt uncertainty penalty`);
  });

  test('Fragility score is bounded [0, 100]', () => {
    // Try to construct worst-case fragility
    const result = computeCompoundProbabilities({
      pHit: 0.15, pHr: 0.12, pXbh: 0.14,
      hitterKPct: 40, hitterBBPct: 5,
      expectedPa: 3.5,
      teamEcosystem: { obp: 0.230, runsPerGame: 2.8, lobPerGame: 8.0 },
      seed: 306, nTrials: 5000
    });
    assert.ok(result.fragility.score >= 0 && result.fragility.score <= 100,
      `Fragility should be in [0,100], got ${result.fragility.score}`);
  });

  test('Elimination tiers: eligible / caution / eliminated', () => {
    const tiers = new Set();
    for (let i = 0; i < 20; i++) {
      const result = computeCompoundProbabilities({
        pHit: 0.20 + (i * 0.01),
        pHr: 0.04 + (i * 0.005),
        pXbh: 0.08 + (i * 0.01),
        hitterKPct: 35 - i,
        hitterBBPct: 5 + i * 0.5,
        expectedPa: 3.5 + (i * 0.05),
        teamEcosystem: { obp: 0.250 + (i * 0.005), runsPerGame: 3.0 + (i * 0.15), lobPerGame: 7.5 - (i * 0.05) },
        seed: 400 + i, nTrials: 2000
      });
      tiers.add(result.fragility.eliminationTier);
    }
    assert.ok(tiers.has('eligible') && tiers.has('caution') && tiers.has('eliminated'),
      `Should produce all 3 tiers across varied inputs, got ${[...tiers].join(', ')}`);
  });
});

// =============================================================
// ECOSYSTEM PRESENCE DOES NOT BREAK PERFORMANCE
// =============================================================

suite('Performance with ecosystem inputs', () => {
  test('Per-game perf with ecosystem (36 hitters) under 800ms', () => {
    const start = Date.now();
    const ecosystem = { obp: 0.318, runsPerGame: 4.45, lobPerGame: 6.85 };
    for (let i = 0; i < 36; i++) {
      computeCompoundProbabilities({
        pHit: 0.243, pHr: 0.030, pXbh: 0.075,
        hitterKPct: 22.5, hitterBBPct: 8.5,
        expectedPa: 4.0, teamEcosystem: ecosystem,
        opposingPitcherKPct: 22.5, gameTotal: 8.5,
        nTrials: 5000, seed: 500 + i
      });
    }
    const elapsed = Date.now() - start;
    console.log(`        (${elapsed}ms for 36 hitters at 5000 trials with full ecosystem)`);
    assert.ok(elapsed < 800, `Full slate should complete in <800ms, took ${elapsed}ms`);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
