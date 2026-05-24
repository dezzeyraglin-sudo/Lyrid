// Tests for unassistedEngine.js (May 23, 2026)
//
// Goal: verify that the engine rejects the kinds of picks that historically
// lost (Sheets/Langeliers-style high-inflation small-sample plays) and
// promotes the kinds of picks that historically won (contact hitters with
// large arsenal samples in the regressed xwOBA sweet spot).

import assert from 'assert';
import {
  selectUnassistedTopPick,
  UNASSISTED_THRESHOLDS,
  _testing
} from '../api/_lib/unassistedEngine.js';

const { inflationGapFrom, checkArsenalCoverage, scoreUnassistedProp } = _testing;

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
// HARD FILTER TESTS
// =============================================================

suite('Hard filters — inflation gap', () => {
  test('Inflation gap > 0.15 rejects the hitter', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.65, score: 80 }],
      {
        adjustedMaxXwoba: 0.85,
        regressedMaxXwoba: 0.60,  // gap = 0.25, exceeds 0.15
        matchedHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.85 }],
        pHit: { probability: 0.30 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'rejected');
    assert.ok(result.rejectionReasons.some(r => r.includes('inflation_gap')));
  });

  test('Inflation gap 0.10-0.15 → caution tier (not rejected)', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.65, score: 80 }],
      {
        adjustedMaxXwoba: 0.65,
        regressedMaxXwoba: 0.53,  // gap = 0.12, in caution band
        matchedHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.65 }],
        pHit: { probability: 0.32 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'caution');
    assert.notStrictEqual(result.topPick, null);
  });

  test('Inflation gap < 0.10 → eligible tier', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.65, score: 80 }],
      {
        adjustedMaxXwoba: 0.58,
        regressedMaxXwoba: 0.55,  // gap = 0.03, well within tight
        matchedHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.58 }],
        pHit: { probability: 0.32 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'eligible');
  });
});

suite('Hard filters — matched K%', () => {
  test('Matched K% > 30 rejects', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.50 }],
      {
        adjustedMaxXwoba: 0.55,
        regressedMaxXwoba: 0.50,
        matchedHitterK: 33,        // exceeds 30
        seasonHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.55 }],
        pHit: { probability: 0.25 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'rejected');
    assert.ok(result.rejectionReasons.some(r => r.includes('matched_k')));
  });

  test('Matched K% 27-30 → caution', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.55 }],
      {
        adjustedMaxXwoba: 0.55,
        regressedMaxXwoba: 0.50,
        matchedHitterK: 28,        // in caution band
        seasonHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.55 }],
        pHit: { probability: 0.27 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'caution');
  });

  test('Matched K% < 27 → eligible', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.55 }],
      {
        adjustedMaxXwoba: 0.55,
        regressedMaxXwoba: 0.52,
        matchedHitterK: 18,
        seasonHitterK: 20,
        recentFormPaUsed: 35,
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.55 }],
        pHit: { probability: 0.30 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'eligible');
  });
});

