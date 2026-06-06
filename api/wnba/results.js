// api/wnba/results.js
//
// ACTUAL RESULTS ENDPOINT (June 2, 2026)
//
// Returns real per-player box-score lines for a date so the History tab can
// grade tracked predictions (win/loss vs the line) and measure projection error.
//
//   GET /api/wnba/results?date=YYYY-MM-DD
//   -> { ok, date, byPlayer: { "Name": { points, rebounds, assists, threes,
//        pra, minutes, didPlay, final } }, audit }
//
// Grading is done client-side (the history store lives in the browser); this
// endpoint only supplies the ground truth. Requires BDL_API_KEY + GOAT tier for
// the stats endpoint; degrades to an empty map otherwise (history stays pending).

import { fetchWnbaPlayerStats, fetchWnbaGameScores, isBdlConfigured } from '../_lib/wnba/bdlFeed.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: 'date=YYYY-MM-DD required' });
  }
  try {
    const [stats, scores] = await Promise.all([
      fetchWnbaPlayerStats(date, { noCache: true }),
      fetchWnbaGameScores(date, { noCache: true }),
    ]);
    return res.status(200).json({
      ok: true,
      date,
      keyConfigured: isBdlConfigured(),
      byPlayer: stats.byPlayer,
      playerCount: Object.keys(stats.byPlayer).length,
      byGame: scores.byGame,          // final team scores (works on ALL-STAR)
      byMatchup: scores.byMatchup,
      audit: stats._audit,
      scoresAudit: scores._audit,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
