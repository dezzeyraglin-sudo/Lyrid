// api/_lib/nba/teamTotals.js
//
// Team + game total projection — a GAME-level model (separate from the player engine).
// Mechanistic: possessions x matchup-adjusted efficiency, minus injuries.
//
//   possessions  = avg(team pace, opp pace)                          (bbref)
//   team ORtg    = leagueRtg * (teamORtg/league) * (oppDRtg/league)  (offense x opp defense; FT scoring is already inside ORtg/DRtg)
//   injuries     = OUT players' usage removed, redistributed at lower efficiency (modest, capped)
//   team points  = adjORtg * possessions / 100
//   game total   = home points + away points
//
// CRITICAL discipline: NO blowout suppression on the total. The validated finding is
// that a blowout does NOT move the game total (margin<->total ~ 0) — the player-under
// edge is redistribution, not scoring loss. This model never inherits that logic.
// Shadow; all constants are TUNE placeholders in leagueConfig.totals.

import NBA, { CONFIGS } from './leagueConfig.js';

export function projectTeamPoints(o, cfg) {
  const t = cfg.totals;
  const { teamORtg, oppDRtg, teamPace, oppPace, outUsgSum = 0 } = o;
  if (teamORtg == null || oppDRtg == null || teamPace == null || oppPace == null) return null;
  const pace = (teamPace + oppPace) / 2;
  let ortg = t.leagueRtg * (teamORtg / t.leagueRtg) * (oppDRtg / t.leagueRtg); // = teamORtg*oppDRtg/league
  const injMult = Math.max(1 - t.injuryCap, 1 - t.injuryCoef * (outUsgSum / 100));
  ortg *= injMult;
  return { points: +(ortg * pace / 100).toFixed(1), pace: +pace.toFixed(1), adjORtg: +ortg.toFixed(1), injMult: +injMult.toFixed(3), outUsgSum: +outUsgSum.toFixed(1) };
}

export function projectGame(home, away, cfg) {
  const h = projectTeamPoints(home, cfg), a = projectTeamPoints(away, cfg);
  if (!h || !a) return null;
  return { homePoints: h.points, awayPoints: a.points, total: +(h.points + a.points).toFixed(1), home: h, away: a };
}

// projection vs market line -> over/under lean (logistic on the point gap)
export function analyzeTotal(projTotal, marketTotal, cfg, kind = 'game') {
  const t = cfg.totals;
  if (projTotal == null || marketTotal == null) return { ok: false, reason: 'missing projection or line' };
  const diff = projTotal - marketTotal;
  const pOver = 1 / (1 + Math.exp(-diff / t.sigma));
  const side = pOver >= 0.5 ? 'over' : 'under';
  const prob = Math.max(pOver, 1 - pOver);
  const edge = Math.abs(prob - 0.5);
  const minEdge = kind === 'team' ? t.teamMinEdge : t.gameMinEdge;
  return {
    ok: true, kind, posture: cfg.posture || 'shadow',
    projTotal: +projTotal.toFixed(1), marketTotal, diff: +diff.toFixed(1),
    pOver: +pOver.toFixed(3), pUnder: +(1 - pOver).toFixed(3),
    side, prob: +prob.toFixed(3), edge: +edge.toFixed(3),
    lean: edge < minEdge ? 'pass' : side,
  };
}

export default { projectTeamPoints, projectGame, analyzeTotal };
