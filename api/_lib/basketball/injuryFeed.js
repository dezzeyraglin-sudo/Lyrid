/**
 * injuryFeed.js
 *
 * Fetches WNBA injuries from ESPN and produces a normalized InjuryReport.
 *
 * Two entry points:
 *   - fetchEspnWnbaInjuries()           -- live network fetch + parse
 *   - parseEspnInjuriesPayload(raw)     -- parse a captured raw payload (for tests / cron-fed JSON)
 *
 * Normalized output:
 *   {
 *     fetchedAt: ISOString,
 *     source: 'espn',
 *     byPlayerId: { [espnPlayerId]: InjuryRecord },
 *     byTeamAbbrev: { [teamAbbrev]: InjuryRecord[] },
 *     all: InjuryRecord[]
 *   }
 *
 *   InjuryRecord:
 *     {
 *       playerId, playerName, shortName, position, teamName, teamAbbrev,
 *       status,            // canonical enum: OUT | DOUBTFUL | GTD | PROBABLE | AVAILABLE
 *       rawStatus,         // ESPN's original string ("Day-To-Day")
 *       espnTypeId,        // ESPN's type.id ("6" for D2D etc) -- preserved for audit
 *       estReturnDate,     // ESPN's free-text date ("May 22")
 *       comment,           // free-text reporter note
 *       espnHref           // link back to ESPN player page
 *     }
 *
 * Design notes:
 *   - ESPN renders the page server-side and embeds a structured JSON payload at
 *     `window['__espnfitt__'].page.content.injuries`. That's the parse target, not HTML tables.
 *     The HTML tables are just a rendering of the same data and are less reliable to scrape.
 *   - Status normalization: ESPN's `type.id` is the source of truth. The string `statusDesc`
 *     is a fallback only. type.id "6" = day-to-day, "7" = out, "8" = doubtful, "9" = probable
 *     based on ESPN's standard injury enum (consistent across NBA/NFL/MLB feeds).
 *   - We map "Day-To-Day" to GTD (game-time-decision) internally because that's how the
 *     minutes engine uses it: full projection with reduced confidence.
 *   - Team-abbrev normalization happens via TEAM_ABBREV_MAP. ESPN uses some team names that
 *     differ from our internal tricodes (e.g. "Golden State Valkyries" -> "GSV" in our system).
 */

const TEAM_NAME_TO_ABBREV = {
  'Atlanta Dream': 'ATL',
  'Chicago Sky': 'CHI',
  'Connecticut Sun': 'CON',
  'Dallas Wings': 'DAL',
  'Golden State Valkyries': 'GSV',
  'Indiana Fever': 'IND',
  'Las Vegas Aces': 'LVA',
  'Los Angeles Sparks': 'LAS',
  'Minnesota Lynx': 'MIN',
  'New York Liberty': 'NYL',
  'Phoenix Mercury': 'PHX',
  'Portland Fire': 'POR',
  'Seattle Storm': 'SEA',
  'Toronto Tempo': 'TOR',
  'Washington Mystics': 'WAS',
};

// ESPN type.id -> canonical status enum.
// Keep this conservative: if we see an unknown id, default to GTD with a flag in audit.
const ESPN_TYPE_ID_TO_STATUS = {
  '1': 'AVAILABLE',   // active (rarely appears on injury page)
  '2': 'OUT',         // injured reserve
  '6': 'GTD',         // day-to-day
  '7': 'OUT',         // out
  '8': 'DOUBTFUL',    // doubtful
  '9': 'PROBABLE',    // probable
};

// Fallback: parse statusDesc text if type.id is missing/unknown.
const STATUS_DESC_FALLBACK = [
  [/^out for season/i, 'OUT'],
  [/^out\b/i, 'OUT'],
  [/^doubtful/i, 'DOUBTFUL'],
  [/^day[- ]to[- ]day/i, 'GTD'],
  [/^questionable/i, 'GTD'],
  [/^probable/i, 'PROBABLE'],
  [/^game[- ]time/i, 'GTD'],
  [/^personal/i, 'OUT'],
  [/^rest/i, 'OUT'],
];

function normalizeStatus(typeId, statusDesc) {
  if (typeId && ESPN_TYPE_ID_TO_STATUS[typeId]) return ESPN_TYPE_ID_TO_STATUS[typeId];
  if (statusDesc) {
    for (const [pattern, status] of STATUS_DESC_FALLBACK) {
      if (pattern.test(statusDesc)) return status;
    }
  }
  return 'GTD'; // safest unknown-default: include in lineup with reduced confidence rather than silently drop
}

