// api/_lib/reconcile-entitlement.js
//
// LOGIN-TIME ENTITLEMENT BACKFILL
//
// Why this exists:
//   Whop's normal flow is: a person subscribes on Whop FIRST, the Whop bot adds
//   them to Discord, and only THEN do they come to lyrid.app and sign in with
//   Discord. When the `membership.activated` webhook fired, no Supabase account
//   existed yet, so the handler logged the event with user_id = NULL and could
//   not apply the upgrade. (This is the "billythreet12345" case.)
//
//   This module closes that gap. Call it whenever you have an authenticated
//   user — the natural place is inside /api/auth/me, which the frontend already
//   hits on every app load. It looks for a Whop activation event whose buyer
//   email matches the signed-in user's email and, if found, applies the
//   entitlement. The purchase effectively "self-heals" on the user's next load.
//
// Guarantees:
//   - No-op for users who are already 'pro' (cheap early exit; no event scan).
//   - NEVER overrides a 'lifetime' grant.
//   - Idempotent: claims the matched event (sets user_id) so audit stays clean.
//
// What it does NOT solve:
//   If a buyer used a DIFFERENT email on Whop than the email on their Discord
//   sign-in, there is no shared key to match on and this returns
//   { reconciled: false, reason: 'no_matching_purchase' }. That case needs a
//   manual grant or an in-app "link my Whop email" step.

/**
 * Map a Whop product ID to our internal tier. Mirrors tierForProduct in
 * api/webhooks/whop.js (kept local to avoid importing the webhook handler).
 */
function tierForProduct(productId) {
  if (!productId) return null;
  if (productId === process.env.WHOP_PRO_PRODUCT_ID) return 'pro';
  if (productId === process.env.WHOP_MEMBER_PRODUCT_ID) return 'free';
  return null;
}

/**
 * Reconcile a signed-in user against any unclaimed Whop purchase for their email.
 *
 * @param {object} supabase - service-role Supabase client (getSupabaseAdmin()).
 * @param {string} userId   - the authenticated user's id (auth.users.id).
 * @param {string} email    - the authenticated user's email.
 * @returns {Promise<{reconciled: boolean, reason?: string, tier?: string, membershipId?: string|null, detail?: string}>}
 */
export async function reconcileEntitlementByEmail(supabase, userId, email) {
  if (!userId || !email) return { reconciled: false, reason: 'missing_input' };
  const target = String(email).trim().toLowerCase();
  if (!target) return { reconciled: false, reason: 'missing_input' };

  // 1) Look at the current profile. Bail early for the two cases where there's
  //    nothing to do, so the common path stays cheap (no event scan).
  const { data: prof, error: profErr } = await supabase
    .from('profiles')
    .select('tier, subscription_source')
    .eq('id', userId)
    .maybeSingle();

  if (profErr) return { reconciled: false, reason: 'profile_lookup_failed', detail: profErr.message };
  if (prof?.subscription_source === 'lifetime') return { reconciled: false, reason: 'lifetime' };
  if (prof?.tier === 'pro') return { reconciled: false, reason: 'already_pro' };

  // 2) Pull recent Whop events and find an activation whose buyer email matches.
  //    We filter in JS (rather than a JSON SQL filter) so email comparison is
  //    reliably case-insensitive and robust to payload-shape variation.
  const { data: events, error: evErr } = await supabase
    .from('subscription_events')
    .select('id, user_id, event_type, raw_payload, created_at')
    .eq('source', 'whop')
    .order('created_at', { ascending: false })
    .limit(100);

  if (evErr || !events) return { reconciled: false, reason: 'event_lookup_failed', detail: evErr?.message };

  const match = events.find((ev) => {
    const type = ev.event_type || '';
    const isActivation = type === 'membership.activated' || type === 'membership_activated';
    if (!isActivation) return false;
    const evEmail =
      ev.raw_payload?.data?.user?.email ||
      ev.raw_payload?.data?.email ||
      null;
    return evEmail && String(evEmail).trim().toLowerCase() === target;
  });

  if (!match) return { reconciled: false, reason: 'no_matching_purchase' };

  // 3) Resolve the tier from the purchased product.
  const productId =
    match.raw_payload?.data?.product?.id ||
    match.raw_payload?.data?.product_id ||
    null;
  const tier = tierForProduct(productId);
  if (tier === null) return { reconciled: false, reason: 'unknown_product' };
  if (tier === prof?.tier) return { reconciled: false, reason: 'already_current' };

  const membershipId = match.raw_payload?.data?.id || null;

  // 4) Apply the entitlement.
  const { error: updErr } = await supabase
    .from('profiles')
    .update({
      tier,
      subscription_source: 'whop',
      subscription_id: membershipId,
      subscription_status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (updErr) return { reconciled: false, reason: 'update_failed', detail: updErr.message };

  // 5) Claim the event for audit / dedup so it isn't reprocessed.
  if (!match.user_id) {
    await supabase.from('subscription_events').update({ user_id: userId }).eq('id', match.id);
  }

  return { reconciled: true, tier, membershipId };
}
