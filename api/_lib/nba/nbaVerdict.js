// api/_lib/nba/nbaVerdict.js
//
// Single-verdict pipeline: one prop -> one verdict, each stage only narrowing.
//   bias correction (shift the line by chronic per-player error)
//   -> base engine (points | rebounds | assists)  -> distributional P(clear)
//   -> form floor (don't fade a player landing at/above the line w/o a minutes reason)
//   -> cadence (assist back-loaded TRAP, rebound back-loaded support, points by script)
//   -> final OVER / UNDER / PASS + merged reasons
// Everything is shadow; the base engines apply their own min-edge.

import NBA, { CONFIGS } from './leagueConfig.js';
import { analyzePoints } from './pointsEngine.js';
import { analyzeCounting } from './reboundsAssistsEngine.js';
import { analyzeCombo } from './comboEngine.js';
const COMBO_SET = new Set(['pra', 'pts_rebs', 'pts_asts', 'rebs_asts']);
import { formFloor } from './formFloor.js';
import { biasCorrection } from './biasCorrection.js';
import { classifyCadence, applyCadence } from './cadenceEngine.js';

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

  // 5) finalize
  const marketMinEdge = market === 'points' ? cfg.edge.minEdge
    : COMBO_SET.has(market) ? (cfg.combo?.minEdge ?? 0.07)
    : (cfg.markets?.[market]?.minEdge ?? 0.06);
  const lean = (rec.formKill || rec.lean === 'pass' || rec.edge < marketMinEdge) ? 'pass' : rec.side;

  const reasons = [...(res.recNotes || []), res.flags?.confidentOverFaded ? 'confident over faded' : null,
    res.flags?.lineAboveCeiling ? 'line above ceiling' : null,
    rec.formNote, cadenceNote, bc.n ? `bias-corrected ${bc.bias > 0 ? '+' : ''}${bc.bias} (n${bc.n})` : null,
  ].filter(Boolean);

  return {
    ok: true, market, line, effLine: +effLine.toFixed(1),
    side: rec.side, prob: rec.prob, edge: +rec.edge.toFixed(3), lean,
    distribution: res.distribution, bias: bc.bias, cadence: cadenceClass,
    formKill: !!rec.formKill, engine: res, reasons,
  };
}

export default { decide };
