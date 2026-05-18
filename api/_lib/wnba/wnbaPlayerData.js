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
 * Get bio stats per player (Session 3, May 16 2026).
 *
 * Endpoint: /stats/leaguedashplayerbiostats
 * Critical fields used:
 *   GP  — games played this season
 *   GS  — games STARTED this season (this is the real starter signal)
 *   PLAYER_HEIGHT_INCHES — height (proxy for primaryBig classification)
 *   AGE — age
 *
 * GS/GP ratio gives us actual starter rate, not the minutes-inferred guess.
 * A player with GS/GP = 0.95 has started 95% of their games — clearly a
 * starter even if minutes vary (foul trouble, blowouts, etc).
 */
export async function listAllPlayersBio(season = 2026) {
  const response = await fetchWnbaStats('/leaguedashplayerbiostats', {
    LeagueID: '10',
    Season: String(season),
    SeasonType: 'Regular Season',
    PerMode: 'PerGame',
    PerGame: 'N',                // Bio stats are not per-game scoped, but the API requires it
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
  return parseResultSet(response, 'LeagueDashPlayerBioStats');
}

/**
 * Get player tracking touches (Session 3, May 16 2026).
 *
 * Endpoint: /stats/leaguedashptstats
 * PtMeasureType: 'Possessions' returns touches per game.
 *
 * IMPORTANT WNBA CAVEAT: player tracking is sparser for WNBA than NBA.
 * Some seasons have full tracking data, others have partial coverage.
 * If this endpoint returns empty, we fall back to the approximation
 * (usage × 0.7 + minutes × 1.2) — better-than-nothing signal.
 *
 * Fields returned include:
 *   TOUCHES — total touches per game
 *   FRONT_CT_TOUCHES — frontcourt touches
 *   TIME_OF_POSS — seconds with the ball
 *   AVG_SEC_PER_TOUCH — possession length
 *   AVG_DRIB_PER_TOUCH — dribbles per touch
 *   POINTS_PER_TOUCH — efficiency
 *   ELBOW_TOUCHES, POST_TOUCHES, PAINT_TOUCHES — location breakdown
 */
export async function listAllPlayersTouches(season = 2026) {
  const response = await fetchWnbaStats('/leaguedashptstats', {
    LeagueID: '10',
    Season: String(season),
    SeasonType: 'Regular Season',
    PerMode: 'PerGame',
    PlayerOrTeam: 'Player',
    PtMeasureType: 'Possessions',
    LastNGames: '0',
    Month: '0',
    OpponentTeamID: '0',
    PlayerExperience: '',
    PlayerPosition: '',
    StarterBench: '',
    TeamID: '0',
    VsConference: '',
    VsDivision: '',
    GameScope: '',
    Location: '',
    Outcome: '',
    SeasonSegment: '',
    DateFrom: '',
    DateTo: '',
    College: '',
    Conference: '',
    Country: '',
    Division: '',
    DraftPick: '',
    DraftYear: '',
    Height: '',
    Weight: ''
  }, { ttlMs: apiTesting.TTL.season });

  if (!response) return [];
  // Result set name for player tracking is typically 'LeagueDashPtStats'
  // but can vary; try both common names
  return parseResultSet(response, 'LeagueDashPtStats')
    || parseResultSet(response);
}

/**
 * Get season stats for one player, formatted for the engine.
 *
 * Returns the shape that basketballProps.js baseProjection() expects:
 *   { id, name, team, position, seasonAvg, minutesAvg, usageRate,
 *     touches, starter, closingRole, ... }
 *
 * SESSION 3 UPDATE (May 16, 2026): now fetches bio + touches in parallel
 * alongside base + advanced. This gives us REAL starter status (GS/GP),
 * REAL touches per game (from player tracking), and REAL foul rate
 * (from base PF field).
 *
 * @param {number} playerId - WNBA player ID
 * @param {number} season - e.g. 2026
 * @param {string} market - 'points'|'rebounds'|'assists'|'threes'|'pra'|...
 *                          determines which stat fills seasonAvg
 * @returns {Promise<Object|null>}
 */
export async function getPlayerSeasonStats(playerId, season = 2026, market = 'points') {
  // Fetch all four data sources in parallel.
  // Bio + touches may fail independently (player tracking has spotty WNBA
  // coverage); the merge function handles missing data gracefully.
  const [base, advanced, bio, touches] = await Promise.all([
    listAllPlayers(season),
    listAllPlayersAdvanced(season),
    listAllPlayersBio(season).catch(() => []),
    listAllPlayersTouches(season).catch(() => [])
  ]);

  const basePlayer = base.find(p => Number(p.PLAYER_ID) === Number(playerId));
  const advPlayer = advanced.find(p => Number(p.PLAYER_ID) === Number(playerId));
  const bioPlayer = bio.find(p => Number(p.PLAYER_ID) === Number(playerId));
  const touchPlayer = touches.find(p => Number(p.PLAYER_ID) === Number(playerId));

  if (!basePlayer) return null;

  return mergePlayerStats(basePlayer, advPlayer, market, bioPlayer, touchPlayer);
}

/**
 * Find a player by name. Case-insensitive substring match.
 * If multiple matches, returns the one with most games played (more likely
 * to be the player the caller actually wanted).
 *
 * SESSION 3 UPDATE: same parallel fetch as getPlayerSeasonStats.
 *
 * @param {string} name - "A'ja Wilson" or "wilson" or partial
 * @param {number} season - e.g. 2026
 * @returns {Promise<Object|null>} { id, name, team, ... }
 */
export async function findPlayerByName(name, season = 2026, market = 'points') {
  if (!name || typeof name !== 'string') return null;

  const [base, advanced, bio, touches] = await Promise.all([
    listAllPlayers(season),
    listAllPlayersAdvanced(season),
    listAllPlayersBio(season).catch(() => []),
    listAllPlayersTouches(season).catch(() => [])
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
  const playerIdNum = Number(basePlayer.PLAYER_ID);
  const advPlayer = advanced.find(p => Number(p.PLAYER_ID) === playerIdNum);
  const bioPlayer = bio.find(p => Number(p.PLAYER_ID) === playerIdNum);
  const touchPlayer = touches.find(p => Number(p.PLAYER_ID) === playerIdNum);

  return mergePlayerStats(basePlayer, advPlayer, market, bioPlayer, touchPlayer);
}

// =============================================================
// MERGE HELPER
// =============================================================

/**
 * Combine base + advanced + bio + touches player rows into the shape the
 * engine expects.
 *
 * SESSION 3 UPDATE (May 16, 2026):
 * Real data now used for:
 *   - touches: from player tracking (TOUCHES field), with approximation fallback
 *   - starter: from bio stats (GS/GP ratio ≥ 0.50), with minutes-inference fallback
 *   - foulRate: from base PF field (was defaulted to 0)
 *
 * Fields with documented fallback behavior:
 *   - touches: real if player tracking endpoint returned data, else approximation
 *   - starter: real if bio endpoint returned data, else minutes inference
 *   - closingRole: still inferred from minutes ≥ 28 (no direct signal)
 *   - primaryBig: inferred from height ≥ 76" (6'4") if bio data, else false
 *   - foulRate: real from base (always available when player exists)
 *
 * Base fields: PLAYER_ID, PLAYER_NAME, TEAM_ABBREVIATION, GP, MIN, PTS, REB,
 *   AST, STL, BLK, TOV, FG3M, FGA, FTA, FT_PCT, PF, etc.
 * Advanced fields: USG_PCT, OFF_RATING, DEF_RATING, AST_PCT, REB_PCT, TS_PCT.
 * Bio fields: PLAYER_HEIGHT_INCHES, PLAYER_WEIGHT, AGE, GP, GS.
 * Touch fields: TOUCHES, TIME_OF_POSS, ELBOW_TOUCHES, POST_TOUCHES, PAINT_TOUCHES.
 */
function mergePlayerStats(base, advanced, market, bio = null, touchData = null) {
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

  const mpg = Number(base.MIN);

  // STARTER STATUS — Session 3 upgrade
  // Real signal: bio.GS / bio.GP gives starter rate. Threshold 0.50 means
  // started majority of games. A bench player who occasionally starts gets
  // false; an injury-replacement starter who's started recent games gets true.
  //
  // Fallback: minutes ≥ 20 (original Session 1 logic).
  let starter;
  let starterSource;
  if (bio && Number(bio.GP) > 0) {
    const gsGpRatio = Number(bio.GS) / Number(bio.GP);
    starter = gsGpRatio >= 0.50;
    starterSource = 'gs_gp_ratio';
  } else {
    starter = mpg >= 20;
    starterSource = 'minutes_inferred';
  }

  // CLOSING ROLE — still inferred from minutes (no direct signal in any endpoint).
  // Top WNBA closers play 28+ MPG. This stays inference-based.
  const closingRole = mpg >= 28;

  // TOUCHES — Session 3 upgrade
  // Real signal: TOUCHES from player tracking endpoint.
  // Fallback: usage × 0.7 + minutes × 1.2 (Session 1 approximation, kept as
  // documented fallback when tracking data is missing for a player or season).
  let touches;
  let touchesSource;
  if (touchData && Number.isFinite(Number(touchData.TOUCHES))) {
    touches = Math.round(Number(touchData.TOUCHES));
    touchesSource = 'player_tracking';
  } else if (mpg > 0) {
    touches = Math.min(100, Math.round(usageRate * 0.7 + mpg * 1.2));
    touchesSource = 'approximation';
  } else {
    touches = 0;
    touchesSource = 'no_data';
  }

  // FOUL RATE — Session 3 upgrade
  // Real signal: PF (personal fouls per game) from base stats. We were
  // ignoring this field in Session 2; now it flows through to roleStability.
  //
  // Note: roleStability.js expects foulRate as fouls per 36 minutes, not raw PF.
  // Convert: pf_per36 = (PF / MPG) × 36
  const pfPerGame = Number(base.PF) || 0;
  const foulRate = mpg > 0 ? (pfPerGame / mpg) * 36 : 0;

  // PRIMARY BIG inference from bio.PLAYER_HEIGHT_INCHES.
  // 6'4" (76 inches) is a reasonable WNBA "big" threshold — most centers
  // are 6'3"+ and most non-bigs are 6'2" or shorter. Borderline players
  // sit at 6'3" but their position usually disambiguates.
  let primaryBig = false;
  if (bio && Number(bio.PLAYER_HEIGHT_INCHES) >= 76) {
    primaryBig = true;
  }

  return {
    // Identity
    id: Number(base.PLAYER_ID),
    name: base.PLAYER_NAME,
    team: base.TEAM_ABBREVIATION,
    position: null,  // not in this endpoint; come from roster lookup if needed
    gamesPlayed: Number(base.GP),

    // Stat we're projecting (market-specific)
    seasonAvg: Number.isFinite(seasonAvg) ? seasonAvg : 0,

    // Inputs for engine — real data with documented fallbacks
    minutesAvg: mpg,
    usageRate,
    seasonUsage: usageRate,  // baseline = same as current until we have last5 trend
    touches,                 // Session 3: real from player tracking when available
    starter,                 // Session 3: real GS/GP when available
    closingRole,
    primaryCreator: usageRate >= 28,  // approximation — still no direct signal
    primaryBig,              // Session 3: real height-based when bio available

    // Stat-specific shares (used by usageFunnel)
    assistShare: Number(advanced?.AST_PCT ?? 0) * 100,
    reboundShare: Number(advanced?.REB_PCT ?? 0) * 100,
    shotShare: 0,  // not directly available; would need /shotchartdetail

    // Foul/turnover risk — Session 3: real foul rate
    foulRate: Number(foulRate.toFixed(2)),
    minutesCv: 0,  // requires game-log analysis; populated by recent-form module

    // Diagnostic metadata — tells callers which fields are real vs approximated
    _dataQuality: {
      starterSource,          // 'gs_gp_ratio' | 'minutes_inferred'
      touchesSource,          // 'player_tracking' | 'approximation' | 'no_data'
      hasBioData: !!bio,
      hasTouchData: !!touchData,
      hasAdvancedData: !!advanced
    },

    // Raw season counts — useful for debugging
    _raw: {
      PTS: Number(base.PTS),
      REB: Number(base.REB),
      AST: Number(base.AST),
      FG3M: Number(base.FG3M),
      MIN: mpg,
      USG_PCT: usageRate,
      GP: Number(base.GP),
      // Session 3 additions
      PF: pfPerGame,
      GS: bio ? Number(bio.GS) : null,
      HEIGHT_IN: bio ? Number(bio.PLAYER_HEIGHT_INCHES) : null,
      TOUCHES: touchData ? Number(touchData.TOUCHES) : null
    }
  };
}


// =============================================================
// TOP-N PER TEAM (Session 4 addition)
// =============================================================

/**
 * Get the top N players for a team, ranked by usage rate.
 *
 * Used by the slate endpoint to pick which players to analyze per game.
 * Top usage = most likely to have PrizePicks/Underdog prop lines.
 *
 * SESSION 4 (May 16, 2026): added for slate generation.
 *
 * @param {string} teamAbbr - 3-letter team code (e.g. "LVA")
 * @param {number} n - number of players to return
 * @param {number} season - e.g. 2026
 * @param {string} market - which market for seasonAvg (defaults to points)
 * @returns {Promise<Array<Object>>} array of merged player objects
 */
export async function getTopPlayersForTeam(teamAbbr, n = 4, season = 2026, market = 'points') {
  if (!teamAbbr) return [];

  // Pull all four data sources once — same as getPlayerSeasonStats / findPlayerByName.
  // Cached after first slate-level call, so per-team fetches are free.
  const [base, advanced, bio, touches] = await Promise.all([
    listAllPlayers(season),
    listAllPlayersAdvanced(season),
    listAllPlayersBio(season).catch(() => []),
    listAllPlayersTouches(season).catch(() => [])
  ]);

  // Filter to team
  const teamPlayers = base.filter(
    p => String(p.TEAM_ABBREVIATION || '').toUpperCase() === String(teamAbbr).toUpperCase()
  );

  if (teamPlayers.length === 0) return [];

  // For each team player, look up usage in advanced data.
  // Sort by usage descending. Tiebreak: minutes played.
  const withUsage = teamPlayers.map(p => {
    const adv = advanced.find(a => Number(a.PLAYER_ID) === Number(p.PLAYER_ID));
    const usage = Number(adv?.USG_PCT ?? 0);
    return {
      basePlayer: p,
      advPlayer: adv,
      usage: usage > 1.0 ? usage : usage * 100,  // normalize to percentage form
      minutes: Number(p.MIN) || 0
    };
  });

  // Sort: highest usage first, then highest minutes as tiebreak
  withUsage.sort((a, b) => {
    if (b.usage !== a.usage) return b.usage - a.usage;
    return b.minutes - a.minutes;
  });

  // Filter to actual rotation players — under 12 MPG isn't getting prop lines
  // anyway, so don't waste an analysis slot on them.
  const rotationPlayers = withUsage.filter(p => p.minutes >= 12);

  // Return top N, fully merged with bio + touches
  return rotationPlayers.slice(0, n).map(p => {
    const bioRow = bio.find(b => Number(b.PLAYER_ID) === Number(p.basePlayer.PLAYER_ID));
    const touchRow = touches.find(t => Number(t.PLAYER_ID) === Number(p.basePlayer.PLAYER_ID));
    return mergePlayerStats(p.basePlayer, p.advPlayer, market, bioRow, touchRow);
  }).filter(Boolean);
}