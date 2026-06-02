// api/_lib/wnba/wnbaPlayerData.js
//
// WNBA PLAYER DATA MODULE (May 18, 2026 — basketball-reference migration)
//
// HISTORY:
//   Session 2 (May 16) — built against stats.wnba.com /leaguedashplayerstats
//   May 17 — file emptied accidentally during folder renames, restored from transcript
//   May 18 ~5 AM — stats.wnba.com confirmed unreachable from Vercel
//   May 18 ~6 AM — rewritten to use basketball-reference (CDN-fronted, 96ms avg)
//
// CONTRACT (UNCHANGED):
//   Exports remain identical to the previous version so slate.js and downstream
//   consumers don't need to change. Each function returns the same shape.
//
//   Exports:
//     listAllPlayers(season)              → array of base stats per player
//     listAllPlayersAdvanced(season)      → array of advanced stats per player
//     listAllPlayersBio(season)           → array of bio (height, GS/GP) per player
//     listAllPlayersTouches(season)       → returns [] for now (bbref doesn't expose
//                                            tracking touches; existing fallback
//                                            in mergePlayerStats handles this)
//     getPlayerSeasonStats(playerId, season, market) → merged object for engine
//     findPlayerByName(name, season, market)         → merged object by name
//     getTopPlayersForTeam(teamAbbr, n, season, market) → array of top N for team
//
// DATA SOURCE NOTES:
//   - basketball-reference per-game table id: "per_game_stats" (verified live)
//     Columns: data-stat="player|team_id|g|gs|mp_per_g|pts_per_g|trb_per_g|
//              ast_per_g|fg3_per_g|pf_per_g|..."
//   - basketball-reference advanced table id: "advanced_stats"
//     Columns: data-stat="player|usg_pct|ts_pct|ast_pct|trb_pct|orb_pct|drb_pct|..."
//   - bbref's USG% is published as a PERCENTAGE (e.g. "28.4"), not a decimal,
//     which matches what our engine expects without the normalization step that
//     stats.wnba.com required.
//   - Player IDs: we use bbref's player slug (e.g. "stewabr01w") as the ID since
//     stats.wnba.com numeric IDs are no longer reachable. This is a deliberate
//     break; the engine treats `id` as opaque so this is safe.
//   - Touches data: bbref doesn't publish tracking touches publicly.
//     listAllPlayersTouches returns []. mergePlayerStats falls back to the
//     usage-based approximation (already in place from Session 3).

import { fetchAndParseTable, fetchBbrefPage, unwrapCommentedTables, extractTableHtml, parseTableRows } from './bbrefClient.js';

// =============================================================
// CORE FETCHERS
// =============================================================

/**
 * Get all WNBA players' per-game (base) stats for the season.
 * Source: https://www.basketball-reference.com/wnba/years/2026.html
 *         table id="per_game_stats"
 *
 * Maps bbref column names → stats.wnba.com-style field names so downstream
 * code (mergePlayerStats) doesn't need to change.
 *
 * @param {number} season - e.g. 2026
 * @returns {Promise<Array<Object>>}
 */
export async function listAllPlayers(season = 2026) {
  // bbref WNBA stats live on dedicated sub-pages, not the main year page.
  // The main /wnba/years/{year}.html page only has standings + team summaries.
  // Per-game player stats are at /wnba/years/{year}_per_game.html
  const path = `/wnba/years/${season}_per_game.html`;
  // Common table IDs (try in priority order)
  const candidateIds = ['per_game_stats', 'per_game', 'players_per_game'];
  for (const tableId of candidateIds) {
    const rows = await fetchAndParseTable(path, tableId);
    if (rows.length > 0) {
      const normalized = rows.map(normalizeBaseRow).filter(Boolean);
      if (normalized.length > 0) return normalized;
    }
  }
  console.warn(`[wnbaPlayerData] No per-game stats table found at ${path}`);
  return [];
}

/**
 * Get all WNBA players' advanced stats for the season.
 * Source: https://www.basketball-reference.com/wnba/years/2026.html
 *         table id="advanced_stats"
 *
 * @param {number} season
 * @returns {Promise<Array<Object>>}
 */
