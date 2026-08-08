// api/tennis/liveApi.mjs — Live Tennis API adapter (free tier: schedule + scores + players).
// Base: https://api.livetennisapi.com/api/public/v1  ·  auth: Authorization: Bearer <LIVETENNISAPI key>
// Free tier limits: 30 req/min, 100/day — so we CACHE aggressively and never hammer it.
//
// Env var in Vercel: `livetennisapi` (the key value).
//
// This REPLACES the flaky OddsPapi schedule with a clean board. It maps the API's match shape to the
// exact object schedule.mjs already emits, so it's a drop-in. Serve stats for the engine still come
// from the Sackmann index — this feed supplies fixtures/scores + the CONTEXT signals (recent form,
// fatigue) that let us adjust a projection for what could shift a specific match.

const BASE = 'https://api.livetennisapi.com/api/public/v1';
const KEY = () => process.env.livetennisapi || process.env.LIVETENNISAPI_KEY || '';

// small in-memory cache so a board refresh doesn't burn the 100/day quota
const CACHE = globalThis.__ltapiCache || (globalThis.__ltapiCache = new Map());
const cached = async (key, ttlMs, fn) => {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  CACHE.set(key, { t: Date.now(), v });
  return v;
};

async function api(path, { ttlMs = 60000 } = {}) {
  const key = KEY();
  if (!key) throw new Error('livetennisapi key missing (set env var `livetennisapi`)');
  return cached(`GET ${path}`, ttlMs, async () => {
    const r = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (r.status === 429) throw new Error('livetennisapi rate-limited (free tier: 100/day)');
    if (r.status === 401) throw new Error('livetennisapi unauthorized — check the key');
    if (!r.ok) throw new Error(`livetennisapi ${r.status}`);
    return r.json();
  });
}

// ---- shape helpers: the API nests players and uses string points; normalize to our schema ----
const surfaceOf = (m) => {
  const s = (m.surface || m.court || m.court_name || '').toString();
  if (/clay/i.test(s)) return 'Clay';
  if (/grass/i.test(s)) return 'Grass';
  if (/carpet/i.test(s)) return 'Carpet';
  if (/hard|indoor/i.test(s)) return 'Hard';
  return s || 'Hard';
};
const tourOf = (m) => {
  const t = (m.tour || m.tour_name || m.category || '').toString().toUpperCase();
  if (t.includes('WTA')) return 'WTA';
  if (t.includes('ATP')) return 'ATP';
  if (t.includes('ITF')) return 'ITF';
  if (t.includes('CHALL')) return 'CH';
  return t || '';
};
const nameOf = (p) => (p && (p.name || p.full_name || p.player_name)) || '';

// Map one API match → the object schedule.mjs already returns, so this is a drop-in board source.
export function mapMatch(m) {
  const p1 = m.player_1 || m.p1 || m.home || {};
  const p2 = m.player_2 || m.p2 || m.away || {};
  return {
    matchId: String(m.match_id || m.id || m.fixture_id || ''),
    playerA: nameOf(p1),
    playerB: nameOf(p2),
    startTime: m.start_time || m.scheduled || m.date || null,
    surface: surfaceOf(m),
    tour: tourOf(m),
    tournament: m.tournament || m.tournament_name || m.event || '',
    bestOf: (tourOf(m) === 'ATP' && /grand slam|australian|french|wimbledon|us open/i.test(m.tournament || '')) ? 5 : 3,
    status: (m.status || '').toString().toLowerCase(),
    source: 'livetennisapi',
  };
}

// GET /matches?status=live  (also used with ?status=upcoming for the board)
export async function liveMatches(status = 'live') {
  const j = await api(`/matches?status=${encodeURIComponent(status)}`, { ttlMs: 30000 });
  const arr = Array.isArray(j) ? j : (j.data || j.matches || []);
  return arr.map(mapMatch).filter((m) => m.playerA && m.playerB);
}

// GET /matches/{id}/score — live score state (sets/games/points/server/tiebreak)
export async function matchScore(id) {
  const j = await api(`/matches/${encodeURIComponent(id)}/score`, { ttlMs: 15000 });
  return {
    sets: j.sets || null, games: j.games || null, points: j.points || null,
    server: j.server ?? null, isTiebreak: !!j.is_tiebreak,
    winProbP1: j.win_probability_p1 ?? null, ts: j.timestamp || null,
  };
}

// GET /players/{id} — bio, ranking, recent fixtures/results (the CONTEXT source)
export async function player(id) {
  return api(`/players/${encodeURIComponent(id)}`, { ttlMs: 3600000 });
}

export default { liveMatches, matchScore, player, mapMatch };
