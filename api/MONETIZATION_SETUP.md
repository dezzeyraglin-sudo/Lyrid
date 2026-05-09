# Mismatch Finder — Monetization Setup Guide

This guide walks through getting Stripe + Supabase + RevenueCat configured. Do these steps in order.

## Phase 1: Supabase (do first)

### 1.1 Create the project

1. Go to https://supabase.com → New project
2. Name it `mismatch-finder` (or whatever you prefer)
3. Pick a region close to your Vercel deployment (US East works for most)
4. Save the database password somewhere safe — you can't retrieve it later
5. Wait ~2 min for provisioning

### 1.2 Run migrations

Two ways:

**Option A — Supabase CLI (recommended):**
```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

**Option B — Manual paste:**
1. Open Supabase Dashboard → SQL Editor
2. Paste contents of `supabase/migrations/20260424_initial_schema.sql`
3. Click Run
4. Paste contents of `supabase/migrations/20260424_rpc_functions.sql`
5. Click Run

### 1.3 Get your keys

Supabase Dashboard → Settings → API:
- **Project URL** → `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`
- **anon public** → `SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **service_role** → `SUPABASE_SERVICE_ROLE_KEY` (KEEP SECRET — never put in browser code)

### 1.4 Configure auth providers

Dashboard → Authentication → Providers:
- **Email** is on by default — leave it
- Optional: enable Google OAuth for one-tap signup. Need to set up Google OAuth credentials first; can defer.
- Optional: enable Apple OAuth (required for iOS App Store approval if you offer "Sign in with Apple")

Dashboard → Authentication → URL Configuration:
- Site URL: `https://mismatch-finder.vercel.app`
- Redirect URLs: add `https://mismatch-finder.vercel.app/auth/callback` and `mismatch://auth/callback` (for the mobile app)

## Phase 2: Stripe (web subscriptions)

### 2.1 Create products

Stripe Dashboard → Products → Add product:

**Pro tier:**
- Name: `Mismatch Finder Pro`
- Description: `Unlimited deep analyses, game-line bets, YRFI/NRFI, pitcher props, calibration tracker`
- Pricing:
  - Recurring monthly: $19.00 USD
  - Recurring yearly: $149.00 USD
- Copy each price ID into your env vars

**Sharp tier:**
- Name: `Mismatch Finder Sharp`
- Description: `Everything in Pro plus projection audit data export, personal API key, priority support`
- Pricing:
  - Recurring monthly: $39.00 USD
  - Recurring yearly: $299.00 USD

### 2.2 Customer portal

Dashboard → Settings → Billing → Customer portal:
- Enable customer portal
- Allow customers to: cancel, update payment method, view invoices
- Set the brand name to "Mismatch Finder"

### 2.3 Webhook (do this in Session 2)

Will be configured in next session when we add the webhook handler endpoint.

## Phase 3: RevenueCat (deferred to Session 3)

This is for iOS/Android in-app subscriptions. Skip until mobile auth is wired up.

## Phase 4: Vercel env vars

Vercel Dashboard → Project → Settings → Environment Variables. Add all the vars from `.env.example` with real values.

After adding, redeploy.

## Verifying it works

After Phase 1 is done:

```bash
curl https://mismatch-finder.vercel.app/api/me
# Should return: {"authenticated": false, "tier": "free", ...}
```

Once user-facing UI is added (Session 2), you can test full auth flow.

## Troubleshooting

**"SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars must be set"** — env vars not set in Vercel. After adding, redeploy.

**Webhook 400s** — wrong webhook secret, or you didn't pass `req.body` as raw bytes (Stripe needs raw body for signature verification).

**RLS blocks queries** — server endpoints should use `getSupabaseAdmin()` not the anon client. Anon client respects RLS; admin client bypasses it.

**User signs up but no profile created** — the `handle_new_user` trigger isn't firing. Check Dashboard → Database → Triggers. May need to re-run the migration.
