// api/_lib/basketball/injuryFeed.js
//
// WNBA INJURY FEED — BALLDONTLIE ONLY (rewritten June 2, 2026)
//
// ESPN has been REMOVED entirely. ESPN's injury page is unreliable from Vercel
// (datacenter-IP blocking + frequent page-structure changes that made the
// __espnfitt__ parse throw), and a thrown fetch silently nulled the whole
// report — so every ruled-out player showed as active. BallDontLie is the sole
// source now: it's the paid, working feed and the key is already configured.
//
// The export name `fetchEspnWnbaInjuries` is intentionally UNCHANGED so slate.js
// (which imports that name) needs no edit. It now returns BDL data in the report
// shape the slate consumes:
//   { fetchedAt, source, all:[{playerName,status,detail,teamAbbrev,source}],
//     byName:{normName: entry}, byPlayerId:{}, byTeamAbbrev:{ABBR:[entry]} }
//
// FAIL-SAFE: never throws. On any failure returns a valid empty report (all
// players AVAILABLE) so the slate runs — but unlike the old ESPN feed, the empty
// case is now the rare exception, not the silent default.

import { fetchWnbaInjuries } from '../wnba/bdlFeed.js';

/**
 * Fetch the WNBA injury report from BallDontLie. Name kept for slate import
 * compatibility. Always resolves; never throws.
 */
export async function fetchEspnWnbaInjuries(opts = {}) {
  const report = {
    fetchedAt: new Date().toISOString(),
    source: 'balldontlie',
    all: [],
    byName: {},
    byPlayerId: {},       // unused for BDL (name-keyed), kept for shape compatibility
    byTeamAbbrev: {},
    _audit: null,
  };
  try {
    const bdl = await fetchWnbaInjuries(opts);
    report.all = bdl.all || [];
    report.byName = bdl.byName || {};
    report.byTeamAbbrev = bdl.byTeamAbbrev || {};
    report._audit = bdl._audit || null;
  } catch (err) {
    report._audit = { error: err.message };
  }
  return report;
}

// Legacy parse export retained as a no-op-safe stub in case anything imports it.
export function parseEspnInjuriesPayload() {
  return { fetchedAt: new Date().toISOString(), source: 'removed', all: [], byName: {}, byPlayerId: {}, byTeamAbbrev: {} };
}

export default fetchEspnWnbaInjuries;
