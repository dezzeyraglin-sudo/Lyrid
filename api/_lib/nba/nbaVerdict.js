// api/_lib/nba/nbaVerdict.js
// Single-verdict pipeline. Uses external schemeRisk for high-floor / under-advise logic.
// Safe fallback if schemeRisk throws so a bad risk module never 500s the whole slate.

import NBA, { CONFIGS } from './leagueConfig.js';
import { analyzePoints } from './pointsEngine.js';
import { analyzeCounting } from './reboundsAssistsEngine.js';
import { analyzeCombo } from './comboEngine.js';
import { formFloor } from './formFloor.js';
import { biasCorrection } from './biasCorrection.js';
import { classifyCadence, applyCadence } from './cadenceEngine.js';
import { applySchemeRisk as applySchemeRiskExternal } from './schemeRisk.js';

const COMBO_SET = new Set(['pra', 'pts_rebs', 'pts_asts', 'rebs_asts']);

function applySchemeRisk(mp, market, line, rec, ctx = {}) {
  try {
    return applySchemeRiskExternal(mp, market, line, rec, {
      ...ctx,
      leagueConfig: ctx.leagueConfig || (CONFIGS && CONFIGS.NBA) || {},
    });
  } catch (e) {
    return {
      rec,
      flags: { forcedPass: false },
      reasons: ['schemeRisk fallback: ' + (e && e.message ? e.message : 'error')],
      score: 50,
      underFactors: 0,
      preferredProfile: null,
      weakestStat: market,
      riskExplanation: 'schemeRisk unavailable — using neutral score',
    };
  }
}

function recentAvgFor(profile, market) {
  if (!profile) return null;
  const M = profile.minutes?.mean ?? null;
  if (market === 'points') return profile.pts?.mean ?? profile.ppg ?? null;
  if (market === 'rebounds') return profile.reb?.mean ?? profile.rpg ?? null;
  if (market === 'assists') return profile.ast?.mean ?? profile.apg ?? null;
  if (market === 'pra') {
    const p = profile.pts?.mean ?? profile.ppg ?? 0;
    const r = profile.reb?.mean ?? profile.rpg ?? 0;
    const a = profile.ast?.mean ?? profile.apg ?? 0;
    return p + r + a;
  }
  return null;
}

function runEngine(mp, market, line, league) {
  if (market === 'points') return analyzePoints(mp, line, { league });
  if (COMBO_SET.has(market)) return analyzeCombo(mp, market, line, { league });
  return analyzeCounting(mp, market, line, { league });
}

/**
 * Decide a single prop.
 */
