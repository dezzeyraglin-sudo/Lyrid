// api/_lib/wnba/wnbaPropSignal.js
//
// WNBA PLAYER-PROP "COLD FORM" UNDER SIGNAL — TIERED (Bronze / Gold / Platinum).
//
// Ships tiered (owner call — 3yr live WNBA betting: players routinely underperform
// their lines). Tiers are PROXY-GROUNDED (vs the player's own rolling avg) and confirm
// against real book lines as live picks grade. Auto-grades live.
//
// ── BASE BACKTEST (2022–2026, 13,245 clean player-games, min≥10) ──
//   UNDER = next game lands below the player's 10-game rolling avg (the proxy line).
//   POINTS    signal ≤ -4 : 59.1%  (n=785)
//   REBOUNDS  signal ≤ -2 : 63.6%  (n=546)
//   ASSISTS   signal ≤ -2 : 71.4%  (n=133)   ← already meets the 70% bar, robustly
//   PRA       signal ≤ -4 : 59.2%  (n=1411)  (fallback when reb/ast props absent)
//
// ── SHARPENING (data-mined to hit the owner's 70% threshold) ──
//   The lever that works is VOLATILITY + ROLE/MINUTES, and only for assists & rebounds.
//   Points/PRA do NOT reach 70% under any tested filter — they're high-volume and
//   tightly priced; shown at Bronze, honestly labeled "below 70%".
//
//   REBOUNDS sharpened: signal ≤ -2 AND last-2-games-both-cold AND minutes dropping
//     (recent-3 min avg ≥ 4 below 10-game min avg) → 71.6% (n=169, W95[64,78],
//     thirds 79/66/70). A shrinking role + cold form genuinely stays under. → PLATINUM.
//   ASSISTS: base 71.4% already clears 70% robustly (W95 lower 63%, n=133). Tighter
//     vol filters look higher (87% at sd<2.5) but collapse to n=8 — small-sample trap,
//     NOT used. Assists ships at its robust base. → PLATINUM.
//
// The OVER side MEAN-REVERTS (~47%) and is NOT shipped.
//
// TIER BANDS by effective WR:  < 62% BRONZE · 62–70% GOLD · 70%+ PLATINUM
// The owner's bar is 70% (Platinum). Only assists (always) and sharpened rebounds reach it.

const LONG = 10;     // baseline window (proxy line)
const SHORT = 3;     // recent-form window
const MIN_HIST = 8;
const MIN_DROP_CUT = -4;   // recent-3 minutes avg this far below 10-game avg = role shrinking

const UNDER_THRESHOLD = { points: -4, rebounds: -2, assists: -2, pra: -4 };

// Base WR + n at entry threshold (tier-band floor).
const BACKTEST = {
  points:   { wr: 59.1, n: 785 },
  rebounds: { wr: 63.6, n: 546 },
  assists:  { wr: 71.4, n: 133 },
  pra:      { wr: 59.2, n: 1411 },
};

// Rebounds-only sharpening: cold-streak + collapsing minutes promotes to Platinum.
const REBOUNDS_SHARP = { wr: 71.6, n: 169 };

const THRESHOLD_BAR = 70;   // owner's hit-rate bar

function tierForWR(wr) {
  if (wr >= 70) return 'PLATINUM';
  if (wr >= 62) return 'GOLD';
  return 'BRONZE';
}

/**
 * Evaluate the cold-form UNDER signal for one player+market, with sharpening.
 * @param {Array<number>} priorValues - prior-game stat values for this market,
 *        oldest→newest, EXCLUDING the game being predicted (no leakage).
 * @param {string} market - 'points' | 'rebounds' | 'assists' | 'pra'
 * @param {Array<number>} [priorMinutes] - matching prior-game minutes, oldest→newest,
 *        same length/order as priorValues. Enables the rebounds minutes-drop sharpening.
 * @returns {Object|null}
 */
export function evaluatePropSignal(priorValues, market, priorMinutes) {
  const thr = UNDER_THRESHOLD[market];
  if (thr == null) return null;
  const vals = (priorValues || []).filter(v => v != null && Number.isFinite(v));
  if (vals.length < MIN_HIST) return null;

  const baseline = avgLast(vals, LONG);
  const recent = avgLast(vals, SHORT);
  const signal = recent - baseline;
  if (signal > thr) return null;  // not cold enough

  let wr = BACKTEST[market].wr;
  let n = BACKTEST[market].n;
  let sharpened = false;

  // REBOUNDS sharpening: last-2-both-cold AND minutes collapsing → Platinum band.
  if (market === 'rebounds') {
    const last2 = vals.slice(-2);
    const bothCold = last2.length === 2 && last2.every(v => v < baseline);
    let minDrop = null;
    if (Array.isArray(priorMinutes) && priorMinutes.length === (priorValues || []).length) {
      const mins = priorMinutes.filter(m => m != null && Number.isFinite(m));
      if (mins.length >= MIN_HIST) {
        minDrop = avgLast(mins, SHORT) - avgLast(mins, LONG);
      }
    }
    if (bothCold && minDrop != null && minDrop <= MIN_DROP_CUT) {
      wr = REBOUNDS_SHARP.wr; n = REBOUNDS_SHARP.n; sharpened = true;
    }
  }

  const tier = tierForWR(wr);
  return {
    market,
    side: 'UNDER',
    tier,
    signal: round1(signal),
    baseline: round1(baseline),   // proxy line
    recent: round1(recent),
    backtestWR: round1(wr),
    backtestN: n,
    sharpened,                    // rebounds minutes-drop promotion applied
    meetsThreshold: wr >= THRESHOLD_BAR,   // true = clears the owner's 70% bar
    proxy: true,
    note: 'Cold-form UNDER. Tier from rolling-avg backtest (proxy); confirming vs real book lines as live picks grade.',
  };
}

function avgLast(arr, n) { const s = arr.slice(-n); return s.reduce((a, b) => a + b, 0) / s.length; }
function round1(x) { return Math.round(x * 10) / 10; }

export { UNDER_THRESHOLD, BACKTEST, REBOUNDS_SHARP, tierForWR, THRESHOLD_BAR };
