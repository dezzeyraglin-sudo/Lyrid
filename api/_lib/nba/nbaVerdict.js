// api/_lib/nba/nbaVerdict.js
// Single-verdict pipeline with high-floor / no-foul-trouble scheme risk.

import { getLeagueConfig } from './leagueConfig.js';
import { analyzePoints } from './pointsEngine.js';
import { analyzeCounting } from './reboundsAssistsEngine.js';
import { analyzeCombo } from './comboEngine.js';
import { formFloor } from './formFloor.js';
import { biasCorrection } from './biasCorrection.js';
import { classifyCadence, applyCadence } from './cadenceEngine.js';
import { applySchemeRisk } from './schemeRisk.js';

const COMBO_SET = new Set(['pra', 'pts_rebs', 'pts_asts', 'rebs_asts']);

/**
 * Decide a single prop.
 */
export function decide(mp, market, line, ctx = {}) {
  const league = ctx.league || 'NBA';
  let cfg;
  try {
    cfg = getLeagueConfig(league);
  } catch {
    cfg = {};
  }

  // 1) bias correction
  const bc = biasCorrection(mp, market, ctx.gradedHistory || []);
  const effLine = line + (bc.bias || 0);

  // 2) base engine
  let res;
  if (market === 'points') {
    res = analyzePoints(mp, effLine, { ...ctx, league, cfg });
  } else if (COMBO_SET.has(market)) {
    res = analyzeCombo(mp, market, effLine, { ...ctx, league, cfg });
  } else {
    res = analyzeCounting(mp, market, effLine, { ...ctx, league, cfg });
  }

  if (!res || !res.ok) {
    return { ok: false, reason: res?.reason || res?.error || 'engine failed', market, line };
  }

  let rec = {
    side: res.side || (res.prob >= 0.5 ? 'over' : 'under'),
    prob: res.prob ?? 0.5,
    edge: res.edge ?? 0,
    lean: res.lean || 'pass',
    formNote: null,
    formKill: false,
  };

  // 3) form floor
  const floor = formFloor(mp, market, line, rec, res);
  if (floor) {
    rec = { ...rec, ...floor };
  }

  // 4) cadence  (FIXED call signature)
  const rawShares = ctx.cadenceShares || mp.cadenceShares || mp.secondHalfShares || null;
  const secondHalfShares = Array.isArray(rawShares)
    ? rawShares
    : (Array.isArray(rawShares?.[market]) ? rawShares[market] : []);
  const cadenceClass = classifyCadence(secondHalfShares);
  const cadenceNote = applyCadence(rec, market, cadenceClass, ctx.gameScript || mp.gameScript);

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
    leagueConfig: cfg,
  });
  rec = scheme.rec;

  // 5) finalize
  const marketMinEdge = market === 'points'
    ? (cfg.edge?.minEdge ?? cfg.thresholds?.minEdge ?? 0.08)
    : COMBO_SET.has(market)
      ? (cfg.combo?.minEdge ?? 0.07)
      : (cfg.markets?.[market]?.minEdge ?? 0.06);

  const lean = (rec.formKill || rec.lean === 'pass' || (rec.edge ?? 0) < marketMinEdge)
    ? 'pass'
    : rec.side;

  // shot-zone + matchup reasons
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
    cadenceNote?.cadenceNote || null,
    ...matchupReasons,
    roleGuarded ? 'role change + market disagreement — lean neutralized' : null,
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

    // High-floor / risk surface
    schemeFlags: scheme.flags || {},
    schemeScore: scheme.score,
    schemeUnderFactors: scheme.underFactors || 0,
    preferredProfile: scheme.preferredProfile || false,
    weakestStat: scheme.weakestStat || market,
    riskExplanation: scheme.riskExplanation || '',
    injuryFlag: scheme.injuryFlag || null,
  };
}

export default { decide };