export function decide(mp, market, line, ctx = {}) {
  const league = ctx.league || 'NBA';
  const cfg = (CONFIGS && CONFIGS[league]) || NBA || {};

  // 1) bias correction
  const bc = biasCorrection(mp.name || mp, market, ctx.gradedHistory);
  const effLine = line - (bc.bias || 0);

  // 2) base engine
  const res = runEngine(mp, market, effLine, league);
  if (!res || !res.ok) return { ok: false, reason: res?.reason || 'engine failed' };

  let rec = {
    side: res.recommendation?.side ?? res.side ?? (res.prob >= 0.5 ? 'over' : 'under'),
    prob: res.recommendation?.prob ?? res.prob ?? 0.5,
    edge: res.edge ?? 0,
    lean: res.recommendation?.lean ?? res.lean ?? 'pass',
    formNote: null,
    formKill: false,
  };

  // 3) form floor
  try {
    const profile = mp.shotProfile || mp.profile;
    const recentAvg = recentAvgFor(profile, market);
    const mf = mp.minutes?.flags || {};
    const hasMinutesReason = !!(mf.reducedMinutes || mf.designation || mf.b2b
      || (mp.projMinutes != null && profile?.minutes?.mean != null && mp.projMinutes < 0.9 * profile.minutes.mean));
    const floorRes = formFloor(mp, market, line, rec, res, { recentAvg, hasMinutesReason });
    if (floorRes) rec = { ...rec, ...floorRes };
  } catch (_) { /* formFloor is best-effort */ }

  // 4) cadence
  let cadenceClass = null;
  let cadenceNote = null;
  try {
    cadenceClass = classifyCadence(mp, market, ctx.cadenceShares || mp.cadenceShares);
    cadenceNote = applyCadence(rec, cadenceClass, market, ctx.gameScript || mp.gameScript);
  } catch (_) { /* cadence is best-effort */ }

  // role-change guard
  let roleGuarded = false;
  if (res.flags?.roleUncertain && rec.lean !== 'pass' && !rec.formKill) {
    const mean = res.distribution?.mean;
    if (mean != null && line > 0) {
      const relGap = Math.abs(mean - line) / line;
      const leanFollowsProjection = (rec.side === 'over' && mean > line) || (rec.side === 'under' && mean < line);
      if (leanFollowsProjection && relGap >= (cfg.roleGuard?.gapPct ?? 0.18)) {
        rec = { ...rec, edge: 0, prob: 0.5, lean: 'pass' };
        roleGuarded = true;
      }
    }
  }

  // 4.5) scheme-risk / high-floor checklist
  const scheme = applySchemeRisk(mp, market, line, rec, {
    ...ctx,
    date: ctx.date || mp.date,
    gameScript: ctx.gameScript || { total: mp.totalLine, spread: mp.spread },
    matchup: mp.matchup,
    oppAdj: mp.oppAdj,
  });
  rec = scheme.rec;

  // 5) finalize
  const marketMinEdge = market === 'points' ? (cfg.edge?.minEdge ?? cfg.thresholds?.minEdge ?? 0.08)
    : COMBO_SET.has(market) ? (cfg.combo?.minEdge ?? 0.07)
    : (cfg.markets?.[market]?.minEdge ?? 0.06);
  const lean = (rec.formKill || rec.lean === 'pass' || (rec.edge ?? 0) < marketMinEdge) ? 'pass' : rec.side;

  // shot-zone shadow reads
  const szReasons = [];
  let szRead = null;
  if (ctx.shotZone) {
    const prof = ctx.shotZone.profile, oz = ctx.shotZone.openZone;
    if (prof && prof.hotGap != null && prof.hotGap > 0.06 && rec.side === 'over') {
      szReasons.push('shooting above shot quality — regression risk');
    }
    if (oz && oz.score != null && !oz.thin) {
      if (oz.score > 0.02) szReasons.push('defense concedes his shot zones');
      else if (oz.score < -0.02) szReasons.push('defense takes away his shot zones');
    }
    szRead = { shotQuality: prof?.shotQuality ?? null, hotGap: prof?.hotGap ?? null, openZone: oz?.score ?? null };
  }

  const matchupReasons = [];
  if (mp.oppAdj) {
    const oa = mp.oppAdj;
    if (oa.effMult <= 0.985) matchupReasons.push('tough matchup (opponent D)');
    else if (oa.effMult >= 1.015) matchupReasons.push('soft matchup (opponent D)');
    if (oa.blockMult != null && oa.blockMult <= 0.98) matchupReasons.push('rim-protecting defense');
    if (oa.stealMult != null && oa.stealMult <= 0.975) matchupReasons.push('ball-pressure defense');
  }

  const reasons = [
    ...(res.recNotes || []),
    res.flags?.confidentOverFaded ? 'confident over faded' : null,
    res.flags?.lineAboveCeiling ? 'line above ceiling' : null,
    rec.formNote,
    cadenceNote,
    ...matchupReasons,
    roleGuarded ? 'role change + market disagreement — lean neutralized (stale projection risk)' : null,
    ...szReasons,
    ...(scheme.reasons || []),
    bc.n ? `bias-corrected ${bc.bias > 0 ? '+' : ''}${bc.bias} (n${bc.n})` : null,
  ].filter(Boolean);

  return {
    ok: true,
    market,
    line,
    effLine: +effLine.toFixed(1),
    side: rec.side,
    prob: rec.prob,
    edge: +(rec.edge || 0).toFixed(3),
    lean,
    distribution: res.distribution,
    bias: bc.bias,
    cadence: cadenceClass,
    formKill: !!rec.formKill,
    roleGuarded,
    shotZone: szRead,
    engine: res,
    reasons,
    schemeFlags: scheme.flags || {},
    schemeScore: scheme.score ?? 50,
    schemeUnderFactors: scheme.underFactors || 0,
    preferredProfile: scheme.preferredProfile || null,
    weakestStat: scheme.weakestStat || market,
    riskExplanation: scheme.riskExplanation || '',
  };
}

export default { decide };
