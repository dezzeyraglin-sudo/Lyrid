// api/wnba/results.js
//
// ACTUAL RESULTS ENDPOINT — ESPN (migrated Aug 2026)
//
// Returns real per-player box-score lines for a date so the History tab can grade
// tracked predictions (win/loss vs the line) and measure projection error.
//
//   GET /api/wnba/results?date=YYYY-MM-DD
//   -> { ok, date, byPlayer: { "Name": { points, rebounds, assists, threes,
//        pra, minutes, didPlay, final } }, byGame, byMatchup, audit }
//
// Migrated off BallDontLie (which required BDL_API_KEY + GOAT tier and was the last
// endpoint still importing bdlFeed.js — the source of the 5xx once the key/module
// went away). ESPN's box scores are free and keyless. Grading stays client-side;
// this endpoint only supplies ground truth. Never throws — degrades to empty maps.

import { getScoreboard, getBoxScore } from '../_lib/wnba/wnbaFeedEspn.js';

const ESPN_TO_SLATE = {
  ATL: 'ATL', CHI: 'CHI', CON: 'CON', DAL: 'DAL', GS: 'GSV', IND: 'IND',
  LA: 'LAS', LV: 'LVA', MIN: 'MIN', NY: 'NYL', PHX: 'PHX', POR: 'POR',
  SEA: 'SEA', TOR: 'TOR', WSH: 'WAS',
};
const tri = (a) => ESPN_TO_SLATE[String(a || '').toUpperCase()] || String(a || '').toUpperCase();

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: 'date=YYYY-MM-DD required' });
  }
  const ymd = date.replace(/-/g, '');
  const byPlayer = {};
  const byGame = {};
  const byMatchup = {};
  let gamesSeen = 0, finalGames = 0;

  try {
    const sb = await getScoreboard(ymd).catch(() => []);
    gamesSeen = sb.length;

    // Final team scores — works even when box scores aren't up yet (e.g. all-star).
    for (const g of sb) {
      const home = tri(g.home), away = tri(g.away);
      const isFinal = String(g.status || '').toUpperCase().includes('FINAL');
      if (isFinal) finalGames++;
      byGame[g.eventId] = {
        home, away, homeScore: g.homeScore, awayScore: g.awayScore, final: isFinal,
      };
      // Team-keyed matchup lookup (for/against + win), both directions.
      if (Number.isFinite(g.homeScore) && Number.isFinite(g.awayScore)) {
        byMatchup[home] = { opp: away, for: g.homeScore, against: g.awayScore, win: g.homeScore > g.awayScore, final: isFinal };
        byMatchup[away] = { opp: home, for: g.awayScore, against: g.homeScore, win: g.awayScore > g.homeScore, final: isFinal };
      }
    }

    // Per-player lines from box scores (only for games that are final).
    const finals = sb.filter(g => String(g.status || '').toUpperCase().includes('FINAL'));
    const boxes = await Promise.all(finals.map(g =>
      getBoxScore(g.eventId).then(rows => ({ g, rows })).catch(() => ({ g, rows: [] }))
    ));
    for (const { g, rows } of boxes) {
      for (const r of rows) {
        if (!r.player) continue;
        const pts = Number(r.pts) || 0, reb = Number(r.reb) || 0, ast = Number(r.ast) || 0;
        const min = Number(r.minutes) || 0;
        byPlayer[r.player] = {
          points: pts, rebounds: reb, assists: ast,
          threes: Number(r.fg3m) || 0,
          pra: pts + reb + ast,
          minutes: min,
          didPlay: min > 0,
          team: tri(r.team),
          final: true,
        };
      }
    }

    return res.status(200).json({
      ok: true,
      date,
      byPlayer,
      playerCount: Object.keys(byPlayer).length,
      byGame,
      byMatchup,
      audit: { source: 'espn', gamesSeen, finalGames, players: Object.keys(byPlayer).length, fetchedAt: new Date().toISOString() },
    });
  } catch (err) {
    // Never 5xx the History tab — return an empty-but-valid payload.
    return res.status(200).json({
      ok: true, date, byPlayer: {}, playerCount: 0, byGame: {}, byMatchup: {},
      audit: { source: 'espn', error: err.message, degraded: true },
    });
  }
}
