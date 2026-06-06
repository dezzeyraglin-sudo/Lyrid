// api/_lib/wnba/wnbaPropSignal.js
//
// WNBA PLAYER-PROP "COLD FORM" UNDER SIGNAL — TIERED (Bronze / Gold / Platinum).
//
// Ships as a tiered system per the owner's call (3 years of live WNBA betting shows
// players routinely underperform their lines). Tiers are PROXY-GROUNDED and confirming
// against real book lines going forward — see proxy stamp below. Auto-grades live.
//
// Backtest (2022–2026, 13,245 clean player-games, min≥10), UNDER = next game lands
// below the player's 10-game rolling average (the proxy line):
//   POINTS    signal ≤ -4 : 60.0%  (n=785)    deeper cold = FLAT (no bump)
//   REBOUNDS  signal ≤ -2 : 64.8%  (n=546)  · ≤ -3 : 68.0% (n=128)  → bump real
//   ASSISTS   signal ≤ -2 : 74.4%  (n=133)    deeper cold = noise (no bump)
//   PRA       signal ≤ -4 : 59.2%  (n=1411) · ≤ -6 : 61.1% · ≤ -8 : 65.7%  → bump real
//   (PRA is the fallback when standalone reb/ast props aren't offered.)
//
// The OVER side MEAN-REVERTS (~47%, worse than a coin flip) and is NOT shipped.
//
// TIER MAPPING: WR band sets the floor, magnitude bumps it up ONLY where the data
// supports it (rebounds, PRA). Points and assists do NOT bump — deeper cold there is
// flat or noise, so bumping would invent precision that isn't real.
//   WR bands:  < 62% → BRONZE   ·   62–70% → GOLD   ·   70%+ → PLATINUM
//
// PROXY STAMP: the backtest line is the player's OWN rolling average, not a sportsbook
// line. Real-line validation accrues as live picks grade against actual book lines.
// Consumers should surface `proxy: true` (the tooltip notes "confirming vs real lines").

const LONG = 10;     // baseline window (proxy line)
const SHORT = 3;     // recent-form window
const MIN_HIST = 8;

// Minimum cold-signal threshold to fire at all, per market.
const UNDER_THRESHOLD = { points: -4, rebounds: -2, assists: -2, pra: -4 };

// Base backtest WR + n at the entry threshold (sets the tier-band FLOOR).
const BACKTEST = {
  points:   { wr: 60.0, n: 785 },
  rebounds: { wr: 64.8, n: 546 },
  assists:  { wr: 74.4, n: 133 },
  pra:      { wr: 59.2, n: 1411 },
};

// Magnitude bumps: where deeper cold genuinely raises the hit rate, a deeper signal
// upgrades the effective WR (and thus the tier). Only markets with a REAL gradient
// are listed; points/assists are intentionally absent (no real bump).
//   Each entry: signal ≤ `at` raises the effective WR to `wr` (n = sample at that depth).
const MAGNITUDE_BUMPS = {
  rebounds: [{ at: -3, wr: 68.0, n: 128 }],
  pra:      [{ at: -6, wr: 61.1, n: 506 }, { at: -8, wr: 65.7, n: 140 }],
};

// WR → tier band.
function tierForWR(wr) {
  if (wr >= 70) return 'PLATINUM';
  if (wr >= 62) return 'GOLD';
  return 'BRONZE';
}

/**
 * Evaluate the cold-form UNDER signal for one player+market, returning a tier.
 * @param {Array<number>} priorValues - the player's prior-game values for this market,
 *        oldest→newest, EXCLUDING the game being predicted (no leakage).
 * @param {string} market - 'points' | 'rebounds' | 'assists' | 'pra'
 * @returns {Object|null} tiered signal, or null if no qualifying UNDER signal.
 */
export function evaluatePropSignal(priorValues, market) {
  const thr = UNDER_THRESHOLD[market];
  if (thr == null) return null;
  const vals = (priorValues || []).filter(v => v != null && Number.isFinite(v));
  if (vals.length < MIN_HIST) return null;

  const baseline = avgLast(vals, LONG);
  const recent = avgLast(vals, SHORT);
  const signal = recent - baseline;
  if (signal > thr) return null;  // not cold enough to fire

  // Start at the base WR for this market, then apply the deepest magnitude bump
  // whose threshold the signal clears (bumps are ordered shallow→deep).
  const base = BACKTEST[market];
  let wr = base.wr, n = base.n, bumped = false;
  for (const b of (MAGNITUDE_BUMPS[market] || [])) {
    if (signal <= b.at) { wr = b.wr; n = b.n; bumped = true; }
  }

  return {
    market,
    side: 'UNDER',
    tier: tierForWR(wr),
    signal: round1(signal),
    baseline: round1(baseline),   // the proxy line
    recent: round1(recent),
    backtestWR: round1(wr),
    backtestN: n,
    bumped,                       // true if a magnitude bump lifted the tier
    proxy: true,                  // <-- proxy-grounded; confirming vs real lines live
    note: 'Cold-form UNDER. Tier from rolling-avg backtest (proxy); confirming vs real book lines as live picks grade.',
  };
}

function avgLast(arr, n) { const s = arr.slice(-n); return s.reduce((a, b) => a + b, 0) / s.length; }
function round1(x) { return Math.round(x * 10) / 10; }

export { UNDER_THRESHOLD, BACKTEST, MAGNITUDE_BUMPS, tierForWR };
