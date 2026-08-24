// api/_lib/nba/reboundsAssistsEngine.js
//
// Counting-stat engine for rebounds and assists. Same distributional philosophy
// as the points engine — output a probability, not a number — but the count is
// modeled as minutes x per-minute rate under a NEGATIVE BINOMIAL, whose dispersion
// `k` is market-specific (rebounds sticky -> high k; assists noisy -> low k, the
// audit's finding). Minutes uncertainty is integrated the same way.
//
// Disciplines carried: fade-the-confident-over, line-above-ceiling -> under,
// team-change variance widening. Shadow posture; all constants TUNE.

import NBA, { CONFIGS } from './leagueConfig.js';

// negative-binomial PMF with mean mu and dispersion size k (variance = mu + mu^2/k).
// recurrence works for real k. k -> infinity approaches Poisson.
function negbinPMF(mu, k, maxN) {
  const out = new Array(maxN + 1).fill(0);
  if (mu <= 0) { out[0] = 1; return out; }
  const p0 = Math.pow(k / (k + mu), k);
  out[0] = p0;
  for (let x = 1; x <= maxN; x++) out[x] = out[x - 1] * ((x + k - 1) / x) * (mu / (mu + k));
  return out;
}

// Acklam inverse normal (for minutes strata)
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > ph) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function minutesScenarios(mean, cv, n, floor, cap) {
  const sd = Math.max(0, mean * cv), nodes = [];
  for (let i = 0; i < n; i++) {
    const qz = (i + 0.5) / n;
    nodes.push({ m: Math.max(floor, Math.min(cap, mean + invNorm(qz) * sd)), w: 1 / n });
  }
  return nodes;
}

function calibrateOver(pRaw, cfg) {
  const c = cfg.calibration;
  if (pRaw <= 0.5) return { p: pRaw, faded: false };
  const w = pRaw >= c.fadeOverThreshold ? c.fadeOverWeight : c.mildOverWeight;
  return { p: 0.5 + (pRaw - 0.5) * w, faded: pRaw >= c.fadeOverThreshold };
}

// input: merged player object (uses .shotProfile.rebPerMin/astPerMin, .line, .flags,
// .projMinutes, .minutesCV) or a light { profile, line, projMinutes, minutesCV }.
export function analyzeCounting(input, market, league = 'NBA') {
  const cfg = CONFIGS[league] || NBA;
  const mk = cfg.markets?.[market];
  if (!mk) return { ok: false, reason: `no config for market ${market}` };

  const profile = input.shotProfile || input.profile;
  const line = input.line?.line ?? input.line;
  const rate = market === 'rebounds' ? profile?.rebPerMin : profile?.astPerMin;
  if (rate == null || line == null || profile?.insufficient) {
    return { ok: false, reason: 'insufficient rate profile or missing line', posture: cfg.posture };
  }

  const roleUncertain = input.flags?.roleUncertain ?? input.roleUncertain ?? false;
  const projMinutes = input.projMinutes ?? input.form?.minL5 ?? profile.minutes.mean;
  let cv = input.minutesCV ?? profile.minutes.cv ?? 0.15;
  if (input.minutesCV == null && roleUncertain) cv *= cfg.minutes.teamChangeCVMult;

  const scen = minutesScenarios(projMinutes, cv, cfg.minutes.scenarioNodes, cfg.minutes.floor, cfg.minutes.cap);
  const maxN = Math.max(10, Math.ceil(rate * cfg.minutes.cap * 2.5));
  let mix = new Array(maxN + 1).fill(0);
  for (const { m, w } of scen) {
    const pmf = negbinPMF(rate * m, mk.k, maxN);
    for (let i = 0; i <= maxN; i++) mix[i] += pmf[i] * w;
  }

  let total = 0, mean = 0;
  for (let i = 0; i <= maxN; i++) { total += mix[i]; mean += i * mix[i]; }
  mean /= total || 1;
  const pctile = (qq) => { let cc = 0; for (let i = 0; i <= maxN; i++) { cc += mix[i] / total; if (cc >= qq) return i; } return maxN; };
  const ceiling = pctile(cfg.dist.ceilingPctile), floor = pctile(cfg.dist.floorPctile);

  let over = 0; const thr = Math.ceil(line);
  for (let i = thr; i <= maxN; i++) over += mix[i];
  const pOverRaw = over / (total || 1);

  const cal = calibrateOver(pOverRaw, cfg);
  const pOver = cal.p, pUnder = 1 - pOver;
  const lineAboveCeiling = cfg.lineAboveCeiling.enabled && line > ceiling;

  let recSide = pUnder >= pOver ? 'under' : 'over', recProb = Math.max(pOver, pUnder);
  if (lineAboveCeiling) { recSide = 'under'; recProb = Math.max(recProb, pUnder); }
  const edge = Math.abs(recProb - 0.5);
  const lean = edge < mk.minEdge ? 'pass' : recSide;

  return {
    ok: true, posture: cfg.posture, market, line, requestedSide: input.line?.side ?? null,
    projMinutes: +projMinutes.toFixed(1), minutesCV: +cv.toFixed(3),
    distribution: { mean: +mean.toFixed(1), median: pctile(0.5), floor, ceiling },
    pOverRaw: +pOverRaw.toFixed(3), pUnderRaw: +(1 - pOverRaw).toFixed(3),
    pOver: +pOver.toFixed(3), pUnder: +pUnder.toFixed(3), edge: +edge.toFixed(3),
    flags: { lineAboveCeiling, confidentOverFaded: cal.faded, roleUncertain },
    recommendation: { lean, side: recSide, prob: +recProb.toFixed(3) },
    notes: ['shadow — grade before trusting', `dispersion k=${mk.k} is a TUNE placeholder`],
  };
}

export default { analyzeCounting };
