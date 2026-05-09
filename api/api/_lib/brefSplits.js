// api/_lib/brefSplits.js
// Fetches situational splits from Baseball Reference for a hitter.
// Returns curated high-signal splits only, with sample-size awareness.
//
// Splits we care about (mapped to prop types they affect):
//   - Bases (RISP, Men On, Bases Empty) → RBI, HR props
//   - Count (Ahead, Behind, First pitch) → walks, HR props
//   - Inning (innings 1-3, 4-6, 7+) → mirror pitcher inning splits for stacking signal
//   - Site (Home, Road) → general hitter profile
//   - Platoon (vs RHP, vs LHP) — fallback when Savant split missing
//   - Power (Grass, Turf) → small surface modifier

const splitsCache = new Map();  // key: `${bbrefId}-${season}`, val: { timestamp, data }
const CACHE_TTL = 12 * 60 * 60 * 1000;  // 12 hours (splits don't change fast)

// MIN-PA thresholds — silence splits below these (sample too small to signal anything)
const MIN_PA = {
  bases: 40,     // per base-state
  risp: 40,
  count: 30,
  inning: 25,
  site: 80,
  platoon: 40,
  power: 60
};

// Simple concurrency throttle so we don't hammer BRef (max 2 concurrent requests)
let activeRequests = 0;
const requestQueue = [];
const MAX_CONCURRENT = 2;

function acquireSlot() {
  return new Promise(resolve => {
    const tryAcquire = () => {
      if (activeRequests < MAX_CONCURRENT) {
        activeRequests++;
        resolve(() => {
          activeRequests--;
          const next = requestQueue.shift();
          if (next) next();
        });
      } else {
        requestQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

/**
 * Fetch splits for a hitter by BRef ID + season.
 * @param {string} bbrefId e.g. "judgeaa01"
 * @param {number} season  e.g. 2025
 * @returns {Promise<Object|null>} Parsed splits
 */
export async function getHitterSituationalSplits(bbrefId, season) {
  if (!bbrefId) return null;
  const cacheKey = `${bbrefId}-${season}`;
  const cached = splitsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  const release = await acquireSlot();
  try {
    const url = `https://www.baseball-reference.com/players/split.fcgi?id=${bbrefId}&year=${season}&t=b`;
    let html;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MismatchFinder/1.0)' }
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      html = await res.text();
    } catch (err) {
      console.warn(`BRef splits fetch failed ${bbrefId}/${season}:`, err.message);
      return null;
    }

    if (!html || html.length < 1000) return null;

    const parsed = {
      bbrefId,
      season,
      fetchedAt: Date.now(),
      bases: parseTable(html, 'bases'),
      count: parseTable(html, 'count'),
      inning: parseTable(html, 'innng'),
      site: parseTable(html, 'site'),
      platoon: parseTable(html, 'plato'),
      power: parseTable(html, 'power'),
      overall: null
    };
    parsed.overall = parseOverall(html);
    parsed.signals = computeActionableSignals(parsed);

    splitsCache.set(cacheKey, { timestamp: Date.now(), data: parsed });
    return parsed;
  } finally {
    release();
  }
}

// ----- HTML PARSER -----
// BRef wraps each splits table in an outer <div id="all_<tableId>">...</div>
// with the table body (or a commented-out version of it) inside.
// We parse the rows and extract key stats: PA, AB, H, HR, BB, SO, OBP, SLG, OPS.

function parseTable(html, tableId) {
  // BRef tables are wrapped in <div id="all_<tableId>"> ... </div>. They are LARGE
  // so we can't rely on non-greedy matching. Instead, find the div opening and
  // search forward for the matching tbody (stripping comment wrappers).
  const divOpen = html.indexOf(`id="all_${tableId}"`);
  if (divOpen < 0) return [];

  // Grab a generous slice — most split tables are under 50KB
  const slice = html.slice(divOpen, divOpen + 150000);

  // Strip HTML comment markers that hide tables from naive scrapers
  const unwrapped = slice.replace(/<!--/g, '').replace(/-->/g, '');

  // Find tbody — note BRef often omits </tbody>, so terminate at </table>
  const tbodyOpen = unwrapped.indexOf('<tbody');
  if (tbodyOpen < 0) return [];
  const tbodyCloseOwn = unwrapped.indexOf('</tbody>', tbodyOpen);
  const tableClose = unwrapped.indexOf('</table>', tbodyOpen);
  let tbodyEnd;
  if (tbodyCloseOwn > 0 && tableClose > 0) tbodyEnd = Math.min(tbodyCloseOwn, tableClose);
  else if (tbodyCloseOwn > 0) tbodyEnd = tbodyCloseOwn;
  else if (tableClose > 0) tbodyEnd = tableClose;
  else return [];
  const tbody = unwrapped.slice(tbodyOpen, tbodyEnd);

  // Parse rows
  const rows = [];
  const rowMatches = tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g);
  for (const rm of rowMatches) {
    const rowHtml = rm[1];
    // Skip header/total rows
    if (/class="[^"]*thead/.test(rm[0])) continue;
    // Extract split name (th element)
    const thMatch = rowHtml.match(/<th[^>]*data-stat="split_name"[^>]*>([\s\S]*?)<\/th>/);
    if (!thMatch) continue;
    const splitName = thMatch[1].replace(/<[^>]+>/g, '').trim();
    if (!splitName || splitName === 'Split') continue;

    // Extract data stats
    const stats = {};
    const tdMatches = rowHtml.matchAll(/data-stat="([^"]+)"[^>]*>([^<]*)</g);
    for (const td of tdMatches) {
      if (td[1] === 'split_name') continue;
      stats[td[1]] = td[2].trim();
    }

    rows.push({
      name: splitName,
      PA: parseInt(stats.PA) || 0,
      AB: parseInt(stats.AB) || 0,
      H: parseInt(stats.H) || 0,
      HR: parseInt(stats.HR) || 0,
      BB: parseInt(stats.BB) || 0,
      SO: parseInt(stats.SO) || 0,
      AVG: parseFloat(stats.batting_avg) || null,
      OBP: parseFloat(stats.onbase_perc) || null,
      SLG: parseFloat(stats.slugging_perc) || null,
      OPS: parseFloat(stats.onbase_plus_slugging) || null,
      raw: stats
    });
  }
  return rows;
}

