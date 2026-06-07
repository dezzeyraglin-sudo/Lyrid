-- ============================================================================
-- Drop #20 — June 7, 2026: Cross-device audit sync
-- ============================================================================
-- Two tables store the empirical audit history per user, so empirical strategies
-- (Drop #12 totals/ML, Drop #16 HR-trap, Drop #17/18 HR tiers) work identically
-- across devices instead of depending on browser localStorage.
--
-- Both tables use RLS so users can only read/write their own rows.
-- Both have deterministic IDs that match existing client-side IDs for idempotent
-- upserts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Table 1: projection_audit
-- One row per (user, game). Records projected total + actual outcome.
-- Used by computeEmpiricalTotalStrategy, computeEmpiricalMLStrategy,
-- computeLeagueEnvironment.
-- ---------------------------------------------------------------------------
create table if not exists public.projection_audit (
  -- Composite PK so the SAME game logged by different users doesn't collide
  user_id        uuid        not null references auth.users(id) on delete cascade,
  audit_key      text        not null,                        -- "{date}_{gamePk}" matches client storage key
  game_pk        bigint      not null,
  game_date      date        not null,
  away_team      text,
  home_team      text,
  proj_total     numeric(5,2),
  actual_total   numeric(5,2),
  actual_away_runs integer,
  actual_home_runs integer,
  home_win_prob  numeric(5,4),                                -- model's home win probability at analysis time
  graded         boolean     not null default false,
  raw            jsonb,                                       -- full client object, for forward compat
  updated_at     timestamptz not null default now(),
  primary key (user_id, audit_key)
);

create index if not exists projection_audit_user_date_idx
  on public.projection_audit(user_id, game_date desc);

create index if not exists projection_audit_user_graded_idx
  on public.projection_audit(user_id, graded)
  where graded = true;

-- ---------------------------------------------------------------------------
-- Table 2: hr_audit
-- One row per (user, game, hitter). Records HR-chance pick + actual outcome.
-- Used by Drop #16 HR-trap detector (reads criteria text per game),
-- Drop #18 HR tier system (rollup stats), HR Picks history view.
-- ---------------------------------------------------------------------------
create table if not exists public.hr_audit (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  entry_id          text        not null,                     -- "{date}_{gamePk}_{hitterId}" matches client
  game_pk           bigint      not null,
  game_date         date        not null,
  hitter_id         integer,
  hitter_name       text,
  team              text,
  opponent          text,
  pitcher_name      text,
  hr_tier           text,                                     -- legacy: elite|strong|solid
  hr_score          integer,
  criteria          jsonb,                                    -- ["16.6% Barrel% (2.2x league)", "Coors Field (+25% HR)", ...]
  empirical_tier    text,                                     -- Drop #17/18: elite|platinum|gold|silver|bronze
  empirical_tier_label text,
  empirical_backtest_rate numeric(5,4),
  empirical_backtest_n integer,
  emp_barrel        numeric(5,2),
  emp_hr_per_9      numeric(5,2),
  emp_park_boost    numeric(5,2),
  actual_hr         boolean,
  graded            boolean     not null default false,
  line_pa           integer,
  line_hr           integer,
  line              jsonb,                                    -- full box-score line
  logged_at         bigint,                                   -- client's Date.now() at log time
  updated_at        timestamptz not null default now(),
  primary key (user_id, entry_id)
);

create index if not exists hr_audit_user_date_idx
  on public.hr_audit(user_id, game_date desc);

create index if not exists hr_audit_user_gamepk_idx
  on public.hr_audit(user_id, game_pk);

create index if not exists hr_audit_user_graded_idx
  on public.hr_audit(user_id, graded)
  where graded = true;

-- ---------------------------------------------------------------------------
-- RLS: every user sees and writes only their own rows
-- ---------------------------------------------------------------------------
alter table public.projection_audit enable row level security;
alter table public.hr_audit enable row level security;

drop policy if exists "projection_audit_owner_select" on public.projection_audit;
create policy "projection_audit_owner_select"
  on public.projection_audit for select
  using (auth.uid() = user_id);

drop policy if exists "projection_audit_owner_write" on public.projection_audit;
create policy "projection_audit_owner_write"
  on public.projection_audit for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "hr_audit_owner_select" on public.hr_audit;
create policy "hr_audit_owner_select"
  on public.hr_audit for select
  using (auth.uid() = user_id);

drop policy if exists "hr_audit_owner_write" on public.hr_audit;
create policy "hr_audit_owner_write"
  on public.hr_audit for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Touch updated_at on every UPDATE so client can resync on watermark
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projection_audit_touch_updated on public.projection_audit;
create trigger projection_audit_touch_updated
  before update on public.projection_audit
  for each row execute function public.touch_updated_at();

drop trigger if exists hr_audit_touch_updated on public.hr_audit;
create trigger hr_audit_touch_updated
  before update on public.hr_audit
  for each row execute function public.touch_updated_at();
