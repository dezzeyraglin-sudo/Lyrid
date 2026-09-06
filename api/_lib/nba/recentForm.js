// api/_lib/nba/recentForm.js
//
// Recent-form / effectiveness panel for the player card: L5 and L10 windows computed
// straight from the ESPN game log (already fetched in analyze — no new feed). Pairs
// with the shot-type archetype: archetype = HOW he scores, recent form = how well he's
// scoring right now, and the L5-vs-L10 trend = heating up or cooling off.

function tsPct(pts, fga, fta) { const d = 2 * ((fga || 0) + 0.44 * (fta || 0)); return d > 0 ? pts / d : null; }
function r3(x) { return x == null ? null : +x.toFixed(3); }
function r1(x) { return x == null ? null : +x.toFixed(1); }

function windowStats(rows) {
  const g = rows.filter((r) => r && r.min > 0);
  if (!g.length) return null;
  const sum = (k) => g.reduce((s, r) => s + (r[k] || 0), 0);
  const n = g.length;
  return {
    gp: n,
    ppg: r1(sum('pts') / n),
    minAvg: r1(sum('min') / n),
    fgaAvg: r1(sum('fga') / n),
    rebAvg: r1(sum('reb') / n),
    astAvg: r1(sum('ast') / n),
    ftaAvg: r1(sum('fta') / n),
    fgPct: r3(sum('fga') ? sum('fgm') / sum('fga') : null),
    fg3Pct: r3(sum('fg3a') ? sum('fg3m') / sum('fg3a') : null),
    tsPct: r3(tsPct(sum('pts'), sum('fga'), sum('fta'))),
  };
}

// gameLog: newest-first rows (fetchPlayerGameLog output).
export function recentForm(gameLog) {
  const rows = gameLog || [];
  const l5 = windowStats(rows.slice(0, 5));
  const l10 = windowStats(rows.slice(0, 10));
  if (!l5 && !l10) return { insufficient: true };
  const trend = (l5 && l10) ? {
    ppgDelta: r1(l5.ppg - l10.ppg),               // + = scoring more lately
    minDelta: r1(l5.minAvg - l10.minAvg),         // + = minutes trending up
    tsDelta: r3((l5.tsPct ?? 0) - (l10.tsPct ?? 0)), // + = shooting hotter
    state: l5.ppg > l10.ppg + 2 ? 'heating' : l5.ppg < l10.ppg - 2 ? 'cooling' : 'steady',
  } : null;
  return { l5, l10, trend, insufficient: false };
}

export default { recentForm };