function parseOverall(html) {
  // Season totals — try the "total" row of the bases table first (always has it)
  const bases = parseTable(html, 'bases');
  const total = bases.find(r => /^Total$/i.test(r.name));
  if (total && total.PA > 0) {
    return {
      PA: total.PA,
      OPS: total.OPS,
      AVG: total.AVG,
      OBP: total.OBP,
      SLG: total.SLG,
      HR: total.HR,
      BB: total.BB
    };
  }
  // Fallback: sum of Men On + Bases Empty
  const menOn = bases.find(r => /^Men On$/i.test(r.name));
  const empty = bases.find(r => /^(Bases Empty|---)$/i.test(r.name));
  if (menOn && empty) {
    const totalPA = menOn.PA + empty.PA;
    const totalAB = menOn.AB + empty.AB;
    const totalH = menOn.H + empty.H;
    const totalBB = menOn.BB + empty.BB;
    const totalHR = menOn.HR + empty.HR;
    // Approximate OPS using combined AB-weighted average
    const OPS = (menOn.OPS * menOn.AB + empty.OPS * empty.AB) / Math.max(1, totalAB);
    return { PA: totalPA, OPS, AVG: totalH / Math.max(1, totalAB), OBP: (totalH + totalBB) / Math.max(1, totalPA), HR: totalHR, BB: totalBB };
  }
  return null;
}

// ----- ACTIONABLE SIGNAL DETECTION -----
// Only surface splits that:
//   1. Meet minimum PA threshold
//   2. Differ meaningfully from overall (≥50 OPS pts or ≥.030 OBP diff)
//
// Returns an object keyed by prop-type relevance.

