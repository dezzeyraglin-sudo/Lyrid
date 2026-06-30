-- Lyrid · Parlay Maker (Drop #43)
-- Run on lyrid-prod (ref xtldczxlibdkwqvgmnob). Idempotent.

CREATE TABLE IF NOT EXISTS public.parlay_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  sport text NOT NULL DEFAULT 'mlb' CHECK (sport IN ('mlb','wnba','cs2','mixed')),
  slate_date date NOT NULL,
  ticket_type text NOT NULL CHECK (ticket_type IN ('power','flex')),
  leg_count int NOT NULL,
  combined_hit_rate numeric,
  floor_label text CHECK (floor_label IN ('elite','solid','lean')),
  legs jsonb NOT NULL,
  constraints jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','graded','void')),
  legs_hit int,
  won boolean,
  graded_at timestamptz
);

CREATE INDEX IF NOT EXISTS parlay_log_user_idx   ON public.parlay_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS parlay_log_status_idx ON public.parlay_log (status, slate_date);

ALTER TABLE public.parlay_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own parlays" ON public.parlay_log;
CREATE POLICY "Users read own parlays" ON public.parlay_log FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own parlays" ON public.parlay_log;
CREATE POLICY "Users insert own parlays" ON public.parlay_log FOR INSERT WITH CHECK (auth.uid() = user_id);
-- grading runs server-side; service role bypasses RLS, so no update policy needed