suite('Hard filters — arsenal coverage', () => {
  test('No pitch with ≥ 15 PA on any main pitch rejects', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.55 }],
      {
        adjustedMaxXwoba: 0.65,    // high but small sample
        regressedMaxXwoba: 0.55,
        matchedHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [
          { pitch: 'FF', pitcherUsage: 45, hitterPa: 8, hitterXwoba: 0.70 },   // main but only 8 PA
          { pitch: 'SL', pitcherUsage: 25, hitterPa: 6, hitterXwoba: 0.55 },   // main but only 6 PA
          { pitch: 'CH', pitcherUsage: 15, hitterPa: 12, hitterXwoba: 0.50 }   // main but only 12 PA
        ],
        pHit: { probability: 0.28 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'rejected');
    assert.ok(result.rejectionReasons.some(r => r.includes('no_main_pitch_with_min_pa')));
  });

  test('At least one main pitch with ≥ 15 PA passes', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.55 }],
      {
        adjustedMaxXwoba: 0.58,
        regressedMaxXwoba: 0.52,
        matchedHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [
          { pitch: 'FF', pitcherUsage: 45, hitterPa: 25, hitterXwoba: 0.60 },  // PASSES (45% usage, 25 PA)
          { pitch: 'SL', pitcherUsage: 25, hitterPa: 8, hitterXwoba: 0.55 },
          { pitch: 'CH', pitcherUsage: 15, hitterPa: 12, hitterXwoba: 0.50 }
        ],
        pHit: { probability: 0.30 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'eligible');
    assert.strictEqual(result.audit.checks.arsenal.passes, true);
  });

  test('Flat arsenal (no pitch ≥ 15% usage) falls back to top 3', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.55 }],
      {
        adjustedMaxXwoba: 0.55,
        regressedMaxXwoba: 0.50,
        matchedHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [
          { pitch: 'FF', pitcherUsage: 14, hitterPa: 20, hitterXwoba: 0.55 },  // below 15% but top 3
          { pitch: 'SL', pitcherUsage: 13, hitterPa: 18, hitterXwoba: 0.50 },
          { pitch: 'CH', pitcherUsage: 12, hitterPa: 15, hitterXwoba: 0.48 }
        ],
        pHit: { probability: 0.28 },
        expectedPa: 4.2
      }
    );
    // Should pass via top-3 fallback since FF has 20 PA
    assert.strictEqual(result.eligibility, 'eligible');
  });

  test('No arsenal data at all → reject', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.55 }],
      {
        adjustedMaxXwoba: 0.55,
        regressedMaxXwoba: 0.50,
        matchedHitterK: 22,
        recentFormPaUsed: 35,
        matchedPitches: [],
        pHit: { probability: 0.28 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'rejected');
  });
});

suite('Hard filters — recent form PA', () => {
  test('Recent form PA < 20 (but > 0) rejects', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.55 }],
      {
        adjustedMaxXwoba: 0.55,
        regressedMaxXwoba: 0.50,
        matchedHitterK: 22,
        recentFormPaUsed: 12,      // too small
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.55 }],
        pHit: { probability: 0.28 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'rejected');
    assert.ok(result.rejectionReasons.some(r => r.includes('recent_form_pa')));
  });

  test('Recent form PA = 0 (missing) is acceptable (no rejection)', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'H', label: 'HITS 0.5', probability: 0.55 }],
      {
        adjustedMaxXwoba: 0.55,
        regressedMaxXwoba: 0.50,
        matchedHitterK: 22,
        recentFormPaUsed: 0,       // missing — graceful
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.55 }],
        pHit: { probability: 0.28 },
        expectedPa: 4.2
      }
    );
    assert.strictEqual(result.eligibility, 'eligible');
  });
});

// =============================================================
// PROP-LEVEL ELIGIBILITY
// =============================================================

