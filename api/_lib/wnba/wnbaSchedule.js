// api/_lib/wnba/wnbaSchedule.js
//
// WNBA SCHEDULE FETCHER (May 18, 2026 — ESPN MIGRATION)
//
// HISTORY:
//   Session 4 (May 16) — built against stats.wnba.com /scoreboardv3
//   May 18 — migrated to ESPN after confirming Vercel functions can't reach
//     stats.wnba.com's scoreboardv3 endpoint (requests time out at 15s
//     consistently). Diagnosed via /api/wnba/debug-schedule.
//
// WHY ESPN:
//   - CDN-fronted endpoint (site.api.espn.com), no datacenter IP blocking
//   - Public/semi-public, used by countless analytics sites
//   - Returns all the data we need: games, teams, statuses, times
//   - Bonus: sometimes includes odds (spread/total) when available
//
// CONTRACT:
//   Returns the SAME shape as the previous stats.wnba.com version so
//   slate.js doesn't need to change. The internal mapping is different,
//   but external consumers see identical normalized objects.
//
// ENDPOINT:
//   https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard
//
//   Query params:
//     dates=YYYYMMDD   — single day
//     (no date param)  — defaults to "today" by ESPN's clock (US Eastern)

const ESPN_WNBA_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard";

// In-memory cache (parallels wnbaStatsApi.js pattern)
// Schedule data is volatile so TTL is short
const _cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(date) {
  return `espn-schedule:${date}`;
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  if (_cache.size > 100) {
    const oldest = [..._cache.keys()].slice(0, 20);
    for (const k of oldest) _cache.delete(k);
  }
}

// =============================================================
// TEAM ABBREVIATION MAPPING
// =============================================================
// ESPN and stats.wnba.com use different team tricodes in some cases.
// Since our player/team data layer keys on stats.wnba.com's tricodes,
// we translate ESPN's tricodes to match before exposing game objects.
//
// MAPPING NOTE: This is my best-knowledge mapping. If a team doesn't
// match after deploy (slate returns empty for one team), check the
// _rawEspnAbbr field on the affected game and update this map.

const ESPN_TO_STATS_TRICODE = {
  // ESPN abbr  →  stats.wnba.com abbr
  'NY':   'NYL',  // New York Liberty
  'LV':   'LVA',  // Las Vegas Aces
  'LA':   'LAS',  // Los Angeles Sparks (sometimes LA in newer ESPN data)
  'WSH':  'WAS',  // Washington Mystics
  'PHX':  'PHO',  // Phoenix Mercury (sometimes PHX, sometimes PHO)
  'CONN': 'CON',  // Connecticut Sun (sometimes CONN, sometimes CON)
  'GS':   'GSV',  // Golden State Valkyries (new team, varies)
  // Pass-throughs (same tricode in both systems):
  // ATL, CHI, DAL, IND, MIN, SEA pass through unchanged
};

function normalizeTeamAbbr(espnAbbr) {
  if (!espnAbbr) return null;
  const upper = String(espnAbbr).toUpperCase();
  return ESPN_TO_STATS_TRICODE[upper] || upper;
}

// =============================================================
// CORE FETCH
// =============================================================

/**
 * Low-level ESPN fetch with timeout + retry.
 * Returns parsed JSON or null on failure.
 *
 * NOTE: uses Node's raw `https` module with a curl-style User-Agent, NOT the
 * built-in fetch(). ESPN's WAF blocks undici (fetch) by TLS fingerprint no matter
 * what User-Agent is sent — verified: fetch+Mozilla → 403, raw-https+curl → 200.
 * This is the same client wnbaFeedEspn.js uses. Do not switch back to fetch().
 */
async function fetchEspn(url, opts = {}) {
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const https = await import('node:https');

  const once = () => new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'curl/8.5.0', 'Accept': 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode === 404) { res.resume(); return resolve({ ok: false, notFound: true }); }
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, status: res.statusCode }); }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ ok: true, json: JSON.parse(data) }); } catch (e) { resolve({ ok: false, status: 'parse' }); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, status: e.message }));
  });

  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const r = await once();
    if (r.ok) return r.json;
    if (r.notFound) return null;      // 404 = no data for this date — don't retry
    lastError = new Error(`HTTP ${r.status}`);
    if (attempt < maxRetries - 1) await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
  }

  console.warn(`[wnbaSchedule] ESPN fetch failed after ${maxRetries} attempts:`, lastError?.message);
  return null;
}

// =============================================================
// PUBLIC API (unchanged signatures from previous version)
// =============================================================

