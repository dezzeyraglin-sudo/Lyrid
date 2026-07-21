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
//   "bestBetHistory": [                // optional; array of logged picks
//     {                                // (Storage Fix — July 20, 2026)
//       "entryId": "2026-07-19_777012_660271", "date": "2026-07-19",
//       "gamePk": 777012, "hitterId": 660271, "hitterName": "...",
//       "team": "MIL", "opponent": "COL", "pitcherName": "...",
//       "propKey": "hits", "tier": "PLATINUM",
//       "result": null, "graded": false, "loggedAt": 1752900000000,
//       ...every other field is preserved verbatim in the `data` jsonb column...
//     }
//   ]
// }
//
// Response:
// {
//   "ok": true,
//   "projectionAuditUpserted": N,
//   "hrAuditUpserted": M,
//   "bestBetHistoryUpserted": P,
//   "bestBetHistorySkippedGraded": Q   // rows refused to avoid a graded downgrade
// }
//
// Idempotent: re-sending the same payload yields the same end state.
//
// (Storage Fix — July 20, 2026) GRADED-WINS GUARD, picks only.
// The projection_audit / hr_audit paths below are blind upserts: an incoming
// graded=false overwrites a stored graded=true. For best_bet_history we read the
// stored graded flags for the incoming entry_ids first and refuse any row that
// would downgrade graded true → false. This is the exact data-loss case the
// storage fix exists to prevent (a stale device wiping a graded result), so it
// is enforced server-side where it holds no matter which client pushes.
// =============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Max payload guards — protects against pathological client sends
const MAX_PROJECTION_BATCH = 1000;
const MAX_HR_BATCH = 5000;
// (Storage Fix — July 20, 2026) The one-time backfill pushes ~900 picks; the
// client chunks them, but allow headroom so a legitimate migration can't 413.
const MAX_BBH_BATCH = 5000;

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
  // (Storage Fix — July 20, 2026) Accept either an array of picks or the
  // client's nested { date: { entryId: pick } } shape, flattened here.
  const bbh = normalizeBestBetHistory(body.bestBetHistory);

  if (projection.length > MAX_PROJECTION_BATCH) {
    return res.status(413).json({ error: `projectionAudit batch too large (${projection.length} > ${MAX_PROJECTION_BATCH})` });
  }
  if (hr.length > MAX_HR_BATCH) {
    return res.status(413).json({ error: `hrAudit batch too large (${hr.length} > ${MAX_HR_BATCH})` });
  }
  if (bbh.length > MAX_BBH_BATCH) {
    return res.status(413).json({ error: `bestBetHistory batch too large (${bbh.length} > ${MAX_BBH_BATCH})` });
  }

  let projectionUpserted = 0;
  let hrUpserted = 0;
  let bbhUpserted = 0;
  let bbhSkippedGraded = 0;
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
        raw: p.raw || null,
        // (Drop #22 — June 7, 2026) Per-inning runs/hits array
        innings: Array.isArray(p.innings) ? p.innings : null
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

  // -------------------------------------------------------------------------
  // Upsert best_bet_history rows   (Storage Fix — July 20, 2026)
  //
  // NOTE: unlike hr_audit, we do NOT require gamePk. Manually-added and
  // CSV-imported picks legitimately carry gamePk: null (see addManualBestBet /
  // the CSV importer in index.html) — filtering on it would silently drop them.
  // Only entryId and a resolvable date are required.
  // -------------------------------------------------------------------------
  if (bbh.length > 0) {
    const candidates = [];
    for (const p of bbh) {
      if (!p || !p.entryId) continue;
      const entryId = String(p.entryId);
      // entryIds are always `YYYY-MM-DD_...`; fall back to that if date is absent
      const date = p.date || (/^\d{4}-\d{2}-\d{2}/.test(entryId) ? entryId.slice(0, 10) : null);
      if (!date) continue;
      candidates.push({ entryId, date, pick: p });
    }

    // ---- Graded-wins guard: never let graded=false overwrite a stored true ----
    const storedGraded = new Map();
    if (candidates.length > 0) {
      const ids = [...new Set(candidates.map(c => c.entryId))];
      const ID_CHUNK = 500;
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await sb
          .from('best_bet_history')
          .select('entry_id, graded, result')
          .eq('user_id', userId)
          .in('entry_id', ids.slice(i, i + ID_CHUNK));
        if (error) {
          // Fail CLOSED: if we can't prove what's stored, we must not risk
          // clobbering graded results. Report and skip the picks write entirely
          // rather than performing a blind upsert.
          console.error('[audit/sync] best_bet_history graded-guard read failed', error);
          errors.push({ table: 'best_bet_history', message: 'graded guard read failed: ' + error.message });
          break;
        }
        for (const row of (data || [])) {
          storedGraded.set(row.entry_id, { graded: !!row.graded, result: row.result });
        }
      }
    }

    const guardFailed = errors.some(e => e.table === 'best_bet_history');
    if (!guardFailed && candidates.length > 0) {
      const rows = [];
      for (const { entryId, date, pick } of candidates) {
        const stored = storedGraded.get(entryId);
        const incomingGraded = Boolean(pick.graded);
        // A stored graded row is only replaced by another graded row. An
        // ungraded incoming copy of an already-graded pick is dropped whole —
        // partial merging here would let a stale device revert `result` too.
        if (stored && stored.graded && !incomingGraded) {
          bbhSkippedGraded++;
          continue;
        }
        rows.push({
          user_id: userId,
          entry_id: entryId,
          game_pk: intOrNull(pick.gamePk),
          game_date: date,
          hitter_id: intOrNull(pick.hitterId),
          hitter_name: pick.hitterName || null,
          team: pick.team || null,
          opponent: pick.opponent || null,
          pitcher_name: pick.pitcherName || null,
          prop_key: pick.propKey || null,
          // unified tier when present, else the legacy tier
          tier: pick._unifiedTier || pick.tier || null,
          result: pick.result || null,
          graded: incomingGraded,
          // Full pick blob — every field the typed columns don't cover
          // (_ppLine, _ppOddsType, _ppBettable, _unifiedCall, _maxConvergence,
          //  _hrrMissType, _gradedVsSource, line, propLabel, ...) round-trips here.
          data: pick,
          logged_at: intOrNull(pick.loggedAt),
          // Set explicitly: the column DEFAULT now() only fires on INSERT, so
          // without this an upsert-UPDATE keeps a stale updated_at and the
          // ?since= incremental load would never return the changed row.
          updated_at: new Date().toISOString()
        });
      }

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const { error, count } = await sb
          .from('best_bet_history')
          .upsert(chunk, { onConflict: 'user_id,entry_id', count: 'exact' });
        if (error) {
          console.error('[audit/sync] best_bet_history upsert error', error);
          errors.push({ table: 'best_bet_history', message: error.message, chunk: i / CHUNK });
          break;
        }
        bbhUpserted += count != null ? count : chunk.length;
      }
    }
  }

  return res.status(200).json({
    ok: errors.length === 0,
    projectionAuditUpserted: projectionUpserted,
    hrAuditUpserted: hrUpserted,
    bestBetHistoryUpserted: bbhUpserted,
    bestBetHistorySkippedGraded: bbhSkippedGraded,
    errors: errors.length > 0 ? errors : undefined
  });
}

// ---------------------------------------------------------------------------
// (Storage Fix — July 20, 2026) Accept bestBetHistory as either:
//   - a flat array of picks:            [ {entryId, date, ...}, ... ]
//   - the client's nested date map:     { "2026-07-19": { "<entryId>": {...} } }
// and return a flat array. Tolerating both means a future client change to
// push the raw store wholesale can't silently no-op.
// ---------------------------------------------------------------------------
function normalizeBestBetHistory(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean);
  if (typeof input !== 'object') return [];
  const out = [];
  for (const [dateKey, byEntry] of Object.entries(input)) {
    if (!byEntry || typeof byEntry !== 'object') continue;
    for (const [entryId, pick] of Object.entries(byEntry)) {
      if (!pick || typeof pick !== 'object') continue;
      out.push({ date: dateKey, entryId, ...pick });
    }
  }
  return out;
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
