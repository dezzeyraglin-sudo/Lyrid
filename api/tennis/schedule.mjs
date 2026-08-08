// api/tennis/schedule.mjs — the board. Multi-source with auto-failover:
//   1) Live Tennis API (primary — free tier, clean board)   ← NEW
//   2) api-tennis.com (APITENNIS_KEY)
//   3) OddsPapi (ODDSPAPI_KEY, quota-limited fallback)
// Returns matches[] in the shape the frontend controller expects. 30-min in-memory cache.

import { liveMatches } from './liveApi.mjs';

const CACHE = globalThis.__schedCache || (globalThis.__schedCache = { t: 0, v: null });
const CACHE_MS = 30 * 60 * 1000;

// cross-reference live PrizePicks names to flag which matches have PP props
async function hasPPSet(origin) {
  try {
    const r = await fetch(`${origin}/api/tennis/prizepicks`, { cache: 'no-store' });
    if (!r.ok) return new Set();
    const j = await r.json();
    const names = new Set();
    for (const p of (j.projections || j.data || [])) {
      const n = (p.player || p.name || '').toLowerCase();
      if (n) names.add(n.split(' ').pop());   // last name
    }
    return names;
  } catch { return new Set(); }
}

async function fromApiTennis() {
  const key = process.env.APITENNIS_KEY;
  if (!key) return [];
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const r = await fetch(`https://api.api-tennis.com/tennis/?method=get_fixtures&APIkey=${key}&date_start=${today}&date_stop=${end}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.result || []).map((m) => ({
    matchId: String(m.event_key), playerA: m.event_first_player, playerB: m.event_second_player,
    startTime: `${m.event_date}T${m.event_time || '00:00'}:00Z`,
    surface: /clay/i.test(m.tournament_name) ? 'Clay' : /grass/i.test(m.tournament_name) ? 'Grass' : 'Hard',
    tour: /wta/i.test(m.tournament_name) ? 'WTA' : /itf/i.test(m.tournament_name) ? 'ITF' : 'ATP',
    tournament: m.tournament_name, bestOf: 3, status: (m.event_status || '').toLowerCase(), source: 'apitennis',
  })).filter((m) => m.playerA && m.playerB);
}

export default async function handler(req, res) {
  try {
    if (CACHE.v && Date.now() - CACHE.t < CACHE_MS) {
      res.status(200).json({ ok: true, cached: true, count: CACHE.v.length, matches: CACHE.v });
      return;
    }
    const origin = `https://${req.headers.host}`;
    let matches = [];
    let source = 'none';

    // 1) Live Tennis API — primary. Pull upcoming + live and merge.
    try {
      const [up, live] = await Promise.all([
        liveMatches('upcoming').catch(() => []),
        liveMatches('live').catch(() => []),
      ]);
      const merged = [...live, ...up];
      if (merged.length) { matches = merged; source = 'livetennisapi'; }
    } catch (e) { /* fall through */ }

    // 2) api-tennis.com fallback
    if (!matches.length) {
      try { const at = await fromApiTennis(); if (at.length) { matches = at; source = 'apitennis'; } } catch {}
    }

    // dedupe by matchId, rank tour-level above ITF but keep ITF (cold-start reads them)
    const seen = new Set();
    matches = matches.filter((m) => { const k = m.matchId || `${m.playerA}|${m.playerB}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const tierRank = { ATP: 0, WTA: 0, CH: 1, ITF: 2 };
    matches.sort((a, b) => (tierRank[a.tour] ?? 3) - (tierRank[b.tour] ?? 3));

    // flag PP availability
    const pp = await hasPPSet(origin);
    for (const m of matches) {
      m.hasPP = pp.has((m.playerB || '').toLowerCase().split(' ').pop()) || pp.has((m.playerA || '').toLowerCase().split(' ').pop());
    }

    CACHE.t = Date.now(); CACHE.v = matches;
    res.status(200).json({ ok: true, source, count: matches.length, matches });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e), matches: CACHE.v || [] });
  }
}
