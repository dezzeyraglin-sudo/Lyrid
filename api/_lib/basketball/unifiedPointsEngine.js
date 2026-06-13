// api/_lib/basketball/unifiedPointsEngine.js
//
// UNIFIED POINTS ENGINE (June 1, 2026)
//
// One engine, replacing the v1 / v2 / enhanced split. It does NOT throw away the
// tested sub-engines — it ORCHESTRATES them: role stability, usage funnel,
// possession environment, and matchup all run as before; this module blends
// their signals into a single projection with a single edge, an over/under
// probability, a confidence score, and an honest data-completeness report.
//
// SCORING CORE = BLEND of two philosophies (weights in leagueConfig.pointsBlend):
//   possessionCore: projMinutes x pace/min x usage(decimal) x 2*TS    — catches
//                   usage redistribution when a teammate sits (the injury-funnel
//                   edge). Strong, but needs TS% + usage.
//   rateCore:       realized PPG blended with recent form, scaled by the ratio
//                   of projected to season minutes — robust, but lags role change.
// Blending keeps the redistribution signal AND the robustness; when the two
// cores disagree sharply, that disagreement widens the variance band (an honest
// confidence signal rather than a hidden coin-flip).
//
// MULTIPLIER STACK (each clamped; each reports whether its inputs were REAL or
// NEUTRAL, so nothing silently pretends to have data):
//   envMult      — possession environment (pace/total/fatigue).         REAL when team/total present.
//   matchupMult  — OPPOSING DEFENSE: def rating, rim protection,         REAL (live bbref opp data).
//                  perimeter & paint suppression. This is the
//                  opponent-defense layer, first-class.
//   coverageMult — COACHING DEFENSIVE COVERAGE: drop/switch/blitz/zone/   NEUTRAL until a coverage
//                  double vs the player's archetype. First-class layer,   source or manual coach tags
//                  but bbref publishes no scheme data, so it sits at       feed it; REAL when fed.
//                  1.0 (active:false) until fed. Wired so the moment
//                  coverage data exists it moves the number.
//   whistleMult  — FTA-driven free-throw scoring.                        REAL when FTA present.
//   funnelMult   — usage-funnel boost when a teammate is OUT.            REAL when redistribution present.
// A final combined clamp prevents the stacked multipliers from railing a
// projection to a career high.
//
// CONTRACT: analyzeUnifiedProp(input, league='WNBA') -> {
//   projection, edge, probOver, probUnder, recommendation, confidence (0-100),
//   tier, scores: { roleStability, usageFunnel, environment, matchup, coverage,
//   whistle, variance, finalEdge }, cores: { possession, rate, blended },
//   multipliers: {...}, dataCompleteness: {...}, floor, ceiling, _audit }
//
// Only the POINTS market uses the blended cores. Rebounds/assists/etc. are
// delegated to the matchup-aware rate model (same as the previous v2 fallback),
// so this engine is a complete points solution and a graceful passthrough for
// other markets.

import { getLeagueConfig } from './leagueConfig.js';
import { calculateRoleStability } from './roleStability.js';
import { detectUsageFunnel } from './usageFunnel.js';
import { calculatePossessionEnvironment } from './possessionEnvironment.js';
import { evaluateBasketballMatchup } from './matchupEngine.js';

const clamp = (x, [lo, hi]) => Math.max(lo, Math.min(hi, x));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Standard normal CDF (Abramowitz-Stegun) for over/under probability.
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// ============================================================
// SCORING CORES
// ============================================================

// Possession core: minutes x pace/min x usage x points-per-possession.
// Efficiency (points-per-possession) is FG%-aware: it uses TS% when present,
// derives a TS proxy from FG% when TS% is missing (so the core stays alive),
// and nudges for recent shooting form (recent FG% vs season FG%).
function possessionCore(player, env, cfg) {
  const minutes = num(player.expectedMinutes) ?? num(player.minutesAvg);
  const usage = normalizeUsage(player.usageRate);
  const baseTs = resolveEfficiency(player, cfg);
  if (minutes == null || usage == null || baseTs == null) return null;
  const form = shootingForm(player, cfg);                 // { mult, active }
  const effTs = clamp(baseTs * form.mult, [0.30, 0.75]);
  const pacePerMin = (num(env?.projectedPace) ?? cfg.leagueAvgPace) / cfg.regulationMinutes;
  const possessions = minutes * pacePerMin;
  const pointsPerPoss = 2 * effTs;                        // TS folds in FG% + FT + 3pt
  return possessions * usage * pointsPerPoss;
}

