// Tests for api/webhooks/whop.js
//
// Covers: signature verification, event parsing, product → tier mapping,
// user matching, profile updates, audit logging, error handling.

import assert from 'assert';
import crypto from 'crypto';

// Set env vars BEFORE module imports
process.env.WHOP_WEBHOOK_SECRET = 'whsec_test_secret_value';
process.env.WHOP_PRO_PRODUCT_ID = 'prod_lmpUuEximUX8d';
process.env.WHOP_MEMBER_PRODUCT_ID = 'prod_zcXCHFY02Q5pf';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_service_role_key';

const {
  verifySignature,
  verifyStandardWebhookSignature,
  tierForProduct,
  findUserByDiscordId,
  logEvent,
  applyEventToProfile,
  parseEvent,
  default: handler,
} = await import('../api/webhooks/whop.js');

const { _setAdminClientForTesting } = await import('../api/_lib/supabase-admin.js');

let passed = 0, failed = 0;
const allTests = [];
function test(name, fn) { allTests.push({ name, fn }); }
function suite(name) { allTests.push({ name, isSuite: true }); }

async function runAll() {
  for (const t of allTests) {
    if (t.isSuite) {
      console.log(`\n${t.name}`);
      continue;
    }
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// =============================================================
// SIGNATURE VERIFICATION
// =============================================================

suite('verifySignature');

test('valid signature returns true', () => {
  const body = '{"type":"membership_activated"}';
  const sig = crypto.createHmac('sha256', 'whsec_test_secret_value').update(body).digest('hex');
  assert.strictEqual(verifySignature(body, sig), true);
});

test('wrong signature returns false', () => {
  assert.strictEqual(verifySignature('{"x":1}', 'wrong_sig'), false);
});

test('null body returns false', () => {
  assert.strictEqual(verifySignature(null, 'sig'), false);
});

test('null signature returns false', () => {
  assert.strictEqual(verifySignature('body', null), false);
});

test('different-length strings return false safely', () => {
  assert.strictEqual(verifySignature('body', 'short'), false);
});

test('tampered body produces wrong signature', () => {
  const original = '{"type":"membership_activated"}';
  const sig = crypto.createHmac('sha256', 'whsec_test_secret_value').update(original).digest('hex');
  const tampered = '{"type":"membership_deactivated"}';
  assert.strictEqual(verifySignature(tampered, sig), false);
});

// ===========================================================
// STANDARD WEBHOOKS SIGNATURE (Whop's actual format)
// ===========================================================

suite('verifyStandardWebhookSignature (Whop production format)');

// Helper to compute a valid Standard Webhooks signature for testing.
// secretWithPrefix is the full secret like "whsec_abc123..."
function signStandardWebhook(id, timestamp, body, secretWithPrefix) {
  const keyB64 = secretWithPrefix.startsWith('whsec_')
    ? secretWithPrefix.slice('whsec_'.length)
    : secretWithPrefix;
  const keyBytes = Buffer.from(keyB64, 'base64');
  const signedPayload = `${id}.${timestamp}.${body}`;
  const sig = crypto.createHmac('sha256', keyBytes).update(signedPayload).digest('base64');
  return `v1,${sig}`;
}

test('valid Standard Webhooks signature returns true', () => {
  // Use a properly base64-encoded test secret so the whsec_ decode works
  const testKey = Buffer.from('test-secret-key-bytes').toString('base64');
  const testSecret = `whsec_${testKey}`;
  process.env.WHOP_WEBHOOK_SECRET = testSecret;

  const id = 'msg_abc123';
  const timestamp = '1717024646';
  const body = '{"type":"membership_activated","data":{}}';
  const sig = signStandardWebhook(id, timestamp, body, testSecret);

  const result = verifyStandardWebhookSignature(body, {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': sig,
  });
  assert.strictEqual(result, true);

  // Restore for other tests
  process.env.WHOP_WEBHOOK_SECRET = 'whsec_test_secret_value';
});

test('wrong signature returns false', () => {
  const testKey = Buffer.from('test-secret-key-bytes').toString('base64');
  process.env.WHOP_WEBHOOK_SECRET = `whsec_${testKey}`;

  const result = verifyStandardWebhookSignature('{"x":1}', {
    'webhook-id': 'msg_x',
    'webhook-timestamp': '12345',
    'webhook-signature': 'v1,wrongbase64sig==',
  });
  assert.strictEqual(result, false);
  process.env.WHOP_WEBHOOK_SECRET = 'whsec_test_secret_value';
});

test('missing webhook-id returns false', () => {
  const result = verifyStandardWebhookSignature('{"x":1}', {
    'webhook-timestamp': '12345',
    'webhook-signature': 'v1,abc',
  });
  assert.strictEqual(result, false);
});

test('missing webhook-timestamp returns false', () => {
  const result = verifyStandardWebhookSignature('{"x":1}', {
    'webhook-id': 'msg_x',
    'webhook-signature': 'v1,abc',
  });
  assert.strictEqual(result, false);
});

test('missing webhook-signature returns false', () => {
  const result = verifyStandardWebhookSignature('{"x":1}', {
    'webhook-id': 'msg_x',
    'webhook-timestamp': '12345',
  });
  assert.strictEqual(result, false);
});

test('tampered body fails verification', () => {
  const testKey = Buffer.from('test-secret-key-bytes').toString('base64');
  const testSecret = `whsec_${testKey}`;
  process.env.WHOP_WEBHOOK_SECRET = testSecret;

  const original = '{"type":"membership_activated"}';
  const tampered = '{"type":"membership_deactivated"}';
  const sig = signStandardWebhook('msg_x', '12345', original, testSecret);

  const result = verifyStandardWebhookSignature(tampered, {
    'webhook-id': 'msg_x',
    'webhook-timestamp': '12345',
    'webhook-signature': sig,
  });
  assert.strictEqual(result, false);
  process.env.WHOP_WEBHOOK_SECRET = 'whsec_test_secret_value';
});

test('handles multiple signatures separated by spaces', () => {
  const testKey = Buffer.from('test-secret-key-bytes').toString('base64');
  const testSecret = `whsec_${testKey}`;
  process.env.WHOP_WEBHOOK_SECRET = testSecret;

  const body = '{"x":1}';
  const sig = signStandardWebhook('msg_x', '12345', body, testSecret);
  // Format: first one is fake/old, second is valid
  const headerValue = `v1,fakeoldsig== ${sig}`;

  const result = verifyStandardWebhookSignature(body, {
    'webhook-id': 'msg_x',
    'webhook-timestamp': '12345',
    'webhook-signature': headerValue,
  });
  assert.strictEqual(result, true);
  process.env.WHOP_WEBHOOK_SECRET = 'whsec_test_secret_value';
});

// =============================================================
// PRODUCT → TIER MAPPING
// =============================================================

suite('tierForProduct');

test('Pro product maps to pro tier', () => {
  assert.strictEqual(tierForProduct('prod_lmpUuEximUX8d'), 'pro');
});

test('Member product maps to free tier (no tool access)', () => {
  assert.strictEqual(tierForProduct('prod_zcXCHFY02Q5pf'), 'free');
});

test('unknown product returns null', () => {
  assert.strictEqual(tierForProduct('prod_unknown_xyz'), null);
});

test('null product returns null', () => {
  assert.strictEqual(tierForProduct(null), null);
});

test('empty product returns null', () => {
  assert.strictEqual(tierForProduct(''), null);
});

// =============================================================
// EVENT PARSING
// =============================================================

suite('parseEvent');

test('standard Whop activation payload', () => {
  const result = parseEvent({
    type: 'membership_activated',
    data: {
      id: 'mem_abc123',
      product_id: 'prod_lmpUuEximUX8d',
      expires_at: '2026-06-30T00:00:00Z',
      user: { discord_id: '111222333' }
    }
  });
  assert.strictEqual(result.type, 'membership_activated');
  assert.strictEqual(result.discordId, '111222333');
  assert.strictEqual(result.productId, 'prod_lmpUuEximUX8d');
  assert.strictEqual(result.membershipId, 'mem_abc123');
  assert.strictEqual(result.periodEnd, '2026-06-30T00:00:00Z');
});

test('alternate field names: action, membership_id, discord_user_id', () => {
  const result = parseEvent({
    action: 'membership_deactivated',
    data: {
      membership_id: 'mem_xyz',
      product: { id: 'prod_zcXCHFY02Q5pf' },
      discord_user_id: '999888777',
      period_end: '2026-07-01T00:00:00Z'
    }
  });
  assert.strictEqual(result.type, 'membership_deactivated');
  assert.strictEqual(result.discordId, '999888777');
  assert.strictEqual(result.productId, 'prod_zcXCHFY02Q5pf');
  assert.strictEqual(result.membershipId, 'mem_xyz');
});

test('null payload returns null', () => {
  assert.strictEqual(parseEvent(null), null);
});

test('payload without type returns null', () => {
  assert.strictEqual(parseEvent({ data: { id: 'x' } }), null);
});

test('handles nested discord_user.id', () => {
  const result = parseEvent({
    type: 'membership_activated',
    data: {
      id: 'mem_1',
      discord_user: { id: '12345' }
    }
  });
  assert.strictEqual(result.discordId, '12345');
});

// =============================================================
// FIND USER BY DISCORD ID — mock Supabase admin
// =============================================================

function makeSupabaseMock(options = {}) {
  const {
    users = [],
    profileUpdateResult = { error: null },
    insertResult = { error: null },
  } = options;
  let updateCalls = [];
  let insertCalls = [];
  let listUsersCalls = 0;

  return {
    auth: {
      admin: {
        async listUsers({ page, perPage }) {
          listUsersCalls++;
          // Single-page mock: return all users on page 1, empty on page 2+
          if (page === 1) return { data: { users }, error: null };
          return { data: { users: [] }, error: null };
        }
      }
    },
    from(table) {
      return {
        update(values) {
          updateCalls.push({ table, values });
          return {
            eq(_col, _val) {
              return Promise.resolve(profileUpdateResult);
            }
          };
        },
        insert(values) {
          insertCalls.push({ table, values });
          return Promise.resolve(insertResult);
        }
      };
    },
    _peek() {
      return { updateCalls, insertCalls, listUsersCalls };
    }
  };
}

suite('findUserByDiscordId');

test('finds user by user_metadata.provider_id', async () => {
  const mock = makeSupabaseMock({
    users: [
      { id: 'uuid-1', user_metadata: { provider_id: '111' } },
      { id: 'uuid-2', user_metadata: { provider_id: '222' } },
    ]
  });
  const user = await findUserByDiscordId(mock, '222');
  assert.ok(user);
  assert.strictEqual(user.id, 'uuid-2');
});

test('finds user by raw_user_meta_data.sub', async () => {
  const mock = makeSupabaseMock({
    users: [
      { id: 'uuid-x', raw_user_meta_data: { sub: '333' } }
    ]
  });
  const user = await findUserByDiscordId(mock, '333');
  assert.ok(user);
  assert.strictEqual(user.id, 'uuid-x');
});

test('finds user by identities[].id when provider is discord', async () => {
  const mock = makeSupabaseMock({
    users: [
      {
        id: 'uuid-id',
        user_metadata: {},
        identities: [{ provider: 'discord', id: '444' }]
      }
    ]
  });
  const user = await findUserByDiscordId(mock, '444');
  assert.ok(user);
  assert.strictEqual(user.id, 'uuid-id');
});

test('returns null when no user matches', async () => {
  const mock = makeSupabaseMock({
    users: [{ id: 'u', user_metadata: { provider_id: 'other' } }]
  });
  const user = await findUserByDiscordId(mock, 'nonexistent');
  assert.strictEqual(user, null);
});

test('returns null for empty discord ID', async () => {
  const mock = makeSupabaseMock();
  const user = await findUserByDiscordId(mock, '');
  assert.strictEqual(user, null);
});

test('handles numeric Discord ID by string-comparing', async () => {
  const mock = makeSupabaseMock({
    users: [{ id: 'u', user_metadata: { provider_id: 12345 } }]  // stored as number
  });
  const user = await findUserByDiscordId(mock, '12345');  // queried as string
  assert.ok(user);
});

// =============================================================
// APPLY EVENT TO PROFILE
// =============================================================

suite('applyEventToProfile');

test('membership_activated for Pro product sets tier=pro', async () => {
  const mock = makeSupabaseMock();
  const result = await applyEventToProfile(mock, {
    user: { id: 'user-uuid-1' },
    eventType: 'membership_activated',
    productId: 'prod_lmpUuEximUX8d',
    membershipId: 'mem_123',
    periodEnd: '2026-07-01T00:00:00Z',
  });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.tier, 'pro');
  const { updateCalls } = mock._peek();
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(updateCalls[0].values.tier, 'pro');
  assert.strictEqual(updateCalls[0].values.subscription_status, 'active');
  assert.strictEqual(updateCalls[0].values.subscription_source, 'whop');
  assert.strictEqual(updateCalls[0].values.subscription_id, 'mem_123');
});

test('membership_activated for Member product sets tier=free (NO tool access)', async () => {
  const mock = makeSupabaseMock();
  const result = await applyEventToProfile(mock, {
    user: { id: 'user-uuid-2' },
    eventType: 'membership_activated',
    productId: 'prod_zcXCHFY02Q5pf',
    membershipId: 'mem_456',
    periodEnd: '2026-07-01T00:00:00Z',
  });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.tier, 'free');
  const { updateCalls } = mock._peek();
  assert.strictEqual(updateCalls[0].values.tier, 'free');
  // Still records the subscription, just doesn't grant tool access
  assert.strictEqual(updateCalls[0].values.subscription_status, 'active');
  assert.strictEqual(updateCalls[0].values.subscription_id, 'mem_456');
});