export async function listAllPlayersAdvanced(season = 2026) {
  // Advanced stats live at /wnba/years/{year}_advanced.html (not the main page)
  const path = `/wnba/years/${season}_advanced.html`;
  const candidateIds = ['advanced_stats', 'advanced', 'players_advanced'];
  for (const tableId of candidateIds) {
    const rows = await fetchAndParseTable(path, tableId);
    if (rows.length > 0) {
      const normalized = rows.map(normalizeAdvancedRow).filter(Boolean);
      if (normalized.length > 0) return normalized;
    }
  }
  console.warn(`[wnbaPlayerData] No advanced stats table found at ${path}`);
  return [];
}

/**
 * Get player bio data (height, games started).
 *
 * Source: per-game table has GS (games started) and we approximate height from
 * the totals table when needed. bbref doesn't centralize "bio" the way
 * stats.wnba.com did, but the fields our engine actually consumes (GS, GP,
 * PLAYER_HEIGHT_INCHES) come from different tables.
 *
 * Strategy: GS/GP come from per_game (already in listAllPlayers via the GS column).
 * Height isn't on the season summary page — we'd need to scrape individual
 * player pages, which is expensive. For Phase 1 we return GS/GP only and
 * height stays null. mergePlayerStats falls back to minutes-based starter
 * detection and to no primaryBig flag, both of which it already handles.
 *
 * @param {number} season
 * @returns {Promise<Array<Object>>}
 */
export async function listAllPlayersBio(season = 2026) {
  // Re-use the per-game table for GS / GP since it's there.
  // We return a separate array (rather than relying on listAllPlayers callers
  // to read GS off the base row) so the merge logic stays identical.
  const baseRows = await listAllPlayers(season);
  return baseRows.map(r => ({
    PLAYER_ID: r.PLAYER_ID,
    PLAYER_NAME: r.PLAYER_NAME,
    TEAM_ABBREVIATION: r.TEAM_ABBREVIATION,
    GP: r.GP,
    GS: r.GS,
    // PLAYER_HEIGHT_INCHES is unavailable from the season summary page.
    // Falls back gracefully in mergePlayerStats (primaryBig stays false).
    PLAYER_HEIGHT_INCHES: null
  }));
}

/**
 * Player tracking touches data — NOT AVAILABLE from basketball-reference.
 *
 * bbref doesn't expose Second Spectrum tracking data publicly. The merge
 * function already has a documented approximation fallback (usage × 0.7 +
 * minutes × 1.2) that activates when this returns empty.
 *
 * @param {number} season
 * @returns {Promise<Array<Object>>} always returns []
 */
export async function listAllPlayersTouches(season = 2026) {
  return [];
}

// =============================================================
// MERGED PLAYER STATS (downstream consumer interface)
// =============================================================

/**
 * Get season stats for one player, formatted for the engine.
 *
 * Returns the SAME shape as the previous stats.wnba.com version. Downstream
 * code (basketballProps.js baseProjection) reads:
 *   id, name, team, seasonAvg, minutesAvg, usageRate, seasonUsage, touches,
 *   starter, closingRole, primaryCreator, primaryBig, assistShare,
 *   reboundShare, foulRate, minutesCv
 *
 * @param {string|number} playerId - bbref player slug or stats.wnba.com numeric ID
 * @param {number} season
 * @param {string} market
 * @returns {Promise<Object|null>}
 */
export async function getPlayerSeasonStats(playerId, season = 2026, market = 'points') {
  const [base, advanced, bio, touches, slugMap] = await Promise.all([
    listAllPlayers(season),
    listAllPlayersAdvanced(season),
    listAllPlayersBio(season),
    listAllPlayersTouches(season),
    buildSlugMap(season)
  ]);

  const target = String(playerId);
  const basePlayer = base.find(p => String(p.PLAYER_ID) === target);
  if (!basePlayer) return null;

  const advPlayer = advanced.find(p => String(p.PLAYER_ID) === target);
  const bioRow = bio.find(p => String(p.PLAYER_ID) === target);
  const touchRow = touches.find(p => String(p.PLAYER_ID) === target);

  return mergePlayerStats(basePlayer, advPlayer, market, bioRow, touchRow, slugMap);
}

/**
 * Find a player by name. Case-insensitive partial match.
 *
 * @param {string} name
 * @param {number} season
 * @param {string} market
 * @returns {Promise<Object|null>}
 */
