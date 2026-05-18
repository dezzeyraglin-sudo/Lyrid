// api/wnba/debug-espn-player.js
//
// DEBUG ENDPOINT (May 18, 2026)
//
// Tests ESPN's WNBA player data endpoints to determine what player-level
// data is actually available from a CDN source Vercel can reach.
//
// Tests two endpoints:
//   1. /teams/{teamId}/roster — does ESPN expose rosters?
//   2. /athletes/{playerId}/stats — does ESPN expose season stats per player?
//      (Critical: do these include USG%, TS%, or just basic box-score?)
//
// USAGE: POST { teamId: "9" } (Liberty) or GET (defaults to Liberty)

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba";
const ESPN_WEB_BASE = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json"
};

async function readBody(req) {
  if (req.method !== "POST") return {};
  try { return await req.json(); }
  catch { return {}; }
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    const status = res.status;
    const text = await res.text();
    const duration = Date.now() - start;
    let parsed = null, parseErr = null;
    try { parsed = JSON.parse(text); } catch (e) { parseErr = e.message; }
    return { status, duration, size: text.length, parsed, parseErr, raw: text.slice(0, 2000) };
  } catch (err) {
    clearTimeout(timer);
    return { error: err.message, errorName: err.name, duration: Date.now() - start };
  }
}

export default async function handler(req, res) {
  try {
    const body = await readBody(req);
    // ESPN team ID 9 = New York Liberty (easy to verify roster)
    const teamId = body.teamId || "9";
    const season = body.season || "2026";

    const results = {};

    // TEST 1: Team roster
    const rosterUrl = `${ESPN_BASE}/teams/${teamId}/roster`;
    results.roster = {
      url: rosterUrl,
      ...await fetchJson(rosterUrl)
    };

    // Extract one player ID from roster to test stats endpoint
    let testPlayerId = null;
    let testPlayerName = null;
    if (results.roster.parsed?.athletes) {
      // The athletes structure is usually [{ position: 'guards', items: [{id, fullName, ...}] }, ...]
      const athletes = results.roster.parsed.athletes;
      if (Array.isArray(athletes)) {
        for (const group of athletes) {
          if (group.items?.length) {
            testPlayerId = String(group.items[0].id);
            testPlayerName = group.items[0].fullName || group.items[0].displayName;
            break;
          }
        }
      }
    }
    results.testPlayer = { id: testPlayerId, name: testPlayerName };

    // TEST 2: Player season stats (if we got an ID)
    if (testPlayerId) {
      const statsUrl = `${ESPN_WEB_BASE}/athletes/${testPlayerId}/stats?season=${season}`;
      results.playerStats = {
        url: statsUrl,
        ...await fetchJson(statsUrl)
      };

      // Try the alternative "overview" endpoint
      const overviewUrl = `${ESPN_WEB_BASE}/athletes/${testPlayerId}/overview`;
      results.playerOverview = {
        url: overviewUrl,
        ...await fetchJson(overviewUrl)
      };
    }

    // TEST 3: League leaders endpoint (might give us bulk stats in one call)
    const leadersUrl = `${ESPN_BASE}/leaders?season=${season}`;
    results.leaders = {
      url: leadersUrl,
      ...await fetchJson(leadersUrl)
    };

    // Summary view — what stats fields actually came back
    const summary = {
      rosterReachable: results.roster.status === 200,
      rosterPlayerCount: results.roster.parsed?.athletes?.reduce?.((acc, g) => acc + (g.items?.length || 0), 0) || 0,
      statsReachable: results.playerStats?.status === 200,
      overviewReachable: results.playerOverview?.status === 200,
      leadersReachable: results.leaders?.status === 200,
      // What's IN the stats response? This is the critical question.
      statsTopLevelKeys: results.playerStats?.parsed ? Object.keys(results.playerStats.parsed) : null,
      statsCategoriesAvailable: results.playerStats?.parsed?.categories?.map(c => ({
        name: c.name,
        displayName: c.displayName,
        statCount: c.stats?.length,
        sampleStats: c.stats?.slice(0, 5).map(s => ({ name: s.name, displayName: s.displayName, value: s.value }))
      })) || null,
      overviewKeys: results.playerOverview?.parsed ? Object.keys(results.playerOverview.parsed) : null
    };

    return res.status(200).json({
      ok: true,
      teamId,
      season,
      summary,
      results
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
}
