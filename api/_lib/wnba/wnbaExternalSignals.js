// api/_lib/wnba/wnbaExternalSignals.js
//
// SOCKETS for engine layers that don't yet have a data source. Each function is a
// no-op stub that returns null → the layer stays NEUTRAL (active:false), exactly
// as today. When you find/buy a source for one of these, implement the function
// and that layer activates AUTOMATICALLY across every card and best-bet — no
// engine edits, no slate edits. This is the one file to touch to light up a layer.
//
// The slate calls each of these per (player, market) if it's defined. Keep them
// fast and fail-safe (return null on any doubt); the slate already wraps calls in
// try/catch, but returning null is the clean "no signal" answer.
//
// Multiplier convention everywhere: 1.0 = neutral, >1 = boosts the projection
// (e.g. soft coverage / fast pace), <1 = suppresses. Keep raw values in a sane
// band (~0.85–1.15); the engine damps and clamps them again.

/**
 * COACHING COVERAGE — defensive scheme vs the player's archetype.
 * Return either a number (multiplier) or { scheme, vsArchetypeMultiplier }.
 * @param {string} opponent  opponent tricode (e.g. 'NYL')
 * @param {Object} player    the player object (has position, archetype, etc.)
 * @param {string} market    'points' | 'rebounds' | 'assists'
 * @returns {number|Object|null}
 *
 * Example once a source exists:
 *   if (opponent === 'CON' && player.archetype === 'iso-guard')
 *     return { scheme: 'switch-heavy', vsArchetypeMultiplier: 0.94 };
 */
export function externalCoverageSignal(opponent, player, market) {
  return null;   // no scheme source yet → COV stays neutral
}

/**
 * WHISTLE — opponent team foul rate (fouls drawn allowed per game). The whistle
 * layer is already FTA-aware on the player side; this supplies the matchup side.
 * @param {string} opponent  opponent tricode
 * @returns {number|null}    fouls/40 or similar rate; league avg ~21
 *
 * Example: return TEAM_FOUL_RATES[opponent] ?? null;
 */
export function externalFoulRate(opponent) {
  return null;   // no team-foul-rate source yet → whistle uses player FTA only
}

/**
 * ENVIRONMENT / PACE — game tempo multiplier. Faster pace = more possessions =
 * more counting-stat opportunity.
 * @param {string} opponent  opponent tricode
 * @param {string} team      the player's team tricode
 * @param {number} total     game total if available (can proxy pace)
 * @returns {number|null}    ~0.9–1.1; >1 = up-tempo
 *
 * Example once a pace source exists:
 *   const pace = PACE_BY_TEAM[opponent];
 *   return pace ? clampish(pace / LEAGUE_PACE) : null;
 */
export function externalPaceSignal(opponent, team, total) {
  // ENV / tempo, powered by the game TOTAL (from the Odds API, already passed in).
  // A high projected total = more possessions + a higher-scoring game = more
  // counting-stat opportunity, which lifts overs and pressures unders. This is a
  // legitimate, currently-available environment signal; it is NOT true pace, but
  // total is the cleanest tempo proxy we can source for free today.
  //
  // Convention: 1.0 = neutral, >1 boosts the projection. Damped and clamped to a
  // sane band (the engine damps/clamps again). Returns null when no total is
  // available so the layer stays neutral rather than guessing.
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return null;   // no line → ENV stays neutral

  const LEAGUE_AVG_TOTAL = 163;   // ~WNBA average game total
  const ratio = t / LEAGUE_AVG_TOTAL;
  // 60% pass-through on the deviation, clamped to ±8%.
  const mult = Math.max(0.92, Math.min(1.08, 1 + (ratio - 1) * 0.6));
  return Number(mult.toFixed(3));
}
