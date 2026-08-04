// nflCompEngine.js
// Lyrid NFL engine — the brain (Layer 6).
// kNN scenario-similarity over league-wide position-group history -> empirical CDF
// -> P(actual > line). This is how we beat the 17-game sample problem: instead of
// asking "how has THIS player done in games like this" (n~17), we ask "how has ANY
// comparable player-game in a similar scenario resolved" (n~hundreds).
//
// Pipeline:
//   1. Build the target's feature vector (volume, matchup, script, environment nudges).
//   2. Find k nearest neighbors in the same position group by weighted feature distance.
//   3. Read the empirical distribution of neighbor OUTCOMES for this prop family.
//   4. P(over) = fraction of neighbor outcomes above the line (with kernel smoothing).
//   5. line_softness = modeled median - line (positive = soft line, favor OVER).
//
// Additive-not-multiplicative: feature deviations are summed (weighted), never chained.

// ---- feature weighting (tunable; fit on backtest via standardized regression later) ----
const DEFAULT_WEIGHTS = {
  volume_floor: 1.0,       // most important — the winning-style anchor
  suppression: 0.8,
  scheme_edge: 0.6,
  game_script: 0.9,
  env_total: 0.5,
  team_proe: 0.7,
  player_vs_opp: 0.3,      // deliberately low (noisy)
  recent_form: 0.6,        // trailing yardage z
};

function weightedDistance(a, b, weights) {
  let sum = 0, wsum = 0, shared = 0;
  for (const k of Object.keys(weights)) {
    if (a[k] == null || b[k] == null) continue;
    const w = weights[k];
    sum += w * (a[k] - b[k]) ** 2;
    wsum += w;
    shared++;
  }
  // No overlapping features: return a large-but-FINITE distance so this neighbor
  // ranks last instead of poisoning the sort with Infinity (which made every
  // neighbor tie and collapsed the median to ~0 for players with sparse vectors).
  if (!wsum || !shared) return 1e6;
  return Math.sqrt(sum / wsum);
}

// Gaussian kernel weight for a neighbor at distance d (bandwidth h).
function kernel(d, h) { return Math.exp(-(d * d) / (2 * h * h)); }

// percentile helper on a weighted sample
function weightedFractionAbove(samples, line) {
  let above = 0, total = 0;
  for (const s of samples) { total += s.w; if (s.y > line) above += s.w; }
  return total ? above / total : 0.5;
}
function weightedMedian(samples) {
  const sorted = [...samples].sort((a, b) => a.y - b.y);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let cum = 0;
  for (const s of sorted) { cum += s.w; if (cum >= total / 2) return s.y; }
  return sorted.length ? sorted[sorted.length - 1].y : null;
}
// weighted percentile (q in 0..1) — the middle-half band for the projected range
function weightedPercentile(samples, q) {
  const sorted = [...samples].sort((a, b) => a.y - b.y);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  if (!total) return null;
  let cum = 0;
  for (const s of sorted) { cum += s.w; if (cum >= total * q) return s.y; }
  return sorted.length ? sorted[sorted.length - 1].y : null;
}

// Main entry.
// target: { position, propFamily, features: {volume_floor, suppression, ...} }
// pool:   array of historical comparable rows, each:
//         { position, features:{...}, outcome: <yards for this propFamily> }
// line:   the DFS/book line to evaluate for OVER
export function compProject({ target, pool, line, k = 60, weights = DEFAULT_WEIGHTS, bandwidth = null }) {
  const samePos = pool.filter(p => p.position === target.position && p.outcome != null);
  if (samePos.length < 20) {
    return { pOver: null, median: null, lineSoftness: null, n: samePos.length, reason: 'insufficient comp pool (<20)' };
  }

  // distances
  const scored = samePos.map(p => ({ d: weightedDistance(target.features, p.features, weights), y: p.outcome }));
  scored.sort((a, b) => a.d - b.d);
  const neighbors = scored.slice(0, Math.min(k, scored.length));

  // adaptive bandwidth = median neighbor distance (so kernel scales to local density)
  const h = bandwidth || (neighbors[Math.floor(neighbors.length / 2)].d || 1) || 1;
  const samples = neighbors.map(nb => ({ y: nb.y, w: kernel(nb.d, h) || 1e-6 }));

  const pOver = +weightedFractionAbove(samples, line).toFixed(4);
  const median = +weightedMedian(samples).toFixed(1);
  const mean = +(samples.reduce((s, x) => s + x.y * x.w, 0) / samples.reduce((s, x) => s + x.w, 0)).toFixed(1);
  const lineSoftness = +(median - line).toFixed(1); // >0 => line below median => soft for OVER
  const p25 = weightedPercentile(samples, 0.25);
  const p75 = weightedPercentile(samples, 0.75);

  return {
    pOver, median, mean, lineSoftness,
    p25: p25 != null ? +p25.toFixed(0) : null,
    p75: p75 != null ? +p75.toFixed(0) : null,
    n: neighbors.length,
    effN: +neighbors.reduce((s, nb) => s + kernel(nb.d, h), 0).toFixed(1),
    reason: 'ok',
  };
}

export { DEFAULT_WEIGHTS, weightedDistance };
