// api/tennis/analyze.mjs — serves a match read off the precomputed tennis_serve_index.json.
// Mirrors api/cs2/analyze: GET /api/tennis/analyze?a=<id|name>&b=<id|name>&surface=Hard&bestOf=3
//   &acesA=15.5&totalGames=22.5&dfA=2.5&rankA=5&rankB=8&h2h=10-4
// Returns the same read object buildMatchRead produces (all props bet:false until graded).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMatchRead } from '../../tennis/tennisMatchRead.js';

// Load + cache the index once per warm lambda. Adjust the path to wherever you commit/store it.
let INDEX = null;
function loadIndex() {
  if (INDEX) return INDEX;
  const candidates = [
    process.env.TENNIS_INDEX_PATH,
    join(process.cwd(), 'tennis', 'tennis_serve_index.json'),
    join(process.cwd(), 'tennis_serve_index.json'),
    join(process.cwd(), 'public', 'tennis_serve_index.json'),
    join(process.cwd(), 'data', 'tennis_serve_index.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { INDEX = JSON.parse(readFileSync(p, 'utf8')); return INDEX; } catch { /* try next */ }
  }
  throw new Error('tennis_serve_index.json not found — run tennisFeatureBuilder.js and commit/store it');
}

// Resolve a player by exact id, then case-insensitive name match.
function resolve(index, key) {
  if (key == null) return null;
  const k = String(key).trim();
  if (index.players[k]) return { id: k, ...index.players[k] };
  const kl = k.toLowerCase();
  for (const [id, p] of Object.entries(index.players)) {
    if ((p.name || '').toLowerCase() === kl) return { id, ...p };
  }
  // loose contains-match as a last resort
  for (const [id, p] of Object.entries(index.players)) {
    if ((p.name || '').toLowerCase().includes(kl)) return { id, ...p };
  }
  return null;
}

const num = (v) => (v == null || v === '' ? null : Number(v));

export default function handler(req, res) {
  try {
    const q = req.query || {};
    const index = loadIndex();
    const playerA = resolve(index, q.a);
    const playerB = resolve(index, q.b);
    if (!playerA || !playerB) {
      res.status(404).json({ error: 'player not found', a: !!playerA, b: !!playerB,
        hint: 'pass ATP/WTA id or exact name as in the index' });
      return;
    }
    const read = buildMatchRead({
      playerA, playerB,
      surface: q.surface || 'Hard',
      bestOf: num(q.bestOf) || 3,
      rankA: num(q.rankA) ?? playerA.rank ?? null,
      rankB: num(q.rankB) ?? playerB.rank ?? null,
      h2h: q.h2h || null,
      recentRetirementA: q.retA === '1' || q.retA === 'true',
      recentRetirementB: q.retB === '1' || q.retB === 'true',
      lines: {
        acesA: num(q.acesA), acesB: num(q.acesB),
        dfA: num(q.dfA), totalGames: num(q.totalGames),
        fantasyA: num(q.fantasyA), fantasyB: num(q.fantasyB),
      },
      sims: 4000,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, builtFrom: index.meta?.built || null, read });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
