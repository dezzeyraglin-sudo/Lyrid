// api/_lib/nba/comboEngine.js
//
// Combo projections (P+R, P+A, R+A, PRA). A combo is the SUM of its components, so
// its distribution is the convolution of the component PMFs. Crucially we convolve
// PER MINUTES DRAW and then mix over the minutes distribution — so the components
// stay correlated through their shared minutes (the dominant correlation), instead
// of the naive independent-sum that understates combo risk.
//
// Residual same-game correlation (a hot night lifts all three) is NOT modeled, so
// thin combo gaps are flagged and combos carry a slightly higher min edge. Shadow;
// all constants TUNE.

import NBA, { CONFIGS } from './leagueConfig.js';

const COMBOS = {
  pra:       ['points', 'rebounds', 'assists'],
  pts_rebs:  ['points', 'rebounds'],
  pts_asts:  ['points', 'assists'],
  rebs_asts: ['rebounds', 'assists'],
};

// --- shared math (mirrors points + rebounds/assists engines) ---
function binomPMF(nRaw, pRaw) {
  const n = Math.max(0, Math.round(nRaw)); const out = new Array(n + 1).fill(0);
  if (n === 0) { out[0] = 1; return out; }
  const p = Math.min(1, Math.max(0, pRaw));
  if (p === 0) { out[0] = 1; return out; } if (p === 1) { out[n] = 1; return out; }
  let pk = Math.pow(1 - p, n); out[0] = pk; const r = p / (1 - p);
  for (let k = 1; k <= n; k++) { pk = pk * ((n - k + 1) / k) * r; out[k] = pk; } return out;
}
function scaleToPoints(binom, mult) {
  const arr = new Array((binom.length - 1) * mult + 1).fill(0);
  for (let k = 0; k < binom.length; k++) arr[k * mult] += binom[k]; return arr;
}
function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) { if (!a[i]) continue; for (let j = 0; j < b.length; j++) if (b[j]) out[i + j] += a[i] * b[j]; }
  return out;
}
function negbinPMF(mu, k, maxN) {
  const out = new Array(maxN + 1).fill(0);
  if (mu <= 0) { out[0] = 1; return out; }
  out[0] = Math.pow(k / (k + mu), k);
  for (let x = 1; x <= maxN; x++) out[x] = out[x - 1] * ((x + k - 1) / x) * (mu / (mu + k));
  return out;
}
function invNorm(p) {
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pl=0.02425,ph=1-pl; let q,r;
  if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if(p>ph){q=Math.sqrt(-2*Math.log(1-p));return-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
function minutesScenarios(mean, cv, n, floor, cap) {
  const sd = Math.max(0, mean * cv), nodes = [];
  for (let i = 0; i < n; i++) { const qz = (i + 0.5) / n; nodes.push({ m: Math.max(floor, Math.min(cap, mean + invNorm(qz) * sd)), w: 1 / n }); }
  return nodes;
}
function pointsPMFAtMinutes(pr, m) {
  const two = scaleToPoints(binomPMF(pr.twoPaPerMin * m, pr.twoPct), 2);
  const three = scaleToPoints(binomPMF(pr.threePaPerMin * m, pr.threePct), 3);
  const ft = scaleToPoints(binomPMF(pr.ftaPerMin * m, pr.ftPct), 1);
  return convolve(convolve(two, three), ft);
}
function componentPMF(comp, pr, m, cfg) {
  if (comp === 'points') return pointsPMFAtMinutes(pr, m);
  const rate = comp === 'rebounds' ? pr.rebPerMin : pr.astPerMin;
  const k = cfg.markets[comp].k;
  const maxN = Math.max(8, Math.ceil(rate * cfg.minutes.cap * 2.5));
  return negbinPMF(rate * m, k, maxN);
}
function addScaled(acc, pmf, w) {
  if (acc.length < pmf.length) acc = acc.concat(new Array(pmf.length - acc.length).fill(0));
  for (let i = 0; i < pmf.length; i++) acc[i] += pmf[i] * w; return acc;
}
function calibrateOver(pRaw, cfg) {
  const c = cfg.calibration; if (pRaw <= 0.5) return { p: pRaw, faded: false };
  const w = pRaw >= c.fadeOverThreshold ? c.fadeOverWeight : c.mildOverWeight;
  return { p: 0.5 + (pRaw - 0.5) * w, faded: pRaw >= c.fadeOverThreshold };
}

export function analyzeCombo(input, market, league = 'NBA') {
  const cfg = CONFIGS[league] || NBA;
  const comps = COMBOS[market];
  if (!comps) return { ok: false, reason: `unknown combo ${market}` };
  const pr = input.shotProfile || input.profile;
  const line = input.line?.line ?? input.line;
  if (!pr || pr.insufficient || line == null) return { ok: false, reason: 'insufficient profile or missing line', posture: cfg.posture };
  // components must have their rates present
  if (comps.includes('rebounds') && pr.rebPerMin == null) return { ok: false, reason: 'no rebound rate' };
  if (comps.includes('assists') && pr.astPerMin == null) return { ok: false, reason: 'no assist rate' };

  const roleUncertain = input.flags?.roleUncertain ?? input.roleUncertain ?? false;
  const projMinutes = input.projMinutes ?? input.form?.minL5 ?? pr.minutes.mean;
  let cv = input.minutesCV ?? pr.minutes.cv ?? 0.15;
  if (input.minutesCV == null && roleUncertain) cv *= cfg.minutes.teamChangeCVMult;

  const scen = minutesScenarios(projMinutes, cv, cfg.minutes.scenarioNodes, cfg.minutes.floor, cfg.minutes.cap);
  let mix = [];
  for (const { m, w } of scen) {
    let combo = null;
    for (const c of comps) { const pmf = componentPMF(c, pr, m, cfg); combo = combo === null ? pmf : convolve(combo, pmf); }
    mix = addScaled(mix, combo, w);
  }

  let total = 0, mean = 0; for (let i = 0; i < mix.length; i++) { total += mix[i]; mean += i * mix[i]; }
  mean /= total || 1;
  const pct = (qq) => { let cc = 0; for (let i = 0; i < mix.length; i++) { cc += mix[i] / total; if (cc >= qq) return i; } return mix.length - 1; };
  const ceiling = pct(cfg.dist.ceilingPctile), floor = pct(cfg.dist.floorPctile);
  let over = 0; const thr = Math.ceil(line); for (let i = thr; i < mix.length; i++) over += mix[i];
  const pOverRaw = over / (total || 1);
  const cal = calibrateOver(pOverRaw, cfg); const pOver = cal.p, pUnder = 1 - pOver;
  const lineAboveCeiling = cfg.lineAboveCeiling.enabled && line > ceiling;
  const thinComboGap = Math.abs(line - mean) < (cfg.combo?.thinGap ?? 1.5);

  let recSide = pUnder >= pOver ? 'under' : 'over', recProb = Math.max(pOver, pUnder);
  if (lineAboveCeiling) { recSide = 'under'; recProb = Math.max(recProb, pUnder); }
  const edge = Math.abs(recProb - 0.5);
  const minEdge = cfg.combo?.minEdge ?? 0.07;
  const lean = (edge < minEdge || thinComboGap) ? 'pass' : recSide; // thin combo gap -> pass (correlation risk)

  return {
    ok: true, posture: cfg.posture, market, line,
    components: comps, projMinutes: +projMinutes.toFixed(1), minutesCV: +cv.toFixed(3),
    distribution: { mean: +mean.toFixed(1), median: pct(0.5), floor, ceiling },
    pOverRaw: +pOverRaw.toFixed(3), pOver: +pOver.toFixed(3), pUnder: +pUnder.toFixed(3), edge: +edge.toFixed(3),
    flags: { lineAboveCeiling, confidentOverFaded: cal.faded, roleUncertain, thinComboGap, comboIndependenceApprox: true },
    recommendation: { lean, side: recSide, prob: +recProb.toFixed(3) },
    notes: ['shadow — grade before trusting', 'combo = convolution over shared minutes; residual same-game correlation not modeled', 'thin gaps auto-pass until graded'],
  };
}

export default { analyzeCombo };
