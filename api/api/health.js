// api/health.js
// Verifies the Supabase + Stripe connection. Hit this endpoint before
// flipping monetization on to confirm everything is wired correctly.
//
// Usage:
//   curl https://mismatch-finder.vercel.app/api/health
//
// Returns a JSON report. 200 means at least core (MLB API) is healthy.
// Each subsystem reports its own status so you know exactly what's missing.

import { isSupabaseConfigured, getSupabaseAdmin } from './_lib/supabase-admin.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const report = {
    timestamp: new Date().toISOString(),
    overall: 'unknown',
    subsystems: {
      mlbApi: { status: 'unknown', detail: '' },
      supabase: { status: 'unknown', detail: '' },
      supabaseSchema: { status: 'unknown', detail: '' },
      stripe: { status: 'unknown', detail: '' },
      oddsApi: { status: 'unknown', detail: '' },
    },
    monetizationReady: false,
    nextSteps: [],
  };

  // ============ 1. MLB API ============
  // Verifies the upstream data source we depend on for everything
  try {
    const r = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1', {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const data = await r.json();
      report.subsystems.mlbApi = {
        status: 'ok',
        detail: `${data.teams?.length || 0} teams loaded`,
      };
    } else {
      report.subsystems.mlbApi = { status: 'error', detail: `HTTP ${r.status}` };
    }
  } catch (err) {
    report.subsystems.mlbApi = { status: 'error', detail: err.message };
  }

  // ============ 2. Supabase configuration ============
  if (!isSupabaseConfigured()) {
    report.subsystems.supabase = {
      status: 'not_configured',
      detail: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars not set',
    };
    report.subsystems.supabaseSchema = {
      status: 'skipped',
      detail: 'Supabase not configured',
    };
    report.nextSteps.push(
      'Add SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY env vars to Vercel'
    );
  } else {
    try {
      const supabase = await getSupabaseAdmin();

      // Test basic connectivity by querying auth.users (always exists, controlled by Supabase)
      const { error: authErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (authErr) {
        report.subsystems.supabase = {
          status: 'error',
          detail: `Auth API: ${authErr.message}`,
        };
        report.nextSteps.push('Verify SUPABASE_SERVICE_ROLE_KEY is correct (not anon key)');
      } else {
        report.subsystems.supabase = {
          status: 'ok',
          detail: 'Connected, service-role authenticated',
        };

        // ============ 3. Schema verification ============
        // Check that our migrations have run by querying our tables
        const checks = await Promise.all([
          supabase.from('profiles').select('id').limit(1),
          supabase.from('daily_usage').select('user_id').limit(1),
          supabase.from('subscription_events').select('id').limit(1),
          supabase.from('entitlements').select('user_id').limit(1),
        ]);

        const missing = [];
        if (checks[0].error?.code === '42P01') missing.push('profiles table');
        if (checks[1].error?.code === '42P01') missing.push('daily_usage table');
        if (checks[2].error?.code === '42P01') missing.push('subscription_events table');
        if (checks[3].error?.code === '42P01') missing.push('entitlements view');

        if (missing.length > 0) {
          report.subsystems.supabaseSchema = {
            status: 'incomplete',
            detail: `Missing: ${missing.join(', ')}`,
          };
          report.nextSteps.push(
            'Run supabase/migrations/20260424_initial_schema.sql in Supabase SQL Editor'
          );
        } else {
          // Also verify RPC functions exist
          const { error: rpcErr } = await supabase.rpc('increment_daily_usage', {
            p_user_id: '00000000-0000-0000-0000-000000000000',
            p_date: '1970-01-01',
            p_field: 'deep_analyses',
          });
          // FK violation (23503) means RPC exists but the test user doesn't — that's expected
          // Function not found (42883) means RPC missing
          if (rpcErr?.code === '42883') {
            report.subsystems.supabaseSchema = {
              status: 'incomplete',
              detail: 'Tables exist but RPC functions missing',
            };
            report.nextSteps.push(
              'Run supabase/migrations/20260424_rpc_functions.sql in Supabase SQL Editor'
            );
          } else {
            report.subsystems.supabaseSchema = {
              status: 'ok',
              detail: 'All tables, views, and RPC functions present',
            };
          }
        }
      }
    } catch (err) {
      report.subsystems.supabase = {
        status: 'error',
        detail: err.message,
      };
      if (err.message.includes('@supabase/supabase-js is not installed')) {
        report.nextSteps.push('Run `npm install` to install @supabase/supabase-js package');
      }
    }
  }

  // ============ 4. Stripe (deferred — for future verification) ============
  if (!process.env.STRIPE_SECRET_KEY) {
    report.subsystems.stripe = {
      status: 'not_configured',
      detail: 'STRIPE_SECRET_KEY not set (expected during pre-monetization)',
    };
  } else {
    try {
      // Lazy import so missing package doesn't crash health check
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const account = await stripe.accounts.retrieve();
      report.subsystems.stripe = {
        status: 'ok',
        detail: `Connected to ${account.business_profile?.name || account.id}`,
      };
    } catch (err) {
      report.subsystems.stripe = {
        status: 'error',
        detail: err.message,
      };
    }
  }

  // ============ 5. The Odds API (pitcher props lines) ============
  if (!process.env.ODDS_API_KEY) {
    report.subsystems.oddsApi = {
      status: 'not_configured',
      detail: 'ODDS_API_KEY not set — pitcher prop line auto-pull disabled (manual entry still works)',
    };
  } else {
    try {
      const apiKey = process.env.ODDS_API_KEY;
      // Hit the sports list endpoint (cheapest call, validates key)
      const res = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${apiKey}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const remaining = res.headers.get('x-requests-remaining') || '?';
        const used = res.headers.get('x-requests-used') || '?';
        report.subsystems.oddsApi = {
          status: 'ok',
          detail: `Authenticated · ${remaining} requests remaining (${used} used this period)`,
        };
      } else {
        report.subsystems.oddsApi = {
          status: 'error',
          detail: `API returned ${res.status} — key may be invalid or quota exhausted`,
        };
      }
    } catch (err) {
      report.subsystems.oddsApi = {
        status: 'error',
        detail: err.message,
      };
    }
  }

  // ============ Compute overall + monetization readiness ============
  const subs = report.subsystems;
  report.overall =
    subs.mlbApi.status === 'ok' ? 'healthy' : 'degraded';

  report.monetizationReady =
    subs.supabase.status === 'ok' &&
    subs.supabaseSchema.status === 'ok';

  // Auth gate is ONLY active when Supabase is configured AND launch flag is set.
  // Until then, every API request is treated as a Pro user (pre-monetization mode).
  const launchFlag = process.env.MONETIZATION_LAUNCHED;
  const launchFlagSet = launchFlag === 'true' || launchFlag === '1' || launchFlag === 'yes';
  report.authGateActive = report.monetizationReady && launchFlagSet;
  report.mode = report.authGateActive ? 'live' : 'pre-monetization';

  if (report.monetizationReady && !launchFlagSet) {
    report.nextSteps.push(
      'When ready to launch monetization (login UI built, Stripe wired): set MONETIZATION_LAUNCHED=true env var in Vercel'
    );
  }

  if (report.authGateActive && report.nextSteps.length === 0) {
    report.nextSteps.push('Auth gate is live. All requests now require valid sign-in.');
  }

  return res.status(200).json(report);
}
