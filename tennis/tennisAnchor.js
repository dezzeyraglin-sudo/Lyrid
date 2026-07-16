// tennisAnchor.js — Elo-anchored point probabilities (Stage 1 of the research plan).
//
// PROBLEM: point-win probs derived from raw serve/return percentages are level-biased and
// gauge-degenerate, so real mismatches read like coin flips → too many 3rd sets → total games high.
//
// FIX (Kovalchik & Reid 2018; Gollub 2021): keep the SUM of serve probabilities from point data —
// the sum is what drives match LENGTH and is far less corrupted than the difference — then solve
// for the DIFFERENCE so the implied match win probability equals the surface-Elo win probability.
// Elo comes from the match graph (which bridges tiers), so it supplies the outside information the
// point aggregates structurally cannot. There is no analytic inverse; bisect.

// Standard hold-probability formula (Barnett-Clarke / O'Malley). p = point-win prob on serve.
export function holdProb(p) {
  const q = 1 - p, dp = 2 * p * q;
  if (dp >= 1) return 0.5;
  const p3 = p * p * p, p4 = p3 * p;
  return p4 + 4 * p4 * q + 10 * p4 * q * q + 20 * p3 * q * q * q * ((p * p) / (1 - dp));
}

// P(A wins a set) given each player's hold prob, A serving first. DP over game score.
export function setWinProb(hA, hB) {
  const memo = new Map();
  const rec = (a, b, aServes) => {
    if (a >= 6 && a - b >= 2) return 1;
    if (b >= 6 && b - a >= 2) return 0;
    if (a === 7) return 1;
    if (b === 7) return 0;
    if (a === 6 && b === 6) return 0.5;             // tiebreak ~ coin flip (close enough here)
    const k = a * 100 + b * 2 + (aServes ? 1 : 0);
    if (memo.has(k)) return memo.get(k);
    const pWinGame = aServes ? hA : 1 - hB;
    const v = pWinGame * rec(a + 1, b, !aServes) + (1 - pWinGame) * rec(a, b + 1, !aServes);
    memo.set(k, v); return v;
  };
  return rec(0, 0, true);
}

// P(A wins match) from set prob, independent sets (anchor only — momentum is applied later in the
// simulator and mainly redistributes 2-0 vs 2-1 without moving match win prob much).
export function matchWinProb(s, bestOf = 3) {
  if (bestOf === 5) return s ** 3 * (1 + 3 * (1 - s) + 6 * (1 - s) ** 2);
  return s * s * (1 + 2 * (1 - s));
}

const impliedWin = (pA, pB, bestOf) => matchWinProb(setWinProb(holdProb(pA), holdProb(pB)), bestOf);

/**
 * Solve for point probs whose implied match win prob matches `targetWin`, holding the serve SUM.
 * @param {number} sum   pA + pB from point data (drives match length)
 * @param {number} targetWin  Elo-derived P(A wins)
 */
export function anchorToWinProb(sum, targetWin, bestOf = 3) {
  const S = Math.min(1.60, Math.max(1.00, sum));   // sane serve-sum band
  const clampP = (x) => Math.min(0.88, Math.max(0.45, x));
  let lo = -0.30, hi = 0.30;                        // difference (pA - pB) search band
  const f = (d) => impliedWin(clampP((S + d) / 2), clampP((S - d) / 2), bestOf);
  if (f(lo) > targetWin) { const d = lo; return { pA: clampP((S + d) / 2), pB: clampP((S - d) / 2), anchored: true, clipped: true }; }
  if (f(hi) < targetWin) { const d = hi; return { pA: clampP((S + d) / 2), pB: clampP((S - d) / 2), anchored: true, clipped: true }; }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < targetWin) lo = mid; else hi = mid;
  }
  const d = (lo + hi) / 2;
  return { pA: clampP((S + d) / 2), pB: clampP((S - d) / 2), anchored: true, clipped: false };
}

export default { holdProb, setWinProb, matchWinProb, anchorToWinProb };
