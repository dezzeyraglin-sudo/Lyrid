// tennisElo.js — surface-specific Elo, computed from match RESULTS (wins/losses).
//
// WHY: raw serve/return percentages are level-biased and mathematically under-determined —
// p(point) = spw_server + (TOUR_RET - ret_returner) is invariant to adding the same constant to
// every spw AND every ret, so a closed pool of same-tier players cannot be separated from tour
// players using point aggregates alone. Elo escapes that trap because it is built from the MATCH
// GRAPH: qualifiers and players who move between Challenger and tour connect the tiers, so the
// level gap propagates. Kovalchik (2016) surveyed 11 published models; Elo (Morris/Bialik) hit
// ~70% accuracy, second only to bookmaker consensus and ahead of every point-based method.
//
// FiveThirtyEight-style dynamic K: K = 250/(n+5)^0.4 — big early moves, stabilising with experience.

const START = 1500;
const SURFACES = ['Hard', 'Clay', 'Grass', 'Carpet'];
const kFactor = (n) => 250 / Math.pow((n || 0) + 5, 0.4);
export const expectedScore = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

export function buildElo(rows) {
  const seen = new Set(); const matches = [];
  for (const r of rows) {
    if (!r.playerId || !r.oppId || !r.date || !r.won) continue;   // feed emits won as 1/0
    const k = [r.playerId, r.oppId].sort().join('-') + '|' + r.date + '|' + (r.tourney || '');
    if (seen.has(k)) continue;
    seen.add(k);
    matches.push({ date: r.date, w: r.playerId, l: r.oppId,
      surface: SURFACES.includes(r.surface) ? r.surface : 'Hard' });
  }
  matches.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const overall = new Map();
  const bySurface = {}; for (const s of SURFACES) bySurface[s] = new Map();
  const get = (m, id) => { if (!m.has(id)) m.set(id, { r: START, n: 0 }); return m.get(id); };
  const update = (m, wId, lId) => {
    const W = get(m, wId), L = get(m, lId);
    const eW = expectedScore(W.r, L.r);
    W.r += kFactor(W.n) * (1 - eW); L.r -= kFactor(L.n) * (1 - eW);
    W.n++; L.n++;
  };
  for (const m of matches) { update(overall, m.w, m.l); update(bySurface[m.surface], m.w, m.l); }
  return { overall, bySurface, matches: matches.length };
}

// Surface samples are thin → shrink surface rating toward overall by surface-match count.
export function surfaceElo(elo, id, surface, kShrink = 20) {
  const o = elo.overall.get(id); const base = o ? o.r : START;
  const sm = elo.bySurface[surface]; const s = sm ? sm.get(id) : null;
  if (!s || !s.n) return base;
  return base + (s.n / (s.n + kShrink)) * (s.r - base);
}
export function eloWinProb(elo, idA, idB, surface) {
  return expectedScore(surfaceElo(elo, idA, surface), surfaceElo(elo, idB, surface));
}
export function eloToJSON(elo) {
  const out = { overall: {}, bySurface: {} };
  for (const [id, v] of elo.overall) out.overall[id] = { r: Math.round(v.r * 10) / 10, n: v.n };
  for (const s of SURFACES) { out.bySurface[s] = {};
    for (const [id, v] of elo.bySurface[s]) out.bySurface[s][id] = { r: Math.round(v.r * 10) / 10, n: v.n }; }
  return out;
}
export function eloFromJSON(j) {
  const elo = { overall: new Map(), bySurface: {} };
  for (const [id, v] of Object.entries(j?.overall || {})) elo.overall.set(id, v);
  for (const s of SURFACES) { elo.bySurface[s] = new Map();
    for (const [id, v] of Object.entries(j?.bySurface?.[s] || {})) elo.bySurface[s].set(id, v); }
  return elo;
}
export default { buildElo, surfaceElo, eloWinProb, expectedScore, eloToJSON, eloFromJSON };
