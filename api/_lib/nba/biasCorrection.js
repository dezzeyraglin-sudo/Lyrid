// api/_lib/nba/biasCorrection.js
//
// Per-(player, market) rolling projection-bias correction from GRADED history
// (your periodic uploads). Catches chronic over/under-projection the base model
// misses. Shrunk toward zero by sample size and capped. Returns a points/units
// bias to shift the projection (equivalently, the line) before computing P(clear).

const CFG = { shrinkK: 6, cap: 4.0, maxGames: 15 };

// gradedHistory: array of graded picks { player, market, projected, actual }.
// Returns { bias, n } where bias = mean(actual - projected), shrunk and capped.
export function biasCorrection(player, market, gradedHistory, cfg = CFG) {
  const rows = (gradedHistory || [])
    .filter((h) => h && h.player === player && h.market === market && h.projected != null && h.actual != null)
    .slice(0, cfg.maxGames);
  const n = rows.length;
  if (!n) return { bias: 0, n: 0 };
  const rawMean = rows.reduce((s, h) => s + (h.actual - h.projected), 0) / n;
  const shrunk = rawMean * (n / (n + cfg.shrinkK));   // toward zero on small n
  const bias = Math.max(-cfg.cap, Math.min(cfg.cap, shrunk));
  return { bias: +bias.toFixed(2), n };
}

export default { biasCorrection };