function computeActionableSignals(parsed) {
  const overall = parsed.overall;
  const signals = {
    risp: null,            // for RBI props
    runnersOn: null,       // for HR props (pitchers avoid damage → fewer HRs with runners)
    basesEmpty: null,      // for solo HR props
    ahead: null,           // for walk props
    behind: null,          // for K props (against)
    firstPitch: null,      // aggressive hitter profile
    inningsEarly: null,    // 1-3 aggregated
    inningsMiddle: null,   // 4-6 aggregated
    inningsLate: null,     // 7+ aggregated
    home: null,            // home split
    road: null,            // road split
    grass: null,           // grass surface
    turf: null             // turf surface
  };

  if (!overall) return signals;
  const baseOps = overall.OPS || 0.700;

  const findRow = (table, nameMatcher) => {
    if (!table) return null;
    return table.find(r => nameMatcher(r.name));
  };
  const qualifies = (row, minPA) => row && row.PA >= minPA && row.OPS != null;

  // Bases states
  const basesRows = parsed.bases || [];
  const risp = findRow(basesRows, n => /RISP/i.test(n));
  if (qualifies(risp, MIN_PA.risp)) {
    const delta = risp.OPS - baseOps;
    signals.risp = {
      PA: risp.PA, OPS: risp.OPS, HR: risp.HR, delta,
      actionable: Math.abs(delta) >= 0.050,
      direction: delta > 0 ? 'better' : 'worse',
      note: delta >= 0.100 ? 'Clutch hitter' : delta <= -0.100 ? 'Struggles with RISP' : null
    };
  }
  const menOn = findRow(basesRows, n => /^Men On$/i.test(n));
  if (qualifies(menOn, MIN_PA.bases)) {
    const delta = menOn.OPS - baseOps;
    signals.runnersOn = {
      PA: menOn.PA, OPS: menOn.OPS, HR: menOn.HR, delta,
      actionable: Math.abs(delta) >= 0.050
    };
  }
  const empty = findRow(basesRows, n => /Bases Empty|^---$/i.test(n));
  if (qualifies(empty, MIN_PA.bases)) {
    const delta = empty.OPS - baseOps;
    signals.basesEmpty = {
      PA: empty.PA, OPS: empty.OPS, HR: empty.HR, delta,
      actionable: Math.abs(delta) >= 0.050
    };
  }

  // Count splits
  const countRows = parsed.count || [];
  const ahead = findRow(countRows, n => /^Ahead in Count$|^Hitter Ahead$|^Ahead$/i.test(n));
  if (qualifies(ahead, MIN_PA.count)) {
    signals.ahead = {
      PA: ahead.PA, OPS: ahead.OPS, BB: ahead.BB, delta: ahead.OPS - baseOps,
      actionable: ahead.OPS - baseOps >= 0.100
    };
  }
  const behind = findRow(countRows, n => /^Behind in Count$|^Pitcher Ahead$|^Behind$/i.test(n));
  if (qualifies(behind, MIN_PA.count)) {
    signals.behind = {
      PA: behind.PA, OPS: behind.OPS, SO: behind.SO, delta: behind.OPS - baseOps,
      actionable: behind.OPS - baseOps <= -0.100
    };
  }
  const firstPitch = findRow(countRows, n => /^First Pitch$|^0-0$/i.test(n));
  if (qualifies(firstPitch, MIN_PA.count)) {
    signals.firstPitch = {
      PA: firstPitch.PA, OPS: firstPitch.OPS, delta: firstPitch.OPS - baseOps,
      actionable: firstPitch.OPS - baseOps >= 0.100
    };
  }

  // Inning groupings — aggregate 1-3, 4-6, 7+
  const inningRows = parsed.inning || [];
  const aggInnings = (from, to) => {
    let PA = 0, H = 0, BB = 0, HR = 0, AB = 0, TB = 0;
    for (let i = from; i <= to; i++) {
      const row = findRow(inningRows, n => new RegExp(`^${i}(st|nd|rd|th)? inning`, 'i').test(n));
      if (!row) continue;
      PA += row.PA; H += row.H; BB += row.BB; HR += row.HR; AB += row.AB;
      // Rough TB reconstruction: H + XBH approximation — BRef uses SLG*AB as pseudo-TB
      if (row.SLG && row.AB) TB += Math.round(row.SLG * row.AB);
    }
    if (PA === 0) return null;
    const OPS = AB > 0 ? ((H + BB) / PA) + (TB / AB) : null;
    return { PA, H, BB, HR, AB, OPS };
  };
  const early = aggInnings(1, 3);
  const middle = aggInnings(4, 6);
  const late = aggInnings(7, 9);
  if (early && early.PA >= MIN_PA.inning) {
    signals.inningsEarly = {
      PA: early.PA, OPS: early.OPS, HR: early.HR,
      delta: early.OPS ? early.OPS - baseOps : 0,
      actionable: early.OPS && Math.abs(early.OPS - baseOps) >= 0.080
    };
  }
  if (middle && middle.PA >= MIN_PA.inning) {
    signals.inningsMiddle = {
      PA: middle.PA, OPS: middle.OPS, HR: middle.HR,
      delta: middle.OPS ? middle.OPS - baseOps : 0,
      actionable: middle.OPS && Math.abs(middle.OPS - baseOps) >= 0.080
    };
  }
  if (late && late.PA >= MIN_PA.inning) {
    signals.inningsLate = {
      PA: late.PA, OPS: late.OPS, HR: late.HR,
      delta: late.OPS ? late.OPS - baseOps : 0,
      actionable: late.OPS && Math.abs(late.OPS - baseOps) >= 0.080
    };
  }

  // Home/road
  const siteRows = parsed.site || [];
  const home = findRow(siteRows, n => /^Home$/i.test(n));
  const road = findRow(siteRows, n => /^Away$|^Road$/i.test(n));
  if (qualifies(home, MIN_PA.site) && qualifies(road, MIN_PA.site)) {
    const hrDelta = home.OPS - road.OPS;
    signals.home = { PA: home.PA, OPS: home.OPS, HR: home.HR };
    signals.road = { PA: road.PA, OPS: road.OPS, HR: road.HR };
    signals.homeRoadGap = {
      delta: hrDelta,
      actionable: Math.abs(hrDelta) >= 0.100,
      direction: hrDelta > 0 ? 'home-slanted' : 'road-slanted'
    };
  }

  // Surface (grass/turf) — BRef 'power' table contains these
  const powerRows = parsed.power || [];
  const grass = findRow(powerRows, n => /Grass/i.test(n));
  const turf = findRow(powerRows, n => /Turf|Artificial/i.test(n));
  if (qualifies(grass, MIN_PA.power) && qualifies(turf, MIN_PA.power)) {
    const gtDelta = turf.OPS - grass.OPS;
    signals.grass = { PA: grass.PA, OPS: grass.OPS };
    signals.turf = { PA: turf.PA, OPS: turf.OPS };
    signals.surfaceGap = {
      delta: gtDelta,
      actionable: Math.abs(gtDelta) >= 0.060
    };
  }

  return signals;
}

