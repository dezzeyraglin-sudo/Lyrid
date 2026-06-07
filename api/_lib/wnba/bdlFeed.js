// api/_lib/wnba/bdlFeed.js
//
// BALLDONTLIE WNBA FEED (June 2, 2026)
//
// Supplies the data BallDontLie covers that bbref + the free Odds API do not:
//   - PLAYER PROPS  → real points/rebounds/assists lines (leaves shadow mode)
//   - LIVE SCORES   → in-progress box scores (the live-score feature)
//   - INJURIES      → player injury list (optional supplement to ESPN)
//
// TIER: Player Props, Betting Odds, and Box Scores require the GOAT plan
// ($39.99/mo) or the 48-hour GOAT trial. Players/Teams/Games are free-tier.
// On a 401 (tier/auth), the feed no-ops and reports it in _audit rather than
// throwing — the slate keeps inferring lines exactly as before.
//
// KEY: process.env.BDL_API_KEY, sent as `Authorization: <key>` (NO "Bearer").
// Set in Vercel env vars, never in code. If unset, every export no-ops.
//
// PORTABILITY: props are keyed by `${playerName}_${market}` — the SAME key the
// slate already uses for caller-provided propLines (gameLines.propLines). This
// means a future swap to Sportradar/SportsDataIO only needs a new feed module
// that emits the same key shape; the slate join logic is untouched. We do NOT
// leak BallDontLie's internal numeric IDs into the rest of the app.

const BDL_BASE = 'https://api.balldontlie.io/wnba/v1';
const TTL_MS = 5 * 60 * 1000;
const INJURY_TTL_MS = 30 * 60 * 1000;   // injuries change slowly; cache hard
const _cache = new Map();

function cacheGet(k){ const e=_cache.get(k); if(!e) return null; const ttl=e.ttl||TTL_MS; if(Date.now()-e.ts>ttl){_cache.delete(k); return null;} return e.data; }
function cacheSet(k,d,ttl){ _cache.set(k,{data:d,ts:Date.now(),ttl}); }

export function isBdlConfigured() {
  return Boolean(process.env.BDL_API_KEY);
}

// --- Trial-safe rate limiting -------------------------------------------------
// Tier spacing. ALL-STAR is 60 req/min, so ~1000ms (one call/second) keeps us
// safely under the cap with no perceptible lag. The old 13000ms default was for
// the 5/min trial. Override via BDL_MIN_GAP_MS if the tier changes (GOAT 600/min
// → set BDL_MIN_GAP_MS=0; trial 5/min → set 13000). The 429 retry below remains
// as a safety net regardless. Default now matches the ALL-STAR plan.
const MIN_GAP_MS = Number(process.env.BDL_MIN_GAP_MS ?? 1000);  // ~60 req/min (ALL-STAR)
let _lastCallAt = 0;
let _chain = Promise.resolve();
function spacedSlot() {
  // Queue each call so they fire one-at-a-time, MIN_GAP_MS apart.
  const run = _chain.then(async () => {
    const wait = Math.max(0, _lastCallAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCallAt = Date.now();
  });
  _chain = run.catch(() => {});
  return run;
}

async function rawFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': process.env.BDL_API_KEY },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { status: res.status, body: res.status === 200 ? await res.json() : await res.text().catch(() => '') };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, body: `fetch failed: ${err.message}` };
  }
}

