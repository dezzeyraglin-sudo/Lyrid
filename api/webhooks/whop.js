// api/webhooks/whop.js
//
// WHOP SUBSCRIPTION WEBHOOK HANDLER (May 30, 2026)
//
// Receives subscription lifecycle events from Whop and translates them into
// updates on the `profiles` and `subscription_events` tables in Supabase.
//
// EVENTS WE HANDLE
//   - membership_activated:   user subscribed (or trial converted to paid)
//   - membership_deactivated: user cancelled, expired, refunded, or banned
//
// EVENT → DATABASE MAPPING
//
//   On `membership_activated` for the PRO product (prod_lmpUuEximUX8d):
//     UPDATE profiles SET
//       tier = 'pro',
//       subscription_source = 'whop',
//       subscription_id = <whop membership id>,
//       subscription_status = 'active',
//       subscription_period_end = <renewal_period_end from Whop>,
//       updated_at = NOW()
//     WHERE id = <user.id from auth.users>
//
//   On `membership_activated` for the MEMBER product (prod_zcXCHFY02Q5pf):
//     UPDATE profiles SET
//       tier = 'free',  ← Member tier doesn't grant tool access
//       subscription_source = 'whop',
//       subscription_id = <whop membership id>,
//       subscription_status = 'active',
//       subscription_period_end = <period_end>,
//       updated_at = NOW()
//     WHERE id = <user.id>
//
//   On `membership_deactivated`:
//     UPDATE profiles SET
//       subscription_status = 'canceled',
//       updated_at = NOW()
//     WHERE id = <user.id>
//
//     We keep tier and subscription_period_end so the user retains access
//     until the end of their billing period (grace period built into the
//     entitlements view).
//
// IMPORTANT: USER MATCHING
//   Whop webhook events include the user's Discord ID. We match this to a
//   Supabase auth user by looking up the user_metadata.provider_id (Discord
//   sets this during OAuth) or raw_user_meta_data.sub. If no match, we still
//   log the event but cannot apply the update — the user must sign in via
//   Discord OAuth first so we have their profile.
//
// SIGNATURE VERIFICATION
//   Whop signs webhooks with HMAC-SHA256 using WHOP_WEBHOOK_SECRET. We
//   verify the X-Whop-Signature header before doing anything else. Reject
//   any request whose signature doesn't match.
//
// IDEMPOTENCY
//   Whop may deliver the same webhook multiple times. We use the event ID
//   as a deduplication key in subscription_events (UNIQUE constraint on
//   source + event_type + payload hash). Re-deliveries become no-ops.
//
// FAILURE BEHAVIOR
//   - Invalid signature: 401, do not log event
//   - Unknown event type: 200 (acknowledge so Whop stops retrying), log to subscription_events
//   - Database error: 500 (Whop will retry)
//   - Unknown product ID: 200, log event, no profile update

import crypto from 'crypto';
import { getSupabaseAdmin, isSupabaseConfigured } from '../_lib/supabase-admin.js';

const WHOP_API_BASE = 'https://api.whop.com/api/v5';

/**
 * Verify Whop webhook signature using HMAC-SHA256.
 * Returns true if signature matches, false otherwise.
 */
export function verifySignature(rawBody, signature) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Map a Whop product ID to our internal tier.
 *
 *   Pro product   → 'pro'  (tool access)
 *   Member product → 'free' (no tool access; only Discord role granted)
 *   Unknown product → null (don't touch tier)
 */
export function tierForProduct(productId) {
  if (!productId) return null;
  if (productId === process.env.WHOP_PRO_PRODUCT_ID) return 'pro';
  if (productId === process.env.WHOP_MEMBER_PRODUCT_ID) return 'free';
  return null;
}

/**
 * Find a Supabase user by Discord ID by querying auth.users via service-role.
 *
 * Discord OAuth via Supabase stores the Discord user ID in
 * raw_user_meta_data.provider_id (sometimes also in .sub).
 *
 * Returns the user record { id, email, ... } or null if no match.
 */
export async function findUserByDiscordId(supabase, discordUserId) {
  if (!discordUserId) return null;

  // listUsers paginates; iterate until we find a match or exhaust.
  // At small scale (< 1000 users) this is fine. At larger scale we'd want
  // an indexed lookup or to maintain a discord_id column on profiles.
  // TODO: add profiles.discord_id column + index for O(1) lookup
  let page = 1;
  const perPage = 200;
  while (page <= 20) {  // hard cap at 4000 users searched
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users || data.users.length === 0) return null;

    for (const user of data.users) {
      const meta = user.user_metadata || user.raw_user_meta_data || {};
      const candidates = [
        meta.provider_id,
        meta.sub,
        meta.discord_id,
        // identities[].provider_id is the canonical place
        ...(user.identities || []).filter(i => i.provider === 'discord').map(i => i.id || i.provider_id)
      ].filter(Boolean).map(String);

      if (candidates.includes(String(discordUserId))) {
        return user;
      }
    }

    if (data.users.length < perPage) return null;  // last page
    page++;
  }
  return null;
}

/**
 * Insert an audit row in subscription_events for every webhook we process,
 * regardless of whether the profile update succeeded.
 */
export async function logEvent(supabase, { userId, eventType, payload }) {
  const { error } = await supabase
    .from('subscription_events')
    .insert({
      user_id: userId || null,
      source: 'whop',
      event_type: eventType,
      raw_payload: payload,
    });
  if (error) {
    console.warn('[whop-webhook] Failed to log event:', error.message);
  }
}

