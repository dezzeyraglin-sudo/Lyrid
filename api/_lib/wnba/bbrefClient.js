// api/_lib/wnba/bbrefClient.js
//
// BASKETBALL-REFERENCE CLIENT (May 18, 2026 — POST stats.wnba.com migration)
//
// WHY THIS EXISTS:
//   stats.wnba.com is unreachable from Vercel (confirmed via debug endpoints
//   on May 18 at ~5 AM). Requests consistently time out at 15 seconds.
//
//   basketball-reference.com is reachable from Vercel (avg 96ms response time
//   in testing) and contains the same data we need, in HTML form.
//
// WHAT THIS PROVIDES:
//   - Cached HTTP fetcher for basketball-reference pages
//   - HTML table parser (regex-based, no dependencies)
//   - Helper to extract rows from a specific table by id
//
// WHAT THIS IS NOT:
//   - A general-purpose scraper. We only parse the table structures
//     basketball-reference.com uses for WNBA pages.
//   - A long-running parser. Each function targets ONE table by id.
//
// DESIGN NOTES:
//   - basketball-reference loves "commented-out" tables — tables wrapped
//     in HTML comments (<!-- ... -->) that browsers render via JS but
//     server-side scraping must unwrap manually. We handle this.
//   - We cache aggressively (60 min TTL) because bbref doesn't change
//     stats mid-day and we don't want to hammer them.
//   - User-Agent header is required or bbref serves a different page.

const BBREF_BASE = 'https://www.basketball-reference.com';

const STANDARD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// =============================================================
// IN-MEMORY CACHE
// =============================================================

const _cache = new Map();

const TTL = {
  seasonStats: 60 * 60 * 1000,   // 60 min — bbref doesn't update mid-day usually
  playerStats: 60 * 60 * 1000,
  teamStats: 60 * 60 * 1000,
  gameLog: 30 * 60 * 1000,       // 30 min — game logs can update post-game
};

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
  if (_cache.size > 200) {
    const oldest = [..._cache.keys()].slice(0, 40);
    for (const k of oldest) _cache.delete(k);
  }
}

// =============================================================
// CORE FETCH
// =============================================================

/**
 * Fetch a basketball-reference page. Returns the raw HTML text or null on failure.
 *
 * @param {string} path - URL path, e.g. '/wnba/years/2026.html'
 * @param {Object} opts - { ttlMs, maxRetries, timeoutMs }
 * @returns {Promise<string|null>}
 */
export async function fetchBbrefPage(path, opts = {}) {
  const ttlMs = opts.ttlMs ?? TTL.seasonStats;
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 8000;

  const cacheKey = `bbref:${path}`;
  const cached = cacheGet(cacheKey, ttlMs);
  if (cached) return cached;

  const url = `${BBREF_BASE}${path}`;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: 'GET',
        headers: STANDARD_HEADERS,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.status === 200) {
        const html = await res.text();
        cacheSet(cacheKey, html);
        return html;
      }

      if (res.status === 404) return null;

      // 429 = rate limited. Don't retry immediately, the backoff below will help.
      lastError = new Error(`HTTP ${res.status} on ${path}`);
    } catch (err) {
      lastError = err;
    }

    // Exponential backoff: 500ms, 1500ms
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1) * 3));
    }
  }

  console.warn(`[bbrefClient] All ${maxRetries} attempts failed for ${path}:`, lastError?.message);
  return null;
}

// =============================================================
// HTML TABLE PARSER
// =============================================================
//
// basketball-reference tables follow this structure:
//
//   <table id="per_game" ...>
//     <thead>
//       <tr><th>...</th><th>...</th></tr>  ← header row (may have category headers)
//       <tr>
//         <th data-stat="ranker">Rk</th>
//         <th data-stat="player">Player</th>
//         <th data-stat="pts_per_g">PTS</th>
//         ...
//       </tr>
//     </thead>
//     <tbody>
//       <tr>
//         <th data-stat="ranker">1</th>
//         <td data-stat="player"><a href="/wnba/players/x/xxx.html">Player Name</a></td>
//         <td data-stat="pts_per_g">22.4</td>
//         ...
//       </tr>
//     </tbody>
//   </table>
//
// We extract each row as { [data-stat]: cellText } based on the data-stat attributes.

/**
 * Unwrap basketball-reference's commented-out tables.
 *
 * bbref hides many advanced tables inside HTML comments to defer rendering.
 * Server-side we need to strip the comment wrapping so the regex can find them.
 *
 * @param {string} html
 * @returns {string}
 */
export function unwrapCommentedTables(html) {
  if (!html) return '';
  // Replace <!-- ... --> wrappers (only around tables — keep other comments intact
  // by only unwrapping comments that contain a <table tag)
  return html.replace(/<!--([\s\S]*?)-->/g, (match, content) => {
    if (content.includes('<table')) return content;
    return match;
  });
}

