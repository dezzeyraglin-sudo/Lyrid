// api/_lib/wnba/firstHalfProfile.js
//
// FIRST-HALF PROFILE — a consistency-gated "fast/slow starter" read.
//
// WHY IT EXISTS: the suppression signals (blowout risk, minutes cuts) act on the SECOND
// half — garbage time, starters pulled, leads protected. So a FRONT-loaded scorer banks
// production before suppression arrives and CLEARS the under (a trap); a BACK-loaded
// scorer loses their 2nd half and the under HOLDS. This module classifies who is which,
// then gates the suppression signals accordingly.
//
// HONESTY (validated on 3wk / 93 players / 329 game-pairs):
//   - first-half share is NOISE for most players: split-half r=0.055, next-game r=0.135.
//   - it ONLY predicts when the player is already consistent: prospective r rises to 0.201
//     for CV<0.25 vs 0.066 for CV>0.40.
//   - readable cohort is small: ~13/93 consistent, ~7 clearly front/back-loaded.
// Therefore this NEVER labels a player unless they clear the consistency + extremity +
// sample gates. Default is UNREADABLE, and UNREADABLE makes NO adjustment.
//
// Thresholds fit on WNBA Aug 2026 — RE-FIT on NBA data (structure ports, numbers don't).

const MIN_GAMES   = 4;      // need a real history
const MAX_CV      = 0.25;   // consistency gate — above this the read is noise
const FAST_SHARE  = 0.58;   // >= this 1H share = front-loaded (fast starter)
const SLOW_SHARE  = 0.42;   // <= this 1H share = back-loaded (slow starter)
const MIN_PTS     = 6;      // ignore games where the player barely scored (share is noise)

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function cv(a) {
  const m = mean(a);
  if (m <= 0) return Infinity;
  const sd = Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
  return sd / m;
}

// PURE CORE — classify from an array of per-game first-half shares (0..1).
// shares should already be filtered to games with >= MIN_PTS total scoring.
export function classifyFirstHalf(shares) {
  const n = Array.isArray(shares) ? shares.length : 0;
  if (n < MIN_GAMES) {
    return { label: 'UNREADABLE', reason: 'thin history', readable: false, n, mean1H: null, cv: null };
  }
  const m = mean(shares);
  const c = cv(shares);
  if (c >= MAX_CV) {
    return { label: 'VOLATILE', reason: 'cadence too noisy to trust', readable: false, n, mean1H: +m.toFixed(3), cv: +c.toFixed(2) };
  }
  if (m >= FAST_SHARE) {
    return { label: 'FAST_STARTER', reason: `consistent front-loader (${Math.round(m * 100)}% 1H)`, readable: true, n, mean1H: +m.toFixed(3), cv: +c.toFixed(2) };
  }
  if (m <= SLOW_SHARE) {
    return { label: 'SLOW_STARTER', reason: `consistent back-loader (${Math.round(m * 100)}% 1H)`, readable: true, n, mean1H: +m.toFixed(3), cv: +c.toFixed(2) };
  }
  return { label: 'NEUTRAL', reason: 'consistent but not extreme', readable: false, n, mean1H: +m.toFixed(3), cv: +c.toFixed(2) };
}

// Compute per-game first-half shares from ESPN play-by-play.
// recentGames: [{ eventId }] newest-first; fetchSummary(eventId) -> summary JSON.
// athleteId: the player's ESPN id. lookback caps how many games we pull (cost control).
export async function computeFirstHalfProfile(athleteId, recentGames, fetchSummary, { lookback = 8 } = {}) {
  const shares = [];
  for (const g of (recentGames || []).slice(0, lookback)) {
    const sm = await fetchSummary(g.eventId).catch(() => null);
    if (!sm) continue;
    let h1 = 0, h2 = 0;
    for (const p of (sm.plays || [])) {
      if (!p.scoringPlay) continue;
      if (String(p.participants?.[0]?.athlete?.id) !== String(athleteId)) continue;
      const per = typeof p.period === 'object' ? p.period?.number : p.period;
      const val = Number(p.scoreValue) || 0;
      if (per <= 2) h1 += val; else h2 += val;
    }
    const tot = h1 + h2;
    if (tot >= MIN_PTS) shares.push(h1 / tot);
  }
  return { ...classifyFirstHalf(shares), shares };
}

// THE GATE — how the profile modifies an UNDER driven by 2nd-half suppression
// (blowout risk, minutes cut, "defense suppresses"). Returns an adjustment the engine
// applies to that signal. UNREADABLE/VOLATILE/NEUTRAL -> no change (null delta).
export function cadenceGate(profile, { suppressionActive } = {}) {
  if (!profile?.readable || !suppressionActive) return { adjust: 'none', note: null };
  if (profile.label === 'FAST_STARTER') {
    return {
      adjust: 'downgrade',   // banks production before suppression -> the under is a TRAP
      note: `fast starter (${Math.round(profile.mean1H * 100)}% 1H) — banks early, before blowout/minutes suppression can land; suppression-driven under is a trap here`,
    };
  }
  if (profile.label === 'SLOW_STARTER') {
    return {
      adjust: 'strengthen', // loses the 2nd half to suppression -> the under is REAL
      note: `slow starter (${Math.round(profile.mean1H * 100)}% 1H) — production is 2nd-half weighted, exactly what suppression removes; under supported`,
    };
  }
  return { adjust: 'none', note: null };
}

export const _config = { MIN_GAMES, MAX_CV, FAST_SHARE, SLOW_SHARE, MIN_PTS };
export default { classifyFirstHalf, computeFirstHalfProfile, cadenceGate, _config };
