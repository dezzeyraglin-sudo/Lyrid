// nflPlayerVsOpponent.js
// Lyrid NFL engine — player-vs-specific-opponent history feature.
//
// HONESTY GUARD: "Player X owns Team Y" is mostly small-sample noise. This module
// computes the signal but DELIBERATELY caps its influence:
//   - requires a minimum number of prior meetings (default 4) before emitting any signal
//   - returns a LOW-WEIGHT z-nudge, never a standalone pick driver
//   - the real matchup edge lives in archetype-vs-scheme (coverage/man-zone), not here
// This mirrors the MLB SCORCHING-tier lesson: raw hot-history decayed to 50%.
//
// Input: a player's prior game rows vs a given opponent (from nfl_player_games),
// plus that player's overall baseline for the same prop family.

const MIN_MEETINGS = 4;         // below this, emit zero signal
const MAX_ABS_NUDGE = 0.25;     // hard cap on the z-nudge magnitude

// propFamily -> stat field
const FIELD = {
  passing_yards: 'passing_yards',
  rushing_yards: 'rushing_yards',
  receiving_yards: 'receiving_yards',
  rush_rec_yards: 'rush_rec_yards',
};

// games: array of prior rows vs THIS opponent (each has the stat field)
// baselineMean / baselineStd: player's overall distribution for this prop family
export function playerVsOpponentNudge({ games, propFamily, baselineMean, baselineStd }) {
  const field = FIELD[propFamily];
  const vals = (games || [])
    .map(g => g[field])
    .filter(v => v != null && !Number.isNaN(v));

  const n = vals.length;
  const out = {
    meetings: n,
    vsOppMean: null,
    baselineMean: baselineMean ?? null,
    nudge: 0,
    reason: '',
  };

  if (n < MIN_MEETINGS) {
    out.reason = `insufficient sample (${n}<${MIN_MEETINGS}) — no signal`;
    return out;
  }
  if (!baselineStd || baselineStd <= 0) {
    out.reason = 'no baseline std — no signal';
    return out;
  }

  const vsOppMean = vals.reduce((a, b) => a + b, 0) / n;
  out.vsOppMean = +vsOppMean.toFixed(1);

  // z of the vs-opponent mean relative to the player's own baseline
  const rawZ = (vsOppMean - baselineMean) / baselineStd;

  // shrink toward zero by sample size (empirical-Bayes style):
  // weight = n / (n + k). k=6 => even 6 meetings only get 50% of the raw signal.
  const k = 6;
  const shrink = n / (n + k);
  let nudge = rawZ * shrink * 0.4; // 0.4 = global low-weight factor for this feature

  // hard cap
  nudge = Math.max(-MAX_ABS_NUDGE, Math.min(MAX_ABS_NUDGE, nudge));
  out.nudge = +nudge.toFixed(4);
  out.reason = `${n} meetings, vsOpp ${out.vsOppMean} vs baseline ${baselineMean?.toFixed?.(1)}, shrunk+capped`;
  return out;
}

export { MIN_MEETINGS, MAX_ABS_NUDGE };
