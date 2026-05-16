// api/_lib/wnba/wnbaPlayerData.js
//
// WNBA PLAYER DATA MODULE (May 16, 2026 — Session 2)
//
// Provides:
//   - getPlayerSeasonStats(playerId, season)  → full season aggregates
//   - findPlayerByName(name, season)          → player ID lookup
//   - listAllPlayers(season)                  → full league player roster (cached)
//
// Returns data in a shape that maps directly onto what
// `basketballProps.js` and `roleStability.js` expect — no transformation
// needed downstream.

import { fetchWnbaStats, parseResultSet, _testing as apiTesting } from './wnbaStatsApi.js';

// =============================================================
// SEASON STATS
// =============================================================

/**
 * Get all-players season averages. Used as both the "list all players"
 * fetch and as the source for individual player stats (we filter the
 * full list rather than making per-player calls — same API cost).
 *
 * Endpoint: /stats/leaguedashplayerstats
 * Returns: PerGame stats with usage rate, minutes, points, rebs, asts, etc.
 *
 * @param {number} season - e.g. 2026
 * @returns {Promise<Array<Object>>} array of player objects
 */
export async function listAllPlayers(season = 2026) {
  const response = await fetchWnbaStats('/leaguedashplayerstats', {
    LeagueID: '10',
    Season: String(season),
    SeasonType: 'Regular Season',
    PerMode: 'PerGame',         // we want per-game averages, not totals
    MeasureType: 'Base',         // basic box stats; advanced is separate call
    PaceAdjust: 'N',
    PlusMinus: 'N',
    Rank: 'N',
    LastNGames: '0',
    Month: '0',
    OpponentTeamID: '0',
    Period: '0',
    PlayerExperience: '',
    PlayerPosition: '',
    StarterBench: '',
    TeamID: '0',
    VsConference: '',
    VsDivision: '',
    GameSegment: '',
    Location: '',
    Outcome: '',
    SeasonSegment: '',
    DateFrom: '',
    DateTo: ''
  }, { ttlMs: apiTesting.TTL.season });

  if (!response) return [];
  return parseResultSet(response, 'LeagueDashPlayerStats');
}

/**
 * Get advanced stats per player — usage rate, true shooting, etc.
 * Same endpoint, MeasureType='Advanced'.
 */
export async function listAllPlayersAdvanced(season = 2026) {
  const response = await fetchWnbaStats('/leaguedashplayerstats', {
    LeagueID: '10',
    Season: String(season),
    SeasonType: 'Regular Season',
    PerMode: 'PerGame',
    MeasureType: 'Advanced',     // advanced stats — usage, TS%, eFG%
    PaceAdjust: 'N',
    PlusMinus: 'N',
    Rank: 'N',
    LastNGames: '0',
    Month: '0',
    OpponentTeamID: '0',
    Period: '0',
    PlayerExperience: '',
    PlayerPosition: '',
    StarterBench: '',
    TeamID: '0',
    VsConference: '',
    VsDivision: '',
    GameSegment: '',
    Location: '',
    Outcome: '',
    SeasonSegment: '',
    DateFrom: '',
    DateTo: ''
  }, { ttlMs: apiTesting.TTL.season });

  if (!response) return [];
  return parseResultSet(response, 'LeagueDashPlayerStats');
}

/**
 * Get season stats for one player, formatted for the engine.
 *
 * Returns the shape that basketballProps.js baseProjection() expects:
 *   { id, name, team, position, seasonAvg, minutesAvg, usageRate,
 *     touches, starter, closingRole, ... }
 *
 * @param {number} playerId - WNBA player ID
 * @param {number} season - e.g. 2026
 * @param {string} market - 'points'|'rebounds'|'assists'|'threes'|'pra'|...
 *                          determines which stat fills seasonAvg
 * @returns {Promise<Object|null>}
 */
export async function getPlayerSeasonStats(playerId, season = 2026, market = 'points') {
  // Fetch both base and advanced stats in parallel
  const [base, advanced] = await Promise.all([
    listAllPlayers(season),
    listAllPlayersAdvanced(season)
  ]);

  const basePlayer = base.find(p => Number(p.PLAYER_ID) === Number(playerId));
  const advPlayer = advanced.find(p => Number(p.PLAYER_ID) === Number(playerId));

  if (!basePlayer) return null;

  return mergePlayerStats(basePlayer, advPlayer, market);
}

/**
 * Find a player by name. Case-insensitive substring match.
 * If multiple matches, returns the one with most games played (more likely
 * to be the player the caller actually wanted).
 *
 * @param {string} name - "A'ja Wilson" or "wilson" or partial
 * @param {number} season - e.g. 2026
 * @returns {Promise<Object|null>} { id, name, team, ... }
 */