// Scoring efficiency as a TS%: prefer real TS%, else derive from FG% (+ a small
// league-typical gap for 3PT/FT value) so a missing advanced stat doesn't kill
// the possession core. Returns null only when neither TS% nor FG% exists.
function resolveEfficiency(player, cfg) {
  const ts = num(player.tsPct) ?? num(player._raw?.TS_PCT);
  if (ts != null && ts > 0) return ts;
  const fg = num(player.fgPct) ?? num(player._raw?.FG_PCT);
  if (fg != null && fg > 0) {
    return clamp(fg + (cfg.fgToTsGap ?? 0.10), [0.30, 0.70]);
  }
  return null;
}

// Recent shooting form: recent FG% vs season FG%. Hot shooting (>1) lifts
// efficiency, cold (<1) trims it. Dampened + tightly clamped so it nudges
// rather than dominates. Neutral (1.0) when recent or season FG% is absent.
function shootingForm(player, cfg) {
  const seasonFg = num(player.fgPct) ?? num(player._raw?.FG_PCT);
  const recentFg = num(player.fgPctRecent);
  if (seasonFg == null || seasonFg <= 0 || recentFg == null || recentFg <= 0) {
    return { mult: 1, active: false };
  }
  const ratio = recentFg / seasonFg;
  const damped = 1 + (ratio - 1) * cfg.weights.shootingFormSensitivity;
  return { mult: clamp(damped, cfg.clamps.shootingForm), active: true };
}

// Rate core: realized PPG blended with recent form, scaled by minutes ratio.
function rateCore(player, cfg) {
  const seasonAvg = num(player.seasonAvg);
  if (seasonAvg == null) return null;
  const minutesAvg = num(player.minutesAvg) || cfg.starterMinutes;
  const projMinutes = num(player.expectedMinutes) ?? minutesAvg;
  const last5 = num(player.last5Avg);
  const w = cfg.weights.recentFormBlend;
  // Blend season & recent PPG, then scale by how minutes are trending.
  const blendedPpg = last5 != null ? (1 - w) * seasonAvg + w * last5 : seasonAvg;
  const minutesRatio = minutesAvg > 0 ? clamp(projMinutes / minutesAvg, cfg.clamps.recentRate) : 1;
  return blendedPpg * minutesRatio;
}

function normalizeUsage(u) {
  let usage = num(u);
  if (usage == null) return null;
  if (usage > 1) usage = usage / 100;           // percentage -> decimal
  return clamp(usage, [0.05, 0.45]);
}

// ============================================================
// MULTIPLIER LAYERS — each returns { mult, active, detail }
// ============================================================

function environmentMult(env, cfg, providedMult) {
  // Provided-first: any future pace/environment feed can set input.environmentMultiplier
  // and this activates automatically. Falls back to the matchup-derived env value.
  // Guard num(null)===0: only take provided when truly present.
  const prov = (providedMult != null && Number(providedMult) > 0) ? num(providedMult) : null;
  const raw = (prov != null) ? prov : num(env?.environmentMultiplier);
  if (raw == null) return { mult: 1, active: false, detail: 'no environment data' };
  const damped = 1 + (raw - 1) * cfg.weights.paceSensitivity;
  const src = (prov != null) ? 'pace feed' : 'pace/total env';
  return { mult: clamp(damped, cfg.clamps.pace), active: true, detail: `${src} ${raw.toFixed(3)}` };
}

// OPPOSING DEFENSE — first-class layer, REAL from live bbref opponent data.
function matchupMult(matchup, cfg, providedMult) {
  // Prefer an explicitly-provided defense multiplier (the WNBA defense feed built
  // from box scores: pts/reb/ast allowed by position). Fall back to the matchup
  // engine's own scoringMultiplier, then to neutral.
  // NOTE: guard against num(null)===0 — only take provided when it's truly present.
  const prov = (providedMult != null && Number(providedMult) > 0) ? num(providedMult) : null;
  const raw = (prov != null) ? prov : num(matchup?.scoringMultiplier);
  if (raw == null) return { mult: 1, active: false, detail: 'no opponent-defense data' };
  const damped = 1 + (raw - 1) * cfg.weights.defenseSensitivity;
  const src = (prov != null) ? 'allowed-by-position (last 10G)' : 'opp def rtg/rim/perimeter';
  return {
    mult: clamp(damped, cfg.clamps.defense), active: true,
    detail: `${src} ${raw.toFixed(3)}`,
  };
}

