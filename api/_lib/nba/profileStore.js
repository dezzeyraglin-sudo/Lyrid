// api/_lib/nba/profileStore.js
// Supabase-backed cache for nightly-built NBA profiles (roster index, team context), so the
// analyze hot path reads them instead of rebuilding ~540 ESPN athlete refs inline (the build
// that was timing out and dropping most of the slate). REST via fetch — no SDK dependency.
//
// Table (run once):
//   create table if not exists nba_matchup_profile (
//     kind text not null, key text not null, data jsonb not null,
//     updated_at timestamptz not null default now(), primary key (kind, key));
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY).

const BASE = process.env.SUPABASE_URL || null;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
const TABLE = 'nba_matchup_profile';
const h = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });

export function storeConfigured() { return !!(BASE && KEY); }

export async function writeProfile(kind, key, data) {
  if (!storeConfigured()) throw new Error('profile store not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
  const row = { kind, key: String(key), data, updated_at: new Date().toISOString() };
  const res = await fetch(`${BASE}/rest/v1/${TABLE}?on_conflict=kind,key`, {
    method: 'POST',
    headers: { ...h(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`profile write ${res.status}: ${await res.text().catch(() => '')}`);
  return true;
}

export async function readProfile(kind, key) {
  if (!storeConfigured()) return null;
  let url = `${BASE}/rest/v1/${TABLE}?select=data,updated_at&kind=eq.${encodeURIComponent(kind)}`;
  url += key != null ? `&key=eq.${encodeURIComponent(String(key))}` : '&order=updated_at.desc';
  url += '&limit=1';
  const res = await fetch(url, { headers: h() });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows && rows[0] ? rows[0].data : null;
}

export default { storeConfigured, writeProfile, readProfile };
