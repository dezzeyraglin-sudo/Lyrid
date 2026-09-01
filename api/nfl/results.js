// api/nfl/results.js — Lyrid NFL box-score results (for prop grading).
// GET /api/nfl/results?date=YYYY-MM-DD
//
// Mirrors /api/nfl/slate's ESPN stack (same site.api.espn.com used for inactives
// and odds). Returns per-player final yardage so the frontend gradeNflProps() can
// grade logged bets — same shape as /api/wnba/results:
//   { ok, date, byPlayer: { <normName>: { player, team, final, didPlay,
//        passing_yards, rushing_yards, receiving_yards } } }
//
// Grading is near-live: a game's players appear as soon as ESPN posts the box
// score, and `final` flips true when the game completes. The frontend refuses to
// grade today's non-final games (same guard WNBA uses) so a live line isn't graded.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const UA = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Lyrid analytics)' };

// name normalizer — MUST match gradeNflProps() on the frontend so keys line up
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ').trim();
}
function ydsIdx(labels) {
  if (!Array.isArray(labels)) return -1;
  for (let i = 0; i < labels.length; i++) if (String(labels[i]).toUpperCase() === 'YDS') return i;
  return -1;
}
function pnum(v) { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; }

export default async function handler(req, res) {
  const date = (req.query && req.query.date) || new Date().toISOString().slice(0, 10);
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  const ymd = String(date).replace(/-/g, '');
  const byPlayer = {};

  try {
    const sb = await fetch(`${ESPN}/scoreboard?dates=${ymd}`, { headers: UA }).then(r => r.ok ? r.json() : null);
    const events = (sb && sb.events) || [];
    if (!events.length) return res.status(200).json({ ok: true, date, count: 0, byPlayer, note: 'no games for this date' });

    // one summary per game (box scores live here), best-effort in parallel
    const summaries = await Promise.all(events.map(e =>
      fetch(`${ESPN}/summary?event=${e.id}`, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null)));

    for (const s of summaries) {
      if (!s) continue;
      const comp = s.header && s.header.competitions && s.header.competitions[0];
      const final = !!(comp && comp.status && comp.status.type && comp.status.type.completed);
      const teamBlocks = (s.boxscore && s.boxscore.players) || [];
      for (const tb of teamBlocks) {
        const teamAbbr = (tb.team && tb.team.abbreviation) || null;
        for (const cat of (tb.statistics || [])) {
          const nm = String(cat.name || '').toLowerCase();
          const fam = nm.indexOf('passing') === 0 ? 'passing_yards'
            : nm.indexOf('rushing') === 0 ? 'rushing_yards'
            : nm.indexOf('receiving') === 0 ? 'receiving_yards' : null;
          if (!fam) continue;
          const yi = ydsIdx(cat.labels);
          if (yi < 0) continue;
          for (const a of (cat.athletes || [])) {
            const dn = a.athlete && a.athlete.displayName;
            if (!dn) continue;
            const k = norm(dn);
            if (!byPlayer[k]) byPlayer[k] = { player: dn, team: teamAbbr, final, didPlay: true };
            byPlayer[k][fam] = pnum((a.stats || [])[yi]);
            byPlayer[k].final = byPlayer[k].final || final;
          }
        }
      }
    }
    return res.status(200).json({ ok: true, date, count: Object.keys(byPlayer).length, byPlayer });
  } catch (e) {
    return res.status(200).json({ ok: false, date, error: String((e && e.message) || e), byPlayer: {} });
  }
}
