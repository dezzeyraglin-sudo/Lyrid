// api/wnba/debug-bbref.js
//
// DEBUG ENDPOINT (May 18, 2026)
//
// Tests basketball-reference.com WNBA pages for reachability from Vercel.
// We DO NOT need to parse the HTML here — just confirm:
//   1. Vercel can reach basketball-reference at all
//   2. Response time is acceptable (<3s) for downstream scraping
//   3. Page contains the expected stats tables (verified by string match)
//
// If reachable: we can scrape it for advanced stats later as needed.
// If blocked: we know hybrid plan needs a different advanced-stats source.

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

async function fetchUrl(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    const status = res.status;
    const contentType = res.headers.get('content-type');
    const text = await res.text();
    return {
      status,
      contentType,
      duration: Date.now() - start,
      size: text.length,
      // Check for expected markers — basketball-reference WNBA pages have these
      containsPerGameTable: text.includes('per_game') || text.includes('Per Game'),
      containsAdvancedTable: text.includes('advanced') || text.includes('Advanced'),
      containsTotals: text.includes('totals') || text.includes('Totals'),
      // First 1000 chars of HTML so we can see what came back
      htmlPreview: text.slice(0, 1000),
      // Look for the table IDs the scraper would target
      tableIdsFound: [
        ...new Set((text.match(/id="([a-z_]+)"/gi) || []).map(m => m.match(/id="([a-z_]+)"/i)[1]))
      ].slice(0, 30)
    };
  } catch (err) {
    clearTimeout(timer);
    return { error: err.message, errorName: err.name, duration: Date.now() - start };
  }
}

export default async function handler(req, res) {
  try {
    const results = {};

    // TEST 1: WNBA season page (per-game, advanced tables)
    results.seasonPage = {
      url: 'https://www.basketball-reference.com/wnba/years/2026.html',
      ...await fetchUrl('https://www.basketball-reference.com/wnba/years/2026.html')
    };

    // TEST 2: A specific player page (Breanna Stewart as a verified player)
    results.playerPage = {
      url: 'https://www.basketball-reference.com/wnba/players/s/stewabr01w.html',
      ...await fetchUrl('https://www.basketball-reference.com/wnba/players/s/stewabr01w.html')
    };

    // TEST 3: Team page (NY Liberty)
    results.teamPage = {
      url: 'https://www.basketball-reference.com/wnba/teams/NYL/2026.html',
      ...await fetchUrl('https://www.basketball-reference.com/wnba/teams/NYL/2026.html')
    };

    const summary = {
      seasonPageReachable: results.seasonPage.status === 200,
      playerPageReachable: results.playerPage.status === 200,
      teamPageReachable: results.teamPage.status === 200,
      seasonPageHasTables: results.seasonPage.containsPerGameTable && results.seasonPage.containsAdvancedTable,
      // Average response time across the three
      avgDurationMs: Math.round((
        (results.seasonPage.duration || 0) +
        (results.playerPage.duration || 0) +
        (results.teamPage.duration || 0)
      ) / 3),
      verdict: null
    };

    if (summary.seasonPageReachable && summary.playerPageReachable && summary.teamPageReachable) {
      summary.verdict = 'REACHABLE — can be used for advanced stats scraping';
    } else if (summary.seasonPageReachable || summary.playerPageReachable) {
      summary.verdict = 'PARTIALLY REACHABLE — investigate which pages fail';
    } else {
      summary.verdict = 'BLOCKED — basketball-reference not reachable from Vercel';
    }

    return res.status(200).json({
      ok: true,
      summary,
      results
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
}