// COACHING DEFENSIVE COVERAGE — first-class layer. Scheme (drop/switch/blitz/
// zone/double) vs the player's archetype. bbref has no scheme data, so this is
// NEUTRAL (1.0) until a coverage feed or manual coach tags populate
// input.opponent.coverage. When present, it shifts the projection.
function coverageMult(input, cfg) {
  const cov = input.opponent?.coverage || input.coverage || null;
  // Expected (when fed): { scheme, vsArchetypeMultiplier } or a numeric multiplier.
  let raw = null, scheme = null;
  if (cov && typeof cov === 'object') {
    raw = num(cov.vsArchetypeMultiplier);
    if (raw == null) raw = num(cov.multiplier);
    scheme = cov.scheme || null;
  } else if (cov != null) {
    raw = num(cov);
  }
  // A coverage layer only counts as REAL when it carries a usable, non-zero
  // multiplier. Missing data, a null, or a 0 all mean "no scheme source" → neutral.
  if (raw == null || raw <= 0) {
    return { mult: 1, active: false, detail: 'no coaching-coverage source (neutral)' };
  }
  const damped = 1 + (raw - 1) * cfg.weights.coverageSensitivity;
  return { mult: clamp(damped, cfg.clamps.coverage), active: true,
    detail: `coverage ${scheme || 'scheme'} ${raw.toFixed(3)}` };
}

// WHISTLE — FTA-driven free-throw scoring, REAL when FT volume present.
function whistleMult(player, opponent, cfg) {
  const fta = num(player.fta) ?? num(player._raw?.FTA);
  if (fta == null || fta <= 0) return { mult: 1, active: false, detail: 'no FTA data' };
  // Opponent foul tendency nudges it; default neutral if absent.
  const oppFoul = num(opponent?.foulRate);
  const leagueFoul = 21;
  const foulRatio = oppFoul != null ? oppFoul / leagueFoul : 1;
  // A player who draws fouls (fta>=4) in a foul-prone matchup gets a small bump.
  const ftaWeight = clamp(fta / 6, [0, 1]);
  const raw = 1 + (foulRatio - 1) * ftaWeight;
  const damped = 1 + (raw - 1) * cfg.weights.whistleSensitivity;
  return { mult: clamp(damped, cfg.clamps.whistle), active: true,
    detail: `fta ${fta} x oppFoul ${foulRatio.toFixed(2)}` };
}

// USAGE FUNNEL — boost when a teammate is OUT and usage redistributes.
function funnelMult(funnel) {
  const boost = num(funnel?.usageBoostMultiplier);
  if (boost == null || boost === 1) return { mult: 1, active: false, detail: 'no redistribution' };
  return { mult: clamp(boost, [1.0, 1.20]), active: true, detail: `funnel ${boost.toFixed(3)}` };
}

// ============================================================
// MAIN
// ============================================================

