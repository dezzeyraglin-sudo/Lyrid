// api/_lib/basketball/injuryFeed.js
//
// WNBA INJURY FEED — ESPN JSON API (rewritten Aug 2026)
//
// Migrated off BallDontLie. The earlier ESPN removal was because the old code
// SCRAPED ESPN's injury HTML page (__espnfitt__ blob), which was fragile and
// threw on structure changes. This uses ESPN's structured JSON injuries endpoint
// instead (site.api.espn.com/.../wnba/injuries) via the shared raw-https client
// in wnbaFeedEspn.js — reliable, keyless, and not IP-blocked like stats.wnba.com.
//
// The export name `fetchEspnWnbaInjuries` is unchanged so slate.js needs no edit.
// Report shape consumed by the slate:
//   { fetchedAt, source, all:[{playerName,status,detail,teamAbbrev,source}],
//     byName:{normName: entry}, byPlayerId:{}, byTeamAbbrev:{ABBR:[entry]} }
//
// FAIL-SAFE: never throws. On any failure returns a valid empty report (all
// players AVAILABLE) so the slate still runs.

import { getInjuries } from '../wnba/wnbaFeedEspn.js';

/**
 * Fetch the WNBA injury report from ESPN's JSON API. Always resolves; never throws.
 */
export async function fetchEspnWnbaInjuries(opts = {}) {
  const report = {
    fetchedAt: new Date().toISOString(),
    source: 'espn',
    all: [],
    byName: {},
    byPlayerId: {},       // ESPN report is name-keyed; kept for shape compatibility
    byTeamAbbrev: {},
    _audit: null,
  };
  try {
    const inj = await getInjuries(opts);
    report.all = inj.all || [];
    report.byName = inj.byName || {};
    report.byTeamAbbrev = inj.byTeamAbbrev || {};
    report._audit = inj._audit || null;
  } catch (err) {
    report._audit = { error: err.message };
  }
  return report;
}

// Legacy parse export retained as a no-op-safe stub in case anything imports it.
export function parseEspnInjuriesPayload() {
  return { fetchedAt: new Date().toISOString(), source: 'espn', all: [], byName: {}, byPlayerId: {}, byTeamAbbrev: {} };
}

export default fetchEspnWnbaInjuries;
