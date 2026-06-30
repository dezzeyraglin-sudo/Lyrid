// Lyrid · Parlay Maker auto-grader (Drop #43)
// Path: api/cron/grade-parlays.js   Route: /api/cron/grade-parlays
// Named .js (not .mjs) so it matches the "api/cron/*.js" maxDuration:60 glob in vercel.json.
//
// Grades pending tickets whose games are final, mirroring how the prop tiers grade.
//   true  = leg cashed
//   false = leg lost
//   null  = game not final yet  -> ticket left pending, retried next run
// If ANY leg returns null, the whole ticket stays pending.
//
// MLB legs resolve against the public MLB Stats API (same source as live innings).
// WNBA legs are NOT yet wired to a result source — gradeLeg returns null for them,
// so WNBA (and mixed MLB+WNBA) tickets stay pending until wired. This is deliberate:
// better to leave pending than publish an unvalidated win rate. TODO: point
// resolveWnba() at the same BDL result lookup the WNBA prop tiers grade against.

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const q = await sb.from('parlay_log').select('*').eq('status', 'pending').lte('slate_date', today);
  if (q.error) return res.status(500).json({ error: q.error.message });

  let graded = 0, pending = 0;
  for (const t of (q.data || [])) {
    const results = await Promise.all((t.legs || []).map(gradeLeg));
    if (results.some(r => r === null)) { pending++; continue; }   // a game not final -> leave pending
    const hits = results.filter(Boolean).length;
    const won = (t.ticket_type === 'power') ? (hits === results.length) : (hits >= results.length - 1);
    const upd = await sb.from('parlay_log')
      .update({ status: 'graded', legs_hit: hits, won, graded_at: new Date().toISOString() })
      .eq('id', t.id);
    if (!upd.error) graded++;
  }
  return res.status(200).json({ checked: (q.data || []).length, graded, pending });
}

// Returns true (cashed) / false (lost) / null (not final or unresolved).
async function gradeLeg(leg) {
  try {
    if (leg.sport === 'mlb') return await resolveMlb(leg);
    if (leg.sport === 'wnba') return await resolveWnba(leg);
    return null;
  } catch (_) {
    return null; // any error -> treat as not-yet-resolvable, retry next run
  }
}

// ---- MLB: MLB Stats API boxscore ----
async function resolveMlb(leg) {
  const gamePk = String(leg.gameId || '').replace(/[^0-9]/g, '');
  if (!gamePk) return null;

  // Confirm final.
  const feed = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
  const abstract = feed?.gameData?.status?.abstractGameState;
  if (abstract !== 'Final') return null;

  const box = await fetchJson(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
  const teams = box?.teams;
  if (!teams) return null;

  const want = norm(leg.player);
  const players = { ...(teams.away?.players || {}), ...(teams.home?.players || {}) };
  let batting = null;
  for (const key of Object.keys(players)) {
    const p = players[key];
    if (norm(p?.person?.fullName) === want) { batting = p?.stats?.batting || {}; break; }
  }
  if (!batting) return null; // didn't play / name mismatch -> can't grade, retry

  const v = statForMlbMarket(batting, leg.market);
  if (v == null) return null;
  return leg.side === 'over' ? (v > leg.line) : (v < leg.line);
}

function statForMlbMarket(b, market) {
  const hits = num(b.hits), runs = num(b.runs), rbi = num(b.rbi), hr = num(b.homeRuns);
  switch (market) {
    case 'hits': return hits;
    case 'hrr':  return hits + runs + rbi;       // hits + runs + RBIs
    case 'hr':   return hr;
    default:     return null;
  }
}

// ---- WNBA: not yet wired to a result source ----
async function resolveWnba(_leg) {
  // TODO: resolve final box score for leg.player and grade markets
  // 'assists' | 'rebounds' | 'pra' against leg.line using the same BDL
  // result lookup the WNBA prop tiers grade against. Until then, return
  // null so WNBA/mixed tickets stay pending rather than mis-grade.
  return null;
}

// ---- helpers ----
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) return null;
  return r.json();
}
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, '').trim(); }
