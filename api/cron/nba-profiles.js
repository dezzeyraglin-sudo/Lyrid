// api/cron/nba-profiles.js
// Nightly: build the current-team roster index + bbref team context ONCE and cache them,
// so analyze.js reads cached profiles instead of ~540 inline ESPN calls per request (the
// timeout that was dropping most of the slate). Supersedes api/cron/nba-roster-index.js.
//
// vercel.json: { "crons": [ { "path": "/api/cron/nba-profiles", "schedule": "0 8 * * *" } ] }

import { buildRosterIndex } from '../_lib/nba/espnRoster.js';
import { fetchTeamContext } from '../_lib/nba/bbrefClient.js';
import { writeProfile, storeConfigured } from '../_lib/nba/profileStore.js';

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers?.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!storeConfigured()) return res.status(500).json({ error: 'profile store not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)' });
  try {
    const rosterSeason = Number(process.env.NBA_ROSTER_SEASON || 2027);
    const bbrefSeason = Number(process.env.NBA_SEASON || 2026);
    const [roster, teamCtx] = await Promise.all([buildRosterIndex(rosterSeason), fetchTeamContext(bbrefSeason)]);
    const builtAt = new Date().toISOString();
    await writeProfile('roster', rosterSeason, { season: rosterSeason, byNameKey: roster.byNameKey, byId: roster.byId, builtAt });
    await writeProfile('teams', bbrefSeason, { season: bbrefSeason, teams: teamCtx.teams, builtAt });
    res.status(200).json({ ok: true, builtAt, players: Object.keys(roster.byId || {}).length, teams: Object.keys(teamCtx.teams || {}).length });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
