// api/_lib/wnba/wnbaGameLog.js
//
// WNBA PLAYER GAME LOG MODULE (May 16, 2026 — Session 2)
//
// Provides last N games of stats for a player. Parallel to MLB Wave 4's
// recentForm.js data fetching.
//
// Used downstream by basketballRecentForm.js (Session 3) to compute hot/cold
// classifications using the same architecture as MLB recent-form weighting.

import { fetchWnbaStats, parseResultSet, _testing as apiTesting } from './wnbaStatsApi.js';

/**
 * Get game-by-game stats for a player in a season.
 *
 * Endpoint: /stats/playergamelog
 * Returns: one row per game played, with full box score stats.
 *
 * @param {number} playerId - WNBA player ID
 * @param {number} season - e.g. 2026
 * @returns {Promise<Array<Object>>} array of game objects, most recent first
 */
export async function fetchPlayerGameLog(playerId, season = 2026) {
  if (!playerId) return [];

  const response = await fetchWnbaStats('/playergamelog', {
    LeagueID: '10',
    PlayerID: String(playerId),
    Season: String(season),
    SeasonType: 'Regular Season'
  }, { ttlMs: apiTesting.TTL.gameLog });

  if (!response) return [];

  const rows = parseResultSet(response, 'PlayerGameLog');

  // Normalize to a clean shape with the fields the engine needs.
  // stats.wnba.com returns game date as 'GAME_DATE' in format "MMM DD, YYYY".
  return rows.map(r => ({
    date: parseGameDate(r.GAME_DATE),
    rawDate: r.GAME_DATE,
    gameId: r.GAME_ID,
    matchup: r.MATCHUP,        // e.g. "LVA vs. NYL" or "LVA @ NYL"
    win: r.WL === 'W',
    minutes: Number(r.MIN),
    points: Number(r.PTS),
    rebounds: Number(r.REB),
    assists: Number(r.AST),
    steals: Number(r.STL),
    blocks: Number(r.BLK),
    turnovers: Number(r.TOV),
    threes: Number(r.FG3M),
    fga: Number(r.FGA),
    fgm: Number(r.FGM),
    fta: Number(r.FTA),
    ftm: Number(r.FTM),
    plusMinus: Number(r.PLUS_MINUS),
    // Combo lines computed for convenience
    pra: Number(r.PTS) + Number(r.REB) + Number(r.AST),
    pa: Number(r.PTS) + Number(r.AST),
    pr: Number(r.PTS) + Number(r.REB),
    ra: Number(r.REB) + Number(r.AST)
  }));
}

/**
 * Get last N played games for a player.
 *
 * @param {number} playerId
 * @param {number} n - number of recent games to return
 * @param {number} season
 * @returns {Promise<Array<Object>>}
 */
export async function getRecentGames(playerId, n = 10, season = 2026) {
  const all = await fetchPlayerGameLog(playerId, season);
  if (all.length === 0) return [];

  // stats.wnba.com returns games in DESCENDING order (most recent first).
  // We want the most recent N. Defensive sort in case ordering changes.
  const sorted = all.sort((a, b) => {
    const ad = a.date ? new Date(a.date).getTime() : 0;
    const bd = b.date ? new Date(b.date).getTime() : 0;
    return bd - ad;  // most recent first
  });

  return sorted.slice(0, n);
}

/**
 * Get aggregated recent stats over last N games, in a shape compatible
 * with the engine's recent-form computation.
 *
 * Used by basketballProps.js when building the "recent vs season" delta
 * for projection adjustments.
 *
 * @param {number} playerId
 * @param {number} n - number of games to aggregate
 * @param {string} market - which stat to highlight as primary
 * @param {number} season
 * @returns {Promise<Object|null>} { gamesUsed, paUsed (or equiv), recent: {...} }
 */
export async function aggregateRecentForm(playerId, n = 10, market = 'points', season = 2026) {
  const games = await getRecentGames(playerId, n, season);
  if (games.length === 0) return null;

  const totals = {
    games: games.length,
    minutes: 0,
    points: 0,
    rebounds: 0,
    assists: 0,
    threes: 0,
    fgm: 0,
    fga: 0,
    ftm: 0,
    fta: 0,
    turnovers: 0
  };

  for (const g of games) {
    totals.minutes += g.minutes || 0;
    totals.points += g.points || 0;
    totals.rebounds += g.rebounds || 0;
    totals.assists += g.assists || 0;
    totals.threes += g.threes || 0;
    totals.fgm += g.fgm || 0;
    totals.fga += g.fga || 0;
    totals.ftm += g.ftm || 0;
    totals.fta += g.fta || 0;
    totals.turnovers += g.turnovers || 0;
  }

  // Compute per-game averages and minutes coefficient of variation.
  // CV is the volatility signal — high CV means inconsistent minutes,
  // which feeds into roleStability's variance assessment.
  const minutesArr = games.map(g => g.minutes || 0);
  const minutesMean = totals.minutes / games.length;
  const minutesVar = minutesArr.reduce((s, m) => s + (m - minutesMean) ** 2, 0) / games.length;
  const minutesStdDev = Math.sqrt(minutesVar);
  const minutesCv = minutesMean > 0 ? minutesStdDev / minutesMean : 0;

  // Market-specific recent avg
  const marketKey = String(market).toLowerCase();
  let recentAvg;
  if (marketKey.includes('rebound')) recentAvg = totals.rebounds / games.length;
  else if (marketKey.includes('assist')) recentAvg = totals.assists / games.length;
  else if (marketKey.includes('three') || marketKey.includes('3pm')) recentAvg = totals.threes / games.length;
  else if (marketKey.includes('pra')) recentAvg = (totals.points + totals.rebounds + totals.assists) / games.length;
  else if (marketKey === 'pa') recentAvg = (totals.points + totals.assists) / games.length;
  else if (marketKey === 'pr') recentAvg = (totals.points + totals.rebounds) / games.length;
  else recentAvg = totals.points / games.length;

  return {
    gamesUsed: games.length,
    recentAvg: Number(recentAvg.toFixed(2)),
    minutesAvg: Number(minutesMean.toFixed(2)),
    minutesCv: Number(minutesCv.toFixed(3)),
    last5Avg: gamesAvg(games.slice(0, 5), marketKey),
    last10Avg: gamesAvg(games.slice(0, 10), marketKey),
    minutesLast5: gamesAvg(games.slice(0, 5), 'minutes'),
    // Pass-through of raw totals for transparency
    totals,
    games   // include the raw game array for downstream inspection
  };
}

function gamesAvg(games, key) {
  if (games.length === 0) return 0;

  let total = 0;
  for (const g of games) {
    if (key === 'minutes') total += g.minutes || 0;
    else if (key.includes('rebound')) total += g.rebounds || 0;
    else if (key.includes('assist')) total += g.assists || 0;
    else if (key.includes('three') || key.includes('3pm')) total += g.threes || 0;
    else if (key.includes('pra')) total += g.pra || 0;
    else if (key === 'pa') total += g.pa || 0;
    else if (key === 'pr') total += g.pr || 0;
    else total += g.points || 0;
  }
  return Number((total / games.length).toFixed(2));
}

// =============================================================
// HELPER: parse game date
// =============================================================
// stats.wnba.com returns dates as "MMM DD, YYYY" (e.g. "MAY 16, 2026").
// Convert to ISO date string for consistent handling.

function parseGameDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  // Try native Date parse — handles "MAY 16, 2026" format
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];  // YYYY-MM-DD
}
