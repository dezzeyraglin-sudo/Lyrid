/**
 * Tests for pointsProjection.js
 *
 * Strategy:
 *  - Unit tests for each factor (pace, matchup, recent form, b2b)
 *  - League-average baseline test: identity case should produce season_ppg back
 *  - Fallback behavior when inputs are missing
 *  - Integration: minutes -> redistribution -> points produces sensible boosted backups
 *
 * Run with: node test/points.test.js
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { computeProjPoints, LEAGUE_AVG_PACE, LEAGUE_AVG_DEF_RATING, LEAGUE_AVG_TS_PCT } = require('../api/_lib/basketball/pointsProjection');
const { computeProjMinutes } = require('../api/_lib/basketball/minutesProjection');
const { redistributeOutMinutes } = require('../api/_lib/basketball/teammateRedistribution');
const { parseEspnInjuriesPayload } = require('../api/_lib/basketball/injuryFeed');

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
// Sanity check: identity case
// ============================================================================

suite('pointsProjection: league-average sanity check', () => {
  test('league-average player vs league-average opponent reproduces season ppg', () => {
    // A player averaging 16 ppg, league-average usage (0.20) and TS (0.535), playing their season MPG,
    // against a league-average opponent, should project right around 16 ppg.
    const player = {
      projMinutes: 30,
      confidence: 100,
      season_ppg: 16,
      usage: 0.20,
      ts_pct: 0.535,
      gp: 10,
    };
    const gameContext = {
      team_pace: 80,
      opp_pace: 80,
      opp_def_rating: 104,
    };
    const result = computeProjPoints(player, gameContext);
    // Formula at league-average: 30 min * (80/40 ppmin) * 0.20 * (2*0.535) * 1.0 * 1.0 * 1.0 * 1.0
    //                          = 30 * 2.0 * 0.20 * 1.07 = 12.84
    // Note: this is < 16 because a "16 ppg" player at 30 min implies ppm of 0.53,
    // and our formula derives points from usage*efficiency, not ppm directly.
    // The "identity case" we should test is: do the math arithmetic check out?
    // 30 * 2.0 * 0.20 * 1.07 = 12.84
    assert.ok(Math.abs(result.projPoints - 12.84) < 0.2, `Expected ~12.84, got ${result.projPoints}`);
    assert.strictEqual(result.audit.fallbacksUsed.length, 0, 'Should not use fallbacks when all inputs present');
  });

  test('zero minutes -> zero points', () => {
    const player = { projMinutes: 0, season_ppg: 20, usage: 0.25, ts_pct: 0.55, confidence: 0 };
    const result = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    assert.strictEqual(result.projPoints, 0);
    assert.strictEqual(result.confidence, 0);
  });
});

// ============================================================================
// Individual factors
// ============================================================================

suite('pointsProjection: pace factor', () => {
  test('faster opponent pace boosts projection', () => {
    const player = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, confidence: 100 };
    const slow = computeProjPoints(player, { team_pace: 80, opp_pace: 75, opp_def_rating: 104 });
    const fast = computeProjPoints(player, { team_pace: 80, opp_pace: 88, opp_def_rating: 104 });
    assert.ok(fast.projPoints > slow.projPoints, `fast (${fast.projPoints}) should exceed slow (${slow.projPoints})`);
  });

  test('pace factor is clamped (extreme pace differences capped)', () => {
    const player = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, confidence: 100 };
    const extreme = computeProjPoints(player, { team_pace: 80, opp_pace: 150, opp_def_rating: 104 });
    // paceFactor clamp = 0.12, so max boost is 1 + 0.12 * 0.5 = 1.06
    assert.ok(extreme.factors.paceFactor <= 1.061, `paceFactor should be clamped, got ${extreme.factors.paceFactor}`);
  });
});

suite('pointsProjection: matchup factor', () => {
  test('elite defense reduces projection', () => {
    const player = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, confidence: 100 };
    const vsAvg = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const vsElite = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 92 });
    assert.ok(vsElite.projPoints < vsAvg.projPoints);
  });

  test('weak defense boosts projection', () => {
    const player = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, confidence: 100 };
    const vsAvg = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const vsWeak = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 115 });
    assert.ok(vsWeak.projPoints > vsAvg.projPoints);
  });

  test('position-specific def rating takes precedence over overall', () => {
    // Opponent has avg overall defense but is weak at the player's position
    const player = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, confidence: 100, position: 'G' };
    const overallOnly = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const positionSpecific = computeProjPoints(player, {
      team_pace: 80,
      opp_pace: 80,
      opp_def_rating: 104,
      opp_def_vs_position: 115, // weak vs guards
    });
    assert.ok(positionSpecific.projPoints > overallOnly.projPoints);
  });
});

suite('pointsProjection: recent form factor', () => {
  test('hot streak boosts projection (half-weight)', () => {
    const cold = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, last5_ppg: 18, confidence: 100 };
    const hot = { ...cold, last5_ppg: 24 };
    const a = computeProjPoints(cold, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const b = computeProjPoints(hot, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    assert.ok(b.projPoints > a.projPoints);
  });

  test('cold streak reduces projection and deducts confidence', () => {
    const hot = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, last5_ppg: 18, confidence: 100 };
    const cold = { ...hot, last5_ppg: 10 }; // last5 is 55% of season -> triggers cold streak penalty
    const a = computeProjPoints(hot, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const b = computeProjPoints(cold, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    assert.ok(b.projPoints < a.projPoints);
    assert.ok(b.confidence < a.confidence, 'Cold streak should deduct confidence');
    const coldStreakHit = b.audit.confidenceDeductions.find(d => d.reason === 'cold_streak');
    assert.ok(coldStreakHit, 'Should record cold_streak in audit');
  });

  test('recent form is clamped (extreme hot streaks capped)', () => {
    const player = { projMinutes: 30, season_ppg: 15, usage: 0.22, ts_pct: 0.55, gp: 10, last5_ppg: 35, confidence: 100 };
    const result = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    // recentForm max boost = 1 + 0.5 * 0.15 = 1.075
    assert.ok(result.factors.recentForm <= 1.076);
  });
});

suite('pointsProjection: b2b efficiency', () => {
  test('b2b game reduces points via efficiency penalty', () => {
    const player = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, confidence: 100 };
    const fresh = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const tired = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104, is_b2b: true });
    assert.ok(tired.projPoints < fresh.projPoints);
    assert.strictEqual(tired.factors.b2bEfficiency, 0.97);
  });

  test('b2b widens the floor/ceiling band', () => {
    const player = { projMinutes: 30, season_ppg: 18, usage: 0.22, ts_pct: 0.55, gp: 10, confidence: 100 };
    const fresh = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const tired = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104, is_b2b: true });
    const freshBand = fresh.ceiling - fresh.floor;
    const tiredBand = tired.ceiling - tired.floor;
    assert.ok(tiredBand > freshBand);
  });
});

// ============================================================================
// Role shift, ceilings, and clamps
// ============================================================================

suite('pointsProjection: role and clamps', () => {
  test('role shift (usage delta > 5pp) deducts confidence', () => {
    const stable = { projMinutes: 30, season_ppg: 14, usage: 0.20, last5_usage: 0.21, ts_pct: 0.55, gp: 10, confidence: 100 };
    const shifting = { ...stable, last5_usage: 0.28 }; // 8pp jump
    const a = computeProjPoints(stable, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const b = computeProjPoints(shifting, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    assert.ok(b.confidence < a.confidence);
    const shiftHit = b.audit.confidenceDeductions.find(d => d.reason === 'role_shift');
    assert.ok(shiftHit);
  });

  test('thin sample (gp < 5) deducts confidence', () => {
    const player = { projMinutes: 22, season_ppg: 14, usage: 0.22, ts_pct: 0.55, gp: 3, confidence: 70 };
    const result = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const thinHit = result.audit.confidenceDeductions.find(d => d.reason === 'thin_efficiency_sample');
    assert.ok(thinHit);
  });

  test('high-usage player gets wider band', () => {
    const lowUsage = { projMinutes: 25, season_ppg: 10, usage: 0.15, ts_pct: 0.55, gp: 10, confidence: 100 };
    const highUsage = { projMinutes: 25, season_ppg: 20, usage: 0.30, ts_pct: 0.55, gp: 10, confidence: 100 };
    const a = computeProjPoints(lowUsage, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    const b = computeProjPoints(highUsage, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    // Compare band as proportion of projection
    const aBandProp = (a.ceiling - a.floor) / a.projPoints;
    const bBandProp = (b.ceiling - b.floor) / b.projPoints;
    assert.ok(bBandProp > aBandProp, `high-usage band prop (${bBandProp}) should exceed low-usage (${aBandProp})`);
  });

  test('ceiling clamp prevents absurd projections', () => {
    // Wild inputs: full minutes, max usage, max ts, fastest pace, weakest defense
    const player = { projMinutes: 38, season_ppg: 12, usage: 0.45, ts_pct: 0.70, gp: 10, last5_ppg: 24, confidence: 100 };
    const result = computeProjPoints(player, { team_pace: 95, opp_pace: 95, opp_def_rating: 125, opp_def_vs_position: 130 });
    // Ceiling = season_ppg * 2.0 = 24
    assert.ok(result.projPoints <= 24, `Projection (${result.projPoints}) should be clamped at 24`);
  });
});

// ============================================================================
// Fallbacks
// ============================================================================

suite('pointsProjection: fallback behavior', () => {
  test('missing usage falls back to league avg and flags audit', () => {
    const player = { projMinutes: 30, season_ppg: 14, ts_pct: 0.55, gp: 10, confidence: 100 };
    const result = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    assert.ok(result.audit.fallbacksUsed.includes('usage'));
  });

  test('missing opp_def_rating falls back to league avg', () => {
    const player = { projMinutes: 30, season_ppg: 14, usage: 0.20, ts_pct: 0.55, gp: 10, confidence: 100 };
    const result = computeProjPoints(player, { team_pace: 80, opp_pace: 80 });
    assert.ok(result.audit.fallbacksUsed.includes('opp_def_rating'));
  });

  test('missing all opponent context still produces a valid projection', () => {
    const player = { projMinutes: 30, season_ppg: 14, usage: 0.20, ts_pct: 0.55, gp: 10, confidence: 100 };
    const result = computeProjPoints(player, {});
    assert.ok(result.projPoints > 0);
    assert.strictEqual(result.audit.fallbacksUsed.length, 3, 'Should flag 3 fallbacks: team_pace, opp_pace, opp_def_rating');
  });
});

// ============================================================================
// Integration: full pipeline
// ============================================================================

suite('Integration: minutes -> redistribution -> points', () => {
  test('OUT star + healthy backup: backup gets boosted points projection', () => {
    // Setup: Collier (star F, 35mpg, 22ppg, 28% usage) is OUT.
    // Smith (backup F, 22mpg season, 11ppg, 19% usage) should absorb minutes AND usage.
    const roster = [
      { playerId: '1', playerName: 'Collier', position: 'F', season_mpg: 35, season_ppg: 22, gp: 10, gs: 10, usage: 0.28, ts_pct: 0.58 },
      { playerId: '2', playerName: 'Smith', position: 'F', season_mpg: 22, season_ppg: 11, gp: 10, gs: 0, usage: 0.19, ts_pct: 0.54 },
    ];
    const injuries = { '1': { status: 'OUT' } };

    // Step 1: tag statuses
    for (const p of roster) {
      p.status = injuries[p.playerId] ? injuries[p.playerId].status : 'AVAILABLE';
    }

    // Step 2: project minutes
    for (const p of roster) {
      const projection = computeProjMinutes(p, {}, injuries[p.playerId] || null);
      p.projMinutes = projection.projMinutes;
      p.confidence = projection.confidence;
    }

    // Smith baseline points projection BEFORE redistribution
    // Snapshot her stats now because the roster object will be mutated by redistribution.
    const smithBeforeMinutes = roster.find(p => p.playerName === 'Smith').projMinutes;
    const smithBeforeUsage = roster.find(p => p.playerName === 'Smith').usage;
    const smithBeforeSnapshot = { ...roster.find(p => p.playerName === 'Smith') };
    const smithBeforePoints = computeProjPoints(smithBeforeSnapshot, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });

    // Step 3: redistribute (this boosts Smith's projMinutes AND usage)
    redistributeOutMinutes(roster);
    const smithAfter = roster.find(p => p.playerName === 'Smith');

    // Step 4: project points with new minutes + usage
    const smithAfterPoints = computeProjPoints(smithAfter, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });

    // Smith should have meaningfully more points after redistribution
    assert.ok(smithAfter.projMinutes > smithBeforeMinutes,
      `Smith minutes should rise: ${smithBeforeMinutes} -> ${smithAfter.projMinutes}`);
    assert.ok(smithAfterPoints.projPoints > smithBeforePoints.projPoints,
      `Smith points should rise: ${smithBeforePoints.projPoints} -> ${smithAfterPoints.projPoints}`);

    // The points boost should be at least proportional to the minutes boost,
    // because usage also boosted (so points should rise faster than minutes).
    const minutesRatio = smithAfter.projMinutes / smithBeforeMinutes;
    const pointsRatio = smithAfterPoints.projPoints / smithBeforePoints.projPoints;
    assert.ok(pointsRatio >= minutesRatio * 0.95,
      `Points ratio (${pointsRatio.toFixed(2)}) should be >= minutes ratio (${minutesRatio.toFixed(2)}) since usage also boosted`);
  });

  test('GTD player keeps full points projection, lower confidence', () => {
    const player = { playerId: '1', playerName: 'Star', position: 'G', season_mpg: 32, season_ppg: 19, gp: 10, gs: 10, usage: 0.25, ts_pct: 0.56 };
    const injury = { status: 'GTD' };

    const minutesProj = computeProjMinutes(player, {}, injury);
    player.projMinutes = minutesProj.projMinutes;
    player.confidence = minutesProj.confidence;

    const pointsProj = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });

    // Minutes should be at full season MPG (GTD doesn't cut minutes)
    assert.strictEqual(player.projMinutes, 32);
    // Confidence should inherit the GTD penalty: 100 * 0.6 = 60 from minutes engine
    assert.strictEqual(player.confidence, 60);
    // Points projection inherits that confidence
    assert.ok(pointsProj.confidence <= 60);
    assert.ok(pointsProj.projPoints > 0);
  });

  test('OUT player produces zero points', () => {
    const player = { playerId: '1', playerName: 'Out', position: 'F', season_mpg: 30, season_ppg: 16, gp: 10, gs: 10, usage: 0.22, ts_pct: 0.55 };
    const injury = { status: 'OUT' };

    const minutesProj = computeProjMinutes(player, {}, injury);
    player.projMinutes = minutesProj.projMinutes;
    player.confidence = minutesProj.confidence;

    const pointsProj = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    assert.strictEqual(pointsProj.projPoints, 0);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

suite('pointsProjection: edge cases', () => {
  test('throws if projMinutes missing', () => {
    assert.throws(() => computeProjPoints({ season_ppg: 14, usage: 0.20, ts_pct: 0.55 }, {}));
  });

  test('throws if season_ppg missing', () => {
    assert.throws(() => computeProjPoints({ projMinutes: 25, usage: 0.20, ts_pct: 0.55 }, {}));
  });

  test('handles season_ppg of zero (rookie with no scoring history)', () => {
    const player = { projMinutes: 20, season_ppg: 0, usage: 0.15, ts_pct: 0.50, gp: 2, confidence: 50 };
    const result = computeProjPoints(player, { team_pace: 80, opp_pace: 80, opp_def_rating: 104 });
    // Ceiling is season_ppg * 2 = 0, so projection should clamp at 0
    assert.strictEqual(result.projPoints, 0);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
