// Tests for firstInning.js + lineupSignalAggregator integration (May 25, 2026)
//
// Verifies that computeFirstInningProbability correctly applies the new
// lineup signal AND arsenal vulnerability multipliers, AND that the two
// signals stack properly (multiplicatively) on each side.

import assert from 'assert';
import { computeFirstInningProbability } from '../api/_lib/firstInning.js';

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

// Minimal side data: just enough to drive the function. We focus on the
// signal application, not the legacy components.
function mkSide({ inningXw, lineupTier } = {}) {
  return {
    inningSplits: {
      perInning: inningXw != null ? { 1: { xwobaAgainst: inningXw, pa: 100, bbPct: 8, kPct: 22 } } : {},
      controlTier: 'average'
    },
    lineupTier: lineupTier || { label: 'NEUTRAL', avgMaxXwoba: 0.320 }
  };
}

suite('Baseline (no aggregator signals)', () => {
  test('Without lineup/arsenal signals, behavior matches legacy', () => {
    const result = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {}
    );
    // YRFI should land near league average (.57) with no boosts applied
    assert.ok(result.yrfiProb > 0.45 && result.yrfiProb < 0.65,
      `Expected near-baseline YRFI, got ${result.yrfiProb}`);
    assert.strictEqual(result.lineupSignalAudit.away, null);
    assert.strictEqual(result.lineupSignalAudit.home, null);
  });
});

suite('Lineup signal application', () => {
  test('Strong away lineup signal raises awayScoresProb', () => {
    const baseline = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {}
    );
    const withBoost = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {
        awayLineupSignal: { multiplier: 1.15, reasoning: ['mock boost'] }
      }
    );
    assert.ok(withBoost.awayScoresProb > baseline.awayScoresProb,
      `Expected away to rise, got ${withBoost.awayScoresProb} vs ${baseline.awayScoresProb}`);
    assert.ok(withBoost.homeScoresProb === baseline.homeScoresProb,
      'Home side should not change');
    assert.notStrictEqual(withBoost.lineupSignalAudit.away, null);
    assert.strictEqual(withBoost.lineupSignalAudit.home, null);
  });

  test('Weak home lineup signal lowers homeScoresProb', () => {
    const baseline = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {}
    );
    const withSuppress = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {
        homeLineupSignal: { multiplier: 0.88, reasoning: ['mock suppression'] }
      }
    );
    assert.ok(withSuppress.homeScoresProb < baseline.homeScoresProb,
      `Expected home to drop, got ${withSuppress.homeScoresProb} vs ${baseline.homeScoresProb}`);
  });
});

suite('Arsenal vulnerability application', () => {
  test('Arsenal signal applied independently of lineup signal', () => {
    const baseline = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {}
    );
    const withArsenal = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {
        awayArsenalSignal: { multiplier: 1.08, reasoning: ['arsenal mock'] }
      }
    );
    assert.ok(withArsenal.awayScoresProb > baseline.awayScoresProb,
      `Arsenal alone should boost away: ${withArsenal.awayScoresProb} vs ${baseline.awayScoresProb}`);
  });

  test('Arsenal and lineup signals stack multiplicatively', () => {
    const lineupOnly = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      { awayLineupSignal: { multiplier: 1.12, reasoning: [] } }
    );
    const arsenalOnly = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      { awayArsenalSignal: { multiplier: 1.08, reasoning: [] } }
    );
    const both = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {
        awayLineupSignal: { multiplier: 1.12, reasoning: [] },
        awayArsenalSignal: { multiplier: 1.08, reasoning: [] }
      }
    );
    // both should exceed either alone
    assert.ok(both.awayScoresProb > lineupOnly.awayScoresProb);
    assert.ok(both.awayScoresProb > arsenalOnly.awayScoresProb);
    // Combined multiplier should be in audit
    const combined = both.lineupSignalAudit.away.combinedMultiplier;
    const expected = 1.12 * 1.08;
    assert.ok(Math.abs(combined - expected) < 0.001,
      `Combined ${combined} ≠ expected ${expected}`);
  });

  test('Arsenal signal does NOT cross sides', () => {
    // awayArsenalSignal should NOT affect homeScoresProb
    const result = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {
        awayArsenalSignal: { multiplier: 1.10, reasoning: [] }
      }
    );
    // homeScoresProb should be untouched (near LEAGUE_HOME_SCORES_FIRST = 0.305)
    assert.ok(Math.abs(result.homeScoresProb - 0.305) < 0.01,
      `home leaked from away signal: ${result.homeScoresProb}`);
  });
});

suite('Audit completeness', () => {
  test('Audit includes both lineup and arsenal reasoning', () => {
    const result = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {
        awayLineupSignal: { multiplier: 1.12, reasoning: ['lineup reason 1'] },
        awayArsenalSignal: { multiplier: 1.06, reasoning: ['arsenal reason 1'] }
      }
    );
    const audit = result.lineupSignalAudit.away;
    assert.ok(audit.lineupReasoning.includes('lineup reason 1'));
    assert.ok(audit.arsenalReasoning.includes('arsenal reason 1'));
    assert.strictEqual(audit.lineupMultiplier, 1.12);
    assert.strictEqual(audit.arsenalMultiplier, 1.06);
  });
});

suite('Edge cases', () => {
  test('1.0 multipliers do not pollute the audit', () => {
    const result = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {
        awayLineupSignal: { multiplier: 1.0, reasoning: [] },
        awayArsenalSignal: { multiplier: 1.0, reasoning: [] }
      }
    );
    // When both are 1.0, no actual change happens, so audit can be null
    assert.strictEqual(result.lineupSignalAudit.away, null);
  });

  test('null/undefined signals do not crash', () => {
    const result = computeFirstInningProbability(
      mkSide({ inningXw: 0.320 }),
      mkSide({ inningXw: 0.320 }),
      {
        awayLineupSignal: null,
        awayArsenalSignal: undefined,
        homeLineupSignal: { multiplier: NaN }  // non-finite
      }
    );
    // Should not throw, multipliers should fall back to 1.0
    assert.ok(Number.isFinite(result.yrfiProb));
    assert.ok(Number.isFinite(result.awayScoresProb));
    assert.ok(Number.isFinite(result.homeScoresProb));
  });

  test('Combined multiplier respects scoreProb clamp [0.05, 0.75]', () => {
    // Extreme: maxed-out lineup × maxed-out arsenal = 1.20 × 1.10 = 1.32x
    const result = computeFirstInningProbability(
      mkSide({ inningXw: 0.400 }),  // already-bad pitcher to push prob up
      mkSide({ inningXw: 0.320 }),
      {
        awayLineupSignal: { multiplier: 1.20, reasoning: [] },
        awayArsenalSignal: { multiplier: 1.10, reasoning: [] }
      }
    );
    assert.ok(result.awayScoresProb <= 0.75, `Hit ceiling: ${result.awayScoresProb}`);
    assert.ok(result.awayScoresProb >= 0.05);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
