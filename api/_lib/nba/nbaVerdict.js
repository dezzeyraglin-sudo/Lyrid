// api/_lib/nba/nbaVerdict.js
// Single-verdict pipeline + inlined scheme-risk (no external schemeRisk.js import).

import NBA, { CONFIGS } from './leagueConfig.js';
import { analyzePoints } from './pointsEngine.js';
import { analyzeCounting } from './reboundsAssistsEngine.js';
import { analyzeCombo } from './comboEngine.js';
import { formFloor } from './formFloor.js';
import { biasCorrection } from './biasCorrection.js';
import { classifyCadence, applyCadence } from './cadenceEngine.js';

// api/_lib/nba/nbaVerdict.js
//
// Single-verdict pipeline: one prop -> one verdict, each stage only narrowing.
//   bias correction (shift the line by chronic per-player error)
//   -> base engine (points | rebounds | assists)  -> distributional P(clear)
//   -> form floor (don't fade a player landing at/above the line w/o a minutes reason)
//   -> cadence (assist back-loaded TRAP, rebound back-loaded support, points by script)
//   -> final OVER / UNDER / PASS + merged reasons
// Everything is shadow; the base engines apply their own min-edge.

const COMBO_SET = new Set(['pra', 'pts_rebs', 'pts_asts', 'rebs_asts']);