test('membership_activated for unknown product does not update profile', async () => {
  const mock = makeSupabaseMock();
  const result = await applyEventToProfile(mock, {
    user: { id: 'u' },
    eventType: 'membership_activated',
    productId: 'prod_unknown',
    membershipId: 'mem_x',
    periodEnd: null,
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'unknown_product');
  assert.strictEqual(mock._peek().updateCalls.length, 0);
});

test('membership_deactivated sets status=canceled, keeps tier intact', async () => {
  const mock = makeSupabaseMock();
  const result = await applyEventToProfile(mock, {
    user: { id: 'user-uuid' },
    eventType: 'membership_deactivated',
    productId: 'prod_lmpUuEximUX8d',
    membershipId: 'mem_canc',
  });
  assert.strictEqual(result.applied, true);
  const { updateCalls } = mock._peek();
  assert.strictEqual(updateCalls[0].values.subscription_status, 'canceled');
  // Critically, tier should NOT be in the update (so user keeps access until period_end)
  assert.strictEqual(updateCalls[0].values.tier, undefined);
});

test('no user → no profile update, returns reason', async () => {
  const mock = makeSupabaseMock();
  const result = await applyEventToProfile(mock, {
    user: null,
    eventType: 'membership_activated',
    productId: 'prod_lmpUuEximUX8d',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'no_user_match');
});

test('database error returns applied=false with db_error reason', async () => {
  const mock = makeSupabaseMock({
    profileUpdateResult: { error: { message: 'connection lost' } }
  });
  const result = await applyEventToProfile(mock, {
    user: { id: 'u' },
    eventType: 'membership_activated',
    productId: 'prod_lmpUuEximUX8d',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'db_error');
});

test('unhandled event type returns reason', async () => {
  const mock = makeSupabaseMock();
  const result = await applyEventToProfile(mock, {
    user: { id: 'u' },
    eventType: 'some.other.event',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'unhandled_event_type');
});

// =============================================================
// LOG EVENT
// =============================================================

suite('logEvent');

test('inserts row in subscription_events with source=whop', async () => {
  const mock = makeSupabaseMock();
  await logEvent(mock, {
    userId: 'u1',
    eventType: 'membership_activated',
    payload: { type: 'membership_activated', data: {} },
  });
  const { insertCalls } = mock._peek();
  assert.strictEqual(insertCalls.length, 1);
  assert.strictEqual(insertCalls[0].table, 'subscription_events');
  assert.strictEqual(insertCalls[0].values.source, 'whop');
  assert.strictEqual(insertCalls[0].values.event_type, 'membership_activated');
  assert.strictEqual(insertCalls[0].values.user_id, 'u1');
});

test('logs even when userId is null', async () => {
  const mock = makeSupabaseMock();
  await logEvent(mock, {
    userId: null,
    eventType: 'unknown',
    payload: {},
  });
  const { insertCalls } = mock._peek();
  assert.strictEqual(insertCalls[0].values.user_id, null);
});

test('logEvent does not throw on DB insert failure (just warns)', async () => {
  const mock = makeSupabaseMock({
    insertResult: { error: { message: 'insert failed' } }
  });
  // Should not throw
  await logEvent(mock, {
    userId: 'u',
    eventType: 'e',
    payload: {},
  });
  // Reached this point = test passed
});

// =============================================================
// FULL HANDLER (end-to-end with mocks)
// =============================================================

suite('handler (full request flow)');

function makeReq({ body, headers = {}, method = 'POST' }) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method,
    body: typeof body === 'string' ? body : body,
    rawBody: bodyStr,
    headers,
  };
}
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; }
  };
  return res;
}

