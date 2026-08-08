// api/wnba/debug-injuries.js
//
// INJURY DEBUG (ESPN-only, Aug 2026)
//
// Shows exactly what the injury pipeline returns from the deployed environment,
// so we can see WHY ruled-out players show as active. BDL has been removed; ESPN's
// JSON injuries endpoint is the sole source now.
//
//   GET /api/wnba/debug-injuries
//   -> { espn: {...}, diagnosis }
//
// If ESPN returns 0 rows from a datacenter IP, that's the prime suspect — the same
// blocking that killed stats.wnba.com. The raw-https + curl-UA client is our best
// shot at getting through; this endpoint confirms it live from Vercel.

import { fetchEspnWnbaInjuries } from '../_lib/basketball/injuryFeed.js';

export default async function handler(req, res) {
  const out = { ok: true, espn: {}, diagnosis: '' };

  try {
    const r = await fetchEspnWnbaInjuries();
    out.espn = {
      reachable: true,
      count: r.all?.length || 0,
      teams: Object.keys(r.byTeamAbbrev || {}),
      sample: (r.all || []).slice(0, 8).map(x => ({ name: x.playerName, status: x.status, team: x.teamAbbrev, detail: x.detail })),
      audit: r._audit || null,
    };
  } catch (err) {
    out.espn = { reachable: false, error: err.message };
  }

  const espnOk = out.espn.reachable && out.espn.count > 0;
  if (espnOk) {
    out.diagnosis = `Injuries ARE available (ESPN: ${out.espn.count}). ` +
      `If players still show active, the bug is the NAME MATCH in buildV2Roster or WNBA_V2_PROJECTIONS being off.`;
  } else if (!out.espn.reachable) {
    out.diagnosis = `ESPN injuries unreachable — error: "${out.espn.error}". ` +
      `Likely a datacenter-IP block on this Vercel region. No injury data is reaching the slate, so everyone shows active.`;
  } else {
    out.diagnosis = `ESPN reachable but 0 rows. The injuries endpoint returned an empty set (off-season or structure change).`;
  }

  return res.status(200).json(out);
}
