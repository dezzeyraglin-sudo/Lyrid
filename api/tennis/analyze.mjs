// api/tennis/analyze.mjs — serves a match read off the precomputed tennis_serve_index.json.
// Mirrors api/cs2/analyze: GET /api/tennis/analyze?a=<id|name>&b=<id|name>&surface=Hard&bestOf=3
//   &acesA=15.5&totalGames=22.5&dfA=2.5&rankA=5&rankB=8&h2h=10-4
// Returns the same read object buildMatchRead produces (all props bet:false until graded).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMatchRead } from '../../tennis/tennisMatchRead.js';
import { augmentMatchup } from '../../tennis/tennisLiveAugment.mjs';
import { makeMatchstatSource } from '../../tennis/tennisMatchstat.mjs';
import { makeApiTennisSource } from '../../tennis/tennisApiTennis.mjs';
import { resolveWithColdStart } from '../../tennis/tennisColdStart.mjs';
import { eloFromJSON, eloWinProb } from '../../tennis/tennisElo.js';

// Live source: prefer api-tennis.com if its key is set, else Matchstat. Either is optional —
// with neither, reads still work off the index (just with build-time form instead of live).
const LIVE = process.env.APITENNIS_KEY
  ? makeApiTennisSource({ apiKey: process.env.APITENNIS_KEY })
  : (process.env.MATCHSTAT_KEY ? makeMatchstatSource({ apiKey: process.env.MATCHSTAT_KEY }) : null);
const LIVE_NAME = process.env.APITENNIS_KEY ? 'api-tennis' : (process.env.MATCHSTAT_KEY ? 'matchstat' : null);

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
// Resolve a player. Feeds hand us abbreviated names ("D. Jade", "A. Sasnovich") while the index
// holds full names ("Damir Jade"), so exact matching alone fails and the board's readable flag
// disagrees with what analyze can actually find. Match on last name + first initial — the SAME rule
// schedule.mjs uses — so the two stay in sync.
// NEVER fall back to a loose substring match: `includes("d.")` happily matches half the tour and
// silently returns a read for the WRONG player, which is worse than no read at all.
function normName(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameKey(s) {
  const t = normName(s).split(' ').filter(Boolean);
  if (!t.length) return null;
  return `${t[t.length - 1]}|${(t[0] || ' ')[0]}`;   // lastname|firstInitial
}
function resolve(index, key) {
  if (key == null) return null;
  const k = String(key).trim();
  if (!k) return null;
  if (index.players[k]) return { id: k, ...index.players[k] };          // exact id
  const target = normName(k);
  const entries = Object.entries(index.players);
  for (const [id, p] of entries) if (normName(p.name) === target) return { id, ...p };  // exact name
  // last name + first initial; if it's ambiguous prefer the player with the most matches
  const want = nameKey(k);
  if (!want) return null;
  const hits = entries.filter(([, p]) => nameKey(p.name) === want);
  if (!hits.length) return null;
  hits.sort((a, b) => ((b[1].surfaces?.ALL?.n || 0) - (a[1].surfaces?.ALL?.n || 0)));
  const [id, p] = hits[0];
  return { id, ...p, _matchedBy: hits.length > 1 ? 'lastname+initial (ambiguous)' : 'lastname+initial' };
}

const num = (v) => (v == null || v === '' ? null : Number(v));

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const index = loadIndex();
    let playerA = resolve(index, q.a);
    let playerB = resolve(index, q.b);

    // Index miss → build the player from the live source's recent matches (ITF, Challenger, new
    // pros). Only possible with a live key; without one we still have to 404.
    let coldA = false, coldB = false;
    if ((!playerA || !playerB) && LIVE && q.live !== '0') {
      const [ra, rb] = await Promise.all([
        resolveWithColdStart(LIVE, playerA, q.a).catch(() => ({ player: playerA, coldStart: false })),
        resolveWithColdStart(LIVE, playerB, q.b).catch(() => ({ player: playerB, coldStart: false })),
      ]);
      playerA = ra.player; coldA = ra.coldStart;
      playerB = rb.player; coldB = rb.coldStart;
    }
    if (!playerA || !playerB) {
      res.status(404).json({ error: 'player not found', a: !!playerA, b: !!playerB,
        hint: LIVE ? 'not in the index and the live source has no recent matches for them'
                   : 'not in the index; set APITENNIS_KEY or MATCHSTAT_KEY to read off-index players' });
      return;
    }
    // Refresh recent form/fatigue from the live source (index stays the deep baseline). Never fatal.
    // Cold-start players are already built from live data — no need to re-fetch them.
    let live = false;
    if (LIVE && q.live !== '0' && !(coldA && coldB)) {
      try {
        const aug = await augmentMatchup(LIVE, playerA, playerB);
        if (!coldA) playerA = aug.playerA;
        if (!coldB) playerB = aug.playerB;
        live = true;
      } catch { /* fall back to index-only */ }
    }
    // Elo anchor: surface Elo from the index supplies the win probability the point rates can't
    // (level-biased + gauge-degenerate). Cold-start players have no Elo → falls back to rates.
    let ewp = null;
    try {
      if (index.elo && !coldA && !coldB) {
        const E = eloFromJSON(index.elo);
        const idA = Object.keys(index.players).find((k) => index.players[k] === playerA);
        const idB = Object.keys(index.players).find((k) => index.players[k] === playerB);
        if (idA && idB) ewp = eloWinProb(E, idA, idB, q.surface || 'Hard');
      }
    } catch { /* rates-only fallback */ }
    const read = buildMatchRead({
      playerA, playerB, eloWinProb: ewp,
      surface: q.surface || 'Hard',
      bestOf: num(q.bestOf) || 3,
      rankA: num(q.rankA) ?? playerA.rank ?? null,
      rankB: num(q.rankB) ?? playerB.rank ?? null,
      h2h: q.h2h || null,
      h2hEdge: num(q.h2hEdge) || 0,
      recentRetirementA: q.retA === '1' || q.retA === 'true',
      recentRetirementB: q.retB === '1' || q.retB === 'true',
      lines: {
        acesA: num(q.acesA), acesB: num(q.acesB),
        dfA: num(q.dfA), totalGames: num(q.totalGames),
        fantasyA: num(q.fantasyA), fantasyB: num(q.fantasyB),
        gamesWonA: num(q.gamesWonA), gamesWonB: num(q.gamesWonB),
      },
      sims: 4000,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, live, eloAnchored: ewp != null, liveSource: (live || coldA || coldB) ? LIVE_NAME : null,
      coldStart: (coldA || coldB) ? { [q.a]: coldA, [q.b]: coldB } : null,
      builtFrom: index.meta?.built || null, read });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