/**
 * Extract a table by its HTML id attribute.
 *
 * @param {string} html - full page HTML
 * @param {string} tableId - the table's id attribute (e.g. "per_game")
 * @returns {string|null} the table's HTML, or null if not found
 */
export function extractTableHtml(html, tableId) {
  if (!html || !tableId) return null;
  // Match <table id="tableId" ... > ... </table>
  // Escape regex special chars in tableId
  const escapedId = tableId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableRegex = new RegExp(`<table[^>]*\\sid="${escapedId}"[^>]*>([\\s\\S]*?)</table>`, 'i');
  const m = html.match(tableRegex);
  return m ? m[0] : null;
}

/**
 * Parse rows from a basketball-reference table HTML.
 *
 * Returns an array of objects keyed by data-stat attribute.
 * Skips header rows (thead) and rows with class "thead" (mid-table headers).
 *
 * @param {string} tableHtml
 * @returns {Array<Object>}
 */
export function parseTableRows(tableHtml) {
  if (!tableHtml) return [];

  // Get just the tbody portion (skip thead).
  // If <tbody> exists, use it. Otherwise, strip <thead> blocks from the table HTML
  // so header rows don't get parsed as data rows.
  let body;
  const tbodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (tbodyMatch) {
    body = tbodyMatch[1];
  } else {
    // No <tbody> — strip all <thead>...</thead> blocks then process the rest
    body = tableHtml.replace(/<thead[^>]*>[\s\S]*?<\/thead>/gi, '');
  }

  // Split into individual <tr> rows
  const rows = [];
  const rowRegex = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(body)) !== null) {
    const rowAttrs = rowMatch[1] || '';
    const rowContent = rowMatch[2];

    // Skip mid-table header rows (class="thead")
    if (/class="[^"]*\bthead\b[^"]*"/.test(rowAttrs)) continue;
    // Skip rows that are just blank dividers
    if (!rowContent.trim()) continue;

    // Parse cells: <th data-stat="X"> or <td data-stat="X">
    const cells = {};
    const cellRegex = /<(?:th|td)[^>]*\sdata-stat="([^"]+)"[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const stat = cellMatch[1];
      const rawContent = cellMatch[2];
      // Strip HTML tags from cell content
      const text = stripHtml(rawContent).trim();
      cells[stat] = text;

      // For player cells, also extract the bbref player ID from the link
      if (stat === 'player' || stat === 'name_display') {
        const linkMatch = rawContent.match(/href="\/wnba\/players\/[a-z0-9]\/([a-z0-9]+\.html)"/i);
        if (linkMatch) {
          cells['bbref_player_id'] = linkMatch[1].replace('.html', '');
        }
      }
      // For team cells, extract the team abbreviation from the link
      if (stat === 'team_id' || stat === 'team_name_abbr') {
        const linkMatch = rawContent.match(/href="\/wnba\/teams\/([A-Z]+)\//);
        if (linkMatch) {
          cells['team_abbr_link'] = linkMatch[1];
        }
      }
    }

    if (Object.keys(cells).length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

/**
 * Strip HTML tags from a string, returning plain text.
 * Handles common entities (&amp;, &nbsp;, etc.)
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')         // remove fully-formed tags
    .replace(/<[^\s<>]*$/g, '')     // remove trailing unclosed tag fragment (e.g. "Player</strong")
    .replace(/^[^\s<>]*>/g, '')     // remove leading unclosed tag fragment (e.g. "strong>Player")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim();
}

/**
 * Convenience function: fetch a page, extract a table, parse rows.
 * The complete typical flow in one call.
 *
 * @param {string} path - URL path
 * @param {string} tableId - table id to extract
 * @param {Object} opts - passed to fetchBbrefPage
 * @returns {Promise<Array<Object>>}
 */
export async function fetchAndParseTable(path, tableId, opts = {}) {
  const html = await fetchBbrefPage(path, opts);
  if (!html) return [];

  // Some tables are in comments — unwrap first
  const unwrapped = unwrapCommentedTables(html);
  const tableHtml = extractTableHtml(unwrapped, tableId);
  if (!tableHtml) {
    console.warn(`[bbrefClient] Table id="${tableId}" not found on ${path}`);
    return [];
  }

  return parseTableRows(tableHtml);
}

// =============================================================
// EXPORTS FOR TESTING / DEBUGGING
// =============================================================

export const _testing = {
  _cache,
  TTL,
  BBREF_BASE,
  STANDARD_HEADERS,
  stripHtml
};

export function _resetCache() {
  _cache.clear();
}
