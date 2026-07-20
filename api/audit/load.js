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
//   "bestBetHistory": {              // (Storage Fix — July 20, 2026)
//     "2026-07-19": {
//       "2026-07-19_777012_660271": { entryId, date, gamePk, hitterId, ... }
//     }
//   },
//   "watermark": "2026-06-07T18:42:11.123Z"   // pass back as ?since= next time
// }
//
// (Storage Fix — July 20, 2026) bestBetHistory added. The client keys this
// store as state.bestBetHistory[date][entryId] (see logBestBets in index.html),
// so we return it NESTED BY DATE to make hydration a direct merge, exactly like
// projectionAudit/hrAudit.
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
  // Fetch best_bet_history  (Storage Fix — July 20, 2026)
  // -------------------------------------------------------------------------
  let bbhRows = [];
  {
    let from = 0;
    while (true) {
      let q = sb.from('best_bet_history').select('*').eq('user_id', userId)
        .order('updated_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (sinceValid) q = q.gt('updated_at', sinceValid);
      const { data, error } = await q;
      if (error) {
        console.error('[audit/load] best_bet_history fetch error', error);
        return res.status(500).json({ error: 'best_bet_history fetch failed', message: error.message });
      }
      if (!data || data.length === 0) break;
      bbhRows = bbhRows.concat(data);
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
    // (Drop #22 — June 7, 2026) Per-inning runs/hits array
    if (Array.isArray(r.innings)) merged.innings = r.innings;
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

  // -------------------------------------------------------------------------
  // Transform back into client-shaped state.bestBetHistory
  //   { "YYYY-MM-DD": { "<entryId>": { ...pick... } } }
  //
  // (Storage Fix — July 20, 2026) The full pick blob lives in the `data` jsonb
  // column; the typed columns are a queryable projection of it. We spread `data`
  // first, then overlay the typed columns — but ONLY when the typed column is
  // non-null, so a null column can never clobber a populated value inside the
  // blob. `graded` is the exception: it is NOT NULL-defaulted and is always
  // authoritative, so it always overlays.
  // -------------------------------------------------------------------------
  const bestBetHistory = {};
  for (const r of bbhRows) {
    const pick = (r.data && typeof r.data === 'object') ? { ...r.data } : {};

    pick.entryId = r.entry_id;
    if (r.game_date != null)    pick.date         = r.game_date;
    if (r.game_pk != null)      pick.gamePk       = Number(r.game_pk);
    if (r.hitter_id != null)    pick.hitterId     = r.hitter_id;
    if (r.hitter_name != null)  pick.hitterName   = r.hitter_name;
    if (r.team != null)         pick.team         = r.team;
    if (r.opponent != null)     pick.opponent     = r.opponent;
    if (r.pitcher_name != null) pick.pitcherName  = r.pitcher_name;
    if (r.prop_key != null)     pick.propKey      = r.prop_key;
    if (r.result != null)       pick.result       = r.result;
    // `tier` is deliberately NOT overlaid from the column. sync.js writes
    // `_unifiedTier || tier` there so the server can query one tier field, but
    // the client keeps these SEPARATE: `tier` holds the legacy value ('gold',
    // 'elite', 'imported') that the render/stat code branches on, while
    // `_unifiedTier` holds PLATINUM/GOLD/SILVER/LEAN. Overlaying would rewrite
    // a legacy 'gold' pick as 'PLATINUM' on every hydrate. Both fields already
    // round-trip verbatim inside the `data` blob; restore only if absent.
    if (pick.tier == null && r.tier != null) pick.tier = r.tier;
    if (r.logged_at != null)    pick.loggedAt     = Number(r.logged_at);
    pick.graded = !!r.graded;

    // Date key: prefer the typed column, fall back to the blob, then to the
    // entry_id prefix (entryIds are always `YYYY-MM-DD_...`). A pick with no
    // resolvable date is unroutable on the client, so skip it rather than
    // creating an "undefined" bucket.
    const dateKey = r.game_date || pick.date ||
      (/^\d{4}-\d{2}-\d{2}/.test(r.entry_id) ? r.entry_id.slice(0, 10) : null);
    if (!dateKey) {
      console.warn('[audit/load] skipping best_bet_history row with no date', r.entry_id);
      continue;
    }
    pick.date = dateKey;

    if (!bestBetHistory[dateKey]) bestBetHistory[dateKey] = {};
    bestBetHistory[dateKey][r.entry_id] = pick;
  }

  // Watermark for next incremental call
  let watermark = sinceValid || new Date(0).toISOString();
  for (const r of [...projectionRows, ...hrRows, ...bbhRows]) {
    if (r.updated_at && r.updated_at > watermark) watermark = r.updated_at;
  }

  return res.status(200).json({
    ok: true,
    projectionAudit,
    hrAudit: { entries: hrEntries, byTier },
    bestBetHistory,
    watermark,
    counts: {
      projectionAudit: projectionRows.length,
      hrAudit: hrEntries.length,
      bestBetHistory: bbhRows.length
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
