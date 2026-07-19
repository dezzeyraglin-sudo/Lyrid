// api/tennis/schedule.mjs — upcoming tennis slate. TWO SOURCES, tried in order:
//   1. api-tennis.com  (APITENNIS_KEY)  — preferred: date-range fixtures, generous quota
//   2. OddsPapi        (ODDSPAPI_KEY)   — fallback: fixture-first, 250 req/month free tier
// The board only needs fixtures (players + time); projections come from the index and you type the
// lines, so no odds are pulled here.
//   GET /api/tennis/schedule                 -> today + next ~36h
//   GET /api/tennis/schedule?date=YYYY-MM-DD
// Returns { ok, source, date, count, readableCount, matches:[...] }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_MS = 30 * 60 * 1000;
const MAX_TOURNAMENTS = 20;
const asList = (x) => (Array.isArray(x) ? x : x?.data || []);

const SURFACE_MAP = [
  [/roland[_ ]?garros|french|monte|madrid|rome|barcelona|hamburg|estoril|munich|bastad|gstaad|umag|kitzbuhel|clay/i, 'Clay'],
  [/wimbledon|halle|queen|hertogenbosch|newport|eastbourne|mallorca|grass/i, 'Grass'],
];
const inferSurface = (n) => { for (const [re, s] of SURFACE_MAP) if (re.test(n || '')) return s; return 'Hard'; };
const inferTour = (n) => /wta|women|ladies/i.test(n || '') ? 'WTA' : /atp|challenger|men/i.test(n || '') ? 'ATP' : 'Tennis';
const isSlam = (n) => /roland[_ ]?garros|french open|wimbledon|us open|australian open/i.test(n || '');

// ---- index lookup (mark which matches have deep history) ----
// MUST match analyze.mjs exactly. Feeds send abbreviated names ("D. Jade"); if the two files
// normalize differently the board marks a match readable that analyze then 404s on — which is
// exactly the bug where clicking a game showed nothing.
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
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
        const n = normName(pl.name);
        if (!n) continue;
        set.add(n);
        const t = n.split(' ').filter(Boolean);
        last.set(`${t[t.length - 1]}|${(t[0] || ' ')[0]}`, true);
      }
      IDX = { set, last }; return IDX;
    } catch { /* next */ }
  }
  IDX = { set: new Set(), last: new Map() }; return IDX;
}
function inIndex(name) {
  const { set, last } = indexNames();
  const n = normName(name);
  if (!n || /^\d+$/.test(n)) return false;
  const t = n.split(' ').filter(Boolean);
  if (t.length < 2) return false;          // a bare fragment must never count as a player
  if (!set.size) return true;
  if (set.has(n)) return true;
  return last.has(`${t[t.length - 1]}|${(t[0] || ' ')[0]}`);
}
const HAS_LIVE = () => !!(process.env.APITENNIS_KEY || process.env.MATCHSTAT_KEY);

