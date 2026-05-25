// Tests for lineupSignalAggregator.js
//
// Goal: validate that the aggregator produces sensible signals from
// representative lineup compositions, and that the consumer functions
// produce bounded, reasonable multipliers.

import assert from 'assert';
import {
  aggregateLineupSignals,
  computeYrfiTopOfOrderBoost,
  computeGameTotalLineupAdjustment,
  computeArsenalVulnerability,
  LINEUP_SIGNAL_AGGREGATION_ENABLED
} from '../api/_lib/lineupSignalAggregator.js';

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

// Helpers to construct realistic matchups
function mkMatchup({ slot, name, tier = 'eligible', fragScore = 20, adj = 0.55, reg = 0.52, ctx = 1.0 }) {
  return {
    hitter: name,
    battingOrder: slot,
    tier: 'elite',
    fragility: { score: fragScore, tier: fragScore > 45 ? 'eliminated' : fragScore > 25 ? 'caution' : 'eligible' },
    unassistedTier: tier,
    adjustedMaxXwoba: adj,
    regressedMaxXwoba: reg,
    contextMultiplier: ctx
  };
}

// =============================================================
// AGGREGATION
// =============================================================

suite('aggregateLineupSignals basics', () => {
  test('empty lineup returns neutral', () => {
    const r = aggregateLineupSignals([]);
    assert.strictEqual(r.topOfOrder.count, 0);
    assert.strictEqual(r.fullLineup.count, 0);
  });

  test('null input returns neutral', () => {
    const r = aggregateLineupSignals(null);
    assert.strictEqual(r.topOfOrder.count, 0);
  });

  test('lineup missing battingOrder falls back gracefully', () => {
    const matchups = [
      { hitter: 'Smith', unassistedTier: 'eligible' },
      { hitter: 'Jones', unassistedTier: 'rejected' }
    ];
    const r = aggregateLineupSignals(matchups);
    assert.strictEqual(r.topOfOrder.count, 0);  // can't aggregate without slots
  });

  test('typical full lineup aggregates correctly', () => {
    const lineup = [
      mkMatchup({ slot: 1, name: 'A', tier: 'eligible', fragScore: 15, reg: 0.58 }),
      mkMatchup({ slot: 2, name: 'B', tier: 'eligible', fragScore: 18, reg: 0.55 }),
      mkMatchup({ slot: 3, name: 'C', tier: 'caution', fragScore: 28, reg: 0.50 }),
      mkMatchup({ slot: 4, name: 'D', tier: 'eligible', fragScore: 20, reg: 0.57 }),
      mkMatchup({ slot: 5, name: 'E', tier: 'rejected', fragScore: 60, reg: 0.42 }),
      mkMatchup({ slot: 6, name: 'F', tier: 'eligible', fragScore: 22, reg: 0.52 }),
      mkMatchup({ slot: 7, name: 'G', tier: 'caution', fragScore: 32, reg: 0.48 }),
      mkMatchup({ slot: 8, name: 'H', tier: 'rejected', fragScore: 55, reg: 0.40 }),
      mkMatchup({ slot: 9, name: 'I', tier: 'eligible', fragScore: 25, reg: 0.50 })
    ];
    const r = aggregateLineupSignals(lineup);
    assert.strictEqual(r.topOfOrder.count, 5, 'top-of-order should have 5');
    assert.strictEqual(r.fullLineup.count, 9);
    assert.ok(r.topOfOrder.eligibleRate > 0.5);
    assert.ok(r.fullLineup.rejectedRate > 0.15);
    assert.ok(r.audit.sampleHitters.length === 5);
  });
});

// =============================================================
// YRFI BOOST
// =============================================================