function signBody(body) {
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHmac('sha256', 'whsec_test_secret_value').update(str).digest('hex');
}

test('rejects non-POST', async () => {
  const req = makeReq({ body: {}, method: 'GET' });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 405);
});

test('rejects invalid signature', async () => {
  const req = makeReq({
    body: { type: 'membership_activated' },
    headers: { 'x-whop-signature': 'invalid_sig' }
  });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 401);
});

test('valid Pro activation updates profile via mocked admin client', async () => {
  const mock = makeSupabaseMock({
    users: [{ id: 'uuid-pro', user_metadata: { provider_id: '777' } }]
  });
  _setAdminClientForTesting(mock);

  const body = {
    type: 'membership_activated',
    data: {
      id: 'mem_pro_123',
      product_id: 'prod_lmpUuEximUX8d',
      expires_at: '2026-07-30T00:00:00Z',
      user: { discord_id: '777' }
    }
  };
  const req = makeReq({ body, headers: { 'x-whop-signature': signBody(body) } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.tier, 'pro');

  const { updateCalls, insertCalls } = mock._peek();
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(updateCalls[0].values.tier, 'pro');
  assert.strictEqual(insertCalls.length, 1);  // audit row inserted

  _setAdminClientForTesting(null);
});

test('Member activation results in tier=free (no tool access)', async () => {
  const mock = makeSupabaseMock({
    users: [{ id: 'uuid-mem', user_metadata: { provider_id: '888' } }]
  });
  _setAdminClientForTesting(mock);

  const body = {
    type: 'membership_activated',
    data: {
      id: 'mem_456',
      product_id: 'prod_zcXCHFY02Q5pf',
      expires_at: '2026-07-30T00:00:00Z',
      user: { discord_id: '888' }
    }
  };
  const req = makeReq({ body, headers: { 'x-whop-signature': signBody(body) } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  const { updateCalls } = mock._peek();
  assert.strictEqual(updateCalls[0].values.tier, 'free');
  _setAdminClientForTesting(null);
});

test('cancellation sets status=canceled without changing tier', async () => {
  const mock = makeSupabaseMock({
    users: [{ id: 'uuid-canc', user_metadata: { provider_id: '999' } }]
  });
  _setAdminClientForTesting(mock);

  const body = {
    type: 'membership_deactivated',
    data: {
      id: 'mem_c',
      product_id: 'prod_lmpUuEximUX8d',
      user: { discord_id: '999' }
    }
  };
  const req = makeReq({ body, headers: { 'x-whop-signature': signBody(body) } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  const { updateCalls } = mock._peek();
  assert.strictEqual(updateCalls[0].values.subscription_status, 'canceled');
  assert.strictEqual(updateCalls[0].values.tier, undefined);  // tier preserved
  _setAdminClientForTesting(null);
});

test('unknown event type is acknowledged 200 but logged', async () => {
  const mock = makeSupabaseMock();
  _setAdminClientForTesting(mock);

  const body = { type: 'some_other_event', data: { id: 'x' } };
  const req = makeReq({ body, headers: { 'x-whop-signature': signBody(body) } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ignored, 'some_other_event');
  const { insertCalls, updateCalls } = mock._peek();
  assert.strictEqual(insertCalls.length, 1);  // logged
  assert.strictEqual(updateCalls.length, 0);  // not applied
  _setAdminClientForTesting(null);
});

test('event with unmatched Discord ID still logs but no profile update', async () => {
  const mock = makeSupabaseMock({
    users: [{ id: 'uuid-other', user_metadata: { provider_id: 'different' } }]
  });
  _setAdminClientForTesting(mock);

  const body = {
    type: 'membership_activated',
    data: {
      id: 'mem_z',
      product_id: 'prod_lmpUuEximUX8d',
      user: { discord_id: 'unmatched' }
    }
  };
  const req = makeReq({ body, headers: { 'x-whop-signature': signBody(body) } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.applied, false);
  assert.strictEqual(res.body.reason, 'no_user_match');
  const { insertCalls, updateCalls } = mock._peek();
  assert.strictEqual(insertCalls.length, 1);  // audit log written even with no match
  assert.strictEqual(updateCalls.length, 0);
  _setAdminClientForTesting(null);
});

runAll();
