// api/tennis/schedule.mjs — upcoming tennis slate from OddsPapi (the source we validated).
// Fixture-first: /tournaments?sportId=12 -> active tournaments -> /fixtures?tournamentId=X.
// The board only needs fixtures (players + time); projections come from the index and you type the
// lines. Odds are NOT pulled here, so this stays cheap on the 250/month free tier.
//   GET /api/tennis/schedule            -> today + next ~36h
//   GET /api/tennis/schedule?date=YYYY-MM-DD
// Requires env ODDSPAPI_KEY. Returns { ok, date, matches:[{matchId, playerA, playerB, startTime,
// surface, tour, tournament, bestOf}] } — the exact shape the SPA controller expects.

const BASE = 'https://api.oddspapi.io/v4';
const SPORT_ID_TENNIS = 12;
const MAX_TOURNAMENTS = 20;
const CACHE_MS = 30 * 60 * 1000;

// --- index lookup so the board only lists matches we can actually READ -------------------------
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
let IDX = null;
function indexNames() {
  if (IDX) return IDX;
  const paths = [process.env.TENNIS_INDEX_PATH, join(process.cwd(), 'tennis', 'tennis_serve_index.json'),
    join(process.cwd(), 'tennis_serve_index.json')].filter(Boolean);
  for (const p of paths) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const set = new Set(), last = new Map();
      for (const pl of Object.values(j.players || {})) {
        const n = String(pl.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        if (!n) continue;
        set.add(n);
        const t = n.split(/\s+/); const key = `${t[t.length - 1]}|${(t[0] || ' ')[0]}`;
        last.set(key, true);
      }
      IDX = { set, last }; return IDX;
    } catch { /* try next */ }
  }
  IDX = { set: new Set(), last: new Map() }; return IDX;
}
function inIndex(name) {
  const { set, last } = indexNames();
  const n = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!n || /^\d+$/.test(n)) return false;           // raw participant ids aren't players
  if (!set.size) return true;                        // no index available → don't filter anything out
  if (set.has(n)) return true;
  const t = n.split(/\s+/);
  return last.has(`${t[t.length - 1]}|${(t[0] || ' ')[0]}`);
}
// With a live source, off-index players (ITF/Challenger/new) get a cold-start profile — so they're
// still readable. Without one, only indexed players can be read.
const HAS_LIVE = !!(process.env.APITENNIS_KEY || process.env.MATCHSTAT_KEY);

const SURFACE_MAP = [
  [/roland[_ ]?garros|french|monte|madrid|rome|barcelona|hamburg|estoril|munich|bastad|gstaad|umag|kitzbuhel|clay/i, 'Clay'],
  [/wimbledon|halle|queen|hertogenbosch|newport|eastbourne|mallorca|grass/i, 'Grass'],
];
const inferSurface = (name) => { for (const [re, s] of SURFACE_MAP) if (re.test(name || '')) return s; return 'Hard'; };
const inferTour = (name) => /wta|women|ladies/i.test(name || '') ? 'WTA' : /atp|challenger|men/i.test(name || '') ? 'ATP' : 'Tennis';
const isSlam = (name) => /roland[_ ]?garros|french open|wimbledon|us open|australian open/i.test(name || '');

async function getJson(path) {
  const r = await fetch(`${BASE}/${path}${path.includes('?') ? '&' : '?'}apiKey=${process.env.ODDSPAPI_KEY}`);
  if (!r.ok) throw new Error(`OddsPapi ${path.split('?')[0]} -> HTTP ${r.status}`);
  return r.json();
}
const asList = (x) => (Array.isArray(x) ? x : x?.data || []);

function inWindow(iso, dateStr) {
  if (!iso) return false;
  if (dateStr) return iso.slice(0, 10) === dateStr;
  const t = Date.parse(iso), now = Date.now();
  return t >= now - 6 * 3600e3 && t <= now + 36 * 3600e3;
}

let CACHE = { key: null, at: 0, data: null };

export default async function handler(req, res) {
  try {
    if (!process.env.ODDSPAPI_KEY) { res.status(500).json({ error: 'ODDSPAPI_KEY not set' }); return; }
    const date = (req.query && req.query.date) || null;
    const key = date || 'upcoming';
    if (CACHE.key === key && Date.now() - CACHE.at < CACHE_MS) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, cached: true, ...CACHE.data });
      return;
    }
    // Prefer real tour events; ITF/UTR/exhibition players aren't in the index so reads fail there.
    const isLowTier = (t) => /itf|utr|futures|m15|m25|w15|w25|w35|w50|exhibition/i.test(
      `${t.tournamentName || ''} ${t.categoryName || ''} ${t.categorySlug || ''}`);
    const all = asList(await getJson(`tournaments?sportId=${SPORT_ID_TENNIS}`))
      .filter((t) => (t.upcomingFixtures || 0) + (t.liveFixtures || 0) > 0);
    const tourLevel = all.filter((t) => !isLowTier(t));
    const tournaments = (tourLevel.length ? tourLevel : all)
      .sort((a, b) => ((b.upcomingFixtures || 0) + (b.liveFixtures || 0)) - ((a.upcomingFixtures || 0) + (a.liveFixtures || 0)))
      .slice(0, MAX_TOURNAMENTS);
    const matches = [];
    for (const t of tournaments) {
      const tid = t.tournamentId ?? t.id;
      const tname = t.tournamentName || t.name || '';
      let fx;
      try { fx = asList(await getJson(`fixtures?tournamentId=${tid}`)); } catch { continue; }
      for (const f of fx) {
        if (!inWindow(f.startTime, date)) continue;
        const playerA = f.participant1Name || String(f.participant1Id);
        const playerB = f.participant2Name || String(f.participant2Id);
        const idxA = inIndex(playerA), idxB = inIndex(playerB);
        const named = !/^\d+$/.test(String(playerA)) && !/^\d+$/.test(String(playerB));
        matches.push({
          matchId: String(f.fixtureId ?? f.id),
          playerA, playerB,
          startTime: f.startTime,
          surface: inferSurface(tname),
          tour: inferTour(tname),
          tournament: tname,
          bestOf: (inferTour(tname) === 'ATP' && isSlam(tname)) ? 5 : 3,
          indexed: idxA && idxB,                                  // deep history for both
          readable: (idxA && idxB) || (HAS_LIVE && named),        // deep, or cold-start from live
        });
      }
    }
    // deepest reads first (indexed), then cold-start-readable, then by start time
    matches.sort((a, b) => (b.indexed - a.indexed) || (b.readable - a.readable) || (Date.parse(a.startTime) - Date.parse(b.startTime)));
    const readableCount = matches.filter((m) => m.readable).length;
    const indexedCount = matches.filter((m) => m.indexed).length;
    const data = { date: date || 'upcoming', count: matches.length, readableCount, indexedCount, matches,
      note: !matches.length ? 'No tennis fixtures in window.'
        : !readableCount ? (HAS_LIVE ? 'Fixtures found but no readable players.'
            : 'Fixtures are off-index (lower-tier). Set APITENNIS_KEY or MATCHSTAT_KEY to read them.')
        : null };
    CACHE = { key, at: Date.now(), data };
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