// ----- BREF ID LOOKUP (via Chadwick Bureau register) -----
// Chadwick sharded people CSV by first hex of key_person. We fetch shards lazily
// and cache them. Lookup by MLBAM ID returns the BRef ID.

const idLookupCache = new Map();   // mlbam → bbrefId (or null if not found)
const shardCache = new Map();       // shardChar → Map<mlbam, bbrefId>
const pendingShards = new Map();    // shardChar → Promise<Map>

async function loadShard(shardChar) {
  if (shardCache.has(shardChar)) return shardCache.get(shardChar);
  if (pendingShards.has(shardChar)) return pendingShards.get(shardChar);

  const promise = (async () => {
    const url = `https://raw.githubusercontent.com/chadwickbureau/register/master/data/people-${shardChar}.csv`;
    let text;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      console.warn(`Chadwick shard ${shardChar} fetch failed:`, err.message);
      return new Map();
    }
    const lines = text.split('\n');
    const header = lines[0].split(',');
    const mlbamIdx = header.indexOf('key_mlbam');
    const bbrefIdx = header.indexOf('key_bbref');
    if (mlbamIdx < 0 || bbrefIdx < 0) return new Map();
    const map = new Map();
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < Math.max(mlbamIdx, bbrefIdx) + 1) continue;
      const mlbam = parts[mlbamIdx];
      const bbref = parts[bbrefIdx];
      if (mlbam && bbref) map.set(mlbam, bbref);
    }
    shardCache.set(shardChar, map);
    return map;
  })();

  pendingShards.set(shardChar, promise);
  try {
    const result = await promise;
    pendingShards.delete(shardChar);
    return result;
  } catch (err) {
    pendingShards.delete(shardChar);
    return new Map();
  }
}

/**
 * Look up BRef ID for an MLBAM ID. Searches shards in parallel.
 * @param {number|string} mlbam
 * @returns {Promise<string|null>}
 */
export async function lookupBrefId(mlbam) {
  if (!mlbam) return null;
  const key = String(mlbam);
  if (idLookupCache.has(key)) return idLookupCache.get(key);

  // Try all 16 shards in parallel (they're cached after first load)
  const shardChars = '0123456789abcdef'.split('');
  const shards = await Promise.all(shardChars.map(c => loadShard(c)));
  for (const shard of shards) {
    if (shard.has(key)) {
      const bbref = shard.get(key);
      idLookupCache.set(key, bbref);
      return bbref;
    }
  }
  idLookupCache.set(key, null);
  return null;
}

/**
 * Look up splits for a hitter by MLBAM ID + season.
 * Convenience wrapper: does ID lookup then fetches splits.
 */
export async function getHitterSituationalByMlbam(mlbam, season) {
  const bbrefId = await lookupBrefId(mlbam);
  if (!bbrefId) return null;
  return getHitterSituationalSplits(bbrefId, season);
}

/**
 * Look up a hitter's BRef ID by first/last name (fallback; prefer MLBAM-based lookup)
 */
export function guessBrefId(fullName, birthYear) {
  if (!fullName) return null;
  const parts = fullName.replace(/[.']/g, '').toLowerCase().split(/\s+/);
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts.slice(1).join('');
  const lastPart = last.slice(0, 5).padEnd(5, 'x');
  const firstPart = first.slice(0, 2);
  return `${lastPart}${firstPart}01`;
}
