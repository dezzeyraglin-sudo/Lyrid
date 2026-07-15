// tennisColdStart.mjs — read players who aren't in the index (ITF, Challenger, new pros).
//
// The index is built from historical ATP/WTA CSVs, so anyone outside that (ITF, Challenger, a
// first-year pro) has no profile and the read 404s. Both live sources (api-tennis.com, Matchstat)
// DO cover those tours — so when the index misses, we build a profile from their recent matches on
// demand. Same idea as pulling a new MLB call-up's stats instead of waiting for a season rebuild.
//
// The profile shape matches what the index emits (surfaces{} + recent{}), so buildMatchRead treats
// a cold-start player identically — it just carries `_coldStart:true` and a smaller sample, which
// the existing thin-sample gate already flags.

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const SURFACES = ['Hard', 'Clay', 'Grass'];

// Tour-neutral fallbacks — used where a cold-start player has no data for a field. Deliberately
// average: a player we know little about should read as ordinary, not exceptional.
const NEUTRAL = { acePerSvGm: 0.55, dfPerSvGm: 0.28, servePtsWonPct: 0.635,
  retPtsWonPct: 0.365, acesFacedPerRetGm: 0.55, winPct: 0.5, n: 0, svGms: 0, retGms: 0 };

function profileFrom(rows) {
  const withStats = rows.filter((r) => r.svGms);
  if (!withStats.length) return null;
  const aceRows = withStats.filter((r) => r.aces != null);
  const spwRows = withStats.filter((r) => r.servePtsWonPct != null);
  return {
    ...NEUTRAL,
    acePerSvGm: aceRows.length ? mean(aceRows.map((r) => r.aces / r.svGms)) : NEUTRAL.acePerSvGm,
    servePtsWonPct: spwRows.length ? mean(spwRows.map((r) => r.servePtsWonPct)) : NEUTRAL.servePtsWonPct,
    n: withStats.length,
    svGms: mean(withStats.map((r) => r.svGms)),
    _n: withStats.length,
    _coldStart: true,
  };
}

/**
 * Build an index-shaped player from a live source's recent matches.
 * Returns null if the source can't find them or returns nothing usable.
 */
export async function coldStartPlayer(source, name) {
  if (!source || !name) return null;
  let rows = [];
  try { rows = await source.fetchRecentMatches(name); } catch { return null; }
  if (!rows || !rows.length) return null;

  const all = profileFrom(rows);
  if (!all) return null;

  const surfaces = { ALL: all };
  for (const s of SURFACES) {
    const sub = profileFrom(rows.filter((r) => r.surface === s));
    // only publish a surface profile with real support; otherwise the ALL profile carries the read
    if (sub && sub.n >= 3) surfaces[s] = sub;
  }

  const last = rows[rows.length - 1] || {};
  return {
    name,
    rank: null,
    lastDate: last.date || null,
    bucket: 'unranked',
    surfaces,
    tier: 'off-index',
    recent: {
      formAce: 0, formServe: 0,               // form is measured vs a career baseline we don't have
      matchesLast10: rows.length,
      minutesLast10: rows.reduce((s, r) => s + (r.minutes || 0), 0),
      lastSurface: last.surface || null,
      lastDate: last.date || null,
      _source: 'coldstart',
    },
    _coldStart: true,
    _sampleMatches: rows.length,
  };
}

/** Resolve both players: index first, live cold-start as fallback. */
export async function resolveWithColdStart(source, indexPlayer, name) {
  if (indexPlayer) return { player: indexPlayer, coldStart: false };
  const cs = await coldStartPlayer(source, name);
  return { player: cs, coldStart: !!cs };
}

export default { coldStartPlayer, resolveWithColdStart };