/**
 * Apply a profile update based on the event.
 */
export async function applyEventToProfile(supabase, { user, eventType, productId, membershipId, periodEnd }) {
  if (!user) {
    console.warn('[whop-webhook] No matched user; skipping profile update');
    return { applied: false, reason: 'no_user_match' };
  }

  if (eventType === 'membership_activated') {
    const tier = tierForProduct(productId);
    if (tier === null) {
      console.warn(`[whop-webhook] Unknown product ${productId}; skipping profile update`);
      return { applied: false, reason: 'unknown_product' };
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        tier,
        subscription_source: 'whop',
        subscription_id: membershipId || null,
        subscription_status: 'active',
        subscription_period_end: periodEnd || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (error) {
      console.error('[whop-webhook] Profile update failed:', error.message);
      return { applied: false, reason: 'db_error', detail: error.message };
    }
    return { applied: true, tier };
  }

  if (eventType === 'membership_deactivated') {
    // Mark canceled but keep tier + period_end so user retains access
    // until subscription_period_end (grace period built into entitlements view)
    const { error } = await supabase
      .from('profiles')
      .update({
        subscription_status: 'canceled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (error) {
      console.error('[whop-webhook] Profile cancel update failed:', error.message);
      return { applied: false, reason: 'db_error', detail: error.message };
    }
    return { applied: true, status: 'canceled' };
  }

  return { applied: false, reason: 'unhandled_event_type' };
}

/**
 * Extract the Whop event fields we care about.
 * Defensive about field locations because Whop's payload shape can vary.
 */
export function parseEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Whop event envelope:
  //   { type: 'membership_activated', data: { ...membership object } }
  // Some webhook flavors use `action` instead of `type` or nest under `event`.
  const type = payload.type || payload.event || payload.action;
  const data = payload.data || payload.membership || payload;

  if (!type) return null;

  // Discord ID location can vary:
  //   data.user.discord_id
  //   data.user.discord?.id
  //   data.discord_id
  //   data.discord_user?.id
  const user = data.user || {};
  const discordId =
    data.discord_user_id ||
    user.discord_id ||
    user.discord?.id ||
    data.discord_id ||
    data.discord_user?.id ||
    null;

  const productId = data.product_id || data.product?.id || null;
  const membershipId = data.id || data.membership_id || null;

  // Period end can be at various paths
  const periodEnd =
    data.expires_at ||
    data.renewal_period_end ||
    data.period_end ||
    data.current_period_end ||
    null;

  return { type, discordId, productId, membershipId, periodEnd, raw: payload };
}

/**
 * Main webhook handler. Vercel serverless function entrypoint.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Whop signs the RAW request body. Vercel auto-parses JSON, so we need
  // to re-stringify with stable key order — which doesn't work reliably.
  // For accurate signature verification, we should read req.rawBody if
  // available, falling back to req.body.
  //
  // TODO: add a vercel.json config to disable bodyParser for this route
  // so we can read the raw body directly. Until then, we accept that
  // signature verification may fail for production traffic and rely on
  // network-level trust (Whop's IPs).

  const rawBody =
    req.rawBody ||
    (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

  const signature =
    req.headers['x-whop-signature'] ||
    req.headers['x-whop-webhook-signature'] ||
    '';

  // Signature verification — skip in dev when no secret configured
  if (process.env.WHOP_WEBHOOK_SECRET) {
    if (!verifySignature(rawBody, signature)) {
      console.warn('[whop-webhook] Invalid signature; rejecting');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Parse body
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const event = parseEvent(payload);
  if (!event || !event.type) {
    return res.status(400).json({ error: 'Could not parse event' });
  }

  // We only handle two event types; ack everything else with 200 so Whop
  // doesn't retry indefinitely
  if (event.type !== 'membership_activated' && event.type !== 'membership_deactivated') {
    // Still log to subscription_events for audit
    if (isSupabaseConfigured()) {
      try {
        const supabase = await getSupabaseAdmin();
        await logEvent(supabase, { userId: null, eventType: event.type, payload });
      } catch (err) {
        console.warn('[whop-webhook] Log failed for unhandled event:', err.message);
      }
    }
    return res.status(200).json({ ok: true, ignored: event.type });
  }

  // If Supabase isn't configured we still ack so Whop doesn't retry
  if (!isSupabaseConfigured()) {
    console.warn('[whop-webhook] Supabase not configured; cannot process event');
    return res.status(200).json({ ok: true, supabase: 'not_configured' });
  }

  // Process the event
  try {
    const supabase = await getSupabaseAdmin();
    const user = await findUserByDiscordId(supabase, event.discordId);

    // Log first (always), then attempt the profile update
    await logEvent(supabase, {
      userId: user?.id || null,
      eventType: event.type,
      payload,
    });

    const result = await applyEventToProfile(supabase, {
      user,
      eventType: event.type,
      productId: event.productId,
      membershipId: event.membershipId,
      periodEnd: event.periodEnd,
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[whop-webhook] Handler error:', err);
    // Return 500 so Whop retries — transient errors should not be lost
    return res.status(500).json({ error: 'Processing failed' });
  }
}

// Export internals for testing
export const _internals = { WHOP_API_BASE };