function extractPlayerIdFromHref(href) {
  if (!href || typeof href !== 'string') return null;
  // https://www.espn.com/wnba/player/_/id/4398674/rhyne-howard
  const m = href.match(/\/id\/(\d+)\//);
  return m ? m[1] : null;
}

function normalizeTeamName(displayName) {
  return TEAM_NAME_TO_ABBREV[displayName] || null;
}

/**
 * Parse a structured payload object (the value of window.__espnfitt__.page.content.injuries
 * or an equivalent fixture). This is the pure function the network fetcher delegates to,
 * and is what unit tests should target.
 */
function parseEspnInjuriesPayload(payload) {
  if (!payload || !Array.isArray(payload.injuries)) {
    throw new Error('injuryFeed: payload missing .injuries array');
  }

  const all = [];
  const byPlayerId = {};
  const byTeamAbbrev = {};
  const unrecognizedTeams = [];

  for (const teamBlock of payload.injuries) {
    const teamName = teamBlock.displayName;
    const teamAbbrev = normalizeTeamName(teamName);
    if (!teamAbbrev) {
      // Don't throw -- ESPN sometimes adds teams (expansion) before we update the map.
      // Record it in audit so we can fix.
      unrecognizedTeams.push(teamName);
    }
    const items = Array.isArray(teamBlock.items) ? teamBlock.items : [];

    for (const item of items) {
      const athlete = item.athlete || {};
      const playerId = extractPlayerIdFromHref(athlete.href);
      const typeId = item.type && item.type.id;
      const status = normalizeStatus(typeId, item.statusDesc);

      const record = {
        playerId,
        playerName: athlete.name || null,
        shortName: athlete.shortName || null,
        position: athlete.position || null,
        teamName,
        teamAbbrev,
        status,
        rawStatus: item.statusDesc || null,
        espnTypeId: typeId || null,
        estReturnDate: item.date || null,
        comment: item.description || '',
        espnHref: athlete.href || null,
      };

      all.push(record);
      if (playerId) byPlayerId[playerId] = record;
      if (teamAbbrev) {
        if (!byTeamAbbrev[teamAbbrev]) byTeamAbbrev[teamAbbrev] = [];
        byTeamAbbrev[teamAbbrev].push(record);
      }
    }
  }

  return {
    fetchedAt: payload._meta && payload._meta.capturedAt ? payload._meta.capturedAt : new Date().toISOString(),
    source: 'espn',
    byPlayerId,
    byTeamAbbrev,
    all,
    _audit: {
      playerCount: all.length,
      teamCount: Object.keys(byTeamAbbrev).length,
      unrecognizedTeams,
    },
  };
}

/**
 * Extract the embedded JSON payload from raw ESPN HTML.
 * Looks for `window['__espnfitt__']={...};` and navigates to .page.content.
 */
function extractInjuriesFromHtml(html) {
  if (!html || typeof html !== 'string') {
    throw new Error('injuryFeed: extractInjuriesFromHtml requires HTML string');
  }
  // Find the JSON assignment.
  const startMarker = "window['__espnfitt__']=";
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error('injuryFeed: __espnfitt__ payload not found in HTML');
  }
  // Walk braces to find the matching end of the JSON object.
  // This is safer than regex because the JSON contains nested braces and escaped strings.
  const jsonStart = html.indexOf('{', startIdx);
  if (jsonStart === -1) throw new Error('injuryFeed: opening brace not found');

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { jsonEnd = i + 1; break; }
    }
  }
  if (jsonEnd === -1) throw new Error('injuryFeed: could not find matching close brace for __espnfitt__');

  const jsonStr = html.slice(jsonStart, jsonEnd);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('injuryFeed: failed to parse __espnfitt__ JSON: ' + e.message);
  }

  const injuries = parsed && parsed.page && parsed.page.content && parsed.page.content.injuries;
  if (!Array.isArray(injuries)) {
    throw new Error('injuryFeed: page.content.injuries not found or not an array');
  }
  return { injuries };
}

/**
 * Live fetcher. Pulls ESPN's HTML, extracts the embedded JSON, normalizes it.
 *
 * Vercel-compatibility note: ESPN does occasionally rate-limit. The current implementation
 * uses the default node-fetch / global fetch. If this hits 429s in production we'll need
 * to add caching (5-min TTL is plenty -- ESPN updates this page on hours-scale).
 */
async function fetchEspnWnbaInjuries(opts = {}) {
  const url = opts.url || 'https://www.espn.com/wnba/injuries';
  const userAgent = opts.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) {
    throw new Error(`injuryFeed: ESPN returned ${res.status}`);
  }
  const html = await res.text();
  const payload = extractInjuriesFromHtml(html);
  return parseEspnInjuriesPayload(payload);
}

module.exports = {
  fetchEspnWnbaInjuries,
  parseEspnInjuriesPayload,
  extractInjuriesFromHtml,
  normalizeStatus,
  TEAM_NAME_TO_ABBREV,
};
