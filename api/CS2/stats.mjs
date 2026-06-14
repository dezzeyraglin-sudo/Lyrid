// lib/cs2/stats.mjs
// Small, dependency-free stats helpers. House style for Lyrid: every rate
// reported with n= and a Wilson score interval so small samples can't lie.

/**
 * Wilson score interval for a binomial proportion.
 * Returns { p, lo, hi, n } where p is the point estimate and [lo, hi] the CI.
 * z = 1.96 -> 95%, z = 1.2816 -> 80% (matches the lo80% you cite on F5 tiers).
 */
export function wilson(successes, n, z = 1.96) {
  if (n <= 0) return { p: 0, lo: 0, hi: 0, n: 0 };
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return {
    p: phat,
    lo: Math.max(0, center - margin),
    hi: Math.min(1, center + margin),
    n,
  };
}

export function mean(xs) {
  if (!xs.length) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). Pass sample=false for population sd. */
export function std(xs, sample = true) {
  const n = xs.length;
  if (n < 2) return n === 0 ? NaN : 0;
  const m = mean(xs);
  const ss = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (sample ? n - 1 : n));
}

/** Coefficient of variation (sd / mean). The variance-compression metric. */
export function cv(xs) {
  const m = mean(xs);
  if (!m) return NaN;
  return std(xs) / m;
}

/** Pearson correlation between two equal-length arrays. */
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

export function mae(pairs) {
  // pairs: [[pred, actual], ...]
  if (!pairs.length) return NaN;
  return mean(pairs.map(([p, a]) => Math.abs(p - a)));
}

export function bias(pairs) {
  // mean signed error (pred - actual). Positive = projection runs high.
  if (!pairs.length) return NaN;
  return mean(pairs.map(([p, a]) => p - a));
}

export const round1 = (x) => Math.round(x * 10) / 10;
export const round2 = (x) => Math.round(x * 100) / 100;
export const pct = (x) => `${(x * 100).toFixed(1)}%`;
