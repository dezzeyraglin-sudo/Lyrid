// =============================================================================
// /api/audit/load — Drop #20 (June 7, 2026)
//
// GET endpoint. Returns the user's full audit corpus, transformed back into
// the SAME shape the client uses in state.projectionAudit / state.hrAudit so
// hydration is a direct merge.
//
// Query params:
//   ?since=ISO8601   — optional; only return rows with updated_at > since
//                      (used for incremental refresh — small payload after first load)
//
// Response:
// {
//   "ok": true,
//   "projectionAudit": {
//     "2026-06-07_777012": { gamePk, date, awayTeam, homeTeam, projTotal,
//                            actualTotal, actualAwayRuns, actualHomeRuns,
//                            homeWinProb, graded, ... }
//   },
//   "hrAudit": {
//     "entries": [{ id, date, gamePk, hitterId, ..., actualHR, graded, ... }],
//     "byTier": { ...rollup over loaded entries... }
//   },
//   "watermark": "2026-06-07T18:42:11.123Z"   // pass back as ?since= next time
// }
// =============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const PAGE = 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  const userId = userData.user.id;

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const since = req.query.since || null;
  const sinceDate = since ? new Date(since) : null;
  const sinceValid = sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate.toISOString() : null;

  // -------------------------------------------------------------------------
  // Fetch projection_audit
  // -------------------------------------------------------------------------
  let projectionRows = [];
  {
    let from = 0;
    while (true) {
      let q = sb.from('projection_audit').select('*').eq('user_id', userId)
        .order('updated_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (sinceValid) q = q.gt('updated_at', sinceValid);
      const { data, error } = await q;
      if (error) {
        console.error('[audit/load] projection fetch error', error);
        return res.status(500).json({ error: 'projection fetch failed', message: error.message });
      }
      if (!data || data.length === 0) break;
      projectionRows = projectionRows.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  // -------------------------------------------------------------------------
  // Fetch hr_audit
  // -------------------------------------------------------------------------
  let hrRows = [];
  {
    let from = 0;
    while (true) {
      let q = sb.from('hr_audit').select('*').eq('user_id', userId)
        .order('updated_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (sinceValid) q = q.gt('updated_at', sinceValid);
      const { data, error } = await q;
      if (error) {
        console.error('[audit/load] hr fetch error', error);
        return res.status(500).json({ error: 'hr fetch failed', message: error.message });
      }
      if (!data || data.length === 0) break;
      hrRows = hrRows.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  // -------------------------------------------------------------------------
  // Transform back into client-shaped state.projectionAudit
  //   { "{date}_{gamePk}": { gamePk, date, awayTeam, homeTeam,
  //                          projTotal, actualTotal, actualAwayRuns,
  //                          actualHomeRuns, homeWinProb, graded } }
  // -------------------------------------------------------------------------
  const projectionAudit = {};
  for (const r of projectionRows) {
    const merged = (r.raw && typeof r.raw === 'object') ? { ...r.raw } : {};
    merged.gamePk = r.game_pk;
    merged.date = r.game_date;
    merged.awayTeam = r.away_team || merged.awayTeam;
    merged.homeTeam = r.home_team || merged.homeTeam;
    merged.projTotal = numOrUndef(r.proj_total);
    merged.actualTotal = numOrUndef(r.actual_total);
    merged.actualAwayRuns = intOrUndef(r.actual_away_runs);
    merged.actualHomeRuns = intOrUndef(r.actual_home_runs);
    merged.homeWinProb = numOrUndef(r.home_win_prob);
    merged.graded = !!r.graded;
    projectionAudit[r.audit_key] = merged;
  }

  // -------------------------------------------------------------------------
  // Transform back into client-shaped state.hrAudit
  //   { entries: [...], byTier: { elite:{hits,misses}, strong:..., solid:... } }
  // The client also has empirical-tier rollup via getHrAuditStats(), which
  // is computed from entries on the fly — we don't need to send that.
  // -------------------------------------------------------------------------
  const hrEntries = hrRows.map(r => ({
    id: r.entry_id,
    date: r.game_date,
    gamePk: r.game_pk,
    hitterId: r.hitter_id,
    hitterName: r.hitter_name,
    team: r.team,
    opponent: r.opponent,
    pitcherName: r.pitcher_name,
    hrTier: r.hr_tier,
    hrScore: r.hr_score,
    criteria: Array.isArray(r.criteria) ? r.criteria : [],
    empiricalTier: r.empirical_tier,
    empiricalTierLabel: r.empirical_tier_label,
    empiricalBacktestRate: numOrNull(r.empirical_backtest_rate),
    empiricalBacktestN: intOrNull(r.empirical_backtest_n),
    _empBarrel: numOrNull(r.emp_barrel),
    _empHrPer9: numOrNull(r.emp_hr_per_9),
    _empParkBoost: numOrNull(r.emp_park_boost),
    actualHR: r.actual_hr == null ? null : !!r.actual_hr,
    graded: !!r.graded,
    line: r.line || (r.line_hr != null ? { PA: r.line_pa, HR: r.line_hr } : null),
    loggedAt: r.logged_at != null ? Number(r.logged_at) : null
  }));

  // Compute legacy byTier rollup over loaded entries
  const byTier = {
    elite:  { hits: 0, misses: 0 },
    strong: { hits: 0, misses: 0 },
    solid:  { hits: 0, misses: 0 }
  };
  for (const e of hrEntries) {
    if (!e.graded || e.actualHR == null) continue;
    if (!byTier[e.hrTier]) continue;
    if (e.actualHR) byTier[e.hrTier].hits++;
    else byTier[e.hrTier].misses++;
  }

  // Watermark for next incremental call
  let watermark = sinceValid || new Date(0).toISOString();
  for (const r of [...projectionRows, ...hrRows]) {
    if (r.updated_at && r.updated_at > watermark) watermark = r.updated_at;
  }

  return res.status(200).json({
    ok: true,
    projectionAudit,
    hrAudit: { entries: hrEntries, byTier },
    watermark,
    counts: {
      projectionAudit: projectionRows.length,
      hrAudit: hrEntries.length
    }
  });
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function numOrUndef(v) {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function intOrUndef(v) {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
