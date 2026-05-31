// Tests for api/auth/me.js
//
// Covers: pre-monetization mode, unauthenticated request, authenticated
// requests across tier values, OPTIONS preflight, wrong methods.

import assert from 'assert';

// Set env vars BEFORE importing the handler
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_service_role_key';
delete process.env.MONETIZATION_LAUNCHED;  // default pre-monetization mode

const { default: handler } = await import('../api/auth/me.js');
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

function makeReq({ method = 'GET', headers = {} } = {}) {
  return { method, headers };
}
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; }
  };
}

// =============================================================
// PRE-MONETIZATION MODE (MONETIZATION_LAUNCHED not set)
// =============================================================

suite('Pre-monetization mode');

test('returns Pro user state for any request (no auth needed)', async () => {
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.authenticated, true);
  assert.strictEqual(res.body.user.tier, 'pro');
  assert.strictEqual(res.body.user.isPro, true);
  assert.strictEqual(res.body.user.isSharp, false);
  assert.strictEqual(res.body.preMonetization, true);
});

test('does not fetch daily usage in pre-monetization (would fail with no DB)', async () => {
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.body.usage, null);
});

// =============================================================
// METHOD HANDLING
// =============================================================

suite('HTTP method handling');

test('OPTIONS returns 200 with CORS headers', async () => {
  const req = makeReq({ method: 'OPTIONS' });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.headers['Access-Control-Allow-Origin']);
});

test('POST is rejected with 405', async () => {
  const req = makeReq({ method: 'POST' });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 405);
});

// =============================================================
// LIVE MODE — MONETIZATION_LAUNCHED=true
// =============================================================

suite('Live monetization mode');

test('unauthenticated request returns 401 when monetization launched', async () => {
  process.env.MONETIZATION_LAUNCHED = 'true';

  const req = makeReq();  // no Authorization header
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.authenticated, false);
  assert.strictEqual(res.body.code, 'AUTH_REQUIRED');

  delete process.env.MONETIZATION_LAUNCHED;
});

test('authenticated Pro user returns tier=pro and usage', async () => {
  process.env.MONETIZATION_LAUNCHED = 'true';

  const mockUser = { id: 'uuid-pro-user', email: 'pro@example.com' };
  const mockEntitlement = {
    user_id: 'uuid-pro-user',
    tier: 'pro',
    subscription_status: 'active',
    subscription_period_end: '2026-07-01T00:00:00Z',
    is_pro_active: true,
    is_sharp_active: false,
  };
  const mockUsage = { deep_analyses_count: 0 };  // Pro users have no quota; this should be ignored

  const mockSupabase = {
    auth: {
      async getUser(token) {
        if (token === 'valid_token') return { data: { user: mockUser }, error: null };
        return { data: { user: null }, error: { message: 'Invalid' } };
      }
    },
    from(table) {
      return {
        select() { return this; },
        eq(_col, _val) { return this; },
        single() {
          if (table === 'entitlements') return Promise.resolve({ data: mockEntitlement, error: null });
          if (table === 'daily_usage') return Promise.resolve({ data: mockUsage, error: null });
          return Promise.resolve({ data: null, error: { message: 'unknown table' } });
        }
      };
    }
  };

  _setAdminClientForTesting(mockSupabase);

  const req = makeReq({ headers: { authorization: 'Bearer valid_token' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.authenticated, true);
  assert.strictEqual(res.body.user.id, 'uuid-pro-user');
  assert.strictEqual(res.body.user.tier, 'pro');
  assert.strictEqual(res.body.user.isPro, true);
  assert.strictEqual(res.body.user.isSharp, false);
  assert.strictEqual(res.body.preMonetization, false);

  _setAdminClientForTesting(null);
  delete process.env.MONETIZATION_LAUNCHED;
});

test('free tier user gets tier=free, isPro=false', async () => {
  process.env.MONETIZATION_LAUNCHED = 'true';

  const mockSupabase = {
    auth: {
      async getUser(token) {
        return { data: { user: { id: 'uuid-free', email: 'free@example.com' } }, error: null };
      }
    },
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        single() {
          if (table === 'entitlements') {
            return Promise.resolve({
              data: {
                user_id: 'uuid-free', tier: 'free', subscription_status: null,
                subscription_period_end: null, is_pro_active: false, is_sharp_active: false
              },
              error: null
            });
          }
          return Promise.resolve({ data: { deep_analyses_count: 2 }, error: null });
        }
      };
    }
  };

  _setAdminClientForTesting(mockSupabase);

  const req = makeReq({ headers: { authorization: 'Bearer valid_token' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.user.tier, 'free');
  assert.strictEqual(res.body.user.isPro, false);
  assert.strictEqual(res.body.user.isSharp, false);

  _setAdminClientForTesting(null);
  delete process.env.MONETIZATION_LAUNCHED;
});

test('sharp tier user has both isPro and isSharp true', async () => {
  process.env.MONETIZATION_LAUNCHED = 'true';

  const mockSupabase = {
    auth: {
      async getUser(token) {
        return { data: { user: { id: 'uuid-sharp', email: 's@example.com' } }, error: null };
      }
    },
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        single() {
          if (table === 'entitlements') {
            return Promise.resolve({
              data: {
                user_id: 'uuid-sharp', tier: 'sharp',
                subscription_status: 'active', subscription_period_end: '2026-12-01',
                is_pro_active: true, is_sharp_active: true
              },
              error: null
            });
          }
          return Promise.resolve({ data: { deep_analyses_count: 0 }, error: null });
        }
      };
    }
  };

  _setAdminClientForTesting(mockSupabase);

  const req = makeReq({ headers: { authorization: 'Bearer sharp_token' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.body.user.tier, 'sharp');
  assert.strictEqual(res.body.user.isPro, true);
  assert.strictEqual(res.body.user.isSharp, true);

  _setAdminClientForTesting(null);
  delete process.env.MONETIZATION_LAUNCHED;
});

test('invalid token returns 401', async () => {
  process.env.MONETIZATION_LAUNCHED = 'true';

  const mockSupabase = {
    auth: {
      async getUser(token) {
        return { data: { user: null }, error: { message: 'Invalid token' } };
      }
    },
    from() { throw new Error('should not query DB for invalid token'); }
  };

  _setAdminClientForTesting(mockSupabase);

  const req = makeReq({ headers: { authorization: 'Bearer bogus_token' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.code, 'AUTH_REQUIRED');

  _setAdminClientForTesting(null);
  delete process.env.MONETIZATION_LAUNCHED;
});

test('missing Bearer prefix returns 401', async () => {
  process.env.MONETIZATION_LAUNCHED = 'true';

  const req = makeReq({ headers: { authorization: 'just_a_token_no_bearer' } });
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res.statusCode, 401);

  delete process.env.MONETIZATION_LAUNCHED;
});

runAll();
