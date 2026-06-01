// api/_lib/wnba/oddsLines.js
//
// THE ODDS API — WNBA GAME LINES FEED (June 1, 2026)
//
// Replaces the abandoned DraftKings direct-scrape (dkLines.js), which Akamai
// blocks from datacenter IPs. The Odds API is a documented aggregator that
// WANTS server traffic, so it works from Vercel. It returns DraftKings' own
// numbers among other books — so you still get DK lines, via a host that
// doesn't return Access Denied.
//
// FREE-TIER SCOPE (deliberate):
//   Free tier covers game-level markets: h2h, spreads, totals. It does NOT
//   include player props (player_points/rebounds/assists are paid + per-event).
//   So this feed supplies GAME TOTAL + SPREAD per game — which is exactly what
//   the slate currently fakes (DEFAULT_TOTAL=164, DEFAULT_SPREAD=0). Player
//   prop LINES still come in manually via the Prop Lab.
//
// COST: one request per slate (all games, 3 markets, single call), cached 5 min.
//   ~30 requests/month at one slate/day — trivial against the 500 free cap.
//   The x-requests-remaining response header is surfaced in _audit so you can
//   watch quota burn in the debug endpoint.
//
// KEY: read from process.env.ODDS_API_KEY (set in Vercel env vars, never in code).
//   If unset, every export no-ops and returns empty — slate falls back to
//   inferred lines exactly as today. No crash when the key is missing.
//
// BOOK PREFERENCE: DraftKings when present, else median across books.

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const SPORT = 'basketball_wnba';
const PREFERRED_BOOK = 'draftkings';

const TTL_MS = 5 * 60 * 1000;
const _cache = new Map();

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }

export function isOddsConfigured() {
  return Boolean(process.env.ODDS_API_KEY);
}

// Normalize a full team name (Odds API uses "Phoenix Mercury") to our tricode.
// Mirrors injuryFeed.js TEAM_NAME_TO_ABBREV so lines join to schedule games.
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

function abbr(teamName) {
  if (!teamName) return null;
  if (TEAM_NAME_TO_ABBREV[teamName]) return TEAM_NAME_TO_ABBREV[teamName];
  // Fallback: match on last word (mascot) in case Odds API tweaks a name.
  const hit = Object.entries(TEAM_NAME_TO_ABBREV).find(([full]) => {
    const mascot = full.split(' ').pop().toLowerCase();
    return teamName.toLowerCase().includes(mascot);
  });
  return hit ? hit[1] : String(teamName).slice(0, 3).toUpperCase();
}

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * From one game's bookmakers array, extract { total, spread } with the spread
 * expressed from the HOME team's perspective (negative = home favored), to
 * match what slate.js / possessionEnvironment expect.
 */
function extractGameLines(game) {
  const homeName = game.home_team;
  const awayName = game.away_team;
  const books = Array.isArray(game.bookmakers) ? game.bookmakers : [];

  // Prefer DraftKings; else collect all books for a median.
  const dk = books.find(b => b.key === PREFERRED_BOOK);

  function totalFrom(book) {
    const m = (book.markets || []).find(mk => mk.key === 'totals');
    if (!m || !Array.isArray(m.outcomes) || !m.outcomes.length) return null;
    // Over and Under share the same point; take the first with a numeric point.
    const pt = m.outcomes.find(o => Number.isFinite(Number(o.point)));
    return pt ? Number(pt.point) : null;
  }

  function spreadFrom(book) {
    const m = (book.markets || []).find(mk => mk.key === 'spreads');
    if (!m || !Array.isArray(m.outcomes)) return null;
    const home = m.outcomes.find(o => o.name === homeName);
    if (home && Number.isFinite(Number(home.point))) return Number(home.point);
    // If only away listed, flip sign for home perspective.
    const away = m.outcomes.find(o => o.name === awayName);
    if (away && Number.isFinite(Number(away.point))) return -Number(away.point);
    return null;
  }

  let total = null, spread = null, bookUsed = null;
  if (dk) {
    total = totalFrom(dk);
    spread = spreadFrom(dk);
    bookUsed = 'draftkings';
  }
  // Median fallback for whichever value DK didn't provide.
  if (total == null) {
    total = median(books.map(totalFrom).filter(v => v != null));
    if (total != null) bookUsed = bookUsed || 'median';
  }
  if (spread == null) {
    spread = median(books.map(spreadFrom).filter(v => v != null));
    if (spread != null) bookUsed = bookUsed || 'median';
  }

  return { total, spread, bookUsed, bookCount: books.length };
}

