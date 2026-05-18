// api/wnba/debug-bbref-parse.js
//
// Verifies bbrefClient.js can fetch AND parse a live basketball-reference page
// from Vercel. This is the make-or-break test before we build the data layer.
//
// Tests:
//   1. Fetch the 2026 WNBA season page
//   2. Extract the per_game_stats table
//   3. Parse rows
//   4. Return row count + first 3 rows + identified table IDs on the page

import { fetchBbrefPage, unwrapCommentedTables, extractTableHtml, parseTableRows } from '../_lib/wnba/bbrefClient.js';

export default async function handler(req, res) {
  try {
    const startedAt = Date.now();

    // Fetch the 2026 season page
    const html = await fetchBbrefPage('/wnba/years/2026.html');
    if (!html) {
      return res.status(200).json({
        ok: false,
        stage: 'fetch',
        message: 'fetchBbrefPage returned null',
        durationMs: Date.now() - startedAt
      });
    }

    // Unwrap commented tables
    const unwrapped = unwrapCommentedTables(html);

    // Find all table IDs on the page (so we know what's available)
    const allTableIds = [...new Set(
      [...unwrapped.matchAll(/<table[^>]*\sid="([^"]+)"[^>]*>/g)].map(m => m[1])
    )];

    // Try to find the per-game table (likely IDs based on bbref conventions)
    const candidateIds = ['per_game_stats', 'per_game', 'per_game-team', 'totals_stats', 'advanced_stats'];
    const tableSamples = {};

    for (const id of candidateIds) {
      const tableHtml = extractTableHtml(unwrapped, id);
      if (tableHtml) {
        const rows = parseTableRows(tableHtml);
        tableSamples[id] = {
          found: true,
          rowCount: rows.length,
          columnNames: rows[0] ? Object.keys(rows[0]) : [],
          firstThreeRows: rows.slice(0, 3)
        };
      } else {
        tableSamples[id] = { found: false };
      }
    }

    return res.status(200).json({
      ok: true,
      durationMs: Date.now() - startedAt,
      pageSize: html.length,
      pageSizeAfterUnwrap: unwrapped.length,
      allTableIds,
      tableSamples,
      htmlSnippet: html.slice(0, 500)
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      stage: 'handler',
      error: err.message,
      stack: err.stack?.slice(0, 1000)
    });
  }
}
