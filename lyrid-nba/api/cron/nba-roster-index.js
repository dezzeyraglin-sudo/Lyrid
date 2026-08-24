// api/cron/nba-roster-index.js
//
// Nightly: rebuild the current-team roster index and cache it. analyze.js should
// READ this cache (Supabase/KV) rather than calling buildRosterIndex() per request
// — that resolves ~550 ESPN athlete refs and must not run on the hot path.
//
// vercel.json:
//   { "crons": [ { "path": "/api/cron/nba-roster-index", "schedule": "0 8 * * *" } ] }

import { buildRosterIndex } from '../_lib/nba/espnRoster.js';

export default async function handler(req, res) {
  // guard: Vercel cron sets this header; reject public calls
  if (process.env.CRON_SECRET && req.headers?.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const season = Number(process.env.NBA_ROSTER_SEASON || 2027);
    const index = await buildRosterIndex(season);
    const payload = { season, byNameKey: index.byNameKey, byId: index.byId, builtAt: new Date().toISOString() };

    // TODO: persist `payload` to your store, e.g.
    //   await supabase.from('nba_roster_index').upsert({ id: 'current', data: payload });
    res.status(200).json({ ok: true, season, players: Object.keys(index.byId).length, builtAt: payload.builtAt });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