/**
 * Fetch + normalize WNBA game lines.
 * @returns {Promise<Object>} {
 *   fetchedAt, source, byMatchup: { "MIN@PHX": { total, spread, ... } },
 *   byTeam: { PHX: {...}, MIN: {...} },   // both teams point at same game
 *   all: [...], _audit: { keyPresent, httpStatus, gamesReturned, remainingRequests, warnings }
 * }
 */
export async function fetchWnbaGameLines(opts = {}) {
  const warnings = [];

  if (!isOddsConfigured()) {
    return { fetchedAt: new Date().toISOString(), source: 'the-odds-api',
      byMatchup: {}, byTeam: {}, all: [],
      _audit: { keyPresent: false, httpStatus: null, gamesReturned: 0, remainingRequests: null,
        warnings: ['ODDS_API_KEY not set — slate will use inferred lines'] } };
  }

  const cacheKey = 'odds:wnba:lines';
  if (!opts.noCache) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const url = `${ODDS_BASE}/sports/${SPORT}/odds/`
    + `?regions=us&markets=h2h,spreads,totals&oddsFormat=american`
    + `&apiKey=${encodeURIComponent(process.env.ODDS_API_KEY)}`;

  let httpStatus = null, remainingRequests = null, games = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    httpStatus = res.status;
    remainingRequests = res.headers.get('x-requests-remaining');

    if (res.status !== 200) {
      const body = await res.text().catch(() => '');
      warnings.push(`Odds API HTTP ${res.status}: ${body.slice(0, 160)}`);
    } else {
      games = await res.json();
      if (!Array.isArray(games)) { warnings.push('Odds API returned non-array body'); games = []; }
      if (games.length === 0) warnings.push('Odds API returned 0 games (none with posted lines right now)');
    }
  } catch (err) {
    warnings.push(`Odds API fetch failed: ${err.message}`);
  }

  const byMatchup = {}, byTeam = {}, all = [];
  for (const g of games) {
    const home = abbr(g.home_team);
    const away = abbr(g.away_team);
    if (!home || !away) continue;
    const lines = extractGameLines(g);
    const rec = {
      matchup: `${away}@${home}`, home, away,
      total: lines.total, spread: lines.spread,
      bookUsed: lines.bookUsed, bookCount: lines.bookCount,
      commenceTime: g.commence_time || null,
    };
    byMatchup[rec.matchup] = rec;
    byTeam[home] = rec;
    byTeam[away] = rec;
    all.push(rec);
  }

  const result = {
    fetchedAt: new Date().toISOString(),
    source: 'the-odds-api',
    byMatchup, byTeam, all,
    _audit: {
      keyPresent: true, httpStatus, gamesReturned: all.length,
      remainingRequests: remainingRequests != null ? Number(remainingRequests) : null,
      warnings,
    },
  };
  cacheSet(cacheKey, result);
  return result;
}

/** Convenience: look up one game's lines by either team's tricode. */
export async function getGameLinesForTeam(teamAbbr, opts = {}) {
  const feed = await fetchWnbaGameLines(opts);
  return feed.byTeam[String(teamAbbr).toUpperCase()] || null;
}

export const _testing = { abbr, median, extractGameLines, TEAM_NAME_TO_ABBREV };
