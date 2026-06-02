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

async function bdlGet(path, params = {}) {
  const url = new URL(`${BDL_BASE}${path}`);
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
  const s = String(label || '').toLowerCase();
  if (s.includes('rebound')) return 'rebounds';
  if (s.includes('assist')) return 'assists';
  if (s.includes('point')) return 'points';
  if (s.includes('three') || s.includes('3pt') || s.includes('3-pt')) return 'threes';
  if (s.includes('pra') || (s.includes('pts') && s.includes('reb') && s.includes('ast'))) return 'pra';
  return s.replace(/\s+/g, '_');
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

  // 2) Pull props per game and flatten to name_market → line.
  const propLines = {};
  let propRows = 0, tierBlocked = false;
  for (const gid of gameIds) {
    const pr = await bdlGet('/odds/player-props', { game_id: gid });
    if (pr.status === 401) { tierBlocked = true; warnings.push('player-props 401 — GOAT tier/trial required'); break; }
    if (pr.status !== 200) { warnings.push(`player-props game ${gid} HTTP ${pr.status}`); continue; }
    for (const row of (pr.body?.data || [])) {
      const name = playerName(row);
      const market = normalizeMarket(row.market || row.type || row.stat);
      const line = Number(row.line ?? row.value ?? row.over_under);
      if (name && market && Number.isFinite(line)) {
        propLines[`${name}_${market}`] = line;
        propRows++;
      }
    }
  }

  const result = {
    propLines,
    _audit: { keyPresent: true, httpStatus: 200, gamesFound: gameIds.length,
      propRows, tierBlocked, source: 'balldontlie', warnings },
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

export const _testing = { normalizeMarket, playerName, BDL_BASE };