// --- scheme-risk inlined (avoids missing-module 500 on deploy) ---
function applySchemeRisk(mp, market, line, rec, ctx = {}) {
  const flags = {
    purePointsRisk: false,
    schemeHostile: false,
    minutesRisk: false,
    scriptDependent: false,
    compoundingUnder: false,
    openingNightDiscount: false,
    forcedPass: false,
    underBoosted: false,
  };
  const reasons = [];
  let score = 50; // 0 = high risk / avoid, 100 = high floor / preferred
  let newRec = { ...rec };

  const isPurePoints = market === 'points';
  const isCombo = ['pra', 'pts_rebs', 'pts_asts', 'rebs_asts'].includes(market);
  const isCounting = market === 'rebounds' || market === 'assists';

  // ----- 1. Minutes / foul / role risk -----
  const mf = mp.minutes?.flags || {};
  const projMin = mp.projMinutes ?? mp.minutes?.mean ?? null;
  const profileMin = mp.shotProfile?.minutes?.mean ?? mp.profile?.minutes?.mean ?? null;
  const minutesHaircut = (projMin != null && profileMin != null && profileMin > 0)
    ? (projMin / profileMin)
    : 1;

  if (mf.reducedMinutes || mf.designation || mf.b2b || minutesHaircut < 0.88) {
    flags.minutesRisk = true;
    score -= 18;
    reasons.push('minutes risk (foul / designation / B2B / projected cut)');
  }
  if (mf.roleUncertain || mp.flags?.roleUncertain) {
    flags.minutesRisk = true;
    score -= 12;
    reasons.push('role uncertain');
  }

  // ----- 2. Scheme / matchup hostility -----
  // We use whatever opponent adjustment + archetype signals already exist.
  const oppAdj = mp.oppAdj || ctx.oppAdj || {};
  const matchup = mp.matchup || ctx.matchup || {};
  const archetype = mp.archetype || {};

  // Hostile if opponent adjustment is clearly negative for this market
  const oppPenalty = (oppAdj.pointsAdj ?? oppAdj.pts ?? 0);
  if (isPurePoints && oppPenalty < -1.2) {
    flags.schemeHostile = true;
    score -= 15;
    reasons.push('opponent defensive adjustment hostile to scoring');
  }
  if ((market === 'assists' || market === 'pts_asts') && (oppAdj.astAdj ?? 0) < -0.6) {
    flags.schemeHostile = true;
    score -= 12;
    reasons.push('opponent limits assist opportunities');
  }
  if ((market === 'rebounds' || market === 'pts_rebs' || market === 'pra') && (oppAdj.rebAdj ?? 0) < -0.8) {
    flags.schemeHostile = true;
    score -= 10;
    reasons.push('opponent rebounding environment tough');
  }

  // Archetype signals (if present)
  if (archetype.signalHint && /switch|pack|paint|length|physical/i.test(archetype.signalHint)) {
    flags.schemeHostile = true;
    score -= 8;
    reasons.push('matchup archetype: ' + archetype.signalHint);
  }

  // ----- 3. Game-script dependency -----
  const script = ctx.gameScript || {};
  const totalLine = script.total ?? mp.totalLine ?? null;
  const spread = script.spread ?? mp.spread ?? null;
  const isLowPace = totalLine != null && totalLine < 218;
  const isBlowoutRisk = spread != null && Math.abs(spread) >= 9.5;

  if (isPurePoints && isLowPace) {
    flags.scriptDependent = true;
    score -= 14;
    reasons.push('low total / slow pace environment');
  }
  if (isPurePoints && isBlowoutRisk) {
    flags.scriptDependent = true;
    score -= 10;
    reasons.push('blowout risk (minutes / garbage time uncertainty)');
  }

  // Pure points that need high pace + competitive script to clear are high variance
  if (isPurePoints && (flags.schemeHostile || flags.scriptDependent)) {
    flags.purePointsRisk = true;
    score -= 12;
    reasons.push('pure points over in hostile or script-sensitive spot');
  }

  // ----- 4. Opening-night / early-season volatility -----
  // Simple calendar heuristic; can be replaced with a proper season-day flag later.
  const dateStr = ctx.date || mp.date || '';
  const isVeryEarly = /2026-10-(2[0-5])/.test(dateStr); // first week of season
  if (isVeryEarly && isPurePoints) {
    flags.openingNightDiscount = true;
    score -= 8;
    reasons.push('early-season / opening-week volatility discount');
  }

  // ----- 5. Compounding UNDER factors -----
  // Stack: low pace + hostile scheme + minutes risk + pure volume market
  let underFactors = 0;
  if (isLowPace) underFactors++;
  if (flags.schemeHostile) underFactors++;
  if (flags.minutesRisk) underFactors++;
  if (isPurePoints || market === 'pts_asts') underFactors++;
  if (isBlowoutRisk) underFactors++;

  if (underFactors >= 3 && (newRec.side === 'under' || newRec.lean === 'under' || newRec.edge < 0)) {
    flags.compoundingUnder = true;
    flags.underBoosted = true;
    score += 18;
    // Boost the under edge modestly
    if (newRec.side === 'under' || newRec.lean === 'under') {
      newRec.edge = Math.min(0.28, (newRec.edge || 0) + 0.045);
      newRec.prob = Math.min(0.72, (newRec.prob || 0.5) + 0.04);
    }
    reasons.push(`compounding under factors (${underFactors})`);
  }

  // ----- 6. Force PASS on high-risk pure Points overs -----
  // This is the core lesson from Miller / Coward / similar misses.
  if (isPurePoints && newRec.side === 'over' && newRec.lean !== 'pass') {
    const highRisk = flags.purePointsRisk && (flags.schemeHostile || flags.scriptDependent || flags.minutesRisk);
    const veryHighRisk = (score <= 28) || (flags.purePointsRisk && underFactors >= 3);

    if (veryHighRisk) {
      newRec = {
        ...newRec,
        side: 'over',          // keep original side for logging
        lean: 'pass',
        edge: 0,
        prob: 0.5,
        formKill: true,        // reuse existing kill path so downstream treats it as non-actionable
      };
      flags.forcedPass = true;
      reasons.push('FORCED PASS — pure points over failed checklist stress test');
      score = Math.min(score, 22);
    } else if (highRisk && (newRec.edge || 0) < 0.11) {
      // Soften weak pure-points overs that already look marginal
      newRec.edge = Math.max(0, (newRec.edge || 0) - 0.04);
      newRec.lean = (newRec.edge < 0.06) ? 'pass' : newRec.lean;
      reasons.push('pure points over edge reduced by checklist');
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    rec: newRec,
    flags,
    reasons,
    score,
    underFactors,
  };
}

function recentAvgFor(profile, market) {
  if (!profile) return null;
  const M = profile.minutes?.mean ?? null;
  if (M == null) return null;
  if (market === 'rebounds') return profile.rebPerMin != null ? profile.rebPerMin * M : null;
  if (market === 'assists') return profile.astPerMin != null ? profile.astPerMin * M : null;
  if (market === 'points') {
    const p = (2 * (profile.twoPaPerMin || 0) * (profile.twoPct || 0)
             + 3 * (profile.threePaPerMin || 0) * (profile.threePct || 0)
             + (profile.ftaPerMin || 0) * (profile.ftPct || 0)) * M;
    return p;
  }
  return null;
}

function runEngine(mp, market, line, league) {
  const withLine = { ...mp, line: { market, line } };
  if (market === 'points') return analyzePoints(withLine, league);
  if (COMBO_SET.has(market)) return analyzeCombo(withLine, market, league);
  return analyzeCounting(withLine, market, league);
}

// decide one prop. ctx: { league, gradedHistory, cadenceShares (per-market 2nd-half
// shares arrays), gameScript:{blowout} }
export function decide(mp, market, line, ctx = {}) {
  const league = ctx.league || 'NBA';
  const cfg = CONFIGS[league] || NBA;

  // 1) per-player bias correction -> shift the effective line
  const bc = biasCorrection(mp.name, market, ctx.gradedHistory);
  const effLine = line - bc.bias;

  // 2) base engine on the bias-adjusted line
  const res = runEngine(mp, market, effLine, league);
  if (!res.ok) return { ok: false, reason: res.reason };

  let rec = { side: res.recommendation.side, prob: res.recommendation.prob, edge: res.edge, lean: res.recommendation.lean };

  // 3) form floor
  const profile = mp.shotProfile || mp.profile;
  const recentAvg = recentAvgFor(profile, market);
  const mf = mp.minutes?.flags || {};
  const hasMinutesReason = !!(mf.reducedMinutes || mf.designation || mf.b2b
    || (mp.projMinutes != null && profile?.minutes?.mean != null && mp.projMinutes < 0.9 * profile.minutes.mean));
  rec = formFloor(rec, market, { recentAvg, projMean: res.distribution.mean, line, hasMinutesReason });

  // 4) cadence (needs 5+ games; keyed on real game script)
  let cadenceClass = null, cadenceNote = null;
  if (ctx.cadenceShares && ctx.cadenceShares[market] && rec.lean !== 'pass' && !rec.formKill) {
    const cad = classifyCadence(ctx.cadenceShares[market]);
    const applied = applyCadence(rec, market, cad, ctx.gameScript || {});
    rec = applied; cadenceClass = applied.cadence; cadenceNote = applied.cadenceNote;
  }

  // role-change guard: an unconfirmed role change + a market line that disagrees strongly
  // with our (stale) projection => the market is pricing a role shift we can't see. Don't
  // lean either way on a projection we can't trust — neutralize to PASS (symmetric).
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

  // 4.5) scheme-risk / high-floor checklist (Miller/Coward-style pure-points protection)
  let scheme = { flags: {}, reasons: [], score: 50, underFactors: 0 };
  if (rec.lean !== 'pass' || rec.formKill) {
    // still run even on formKill so we can attach flags for logging
  }
  scheme = applySchemeRisk(mp, market, line, rec, {
    ...ctx,
    date: ctx.date || mp.date,
    gameScript: ctx.gameScript || { total: mp.totalLine, spread: mp.spread },
    matchup: mp.matchup,
    oppAdj: mp.oppAdj,
  });
  rec = scheme.rec;

  // 5) finalize
  const marketMinEdge = market === 'points' ? cfg.edge.minEdge
    : COMBO_SET.has(market) ? (cfg.combo?.minEdge ?? 0.07)
    : (cfg.markets?.[market]?.minEdge ?? 0.06);
  const lean = (rec.formKill || rec.lean === 'pass' || rec.edge < marketMinEdge) ? 'pass' : rec.side;

  // shot-zone shadow reads (location-based; log alongside, no projection change until graded)
  const szReasons = []; let szRead = null;
  if (ctx.shotZone) {
    const prof = ctx.shotZone.profile, oz = ctx.shotZone.openZone;
    if (prof && prof.hotGap != null && prof.hotGap > 0.06 && rec.side === 'over') szReasons.push('shooting above shot quality — regression risk');
    if (oz && oz.score != null && !oz.thin) {
      if (oz.score > 0.02) szReasons.push('defense concedes his shot zones');
      else if (oz.score < -0.02) szReasons.push('defense takes away his shot zones');
    }
    szRead = { shotQuality: prof?.shotQuality ?? null, hotGap: prof?.hotGap ?? null, openZone: oz?.score ?? null };
  }

  const matchupReasons = [];
  if (mp.oppAdj) {
    var oa = mp.oppAdj;
    if (oa.effMult <= 0.985) matchupReasons.push('tough matchup (opponent D)');
    else if (oa.effMult >= 1.015) matchupReasons.push('soft matchup (opponent D)');
    if (oa.blockMult != null && oa.blockMult <= 0.98) matchupReasons.push('rim-protecting defense');
    if (oa.stealMult != null && oa.stealMult <= 0.975) matchupReasons.push('ball-pressure defense');
  }
  const reasons = [...(res.recNotes || []), res.flags?.confidentOverFaded ? 'confident over faded' : null,
    res.flags?.lineAboveCeiling ? 'line above ceiling' : null,
    rec.formNote, cadenceNote, ...matchupReasons,
    roleGuarded ? 'role change + market disagreement — lean neutralized (stale projection risk)' : null,
    ...szReasons,
    ...(scheme.reasons || []),
    bc.n ? `bias-corrected ${bc.bias > 0 ? '+' : ''}${bc.bias} (n${bc.n})` : null,
  ].filter(Boolean);

  return {
    ok: true, market, line, effLine: +effLine.toFixed(1),
    side: rec.side, prob: rec.prob, edge: +rec.edge.toFixed(3), lean,
    distribution: res.distribution, bias: bc.bias, cadence: cadenceClass,
    formKill: !!rec.formKill, roleGuarded, shotZone: szRead, engine: res, reasons,
    // new checklist / scheme-risk surface
    schemeFlags: scheme.flags || {},
    schemeScore: scheme.score,
    schemeUnderFactors: scheme.underFactors || 0,
  };
}

export default { decide };