export async function findPlayerByName(name, season = 2026, market = 'points') {
  if (!name || typeof name !== 'string') return null;

  const [base, advanced, bio, touches, slugMap] = await Promise.all([
    listAllPlayers(season),
    listAllPlayersAdvanced(season),
    listAllPlayersBio(season),
    listAllPlayersTouches(season),
    buildSlugMap(season)
  ]);

  const needle = name.toLowerCase().trim();

  // Exact match first, then startsWith, then contains
  let basePlayer = base.find(p => p.PLAYER_NAME?.toLowerCase() === needle);
  if (!basePlayer) {
    basePlayer = base.find(p => p.PLAYER_NAME?.toLowerCase().startsWith(needle));
  }
  if (!basePlayer) {
    basePlayer = base.find(p => p.PLAYER_NAME?.toLowerCase().includes(needle));
  }
  if (!basePlayer) return null;

  const targetId = String(basePlayer.PLAYER_ID);
  const advPlayer = advanced.find(p => String(p.PLAYER_ID) === targetId);
  const bioRow = bio.find(p => String(p.PLAYER_ID) === targetId);
  const touchRow = touches.find(p => String(p.PLAYER_ID) === targetId);

  return mergePlayerStats(basePlayer, advPlayer, market, bioRow, touchRow, slugMap);
}

/**
 * Get the top N players for a team, sorted by the market-relevant season stat.
 *
 * Used by slate.js to build "best plays" lists. Top N is typically 4.
 *
 * @param {string} teamAbbr - stats.wnba.com-style tricode (NYL, LVA, etc.)
 * @param {number} n
 * @param {number} season
 * @param {string} market
 * @returns {Promise<Array<Object>>}
 */
export async function getTopPlayersForTeam(teamAbbr, n = 4, season = 2026, market = 'points') {
  if (!teamAbbr) return [];

  const [base, advanced, bio, touches, slugMap] = await Promise.all([
    listAllPlayers(season),
    listAllPlayersAdvanced(season),
    listAllPlayersBio(season),
    listAllPlayersTouches(season),
    buildSlugMap(season)
  ]);

  const targetAbbr = String(teamAbbr).toUpperCase();

  // Filter team players. bbref might return tricode in TEAM_ABBREVIATION
  // (we normalize there) or in raw form — check both.
  const teamPlayers = base.filter(p => {
    const tabbr = String(p.TEAM_ABBREVIATION || '').toUpperCase();
    return tabbr === targetAbbr;
  });

  if (teamPlayers.length === 0) {
    console.warn(`[wnbaPlayerData] No players found for team "${targetAbbr}"`);
    return [];
  }

  // Compute a sort key based on the market.
  const marketKey = String(market).toLowerCase();
  function sortValue(p) {
    if (marketKey.includes('rebound') || marketKey === 'reb') return Number(p.REB) || 0;
    if (marketKey.includes('assist') || marketKey === 'ast') return Number(p.AST) || 0;
    if (marketKey.includes('three') || marketKey.includes('3pm')) return Number(p.FG3M) || 0;
    if (marketKey.includes('pra')) return (Number(p.PTS)||0) + (Number(p.REB)||0) + (Number(p.AST)||0);
    if (marketKey === 'pa') return (Number(p.PTS)||0) + (Number(p.AST)||0);
    if (marketKey === 'pr') return (Number(p.PTS)||0) + (Number(p.REB)||0);
    return Number(p.PTS) || 0;
  }

  // Sort descending and take top N
  const topN = [...teamPlayers]
    .sort((a, b) => sortValue(b) - sortValue(a))
    .slice(0, n);

  // Merge with advanced/bio/touches and return engine-shaped objects
  const results = topN.map(basePlayer => {
    const targetId = String(basePlayer.PLAYER_ID);
    const advPlayer = advanced.find(p => String(p.PLAYER_ID) === targetId);
    const bioRow = bio.find(p => String(p.PLAYER_ID) === targetId);
    const touchRow = touches.find(p => String(p.PLAYER_ID) === targetId);
    return mergePlayerStats(basePlayer, advPlayer, market, bioRow, touchRow, slugMap);
  }).filter(Boolean);

  return results;
}

// =============================================================
// ROW NORMALIZERS — bbref columns → stats.wnba.com-style fields
// =============================================================
//
// Downstream code (mergePlayerStats, basketballProps.js) reads field names
// like PLAYER_ID, PLAYER_NAME, TEAM_ABBREVIATION, MIN, PTS, REB, AST, FG3M,
// USG_PCT, GP, GS, PF, AST_PCT, REB_PCT. We translate bbref columns into
// those names so the rest of the codebase doesn't need to change.

