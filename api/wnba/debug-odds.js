// api/wnba/debug-odds.js
//
// DEBUG ENDPOINT (June 1, 2026)
//
// Diagnose the The Odds API integration directly in the deployed environment.
// Hit /api/wnba/debug-odds in a browser after setting ODDS_API_KEY in Vercel.
//
// Tells you, without a local curl:
//   - is the key present + valid (httpStatus)
//   - how many WNBA games came back with lines
//   - the parsed total/spread for the first game (so you see the join shape)
//   - how many free-tier requests remain this month (x-requests-remaining)
//   - any warnings (key missing, 0 games, HTTP error, etc.)
//
// Safe to leave deployed: it never prints the API key.

import { fetchWnbaGameLines, isOddsConfigured } from '../_lib/wnba/oddsLines.js';

export default async function handler(req, res) {
  try {
    // noCache so each debug hit reflects the live API (costs 1 request).
    const feed = await fetchWnbaGameLines({ noCache: true });
    return res.status(200).json({
      ok: true,
      keyConfigured: isOddsConfigured(),
      audit: feed._audit,
      gameCount: feed.all.length,
      firstGame: feed.all[0] || null,
      allMatchups: feed.all.map(g => ({
        matchup: g.matchup, total: g.total, spread: g.spread, book: g.bookUsed
      })),
      hint: !isOddsConfigured()
        ? 'ODDS_API_KEY is not set. Add it in Vercel → Settings → Environment Variables, then REDEPLOY (env vars only load on a fresh deploy).'
        : (feed.all.length === 0
            ? 'Key works but 0 games returned — either no WNBA games today, or none have posted lines yet. Try again closer to game time.'
            : 'Lines are flowing. remainingRequests shows your free-tier quota left this month.')
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