// Pull the set of players PrizePicks currently posts lines for, so the board can show which matches
// are actually playable on PP (vs. index-readable but no PP line). Cached, fails soft.
let PP = { at: 0, set: null };
async function prizePicksNames() {
  if (PP.set && Date.now() - PP.at < 5 * 60 * 1000) return PP.set;
  try {
    const r = await fetch('https://partner-api.prizepicks.com/projections?per_page=1000', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw 0;
    const j = await r.json();
    const players = new Map(), leagues = new Map();
    for (const inc of j.included || []) {
      if (inc.type === 'new_player') players.set(String(inc.id), inc.attributes?.name || '');
      if (inc.type === 'league') leagues.set(String(inc.id), inc.attributes?.name || '');
    }
    const set = new Set();
    for (const d of j.data || []) {
      const lg = leagues.get(String(d.relationships?.league?.data?.id ?? '')) || '';
      if (!/tennis/i.test(lg)) continue;
      const nm = players.get(String(d.relationships?.new_player?.data?.id ?? '')) || '';
      if (nm) { set.add(normName(nm)); const t = normName(nm).split(' ').filter(Boolean);
        if (t.length >= 2) set.add(`${t[t.length-1]}|${t[0][0]}`); }
    }
    PP = { at: Date.now(), set };
    return set;
  } catch { return PP.set || new Set(); }
}
function ppHas(ppSet, name) {
  if (!ppSet || !ppSet.size) return false;
  const n = normName(name); if (ppSet.has(n)) return true;
  const t = n.split(' ').filter(Boolean);
  return t.length >= 2 && ppSet.has(`${t[t.length-1]}|${t[0][0]}`);
}

function inWindow(iso, dateStr) {
  if (!iso) return false;
  if (dateStr) return iso.slice(0, 10) === dateStr;
  const t = Date.parse(iso), now = Date.now();
  return t >= now - 6 * 3600e3 && t <= now + 36 * 3600e3;
}
function finish(matches, ppSet) {
  for (const m of matches) {
    const idxA = inIndex(m.playerA), idxB = inIndex(m.playerB);
    const named = !/^\d+$/.test(String(m.playerA)) && !/^\d+$/.test(String(m.playerB));
    m.indexed = idxA && idxB;
    m.readable = (idxA && idxB) || (HAS_LIVE() && named);
    m.hasPP = ppHas(ppSet, m.playerA) || ppHas(ppSet, m.playerB);   // PrizePicks posts a line for this match
  }
  matches.sort((a, b) => (b.hasPP - a.hasPP) || (b.indexed - a.indexed) || (b.readable - a.readable)
    || (Date.parse(a.startTime) - Date.parse(b.startTime)));
  return matches;
}

// ---------- SOURCE 1: api-tennis.com ----------
async function fromApiTennis(date) {
  const key = process.env.APITENNIS_KEY;
  if (!key) return null;
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const start = date || iso(Date.now());
  const stop = date || iso(Date.now() + 36 * 3600e3);
  const qs = new URLSearchParams({ method: 'get_fixtures', APIkey: key, date_start: start, date_stop: stop });
  const r = await fetch(`https://api.api-tennis.com/tennis/?${qs}`);
  if (!r.ok) throw new Error(`api-tennis HTTP ${r.status}`);
  const j = await r.json();
  if (j.success !== 1) throw new Error(`api-tennis: ${JSON.stringify(j.result || j).slice(0, 120)}`);
  const rows = asList(j.result);
  const matches = [];
  for (const f of rows) {
    const tname = f.tournament_name || '';
    const d = f.event_date, tm = f.event_time || '00:00';
    const startTime = d ? new Date(`${d}T${tm.length === 5 ? tm : '00:00'}:00Z`).toISOString() : null;
    if (!inWindow(startTime, date)) continue;
    const a = f.event_first_player || f.first_player, b = f.event_second_player || f.second_player;
    if (!a || !b) continue;
    const tour = /wta/i.test(f.event_type_type || '') ? 'WTA'
      : /atp/i.test(f.event_type_type || '') ? 'ATP' : inferTour(`${f.event_type_type || ''} ${tname}`);
    matches.push({
      matchId: String(f.event_key ?? `${a}-${b}-${d}`),
      playerA: a, playerB: b, startTime,
      surface: inferSurface(tname), tour, tournament: tname,
      bestOf: (tour === 'ATP' && isSlam(tname)) ? 5 : 3,
    });
  }
  return matches;
}

// ---------- SOURCE 2: OddsPapi ----------
async function fromOddsPapi(date) {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return null;
  const BASE = 'https://api.oddspapi.io/v4';
  const get = async (p) => {
    const r = await fetch(`${BASE}/${p}${p.includes('?') ? '&' : '?'}apiKey=${key}`);
    if (!r.ok) throw new Error(`OddsPapi ${p.split('?')[0]} -> HTTP ${r.status}`);
    return r.json();
  };
  const isLowTier = (t) => /itf|utr|futures|m15|m25|w15|w25|w35|w50|exhibition/i.test(
    `${t.tournamentName || ''} ${t.categoryName || ''} ${t.categorySlug || ''}`);
  // Rank tour-level first but DON'T drop lower tiers — in off-weeks ITF is the only tennis running,
  // and cold-start makes those players readable. Dropping them emptied the board.
  const tournaments = asList(await get('tournaments?sportId=12'))
    .filter((t) => (t.upcomingFixtures || 0) + (t.liveFixtures || 0) > 0)
    .sort((a, b) => (isLowTier(a) - isLowTier(b))
      || (((b.upcomingFixtures || 0) + (b.liveFixtures || 0)) - ((a.upcomingFixtures || 0) + (a.liveFixtures || 0))))
    .slice(0, MAX_TOURNAMENTS);
  const matches = [];
  for (const t of tournaments) {
    const tname = t.tournamentName || '';
    let fx; try { fx = asList(await get(`fixtures?tournamentId=${t.tournamentId ?? t.id}`)); } catch { continue; }
    for (const f of fx) {
      if (!inWindow(f.startTime, date)) continue;
      const tour = inferTour(tname);
      matches.push({
        matchId: String(f.fixtureId ?? f.id),
        playerA: f.participant1Name || String(f.participant1Id),
        playerB: f.participant2Name || String(f.participant2Id),
        startTime: f.startTime,
        surface: inferSurface(tname), tour, tournament: tname,
        bestOf: (tour === 'ATP' && isSlam(tname)) ? 5 : 3,
      });
    }
  }
  return matches;
}

let CACHE = { key: null, at: 0, data: null };

export default async function handler(req, res) {
  const date = (req.query && req.query.date) || null;
  const key = date || 'upcoming';
  if (CACHE.key === key && Date.now() - CACHE.at < CACHE_MS) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, cached: true, ...CACHE.data });
    return;
  }
  const errors = [];
  for (const [name, fn] of [['api-tennis', fromApiTennis], ['oddspapi', fromOddsPapi]]) {
    try {
      const m = await fn(date);
      if (m == null) { errors.push(`${name}: no key`); continue; }
      if (!m.length) { errors.push(`${name}: 0 fixtures in window`); continue; }
      const ppSet = await prizePicksNames();
      const matches = finish(m, ppSet);
      const data = { source: name, date: date || 'upcoming', count: matches.length,
        readableCount: matches.filter((x) => x.readable).length,
        indexedCount: matches.filter((x) => x.indexed).length,
        ppCount: matches.filter((x) => x.hasPP).length, matches, note: null };
      CACHE = { key, at: Date.now(), data };
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, ...data });
      return;
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  res.status(200).json({ ok: true, source: null, date: date || 'upcoming', count: 0, matches: [],
    note: `No fixtures. Sources tried — ${errors.join(' | ')}. Set APITENNIS_KEY (preferred) or ODDSPAPI_KEY.` });
}
