// api/_lib/wnba/wnbaCache.js
//
// Cross-invocation cache for WNBA props + injuries, backed by Supabase.
//
// WHY: Vercel functions are stateless — an in-memory Map doesn't persist between
// the cron run and a slate request. The trial BDL key is capped at 5 req/min, so
// making live calls on every slate load is slow and throttled. This cache lets a
// scheduled cron warm the data (props/injuries) into Supabase, and the slate read
// it back instantly with zero BDL calls at request time.
//
// DESIGN: talks to Supabase's PostgREST endpoint directly via fetch — no SDK, so
// this has no dependency on the repo's supabase-admin.js shape. Reads the standard
// env vars SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role = server-side,
// bypasses RLS). FAIL-SAFE: every path swallows errors and returns null, so a cache
// miss or misconfiguration just makes the caller fall back to a live fetch.
//
// TABLE (create once in Supabase SQL editor):
//   create table if not exists wnba_cache (
//     key text primary key,
//     value jsonb not null,
//     updated_at timestamptz not null default now()
//   );
//   -- service role bypasses RLS; no policies needed for server-only access.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'wnba_cache';

export function isCacheConfigured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

function restUrl(path) {
  return `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
}

function headers(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * Read a cached value. Returns { value, updatedAt, ageMs } or null on miss/error.
 * Optionally enforce a max age (ms) — older entries are treated as a miss.
 */
export async function cacheRead(key, maxAgeMs = null) {
  if (!isCacheConfigured()) return null;
  try {
    const url = restUrl(`${TABLE}?key=eq.${encodeURIComponent(key)}&select=value,updated_at`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { headers: headers(), signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    const ageMs = Date.now() - updatedAt;
    if (maxAgeMs != null && ageMs > maxAgeMs) return null;   // stale → treat as miss
    return { value: row.value, updatedAt, ageMs };
  } catch {
    return null;
  }
}

/**
 * Write a value (upsert by key). Returns true on success, false otherwise.
 */
export async function cacheWrite(key, value) {
  if (!isCacheConfigured()) return false;
  try {
    const url = restUrl(TABLE);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// Standard cache keys.
export const CACHE_KEYS = {
  props: (date) => `wnba:props:${date}`,
  injuries: () => `wnba:injuries`,
  defense: () => `wnba:defense`,
};