export async function findPlayerByName(name, season = 2026, market = 'points') {
  if (!name || typeof name !== 'string') return null;

  const [base, advanced] = await Promise.all([
    listAllPlayers(season),
    listAllPlayersAdvanced(season)
  ]);

  const needle = name.toLowerCase().trim();
  // Exact match first, then substring fallback
  let matches = base.filter(p => p.PLAYER_NAME?.toLowerCase() === needle);
  if (matches.length === 0) {
    matches = base.filter(p => p.PLAYER_NAME?.toLowerCase().includes(needle));
  }

  if (matches.length === 0) return null;

  // If multiple matches, prefer the one with most games (likely the "real" player)
  matches.sort((a, b) => (Number(b.GP) || 0) - (Number(a.GP) || 0));
  const basePlayer = matches[0];
  const advPlayer = advanced.find(p => Number(p.PLAYER_ID) === Number(basePlayer.PLAYER_ID));

  return mergePlayerStats(basePlayer, advPlayer, market);
}

// =============================================================
// MERGE HELPER
// =============================================================

/**
 * Combine base + advanced player rows into the shape the engine expects.
 * Map stats.wnba.com field names to our snake_case-ish conventions.
 *
 * Base fields include: PLAYER_ID, PLAYER_NAME, TEAM_ABBREVIATION, GP, MIN,
 *   PTS, REB, AST, STL, BLK, TOV, FG3M, FGA, FTA, FT_PCT, etc.
 * Advanced fields include: USG_PCT, OFF_RATING, DEF_RATING, NET_RATING,
 *   AST_PCT, AST_TO, AST_RATIO, OREB_PCT, DREB_PCT, REB_PCT, TM_TOV_PCT,
 *   EFG_PCT, TS_PCT, PACE.
 */
function mergePlayerStats(base, advanced, market) {
  if (!base) return null;

  // Pick the right "seasonAvg" stat based on the market.
  const marketKey = String(market).toLowerCase();
  let seasonAvg;
  if (marketKey.includes('rebound') || marketKey === 'reb') seasonAvg = Number(base.REB);
  else if (marketKey.includes('assist') || marketKey === 'ast') seasonAvg = Number(base.AST);
  else if (marketKey.includes('three') || marketKey.includes('3pm')) seasonAvg = Number(base.FG3M);
  else if (marketKey.includes('pra')) seasonAvg = Number(base.PTS) + Number(base.REB) + Number(base.AST);
  else if (marketKey === 'pa') seasonAvg = Number(base.PTS) + Number(base.AST);
  else if (marketKey === 'pr') seasonAvg = Number(base.PTS) + Number(base.REB);
  else seasonAvg = Number(base.PTS);  // default to points

  // Usage rate from advanced stats; stats.wnba.com returns USG_PCT as e.g. 0.312
  // (decimal), but our engine expects percentage form (e.g. 31.2). Normalize.
  const usageRaw = Number(advanced?.USG_PCT ?? 0);
  const usageRate = usageRaw > 1.0 ? usageRaw : usageRaw * 100;

  // Starter inference: players with MIN >= 20 and GP_PCT high → likely starter.
  // stats.wnba.com doesn't have a clean "starter" flag in this endpoint, so we
  // approximate. Better than nothing; consumers can override with explicit value.
  const mpg = Number(base.MIN);
  const inferredStarter = mpg >= 20;
  // Closing role inference: top WNBA closers play 30+. Approximate.
  const inferredClosing = mpg >= 28;

  // Touches aren't in the basic endpoint; we approximate from usage + minutes.
  // True touches require a different endpoint (player tracking) that may not
  // be exposed for WNBA. This approximation works as a directional signal.
  // WNBA averages ~70 possessions per team, so a player with 31% usage in
  // 34 minutes touches the ball ~31% × (34/40) × 70 × 1.2 ≈ 22 plays.
  // Multiply by ~3 (counting non-usage touches: passes, screens, etc.) ≈ 66.
  // Capped at 100 to avoid unrealistic outputs.
  const touches = mpg > 0 ? Math.min(100, Math.round(usageRate * 0.7 + mpg * 1.2)) : 0;

  return {
    // Identity
    id: Number(base.PLAYER_ID),
    name: base.PLAYER_NAME,
    team: base.TEAM_ABBREVIATION,
    position: null,  // not in this endpoint; come from roster lookup if needed
    gamesPlayed: Number(base.GP),

    // Stat we're projecting (market-specific)
    seasonAvg: Number.isFinite(seasonAvg) ? seasonAvg : 0,

    // Inputs for engine
    minutesAvg: Number(base.MIN),
    usageRate,
    seasonUsage: usageRate,  // baseline = same as current until we have last5 trend
    touches,
    starter: inferredStarter,
    closingRole: inferredClosing,
    primaryCreator: usageRate >= 28,  // approximation
    primaryBig: false,  // requires position lookup; conservative default

    // Stat-specific shares (used by usageFunnel)
    assistShare: Number(advanced?.AST_PCT ?? 0) * 100,
    reboundShare: Number(advanced?.REB_PCT ?? 0) * 100,
    shotShare: 0,  // not directly available; would need /shotchartdetail

    // Foul/turnover risk
    foulRate: 0,  // not in this endpoint; default to neutral
    minutesCv: 0,  // requires game-log analysis; populated by recent-form module

    // Raw season counts — useful for debugging
    _raw: {
      PTS: Number(base.PTS),
      REB: Number(base.REB),
      AST: Number(base.AST),
      FG3M: Number(base.FG3M),
      MIN: Number(base.MIN),
      USG_PCT: usageRate,
      GP: Number(base.GP)
    }
  };
}
