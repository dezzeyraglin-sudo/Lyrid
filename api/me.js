// api/me.js
// Returns the current authenticated user with subscription tier + daily usage.
// Called by client on app load and after auth state changes to get tier-gating info.
//
// Returns 200 with { authenticated: false } for anonymous users so the client
// can render the appropriate UI without needing to handle 401s.

import { tryAuth, getDailyUsage } from './_lib/auth.js';
import { getSupabaseAdmin, isSupabaseConfigured } from './_lib/supabase-admin.js';
import { reconcileEntitlementByEmail } from './_lib/reconcile-entitlement.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await tryAuth(req, res);
  if (res.headersSent) return;

  if (!user) {
    return res.status(200).json({
      authenticated: false,
      tier: 'free',
      anonymous: true,
      quotas: {
        deep_analyses: { used: 0, limit: 0, message: 'Sign in to use deep mode' },
      },
    });
  }

  // Self-heal entitlements. The common Whop flow is: subscribe on Whop first,
  // get added to Discord, THEN sign into lyrid.app — so the activation webhook
  // usually fires before any account exists to match. Reconcile against any
  // unclaimed Whop purchase for this user's email so the upgrade applies on
  // this load. Cheap + safe: no-op for users already 'pro' or on a lifetime
  // grant; only writes when a matching purchase is found.
  let reconciledTier = null;
  if (isSupabaseConfigured()) {
    try {
      const admin = await getSupabaseAdmin();
      const recon = await reconcileEntitlementByEmail(admin, user.id, user.email);
      if (recon.reconciled && recon.tier) reconciledTier = recon.tier;
    } catch (err) {
      console.warn('[me] Entitlement reconcile failed:', err.message);
    }
  }

  // tryAuth read the tier BEFORE the reconcile above ran, so fold a just-healed
  // upgrade into what we return on this same response.
  const effectiveTier = reconciledTier || user.tier;
  const effectiveIsPro = reconciledTier ? reconciledTier === 'pro' : user.isPro;
  const effectiveStatus = reconciledTier ? 'active' : (user.profile?.subscription_status || 'inactive');

  let usage = { deep_analyses: 0 };
  try {
    usage = await getDailyUsage(user.id);
  } catch (err) {
    console.warn('[me] Failed to fetch daily usage:', err.message);
  }

  const dailyLimit = effectiveTier === 'free' ? 3 : Infinity;

  return res.status(200).json({
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      tier: effectiveTier,
      isPro: effectiveIsPro,
      isSharp: user.isSharp,
      subscription: {
        status: effectiveStatus,
        periodEnd: user.profile?.subscription_period_end || null,
      },
    },
    quotas: {
      deep_analyses: {
        used: usage.deep_analyses,
        limit: dailyLimit === Infinity ? null : dailyLimit,
        remaining: dailyLimit === Infinity ? null : Math.max(0, dailyLimit - usage.deep_analyses),
      },
    },
  });
}