suite('computeYrfiTopOfOrderBoost', () => {
  test('strong top-of-order produces boost', () => {
    const lineup = [
      mkMatchup({ slot: 1, name: 'A', tier: 'eligible', fragScore: 15, reg: 0.58 }),
      mkMatchup({ slot: 2, name: 'B', tier: 'eligible', fragScore: 18, reg: 0.55 }),
      mkMatchup({ slot: 3, name: 'C', tier: 'eligible', fragScore: 20, reg: 0.57 }),
      mkMatchup({ slot: 4, name: 'D', tier: 'eligible', fragScore: 16, reg: 0.56 }),
      mkMatchup({ slot: 5, name: 'E', tier: 'caution', fragScore: 25, reg: 0.52 })
    ];
    const aggregated = aggregateLineupSignals(lineup);
    const result = computeYrfiTopOfOrderBoost(aggregated);
    assert.ok(result.multiplier > 1.0, `Expected boost, got ${result.multiplier}`);
    assert.ok(result.multiplier <= 1.20, 'Multiplier exceeded ceiling');
  });

  test('weak top-of-order produces suppression', () => {
    const lineup = [
      mkMatchup({ slot: 1, name: 'A', tier: 'rejected', fragScore: 55, reg: 0.40 }),
      mkMatchup({ slot: 2, name: 'B', tier: 'rejected', fragScore: 50, reg: 0.42 }),
      mkMatchup({ slot: 3, name: 'C', tier: 'rejected', fragScore: 48, reg: 0.41 }),
      mkMatchup({ slot: 4, name: 'D', tier: 'caution', fragScore: 35, reg: 0.46 }),
      mkMatchup({ slot: 5, name: 'E', tier: 'eligible', fragScore: 22, reg: 0.50 })
    ];
    const aggregated = aggregateLineupSignals(lineup);
    const result = computeYrfiTopOfOrderBoost(aggregated);
    assert.ok(result.multiplier < 1.0, `Expected suppression, got ${result.multiplier}`);
    assert.ok(result.multiplier >= 0.85, 'Multiplier dropped below floor');
  });

  test('mixed lineup stays near 1.0', () => {
    const lineup = [
      mkMatchup({ slot: 1, name: 'A', tier: 'eligible', fragScore: 22, reg: 0.50 }),
      mkMatchup({ slot: 2, name: 'B', tier: 'caution', fragScore: 28, reg: 0.48 }),
      mkMatchup({ slot: 3, name: 'C', tier: 'rejected', fragScore: 50, reg: 0.41 }),
      mkMatchup({ slot: 4, name: 'D', tier: 'eligible', fragScore: 18, reg: 0.55 }),
      mkMatchup({ slot: 5, name: 'E', tier: 'caution', fragScore: 30, reg: 0.49 })
    ];
    const aggregated = aggregateLineupSignals(lineup);
    const result = computeYrfiTopOfOrderBoost(aggregated);
    assert.ok(result.multiplier >= 0.95 && result.multiplier <= 1.05,
      `Expected near 1.0, got ${result.multiplier}`);
  });

  test('respects feature flag (always returns 1.0 when empty)', () => {
    const result = computeYrfiTopOfOrderBoost(null);
    assert.strictEqual(result.multiplier, 1.0);
  });

  test('multiplier is bounded to [0.85, 1.20]', () => {
    // Extreme strong lineup
    const lineup = [];
    for (let s = 1; s <= 5; s++) {
      lineup.push(mkMatchup({ slot: s, name: `A${s}`, tier: 'eligible', fragScore: 5, reg: 0.65 }));
    }
    const r = computeYrfiTopOfOrderBoost(aggregateLineupSignals(lineup));
    assert.ok(r.multiplier <= 1.20, `Exceeded ceiling: ${r.multiplier}`);
    assert.ok(r.multiplier >= 0.85);
  });
});

// =============================================================
// GAME TOTAL ADJUSTMENT
// =============================================================