/**
 * Get games for a specific date.
 *
 * @param {string} date - YYYY-MM-DD format (e.g. "2026-05-18")
 * @returns {Promise<Array<Object>>} array of normalized game objects
 */
export async function getGamesForDate(date) {
  if (!date) return [];

  const cached = cacheGet(cacheKey(date));
  if (cached) return cached;

  // ESPN wants date in YYYYMMDD (no separators)
  const espnDate = String(date).replace(/-/g, '');
  const url = `${ESPN_WNBA_SCOREBOARD}?dates=${espnDate}`;

  const response = await fetchEspn(url);
  if (!response) return [];

  // ESPN response shape:
  // {
  //   leagues: [...],
  //   events: [
  //     {
  //       id, uid, date (ISO),
  //       status: { type: { id, state, completed, description }, period, clock },
  //       competitions: [
  //         {
  //           id, date, attendance,
  //           competitors: [
  //             { id, homeAway: 'home'|'away', team: { id, location, name, abbreviation, ... }, score },
  //             ...
  //           ],
  //           odds: [{ details: "LV -3.5", overUnder: 166.5, ... }]
  //         }
  //       ]
  //     }
  //   ]
  // }
  const events = Array.isArray(response.events) ? response.events : [];
  const games = events.map(normalizeEspnGame).filter(Boolean);

  cacheSet(cacheKey(date), games);
  return games;
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
 */
export async function getUpcomingGames(daysAhead = 0) {
  const results = [];
  for (let i = 0; i <= daysAhead; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const date = d.toISOString().split('T')[0];
    const games = await getGamesForDate(date);
    results.push(...games);
  }
  return results;
}

// =============================================================
// NORMALIZATION
// =============================================================

/**
 * Convert ESPN event to the normalized game shape that slate.js expects.
 * IMPORTANT: output shape must match the original stats.wnba.com version
 * so slate.js doesn't need to change.
 */
function normalizeEspnGame(event) {
  if (!event || !event.id) return null;

  const competition = Array.isArray(event.competitions) ? event.competitions[0] : null;
  if (!competition) return null;

  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');

  if (!home?.team || !away?.team) return null;

  // ESPN status mapping → our internal 1/2/3 system
  //   pre  → 1 (upcoming)
  //   in   → 2 (live)
  //   post → 3 (final)
  const state = event.status?.type?.state;
  let gameStatus = 1;
  if (state === 'in') gameStatus = 2;
  else if (state === 'post') gameStatus = 3;

  const statusLabel = event.status?.type?.description ||
    (gameStatus === 1 ? 'Upcoming' : gameStatus === 2 ? 'Live' : 'Final');

  // Odds (if ESPN has them)
  let spread = null;
  let total = null;
  if (Array.isArray(competition.odds) && competition.odds.length > 0) {
    const o = competition.odds[0];
    // overUnder is the total
    if (Number.isFinite(Number(o.overUnder))) total = Number(o.overUnder);
    // spread parsing: "LV -3.5" — we need to know whose perspective.
    // ESPN's `details` is "{abbr} {spread}" where abbr is the FAVORITE.
    // We normalize to home-team perspective: negative = home favored.
    if (typeof o.details === 'string') {
      const m = o.details.match(/^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/);
      if (m) {
        const favAbbr = m[1];
        const favSpread = Number(m[2]);
        if (Number.isFinite(favSpread)) {
          if (favAbbr === home.team.abbreviation) {
            spread = favSpread;  // home is favorite, spread is already from home perspective
          } else if (favAbbr === away.team.abbreviation) {
            spread = -favSpread; // away is favorite, flip sign for home perspective
          }
        }
      }
    }
  }

  return {
    gameId: String(event.id),
    status: statusLabel,
    gameStatus,
    gameTimeUTC: event.date || competition.date || null,
    gameTimeET: event.date || competition.date || null,
    home: {
      id: home.team.id ? Number(home.team.id) : null,
      abbr: normalizeTeamAbbr(home.team.abbreviation),
      _rawEspnAbbr: home.team.abbreviation || null,
      name: home.team.displayName || home.team.name || null,
      score: Number(home.score ?? 0)
    },
    away: {
      id: away.team.id ? Number(away.team.id) : null,
      abbr: normalizeTeamAbbr(away.team.abbreviation),
      _rawEspnAbbr: away.team.abbreviation || null,
      name: away.team.displayName || away.team.name || null,
      score: Number(away.score ?? 0)
    },
    spread,
    total,
    _shape: 'espn'
  };
}

// =============================================================
// EXPORTS FOR TESTING
// =============================================================

export const _testing = {
  normalizeEspnGame,
  normalizeTeamAbbr,
  fetchEspn,
  _cache
};
