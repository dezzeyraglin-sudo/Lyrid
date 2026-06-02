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
const _cache = new Map();

function cacheGet(k){ const e=_cache.get(k); if(!e) return null; if(Date.now()-e.ts>TTL_MS){_cache.delete(k); return null;} return e.data; }
function cacheSet(k,d){ _cache.set(k,{data:d,ts:Date.now()}); }

export function isBdlConfigured() {
  return Boolean(process.env.BDL_API_KEY);
}

async function bdlGet(path, params = {}, base = BDL_BASE) {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(`${k}[]`, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url.toString(), {
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

// Map common BDL prop market labels → our internal market keys.
function normalizeMarket(label) {
  const s = String(label || '').toLowerCase().trim();
  // Reject exotic/derived markets (first-N-min, quarter/half, double-double, etc.)
  // so they don't pollute the standard full-game lines our engine projects.
  if (/first|min|_q[1-4]|quarter|half|double|odd|even|streak|margin/.test(s)) return null;
  // Combined first (so "pts+reb+ast" doesn't match plain points).
  if (s === 'pra' || (s.includes('pts') && s.includes('reb') && s.includes('ast'))
      || (s.includes('points') && s.includes('rebounds') && s.includes('assists'))) return 'pra';
  if (s.includes('rebound')) return 'rebounds';
  if (s.includes('assist')) return 'assists';
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
    return { propLines: {}, _audit: { keyPresent: false, warnings: ['BDL_API_KEY not set — props skipped'] } };
  }

  const cacheKey = `bdl:props:${dateYmd}`;
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  // 1) Find the day's games to get game ids.
  const games = await bdlGet('/games', { 'dates': [dateYmd], per_page: 100 });
  if (games.status !== 200) {
    warnings.push(`games HTTP ${games.status}: ${String(games.body).slice(0,120)}`);
    return { propLines: {}, _audit: { keyPresent: true, httpStatus: games.status, gamesFound: 0, warnings } };
  }
  const gameIds = (games.body?.data || []).map(g => g.id);
  if (gameIds.length === 0) {
    warnings.push('no WNBA games for date');
    return { propLines: {}, _audit: { keyPresent: true, httpStatus: 200, gamesFound: 0, warnings } };
  }

  // 2) Pull props per game (v1 base, underscore path — confirmed live), resolve
  // numeric player_id → name, and flatten to name_market → line.
  const propLines = {};
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
      if (name && market && Number.isFinite(line)) {
        // Prefer the standard over/under line over milestone ladders for a market.
        const key = `${name}_${market}`;
        if (propLines[key] == null || isOverUnder) propLines[key] = line;
        propRows++;
      }
    }
  }

  const result = {
    propLines,
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
    const st = await bdlGet('/stats', { 'game_ids': [gid], per_page: 100 });
    if (st.status === 401) { warnings.push('stats 401 — GOAT tier/trial required'); break; }
    if (st.status !== 200) { warnings.push(`stats game ${gid} HTTP ${st.status}`); continue; }
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
    gamesFound: gameIds.length, playerRows: rows, warnings } };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch WNBA player injuries from BallDontLie, normalized + name-keyed so they
 * merge with the ESPN feed. BDL often carries season-ending injuries that ESPN
 * drops off its active report (e.g. a torn ACL moved to the season-ending list).
 *
 *   { byName: { "normalized name": { playerName, status, detail, source } },
 *     all: [...], _audit }
 */
export async function fetchWnbaInjuries(opts = {}) {
  if (!isBdlConfigured()) return { byName: {}, all: [], _audit: { keyPresent: false } };
  const cacheKey = 'bdl:injuries';
  if (!opts.noCache) { const c = cacheGet(cacheKey); if (c) return c; }

  const res = await bdlGet('/player_injuries', { per_page: 100 });
  if (res.status !== 200) {
    return { byName: {}, all: [], _audit: { keyPresent: true, httpStatus: res.status,
      warnings: [`injuries HTTP ${res.status}`] } };
  }
  const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  // Map BDL status text → our normalized buckets.
  const mapStatus = (s) => {
    const t = String(s || '').toLowerCase();
    if (t.includes('out') || t.includes('season')) return 'OUT';
    if (t.includes('doubtful')) return 'DOUBTFUL';
    if (t.includes('question')) return 'QUESTIONABLE';
    if (t.includes('day')) return 'DAY_TO_DAY';
    return s ? String(s).toUpperCase() : 'OUT';
  };
  const byName = {}; const all = [];
  for (const row of (res.body?.data || [])) {
    const nm = playerName(row) || playerName({ player: row.player });
    if (!nm) continue;
    const entry = {
      playerName: nm,
      status: mapStatus(row.status),
      detail: row.description || row.comment || row.return_date || null,
      source: 'balldontlie',
    };
    byName[norm(nm)] = entry;
    all.push(entry);
  }
  const result = { byName, all, _audit: { keyPresent: true, httpStatus: 200, count: all.length } };
  cacheSet(cacheKey, result);
  return result;
}

export const _testing = { normalizeMarket, playerName, BDL_BASE };
