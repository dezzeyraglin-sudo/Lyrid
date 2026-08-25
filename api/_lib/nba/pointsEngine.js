// api/_lib/nba/pointsEngine.js
//
// Shots-to-clear points engine. League-agnostic: reads constants from leagueConfig.
// Output is a PROBABILITY, not a number — the audit's central lesson: ~1/3 of the
// error is irreducible shooting variance you can only price, so we build the full
// points distribution and read P(clear) off it.
//
//   minutes -> shot volume (attempts = per-min rate x minutes)
//           -> makes (Binomial per shot type)
//           -> points = 2*made2 + 3*made3 + 1*madeFT   (convolved PMFs)
//           -> integrate over minutes uncertainty       (minutes is the master var)
//           -> P(clear line), floor/median/ceiling
//           -> disciplines: fade-confident-over, line-above-ceiling, team-change widen
//
// Not yet wired (clean hooks left): the dedicated minutes model (feeds `projMinutes`),
// adaptive shrinkage of season vs recent rates, and per-player rolling bias correction
// (needs the grading harness). All start in shadow.

import NBA, { CONFIGS } from './leagueConfig.js';

// ---------- math helpers ----------
function binomPMF(nRaw, pRaw) {
  const n = Math.max(0, Math.round(nRaw));
  const out = new Array(n + 1).fill(0);
  if (n === 0) { out[0] = 1; return out; }
  const p = Math.min(1, Math.max(0, pRaw));
  if (p === 0) { out[0] = 1; return out; }
  if (p === 1) { out[n] = 1; return out; }
  let pk = Math.pow(1 - p, n);
  out[0] = pk;
  const r = p / (1 - p);
  for (let k = 1; k <= n; k++) { pk = pk * ((n - k + 1) / k) * r; out[k] = pk; }
  return out;
}

// place a made-count PMF onto a POINTS axis (each make worth `mult` points)
function scaleToPoints(binom, mult) {
  const arr = new Array((binom.length - 1) * mult + 1).fill(0);
  for (let k = 0; k < binom.length; k++) arr[k * mult] += binom[k];
  return arr;
}

function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) { if (b[j]) out[i + j] += a[i] * b[j]; }
  }
  return out;
}

// Acklam inverse normal CDF (for minutes strata)
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > ph) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function minutesScenarios(mean, cv, n, floor, cap) {
  const sd = Math.max(0, mean * cv);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const q = (i + 0.5) / n;              // equal-probability strata midpoints
    let m = mean + invNorm(q) * sd;
    m = Math.max(floor, Math.min(cap, m));
    nodes.push({ m, w: 1 / n });
  }
  return nodes;
}

// points PMF at a fixed minutes value
function pointsPMFAtMinutes(profile, minutes) {
  const two = scaleToPoints(binomPMF(profile.twoPaPerMin * minutes, profile.twoPct), 2);
  const three = scaleToPoints(binomPMF(profile.threePaPerMin * minutes, profile.threePct), 3);
  const ft = scaleToPoints(binomPMF(profile.ftaPerMin * minutes, profile.ftPct), 1);
  return convolve(convolve(two, three), ft);
}

function addScaled(acc, pmf, w) {
  if (acc.length < pmf.length) acc = acc.concat(new Array(pmf.length - acc.length).fill(0));
  for (let i = 0; i < pmf.length; i++) acc[i] += pmf[i] * w;
  return acc;
}

function pmfStats(pmf, cfg) {
  let total = 0, mean = 0;
  for (let i = 0; i < pmf.length; i++) { total += pmf[i]; mean += i * pmf[i]; }
  mean /= total || 1;
  const pctile = (q) => { let c = 0; for (let i = 0; i < pmf.length; i++) { c += pmf[i] / total; if (c >= q) return i; } return pmf.length - 1; };
  return {
    mean,
    median: pctile(0.5),
    floor: pctile(cfg.dist.floorPctile),
    ceiling: pctile(cfg.dist.ceilingPctile),
    pOver: (line) => { let c = 0; const thr = Math.ceil(line); for (let i = thr; i < pmf.length; i++) c += pmf[i]; return c / (total || 1); },
  };
}

