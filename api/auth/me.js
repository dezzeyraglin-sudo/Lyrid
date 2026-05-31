// api/auth/me.js
//
// CURRENT USER ENDPOINT (May 30, 2026)
//
// Returns the authenticated user's tier, subscription status, and current
// daily usage. Called by the frontend on page load to determine what UI to
// show:
//   - Not logged in → show login button + free preview
//   - Logged in, tier=free → show login state + "upgrade to Pro" prompts
//   - Logged in, tier=pro/sharp → show full tool access + "logged in as X"
//
// AUTH FLOW
//   The frontend sends:
//     GET /api/auth/me
//     Authorization: Bearer <supabase_access_token>
//
//   This endpoint:
//     1. Calls tryAuth() to validate the token and look up tier
//     2. If valid: returns user + tier + usage
//     3. If invalid or missing: returns 401 with code AUTH_REQUIRED
//
// PRE-MONETIZATION MODE
//   When MONETIZATION_LAUNCHED=false (current state), tryAuth() returns the
//   PRE_MONETIZATION_USER object regardless of token. /me will still respond
//   with tier=pro so the frontend treats everyone as Pro. This keeps the
//   live app working while we build the rest of the auth flow.

import { tryAuth, getDailyUsage } from '../_lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await tryAuth(req, res);
  if (res.headersSent) return;  // tryAuth wrote an error response

  if (!user) {
    return res.status(401).json({
      authenticated: false,
      error: 'Not signed in',
      code: 'AUTH_REQUIRED',
    });
  }

  // Pull daily usage if we have a real user (not pre-monetization placeholder)
  let usage = null;
  if (user.id && !user.preMonetization) {
    try {
      usage = await getDailyUsage(user.id);
    } catch (err) {
      console.warn('[me] getDailyUsage failed:', err.message);
    }
  }

  return res.status(200).json({
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      tier: user.tier,
      isPro: user.isPro,
      isSharp: user.isSharp,
      displayName: user.profile?.display_name || null,
      subscriptionStatus: user.profile?.subscription_status || null,
      subscriptionPeriodEnd: user.profile?.subscription_period_end || null,
    },
    usage,
    preMonetization: Boolean(user.preMonetization),
  });
}
