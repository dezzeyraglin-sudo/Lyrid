/**
 * Tests for reboundsProjection.js
 *
 * Strategy:
 *  - Unit tests for the matchup multiplier (the swappable Stage 1/2/3 boundary)
 *  - Formula sanity at league-average baseline
 *  - Position volatility affects band width and confidence
 *  - Integration: full pipeline (minutes -> redistribution -> rebounds)
 *  - The architecture-validation test: swapping matchup multiplier doesn't break public API
 *
 * Run with: node test/rebounds.test.js
 */

import assert from 'assert';

import {
  computeProjRebounds,
  computeMatchupMultiplier,
  LEAGUE_AVG_PACE,
  LEAGUE_AVG_MISS_RATE,
} from '../api/_lib/basketball/reboundsProjection.js';
import { computeProjMinutes } from '../api/_lib/basketball/minutesProjection.js';
import { redistributeOutMinutes } from '../api/_lib/basketball/teammateRedistribution.js';

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
// Matchup multiplier as standalone (the architecture boundary)
// ============================================================================

suite('computeMatchupMultiplier: Stage 1', () => {
  test('league-average opponent produces multiplier of 1.0', () => {
    const result = computeMatchupMultiplier({}, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.strictEqual(result.multiplier, 1.0);
    assert.strictEqual(result.audit.fallbacksUsed.length, 0);
  });

  test('faster opponent pace boosts multiplier', () => {
    const slow = computeMatchupMultiplier({}, { opp_pace: 75, opp_miss_rate: 0.555 });
    const fast = computeMatchupMultiplier({}, { opp_pace: 88, opp_miss_rate: 0.555 });
    assert.ok(fast.multiplier > slow.multiplier);
  });

  test('higher opponent miss rate boosts multiplier', () => {
    const lowMisses = computeMatchupMultiplier({}, { opp_pace: 80, opp_miss_rate: 0.50 });
    const highMisses = computeMatchupMultiplier({}, { opp_pace: 80, opp_miss_rate: 0.62 });
    assert.ok(highMisses.multiplier > lowMisses.multiplier);
  });

  test('extreme pace and miss rate are clamped (no compounding to absurd values)', () => {
    const extreme = computeMatchupMultiplier({}, { opp_pace: 150, opp_miss_rate: 0.95 });
    // pace clamp: 1.15, miss rate clamp: 1.12 -> max product: 1.288
    assert.ok(extreme.multiplier <= 1.29, `Extreme should be clamped, got ${extreme.multiplier}`);
  });

  test('missing opp_pace falls back to league avg and flags audit', () => {
    const result = computeMatchupMultiplier({}, { opp_miss_rate: 0.555 });
    assert.ok(result.audit.fallbacksUsed.includes('opp_pace'));
  });

  test('audit identifies this as Stage 1 (architecture marker)', () => {
    const result = computeMatchupMultiplier({}, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.strictEqual(result.audit.stage, 1);
    assert.ok(result.audit.note.includes('Stage 2'));
  });
});

// ============================================================================
// Formula sanity at baseline
// ============================================================================

suite('reboundsProjection: baseline sanity', () => {
  test('league-average context reproduces minutes * reb_per_min', () => {
    // Player with 0.25 reb/min playing 30 minutes vs league-avg opponent should project to 7.5
    const player = {
      projMinutes: 30,
      confidence: 100,
      season_reb_per_min: 0.25,  // 7.5 rpg over 30 mpg
      position: 'F',
      gp: 10,
    };
    const result = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.strictEqual(result.projRebounds, 7.5);
  });

  test('zero minutes -> zero rebounds', () => {
    const player = { projMinutes: 0, confidence: 0, season_reb_per_min: 0.30, position: 'C' };
    const result = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.strictEqual(result.projRebounds, 0);
  });

  test('audit identifies stage and formula', () => {
    const player = { projMinutes: 25, confidence: 80, season_reb_per_min: 0.20, position: 'F', gp: 10 };
    const result = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.strictEqual(result.audit.stage, 1);
    assert.ok(result.audit.formula.includes('projMinutes'));
    assert.ok(result.audit.formula.includes('matchupMultiplier'));
  });
});

// ============================================================================
// Per-minute scaling (vs. per-possession like points)
// ============================================================================

suite('reboundsProjection: minutes scaling', () => {
  test('doubling minutes roughly doubles rebounds (linear, not exponential)', () => {
    const playerShort = { projMinutes: 15, confidence: 100, season_reb_per_min: 0.30, position: 'C', gp: 10 };
    const playerLong = { ...playerShort, projMinutes: 30 };
    const a = computeProjRebounds(playerShort, { opp_pace: 80, opp_miss_rate: 0.555 });
    const b = computeProjRebounds(playerLong, { opp_pace: 80, opp_miss_rate: 0.555 });
    // Same context -> rebounds should scale linearly with minutes
    assert.strictEqual(b.projRebounds, a.projRebounds * 2);
  });

  test('a star center at full minutes projects to double digits', () => {
    const playerC = { projMinutes: 34, confidence: 100, season_reb_per_min: 0.32, position: 'C', gp: 10 };
    const result = computeProjRebounds(playerC, { opp_pace: 82, opp_miss_rate: 0.57 });
    assert.ok(result.projRebounds >= 10, `Star center should project to 10+ rebounds, got ${result.projRebounds}`);
  });
});

// ============================================================================
// Position volatility
// ============================================================================

suite('reboundsProjection: position volatility', () => {
  test('guards get confidence deduction for rebound volatility', () => {
    const guard = { projMinutes: 28, confidence: 100, season_reb_per_min: 0.13, position: 'G', gp: 10 };
    const center = { projMinutes: 28, confidence: 100, season_reb_per_min: 0.30, position: 'C', gp: 10 };
    const a = computeProjRebounds(guard, { opp_pace: 80, opp_miss_rate: 0.555 });
    const b = computeProjRebounds(center, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.ok(a.confidence < b.confidence, `Guard confidence (${a.confidence}) should be lower than center (${b.confidence})`);
  });

  test('guards get wider floor/ceiling band', () => {
    const guard = { projMinutes: 28, confidence: 100, season_reb_per_min: 0.15, position: 'G', gp: 10 };
    const center = { projMinutes: 28, confidence: 100, season_reb_per_min: 0.30, position: 'C', gp: 10 };
    const a = computeProjRebounds(guard, { opp_pace: 80, opp_miss_rate: 0.555 });
    const b = computeProjRebounds(center, { opp_pace: 80, opp_miss_rate: 0.555 });
    const guardBandProp = (a.ceiling - a.floor) / a.projRebounds;
    const centerBandProp = (b.ceiling - b.floor) / b.projRebounds;
    assert.ok(guardBandProp > centerBandProp, `Guard band ${guardBandProp.toFixed(3)} should exceed center ${centerBandProp.toFixed(3)}`);
  });

  test('unknown position defaults safely (no crash)', () => {
    const weird = { projMinutes: 25, confidence: 100, season_reb_per_min: 0.20, position: 'XYZ', gp: 10 };
    const result = computeProjRebounds(weird, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.ok(result.projRebounds > 0);
    assert.strictEqual(result.factors.position, 'XYZ');
  });
});

// ============================================================================
// Recent form, b2b, thin sample
// ============================================================================

suite('reboundsProjection: adjustments', () => {
  test('hot rebound streak boosts projection', () => {
    const stable = { projMinutes: 30, confidence: 100, season_reb_per_min: 0.25, last5_reb_per_min: 0.25, position: 'F', gp: 10 };
    const hot = { ...stable, last5_reb_per_min: 0.32 };
    const a = computeProjRebounds(stable, { opp_pace: 80, opp_miss_rate: 0.555 });
    const b = computeProjRebounds(hot, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.ok(b.projRebounds > a.projRebounds);
  });

  test('b2b reduces rebounds by ~4%', () => {
    const player = { projMinutes: 30, confidence: 100, season_reb_per_min: 0.25, position: 'F', gp: 10 };
    const fresh = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    const tired = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555, is_b2b: true });
    assert.ok(tired.projRebounds < fresh.projRebounds);
    assert.strictEqual(tired.factors.b2bPenalty, 0.96);
  });

  test('thin sample deducts confidence', () => {
    const player = { projMinutes: 22, confidence: 70, season_reb_per_min: 0.22, position: 'F', gp: 3 };
    const result = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    const thinHit = result.audit.confidenceDeductions.find(d => d.reason === 'thin_rebound_sample');
    assert.ok(thinHit, 'Should record thin_rebound_sample deduction');
  });

  test('high variance (rebound std-dev > 3.5) deducts confidence', () => {
    const stable = { projMinutes: 28, confidence: 100, season_reb_per_min: 0.25, last5_reb_std: 2.0, position: 'F', gp: 10 };
    const volatile = { ...stable, last5_reb_std: 4.5 };
    const a = computeProjRebounds(stable, { opp_pace: 80, opp_miss_rate: 0.555 });
    const b = computeProjRebounds(volatile, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.ok(b.confidence < a.confidence);
  });
});

// ============================================================================
// Integration: full pipeline
// ============================================================================

suite('Integration: minutes -> redistribution -> rebounds', () => {
  test('OUT center + backup C: backup absorbs minutes and rebound boost', () => {
    // Setup: Star C (30mpg, 0.32 reb/min = ~9.6 rpg) is OUT.
    // BackupC (16mpg, 0.28 reb/min) absorbs minutes.
    const roster = [
      { playerId: '1', playerName: 'StarC', position: 'C', season_mpg: 30, gp: 10, gs: 10, season_reb_per_min: 0.32 },
      { playerId: '2', playerName: 'BackupC', position: 'C', season_mpg: 16, gp: 10, gs: 0, season_reb_per_min: 0.28 },
    ];
    const injuries = { '1': { status: 'OUT' } };

    // Tag, project minutes
    for (const p of roster) {
      p.status = injuries[p.playerId] ? injuries[p.playerId].status : 'AVAILABLE';
      const proj = computeProjMinutes(p, {}, injuries[p.playerId] || null);
      p.projMinutes = proj.projMinutes;
      p.confidence = proj.confidence;
    }

    // Snapshot backup before redistribution
    const backupBeforeMin = roster.find(p => p.playerName === 'BackupC').projMinutes;
    const backupBeforeSnap = { ...roster.find(p => p.playerName === 'BackupC') };
    const beforeReb = computeProjRebounds(backupBeforeSnap, { opp_pace: 80, opp_miss_rate: 0.555 });

    // Redistribute
    redistributeOutMinutes(roster);
    const backupAfter = roster.find(p => p.playerName === 'BackupC');
    const afterReb = computeProjRebounds(backupAfter, { opp_pace: 80, opp_miss_rate: 0.555 });

    assert.ok(backupAfter.projMinutes > backupBeforeMin,
      `Minutes should rise: ${backupBeforeMin} -> ${backupAfter.projMinutes}`);
    assert.ok(afterReb.projRebounds > beforeReb.projRebounds,
      `Rebounds should rise: ${beforeReb.projRebounds} -> ${afterReb.projRebounds}`);

    // Since rebounds scale linearly with minutes, the ratio should match
    const minRatio = backupAfter.projMinutes / backupBeforeMin;
    const rebRatio = afterReb.projRebounds / beforeReb.projRebounds;
    // Should be within 5% (the projMinutes is captured pre-redistribution in factors, so ratio should match exactly)
    assert.ok(Math.abs(minRatio - rebRatio) < 0.05,
      `Rebound ratio (${rebRatio.toFixed(3)}) should match minute ratio (${minRatio.toFixed(3)}) for linear scaling`);
  });

  test('GTD player keeps full rebound projection, lower confidence', () => {
    const player = {
      playerId: '1', playerName: 'Star', position: 'F',
      season_mpg: 30, gp: 10, gs: 10, season_reb_per_min: 0.25,
    };
    const injury = { status: 'GTD' };

    const minProj = computeProjMinutes(player, {}, injury);
    player.projMinutes = minProj.projMinutes;
    player.confidence = minProj.confidence;

    const rebProj = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    // Minutes full (30), confidence inherits 60 from GTD
    assert.strictEqual(player.projMinutes, 30);
    assert.ok(rebProj.confidence <= 60);
    assert.ok(rebProj.projRebounds > 0);
  });

  test('OUT player produces zero rebounds', () => {
    const player = {
      playerId: '1', playerName: 'Out', position: 'C',
      season_mpg: 32, gp: 10, gs: 10, season_reb_per_min: 0.30,
    };
    const injury = { status: 'OUT' };
    const minProj = computeProjMinutes(player, {}, injury);
    player.projMinutes = minProj.projMinutes;
    player.confidence = minProj.confidence;
    const rebProj = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.strictEqual(rebProj.projRebounds, 0);
  });
});

// ============================================================================
// Architecture validation: swap-in compatibility
// ============================================================================

suite('Architecture: Stage 2 swap-in compatibility', () => {
  test('computeMatchupMultiplier is exported for direct testing', () => {
    // If this fails, Stage 2 swap-in would break the public API.
    assert.strictEqual(typeof computeMatchupMultiplier, 'function');
  });

  test('matchup multiplier audit identifies its stage (for monitoring future migrations)', () => {
    const result = computeMatchupMultiplier({}, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.ok(typeof result.audit.stage === 'number');
    assert.strictEqual(result.audit.stage, 1);
  });

  test('rebounds projection audit surfaces the matchup audit (full traceability)', () => {
    const player = { projMinutes: 25, confidence: 100, season_reb_per_min: 0.22, position: 'F', gp: 10 };
    const result = computeProjRebounds(player, { opp_pace: 82, opp_miss_rate: 0.57 });
    assert.ok(result.audit.matchupBreakdown);
    assert.strictEqual(result.audit.matchupBreakdown.stage, 1);
  });

  test('player object can carry Stage 2 fields (oreb_rate, dreb_rate) without crashing Stage 1', () => {
    // Forward-compatibility: Stage 2 will pass these. Stage 1 should ignore them gracefully.
    const playerWithStage2Fields = {
      projMinutes: 28, confidence: 100, season_reb_per_min: 0.28, position: 'F', gp: 10,
      oreb_rate: 0.08, dreb_rate: 0.22,  // Stage 2 fields
    };
    const result = computeProjRebounds(playerWithStage2Fields, {
      opp_pace: 80,
      opp_miss_rate: 0.555,
      opp_3pa_rate: 0.38,    // Stage 2 fields
      opp_paint_rate: 0.32,  // Stage 2 fields
    });
    assert.ok(result.projRebounds > 0);
    // Currently Stage 1 ignores these, but it shouldn't crash
  });
});

// ============================================================================
// Edge cases
// ============================================================================

suite('reboundsProjection: edge cases', () => {
  test('throws if projMinutes missing', () => {
    assert.throws(() => computeProjRebounds({ season_reb_per_min: 0.25, position: 'F' }, {}));
  });

  test('throws if season_reb_per_min missing', () => {
    assert.throws(() => computeProjRebounds({ projMinutes: 25, position: 'F' }, {}));
  });

  test('zero rebound rate (lockdown defender, no boards) projects to 0', () => {
    const player = { projMinutes: 25, confidence: 100, season_reb_per_min: 0, position: 'PG', gp: 10 };
    const result = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.strictEqual(result.projRebounds, 0);
  });

  test('handles missing position (defaults to F volatility)', () => {
    const player = { projMinutes: 25, confidence: 100, season_reb_per_min: 0.22, gp: 10 };
    const result = computeProjRebounds(player, { opp_pace: 80, opp_miss_rate: 0.555 });
    assert.strictEqual(result.factors.position, 'F');
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
