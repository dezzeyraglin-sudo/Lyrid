// api/_lib/auth.js
// Request authentication and tier gating. Used by every protected endpoint.
//
// Workflow:
//   1. Endpoint calls `await authenticate(req)` → returns user or null
//   2. If feature requires tier, calls `requireTier(user, 'pro')` → 403 if insufficient
//   3. For free quota tracking, calls `incrementDailyUsage(userId, 'deep_analyses')`
//
// The auth flow:
//   - Client sends Bearer JWT in Authorization header (Supabase access token)
//   - We verify via Supabase, returning the user ID
//   - We fetch tier + entitlement state from our profiles table
//   - We attach to `req.user` for the endpoint handler

import { getSupabaseAdmin, isSupabaseConfigured } from './supabase-admin.js';

/**
 * The auth gate has TWO independent flags:
 *
 *   1. isSupabaseConfigured() — env vars present, database reachable
 *   2. isMonetizationLaunched() — login UI shipped, users can sign in
 *
 * BOTH must be true before auth is enforced on requests. This separation lets you:
 *   - Set up Supabase (Phase 1-7) without breaking the live app
 *   - Test the auth/database wiring via /api/health
 *   - Keep pre-monetization mode active until you're ready to launch monetization
 *
 * To launch monetization later, set the env var: MONETIZATION_LAUNCHED=true
 * Until then, every request is treated as a Pro user with unlimited quota.
 */
const PRE_MONETIZATION_USER = {
  id: null,
  email: null,
  tier: 'pro',
  isPro: true,
  isSharp: false,
  profile: null,
  preMonetization: true,
};

function isMonetizationLaunched() {
  // Explicit opt-in — defaults to false, only true when env var explicitly set
  const v = process.env.MONETIZATION_LAUNCHED;
  return v === 'true' || v === '1' || v === 'yes';
}

function isAuthGateActive() {
  return isSupabaseConfigured() && isMonetizationLaunched();
}

/**
 * Verify a request's auth token and return the authenticated user with tier info.
 * Returns null for unauthenticated requests (anonymous = free tier with limits).
 *
 * If Supabase isn't configured, returns PRE_MONETIZATION_USER (effectively unlimited).
 *
 * @returns {Promise<null | { id, email, tier, isPro, isSharp, profile }>}
 */
export async function authenticate(req) {
  // Pre-monetization mode: auth gate not active yet, treat as Pro
  // (active = Supabase configured AND MONETIZATION_LAUNCHED env var set)
  if (!isAuthGateActive()) return PRE_MONETIZATION_USER;

  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const supabase = await getSupabaseAdmin();

  // Step 1: verify the JWT belongs to a real user
  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) return null;

  // Step 2: load their tier from our profiles + entitlements view
  const { data: ent, error: entErr } = await supabase
    .from('entitlements')
    .select('user_id, tier, subscription_status, subscription_period_end, is_pro_active, is_sharp_active')
    .eq('user_id', user.id)
    .single();

  if (entErr) {
    console.warn('[auth] No profile row for user', user.id, entErr.message);
    return {
      id: user.id,
      email: user.email,
      tier: 'free',
      isPro: false,
      isSharp: false,
      profile: null,
    };
  }

  const isProActive = ent.is_pro_active || ent.is_sharp_active;
  const isSharpActive = ent.is_sharp_active;

  return {
    id: user.id,
    email: user.email,
    tier: ent.tier,
    isPro: isProActive,
    isSharp: isSharpActive,
    profile: ent,
  };
}

/**
 * Throw a 403-equivalent if user doesn't have the required tier.
 * Returns user when allowed; throws AuthError when not.
 */
export class AuthError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

export function requireAuth(user) {
  if (!user) throw new AuthError('Authentication required', 401, 'AUTH_REQUIRED');
  return user;
}

export function requirePro(user) {
  requireAuth(user);
  if (!user.isPro && !user.isSharp) {
    throw new AuthError('Pro subscription required', 403, 'UPGRADE_REQUIRED_PRO');
  }
  return user;
}