function normalizeBaseRow(row) {
  if (!row || !row.player) return null;

  // Skip header rows that leak through the parser (e.g. row where player == "Player").
  // bbref repeats the column-header row mid-table on long pages.
  if (row.player === 'Player' || row.team === 'Team' || row.team_id === 'Team') return null;

  // Player ID: bbref slug (e.g. "citroso01w"), extracted from the player link.
  // CRITICAL: never fall back to the player NAME — a name produces a 404 game-log
  // URL (/wnba/players/s/Sonia Citron/gamelog) which silently returns no games,
  // which starves the role/minutes/variance layers. null is correct when absent;
  // downstream skips the game-log fetch cleanly.
  const playerId = extractBbrefSlug(row);
  // Team abbreviation: try multiple bbref column names + the link extraction
  // bbref WNBA pages variously use: team_name_abbr, team_id, team
  const teamAbbr = row.team_abbr_link || row.team_name_abbr || row.team_id || row.team || '';

  return {
    // Join key across base/advanced/bio = NAME (always present, matches reliably).
    // The bbref slug is carried separately for the game-log URL only.
    PLAYER_ID: row.player,
    BBREF_SLUG: playerId,
    PLAYER_NAME: row.player,
    _slugResolved: playerId != null,
    TEAM_ABBREVIATION: String(teamAbbr).toUpperCase(),
    GP: toNum(row.g),
    GS: toNum(row.gs),
    MIN: toNum(row.mp_per_g),
    PTS: toNum(row.pts_per_g),
    REB: toNum(row.trb_per_g),
    AST: toNum(row.ast_per_g),
    FG3M: toNum(row.fg3_per_g),
    STL: toNum(row.stl_per_g),
    BLK: toNum(row.blk_per_g),
    TOV: toNum(row.tov_per_g),
    PF: toNum(row.pf_per_g),
    FG_PCT: toNum(row.fg_pct),
    FG3_PCT: toNum(row.fg3_pct),
    FT_PCT: toNum(row.ft_pct),
    EFG_PCT: toNum(row.efg_pct),
    // ADDED June 1: surface FT volume for the whistle layer + a position if
    // bbref includes one on the per-game row (data-stat="pos").
    FT: toNum(row.ft_per_g),
    FTA: toNum(row.fta_per_g),
    FGA: toNum(row.fga_per_g),
    POS: row.pos ? String(row.pos).toUpperCase() : null
  };
}

