-- supabase/migrations/20260530_existing_schema_snapshot.sql
--
-- Snapshot of the schema as it exists in production Supabase on May 30, 2026.
-- This migration is IDEMPOTENT — safe to run on a fresh database, no-op on
-- the existing production database (tables already exist).
--
-- Source: confirmed via information_schema.columns query on lyrid-prod
-- and pg_get_viewdef('entitlements', true).
--
-- This file exists for two reasons:
--   1. Disaster recovery — if Supabase project is deleted, we can recreate
--   2. Local development — running Supabase locally needs the schema applied
--
-- NOT TO BE RUN BLINDLY. Review before applying to a production database.

-- ============================================================
-- TABLE: profiles
-- ============================================================
-- One row per authenticated user. The `id` column matches auth.users.id.
-- This is the source of truth for tier, subscription state, and API keys.

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,                              -- matches auth.users.id
  email text NOT NULL,
  display_name text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  tier text NOT NULL DEFAULT 'free'                 -- 'free' | 'pro' | 'sharp'
    CHECK (tier IN ('free', 'pro', 'sharp')),
  subscription_source text,                         -- 'whop' | 'stripe' | null
  subscription_id text,                             -- external subscription ID
  subscription_status text,                         -- 'active' | 'trialing' | 'canceled' | 'expired'
  subscription_period_end timestamptz,
  api_key text,                                     -- Lyrid-issued API key
  api_key_created_at timestamptz,
  stripe_customer_id text                           -- legacy Stripe field
);

-- ============================================================
-- TABLE: subscription_events
-- ============================================================
-- Append-only audit log of every subscription-related event from any source
-- (whop, stripe, etc.). raw_payload stores the full webhook body for
-- debugging. Past Claude wrote events for both Stripe and Whop.

CREATE TABLE IF NOT EXISTS public.subscription_events (
  id bigserial PRIMARY KEY,
  user_id uuid,                                     -- nullable: events may arrive before match
  source text NOT NULL,                             -- 'whop' | 'stripe' | 'manual'
  event_type text NOT NULL,                         -- 'membership_activated', etc.
  raw_payload jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_events_user_id_idx
  ON public.subscription_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS subscription_events_source_idx
  ON public.subscription_events (source, created_at DESC);

-- ============================================================
-- TABLE: daily_usage
-- ============================================================
-- Per-user, per-day count of deep-mode analyses. Used for free-tier rate
-- limiting (3 deep analyses/day).

CREATE TABLE IF NOT EXISTS public.daily_usage (
  user_id uuid NOT NULL,
  date date NOT NULL,
  deep_analyses_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- ============================================================
-- VIEW: entitlements
-- ============================================================
-- Computed access state. is_pro_active is true if user has pro OR sharp tier
-- (sharp is a superset of pro). is_sharp_active is true only for sharp.
--
-- Grace period: when subscription_status = 'canceled', user retains access
-- until subscription_period_end passes. This means cancelling mid-month
-- doesn't immediately lock out a user who paid for that month.

CREATE OR REPLACE VIEW public.entitlements AS
SELECT
  p.id AS user_id,
  p.tier,
  p.subscription_status,
  p.subscription_period_end,
  CASE
    WHEN p.tier = 'free' THEN false
    WHEN p.subscription_status IN ('active', 'trialing') THEN true
    WHEN p.subscription_status = 'canceled'
      AND p.subscription_period_end > now() THEN true
    ELSE false
  END AS is_pro_active,
  CASE
    WHEN p.tier <> 'sharp' THEN false
    WHEN p.subscription_status IN ('active', 'trialing') THEN true
    WHEN p.subscription_status = 'canceled'
      AND p.subscription_period_end > now() THEN true
    ELSE false
  END AS is_sharp_active
FROM public.profiles p;

-- ============================================================
-- RPC: increment_daily_usage
-- ============================================================
-- Atomic increment of a user's daily counter. Used by the auth/quota system
-- to enforce free-tier limits without race conditions.
--
-- Returns the new count after increment. Caller is responsible for checking
-- whether the new count exceeds the tier limit and rolling back if so.

CREATE OR REPLACE FUNCTION public.increment_daily_usage(
  p_user_id uuid,
  p_date date,
  p_field text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_count integer;
BEGIN
  IF p_field <> 'deep_analyses' THEN
    RAISE EXCEPTION 'Unknown usage field: %', p_field;
  END IF;

  INSERT INTO public.daily_usage (user_id, date, deep_analyses_count)
  VALUES (p_user_id, p_date, 1)
  ON CONFLICT (user_id, date)
    DO UPDATE SET deep_analyses_count = daily_usage.deep_analyses_count + 1
  RETURNING deep_analyses_count INTO new_count;

  RETURN new_count;
END;
$$;

-- ============================================================
-- TRIGGER: auto-create profile on signup
-- ============================================================
-- When a new auth.users row is created (via Discord OAuth signup),
-- automatically create a corresponding profiles row with default tier='free'.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, tier)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', NULL),
    'free'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- RLS POLICIES (the basics)
-- ============================================================
-- Server-side service-role queries bypass RLS, so these only restrict
-- what authenticated browser sessions can read directly.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT
  USING (auth.uid() = id);

-- Users can read their own usage
DROP POLICY IF EXISTS "Users can read own usage" ON public.daily_usage;
CREATE POLICY "Users can read own usage" ON public.daily_usage
  FOR SELECT
  USING (auth.uid() = user_id);

-- subscription_events: only server-side service role can read/write
-- (no SELECT policy = nothing readable by authenticated users)
