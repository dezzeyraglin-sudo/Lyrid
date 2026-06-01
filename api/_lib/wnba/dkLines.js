// api/_lib/wnba/dkLines.js
//
// DRAFTKINGS WNBA PLAYER-PROP LINE FEED (June 1, 2026)
//
// Promotes the reachability + shape proven in api/wnba/debug-dk.js into a
// production line feed. This is the "real lines" half of MLB parity: the slate
// already auto-fetches games (ESPN) + players (bbref) + injuries (ESPN); this
// supplies the actual posted prop lines so projected edge is meaningful instead
// of measured against an inferred season-average line.
//
// WHAT THIS PROVIDES:
//   - Cached fetch of DK's WNBA event group + player-prop subcategories
//   - Normalized output keyed by `${normalizedName}_${market}` so slate.js can
//     join lines onto players without an ID map (DK names ↔ bbref slugs)
//   - American-odds → implied-probability helper for vig-aware edge later
//
// WHAT THIS IS NOT:
//   - A general DK scraper. We target points / rebounds / assists (the documented
//     categories) plus optional combos, and ignore game lines / alt lines.
//   - Authenticated. DK's read API needs no auth; it does rate-limit datacenter
//     IPs, so we cache aggressively (5 min — WNBA lines move slower than that).
//
// SOURCE OF TRUTH for IDs/endpoints: api/wnba/debug-dk.js
//   DK_BASE, event group 94682, category 1215=points / 1216=rebounds / 1217=assists,
//   endpoints /eventgroups/{g} and /eventgroups/{g}/categories/{c}.
//
// PARSER NOTE: DK's v5 offers nest as eventGroup.offerCategories[]
//   .offerSubcategoryDescriptors[].offerSubcategory.offers (an array of arrays).
//   Each offer has outcomes[] with { label:'Over'|'Under', line, oddsAmerican,
//   participant / participants[] }. Field names drift across sports/versions, so
//   we walk defensively and read whichever fields are present. If you run
//   debug-dk against a live slate and the counts look off, the only thing to
//   adjust is extractPlayerName() / OUTCOME field reads below.

const DK_BASE = 'https://sportsbook-nash.draftkings.com';
const WNBA_EVENT_GROUP_ID = 94682;

// Category id → our canonical market. Extend with combo categories if you add them.
const CATEGORY_MARKET = {
  1215: 'points',
  1216: 'rebounds',
  1217: 'assists',
};

// Fallback: match a subcategory/category NAME to a market when ids drift.
const NAME_MARKET_PATTERNS = [
  [/points\s*\+\s*rebounds\s*\+\s*assists|pts\s*\+\s*reb\s*\+\s*ast|\bpra\b/i, 'pra'],
  [/points\s*\+\s*rebounds|pts\s*\+\s*reb|\bpr\b/i, 'pr'],
  [/points\s*\+\s*assists|pts\s*\+\s*ast|\bpa\b/i, 'pa'],
  [/three|3-?pt|3pm/i, 'threes'],
  [/rebound/i, 'rebounds'],
  [/assist/i, 'assists'],
  [/point/i, 'points'],
];

const STANDARD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://sportsbook.draftkings.com/',
  'Origin': 'https://sportsbook.draftkings.com',
};

// =============================================================
// CACHE
// =============================================================

const _cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 min — lines move slower than this for WNBA

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  if (_cache.size > 60) {
    for (const k of [..._cache.keys()].slice(0, 20)) _cache.delete(k);
  }
}

// =============================================================
// FETCH
// =============================================================

async function fetchDk(url, opts = {}) {
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 8000;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { method: 'GET', headers: STANDARD_HEADERS, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 200) return await res.json();
      if (res.status === 404) return null;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
  }
  console.warn(`[dkLines] fetch failed after ${maxRetries} attempts: ${lastError?.message}`);
  return null;
}

// =============================================================
// NAME NORMALIZATION (the DK ↔ bbref bridge)
// =============================================================
// DK: "A'ja Wilson", bbref display: "A'ja Wilson", slug: "wilsoa01w".
// We can't join on slug, so we join on a normalized name on BOTH sides.
// slate.js should normalize its player names with this same function.

export function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')            // drop suffixes
    .replace(/[^a-z]/g, '');                          // letters only
}

// =============================================================
// ODDS HELPER
// =============================================================

export function americanToImpliedProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : (-o) / (-o + 100);
}

// =============================================================
// DEFENSIVE EXTRACTION
// =============================================================

// Pull a player name out of an outcome or its enclosing offer, wherever DK put it.
function extractPlayerName(outcome, offer) {
  if (outcome) {
    if (typeof outcome.participant === 'string' && outcome.participant.trim()) return outcome.participant.trim();
    if (Array.isArray(outcome.participants) && outcome.participants[0]?.name) return outcome.participants[0].name;
    if (outcome.playerName) return outcome.playerName;
  }
  if (offer) {
    if (Array.isArray(offer.participants) && offer.participants[0]?.name) return offer.participants[0].name;
    // Offer label is often just "A'ja Wilson Points" — strip trailing market word.
    if (typeof offer.label === 'string') {
      const m = offer.label.replace(/\b(points|rebounds|assists|threes|pra|pr|pa|pts|reb|ast)\b.*$/i, '').trim();
      if (m) return m;
    }
  }
  return null;
}

