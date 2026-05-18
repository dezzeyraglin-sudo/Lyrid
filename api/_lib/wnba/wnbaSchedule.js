// api/_lib/wnba/wnbaSchedule.js
//
// WNBA SCHEDULE FETCHER (May 16, 2026 — Session 4)
//
// Provides today's games (and recent/upcoming) from stats.wnba.com's
// scoreboard endpoint.
//
// CRITICAL CAVEAT:
//   stats.wnba.com's scoreboard endpoint returns matchup data (teams, IDs,
//   game time, home/away) but does NOT return betting lines (spread/total).
//   The slate endpoint will require the caller to inject lines, or default
//   them to neutral values (spread=0, total=164 WNBA avg).
//
// ENDPOINTS USED:
//   /stats/scoreboardv3 — modern scoreboard with full game info
//   /stats/scoreboardv2 — fallback if v3 is sparse

import { fetchWnbaStats, parseResultSet, _testing as apiTesting } from './wnbaStatsApi.js';

// =============================================================
// CORE SCHEDULE FETCHER
// =============================================================

/**
 * Get games for a specific date.
 *
 * @param {string} date - YYYY-MM-DD format (e.g. "2026-05-16")
 * @returns {Promise<Array<Object>>} array of game objects
 */
export async function getGamesForDate(date) {
  // stats.wnba.com expects MM/DD/YYYY format for the GameDate param
  const formatted = formatDateForApi(date);

  const response = await fetchWnbaStats('/scoreboardv3', {
    LeagueID: '10',
    GameDate: formatted,
    DayOffset: '0'
  }, { ttlMs: apiTesting.TTL.schedule });

  if (!response) return [];

  // scoreboardv3 has a different response shape from leaguedash endpoints.
  // It returns a structured object with `scoreboard.games[]` rather than
  // resultSets. Try both shapes for resilience.
  let games = [];
  if (response.scoreboard?.games && Array.isArray(response.scoreboard.games)) {
    games = response.scoreboard.games;
  } else if (response.resultSets) {
    // Older v2-style fallback
    games = parseResultSet(response, 'GameHeader');
  }

  return games.map(normalizeGame);
}

/**
 * Get today's games (convenience wrapper).
 */
export async function getTodaysGames() {
  const today = new Date().toISOString().split('T')[0];
  return getGamesForDate(today);
}

/**
 * Get games for the next N days (today + N).
 * Useful for "what's upcoming this week" views.
 */
export async function getUpcomingGames(daysAhead = 0) {
  const results = [];
  for (let i = 0; i <= daysAhead; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const games = await getGamesForDate(d.toISOString().split('T')[0]);
    results.push(...games);
  }
  return results;
}

// =============================================================
// NORMALIZATION
// =============================================================
// scoreboardv3 returns games in a nested shape. Flatten it into a
// consistent format the slate endpoint can consume.

function normalizeGame(g) {
  // scoreboardv3 shape:
  //   { gameId, gameStatus, gameStatusText, period, gameClock,
  //     gameTimeUTC, gameEt, awayTeam: {teamId, teamName, teamCity, teamTricode, score},
  //     homeTeam: {...}, ... }
  // scoreboardv2 (older) shape:
  //   GAME_ID, GAME_DATE_EST, HOME_TEAM_ID, VISITOR_TEAM_ID, GAME_STATUS_ID, etc.

  // Detect shape and normalize accordingly
  if (g.gameId !== undefined) {
    // v3 shape
    return {
      gameId: String(g.gameId),
      status: g.gameStatusText || statusLabel(g.gameStatus),
      gameStatus: Number(g.gameStatus),  // 1=upcoming, 2=live, 3=final
      gameTimeUTC: g.gameTimeUTC || null,
      gameTimeET: g.gameEt || null,
      home: {
        id: g.homeTeam?.teamId ? Number(g.homeTeam.teamId) : null,
        abbr: g.homeTeam?.teamTricode || null,
        name: g.homeTeam?.teamName || null,
        score: Number(g.homeTeam?.score ?? 0)
      },
      away: {
        id: g.awayTeam?.teamId ? Number(g.awayTeam.teamId) : null,
        abbr: g.awayTeam?.teamTricode || null,
        name: g.awayTeam?.teamName || null,
        score: Number(g.awayTeam?.score ?? 0)
      },
      // Betting lines NOT in this endpoint — caller must inject
      spread: null,
      total: null,
      _shape: 'v3'
    };
  }

  // v2 fallback shape
  return {
    gameId: String(g.GAME_ID || ''),
    status: g.GAME_STATUS_TEXT || statusLabel(g.GAME_STATUS_ID),
    gameStatus: Number(g.GAME_STATUS_ID),
    gameTimeUTC: g.GAME_DATE_EST || null,
    gameTimeET: g.GAME_STATUS_TEXT || null,
    home: {
      id: g.HOME_TEAM_ID ? Number(g.HOME_TEAM_ID) : null,
      abbr: null,  // not in this row; needs roster lookup
      name: null,
      score: 0
    },
    away: {
      id: g.VISITOR_TEAM_ID ? Number(g.VISITOR_TEAM_ID) : null,
      abbr: null,
      name: null,
      score: 0
    },
    spread: null,
    total: null,
    _shape: 'v2'
  };
}

function statusLabel(statusId) {
  // 1 = upcoming, 2 = live, 3 = final
  const n = Number(statusId);
  if (n === 1) return 'Upcoming';
  if (n === 2) return 'Live';
  if (n === 3) return 'Final';
  return 'Unknown';
}

function formatDateForApi(isoDate) {
  // ISO format "2026-05-16" → API format "05/16/2026"
  const parts = String(isoDate).split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

// =============================================================
// EXPORTS FOR TESTING
// =============================================================

export const _testing = {
  normalizeGame,
  statusLabel,
  formatDateForApi
};