suite('computeGameTotalLineupAdjustment', () => {
  test('robust lineup gets small boost', () => {
    const lineup = [];
    for (let s = 1; s <= 9; s++) {
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, tier: 'eligible', fragScore: 10, reg: 0.55 }));
    }
    const result = computeGameTotalLineupAdjustment(aggregateLineupSignals(lineup));
    assert.ok(result.multiplier > 1.0, `Expected boost, got ${result.multiplier}`);
    assert.ok(result.multiplier <= 1.10, 'Multiplier exceeded ceiling');
  });

  test('fragile lineup gets suppression', () => {
    const lineup = [];
    for (let s = 1; s <= 9; s++) {
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, tier: 'rejected', fragScore: 50, reg: 0.42 }));
    }
    const result = computeGameTotalLineupAdjustment(aggregateLineupSignals(lineup));
    assert.ok(result.multiplier < 1.0, `Expected suppression, got ${result.multiplier}`);
    assert.ok(result.multiplier >= 0.90);
  });

  test('lineup with high inflation gaps gets suppression', () => {
    const lineup = [];
    for (let s = 1; s <= 9; s++) {
      // Each hitter has wide adj-reg gap = inflated edge
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, tier: 'eligible', fragScore: 20, adj: 0.75, reg: 0.55 }));
    }
    const result = computeGameTotalLineupAdjustment(aggregateLineupSignals(lineup));
    assert.ok(result.multiplier < 1.0, `Expected modest suppression from inflation, got ${result.multiplier}`);
  });

  test('multiplier always in [0.90, 1.10]', () => {
    const lineup = [];
    for (let s = 1; s <= 9; s++) {
      // Worst-case: rejected with huge inflation
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, tier: 'rejected', fragScore: 80, adj: 0.95, reg: 0.40, ctx: 1.5 }));
    }
    const result = computeGameTotalLineupAdjustment(aggregateLineupSignals(lineup));
    assert.ok(result.multiplier >= 0.90, `Floor breached: ${result.multiplier}`);
    assert.ok(result.multiplier <= 1.10, `Ceiling breached: ${result.multiplier}`);
  });

  test('insufficient lineup data → neutral', () => {
    const result = computeGameTotalLineupAdjustment(aggregateLineupSignals([
      mkMatchup({ slot: 1, name: 'A' }),
      mkMatchup({ slot: 2, name: 'B' })
    ]));
    assert.strictEqual(result.multiplier, 1.0);
  });
});

// =============================================================
// ARSENAL VULNERABILITY
// =============================================================

suite('computeArsenalVulnerability', () => {
  test('lineup with concentrated arsenal advantage produces boost', () => {
    // 6 of 9 hitters have regressed xwOBA >= 0.55
    const lineup = [];
    for (let s = 1; s <= 6; s++) {
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, reg: 0.58 }));
    }
    for (let s = 7; s <= 9; s++) {
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, reg: 0.45 }));
    }
    const result = computeArsenalVulnerability(lineup, 0.320);
    assert.ok(result.multiplier > 1.0, `Expected boost, got ${result.multiplier}`);
    assert.ok(result.multiplier <= 1.10);
  });

  test('lineup with no real advantage stays neutral', () => {
    const lineup = [];
    for (let s = 1; s <= 9; s++) {
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, reg: 0.42 }));  // all below 0.55
    }
    const result = computeArsenalVulnerability(lineup, 0.320);
    assert.strictEqual(result.multiplier, 1.0);
  });

  test('boost is halved when pitcher already elite', () => {
    const lineup = [];
    for (let s = 1; s <= 6; s++) {
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, reg: 0.58 }));
    }
    for (let s = 7; s <= 9; s++) {
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, reg: 0.45 }));
    }
    const regularResult = computeArsenalVulnerability(lineup, 0.320);
    const eliteResult = computeArsenalVulnerability(lineup, 0.270);  // elite pitcher
    assert.ok(eliteResult.multiplier < regularResult.multiplier,
      `Elite pitcher should reduce boost: regular=${regularResult.multiplier} elite=${eliteResult.multiplier}`);
  });

  test('multiplier bounded to [0.92, 1.10]', () => {
    const lineup = [];
    for (let s = 1; s <= 9; s++) {
      lineup.push(mkMatchup({ slot: s, name: `H${s}`, reg: 0.75 }));  // every hitter elite
    }
    const result = computeArsenalVulnerability(lineup, 0.350);  // mediocre pitcher
    assert.ok(result.multiplier <= 1.10, `Ceiling: ${result.multiplier}`);
  });

  test('empty matchups → neutral', () => {
    const result = computeArsenalVulnerability([], 0.320);
    assert.strictEqual(result.multiplier, 1.0);
  });
});

// =============================================================
// FEATURE FLAG
// =============================================================

suite('Feature flag behavior', () => {
  test('flag is exported and is a boolean', () => {
    assert.strictEqual(typeof LINEUP_SIGNAL_AGGREGATION_ENABLED, 'boolean');
  });

  test('flag is currently ON (per user request May 25, 2026)', () => {
    assert.strictEqual(LINEUP_SIGNAL_AGGREGATION_ENABLED, true);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