export function analyzeUnifiedProp(input, league = 'WNBA') {
  const cfg = getLeagueConfig(league);
  const market = String(input.market || 'points').toLowerCase();
  const player = input.player || {};
  const line = num(input.line);

  // --- Run the tested sub-engines (same inputs they always took) ---
  const role = safe(() => calculateRoleStability(input), null);
  const funnel = safe(() => detectUsageFunnel(input), null);
  const env = safe(() => calculatePossessionEnvironment(input), null);
  const matchup = safe(() => evaluateBasketballMatchup(input), null);

  // --- POINTS: blended core + full multiplier stack ---
  // Non-points markets delegate to the rate core with the matchup mult only
  // (rebounds/assists don't use TS%/possession scoring), preserving prior behavior.
  const isPoints = market === 'points' || market === 'pts';

  const possC = isPoints ? possessionCore(player, env, cfg) : null;
  const rateC = rateCore(player, cfg);

  let blended, coreMix;
  if (isPoints && possC != null && rateC != null) {
    const w = cfg.pointsBlend;
    blended = w.possession * possC + w.rate * rateC;
    coreMix = 'blend';
  } else if (possC != null) {
    blended = possC; coreMix = 'possession-only';
  } else if (rateC != null) {
    blended = rateC; coreMix = 'rate-only';
  } else {
    blended = num(player.seasonAvg) ?? 0; coreMix = 'season-fallback';
  }

  // Multiplier layers
  const mEnv = environmentMult(env, cfg, input.environmentMultiplier);
  const mMatch = matchupMult(matchup, cfg, input.opponent?.defenseMultiplier);          // opposing defense
  const mCover = coverageMult(input, cfg);           // coaching coverage
  const mWhistle = isPoints ? whistleMult(player, input.opponent, cfg)
                            : { mult: 1, active: false, detail: 'whistle points-only' };
  const mFunnel = funnelMult(funnel);

  // Combine multipliers ADDITIVELY (sum each factor's deviation from 1), NOT
  // multiplicatively. Five near-1 factors chained with * compound into a career-high
  // projection — this is what railed Plum to 31.8 on a 22.5 line (and A'ja Wilson to
  // 31.4 in the env engine, and the MLB 7-multiplier buildGameProjection bug). Additive
  // deviation honors the standing rule: no multiplicative chaining beyond two factors.
  // Total adjustment capped at ±COMBINED_DEV_CAP, matching the env-engine's documented
  // ~±14% intended swing.
  const COMBINED_DEV_CAP = 0.15;
  const devSum = [mEnv.mult, mMatch.mult, mCover.mult, mWhistle.mult, mFunnel.mult]
    .reduce((acc, m) => acc + (Number.isFinite(m) ? m - 1 : 0), 0);
  const rawCombined = 1 + clamp(devSum, [-COMBINED_DEV_CAP, COMBINED_DEV_CAP]);
  // A tighter league clamp can constrain further; it can never loosen past the cap above.
  const combined = clamp(rawCombined, cfg.clamps.combined);

  let projection = blended * combined;

  // Anti-rail: never exceed a sane ceiling off realized production.
  const seasonAvg = num(player.seasonAvg);
  if (seasonAvg != null && projection > seasonAvg * 2.0) projection = seasonAvg * 2.0;
  projection = Math.max(0, Number(projection.toFixed(2)));

  // --- Variance band: base CV widened by minutes volatility AND core disagreement ---
  const baseCv = cfg.variance.baseScoringCv;
  const minutesCv = num(player.minutesCv) ?? 0;
  let coreDisagreement = 0;
  if (isPoints && possC != null && rateC != null && projection > 0) {
    coreDisagreement = Math.abs(possC - rateC) / Math.max(possC, rateC); // 0..1
  }
  const effectiveCv = baseCv * (1 + minutesCv * cfg.variance.minutesCvInflation)
                              * (1 + 0.5 * coreDisagreement);
  const sd = projection * effectiveCv;
  const floor = Math.max(0, Number((projection - sd).toFixed(1)));
  const ceiling = Number((projection + sd).toFixed(1));

  // --- Over/under probability ---
  let probOver = null, probUnder = null;
  if (line != null && sd > 0) {
    const z = (projection - line) / sd;
    probOver = Number(normalCdf(z).toFixed(3));
    probUnder = Number((1 - probOver).toFixed(3));
  }

  const edge = line != null ? Number((projection - line).toFixed(2)) : null;

  // --- Sub-scores (0-100) for the card; opposing defense and coverage explicit ---
  const scores = {
    roleStability: pick(role, ['score', 'stability'], 50),
    usageFunnel: pick(funnel, ['score'], 50),
    environment: pick(env, ['score'], 50),
    matchup: pick(matchup, ['score', 'defenseScore'], 50),     // opposing defense outcome
    coverage: mCover.active ? pick(input.opponent?.coverage, ['score'], 50) : 50,
    whistle: mWhistle.active ? Math.round(50 + (mWhistle.mult - 1) * 500) : 50,
    variance: Math.round(clamp(100 - effectiveCv * 150, [0, 100])),
    finalEdge: null,
  };
  scores.finalEdge = computeFinalEdgeScore(scores, edge, line);

  // --- Data completeness (honest real-vs-neutral per layer) ---
  const dataCompleteness = {
    scoringCore: coreMix,
    possessionCoreAvailable: possC != null,
    rateCoreAvailable: rateC != null,
    opposingDefense: mMatch.active ? 'REAL' : 'NEUTRAL',
    coachingCoverage: mCover.active ? 'REAL' : 'NEUTRAL (no scheme source)',
    whistle: mWhistle.active ? 'REAL' : 'NEUTRAL',
    environment: mEnv.active ? 'REAL' : 'NEUTRAL',
    usageFunnel: mFunnel.active ? 'REAL' : 'NEUTRAL',
    tsPctAvailable: (num(player.tsPct) ?? num(player._raw?.TS_PCT)) != null,
    efficiencySource: ((num(player.tsPct) ?? num(player._raw?.TS_PCT)) > 0) ? 'TS%'
      : ((num(player.fgPct) ?? num(player._raw?.FG_PCT)) > 0 ? 'FG%-derived' : 'none'),
    shootingForm: shootingForm(player, cfg).active ? 'REAL (recent FG% vs season)' : 'NEUTRAL',
    recentFormAvailable: num(player.last5Avg) != null,
  };

  // --- Confidence (0-100): how much of the stack ran on real data ---
  const confidence = computeConfidence(dataCompleteness, scores, player, cfg);

  const tier = edgeTierLabel(scores.finalEdge);
  const recommendation = recommend(edge, probOver, dataCompleteness);

  return {
    market, line, projection, edge, probOver, probUnder, recommendation,
    confidence, tier,
    cores: {
      possession: possC != null ? Number(possC.toFixed(2)) : null,
      rate: rateC != null ? Number(rateC.toFixed(2)) : null,
      blended: Number(blended.toFixed(2)),
      mix: coreMix,
    },
    multipliers: {
      environment: round3(mEnv.mult), matchup_opposingDefense: round3(mMatch.mult),
      coverage_coachingScheme: round3(mCover.mult), whistle: round3(mWhistle.mult),
      usageFunnel: round3(mFunnel.mult), combined: round3(combined),
    },
    layerDetail: {
      environment: mEnv.detail, opposingDefense: mMatch.detail,
      coachingCoverage: mCover.detail, whistle: mWhistle.detail, usageFunnel: mFunnel.detail,
    },
    scores, floor, ceiling, dataCompleteness,
    _audit: { league, coreDisagreement: Number(coreDisagreement.toFixed(3)), effectiveCv: Number(effectiveCv.toFixed(3)) },
  };
}

