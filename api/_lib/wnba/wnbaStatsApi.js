// api/_lib/wnba/wnbaStatsApi.js
//
// stats.wnba.com API CLIENT (May 16, 2026 — Session 2)
//
// stats.wnba.com is the undocumented official WNBA stats API. It mirrors
// stats.nba.com architecture and is what most public-facing WNBA analytics
// tools use. It is NOT documented officially, but the request patterns are
// well-known in the basketball analytics community.
//
// CRITICAL: requires specific headers or returns 403. Datacenter IP ranges
// can also get rate-limited. We compensate with:
//   - Standard browser-mimicking headers
//   - 5-second timeout (kills slow requests fast)
//   - Retry with exponential backoff (max 3 attempts)
//   - In-memory cache (60min for season data, 15min for game logs)
//   - Graceful degradation: callers should handle null returns
//
// ENDPOINT PATTERNS (verified against public docs):
//   /stats/leaguedashplayerstats   — season stats per player
//   /stats/playergamelog            — game-by-game stats for one player
//   /stats/commonteamroster         — team roster + player IDs
//   /stats/leaguedashteamstats      — team-level stats (pace, off/def rating)
//   /stats/scoreboardv3             — today's games + scores
//
// LeagueID for WNBA = "10" (NBA = "00", G-League = "20")

const STATS_WNBA_BASE = "https://stats.wnba.com/stats";

// Standard headers — without these, stats.wnba.com returns 403.
// These are the headers stats.nba.com officially documents as required and
// stats.wnba.com mirrors. Do not modify without testing.
const STANDARD_HEADERS = {
  "Host": "stats.wnba.com",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.wnba.com/",
  "Origin": "https://www.wnba.com",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Connection": "keep-alive"
};

// =============================================================
// IN-MEMORY CACHE
// =============================================================
// Serverless functions reset between cold starts so this cache doesn't
// persist across invocations. It DOES help within a single slate analysis
// where the same player might be looked up multiple times.

const _cache = new Map();

function cacheKey(endpoint, params) {
  // Sort param keys for deterministic cache hits regardless of param order
  const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return `${endpoint}?${sortedParams}`;
}

function cacheGet(key, ttlMs) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  // Bound cache size — drop oldest if we exceed 500 entries.
  // 500 chosen because a typical slate analysis touches ~50 players × a
  // few endpoints each = ~150 entries. 500 gives headroom for multiple
  // slate analyses within the same warm function.
  if (_cache.size > 500) {
    const oldest = [..._cache.keys()].slice(0, 50);
    for (const k of oldest) _cache.delete(k);
  }
}

// Default TTLs by endpoint. Season stats can be cached longer (only updates
// once per game day); game logs need fresher data after games finalize.
const TTL = {
  season: 60 * 60 * 1000,         // 60min — season aggregates change slowly
  gameLog: 15 * 60 * 1000,        // 15min — recent games may finalize/update
  teamStats: 60 * 60 * 1000,      // 60min — team aggregates change slowly
  schedule: 5 * 60 * 1000,        // 5min — game state changes fast
  roster: 60 * 60 * 1000          // 60min — rosters don't change mid-day
};

// =============================================================
// CORE FETCH WITH RETRY
// =============================================================

/**
 * Low-level GET with timeout + retry + exponential backoff.
 * Returns parsed JSON on success, null on failure (caller must handle).
 *
 * @param {string} endpoint - path under /stats, e.g. "/leaguedashplayerstats"
 * @param {Object} params - query string params
 * @param {Object} opts - { ttlMs, maxRetries, timeoutMs }
 */
export async function fetchWnbaStats(endpoint, params = {}, opts = {}) {
  const ttlMs = opts.ttlMs ?? TTL.season;
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8000;

  // Check cache first
  const key = cacheKey(endpoint, params);
  const cached = cacheGet(key, ttlMs);
  if (cached) return cached;

  // Build URL with query params
  const qs = new URLSearchParams(params).toString();
  const url = `${STATS_WNBA_BASE}${endpoint}?${qs}`;

  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: "GET",
        headers: STANDARD_HEADERS,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.status === 200) {
        const data = await res.json();
        cacheSet(key, data);
        return data;
      }

      // 403 means our headers are stale or we're rate-limited. Retry won't help.
      if (res.status === 403) {
        console.warn(`[wnbaStatsApi] 403 forbidden on ${endpoint} — likely rate limit or header issue`);
        return null;
      }

      // 404 means the resource doesn't exist (e.g. wrong player ID). Don't retry.
      if (res.status === 404) {
        return null;
      }

      // 5xx is server error — worth retrying
      lastError = new Error(`HTTP ${res.status} on ${endpoint}`);
    } catch (err) {
      lastError = err;
      // AbortError, network errors — retry
    }

    // Exponential backoff: 200ms, 600ms, 1800ms
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 200 * Math.pow(3, attempt)));
    }
  }

  console.warn(`[wnbaStatsApi] All ${maxRetries} attempts failed for ${endpoint}:`, lastError?.message);
  return null;
}

// =============================================================
// RESPONSE PARSER
// =============================================================
// stats.wnba.com returns data in a "resultSets" format with headers + rowSet:
//   { resultSets: [{ name, headers: [...], rowSet: [[...], [...]] }] }
// This helper turns it into an array of objects keyed by header names.

/**
 * Parse stats.wnba.com resultSets response into array of objects.
 *
 * @param {Object} response - parsed JSON from fetchWnbaStats
 * @param {string} resultSetName - which resultSet to parse (default: first)
 * @returns {Array<Object>} rows as objects keyed by header names
 */
export function parseResultSet(response, resultSetName = null) {
  if (!response?.resultSets || !Array.isArray(response.resultSets)) {
    return [];
  }

  // Find the matching result set by name, or default to first
  const rs = resultSetName
    ? response.resultSets.find(r => r.name === resultSetName)
    : response.resultSets[0];

  if (!rs || !Array.isArray(rs.headers) || !Array.isArray(rs.rowSet)) {
    return [];
  }

  return rs.rowSet.map(row => {
    const obj = {};
    rs.headers.forEach((h, i) => {
      obj[h] = row[i];
    });
    return obj;
  });
}

// =============================================================
// UTILITY EXPORTS FOR TESTING / DEBUGGING
// =============================================================

export const _testing = {
  _cache,
  STANDARD_HEADERS,
  STATS_WNBA_BASE,
  TTL,
  cacheKey,
  cacheGet,
  cacheSet
};

/**
 * Clear the in-memory cache. Useful for testing.
 */
export function _resetCache() {
  _cache.clear();
}
