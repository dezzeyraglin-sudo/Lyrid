// api/_lib/wnba/wnbaEmpiricalTotals.js
//
// EMPIRICAL TEAM-TOTALS STRATEGY (WNBA) — derived from a 2022–2026 backtest on
// 979 evaluable games (BalldontLie /games, final scores only). See
// WNBA_TEAM_TOTALS_BACKTEST.md for the full methodology and rejected filters.
//
// The rule compares a rolling-team projection to a PROXY LINE (rolling 30-game
// leaguewide average total), because BDL has no historical book lines. When the
// projection diverges far enough from the proxy line, the game tends to land that
// way. Edges are tiered BRONZE / GOLD / PLATINUM by divergence magnitude.
//
//   OVER  (proj above proxy line):
//     BRONZE   +4 to +6   65.3%  (n=75)
//     GOLD     +6 to +9   70.1%  (n=87)
//     PLATINUM +9 or more 86.7%  (n=30)
//   UNDER (proj below proxy line AND both defenses < 160 pts allowed/g):
//     GOLD     -6 or more 74.5%  (n=55)   [single tier — data doesn't support sub-tiers]
//
// LIVE GRADING: against the proxy line until real book lines flow (manual/odds).
// KILL-RULE: disable a tier live if it drops below 50% over 20+ triggers.

const ROLL_TEAM = 10;     // games per team for off/def averages
const MIN_TEAM = 5;       // need at least this many prior games to fire
const ROLL_LEAGUE = 30;   // games for the leaguewide proxy line
const MIN_LEAGUE = 10;    // minimum league games before a proxy line is valid
const DEF_FILTER = 160;   // UNDER requires both teams' def avg below this

// Bad-data guard: exhibition/All-Star and postponed rows poison averages.
function isRealGame(g) {
  const total = (g.home_score ?? 0) + (g.away_score ?? 0);
  return g.status === 'post'
    && g.home_score > 0 && g.away_score > 0
    && total >= 100 && total <= 230;
}

/**
 * Build rolling off/def per team and a leaguewide proxy line from a list of
 * finished games (chronological). Returns a function `evaluate(homeAbbr,
 * awayAbbr)` that yields the empirical total edge for a matchup TODAY, using
 * only games that have already happened (no leakage — the caller passes history
 * that precedes the slate date).
 *
 * @param {Array} games - finished games: { date, season, home_abbr, away_abbr,
 *                         home_score, away_score, status, postseason }
 * @param {number} season - the season to scope rolling windows to
 */
export function buildEmpiricalTotals(games, season) {
  const clean = (games || [])
    .filter(isRealGame)
    .filter(g => g.season === season)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Accumulate each team's scored/allowed series and the league total series.
  const teamSeries = {};   // abbr -> [{ scored, allowed }]
  const leagueTotals = []; // [total]
  for (const g of clean) {
    const h = g.home_abbr, a = g.away_abbr;
    (teamSeries[h] = teamSeries[h] || []).push({ scored: g.home_score, allowed: g.away_score });
    (teamSeries[a] = teamSeries[a] || []).push({ scored: g.away_score, allowed: g.home_score });
    leagueTotals.push(g.home_score + g.away_score);
  }

  const avgLast = (arr, key, n) => {
    if (!arr || arr.length < MIN_TEAM) return null;
    const slice = arr.slice(-n);
    return slice.reduce((s, x) => s + x[key], 0) / slice.length;
  };

  const proxyLine = leagueTotals.length >= MIN_LEAGUE
    ? leagueTotals.slice(-ROLL_LEAGUE).reduce((s, t) => s + t, 0) / Math.min(leagueTotals.length, ROLL_LEAGUE)
    : null;

  function evaluate(homeAbbr, awayAbbr) {
    if (proxyLine == null) return null;
    const hOff = avgLast(teamSeries[homeAbbr], 'scored', ROLL_TEAM);
    const hDef = avgLast(teamSeries[homeAbbr], 'allowed', ROLL_TEAM);
    const aOff = avgLast(teamSeries[awayAbbr], 'scored', ROLL_TEAM);
    const aDef = avgLast(teamSeries[awayAbbr], 'allowed', ROLL_TEAM);
    if (hOff == null || aOff == null || hDef == null || aDef == null) return null;

    const projTotal = (hOff + aDef) / 2 + (aOff + hDef) / 2;
    const signal = projTotal - proxyLine;       // + = lean over, - = lean under
    const combDef = hDef + aDef;

    const base = {
      projTotal: Math.round(projTotal * 10) / 10,
      proxyLine: Math.round(proxyLine * 10) / 10,
      signal: Math.round(signal * 10) / 10,
      combDef: Math.round(combDef * 10) / 10,
      homeOff: Math.round(hOff * 10) / 10, homeDef: Math.round(hDef * 10) / 10,
      awayOff: Math.round(aOff * 10) / 10, awayDef: Math.round(aDef * 10) / 10,
    };

    // OVER tiers by magnitude.
    if (signal >= 9) return { ...base, side: 'OVER', tier: 'PLATINUM', backtestWR: 86.7, backtestN: 30 };
    if (signal >= 6) return { ...base, side: 'OVER', tier: 'GOLD', backtestWR: 70.1, backtestN: 87 };
    if (signal >= 4) return { ...base, side: 'OVER', tier: 'BRONZE', backtestWR: 65.3, backtestN: 75 };

    // UNDER — single GOLD tier, requires the defense filter to qualify.
    if (signal <= -6 && combDef < DEF_FILTER) {
      return { ...base, side: 'UNDER', tier: 'GOLD', backtestWR: 74.5, backtestN: 55 };
    }

    // No qualifying edge.
    return { ...base, side: null, tier: null };
  }

  return {
    evaluate,
    proxyLine: proxyLine == null ? null : Math.round(proxyLine * 10) / 10,
    _audit: {
      season,
      cleanGames: clean.length,
      teamsTracked: Object.keys(teamSeries).length,
      leagueGames: leagueTotals.length,
      proxyLineValid: proxyLine != null,
    },
  };
}