export function requireSharp(user) {
  requireAuth(user);
  if (!user.isSharp) {
    throw new AuthError('Sharp subscription required', 403, 'UPGRADE_REQUIRED_SHARP');
  }
  return user;
}

/**
 * Convenience wrapper: top of every endpoint that may require auth.
 * Catches AuthError and writes the response. Returns user or null.
 *
 * Usage:
 *   const user = await tryAuth(req, res);  // null = anonymous (free tier with limits)
 *   if (res.headersSent) return;            // auth failed and response was already sent
 */
export async function tryAuth(req, res) {
  try {
    return await authenticate(req);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return null;
    }
    console.error('[auth] Unexpected error:', err);
    res.status(500).json({ error: 'Authentication system unavailable' });
    return null;
  }
}

/**
 * Increment a free-tier user's daily usage counter (deep_analyses).
 * Returns the new count and the daily limit.
 * Throws AuthError if quota exceeded for free tier.
 *
 * Pro/Sharp users: this is a no-op that returns null (no enforcement needed).
 */
const DAILY_QUOTAS = {
  free: { deep_analyses: 3 },
  pro: { deep_analyses: Infinity },
  sharp: { deep_analyses: Infinity },
};

export async function checkAndIncrementQuota(user, feature) {
  // Pre-monetization mode: no quota enforcement
  if (!isAuthGateActive() || user?.preMonetization) {
    return { used: 0, limit: Infinity };
  }

  if (!user) {
    // Anonymous users get the same free quota but tracked by IP would be needed in real prod;
    // for now, return a quota error to push them to sign up
    throw new AuthError('Sign in to use deep mode', 401, 'SIGN_IN_REQUIRED');
  }

  const tier = user.tier || 'free';
  const limit = DAILY_QUOTAS[tier]?.[feature];
  if (limit == null) return { used: 0, limit: 0 };
  if (limit === Infinity) return { used: 0, limit: Infinity };

  const supabase = await getSupabaseAdmin();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Atomic upsert: increment the counter, returning the new value
  const { data, error } = await supabase.rpc('increment_daily_usage', {
    p_user_id: user.id,
    p_date: today,
    p_field: feature,
  });

  if (error) {
    // Fallback path: if RPC doesn't exist, do read-modify-write (less safe but functional)
    const { data: row } = await supabase
      .from('daily_usage')
      .select('deep_analyses_count')
      .eq('user_id', user.id)
      .eq('date', today)
      .single();
    const current = row?.deep_analyses_count ?? 0;
    if (current >= limit) {
      throw new AuthError(
        `Daily limit reached: ${limit} deep analyses on free tier. Upgrade to Pro for unlimited.`,
        429,
        'QUOTA_EXCEEDED'
      );
    }
    await supabase
      .from('daily_usage')
      .upsert(
        { user_id: user.id, date: today, deep_analyses_count: current + 1 },
        { onConflict: 'user_id,date' }
      );
    return { used: current + 1, limit };
  }

  const newCount = data;
  if (newCount > limit) {
    // Roll back the increment
    await supabase
      .from('daily_usage')
      .update({ deep_analyses_count: limit })
      .eq('user_id', user.id)
      .eq('date', today);
    throw new AuthError(
      `Daily limit reached: ${limit} deep analyses on free tier. Upgrade to Pro for unlimited.`,
      429,
      'QUOTA_EXCEEDED'
    );
  }

  return { used: newCount, limit };
}

/**
 * Read the user's current daily usage without incrementing.
 * Used by /api/me to display "2 of 3 deep analyses today" in the UI.
 */
export async function getDailyUsage(userId) {
  if (!isAuthGateActive() || !userId) {
    return { deep_analyses: 0 };
  }
  const supabase = await getSupabaseAdmin();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const { data } = await supabase
    .from('daily_usage')
    .select('deep_analyses_count')
    .eq('user_id', userId)
    .eq('date', today)
    .single();
  return { deep_analyses: data?.deep_analyses_count ?? 0 };
}