suite('Prop eligibility within unassisted', () => {
  const goodCtx = {
    adjustedMaxXwoba: 0.55,
    regressedMaxXwoba: 0.55,
    matchedHitterK: 18,
    seasonHitterK: 20,
    recentFormPaUsed: 35,
    matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.55 }],
    pHit: { probability: 0.32 },
    expectedPa: 4.2,
    hitterBBPct: 10
  };

  test('HITS prop is fully eligible', () => {
    const score = scoreUnassistedProp({ key: 'H', label: 'HITS 0.5', probability: 0.75 }, goodCtx);
    assert.strictEqual(score.eligible, true);
    assert.ok(score.total > 0);
  });

  test('HRR is eligible but discounted 0.85x', () => {
    const score = scoreUnassistedProp({ key: 'HRR', label: 'H+R+RBI 1.5', probability: 0.70 }, goodCtx);
    assert.strictEqual(score.eligible, true);
    assert.strictEqual(score.components.propMultiplier, 0.85);
  });

  test('R (Runs) is INELIGIBLE — requires teammates to drive in', () => {
    const score = scoreUnassistedProp({ key: 'R', label: 'RUNS 0.5', probability: 0.60 }, goodCtx);
    assert.strictEqual(score.eligible, false);
    assert.strictEqual(score.total, -Infinity);
  });

  test('RBI is INELIGIBLE — requires teammates on base', () => {
    const score = scoreUnassistedProp({ key: 'RBI', label: 'RBI 0.5', probability: 0.50 }, goodCtx);
    assert.strictEqual(score.eligible, false);
  });

  test('HR is INELIGIBLE — variance, not skill', () => {
    const score = scoreUnassistedProp({ key: 'HR', label: 'HR 0.5', probability: 0.25 }, goodCtx);
    assert.strictEqual(score.eligible, false);
  });

  test('PP_FS_6 is eligible but heavily discounted 0.70x', () => {
    const score = scoreUnassistedProp({ key: 'PP_FS_6', label: 'PP FS 6', probability: 0.65 }, goodCtx);
    assert.strictEqual(score.eligible, true);
    assert.strictEqual(score.components.propMultiplier, 0.70);
  });
});

// =============================================================
// TOP-PICK SELECTION
// =============================================================

suite('Top pick selection', () => {
  const goodCtx = {
    adjustedMaxXwoba: 0.55,
    regressedMaxXwoba: 0.55,
    matchedHitterK: 18,
    seasonHitterK: 20,
    recentFormPaUsed: 35,
    matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.55 }],
    pHit: { probability: 0.32 },
    expectedPa: 4.2,
    hitterBBPct: 10
  };

  test('Prefers HITS over HRR when both available', () => {
    const props = [
      { key: 'HRR', label: 'H+R+RBI 1.5', probability: 0.72 },  // higher headline
      { key: 'H', label: 'HITS 0.5', probability: 0.78 }
    ];
    const result = selectUnassistedTopPick(props, goodCtx);
    assert.strictEqual(result.topPick.key, 'H');  // HITS wins despite similar probability
  });

  test('Prefers HRR over PP_FS when only those two eligible', () => {
    const props = [
      { key: 'PP_FS_8', label: 'PP FS 8', probability: 0.70 },
      { key: 'HRR', label: 'H+R+RBI 1.5', probability: 0.68 }
    ];
    const result = selectUnassistedTopPick(props, goodCtx);
    assert.strictEqual(result.topPick.key, 'HRR');  // HRR's 0.85x multiplier beats FS's 0.70x
  });

  test('Returns null topPick if all eligible props are rejected', () => {
    // Construct a case where only ineligible props (R, RBI, HR) exist
    const props = [
      { key: 'R', label: 'RUNS 0.5', probability: 0.60 },
      { key: 'RBI', label: 'RBI 0.5', probability: 0.55 },
      { key: 'HR', label: 'HR 0.5', probability: 0.20 }
    ];
    const result = selectUnassistedTopPick(props, goodCtx);
    assert.strictEqual(result.topPick, null);
    assert.strictEqual(result.eligibility, 'rejected');
  });
});

// =============================================================
// ARCHETYPE TESTS — DATA-GROUNDED
// =============================================================

