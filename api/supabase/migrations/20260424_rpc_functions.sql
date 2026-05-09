-- Mismatch Finder — RPC functions
-- Atomic operations that should run database-side rather than read-modify-write from app code.

-- ============ INCREMENT DAILY USAGE ============
-- Atomically increments a counter on daily_usage, creating the row if it doesn't exist.
-- Returns the NEW value of the counter so the caller can compare to quota.
CREATE OR REPLACE FUNCTION public.increment_daily_usage(
  p_user_id UUID,
  p_date DATE,
  p_field TEXT
)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  -- Currently only deep_analyses is tracked; future-proof by branching on field name
  IF p_field = 'deep_analyses' THEN
    INSERT INTO public.daily_usage (user_id, date, deep_analyses_count)
    VALUES (p_user_id, p_date, 1)
    ON CONFLICT (user_id, date)
    DO UPDATE SET deep_analyses_count = public.daily_usage.deep_analyses_count + 1
    RETURNING deep_analyses_count INTO new_count;
    RETURN new_count;
  END IF;
  RAISE EXCEPTION 'Unknown usage field: %', p_field;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============ APPLY SUBSCRIPTION CHANGE ============
-- Single entry point used by Stripe webhook handler AND RevenueCat webhook handler
-- to update a user's subscription state. Idempotent: re-running with the same
-- subscription_id won't double-grant or double-revoke.
CREATE OR REPLACE FUNCTION public.apply_subscription_change(
  p_user_id UUID,
  p_tier TEXT,
  p_source TEXT,
  p_subscription_id TEXT,
  p_status TEXT,
  p_period_end TIMESTAMPTZ,
  p_event_type TEXT,
  p_raw_payload JSONB
)
RETURNS VOID AS $$
BEGIN
  -- Update the profile in a single statement
  UPDATE public.profiles
  SET
    tier = p_tier,
    subscription_source = p_source,
    subscription_id = p_subscription_id,
    subscription_status = p_status,
    subscription_period_end = p_period_end,
    updated_at = NOW()
  WHERE id = p_user_id;

  -- Log the event for audit trail
  INSERT INTO public.subscription_events (user_id, source, event_type, raw_payload)
  VALUES (p_user_id, p_source, p_event_type, p_raw_payload);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============ GENERATE SHARP API KEY ============
-- Sharp tier perk: each user gets a personal API key for automation.
-- This generates a fresh one and rotates the old.
CREATE OR REPLACE FUNCTION public.rotate_api_key(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  new_key TEXT;
BEGIN
  -- 32 bytes of random data, base64-url-encoded ≈ 43 chars
  new_key := 'mf_sk_' || encode(gen_random_bytes(32), 'base64');
  -- Strip trailing = padding and replace +/- to make it URL-safe
  new_key := replace(replace(replace(new_key, '+', '-'), '/', '_'), '=', '');

  UPDATE public.profiles
  SET api_key = new_key, api_key_created_at = NOW()
  WHERE id = p_user_id AND tier = 'sharp';

  RETURN new_key;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
