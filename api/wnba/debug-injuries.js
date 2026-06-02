// api/wnba/debug-injuries.js
//
// INJURY DEBUG (June 2, 2026)
//
// Shows exactly what the injury pipeline returns from the deployed environment,
// so we can see WHY ruled-out players show as active. Tests both sources the
// slate uses and reports each independently.
//
//   GET /api/wnba/debug-injuries
//   -> { espn: {...}, bdl: {...}, merged: {...}, diagnosis }
//
// ESPN failing (throw) OR returning 0 rows from a datacenter IP is the prime
// suspect — same blocking that killed stats.wnba.com / DraftKings this build.

import { fetchEspnWnbaInjuries } from '../_lib/basketball/injuryFeed.js';
import { fetchWnbaInjuries, isBdlConfigured } from '../_lib/wnba/bdlFeed.js';

export default async function handler(req, res) {
  const out = { ok: true, espn: {}, bdl: {}, diagnosis: '' };

  // --- ESPN source (the legacy primary) ---
  try {
    const r = await fetchEspnWnbaInjuries();
    out.espn = {
      reachable: true,
      count: r.all?.length || 0,
      teams: Object.keys(r.byTeamAbbrev || {}),
      sample: (r.all || []).slice(0, 6).map(x => ({ name: x.playerName, status: x.status, team: x.teamAbbrev })),
      audit: r._audit || null,
    };
  } catch (err) {
    out.espn = { reachable: false, error: err.message };
  }

  // --- BDL source (the second source we merge) ---
  try {
    if (!isBdlConfigured()) {
      out.bdl = { keyConfigured: false };
    } else {
      const b = await fetchWnbaInjuries({ noCache: true });
      out.bdl = {
        keyConfigured: true,
        count: b.all?.length || 0,
        httpStatus: b._audit?.httpStatus,
        sample: (b.all || []).slice(0, 6).map(x => ({ name: x.playerName, status: x.status })),
        audit: b._audit || null,
      };
    }
  } catch (err) {
    out.bdl = { error: err.message };
  }

  // --- Diagnosis ---
  const espnOk = out.espn.reachable && out.espn.count > 0;
  const bdlOk = out.bdl.count > 0;
  if (espnOk || bdlOk) {
    out.diagnosis = `Injuries ARE available (ESPN: ${out.espn.count || 0}, BDL: ${out.bdl.count || 0}). ` +
      `If players still show active, the bug is the NAME MATCH in buildV2Roster or WNBA_V2_PROJECTIONS being off.`;
  } else if (!out.espn.reachable && !bdlOk) {
    out.diagnosis = `NEITHER source returned injuries. ESPN error: "${out.espn.error}". ` +
      `BDL count 0 (status ${out.bdl.httpStatus}). This is why everyone shows active — there is no injury data reaching the slate.`;
  } else {
    out.diagnosis = `ESPN reachable but 0 rows (page structure may have changed), BDL 0 rows. No injuries reaching slate.`;
  }

  return res.status(200).json(out);
}