suite('Historical archetypes (from 82-pick dataset)', () => {
  test('Bryce Harper 5/19 (lost 0-fer, edge=0.738, SCORCHING) — should be flagged', () => {
    // Harper had a high edge, SCORCHING form, vs CWS-tier bullpen. Lost.
    // Reason historically: inflated by single-pitch dominance, ecosystem failed
    // to convert. With the strict arsenal + inflation filters, should reject
    // OR land in caution.
    const result = selectUnassistedTopPick(
      [{ key: 'HRR', label: 'H+R+RBI 1.5', probability: 0.70 }],
      {
        adjustedMaxXwoba: 0.95,  // inflated headline
        regressedMaxXwoba: 0.60,  // regression sees through it — gap 0.35
        matchedHitterK: 26,
        seasonHitterK: 24,
        recentFormPaUsed: 38,
        matchedPitches: [
          { pitch: 'FF', pitcherUsage: 50, hitterPa: 30, hitterXwoba: 0.95 },
          { pitch: 'SL', pitcherUsage: 30, hitterPa: 22, hitterXwoba: 0.60 }
        ],
        pHit: { probability: 0.32 },
        expectedPa: 4.3,
        hitterBBPct: 14
      }
    );
    // Gap = 0.35 > 0.15 → reject
    assert.strictEqual(result.eligibility, 'rejected');
    assert.ok(result.rejectionReasons.some(r => r.includes('inflation_gap')));
  });

  test('Sweet-spot contact hitter (regressed 0.55, large arsenal sample) — should be eligible top pick', () => {
    const props = [
      { key: 'H', label: 'HITS 0.5', probability: 0.72 },
      { key: 'HRR', label: 'H+R+RBI 1.5', probability: 0.68 }
    ];
    const result = selectUnassistedTopPick(props, {
      adjustedMaxXwoba: 0.58,
      regressedMaxXwoba: 0.55,    // sweet spot
      matchedHitterK: 16,
      seasonHitterK: 19,           // matched K is LOWER than season — bonus
      recentFormPaUsed: 42,
      matchedPitches: [
        { pitch: 'FF', pitcherUsage: 40, hitterPa: 38, hitterXwoba: 0.58 },
        { pitch: 'SL', pitcherUsage: 25, hitterPa: 22, hitterXwoba: 0.52 }
      ],
      pHit: { probability: 0.33 },
      expectedPa: 4.3,
      hitterBBPct: 11
    });
    assert.strictEqual(result.eligibility, 'eligible');
    assert.strictEqual(result.topPick.key, 'H');  // prefers HITS over HRR
    assert.ok(result.score > 0.5);
  });

  test('Sweet-spot hitter only has HRR (no HITS prop) — HRR becomes top pick', () => {
    const result = selectUnassistedTopPick(
      [{ key: 'HRR', label: 'H+R+RBI 1.5', probability: 0.65 }],
      {
        adjustedMaxXwoba: 0.55,
        regressedMaxXwoba: 0.55,
        matchedHitterK: 18,
        seasonHitterK: 20,
        recentFormPaUsed: 35,
        matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 30, hitterXwoba: 0.55 }],
        pHit: { probability: 0.30 },
        expectedPa: 4.2,
        hitterBBPct: 9
      }
    );
    assert.strictEqual(result.topPick.key, 'HRR');
  });

  test('High-K-cluster hitter (matched > season by 8pp) is penalized', () => {
    // Build context where the matched K% is 30 but season is 22 — significant gap
    const ctxHighGap = {
      adjustedMaxXwoba: 0.55,
      regressedMaxXwoba: 0.55,
      matchedHitterK: 30,
      seasonHitterK: 22,         // 8pp gap → 0.4 × 0.08 = 0.032 penalty
      recentFormPaUsed: 35,
      matchedPitches: [{ pitch: 'FF', pitcherUsage: 40, hitterPa: 25, hitterXwoba: 0.55 }],
      pHit: { probability: 0.30 },
      expectedPa: 4.2,
      hitterBBPct: 9
    };
    const ctxNoGap = { ...ctxHighGap, matchedHitterK: 22, seasonHitterK: 22 };

    const highScore = scoreUnassistedProp({ key: 'H', label: 'HITS 0.5', probability: 0.65 }, ctxHighGap);
    const noScore = scoreUnassistedProp({ key: 'H', label: 'HITS 0.5', probability: 0.65 }, ctxNoGap);

    // Note: ctxHighGap has matchedK = 30, exactly at the boundary. Engine
    // applies the K-cluster penalty in scoring. (Hard rejection is matched > 30.)
    assert.ok(highScore.total < noScore.total,
      `Higher K-gap should score lower (got ${highScore.total} vs ${noScore.total})`);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
