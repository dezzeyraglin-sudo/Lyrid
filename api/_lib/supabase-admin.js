// api/_lib/supabase-admin.js
// Server-side Supabase client using the service role key.
// NEVER expose this to the browser — service role bypasses RLS.
//
// The @supabase/supabase-js import is loaded lazily so that endpoints that
// don't actually use Supabase (or environments that don't have it installed)
// don't crash on module load. This matters during pre-monetization rollout
// where the package may not be in node_modules yet.

let _adminClient = null;
let _createClient = null;

async function loadCreateClient() {
  if (_createClient) return _createClient;
  try {
    const mod = await import('@supabase/supabase-js');
    _createClient = mod.createClient;
    return _createClient;
  } catch (err) {
    throw new Error(
      '@supabase/supabase-js is not installed. ' +
      'Run `npm install @supabase/supabase-js` to enable auth/quota features.'
    );
  }
}

/**
 * Returns whether Supabase is configured. When false, auth/quota features
 * should silently no-op and let everyone access everything (pre-monetization mode).
 */
export function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function getSupabaseAdmin() {
  if (_adminClient) return _adminClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars must be set. ' +
      'Get them from Supabase Dashboard → Settings → API.'
    );
  }

  const createClient = await loadCreateClient();

  _adminClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _adminClient;
}

export async function getSupabaseAnonForUser(jwt) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY required for user-context client');
  }
  const createClient = await loadCreateClient();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
