// api/nba/slate.js
// Lightweight NBA board: schedule + line counts. No projections.

import * as espn from '../_lib/nba/espnClient.js';
import { fetchNbaProps } from '../_lib/nba/prizepicks.js';

function todayISO() { return new Date().toISOString().slice(0, 10); }

export default async function handler(req, res) {
  try {
    const date = (req.query?.date) || todayISO();
    const [schedule, props] = await Promise.all([
      espn.fetchSchedule(date.replace(/-/g, '')),
      fetchNbaProps().catch(() => ({ lines: [], count: 0 })),
    ]);
    const propsByTeam = {};
    for (const l of props.lines || []) if (l.team) propsByTeam[l.team] = (propsByTeam[l.team] || 0) + 1;

    const games = schedule.map((g) => ({
      gameId: g.eventId, date: g.date, status: g.status,
      home: g.home.abbr, away: g.away.abbr,
      favAbbr: g.favAbbr, spread: g.spread, total: g.total,
      standardProps: (propsByTeam[g.home.abbr] || 0) + (propsByTeam[g.away.abbr] || 0),
    }));
    res.status(200).json({ date, games, totalStandardProps: props.count || 0 });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
