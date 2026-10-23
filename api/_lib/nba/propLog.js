// api/_lib/nba/propLog.js
// Server-side prop log + grading feed (plan step 4). ADDITIVE to the frontend's manual
// uploads — calibration reads from whichever has data (server preferred once flowing). Every
// leaned pick is captured once (pick_id dedupe, never clobbering a graded row); a nightly
// grader settles them from ESPN box scores; analyze reads the graded rows for calibration.
//
// Table (run once):
//   create table if not exists nba_prop_log (
//     pick_id text primary key, date text not null, game_id text,
//     player text, player_id text, market text not null, side text not null, line numeric,
//     projection numeric, tier text, regime text, signals jsonb, engine_version text,
//     result text, actual numeric,
//     logged_at timestamptz default now(), graded_at timestamptz);
//   create index if not exists nba_prop_log_grade on nba_prop_log (date, result);
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY).

const BASE = process.env.SUPABASE_URL || null;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
const TABLE = 'nba_prop_log';
const h = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
export function logConfigured() { return !!(BASE && KEY); }

// first-capture: insert, IGNORE duplicates so a re-run never overwrites a graded row.
export async function logPicks(picks) {
  if (!logConfigured() || !picks || !picks.length) return 0;
  const rows = picks.map((p) => ({
    pick_id: p.pickId, date: p.date, game_id: p.gameId || null,
    player: p.player || null, player_id: p.playerId != null ? String(p.playerId) : null,
    market: p.market, side: p.side, line: p.line != null ? p.line : null,
    projection: p.projection != null ? p.projection : null, tier: p.tier || null, regime: p.regime || null,
    signals: p.signalsFired || [], engine_version: p.engineVersion || null,
  }));
  const res = await fetch(`${BASE}/rest/v1/${TABLE}?on_conflict=pick_id`, {
    method: 'POST', headers: { ...h(), Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`prop-log write ${res.status}: ${await res.text().catch(() => '')}`);
  return rows.length;
}

// graded rows -> calibration cohort observations
export async function readGradedHistory({ sinceDays = 150, limit = 8000 } = {}) {
  if (!logConfigured()) return [];
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
  const url = `${BASE}/rest/v1/${TABLE}?select=market,side,regime,signals,result&result=in.(win,loss)&date=gte.${since}&limit=${limit}`;
  const res = await fetch(url, { headers: h() });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return rows.map((r) => ({ market: r.market, side: r.side, regime: r.regime || 'settled', signalsFired: r.signals || [], result: r.result }));
}

export async function readUngraded(dates) {
  if (!logConfigured()) return [];
  let url = `${BASE}/rest/v1/${TABLE}?select=pick_id,date,player_id,market,side,line&result=is.null`;
  if (dates && dates.length) url += `&date=in.(${dates.map(encodeURIComponent).join(',')})`;
  url += '&limit=8000';
  const res = await fetch(url, { headers: h() });
  if (!res.ok) return [];
  return (await res.json().catch(() => [])) || [];
}

export async function gradeOne(pickId, result, actual) {
  if (!logConfigured()) return false;
  const res = await fetch(`${BASE}/rest/v1/${TABLE}?pick_id=eq.${encodeURIComponent(pickId)}`, {
    method: 'PATCH', headers: { ...h(), Prefer: 'return=minimal' },
    body: JSON.stringify({ result, actual: actual != null ? actual : null, graded_at: new Date().toISOString() }),
  });
  return res.ok;
}

// settled stat for a market from a box-score player row
export function actualForMarket(market, bp) {
  if (!bp) return null;
  const s = (...ks) => ks.reduce((a, k) => a + (bp[k] || 0), 0);
  switch (market) {
    case 'points': return bp.pts;
    case 'rebounds': return bp.reb;
    case 'assists': return bp.ast;
    case 'threes': return bp.fg3m;
    case 'pra': return s('pts', 'reb', 'ast');
    case 'pts_rebs': return s('pts', 'reb');
    case 'pts_asts': return s('pts', 'ast');
    case 'rebs_asts': return s('reb', 'ast');
    default: return null;
  }
}
export function gradeSide(side, actual, line) {
  if (actual == null || line == null) return null;
  if (actual === line) return 'push';
  const over = actual > line;
  return (side === 'over') === over ? 'win' : 'loss';
}

export default { logConfigured, logPicks, readGradedHistory, readUngraded, gradeOne, actualForMarket, gradeSide };
