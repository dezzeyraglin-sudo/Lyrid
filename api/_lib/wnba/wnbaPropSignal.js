// api/_lib/wnba/wnbaPropSignal.js
//
// WNBA PLAYER-PROP "COLD FORM" UNDER SIGNAL — PROXY, NOT A BOOK-LINE EDGE.
//
// ⚠️ READ THIS BEFORE TRUSTING IT ⚠️
// Backtest (2022–2026, 13,245 clean player-games, min≥10) found:
//   • The OVER side MEAN-REVERTS — hot recent form does NOT continue. Do not bet overs
//     off hot streaks; the data shows ~47% (worse than a coin flip). NOT shipped.
//   • The UNDER side shows signal: when a player's recent 3-game form is well BELOW
//     their 10-game baseline, the next game tends to stay under that baseline:
//       PTS  signal ≤ -4 : 60.0%  (n=785, thirds 59/59/62)
//       REB  signal ≤ -2 : 64.8%  (n=546, thirds 63/66/65)
//       AST  signal ≤ -2 : 74.4%  (n=133, thirds 68/80/76)
//
// CRITICAL CAVEAT: the "line" in this backtest is the player's OWN 10-game rolling
// average — NOT a sportsbook line. Books already lower a slumping player's line, so
// the real edge vs a DraftKings/FanDuel prop line is likely MUCH smaller, maybe gone.
// This is a MEAN-REVERSION SIGNAL, not a validated betting edge. It is shown to inform
// analysis, explicitly labeled "proxy / unproven." Real validation requires logging
// vs real lines going forward (now possible on GOAT) and grading actual results.
// Do NOT tier this Bronze/Gold/Platinum — that styling implies a proven edge.

const LONG = 10;   // baseline window (proxy line)
const SHORT = 3;   // recent-form window
const MIN_HIST = 8;

// Shipped UNDER thresholds (signal = recentAvg − baselineAvg, must be ≤ threshold).
const UNDER_THRESHOLD = { points: -4, rebounds: -2, assists: -2 };
const BACKTEST = {
  points:   { wr: 60.0, n: 785 },
  rebounds: { wr: 64.8, n: 546 },
  assists:  { wr: 74.4, n: 133 },
};

/**
 * Evaluate the cold-form UNDER signal for one player+market.
 * @param {Array<number>} priorValues - the player's prior-game values for this
 *        market, oldest→newest, EXCLUDING the game being predicted (no leakage).
 * @param {string} market - 'points' | 'rebounds' | 'assists'
 * @returns {Object|null} signal info, or null if no qualifying UNDER signal.
 */
export function evaluatePropSignal(priorValues, market) {
  const thr = UNDER_THRESHOLD[market];
  if (thr == null) return null;
  const vals = (priorValues || []).filter(v => v != null && Number.isFinite(v));
  if (vals.length < MIN_HIST) return null;

  const baseline = avgLast(vals, LONG);
  const recent = avgLast(vals, SHORT);
  const signal = recent - baseline;

  if (signal > thr) return null;  // not cold enough

  const bt = BACKTEST[market];
  return {
    market,
    side: 'UNDER',
    signal: round1(signal),
    baseline: round1(baseline),   // the proxy line
    recent: round1(recent),
    backtestWR: bt.wr,
    backtestN: bt.n,
    proxy: true,                  // <-- consumers MUST surface this as unproven
    note: 'Cold-form UNDER vs player rolling avg (proxy line). Not validated vs book lines.',
  };
}

function avgLast(arr, n) {
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function round1(x) { return Math.round(x * 10) / 10; }

export { UNDER_THRESHOLD, BACKTEST };
