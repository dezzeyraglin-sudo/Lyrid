// api/tennis/schedule.mjs — upcoming tennis slate from OddsPapi (the source we validated).
// Fixture-first: /tournaments?sportId=12 -> active tournaments -> /fixtures?tournamentId=X.
// The board only needs fixtures (players + time); projections come from the index and you type the
// lines. Odds are NOT pulled here, so this stays cheap on the 250/month free tier.
//   GET /api/tennis/schedule            -> today + next ~36h
//   GET /api/tennis/schedule?date=YYYY-MM-DD
// Requires env ODDSPAPI_KEY. Returns { ok, date, matches:[{matchId, playerA, playerB, startTime,
// surface, tour, tournament, bestOf}] } — the exact shape the SPA controller expects.

const BASE = 'https://api.oddspapi.io/v4';
const SPORT_ID_TENNIS = 12;          // confirmed via probe
const MAX_TOURNAMENTS = 20;          // quota guard: 1 + up to 20 fixture calls per cold fetch
const CACHE_MS = 30 * 60 * 1000;     // 30 min — board loads hit cache, not OddsPapi

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
    const tournaments = asList(await getJson(`tournaments?sportId=${SPORT_ID_TENNIS}`))
      .filter((t) => (t.upcomingFixtures || 0) + (t.liveFixtures || 0) > 0)
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
        matches.push({
          matchId: String(f.fixtureId ?? f.id),
          playerA: f.participant1Name || f.participant1Id,
          playerB: f.participant2Name || f.participant2Id,
          startTime: f.startTime,
          surface: inferSurface(tname),
          tour: inferTour(tname),
          tournament: tname,
          bestOf: (inferTour(tname) === 'ATP' && isSlam(tname)) ? 5 : 3,
        });
      }
    }
    matches.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    const data = { date: date || 'upcoming', count: matches.length, matches,
      note: matches.length ? null : 'No tennis fixtures in window.' };
    CACHE = { key, at: Date.now(), data };
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
