// api/tennis/schedule.mjs — upcoming ATP/WTA slate from The Odds API.
// Uses the /sports and /events endpoints, which are FREE (they don't spend your odds quota),
// so this fits the free-first plan and never touches BDL.
//   GET /api/tennis/schedule?date=YYYY-MM-DD   (omit date = next ~48h)
// Returns { ok, date, matches:[{ matchId, playerA, playerB, startTime, surface, tour, tournament, bestOf }] }
//
// Requires env ODDS_API_KEY. Surface + best-of are inferred from the tournament key/title
// (Sackmann has the authoritative surface per completed match, but for UPCOMING fixtures we
// infer). Adjust SURFACE_MAP as the tour calendar rolls over.

const ODDS_BASE = 'https://api.the-odds-api.com/v4';

// tournament-key/title fragments → surface. Order matters (first hit wins).
const SURFACE_MAP = [
  [/roland[_ ]?garros|french[_ ]?open/i, 'Clay'],
  [/wimbledon/i, 'Grass'],
  [/us[_ ]?open|australian[_ ]?open|indian[_ ]?wells|miami|cincinnati|shanghai|paris[_ ]?master|canadian|us[_ ]?hardcourt/i, 'Hard'],
  [/monte[_ ]?carlo|madrid|rome|barcelona|hamburg|estoril|munich|clay/i, 'Clay'],
  [/halle|queen|s[_ ]?hertogenbosch|stuttgart|newport|grass/i, 'Grass'],
];
function inferSurface(key, title) {
  const hay = `${key} ${title || ''}`;
  for (const [re, surf] of SURFACE_MAP) if (re.test(hay)) return surf;
  return 'Hard'; // tour default
}
// Men's Grand Slams are Bo5; everything else (and all WTA) Bo3.
function inferBestOf(key, title, tour) {
  const isSlam = /roland[_ ]?garros|french[_ ]?open|wimbledon|us[_ ]?open|australian[_ ]?open/i.test(`${key} ${title || ''}`);
  return (tour === 'ATP' && isSlam) ? 5 : 3;
}
function tourOf(key) {
  if (/wta/i.test(key)) return 'WTA';
  if (/atp/i.test(key)) return 'ATP';
  return 'ATP';
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Odds API ${r.status} for ${url.split('?')[0]}`);
  return r.json();
}

// Same UTC calendar day as `dateStr` (YYYY-MM-DD); if no dateStr, within the next 48h.
function inWindow(commenceIso, dateStr) {
  const t = new Date(commenceIso);
  if (dateStr) return commenceIso.slice(0, 10) === dateStr;
  const now = Date.now();
  return t.getTime() >= now - 3 * 3600e3 && t.getTime() <= now + 48 * 3600e3;
}

let CACHE = { key: null, at: 0, data: null };

export default async function handler(req, res) {
  try {
    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) { res.status(500).json({ error: 'ODDS_API_KEY not set' }); return; }
    const date = (req.query && req.query.date) || null;

    const cacheKey = date || 'upcoming';
    if (CACHE.key === cacheKey && Date.now() - CACHE.at < 5 * 60e3) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, cached: true, ...CACHE.data });
      return;
    }

    // 1) active tennis sport keys
    const sports = await getJson(`${ODDS_BASE}/sports/?apiKey=${apiKey}`);
    const tennisKeys = sports.filter((s) => s.active &&
      (s.group === 'Tennis' || /^tennis_/i.test(s.key)));

    // 2) events per key (free endpoint)
    const matches = [];
    for (const s of tennisKeys) {
      let events;
      try { events = await getJson(`${ODDS_BASE}/sports/${s.key}/events?apiKey=${apiKey}`); }
      catch { continue; }
      const tour = tourOf(s.key);
      const surface = inferSurface(s.key, s.title);
      const bestOf = inferBestOf(s.key, s.title, tour);
      for (const e of events) {
        if (!inWindow(e.commence_time, date)) continue;
        matches.push({
          matchId: e.id,
          playerA: e.home_team, playerB: e.away_team,
          startTime: e.commence_time,
          surface, tour, tournament: s.title || s.key, bestOf,
        });
      }
    }
    matches.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    const data = { date: date || 'upcoming', count: matches.length, matches,
      note: matches.length ? null : 'No tennis events in window — off-week or between tournaments.' };
    CACHE = { key: cacheKey, at: Date.now(), data };
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