async function bdlGet(path, params = {}, base = BDL_BASE, opts = {}) {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(`${k}[]`, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  const u = url.toString();
  // Priority calls (injuries) skip the inter-call spacer — they're the first and
  // most important fetch, one request, and must not wait behind the prop queue
  // or exceed the serverless function timeout.
  if (MIN_GAP_MS > 0 && !opts.priority) await spacedSlot();
  let res = await rawFetch(u);
  // One quick retry on 429. Keep the wait SHORT (3s) so the whole call finishes
  // inside Vercel's function timeout — a 13s wait + 8s fetch would abort.
  if (res.status === 429 && !opts.noRetry) {
    await new Promise(r => setTimeout(r, 3000));
    res = await rawFetch(u);
  }
  return res;
}

// WNBA box scores live on /player_stats for GOAT (the backtest spec confirmed
// /stats is a 404 for WNBA, which is why fetchWnbaPlayerStats returned empty and
// grading silently never ran). Resolve the working endpoint ONCE per cold start —
// try /player_stats first, fall back to /stats — and remember which answered 200.
let _statsEndpoint = null;
async function fetchStatsRows(params) {
  const candidates = _statsEndpoint ? [_statsEndpoint] : ['/player_stats', '/stats'];
  let last = { status: 0, body: '', path: candidates[candidates.length - 1] };
  for (const path of candidates) {
    const r = await bdlGet(path, params);
    if (r.status === 200) { _statsEndpoint = path; return { ...r, path }; }
    if (r.status === 401) return { ...r, path };   // tier gate — don't fall through
    last = { ...r, path };                          // 404/other → try the next candidate
  }
  return last;
}

// Map common BDL prop market labels → our internal market keys.
function normalizeMarket(label) {
  const s = String(label || '').toLowerCase().trim();
  // Reject exotic/derived markets (first-N-min, quarter/half, double-double, etc.)
  // so they don't pollute the standard full-game lines our engine projects.
  if (/first|min|_q[1-4]|quarter|half|double|triple|odd|even|streak|margin/.test(s)) return null;
  // Combined PRA first (so "pts+reb+ast" doesn't match plain points).
  if (s === 'pra' || (s.includes('pts') && s.includes('reb') && s.includes('ast'))
      || (s.includes('points') && s.includes('rebounds') && s.includes('assists'))) return 'pra';
  // Reject 2-way combos (points_assists, rebounds_assists, points_rebounds, etc.)
  // BEFORE the singular checks below — otherwise "points_assists" (a ~20-30 line)
  // matches `includes('assist')` and OVERWRITES the real single-stat assists line
  // (~5). This was the bug that made assists/rebounds show points-scale lines.
  const parts = [s.includes('point') || s.includes('pts'), s.includes('rebound') || s === 'reb',
                 s.includes('assist') || s === 'ast'].filter(Boolean).length;
  if (parts >= 2) return null;   // any multi-stat combo that isn't the full PRA → skip
  if (s.includes('rebound') || s === 'reb' || s === 'trb') return 'rebounds';
  if (s.includes('assist') || s === 'ast') return 'assists';
  if (s.includes('three') || s.includes('3pt') || s.includes('3-pt') || s.includes('3pm')) return 'threes';
  if (s === 'points' || s === 'pts' || (s.includes('point') && !s.includes('_'))) return 'points';
  return null;   // unknown/exotic — skip rather than invent a market key
}

function playerName(p) {
  // BDL props may carry player name directly or nested; handle both.
  if (p.player_name) return p.player_name;
  if (p.player && (p.player.first_name || p.player.last_name)) {
    return `${p.player.first_name || ''} ${p.player.last_name || ''}`.trim();
  }
  if (p.first_name || p.last_name) return `${p.first_name || ''} ${p.last_name || ''}`.trim();
  return null;
}

/**
 * Fetch WNBA player props for a date and normalize to propLines:
 *   { "Player Name_points": 18.5, "Player Name_rebounds": 7.5, ... }
 * keyed exactly like the slate's existing caller propLines.
 *
 * @param {string} dateYmd  YYYY-MM-DD (local date of the slate)
 */
export async function fetchWnbaProps(dateYmd, opts = {}) {
  const warnings = [];
  if (!isBdlConfigured()) {
    return { propLines: {}, propMeta: {}, _audit: { keyPresent: false, warnings: ['BDL_API_KEY not set — props skipped'] } };
  }

  const cacheKey = `bdl:props:${dateYmd}`;
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  // 1) Find the day's games to get game ids.
  const games = await bdlGet('/games', { 'dates': [dateYmd], per_page: 100 });
  if (games.status !== 200) {
    warnings.push(`games HTTP ${games.status}: ${String(games.body).slice(0,120)}`);
    return { propLines: {}, propMeta: {}, _audit: { keyPresent: true, httpStatus: games.status, gamesFound: 0, warnings } };
  }
  const gameIds = (games.body?.data || []).map(g => g.id);
  if (gameIds.length === 0) {
    warnings.push('no WNBA games for date');
    return { propLines: {}, propMeta: {}, _audit: { keyPresent: true, httpStatus: 200, gamesFound: 0, warnings } };
  }

  // 2) Pull props per game (v1 base, underscore path — confirmed live), resolve
  // numeric player_id → name, and flatten to name_market → line.
  const propLines = {};
  const propMeta = {};
  let propRows = 0, tierBlocked = false;
  const idToName = {};            // player_id → "First Last", filled lazily per game
  const rawTypeCounts = {};       // prop_type → count, including exotic (diagnostics)
  let rawRowsSeen = 0, overUnderSeen = 0;

  for (const gid of gameIds) {
    // WNBA player props live on the v1 base with an underscore path — confirmed
    // live via the probe. (NBA docs show v2; WNBA differs — uses v1.)
    const pr = await bdlGet('/odds/player_props', { game_id: gid });
    if (pr.status === 401) { tierBlocked = true; warnings.push('player_props 401 — GOAT tier/trial required'); break; }
    if (pr.status !== 200) { warnings.push(`player_props game ${gid} HTTP ${pr.status}`); continue; }
    const rows = pr.body?.data || [];
    rawRowsSeen += rows.length;
    if (rows.length === 0) continue;

    // Resolve any unknown player_ids for this game in one batched call.
    const unknownIds = [...new Set(rows.map(r => r.player_id).filter(id => id != null && !idToName[id]))];
    if (unknownIds.length) {
      const pl = await bdlGet('/players', { 'player_ids': unknownIds, per_page: 100 });
      if (pl.status === 200) {
        for (const p of (pl.body?.data || [])) {
          const nm = `${p.first_name || ''} ${p.last_name || ''}`.trim();
          if (p.id != null && nm) idToName[p.id] = nm;
        }
      }
    }

    for (const row of rows) {
      const rawType = String(row.prop_type || row.market?.type || row.type || 'unknown');
      rawTypeCounts[rawType] = (rawTypeCounts[rawType] || 0) + 1;
      const isOverUnder = row.market?.type === 'over_under' || row.market?.over_odds != null;
      if (isOverUnder) overUnderSeen++;
      const name = idToName[row.player_id] || (row.player_name) || null;
      const market = normalizeMarket(row.prop_type || row.market?.type || row.type);
      const line = Number(row.line_value ?? row.line ?? row.value);
      // Sanity bounds: reject physically implausible lines (BDL occasionally returns
      // garbage, e.g. a 14.5 "assists" line — no WNBA player is remotely near that).
      // These ceilings sit well above any real line but below combo/typo values.
      const MARKET_MAX = { points: 45, rebounds: 22, assists: 13, threes: 9, pra: 70 };
      const withinBounds = market && Number.isFinite(line) && line > 0
        && line <= (MARKET_MAX[market] ?? 70);
      if (name && market && withinBounds) {
        const key = `${name}_${market}`;
        const vendor = String(row.vendor || row.book || '').toLowerCase();
        // Vendor preference: PrizePicks/Underdog aren't carried by BDL, so among
        // the available sportsbooks we prefer DraftKings → FanDuel → BetRivers.
        // (Lower rank = more preferred.) Anything else ranks last.
        const VENDOR_RANK = { draftkings: 0, fanduel: 1, betrivers: 2 };
        const rank = VENDOR_RANK[vendor] != null ? VENDOR_RANK[vendor] : 9;
        const prevRank = propMeta[key]?._rank ?? 99;
        // Take this row if: nothing yet, OR this vendor is more preferred, OR same
        // vendor but this is the standard over/under (vs a milestone ladder).
        const better = propLines[key] == null || rank < prevRank || (rank === prevRank && isOverUnder);
        if (better) {
          propLines[key] = line;
          propMeta[key] = {
            vendor: row.vendor || row.book || null,
            _rank: rank,
            overOdds: row.market?.over_odds ?? null,
            underOdds: row.market?.under_odds ?? null,
            updatedAt: row.updated_at || null,
          };
        }
        propRows++;
      }
    }
  }

  const result = {
    propLines,
    propMeta,
    _audit: { keyPresent: true, httpStatus: 200, gamesFound: gameIds.length,
      propRows, tierBlocked, source: 'balldontlie',
      rawRowsSeen, overUnderSeen, rawTypeCounts, warnings },
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Live box scores for in-progress games → quick score map for the UI.
 * @returns { byMatchup: { "AWAY@HOME": { home, away, homeScore, awayScore, status, period, clock } } }
 */
/**
 * Fetch FINAL team scores for a date, for grading WNBA game-line bets (total /
 * moneyline / spread). Uses /games, which works on ALL-STAR (no player_stats /
 * GOAT gate). Returns games keyed by matchup AND by gameId, with finished flag.
 *
 *   { byGame: { "<gameId>": { home, away, homeScore, awayScore, final } },
 *     byMatchup: { "AWAY@HOME": {...same...} }, _audit }
 */
export async function fetchWnbaGameScores(dateYmd, opts = {}) {
  if (!isBdlConfigured()) return { byGame: {}, byMatchup: {}, _audit: { keyPresent: false } };
  const cacheKey = `bdl:scores:${dateYmd}`;
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  const games = await bdlGet('/games', { 'dates': [dateYmd], per_page: 100 });
  if (games.status !== 200) {
    return { byGame: {}, byMatchup: {}, _audit: { keyPresent: true, httpStatus: games.status, warnings: [`games HTTP ${games.status}`] } };
  }
  const byGame = {}, byMatchup = {};
  for (const g of (games.body?.data || [])) {
    const home = g.home_team?.abbreviation || g.home_team_abbr;
    const away = g.visitor_team?.abbreviation || g.away_team_abbr;
    if (!home || !away) continue;
    const s = String(g.status || '').toLowerCase();
    const final = (s === 'post' || s.includes('final') || s === 'f');
    const homeScore = g.home_score ?? g.home_team_score ?? null;
    const awayScore = g.away_score ?? g.visitor_team_score ?? null;
    const rec = { gameId: String(g.id), home, away, homeScore, awayScore, final, status: g.status || null };
    byGame[String(g.id)] = rec;
    byMatchup[`${away}@${home}`] = rec;
  }
  const result = { byGame, byMatchup, _audit: { keyPresent: true, httpStatus: 200, games: Object.keys(byGame).length } };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch ALL finished games for a season (paginated), normalized for the
 * empirical-totals rolling-stats builder. Works on ALL-STAR (final scores only).
 * Cached per season — the history only grows, so a short TTL is fine.
 *
 *   -> [{ id, date 'YYYY-MM-DD', season, postseason, home_abbr, away_abbr,
 *         home_score, away_score, status }]
 */
export async function fetchWnbaSeasonGames(season, opts = {}) {
  if (!isBdlConfigured()) return { games: [], _audit: { keyPresent: false } };
  const cacheKey = `bdl:season:${season}`;
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  const out = [];
  let cursor = null, pages = 0;
  const warnings = [];
  while (pages < 30) {
    const params = { 'seasons[]': season, per_page: 100 };
    if (cursor != null) params.cursor = cursor;
    const r = await bdlGet('/games', params);
    if (r.status !== 200) { warnings.push(`season ${season} HTTP ${r.status}`); break; }
    for (const g of (r.body?.data || [])) {
      const home = g.home_team?.abbreviation || g.home_team_abbr;
      const away = g.visitor_team?.abbreviation || g.away_team_abbr;
      if (!home || !away) continue;
      out.push({
        id: String(g.id), date: (g.date || '').slice(0, 10), season,
        postseason: !!g.postseason,
        home_abbr: home, away_abbr: away,
        home_score: g.home_score ?? g.home_team_score ?? null,
        away_score: g.away_score ?? g.visitor_team_score ?? null,
        status: g.status || null,
      });
    }
    cursor = r.body?.meta?.next_cursor;
    pages++;
    if (cursor == null) break;
  }
  const result = { games: out, _audit: { keyPresent: true, season, games: out.length, pages, warnings } };
  cacheSet(cacheKey, result);
  return result;
}

// Normalize a player name for cross-source joins (BDL box-score names vs the
// slate's player.name). Mirrors slate.js normPlayerName.
function normNameBdl(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Season-wide player box scores from /player_stats (cursor-paginated), grouped by
 * NORMALIZED player name → games[] (newest-first). Replaces the bbref game-log
 * scrape, which Sports-Reference hard-429s from Vercel's shared IPs. Cached per
 * season. On GOAT set BDL_MIN_GAP_MS=0 so the pages don't serialize behind a 1s gap.
 *
 * Each game matches the shape aggregateRecentForm/propSignal expect:
 *   { date, minutes, points, rebounds, assists, threes, fgm, fga, ftm, fta,
 *     turnovers, pra, pa, pr, ra }
 *
 * @returns {Promise<{ byName: Object, _audit: Object }>}
 */
export async function fetchWnbaPlayerSeasonLogs(season, opts = {}) {
  if (!isBdlConfigured()) return { byName: {}, _audit: { keyPresent: false } };
  const cacheKey = `bdl:playerlogs:${season}`;
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  // game_id -> date, so rows that only carry a game id can still be dated/sorted.
  const gameDate = {};
  try {
    const sg = await fetchWnbaSeasonGames(season);
    for (const g of (sg.games || [])) gameDate[String(g.id)] = g.date;
  } catch (_) { /* non-fatal: rows usually carry their own date */ }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const parseMin = (v) => {
    if (v == null || v === '') return 0;
    const s = String(v);
    if (s.includes(':')) { const [m, sec] = s.split(':').map(Number); return Number.isFinite(m) ? Number((m + (Number(sec) || 0) / 60).toFixed(2)) : 0; }
    const n = Number(s); return Number.isFinite(n) ? n : 0;
  };

  const byName = {};
  const warnings = [];
  let cursor = null, pages = 0, rows = 0, endpoint = null;
  while (pages < 80) {
    const params = { 'seasons[]': season, per_page: 100 };
    if (cursor != null) params.cursor = cursor;
    const st = await fetchStatsRows(params);
    endpoint = st.path || endpoint;
    if (st.status === 401) { warnings.push(`player_stats 401 — GOAT tier required (${st.path})`); break; }
    if (st.status !== 200) { warnings.push(`player_stats HTTP ${st.status} (${st.path})`); break; }
    for (const r of (st.body?.data || [])) {
      const name = playerName(r) || playerName({ player: r.player });
      if (!name) continue;
      const gid = String(r.game?.id ?? r.game_id ?? '');
      const date = ((r.game?.date || r.date || gameDate[gid] || '')).slice(0, 10) || null;
      const minutes = parseMin(r.min ?? r.minutes);
      const points = num(r.pts ?? r.points);
      const rebounds = num(r.reb ?? r.rebounds ?? r.total_rebounds);
      const assists = num(r.ast ?? r.assists);
      const threes = num(r.fg3m ?? r.three_pointers_made ?? r.fg3);
      const didPlay = minutes > 0 || points != null || rebounds != null;
      if (!didPlay) continue;   // drop DNPs so they don't poison cold-form
      const p = points ?? 0, rb = rebounds ?? 0, as = assists ?? 0;
      const key = normNameBdl(name);
      (byName[key] = byName[key] || { name, games: [] }).games.push({
        date, minutes,
        points: p, rebounds: rb, assists: as, threes: threes ?? 0,
        fgm: num(r.fgm ?? r.field_goals_made) ?? 0, fga: num(r.fga ?? r.field_goals_attempted) ?? 0,
        ftm: num(r.ftm ?? r.free_throws_made) ?? 0, fta: num(r.fta ?? r.free_throws_attempted) ?? 0,
        turnovers: num(r.turnover ?? r.turnovers ?? r.tov) ?? 0,
        pra: p + rb + as, pa: p + as, pr: p + rb, ra: rb + as,
      });
      rows++;
    }
    cursor = st.body?.meta?.next_cursor;
    pages++;
    if (cursor == null) break;
  }

  // newest-first per player
  for (const k of Object.keys(byName)) {
    byName[k].games.sort((a, b) => (a.date && b.date) ? (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) : 0);
  }

  const result = { byName, _audit: { keyPresent: true, season, statsEndpoint: endpoint,
    players: Object.keys(byName).length, rows, pages, warnings } };
  cacheSet(cacheKey, result);
  return result;
}

export async function fetchWnbaLiveScores(opts = {}) {
  if (!isBdlConfigured()) return { byMatchup: {}, _audit: { keyPresent: false } };
  const cacheKey = 'bdl:live';
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  const res = await bdlGet('/box_scores/live');
  if (res.status !== 200) {
    return { byMatchup: {}, _audit: { keyPresent: true, httpStatus: res.status,
      warnings: [`live box scores HTTP ${res.status}`] } };
  }
  const byMatchup = {};
  for (const g of (res.body?.data || res.body || [])) {
    const home = g.home_team?.abbreviation || g.home_team_abbr;
    const away = g.visitor_team?.abbreviation || g.away_team_abbr;
    if (!home || !away) continue;
    byMatchup[`${away}@${home}`] = {
      home, away,
      homeScore: g.home_team_score ?? g.home_score ?? null,
      awayScore: g.visitor_team_score ?? g.away_score ?? null,
      status: g.status || null, period: g.period ?? null, clock: g.time || null,
    };
  }
  const result = { byMatchup, _audit: { keyPresent: true, httpStatus: 200, games: Object.keys(byMatchup).length } };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch ACTUAL per-player box-score results for a date, for grading predictions.
 * Returns a name-keyed map of the real stat line so the history tab can mark
 * each tracked prop win/loss and measure projection error (MAE).
 *
 *   { byPlayer: { "Player Name": { points, rebounds, assists, threes, pra,
 *                                  minutes, didPlay, final } }, _audit }
 *
 * Uses the Game Player Stats endpoint (/stats), which carries flat per-game
 * box lines. Field names are read defensively (pts/points, reb/rebounds, etc.)
 * so a provider/shape change degrades instead of breaking.
 */
export async function fetchWnbaPlayerStats(dateYmd, opts = {}) {
  if (!isBdlConfigured()) {
    return { byPlayer: {}, _audit: { keyPresent: false, warnings: ['BDL_API_KEY not set'] } };
  }
  const cacheKey = `bdl:stats:${dateYmd}`;
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  const warnings = [];
  // Resolve the day's games first (also tells us which are final).
  const games = await bdlGet('/games', { 'dates': [dateYmd], per_page: 100 });
  if (games.status !== 200) {
    return { byPlayer: {}, _audit: { keyPresent: true, httpStatus: games.status,
      warnings: [`games HTTP ${games.status}`] } };
  }
  const gameList = games.body?.data || [];
  const finalById = {};
  for (const g of gameList) {
    const isFinal = /final/i.test(String(g.status || '')) || g.period >= 4 && /final/i.test(String(g.time || ''));
    finalById[g.id] = isFinal;
  }
  const gameIds = gameList.map(g => g.id);
  if (gameIds.length === 0) {
    return { byPlayer: {}, _audit: { keyPresent: true, httpStatus: 200, gamesFound: 0, warnings: ['no games'] } };
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const byPlayer = {};
  let rows = 0;
  // Pull box lines per game (stats endpoint paginates; one page covers a game's
  // ~24 players at per_page=100).
  for (const gid of gameIds) {
    const st = await fetchStatsRows({ 'game_ids': [gid], per_page: 100 });
    if (st.status === 401) { warnings.push(`player_stats 401 — GOAT tier/trial required (${st.path})`); break; }
    if (st.status !== 200) { warnings.push(`stats game ${gid} HTTP ${st.status} (${st.path})`); continue; }
    for (const row of (st.body?.data || [])) {
      const name = playerName(row) || playerName({ player: row.player });
      if (!name) continue;
      const pts = num(row.pts ?? row.points);
      const reb = num(row.reb ?? row.rebounds ?? row.total_rebounds);
      const ast = num(row.ast ?? row.assists);
      const fg3 = num(row.fg3m ?? row.three_pointers_made ?? row.fg3);
      const minRaw = row.min ?? row.minutes;
      const minutes = (typeof minRaw === 'string' && minRaw.includes(':'))
        ? num(minRaw.split(':')[0]) : num(minRaw);
      const didPlay = (minutes != null && minutes > 0) || pts != null || reb != null;
      byPlayer[name] = {
        points: pts, rebounds: reb, assists: ast, threes: fg3,
        pra: (pts != null && reb != null && ast != null) ? pts + reb + ast : null,
        minutes, didPlay, final: finalById[gid] === true,
      };
      rows++;
    }
  }
  const result = { byPlayer, _audit: { keyPresent: true, httpStatus: 200,
    gamesFound: gameIds.length, playerRows: rows, statsEndpoint: _statsEndpoint, warnings } };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch WNBA player injuries from BallDontLie, normalized + name-keyed.
 * Sole injury source (ESPN removed). Tries candidate paths and uses whichever
 * returns 200, so it is self-correcting if BDL's WNBA injuries path differs.
 *
 *   { byName: { "normalized name": {...} }, byTeamAbbrev: {}, all: [...], _audit }
 */
export async function fetchWnbaInjuries(opts = {}) {
  if (!isBdlConfigured()) return { byName: {}, byTeamAbbrev: {}, all: [], _audit: { keyPresent: false } };

  const cacheKey = 'bdl:injuries';
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  // Try the likely WNBA injuries paths in order; first 200 with an array wins.
  const paths = ['/player_injuries', '/injuries', '/players/injuries'];
  let rows = null, pathUsed = null, lastStatus = null;
  for (const p of paths) {
    const res = await bdlGet(p, { per_page: 100 }, BDL_BASE, { priority: true });
    lastStatus = res.status;
    if (res.status === 200 && Array.isArray(res.body?.data)) { rows = res.body.data; pathUsed = p; break; }
    // 429 = right endpoint, just throttled (trial cap). Don't fall through to a
    // wrong path — stop and report so a retry later succeeds on this same path.
    if (res.status === 429) break;
  }
  if (!rows) {
    return { byName: {}, byTeamAbbrev: {}, all: [],
      _audit: { keyPresent: true, httpStatus: lastStatus, pathsTried: paths,
        warnings: [`no injuries path returned data (last status ${lastStatus})`] } };
  }

  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const mapStatus = (s) => {
    const t = String(s || '').toLowerCase();
    if (!t) return 'OUT';
    if (t.includes('out') || t.includes('season') || t.includes('inactive')) return 'OUT';
    if (t.includes('doubt')) return 'DOUBTFUL';
    if (t.includes('quest')) return 'QUESTIONABLE';
    if (t.includes('day')) return 'DAY_TO_DAY';
    if (t.includes('prob') || t.includes('available')) return 'PROBABLE';
    return String(s).toUpperCase();
  };
  const teamAbbr = (row) => {
    const t = row?.team || row?.player?.team;
    if (!t) return null;
    return String(t.abbreviation || t.abbr || t).toUpperCase();
  };

  const byName = {}; const byTeamAbbrev = {}; const all = [];
  for (const row of rows) {
    const nm = playerName(row) || playerName({ player: row.player });
    if (!nm) continue;
    const ab = teamAbbr(row);
    const entry = {
      playerName: nm,
      status: mapStatus(row.status || row.injury_status),
      detail: row.description || row.comment || row.note || row.return_date || null,
      teamAbbrev: ab,
      source: 'balldontlie',
    };
    byName[norm(nm)] = entry;
    all.push(entry);
    if (ab) (byTeamAbbrev[ab] = byTeamAbbrev[ab] || []).push(entry);
  }
  const result = { byName, byTeamAbbrev, all,
    _audit: { keyPresent: true, httpStatus: 200, pathUsed, count: all.length } };
  cacheSet(cacheKey, result, INJURY_TTL_MS);
  return result;
}

export const _testing = { normalizeMarket, playerName, BDL_BASE };
