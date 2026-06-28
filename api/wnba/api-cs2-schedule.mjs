// Vercel serverless function — live CS2 schedule for a given date.
// Deploy to:  api/cs2/schedule.mjs   (route: GET /api/cs2/schedule?date=YYYY-MM-DD)
//
// Pulls today's (or any date's) fixtures from BALLDONTLIE so the CS2 tab can show
// the CURRENT slate instead of a frozen snapshot. The projection cards are still
// generated offline by matchRead --today and deployed as /cs2_reads.json; the tab
// merges these live fixtures with whatever projections are deployed (by matchId).
//
// NOTE: the /cs/v1/matches endpoint requires GOAT tier. On ALL-STAR this returns
// 401/403 and the tab falls back to the static snapshot. Key is read from the
// BDL_API_KEY env var (set it in the Vercel project settings, never commit it).

const BASE = "https://api.balldontlie.io/cs/v1";

// Which teams the projection engine can actually read (those in the deployed index).
// Cached in module scope so we only fetch the index once per warm lambda. Only the
// tiny set of team IDs is kept in memory, not the whole index.
let COVERED = null, COVERED_AT = 0;
async function loadCoverage(origin) {
  if (COVERED && Date.now() - COVERED_AT < 10 * 60 * 1000) return COVERED;
  try {
    const r = await fetch(`${origin}/cs2_kpr_index.json`, { cache: "no-store" });
    if (r.ok) {
      const idx = await r.json();
      COVERED = new Set(Object.keys(idx.teams || {}));
      COVERED_AT = Date.now();
    }
  } catch { /* keep whatever we had; null means "unknown" -> tab shows all */ }
  return COVERED;
}

export default async function handler(req, res) {
  const key = process.env.BDL_API_KEY;
  if (!key) return res.status(500).json({ error: "BDL_API_KEY not configured on the server" });

  // date param (YYYY-MM-DD); default to today in UTC
  const raw = (req.query && req.query.date) || new Date().toISOString().slice(0, 10);
  const date = String(raw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }

  try {
    const games = [];
    let cursor = null, guard = 0;
    do {
      const u = new URL(`${BASE}/matches`);
      u.searchParams.append("dates[]", date);
      u.searchParams.set("per_page", "100");
      if (cursor) u.searchParams.set("cursor", cursor);

      const r = await fetch(u, { headers: { Authorization: key } });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return res.status(r.status).json({
          error: `BDL responded ${r.status}`,
          detail: body.slice(0, 200),
          tierHint: (r.status === 401 || r.status === 403)
            ? "the matches endpoint requires GOAT tier — the tab will fall back to the static snapshot"
            : undefined,
        });
      }
      const j = await r.json();
      for (const m of j.data || []) {
        games.push({
          matchId: m.id,
          teamA: m.team1?.name ?? null,
          teamB: m.team2?.name ?? null,
          teamAId: m.team1?.id ?? null,
          teamBId: m.team2?.id ?? null,
          startTime: m.start_time ?? null,
          bestOf: m.best_of ?? null,
          status: m.status ?? null,
          tournament: m.tournament?.name ?? null,
          tier: m.tournament?.tier ?? null,
          lan: m.tournament?.is_online === false,
          stage: m.stage?.name ?? null,
          doOrDie: m.stage?.stage_type === "bracket",
        });
      }
      cursor = j.meta?.next_cursor ?? null;
    } while (cursor && ++guard < 10);

    // sort by start time so the slate reads top-to-bottom chronologically
    games.sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));

    // tag each game with whether the engine can read both teams. covered === null
    // means the index couldn't be loaded, so the tab should show everything.
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const covered = await loadCoverage(`${proto}://${host}`);
    let coveredCount = 0;
    for (const g of games) {
      if (!covered) { g.covered = null; continue; }
      g.covered = covered.has(String(g.teamAId)) && covered.has(String(g.teamBId));
      if (g.covered) coveredCount++;
    }

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json({ date, count: games.length, coveredCount, games });
  } catch (e) {
    return res.status(500).json({ error: "schedule fetch failed", detail: String(e).slice(0, 200) });
  }
}
