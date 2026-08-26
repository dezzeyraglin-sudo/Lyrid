// api/wnba/pp-lines.js — client-facing PrizePicks WNBA line feed (mirrors MLB pp-lines).
//   GET /api/wnba/pp-lines           → all WNBA lines + altIndex
//   GET /api/wnba/pp-lines?standard=1 → standard lines only (the bettable set)
// Thin wrapper over the shared fetcher so the slate and the client share one source.
import { fetchWnbaPpLines } from '../_lib/wnba/ppLines.js';

export default async function handler(req, res) {
  const standardOnly = String((req.query && req.query.standard) || '') === '1';
  const out = await fetchWnbaPpLines({ standardOnly });
  // Edge cache 3 min (same as MLB) — lines move, but not every second.
  if (out.ok) res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=300');
  return res.status(200).json(out);
}
