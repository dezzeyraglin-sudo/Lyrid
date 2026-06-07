// =============================================================================
// /api/audit/diag — TEMPORARY diagnostic endpoint
//
// Returns sanitized info about what the runtime can see for the audit endpoints.
// Use to debug RLS violations. DELETE this file after fixing.
//
// IMPORTANT: never returns the actual secret values — only first 4 + last 4
// characters and length, which is enough to confirm which key is in place
// without leaking the secret.
// =============================================================================

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  // Decode JWT role claim if present — service role tokens contain "role":"service_role"
  function roleOf(jwt) {
    try {
      const parts = (jwt || '').split('.');
      if (parts.length < 2) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      return payload.role || null;
    } catch (_) { return null; }
  }

  function mask(s) {
    if (!s) return null;
    if (s.length < 16) return `len=${s.length}`;
    return `${s.slice(0, 4)}...${s.slice(-4)} (len=${s.length}, role=${roleOf(s) || 'unknown'})`;
  }

  return res.status(200).json({
    ok: true,
    supabaseUrl: url ? mask(url) : '(missing)',
    anonKey: anon ? mask(anon) : '(missing)',
    serviceRoleKey: service ? mask(service) : '(missing)',
    // We want service_role JWT to have role=service_role and anon to have role=anon.
    // If serviceRoleKey shows role=anon, that's the bug — wrong value was pasted.
    expected: 'serviceRoleKey.role should be "service_role"'
  });
}
