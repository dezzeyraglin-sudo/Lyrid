// api/wnba/debug-wnba-data.js
//
// DEBUG ENDPOINT (June 1, 2026)
//
// Verifies the basketball-reference migrations are LIVE and returning real data
// — not the neutral fallbacks that caused the WEAK / ROLE 37 / ENV 50 /
// MATCHUP 44 spam. Hit /api/wnba/debug-wnba-data in a browser after deploying
// the three migrated modules (wnbaTeamData.js, wnbaGameLog.js, wnbaPlayerData.js).
//
// Optional query: ?team=PHX  (defaults to LVA)
//
// For each of the three feeds it answers one question: real data or fallback?
//   TEAM   → did pace get DERIVED from possessions (real) or fall back to 80?
//            is the opponent table being read (source = basketball-reference)?
//   PLAYER → are the newly-surfaced fields populated (position, tsPct, fta)?
//            If these are null/0, the wnbaPlayerData field fix isn't deployed.
//   RECENT → did the game-log page return any games? (0 = wnbaGameLog not working)
//
// Safe to leave deployed: read-only, no secrets.

import { getAllTeamStats, getTeamStats } from '../_lib/wnba/wnbaTeamData.js';
import { getTopPlayersForTeam } from '../_lib/wnba/wnbaPlayerData.js';
import { aggregateRecentForm } from '../_lib/wnba/wnbaGameLog.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const team = (url.searchParams.get('team') || 'LVA').toUpperCase();
  const season = Number(url.searchParams.get('season')) || 2026;

  const out = { ok: true, team, season, checks: {} };

  // ---- CHECK 1: TEAM STATS (wnbaTeamData.js) ----
  try {
    const all = await getAllTeamStats(season);
    const teamsReturned = Object.keys(all).length;
    const t = all[team] || null;
    const paceSource = t?._raw?.paceSource || null;
    const source = t?._raw?.source || null;

    // Real if the opponent table parsed AND pace was derived (not the 80 default).
    const looksReal = !!t && source === 'basketball-reference'
      && (paceSource === 'derived_possessions' || paceSource === 'derived_team_only')
      && Number.isFinite(t.pace) && t.pace !== 80;

    out.checks.teamStats = {
      verdict: teamsReturned === 0 ? 'EMPTY — module returning nothing'
        : looksReal ? 'LIVE — real bbref data'
        : 'FALLBACK — parsed but using defaults (check table id / opp_ columns)',
      teamsReturned,
      sample: t ? {
        pace: t.pace, offRating: t.offRating, defRating: t.defRating,
        reboundAllowed: t.reboundAllowed, rimProtection: t.rimProtection,
        paceSource, source
      } : null,
    };
  } catch (err) {
    out.checks.teamStats = { verdict: 'ERROR', error: err.message };
  }

  // ---- CHECK 2: PLAYER FIELD FIXES (wnbaPlayerData.js) ----
  let topPlayer = null;
  try {
    const players = await getTopPlayersForTeam(team, 3, season, 'points');
    topPlayer = players[0] || null;

    const hasPosition = topPlayer?.position != null;
    const hasTsPct = topPlayer?.tsPct != null && topPlayer.tsPct > 0;
    const hasFta = Number(topPlayer?.fta) > 0;

    out.checks.playerFields = {
      verdict: !topPlayer ? 'EMPTY — no players for team'
        : (hasTsPct && hasFta) ? 'LIVE — new fields surfaced'
        : 'PARTIAL — some new fields still null (check mergePlayerStats edits)',
      playersReturned: players.length,
      sample: topPlayer ? {
        name: topPlayer.name, id: topPlayer.id,
        position: topPlayer.position,          // null = bbref had no pos column (acceptable)
        tsPct: topPlayer.tsPct,                 // null/0 = field fix not deployed
        fta: topPlayer.fta, ftm: topPlayer.ftm, // 0 = field fix not deployed
        usageRate: topPlayer.usageRate, seasonAvg: topPlayer.seasonAvg
      } : null,
      note: 'position may be null if bbref per-game table has no pos column; tsPct/fta are the load-bearing checks.'
    };
  } catch (err) {
    out.checks.playerFields = { verdict: 'ERROR', error: err.message };
  }

  // ---- CHECK 3: RECENT FORM / GAME LOGS (wnbaGameLog.js) ----
  try {
    if (!topPlayer?.id) {
      out.checks.recentForm = { verdict: 'SKIPPED — no player id to look up', };
    } else {
      const rf = await aggregateRecentForm(topPlayer.id, 10, 'points', season);
      out.checks.recentForm = {
        verdict: !rf ? 'EMPTY — game log returned no games (check slug path / table id)'
          : rf.gamesUsed > 0 ? 'LIVE — game logs flowing'
          : 'EMPTY — zero games',
        player: topPlayer.name,
        sample: rf ? {
          gamesUsed: rf.gamesUsed, recentAvg: rf.recentAvg,
          minutesAvg: rf.minutesAvg, minutesCv: rf.minutesCv,
          last5Avg: rf.last5Avg, last10Avg: rf.last10Avg
        } : null,
      };
    }
  } catch (err) {
    out.checks.recentForm = { verdict: 'ERROR', error: err.message };
  }

  // ---- OVERALL ----
  const verdicts = Object.values(out.checks).map(c => c.verdict || '');
  out.summary = verdicts.every(v => v.startsWith('LIVE'))
    ? 'ALL LIVE — migrations deployed and returning real data. The WEAK/FRAGILE spam should be gone.'
    : 'NOT ALL LIVE — see each check. Anything FALLBACK/EMPTY/ERROR means that module needs attention before the slate shows real scores.';

  return res.status(200).json(out);
}
