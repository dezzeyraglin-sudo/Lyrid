// api/wnba/debug-schedule.js
//
// DEBUG ENDPOINT (May 18, 2026)
//
// Returns the raw stats.wnba.com schedule response so we can see what shape
// the API is actually returning. Used to diagnose why getGamesForDate returns
// empty arrays for dates that ESPN/wnba.com show games on.
//
// This is a diagnostic endpoint — not for end users. Remove after we fix
// the parser in wnbaSchedule.js.
//
// USAGE:
//   POST /api/wnba/debug-schedule with body { date: "2026-05-18" }
//   GET  /api/wnba/debug-schedule (uses today's date)
//
// Returns:
//   {
//     ok: true,
//     date,
//     formattedDate,
//     endpoint,
//     url,
//     httpStatus,
//     httpStatusText,
//     responseHeaders,
//     responseSize,
//     topLevelKeys,             // what keys are at the top of the response
//     scoreboardKeys,           // what's inside scoreboard (if present)
//     resultSetsInfo,           // what resultSets are present (if old shape)
//     gamesArrayLocation,       // where (if anywhere) we found a games array
//     gamesCount,
//     firstGameRaw,             // raw first game so we see its structure
//     rawResponseTruncated      // first 8KB of raw JSON for inspection
//   }

const STATS_WNBA_BASE = "https://stats.wnba.com/stats";

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

function formatDateForApi(isoDate) {
  // ISO format "2026-05-18" → API format "05/18/2026"
  const parts = String(isoDate).split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

async function readBody(req) {
  if (req.method !== "POST") return {};
  try { return await req.json(); }
  catch { return {}; }
}

/**
 * Walk the response object looking for arrays of games.
 * Returns the path (as a dot-notation string) where it found them, or null.
 */
function findGamesArray(obj, path = '') {
  if (!obj || typeof obj !== 'object') return null;

  // Direct hit: `games` array at this level
  if (Array.isArray(obj.games) && obj.games.length > 0) {
    return { path: path ? `${path}.games` : 'games', count: obj.games.length, sample: obj.games[0] };
  }

  // resultSets shape (older API)
  if (Array.isArray(obj.resultSets)) {
    for (let i = 0; i < obj.resultSets.length; i++) {
      const rs = obj.resultSets[i];
      if (rs?.name === 'GameHeader' && Array.isArray(rs.rowSet) && rs.rowSet.length > 0) {
        return {
          path: `${path}.resultSets[${i}].rowSet (name: GameHeader)`,
          count: rs.rowSet.length,
          headers: rs.headers,
          sample: rs.rowSet[0]
        };
      }
    }
    // Even if no GameHeader, log what resultSets exist
    return {
      path: 'resultSets (no GameHeader, see resultSetsInfo)',
      count: 0,
      _info: obj.resultSets.map(rs => ({ name: rs.name, rows: rs.rowSet?.length ?? 0 }))
    };
  }

  // Recursive walk — try common nesting points
  for (const key of ['scoreboard', 'data', 'response', 'body']) {
    if (obj[key] && typeof obj[key] === 'object') {
      const result = findGamesArray(obj[key], path ? `${path}.${key}` : key);
      if (result && result.count > 0) return result;
    }
  }

  return null;
}

export default async function handler(req, res) {
  try {
    const body = await readBody(req);
    const date = body.date || new Date().toISOString().split('T')[0];
    const formatted = formatDateForApi(date);

    // Try scoreboardv3 first
    const endpoint = '/scoreboardv3';
    const params = {
      LeagueID: '10',
      GameDate: formatted,
      DayOffset: '0'
    };

    const qs = new URLSearchParams(params).toString();
    const url = `${STATS_WNBA_BASE}${endpoint}?${qs}`;

    const startedAt = Date.now();
    let httpStatus, httpStatusText, responseHeaders, raw, parsed;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      const fetchRes = await fetch(url, {
        method: "GET",
        headers: STANDARD_HEADERS,
        signal: controller.signal
      });
      clearTimeout(timer);

      httpStatus = fetchRes.status;
      httpStatusText = fetchRes.statusText;
      // Capture a subset of response headers (interesting for diagnostics)
      responseHeaders = {};
      for (const [k, v] of fetchRes.headers.entries()) {
        if (k.toLowerCase().match(/content-type|content-length|cache-control|x-cache|server|cf-/)) {
          responseHeaders[k] = v;
        }
      }

      raw = await fetchRes.text();

      // Try to parse as JSON
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        return res.status(200).json({
          ok: false,
          stage: 'json_parse',
          error: parseErr.message,
          httpStatus,
          httpStatusText,
          responseHeaders,
          responseSize: raw.length,
          durationMs: Date.now() - startedAt,
          rawResponseTruncated: raw.slice(0, 8000),
          url
        });
      }
    } catch (fetchErr) {
      return res.status(200).json({
        ok: false,
        stage: 'fetch',
        error: fetchErr.message,
        url,
        durationMs: Date.now() - startedAt
      });
    }

    // Analyze the parsed response
    const topLevelKeys = Object.keys(parsed);

    let scoreboardKeys = null;
    if (parsed.scoreboard && typeof parsed.scoreboard === 'object') {
      scoreboardKeys = Object.keys(parsed.scoreboard);
    }

    let resultSetsInfo = null;
    if (Array.isArray(parsed.resultSets)) {
      resultSetsInfo = parsed.resultSets.map(rs => ({
        name: rs.name,
        headerCount: rs.headers?.length ?? 0,
        rowCount: rs.rowSet?.length ?? 0,
        headers: rs.headers?.slice(0, 20)  // first 20 headers to save space
      }));
    }

    const gamesArrayResult = findGamesArray(parsed);

    return res.status(200).json({
      ok: true,
      date,
      formattedDate: formatted,
      endpoint,
      url,
      httpStatus,
      httpStatusText,
      responseHeaders,
      responseSize: raw.length,
      durationMs: Date.now() - startedAt,
      topLevelKeys,
      scoreboardKeys,
      resultSetsInfo,
      gamesArrayLocation: gamesArrayResult,
      rawResponseTruncated: raw.slice(0, 8000)
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      stage: 'handler',
      error: err.message,
      stack: err.stack
    });
  }
}