function readLine(outcome) {
  for (const k of ['line', 'handicap', 'totalLine']) {
    const v = Number(outcome?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}
function readOdds(outcome) {
  for (const k of ['oddsAmerican', 'oddsAmericanDisplay', 'americanOdds']) {
    if (outcome?.[k] != null) {
      const v = Number(String(outcome[k]).replace(/[^0-9+\-]/g, ''));
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}
function sideOf(outcome) {
  const l = String(outcome?.label || outcome?.line?.label || '').toLowerCase();
  if (l.includes('over') || l === 'o') return 'over';
  if (l.includes('under') || l === 'u') return 'under';
  return null;
}

// Recursively collect every object that looks like an "offer" (has an outcomes array).
function collectOffers(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectOffers(x, acc); return; }
  if (Array.isArray(node.outcomes)) acc.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'outcomes') continue;
    const v = node[k];
    if (v && typeof v === 'object') collectOffers(v, acc);
  }
}

// Decide the market for a category node by id first, then by name patterns.
function marketForCategory(catId, ...names) {
  if (CATEGORY_MARKET[catId]) return CATEGORY_MARKET[catId];
  for (const name of names) {
    for (const [re, mkt] of NAME_MARKET_PATTERNS) if (re.test(String(name || ''))) return mkt;
  }
  return null;
}

// =============================================================
// PUBLIC API
// =============================================================

/**
 * Fetch and normalize DK WNBA player prop lines.
 *
 * @param {Object} opts - { categoryIds?: number[], groupId?: number }
 * @returns {Promise<Object>} normalized lines (see shape below) or null on hard failure
 *
 * Shape:
 *   {
 *     fetchedAt, source:'draftkings',
 *     byPlayerMarket: { "ajawilson_points": { player, market, line, overOdds, underOdds, impliedOver, eventId } },
 *     events: { [eventId]: { name, away, home, startDate } },
 *     all: [ ...prop objects ],
 *     _audit: { eventCount, propCount, categoriesFetched, warnings }
 *   }
 */
export async function fetchDkWnbaPropLines(opts = {}) {
  const groupId = opts.groupId || WNBA_EVENT_GROUP_ID;
  const categoryIds = opts.categoryIds || Object.keys(CATEGORY_MARKET).map(Number);

  const cacheKey = `dk:${groupId}:${categoryIds.join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const warnings = [];

  // 1) Event group → events (team/context) + confirm categories exist.
  const groupUrl = `${DK_BASE}/sites/US-SB/api/v5/eventgroups/${groupId}?format=json`;
  const groupData = await fetchDk(groupUrl);
  if (!groupData?.eventGroup) {
    return { fetchedAt: new Date().toISOString(), source: 'draftkings', byPlayerMarket: {}, events: {}, all: [],
      _audit: { eventCount: 0, propCount: 0, categoriesFetched: [], warnings: ['event group fetch failed or empty'] } };
  }

  const events = {};
  for (const ev of (groupData.eventGroup.events || [])) {
    events[String(ev.eventId)] = {
      name: ev.name || null,
      away: ev.teamShortName1 || null,
      home: ev.teamShortName2 || null,
      startDate: ev.startDate || null,
    };
  }

  // 2) For each category, fetch its offers and parse outcomes.
  const byPlayerMarket = {};
  const all = [];
  const categoriesFetched = [];

  for (const catId of categoryIds) {
    const catUrl = `${DK_BASE}/sites/US-SB/api/v5/eventgroups/${groupId}/categories/${catId}?format=json`;
    const catData = await fetchDk(catUrl);
    if (!catData?.eventGroup) { warnings.push(`category ${catId} fetch failed`); continue; }
    categoriesFetched.push(catId);

    const offers = [];
    collectOffers(catData.eventGroup.offerCategories || catData.eventGroup, offers);
    if (!offers.length) { warnings.push(`category ${catId} returned no offers`); continue; }

    const market = marketForCategory(catId);
    for (const offer of offers) {
      const offerMarket = market || marketForCategory(null, offer.label);
      if (!offerMarket) continue;

      // Group this offer's outcomes into one prop (over + under share a player + line).
      let player = null, line = null, overOdds = null, underOdds = null;
      for (const oc of (offer.outcomes || [])) {
        player = player || extractPlayerName(oc, offer);
        const ln = readLine(oc);
        if (ln != null) line = ln;
        const side = sideOf(oc);
        const odds = readOdds(oc);
        if (side === 'over') overOdds = odds;
        else if (side === 'under') underOdds = odds;
      }
      if (!player || line == null) continue;

      const key = `${normalizeName(player)}_${offerMarket}`;
      const rec = {
        player, market: offerMarket, line,
        overOdds, underOdds,
        impliedOver: americanToImpliedProb(overOdds),
        impliedUnder: americanToImpliedProb(underOdds),
        eventId: offer.eventId ? String(offer.eventId) : null,
        source: 'draftkings',
      };
      // De-dupe: keep the first/standard line if DK lists alternates.
      if (!byPlayerMarket[key]) { byPlayerMarket[key] = rec; all.push(rec); }
    }
  }

  const result = {
    fetchedAt: new Date().toISOString(),
    source: 'draftkings',
    byPlayerMarket,
    events,
    all,
    _audit: { eventCount: Object.keys(events).length, propCount: all.length, categoriesFetched, warnings },
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Convenience: look up one line. Market defaults to points.
 * @returns {Object|null} prop record or null if not posted.
 */
export async function getDkLine(playerName, market = 'points', opts = {}) {
  const feed = await fetchDkWnbaPropLines(opts);
  if (!feed) return null;
  return feed.byPlayerMarket[`${normalizeName(playerName)}_${market}`] || null;
}

export const _testing = {
  DK_BASE, WNBA_EVENT_GROUP_ID, CATEGORY_MARKET,
  normalizeName, extractPlayerName, readLine, readOdds, sideOf, collectOffers, marketForCategory,
};

export function _resetCache() { _cache.clear(); }