// ============================================================
// helpers
// ============================================================

function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

function pick(obj, keys, dflt) {
  if (!obj) return dflt;
  for (const k of keys) {
    const v = num(obj[k]);
    if (v != null) return Math.round(v);
  }
  return dflt;
}

function round3(x) { return Number(Number(x).toFixed(3)); }

function computeFinalEdgeScore(scores, edge, line) {
  // Map the analytical sub-scores + the raw edge into a 0-100 signal score.
  const analytic = (scores.roleStability + scores.usageFunnel + scores.environment
    + scores.matchup + scores.coverage + scores.whistle) / 6;
  let edgePart = 50;
  if (edge != null && line) {
    const pctEdge = edge / line;                     // e.g. +0.10 = 10% over the line
    edgePart = clamp(50 + pctEdge * 250, [0, 100]);  // ±20% edge spans the scale
  }
  return Math.round(0.55 * edgePart + 0.45 * analytic);
}

function computeConfidence(dc, scores, player, cfg) {
  let c = 100;
  if (dc.scoringCore !== 'blend') c -= 12;                       // only one core available
  if (!dc.tsPctAvailable) c -= 10;
  if (!dc.recentFormAvailable) c -= 8;
  if (dc.opposingDefense !== 'REAL') c -= 12;
  if (dc.environment !== 'REAL') c -= 6;
  if (dc.coachingCoverage.startsWith('NEUTRAL')) c -= 4;         // small: expected-neutral on bbref
  const gp = num(player.gamesPlayed);
  if (gp != null && gp < 5) c -= 12;                             // thin sample
  const minutesCv = num(player.minutesCv) ?? 0;
  if (minutesCv > 0.30) c -= 10;                                 // volatile role
  return Math.max(0, Math.min(100, Math.round(c)));
}

function edgeTierLabel(finalEdge) {
  if (finalEdge >= 68) return 'STRONG';
  if (finalEdge >= 56) return 'SOLID';
  if (finalEdge >= 46) return 'NEUTRAL';
  return 'WEAK';
}

function recommend(edge, probOver, dc) {
  if (edge == null || probOver == null) return 'PASS';           // no real line yet
  // Require both a directional edge and the opposing-defense layer to be real.
  if (dc.opposingDefense !== 'REAL') return 'PASS';
  if (edge >= 0.5 && probOver >= 0.56) return 'OVER';
  if (edge <= -0.5 && probOver <= 0.44) return 'UNDER';
  return 'PASS';
}

export const _testing = {
  possessionCore, rateCore, normalizeUsage, resolveEfficiency, shootingForm,
  environmentMult, matchupMult, coverageMult, whistleMult, funnelMult,
  normalCdf, computeConfidence, computeFinalEdgeScore,
};
