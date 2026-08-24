// api/_lib/nba/formFloor.js
//
// Recent-form floor (a.k.a. formKill). A projection can't sit far below the player's
// own recent average without a role/minutes reason. Market-aware, because stickiness
// differs: rebounds trigger at a 1.5 gap, points 2.5 (shooting variance), assists 2.0.
// Catches lowballed unders. Thresholds are TUNE.

const GAPS = {
  rebounds: { gap: 1.5 },
  points:   { gap: 2.5 },
  assists:  { gap: 2.0 },
};

// rec: { side, prob, edge }. recentAvg: player's recent per-game avg for this market
// (at baseline minutes). line: the prop line. hasMinutesReason: is there a real
// minutes/role cut explaining a low projection (reducedMinutes, designation, etc.)?
export function formFloor(rec, market, { recentAvg, projMean, line, hasMinutesReason } = {}) {
  const g = GAPS[market];
  if (!g || rec.side !== 'under' || recentAvg == null) return { ...rec };

  // formKill: recent form already lands at/above the line and nothing cut the minutes
  if (recentAvg >= line && !hasMinutesReason) {
    return { ...rec, side: 'under', edge: 0, prob: 0.5, lean: 'pass', formKill: true,
      formNote: 'recent avg at/above line, no minutes reason — do not fade' };
  }
  // soften: projection sits a full market-gap below recent avg without a reason
  if (projMean != null && recentAvg - projMean > g.gap && !hasMinutesReason) {
    const edge = rec.edge * 0.5;
    return { ...rec, edge: +edge.toFixed(3), prob: +(0.5 + edge).toFixed(3),
      formNote: 'projection well below recent avg, no minutes reason — softened' };
  }
  return { ...rec };
}

export default { formFloor };