// fade-the-confident-over calibration (under side kept)
function calibrateOver(pRaw, cfg) {
  const c = cfg.calibration;
  if (pRaw <= 0.5) return { p: pRaw, faded: false };
  const w = pRaw >= c.fadeOverThreshold ? c.fadeOverWeight : c.mildOverWeight;
  return { p: 0.5 + (pRaw - 0.5) * w, faded: pRaw >= c.fadeOverThreshold };
}

// ---------- public ----------
// input: the merged player object from normalizeMerge (uses .shotProfile, .line,
// .form, .flags), or a lightweight { profile, line, projMinutes, roleUncertain }.
export function analyzePoints(input, league = 'NBA') {
  const cfg = CONFIGS[league] || NBA;
  const profile = input.shotProfile || input.profile;
  const line = input.line?.line ?? input.line;
  const side = input.line?.side ?? input.side ?? null;

  if (!profile || profile.insufficient || line == null) {
    return { ok: false, reason: 'insufficient shot profile or missing line', posture: cfg.posture };
  }

  const roleUncertain = input.flags?.roleUncertain ?? input.roleUncertain ?? false;
  const projMinutes = input.projMinutes ?? input.form?.minL5 ?? profile.minutes.mean;
  // prefer the minutes model's cv (it already handles role-change widening);
  // fall back to the profile cv + a widen only when the model didn't supply one.
  let cv = input.minutesCV ?? profile.minutes.cv ?? 0.15;
  if (input.minutesCV == null && roleUncertain) cv *= cfg.minutes.teamChangeCVMult;

  // integrate points distribution over minutes uncertainty
  const scen = minutesScenarios(projMinutes, cv, cfg.minutes.scenarioNodes, cfg.minutes.floor, cfg.minutes.cap);
  let mix = [];
  for (const { m, w } of scen) mix = addScaled(mix, pointsPMFAtMinutes(profile, m), w);

  const s = pmfStats(mix, cfg);
  const pOverRaw = s.pOver(line);
  const pUnderRaw = 1 - pOverRaw;

  const cal = calibrateOver(pOverRaw, cfg);
  const pOver = cal.p;
  const pUnder = 1 - pOver;

  const lineAboveCeiling = cfg.lineAboveCeiling.enabled && line > s.ceiling;

  // recommendation (shadow posture: probabilities + provisional bucket, no tiers)
  let recSide = pUnder >= pOver ? 'under' : 'over';
  let recProb = Math.max(pOver, pUnder);
  if (lineAboveCeiling) { recSide = 'under'; recProb = Math.max(recProb, pUnder); }
  const edge = Math.abs(recProb - 0.5);
  const lean = edge < cfg.edge.minEdge ? 'pass' : recSide;

  return {
    ok: true,
    posture: cfg.posture,           // 'shadow' — do not treat as a graded tier yet
    market: 'points',
    line, requestedSide: side,
    projMinutes: +projMinutes.toFixed(1),
    minutesCV: +cv.toFixed(3),
    distribution: {
      mean: +s.mean.toFixed(1), median: s.median,
      floor: s.floor, ceiling: s.ceiling,   // p15 / p85
    },
    pOverRaw: +pOverRaw.toFixed(3), pUnderRaw: +pUnderRaw.toFixed(3),
    pOver: +pOver.toFixed(3), pUnder: +pUnder.toFixed(3),
    edge: +edge.toFixed(3),
    flags: {
      lineAboveCeiling,
      confidentOverFaded: cal.faded,
      roleUncertain,
    },
    recommendation: { lean, side: recSide, prob: +recProb.toFixed(3) },
    notes: [
      'shadow mode — grade before trusting',
      'calibration + minutes widening are WNBA-derived placeholders (TUNE on NBA data)',
      'projMinutes is recent-mean until the minutes model plugs in',
    ],
  };
}

export default { analyzePoints };
