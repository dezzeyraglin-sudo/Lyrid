// api/wnba/debug-bbref-parse.js
//
// Probes multiple basketball-reference pages to identify what tables are
// where. Useful for fixing URL paths and table IDs without redeploying
// wnbaPlayerData.js for each test.

import { fetchBbrefPage, unwrapCommentedTables, extractTableHtml, parseTableRows } from '../_lib/wnba/bbrefClient.js';

async function probePage(path) {
  const html = await fetchBbrefPage(path);
  if (!html) return { path, error: 'fetch returned null' };

  const unwrapped = unwrapCommentedTables(html);
  const allTableIds = [...new Set(
    [...unwrapped.matchAll(/<table[^>]*\sid="([^"]+)"[^>]*>/g)].map(m => m[1])
  )];

  // For each table, get its row count
  const tables = allTableIds.map(id => {
    const tableHtml = extractTableHtml(unwrapped, id);
    const rows = parseTableRows(tableHtml);
    return {
      id,
      rowCount: rows.length,
      sampleColumns: rows[0] ? Object.keys(rows[0]).slice(0, 10) : [],
      firstRow: rows[0] || null
    };
  });

  return {
    path,
    pageSize: html.length,
    allTableIds,
    tables: tables.slice(0, 10)  // limit to first 10 for response size
  };
}

export default async function handler(req, res) {
  try {
    const season = req.query?.season || '2026';
    const startedAt = Date.now();

    // Probe the main page AND the candidate sub-pages
    const [main, perGame, totals, advanced] = await Promise.all([
      probePage(`/wnba/years/${season}.html`),
      probePage(`/wnba/years/${season}_per_game.html`),
      probePage(`/wnba/years/${season}_totals.html`),
      probePage(`/wnba/years/${season}_advanced.html`)
    ]);

    return res.status(200).json({
      ok: true,
      season,
      durationMs: Date.now() - startedAt,
      pages: { main, perGame, totals, advanced }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack?.slice(0, 1000) });
  }
}
