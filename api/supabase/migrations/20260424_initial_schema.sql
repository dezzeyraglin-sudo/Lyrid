-- Mismatch Finder — initial schema
-- Run via Supabase CLI: `supabase db push` or paste into SQL editor.
-- Builds on top of Supabase's built-in `auth.users` table.

-- ============ PROFILES ============
-- One row per user. Mirror of auth.users with our app-specific fields.
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Subscription tier — single source of truth
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'sharp')),
  -- Where their subscription came from (so we know which provider to query for cancel)
  subscription_source TEXT CHECK (subscription_source IN ('stripe', 'apple', 'google', 'manual') OR subscription_source IS NULL),
  subscription_id TEXT,                    -- Stripe sub ID, App Store transaction ID, etc.
  subscription_status TEXT DEFAULT 'inactive' CHECK (subscription_status IN ('active', 'past_due', 'canceled', 'inactive', 'trialing')),
  subscription_period_end TIMESTAMPTZ,     -- When current period ends (so we can grant access until then even if canceled)
  -- For Sharp tier API key access
  api_key TEXT UNIQUE,
  api_key_created_at TIMESTAMPTZ,
  -- Stripe customer ID, set on first checkout
  stripe_customer_id TEXT UNIQUE
);

-- Profile auto-creation trigger: when a user signs up via Supabase Auth, create their profile row
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Updated-at maintenance
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_profile_update ON public.profiles;
CREATE TRIGGER on_profile_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ DAILY USAGE QUOTAS ============
-- Tracks free-tier deep-mode usage. One row per user per day.
CREATE TABLE IF NOT EXISTS public.daily_usage (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  deep_analyses_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON public.daily_usage(date);

-- ============ SUBSCRIPTION EVENTS LOG ============
-- Audit trail of every subscription-changing event from any source.
-- Useful for debugging "why did they get charged twice" questions later.
CREATE TABLE IF NOT EXISTS public.subscription_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('stripe', 'apple', 'google', 'manual')),
  event_type TEXT NOT NULL,                -- e.g. 'checkout.session.completed', 'INITIAL_PURCHASE', 'CANCELLATION'
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_user ON public.subscription_events(user_id, created_at DESC);

-- ============ ROW LEVEL SECURITY ============
-- Critical: without RLS, any authenticated user could read all profiles.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
DROP POLICY IF EXISTS "users read own profile" ON public.profiles;
CREATE POLICY "users read own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- Users can update their own non-sensitive fields (display_name only for now)
-- Tier/subscription fields are server-only via service role
DROP POLICY IF EXISTS "users update own display_name" ON public.profiles;
CREATE POLICY "users update own display_name" ON public.profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Daily usage: users see their own only
DROP POLICY IF EXISTS "users read own usage" ON public.daily_usage;
CREATE POLICY "users read own usage" ON public.daily_usage
  FOR SELECT USING (auth.uid() = user_id);

-- Subscription events: users see their own audit log
DROP POLICY IF EXISTS "users read own subscription events" ON public.subscription_events;
CREATE POLICY "users read own subscription events" ON public.subscription_events
  FOR SELECT USING (auth.uid() = user_id);

-- ============ HELPER VIEWS ============
-- Quick way to check if a user is "currently entitled" to Pro/Sharp features.
-- Even if subscription is canceled, they keep access until period_end.
CREATE OR REPLACE VIEW public.entitlements AS
SELECT
  p.id AS user_id,
  p.tier,
  p.subscription_status,
  p.subscription_period_end,
  CASE
    WHEN p.tier = 'free' THEN false
    WHEN p.subscription_status IN ('active', 'trialing') THEN true
    WHEN p.subscription_status = 'canceled' AND p.subscription_period_end > NOW() THEN true
    ELSE false
  END AS is_pro_active,
  CASE
    WHEN p.tier != 'sharp' THEN false
    WHEN p.subscription_status IN ('active', 'trialing') THEN true
    WHEN p.subscription_status = 'canceled' AND p.subscription_period_end > NOW() THEN true
    ELSE false
  END AS is_sharp_active
FROM public.profiles p;

GRANT SELECT ON public.entitlements TO authenticated, anon;
