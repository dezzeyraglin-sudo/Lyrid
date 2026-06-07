// =============================================================================
// /api/audit/sync — Drop #20 (June 7, 2026)
//
// POST endpoint that accepts a payload of audit changes from the client and
// upserts them into Supabase. Fixes the cross-device bug where empirical
// strategies (Drop #12 totals/ML, Drop #16 HR-trap, Drop #17/18 HR tiers)
// only fired on devices that had locally accumulated history.
//
// Auth: requires a valid Supabase session via the Authorization header
// (set up by the global fetch wrapper in index.html line ~3773).
//
// Body shape:
// {
//   "projectionAudit": [               // optional; array of game-level entries
//     {
//       "auditKey": "2026-06-07_777012", "gamePk": 777012, "date": "2026-06-07",
//       "awayTeam": "MIL", "homeTeam": "COL",
//       "projTotal": 11.85, "actualTotal": null, "graded": false,
//       "actualAwayRuns": null, "actualHomeRuns": null,
//       "homeWinProb": 0.48,
//       "raw": { ...full client object... }
//     }
//   ],
//   "hrAudit": [                       // optional; array of hitter-level entries
//     {
//       "id": "2026-06-07_777012_660271", "gamePk": 777012, "date": "2026-06-07",
//       "hitterId": 660271, "hitterName": "...", "team": "MIL", "opponent": "COL",
//       "pitcherName": "...", "hrTier": "elite", "hrScore": 142,
//       "criteria": [...],
//       "empiricalTier": "elite", "empiricalTierLabel": "ELITE",
//       "empiricalBacktestRate": 0.545, "empiricalBacktestN": 11,
//       "_empBarrel": 15.4, "_empHrPer9": 2.1, "_empParkBoost": 25,
//       "actualHR": null, "graded": false, "line": null, "loggedAt": 1717800000000
//     }
//   ]
// }
//
// Response:
// {
//   "ok": true,
//   "projectionAuditUpserted": N,
//   "hrAuditUpserted": M
// }
//
// Idempotent: re-sending the same payload yields the same end state.
// =============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Max payload guards — protects against pathological client sends
const MAX_PROJECTION_BATCH = 1000;
const MAX_HR_BATCH = 5000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authn — pull access token from Authorization header
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  // Verify the token and get the user
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  const userId = userData.user.id;

  // Service-role client for the actual writes (bypasses RLS since we already
  // proved who the user is). We FORCE user_id = userId on every row.
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const body = req.body || {};
  const projection = Array.isArray(body.projectionAudit) ? body.projectionAudit : [];
  const hr = Array.isArray(body.hrAudit) ? body.hrAudit : [];

  if (projection.length > MAX_PROJECTION_BATCH) {
    return res.status(413).json({ error: `projectionAudit batch too large (${projection.length} > ${MAX_PROJECTION_BATCH})` });
  }
  if (hr.length > MAX_HR_BATCH) {
    return res.status(413).json({ error: `hrAudit batch too large (${hr.length} > ${MAX_HR_BATCH})` });
  }

  let projectionUpserted = 0;
  let hrUpserted = 0;
  const errors = [];

  // -------------------------------------------------------------------------
  // Upsert projection_audit rows
  // -------------------------------------------------------------------------
  if (projection.length > 0) {
    const rows = projection
      .filter(p => p && p.auditKey && p.gamePk && p.date)
      .map(p => ({
        user_id: userId,
        audit_key: String(p.auditKey),
        game_pk: Number(p.gamePk),
        game_date: String(p.date),
        away_team: p.awayTeam || null,
        home_team: p.homeTeam || null,
        proj_total: numOrNull(p.projTotal),
        actual_total: numOrNull(p.actualTotal),
        actual_away_runs: intOrNull(p.actualAwayRuns),
        actual_home_runs: intOrNull(p.actualHomeRuns),
        home_win_prob: numOrNull(p.homeWinProb),
        graded: Boolean(p.graded),
        raw: p.raw || null
      }));

    if (rows.length > 0) {
      const { error, count } = await sb
        .from('projection_audit')
        .upsert(rows, { onConflict: 'user_id,audit_key', count: 'exact' });
      if (error) {
        console.error('[audit/sync] projection upsert error', error);
        errors.push({ table: 'projection_audit', message: error.message });
      } else {
        projectionUpserted = count != null ? count : rows.length;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Upsert hr_audit rows
  // -------------------------------------------------------------------------
  if (hr.length > 0) {
    const rows = hr
      .filter(e => e && e.id && e.gamePk && e.date)
      .map(e => ({
        user_id: userId,
        entry_id: String(e.id),
        game_pk: Number(e.gamePk),
        game_date: String(e.date),
        hitter_id: intOrNull(e.hitterId),
        hitter_name: e.hitterName || null,
        team: e.team || null,
        opponent: e.opponent || null,
        pitcher_name: e.pitcherName || null,
        hr_tier: e.hrTier || null,
        hr_score: intOrNull(e.hrScore),
        criteria: Array.isArray(e.criteria) ? e.criteria : null,
        empirical_tier: e.empiricalTier || null,
        empirical_tier_label: e.empiricalTierLabel || null,
        empirical_backtest_rate: numOrNull(e.empiricalBacktestRate),
        empirical_backtest_n: intOrNull(e.empiricalBacktestN),
        emp_barrel: numOrNull(e._empBarrel),
        emp_hr_per_9: numOrNull(e._empHrPer9),
        emp_park_boost: numOrNull(e._empParkBoost),
        actual_hr: e.actualHR == null ? null : Boolean(e.actualHR),
        graded: Boolean(e.graded),
        line_pa: intOrNull(e.line?.PA),
        line_hr: intOrNull(e.line?.HR),
        line: e.line || null,
        logged_at: intOrNull(e.loggedAt)
      }));

    if (rows.length > 0) {
      // Supabase has a row-count limit per upsert call. Chunk to be safe.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const { error, count } = await sb
          .from('hr_audit')
          .upsert(chunk, { onConflict: 'user_id,entry_id', count: 'exact' });
        if (error) {
          console.error('[audit/sync] hr upsert error', error);
          errors.push({ table: 'hr_audit', message: error.message, chunk: i / CHUNK });
          break;
        }
        hrUpserted += count != null ? count : chunk.length;
      }
    }
  }

  return res.status(200).json({
    ok: errors.length === 0,
    projectionAuditUpserted: projectionUpserted,
    hrAuditUpserted: hrUpserted,
    errors: errors.length > 0 ? errors : undefined
  });
}

// ---------------------------------------------------------------------------
// Helpers — coerce client values, returning null when missing/invalid so we
// don't trip Postgres NOT NULL constraints on optional columns.
// ---------------------------------------------------------------------------
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
