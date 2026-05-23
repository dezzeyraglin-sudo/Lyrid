/**
 * Tests for basketball injury + minutes engine.
 *
 * Covers:
 *  - injuryFeed parser (fixture round-trip, status normalization, team mapping)
 *  - minutesProjection (formula correctness, injury modifiers, blowout logic)
 *  - teammateRedistribution (the 5 spec test cases)
 *
 * Run with: node test/basketball.test.js
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { parseEspnInjuriesPayload, extractInjuriesFromHtml, normalizeStatus } from '../api/_lib/basketball/injuryFeed.js';
import { computeProjMinutes } from '../api/_lib/basketball/minutesProjection.js';
import { redistributeOutMinutes, findBackfillRecipients } from '../api/_lib/basketball/teammateRedistribution.js';

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
// injuryFeed tests
// ============================================================================

const fixturePath = path.join(__dirname, 'fixtures', 'espn-wnba-injuries-2026-05-19.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

suite('injuryFeed: parseEspnInjuriesPayload', () => {
  test('parses fixture without error', () => {
    const result = parseEspnInjuriesPayload(fixture);
    assert.ok(result);
    assert.strictEqual(result.source, 'espn');
  });

  test('finds all 12 players from the May 19 fixture', () => {
    // 9 teams: ATL(1) + CHI(2) + DAL(2) + GSV(1) + IND(2) + NYL(1) + SEA(1) + TOR(1) + WAS(1) = 12
    const result = parseEspnInjuriesPayload(fixture);
    assert.strictEqual(result.all.length, 12);
    assert.strictEqual(result._audit.playerCount, 12);
  });

  test('finds all 9 teams from the fixture', () => {
    const result = parseEspnInjuriesPayload(fixture);
    assert.strictEqual(result._audit.teamCount, 9);
  });

  test('indexes Rhyne Howard correctly by ESPN player id', () => {
    const result = parseEspnInjuriesPayload(fixture);
    const howard = result.byPlayerId['4398674'];
    assert.ok(howard, 'Howard should be indexed by player id 4398674');
    assert.strictEqual(howard.playerName, 'Rhyne Howard');
    assert.strictEqual(howard.position, 'G');
    assert.strictEqual(howard.teamAbbrev, 'ATL');
    assert.strictEqual(howard.status, 'GTD');
  });

  test('maps Toronto Tempo (new expansion team) correctly', () => {
    const result = parseEspnInjuriesPayload(fixture);
    const sabally = result.byPlayerId['4398768'];
    assert.ok(sabally);
    assert.strictEqual(sabally.teamAbbrev, 'TOR');
    assert.strictEqual(sabally.teamName, 'Toronto Tempo');
  });

  test('preserves reporter comments where present', () => {
    const result = parseEspnInjuriesPayload(fixture);
    const jackson = result.byPlayerId['4433630'];
    assert.ok(jackson.comment.includes('MRI'));
  });

  test('handles empty comments without crashing', () => {
    const result = parseEspnInjuriesPayload(fixture);
    const howard = result.byPlayerId['4398674'];
    assert.strictEqual(howard.comment, '');
  });

  test('groups by team abbrev correctly (Chicago has 2 players)', () => {
    const result = parseEspnInjuriesPayload(fixture);
    assert.strictEqual(result.byTeamAbbrev['CHI'].length, 2);
  });

  test('preserves ESPN type id for audit', () => {
    const result = parseEspnInjuriesPayload(fixture);
    const howard = result.byPlayerId['4398674'];
    assert.strictEqual(howard.espnTypeId, '6');
  });
});

suite('injuryFeed: normalizeStatus', () => {
  test('maps type.id "6" to GTD', () => {
    assert.strictEqual(normalizeStatus('6', 'Day-To-Day'), 'GTD');
  });
  test('maps type.id "7" to OUT', () => {
    assert.strictEqual(normalizeStatus('7', 'Out'), 'OUT');
  });
  test('maps type.id "8" to DOUBTFUL', () => {
    assert.strictEqual(normalizeStatus('8', 'Doubtful'), 'DOUBTFUL');
  });
  test('maps type.id "9" to PROBABLE', () => {
    assert.strictEqual(normalizeStatus('9', 'Probable'), 'PROBABLE');
  });
  test('falls back to statusDesc text when type.id unknown', () => {
    assert.strictEqual(normalizeStatus(null, 'Out for season'), 'OUT');
    assert.strictEqual(normalizeStatus('999', 'Probable'), 'PROBABLE');
  });
  test('defaults to GTD when both are unknown (safest default)', () => {
    assert.strictEqual(normalizeStatus(null, 'something weird'), 'GTD');
  });
});

suite('injuryFeed: extractInjuriesFromHtml', () => {
  test('extracts JSON from a minimal valid HTML page', () => {
    const payload = { page: { content: { injuries: [{ displayName: 'Atlanta Dream', items: [] }] } } };
    const html = `<html><body><script>window['__espnfitt__']=${JSON.stringify(payload)};</script></body></html>`;
    const result = extractInjuriesFromHtml(html);
    assert.ok(result.injuries);
    assert.strictEqual(result.injuries.length, 1);
    assert.strictEqual(result.injuries[0].displayName, 'Atlanta Dream');
  });

  test('handles nested braces and string escapes inside the JSON', () => {
    const payload = { page: { content: { injuries: [{ displayName: 'X', items: [{ description: 'has "quotes" and {braces}' }] }] } } };
    const html = `<html><body><script>window['__espnfitt__']=${JSON.stringify(payload)};</script></body></html>`;
    const result = extractInjuriesFromHtml(html);
    assert.strictEqual(result.injuries[0].items[0].description, 'has "quotes" and {braces}');
  });

  test('throws if __espnfitt__ marker is missing', () => {
    assert.throws(() => extractInjuriesFromHtml('<html><body>no payload here</body></html>'));
  });

  test('throws if page.content.injuries is missing', () => {
    const html = `<html><script>window['__espnfitt__']={"some":"other","shape":true};</script></html>`;
    assert.throws(() => extractInjuriesFromHtml(html));
  });
});

// ============================================================================
// minutesProjection tests
// ============================================================================

suite('minutesProjection: basic formula', () => {
  test('healthy starter gets full minutes', () => {
    const player = { season_mpg: 32, gp: 10, gs: 10 };
    const result = computeProjMinutes(player);
    // roleStability = 1.00 (all starts), other factors = 1.00
    // expected: 32 * 1.0 = 32
    assert.strictEqual(result.projMinutes, 32);
    assert.strictEqual(result.confidence, 100);
  });

  test('pure bench player gets reduced via role-stability factor', () => {
    const player = { season_mpg: 15, gp: 10, gs: 0 };
    const result = computeProjMinutes(player);
    // roleStability = 0.85, expected: 15 * 0.85 = 12.75 -> 12.8
    assert.strictEqual(result.projMinutes, 12.8);
  });

  test('confidence drops for small sample (gp < 5)', () => {
    const player = { season_mpg: 25, gp: 3, gs: 3 };
    const result = computeProjMinutes(player);
    // confidence starts 100, -30 for small sample
    assert.strictEqual(result.confidence, 70);
  });

  test('confidence drops for role ambiguity (gs/gp between 0.3 and 0.7)', () => {
    const player = { season_mpg: 22, gp: 10, gs: 5 };
    const result = computeProjMinutes(player);
    // gs/gp = 0.5 -> role ambiguity penalty
    assert.strictEqual(result.confidence, 85);
  });

  test('confidence is floored at 30', () => {
    const player = { season_mpg: 10, gp: 2, gs: 0, last5_std: 6, first_game_back: true };
    const result = computeProjMinutes(player);
    // -30 small sample, -10 variance, -10 first game back = 50, no role ambiguity penalty (gs/gp=0)
    // No injury modifier so 50 stays
    assert.ok(result.confidence >= 30);
  });

  test('b2b penalty reduces minutes by 4%', () => {
    const playerNo = { season_mpg: 30, gp: 10, gs: 10 };
    const playerB2B = { season_mpg: 30, gp: 10, gs: 10, is_b2b: true };
    const a = computeProjMinutes(playerNo);
    const b = computeProjMinutes(playerB2B);
    assert.ok(b.projMinutes < a.projMinutes);
    assert.strictEqual(b.projMinutes, round1(30 * 0.96));
  });

  test('position cap prevents unrealistic projections', () => {
    const player = { season_mpg: 36, gp: 10, gs: 10, last5_mpg: 42, days_rest: 5 };
    const result = computeProjMinutes(player);
    assert.ok(result.projMinutes <= 38);
  });

  test('blowout reduces starter minutes when spread > 10', () => {
    const player = { season_mpg: 32, gp: 10, gs: 10 };
    const normal = computeProjMinutes(player, { spread: -3 });
    const blowout = computeProjMinutes(player, { spread: -16 });
    assert.ok(blowout.projMinutes < normal.projMinutes);
  });

  test('blowout boosts bench minutes when spread > 10', () => {
    const player = { season_mpg: 12, gp: 10, gs: 0 };
    const normal = computeProjMinutes(player, { spread: -3 });
    const blowout = computeProjMinutes(player, { spread: -16 });
    assert.ok(blowout.projMinutes > normal.projMinutes);
  });

  test('blowout does not fire below threshold (spread of 10 exact)', () => {
    const player = { season_mpg: 32, gp: 10, gs: 10 };
    const normal = computeProjMinutes(player, { spread: -3 });
    const edge = computeProjMinutes(player, { spread: -10 });
    assert.strictEqual(edge.projMinutes, normal.projMinutes);
  });
});

suite('minutesProjection: injury modifiers', () => {
  test('AVAILABLE (no injury) is identical to no injury record', () => {
    const player = { season_mpg: 30, gp: 10, gs: 10 };
    const a = computeProjMinutes(player, {}, null);
    const b = computeProjMinutes(player, {}, { status: 'AVAILABLE' });
    assert.strictEqual(a.projMinutes, b.projMinutes);
    assert.strictEqual(a.confidence, b.confidence);
  });

  test('PROBABLE keeps minutes but drops confidence to 90%', () => {
    const player = { season_mpg: 30, gp: 10, gs: 10 };
    const a = computeProjMinutes(player, {}, null);
    const probable = computeProjMinutes(player, {}, { status: 'PROBABLE' });
    assert.strictEqual(probable.projMinutes, a.projMinutes);
    assert.strictEqual(probable.confidence, 90);
  });

  test('GTD keeps full minutes (caller decides activation), confidence x 0.6', () => {
    const player = { season_mpg: 30, gp: 10, gs: 10 };
    const gtd = computeProjMinutes(player, {}, { status: 'GTD' });
    assert.strictEqual(gtd.projMinutes, 30);
    assert.strictEqual(gtd.confidence, 60); // 100 * 0.6
  });

  test('DOUBTFUL halves minutes and drops confidence to 40%', () => {
    const player = { season_mpg: 30, gp: 10, gs: 10 };
    const doubtful = computeProjMinutes(player, {}, { status: 'DOUBTFUL' });
    assert.strictEqual(doubtful.projMinutes, 15);
    assert.strictEqual(doubtful.confidence, 40);
  });

  test('OUT short-circuits to zero with audit note', () => {
    const player = { season_mpg: 30, gp: 10, gs: 10 };
    const out = computeProjMinutes(player, {}, { status: 'OUT' });
    assert.strictEqual(out.projMinutes, 0);
    assert.strictEqual(out.confidence, 0);
    assert.ok(out.audit.reason.includes('redistributed'));
  });

  test('floor/ceiling band is wider for GTD than for AVAILABLE', () => {
    const player = { season_mpg: 30, gp: 10, gs: 10 };
    const available = computeProjMinutes(player, {}, { status: 'AVAILABLE' });
    const gtd = computeProjMinutes(player, {}, { status: 'GTD' });
    const availableBand = available.ceiling - available.floor;
    const gtdBand = gtd.ceiling - gtd.floor;
    assert.ok(gtdBand > availableBand, `GTD band (${gtdBand}) should exceed AVAILABLE band (${availableBand})`);
  });
});

// ============================================================================
// teammateRedistribution tests -- the 5 spec cases
// ============================================================================

suite('teammateRedistribution: the 5 spec test cases', () => {

  test('Case 1: Star OUT -> backup gets boosted projection', () => {
    // Collier (F, 35mpg) OUT. Two F teammates: Smith (22mpg) and Jones (15mpg).
    const roster = [
      { playerId: '1', playerName: 'Collier', position: 'F', projMinutes: 0, season_mpg: 35, status: 'OUT', is_starter: true },
      { playerId: '2', playerName: 'Smith', position: 'F', projMinutes: 22, season_mpg: 22, status: 'AVAILABLE' },
      { playerId: '3', playerName: 'Jones', position: 'F', projMinutes: 15, season_mpg: 15, status: 'AVAILABLE' },
    ];
    const { audit } = redistributeOutMinutes(roster);
    const smith = roster.find(p => p.playerName === 'Smith');
    const jones = roster.find(p => p.playerName === 'Jones');
    // vacatedMinutes = 35 * 0.85 = 29.75
    // Smith (top backup by mpg) gets 50% * 29.75 = ~14.9 -> 22 + 14.9 = 36.9
    // Jones gets 30% * 29.75 = ~8.9 -> 15 + 8.9 = 23.9
    assert.ok(smith.projMinutes > 30, `Smith should be boosted; got ${smith.projMinutes}`);
    assert.ok(jones.projMinutes > 15, `Jones should be boosted; got ${jones.projMinutes}`);
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].outPlayer, 'Collier');
  });

  test('Case 2: GTD that plays -> normal projection with flag, confidence x 0.6', () => {
    // GTD doesn't trigger redistribution; it's tested in minutesProjection above.
    // Here we just verify the redistribution function doesn't touch GTD players.
    const roster = [
      { playerId: '1', playerName: 'Star', position: 'F', projMinutes: 30, season_mpg: 30, status: 'GTD' },
      { playerId: '2', playerName: 'Backup', position: 'F', projMinutes: 18, season_mpg: 18, status: 'AVAILABLE' },
    ];
    const before = roster.map(p => p.projMinutes);
    redistributeOutMinutes(roster);
    const after = roster.map(p => p.projMinutes);
    assert.deepStrictEqual(after, before, 'GTD should not trigger redistribution');
  });

  test('Case 3: GTD that scratches at tip -> simulated by changing status to OUT and re-running', () => {
    // Simulates the pre-tip refresh: roster had GTD, news drops, status becomes OUT, re-run.
    const roster = [
      { playerId: '1', playerName: 'Star', position: 'F', projMinutes: 30, season_mpg: 30, status: 'OUT' },
      { playerId: '2', playerName: 'Backup', position: 'F', projMinutes: 18, season_mpg: 18, status: 'AVAILABLE' },
    ];
    // First, the OUT player would have been zeroed by computeProjMinutes:
    roster[0].projMinutes = 0;
    redistributeOutMinutes(roster);
    const backup = roster.find(p => p.playerName === 'Backup');
    assert.ok(backup.projMinutes > 18, 'Backup should receive vacated minutes');
    assert.ok(backup._engineAudit && backup._engineAudit.absorbedMinutes.length === 1);
    assert.strictEqual(backup._engineAudit.absorbedMinutes[0].fromPlayer, 'Star');
  });

  test('Case 4: Two simultaneous same-position OUTs -> backup capped at 38min', () => {
    const roster = [
      { playerId: '1', playerName: 'Star1', position: 'F', projMinutes: 0, season_mpg: 32, status: 'OUT' },
      { playerId: '2', playerName: 'Star2', position: 'F', projMinutes: 0, season_mpg: 30, status: 'OUT' },
      { playerId: '3', playerName: 'OnlyBackup', position: 'F', projMinutes: 20, season_mpg: 20, status: 'AVAILABLE' },
    ];
    redistributeOutMinutes(roster);
    const backup = roster.find(p => p.playerName === 'OnlyBackup');
    assert.ok(backup.projMinutes <= 38, `Backup should be capped at 38; got ${backup.projMinutes}`);
    // She should have absorbed minutes from both OUT players
    assert.ok(backup._engineAudit.absorbedMinutes.length === 2);
  });

  test('Case 5: No injuries -> clean engine run, audit empty', () => {
    const roster = [
      { playerId: '1', playerName: 'A', position: 'G', projMinutes: 30, season_mpg: 30, status: 'AVAILABLE' },
      { playerId: '2', playerName: 'B', position: 'F', projMinutes: 28, season_mpg: 28, status: 'AVAILABLE' },
      { playerId: '3', playerName: 'C', position: 'C', projMinutes: 25, season_mpg: 25, status: 'AVAILABLE' },
    ];
    const { audit } = redistributeOutMinutes(roster);
    assert.strictEqual(audit.length, 0);
    // No projMinutes should have changed
    assert.strictEqual(roster[0].projMinutes, 30);
    assert.strictEqual(roster[1].projMinutes, 28);
    assert.strictEqual(roster[2].projMinutes, 25);
  });
});

suite('teammateRedistribution: position adjacency', () => {
  test('missing PG is backfilled by SGs when no other PGs available', () => {
    const roster = [
      { playerId: '1', playerName: 'StarterPG', position: 'PG', projMinutes: 0, season_mpg: 32, status: 'OUT' },
      { playerId: '2', playerName: 'SG1', position: 'SG', projMinutes: 28, season_mpg: 28, status: 'AVAILABLE' },
      { playerId: '3', playerName: 'PF1', position: 'PF', projMinutes: 22, season_mpg: 22, status: 'AVAILABLE' },
    ];
    redistributeOutMinutes(roster);
    const sg = roster.find(p => p.playerName === 'SG1');
    const pf = roster.find(p => p.playerName === 'PF1');
    assert.ok(sg.projMinutes > 28, 'SG should backfill missing PG');
    assert.strictEqual(pf.projMinutes, 22, 'PF should NOT backfill missing PG (too far in chain)');
  });

  test('findBackfillRecipients returns no recipients when no eligible teammates exist', () => {
    const out = { playerName: 'Lonely', position: 'C', status: 'OUT' };
    const roster = [
      out,
      { playerName: 'Guard1', position: 'PG', season_mpg: 30, status: 'AVAILABLE' },
    ];
    // C chain is ['C', 'PF']. No C or PF in roster -> empty.
    const recipients = findBackfillRecipients(roster, out);
    assert.strictEqual(recipients.length, 0);
  });
});

// ============================================================================
// Integration test: full slate workflow
// ============================================================================

suite('Integration: injury feed -> minutes projection -> redistribution', () => {
  test('Indiana Fever slate run with Aliyah Boston injury', () => {
    const injuryReport = parseEspnInjuriesPayload(fixture);
    // Build a mini Fever roster (mock season data)
    const roster = [
      { playerId: '4432831', playerName: 'Aliyah Boston', position: 'C', season_mpg: 32, gp: 10, gs: 10 },
      { playerId: 'X', playerName: 'BackupC', position: 'C', season_mpg: 14, gp: 10, gs: 0 },
      { playerId: '4433546', playerName: 'Makayla Timpson', position: 'F', season_mpg: 18, gp: 10, gs: 0 },
      { playerId: 'Y', playerName: 'BackupF', position: 'F', season_mpg: 12, gp: 10, gs: 0 },
    ];

    // Step 1: tag each player with injury status from feed
    for (const p of roster) {
      const injury = injuryReport.byPlayerId[p.playerId];
      p.status = injury ? injury.status : 'AVAILABLE';
    }

    // Boston and Timpson should both be tagged GTD from the fixture
    const boston = roster.find(p => p.playerName === 'Aliyah Boston');
    const timpson = roster.find(p => p.playerName === 'Makayla Timpson');
    assert.strictEqual(boston.status, 'GTD', `Boston status: ${boston.status}`);
    assert.strictEqual(timpson.status, 'GTD', `Timpson status: ${timpson.status}`);

    // Step 2: project minutes per player (GTD keeps full minutes, lower confidence)
    for (const p of roster) {
      const injury = injuryReport.byPlayerId[p.playerId];
      const projection = computeProjMinutes(p, {}, injury);
      p.projMinutes = projection.projMinutes;
      p.confidence = projection.confidence;
    }

    // Boston still projects to a real number (GTD doesn't zero her)
    assert.ok(boston.projMinutes > 0);
    // But her confidence is at most 60 (100 * 0.6 for GTD)
    assert.ok(boston.confidence <= 60);

    // Step 3: redistribute -- no OUT players in this fixture so nothing should change
    const { audit } = redistributeOutMinutes(roster);
    assert.strictEqual(audit.length, 0, 'No OUT players in May 19 fixture -> no redistribution');
  });
});

// ============================================================================
// Run + summarize
// ============================================================================

function round1(x) { return Math.round(x * 10) / 10; }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