function normalizeAdvancedRow(row) {
  if (!row || !row.player) return null;
  // Skip header rows
  if (row.player === 'Player' || row.team === 'Team' || row.team_id === 'Team') return null;
  const playerId = extractBbrefSlug(row);
  const teamAbbr = row.team_abbr_link || row.team_name_abbr || row.team_id || row.team || '';
  return {
    PLAYER_ID: row.player,
    BBREF_SLUG: playerId,
    PLAYER_NAME: row.player,
    TEAM_ABBREVIATION: String(teamAbbr).toUpperCase(),
    // bbref publishes these as percentages (e.g. "28.4" for 28.4%).
    // The merge function expects USG_PCT in decimal OR percentage form;
    // it has detection logic that normalizes both. We pass percentage,
    // which matches what mergePlayerStats expects post-conversion.
    USG_PCT: toNum(row.usg_pct),
    TS_PCT: toNum(row.ts_pct),
    AST_PCT: toNum(row.ast_pct) / 100,   // mergePlayerStats multiplies × 100
    REB_PCT: toNum(row.trb_pct) / 100,   // ditto
    ORB_PCT: toNum(row.orb_pct) / 100,
    DRB_PCT: toNum(row.drb_pct) / 100,
    STL_PCT: toNum(row.stl_pct) / 100,
    BLK_PCT: toNum(row.blk_pct) / 100,
    TOV_PCT: toNum(row.tov_pct) / 100,
    PER: toNum(row.per)
  };
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Extract the bbref player slug (e.g. "citroso01w") for a row. bbref player
// cells link to /wnba/players/{letter}/{slug}.html — we scan whatever fields
// parseTableRows exposed for that pattern, then known slug fields. Returns null
// (NEVER the player name) when no real slug is found, so the game-log URL is
// never built from a name (which 404s and silently starves the minutes layer).
const BBREF_SLUG_RE = /\/wnba\/players\/[a-z]\/([a-z0-9]+)\.html/i;
const SLUG_SHAPE_RE = /^[a-z]+[0-9]{2}w$/i;   // e.g. citroso01w
function extractBbrefSlug(row) {
  if (!row) return null;
  // 1) Direct slug fields parseTableRows may provide.
  for (const k of ['bbref_player_id', 'data_append_csv', 'append_csv', 'player_slug', 'slug']) {
    const v = row[k];
    if (typeof v === 'string' && SLUG_SHAPE_RE.test(v.trim())) return v.trim();
  }
  // 2) Scan every string value for the player href pattern.
  for (const v of Object.values(row)) {
    if (typeof v !== 'string') continue;
    const m = v.match(BBREF_SLUG_RE);
    if (m && m[1]) return m[1];
  }
  return null;
}

// -----------------------------------------------------------
// SLUG MAP — name → bbref slug, parsed from RAW page HTML.
// -----------------------------------------------------------
// parseTableRows strips the <a> tag from the player cell, returning only the
// display name, so the slug never survives into the row. We fetch the raw
// per-game page once and regex every player anchor:
//   <th ... data-stat="player"><strong><a href='/wnba/players/a/akoamo01w.html'>Monique Akoa Makani</a>
// into a { "Monique Akoa Makani": "akoamo01w" } map, cached per season.
const _slugMapCache = new Map();
// Matches both single- and double-quoted hrefs, captures slug + display name.
const PLAYER_ANCHOR_RE = /href=['"]\/wnba\/players\/[a-z]\/([a-z0-9]+)\.html['"]\s*>([^<]+)<\/a>/gi;

function normalizeName(s) {
  // Lowercase, strip accents and punctuation so "A'ja Wilson" ≈ "aja wilson".
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

async function buildSlugMap(season = 2026) {
  if (_slugMapCache.has(season)) return _slugMapCache.get(season);
  const map = new Map();
  try {
    const html = await fetchBbrefPage(`/wnba/years/${season}_per_game.html`, { ttlMs: 6 * 60 * 60 * 1000 });
    if (html) {
      // Player anchors live in BOTH the live table and bbref's commented-out
      // duplicate blocks; unwrap so we catch every player.
      const scan = unwrapCommentedTables(html);
      let m;
      PLAYER_ANCHOR_RE.lastIndex = 0;
      while ((m = PLAYER_ANCHOR_RE.exec(scan)) !== null) {
        const slug = m[1];
        const name = m[2].trim();
        if (slug && name && SLUG_SHAPE_RE.test(slug)) {
          map.set(normalizeName(name), slug);
        }
      }
    }
  } catch (err) {
    console.warn(`[wnbaPlayerData] slug map build failed: ${err.message}`);
  }
  _slugMapCache.set(season, map);
  return map;
}

function lookupSlug(slugMap, name) {
  if (!slugMap || !name) return null;
  return slugMap.get(normalizeName(name)) || null;
}

// =============================================================
// MERGE FUNCTION — unchanged from Session 3 contract
// =============================================================

function mergePlayerStats(base, advanced, market, bio = null, touchData = null, slugMap = null) {
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
  else seasonAvg = Number(base.PTS);

  // Usage rate normalization.
  // bbref returns percentages (e.g. 28.4). stats.wnba.com returned decimals (0.284).
  // mergePlayerStats expects percentage form. The check below handles both safely.
  const usageRaw = Number(advanced?.USG_PCT ?? 0);
  const usageRate = usageRaw > 1.0 ? usageRaw : usageRaw * 100;

  const mpg = Number(base.MIN);

  // Starter status — uses GS/GP ratio if available, falls back to minutes ≥ 20
  let starter;
  let starterSource;
  if (bio && Number(bio.GP) > 0 && Number(bio.GS) > 0) {
    const gsGpRatio = Number(bio.GS) / Number(bio.GP);
    starter = gsGpRatio >= 0.50;
    starterSource = 'gs_gp_ratio';
  } else if (Number(base.GS) > 0 && Number(base.GP) > 0) {
    // bbref includes GS in the per_game table directly
    const gsGpRatio = Number(base.GS) / Number(base.GP);
    starter = gsGpRatio >= 0.50;
    starterSource = 'gs_gp_ratio';
  } else {
    starter = mpg >= 20;
    starterSource = 'minutes_inferred';
  }

  // Closing role — minute-inferred
  const closingRole = mpg >= 28;

  // Touches — bbref doesn't expose tracking. Use the documented approximation.
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

  // Foul rate per 36 minutes
  const pfPerGame = Number(base.PF) || 0;
  const foulRate = mpg > 0 ? (pfPerGame / mpg) * 36 : 0;

  // Primary big — bbref doesn't expose height on the season summary page.
  // Falls back to a position-based heuristic if/when we add roster scraping.
  let primaryBig = false;
  if (bio && Number(bio.PLAYER_HEIGHT_INCHES) >= 76) {
    primaryBig = true;
  }

  return {
    // Identity. `id` carries the bbref SLUG when resolved (the game-log fetch
    // needs it for the URL); falls back to name only so nothing is undefined.
    // `name` is the reliable cross-source join key (injuries, props, history).
    id: (lookupSlug(slugMap, base.PLAYER_NAME) || base.BBREF_SLUG || base.PLAYER_NAME),
    bbrefSlug: (lookupSlug(slugMap, base.PLAYER_NAME) || base.BBREF_SLUG || null),
    name: base.PLAYER_NAME,
    team: base.TEAM_ABBREVIATION,
    // ADDED June 1: real position when bbref provides one (per-game `pos`
    // column), else null. teammateRedistribution's backfill chain needs this;
    // it falls back to 'F' only when null.
    position: base.POS || null,
    gamesPlayed: Number(base.GP),

    // Stat we're projecting (market-specific)
    seasonAvg: Number.isFinite(seasonAvg) ? seasonAvg : 0,

    // Inputs for engine
    minutesAvg: mpg,
    usageRate,
    seasonUsage: usageRate,
    touches,
    starter,
    closingRole,
    primaryCreator: usageRate >= 28,
    primaryBig,

    // Stat-specific shares (engine consumes these)
    assistShare: Number(advanced?.AST_PCT ?? 0) * 100,
    reboundShare: Number(advanced?.REB_PCT ?? 0) * 100,
    shotShare: 0,

    foulRate: Number(foulRate.toFixed(2)),
    minutesCv: 0,

    // ADDED June 1: real shooting efficiency + FT volume. Previously TS_PCT was
    // parsed but dropped, so pointsProjection fell back to league-average 0.535
    // for everyone; and FTA was never surfaced so the whistle layer stayed dark.
    tsPct: Number(advanced?.TS_PCT ?? 0) || null,
    fgPct: Number(base.FG_PCT ?? 0) || null,
    fta: Number(base.FTA ?? 0),
    ftm: Number(base.FT ?? 0),
    ftPct: Number(base.FT_PCT ?? 0),

    // Diagnostic
    _dataQuality: {
      starterSource,
      touchesSource,
      hasBioData: !!bio,
      hasTouchData: !!touchData,
      hasAdvancedData: !!advanced,
      source: 'basketball-reference'
    },

    _raw: {
      PTS: Number(base.PTS),
      REB: Number(base.REB),
      AST: Number(base.AST),
      FG3M: Number(base.FG3M),
      MIN: mpg,
      USG_PCT: usageRate,
      GP: Number(base.GP),
      GS: Number(base.GS) || (bio ? Number(bio.GS) : null),
      PF: pfPerGame,
      // ADDED June 1: TS%, FT volume, FGA, POS — consumed by buildV2Roster in
      // slate.js (it already checks raw.TS_PCT / raw.FTA / raw.POS and falls
      // back when absent; these make the real values available).
      TS_PCT: Number(advanced?.TS_PCT ?? 0) || null,
      FG_PCT: Number(base.FG_PCT ?? 0) || null,
      FTA: Number(base.FTA ?? 0),
      FT: Number(base.FT ?? 0),
      FGA: Number(base.FGA ?? 0),
      POS: base.POS || null,
      HEIGHT_IN: bio ? Number(bio.PLAYER_HEIGHT_INCHES) : null,
      TOUCHES: touchData ? Number(touchData.TOUCHES) : null
    }
  };
}

// =============================================================
// EXPORTS FOR TESTING
// =============================================================

export const _testing = {
  normalizeBaseRow,
  normalizeAdvancedRow,
  mergePlayerStats,
  toNum
};
