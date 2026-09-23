// api/_lib/nba/regime.js
// REGIME TAGGING (v4 §1) — the edge lives in the SETTLED mid-season. Disrupted windows
// (opening weeks, trade deadline, B2B/load-management, late-season tanking, playoffs) get
// tagged so they can be down-weighted or sat, and NEVER pooled into the calibration baseline.

export function tagRegime(game, ctx, cfg) {
  const c = (cfg && cfg.regime) || {};
  const disruptedSet = c.disrupted || ['opening', 'playoffs', 'deadline', 'b2b', 'tanking'];
  const date = new Date(ctx.date || game.date || Date.now());
  const tags = [];
  if (ctx.seasonStart) {
    const days = (date - new Date(ctx.seasonStart)) / 86400000;
    if (days >= 0 && days <= (c.openingDays != null ? c.openingDays : 14)) tags.push('opening');
  }
  if (ctx.isPlayoffs || game.seasonType === 'postseason') tags.push('playoffs');
  const mo = date.getUTCMonth(), day = date.getUTCDate();
  if (mo === 1 && day >= (c.deadlineFrom || 1) && day <= (c.deadlineTo || 12)) tags.push('deadline');
  if (game.homeB2B || game.awayB2B || game.b2b) tags.push('b2b');
  if (mo === 3 && (game.homeEliminated || game.awayEliminated)) tags.push('tanking');
  const disrupted = tags.some((t) => disruptedSet.includes(t));
  return { regime: disrupted ? tags[0] : 'settled', tags, disrupted };
}

export function isBackToBack(gameDateISO, teamRecentDates) {
  if (!gameDateISO || !Array.isArray(teamRecentDates)) return false;
  const d = new Date(gameDateISO), prev = new Date(d.getTime() - 86400000);
  const key = prev.toISOString().slice(0, 10);
  return teamRecentDates.some((x) => String(x).slice(0, 10) === key);
}

export default { tagRegime, isBackToBack };
