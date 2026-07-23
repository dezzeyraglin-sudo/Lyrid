-- ============================================================================
-- Lyrid NFL Engine — Supabase migration
-- Run in Supabase SQL editor (lyrid-prod). Idempotent: safe to re-run.
-- Convention notes:
--   * BDL/nflverse ids are integers; we keep a text player_key for cross-source joins.
--   * DK backtest lines and manual pick'em lines live in SEPARATE tables on purpose
--     (the manual set is a biased sample and must never contaminate backtest tiers).
--   * All feature values are stored pre-computed and leak-guarded (as_of_kickoff).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. REFERENCE: teams (offense/defense/special-teams live as unit rows)
-- ---------------------------------------------------------------------------
create table if not exists nfl_teams (
  team_abbr      text primary key,                 -- 'KC','BUF', etc.
  full_name      text not null,
  conference     text check (conference in ('AFC','NFC')),
  division       text check (division in ('North','South','East','West')),
  home_stadium   text,                             -- joins nfl_stadiums.stadium_key
  updated_at     timestamptz default now()
);

create table if not exists nfl_stadiums (
  stadium_key      text primary key,               -- team abbr of primary tenant, e.g. 'DEN'
  name             text not null,
  roof             text check (roof in ('dome','retractable','outdoor')) not null,
  surface          text check (surface in ('grass','turf')),
  lat              numeric,
  lon              numeric,
  altitude_ft      integer default 0,
  weather_relevant boolean default true,           -- false for domes / dry retractables
  tz               text,
  updated_at       timestamptz default now()
);

-- Coaching: head coach free from nflverse schedules; coordinators scraped.
-- One row per team per season per role; role tenure tracked via season.
create table if not exists nfl_coaches (
  id           bigint generated always as identity primary key,
  team_abbr    text references nfl_teams(team_abbr),
  season       int not null,
  role         text check (role in ('HC','OC','DC','STC')) not null,   -- special-teams coord included
  coach_name   text not null,
  scheme_tag   text,                               -- e.g. 'air_raid','wide_zone','cover3_heavy' (nullable, scraped/derived)
  source       text default 'nflverse',
  updated_at   timestamptz default now(),
  unique (team_abbr, season, role)
);

-- ---------------------------------------------------------------------------
-- 2. PLAYER GAME LOGS + ADVANCED STATS (from nflverse backfill)
--    Backbone of the comp database and backtest outcomes.
-- ---------------------------------------------------------------------------
create table if not exists nfl_player_games (
  id              bigint generated always as identity primary key,
  player_key      text not null,                   -- cross-source stable key (gsis_id preferred)
  player_name     text not null,
  position        text,                            -- QB/RB/WR/TE
  team_abbr       text,
  opponent_abbr   text,
  season          int not null,
  week            int not null,
  game_id         text,                            -- nflverse game_id
  is_home         boolean,
  -- outcomes (the prop targets)
  passing_yards   numeric,
  rushing_yards   numeric,
  receiving_yards numeric,
  rush_rec_yards  numeric generated always as (coalesce(rushing_yards,0)+coalesce(receiving_yards,0)) stored,
  pass_attempts   int,
  rush_attempts   int,
  targets         int,
  receptions      int,
  -- volume-security inputs
  snaps           int,
  snap_share      numeric,
  route_participation numeric,
  target_share    numeric,
  air_yards_share numeric,
  -- efficiency / skill
  cpoe            numeric,                          -- passing
  ryoe_per_att    numeric,                          -- rushing
  avg_separation  numeric,                          -- receiving
  -- context
  team_implied_total numeric,
  spread          numeric,                          -- signed for player's team (negative = favored)
  game_total      numeric,
  was_garbage_time boolean default false,
  ingested_at     timestamptz default now(),
  unique (player_key, season, week)
);

create index if not exists idx_nfl_pg_lookup on nfl_player_games (player_key, season, week);
create index if not exists idx_nfl_pg_comp on nfl_player_games (position, season, week);

-- ---------------------------------------------------------------------------
-- 3. HISTORICAL DK PROP LINES (from The Odds API) — the BACKTEST line source
-- ---------------------------------------------------------------------------
create table if not exists nfl_prop_lines_historical (
  id              bigint generated always as identity primary key,
  game_id         text,                            -- odds-api event id; matched to nflverse
  player_key      text,                            -- resolved after name-match (nullable until matched)
  player_name_raw text not null,                   -- as returned by odds api
  prop_type       text not null check (prop_type in ('passing_yards','rushing_yards','receiving_yards','rush_rec_yards')),
  line            numeric not null,
  over_odds       int,
  under_odds      int,
  vendor          text default 'draftkings',
  snapshot_at     timestamptz not null,            -- pre-kickoff snapshot time
  season          int,
  week            int,
  ingested_at     timestamptz default now()
);

create index if not exists idx_nfl_lines_hist on nfl_prop_lines_historical (season, week, prop_type);
create index if not exists idx_nfl_lines_hist_player on nfl_prop_lines_historical (player_key, season, week);

-- ---------------------------------------------------------------------------
-- 4. FEATURE VECTORS (pre-computed, leak-guarded) — what the comp engine reads
-- ---------------------------------------------------------------------------
create table if not exists nfl_feature_vectors (
  id                bigint generated always as identity primary key,
  player_key        text not null,
  season            int not null,
  week              int not null,
  prop_type         text not null,
  as_of_kickoff     timestamptz not null,          -- leakage guard: features use only pre-this data
  -- three-filter signals
  volume_floor_score numeric,                       -- higher = more volume-secure
  game_script_risk   numeric,                        -- higher = more blowout/abandon risk
  line_softness      numeric,                        -- DK line minus modeled median (for OVER)
  -- environment nudges (from nflEnvironment.js)
  env_total_nudge    numeric default 0,
  env_detail         jsonb,                          -- {wind, precip, altitude_carry, roof, ...}
  -- matchup
  opp_yards_allowed_pos numeric,
  opp_epa_allowed       numeric,
  -- packed feature vector for kNN (standardized)
  feature_json      jsonb not null,
  built_at          timestamptz default now(),
  unique (player_key, season, week, prop_type)
);

create index if not exists idx_nfl_feat on nfl_feature_vectors (season, week, prop_type);

-- ---------------------------------------------------------------------------
-- 5. BACKTEST GRADES (walk-forward) — tier calibration reads ONLY from here
-- ---------------------------------------------------------------------------
create table if not exists nfl_backtest_grades (
  id              bigint generated always as identity primary key,
  line_id         bigint references nfl_prop_lines_historical(id),
  player_key      text,
  season          int, week int,
  prop_type       text,
  line            numeric,
  engine_pick     text check (engine_pick in ('higher','lower','pass')),
  engine_edge     numeric,                          -- P(over) - breakeven
  p_over          numeric,
  tier_candidate  text check (tier_candidate in ('GOLD','PLATINUM','GUARANTEED','none')),
  actual          numeric,
  result          text check (result in ('win','loss','push','void')),
  fold            text,                             -- e.g. 'train2023','test2024','test2025'
  graded_at       timestamptz default now()
);

create index if not exists idx_nfl_grades_tier on nfl_backtest_grades (tier_candidate, result);
create index if not exists idx_nfl_grades_fold on nfl_backtest_grades (fold, prop_type);

-- ---------------------------------------------------------------------------
-- 6. MANUAL PICK'EM TRACKER (Underdog / PrizePicks) — live validation, user-scoped
--    SEPARATE from backtest. Never feeds tier math.
-- ---------------------------------------------------------------------------
create table if not exists nfl_pickem_manual (
  id             bigint generated always as identity primary key,
  user_id        uuid references auth.users not null,
  app            text check (app in ('underdog','prizepicks','sleeper')) not null,
  player_name    text not null,
  player_key     text,                              -- resolved via player search
  prop_type      text not null,
  line           numeric not null,
  pick           text check (pick in ('higher','lower')),
  game_date      date not null,
  season         int, week int,
  engine_verdict text,                              -- what nflClassify said at entry
  engine_edge    numeric,
  actual         numeric,                            -- filled by grader
  result         text check (result in ('win','loss','push','void','pending')) default 'pending',
  source         text default 'manual',              -- 'manual' or 'autofetch'
  created_at     timestamptz default now()
);

alter table nfl_pickem_manual enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='nfl_pickem_manual' and policyname='own_rows_select') then
    create policy own_rows_select on nfl_pickem_manual for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='nfl_pickem_manual' and policyname='own_rows_insert') then
    create policy own_rows_insert on nfl_pickem_manual for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='nfl_pickem_manual' and policyname='own_rows_update') then
    create policy own_rows_update on nfl_pickem_manual for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='nfl_pickem_manual' and policyname='own_rows_delete') then
    create policy own_rows_delete on nfl_pickem_manual for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. LIVE PROP LINES (current slate, from free odds tier / BDL) — non-user
-- ---------------------------------------------------------------------------
create table if not exists nfl_prop_lines_live (
  id            bigint generated always as identity primary key,
  game_id       text,
  player_key    text,
  player_name   text not null,
  prop_type     text not null,
  line          numeric not null,
  over_odds     int,
  under_odds    int,
  vendor        text,                                -- 'draftkings','underdog','prizepicks',...
  season        int, week int,
  fetched_at    timestamptz default now()
);

create index if not exists idx_nfl_live on nfl_prop_lines_live (season, week, prop_type, vendor);

-- ============================================================================
-- End migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 8. TEAM TENDENCIES (from build_team_tendencies.py) — PROE / offensive identity
-- ---------------------------------------------------------------------------
create table if not exists nfl_team_tendencies (
  id bigint generated always as identity primary key,
  team_abbr text references nfl_teams(team_abbr),
  season int not null,
  proe_pct numeric,                 -- pass rate over expected (%), game-script neutral
  neutral_pass_rate_pct numeric,
  plays_per_game numeric,
  identity text check (identity in ('pass_heavy','run_heavy','balanced','unknown')),
  updated_at timestamptz default now(),
  unique (team_abbr, season)
);

-- ---------------------------------------------------------------------------
-- 9. DEFENSE SCHEME (from build_defense_scheme.py) — man/zone/blitz tendencies
--    NOTE: prior-season tendency prior (participation data is post-season, ends 2024)
-- ---------------------------------------------------------------------------
create table if not exists nfl_defense_scheme (
  id bigint generated always as identity primary key,
  team_abbr text references nfl_teams(team_abbr),
  season int not null,
  man_rate numeric, zone_rate numeric, blitz_rate numeric,
  heavy_box_rate numeric, pressure_rate numeric,
  cover1_share numeric, cover2_share numeric, cover3_share numeric, cover4_share numeric,
  updated_at timestamptz default now(),
  unique (team_abbr, season)
);

-- ---------------------------------------------------------------------------
-- 10. DEFENSE SUPPRESSION (from build_defense_suppression.py) — EPA/YPC allowed
-- ---------------------------------------------------------------------------
create table if not exists nfl_defense_suppression (
  id bigint generated always as identity primary key,
  team_abbr text references nfl_teams(team_abbr), season int not null,
  pass_epa_allowed numeric, pass_success_allowed numeric, sack_rate numeric, qb_hit_rate numeric,
  rush_epa_allowed numeric, rush_success_allowed numeric, ypc_allowed numeric,
  updated_at timestamptz default now(), unique (team_abbr, season)
);

-- ---------------------------------------------------------------------------
-- 13. COVERAGE ALLOWED BY POSITION GROUP (build_coverage_by_position.py)
--     RBs are covered by LB/S, not CBs — this is the RB-receiving matchup path.
-- ---------------------------------------------------------------------------
create table if not exists nfl_defense_coverage_by_pos (
  id bigint generated always as identity primary key,
  team_abbr text references nfl_teams(team_abbr), season int not null,
  pos_group text check (pos_group in ('RB','TE','WR')) not null,
  targets int, yards numeric, completions int, epa numeric,
  yards_per_target numeric, catch_rate_allowed numeric,
  updated_at timestamptz default now(), unique (team_abbr, season, pos_group)
);

-- ---------------------------------------------------------------------------
-- 14. DAY-OF AVAILABILITY SNAPSHOTS (nflInactives.js) — audit trail for the gate
-- ---------------------------------------------------------------------------
create table if not exists nfl_availability_snapshots (
  id bigint generated always as identity primary key,
  game_date date not null,
  player_name text not null,
  team_abbr text, position text,
  status text check (status in ('active','doubtful','out','unknown')),
  status_raw text, detail text,
  fetched_at timestamptz default now(),
  unique (game_date, player_name)
);

-- ---------------------------------------------------------------------------
-- 15. PENALTY DRAG (build_penalty_drag.py) — completed catches erased by flags
-- ---------------------------------------------------------------------------
create table if not exists nfl_team_penalty_drag (
  id bigint generated always as identity primary key,
  team_abbr text references nfl_teams(team_abbr), season int not null,
  pass_plays int, wiped_pass_plays int, nullify_pct numeric, top_penalty text,
  updated_at timestamptz default now(), unique (team_abbr, season)
);

-- ---------------------------------------------------------------------------
-- 16. RECEIVER / QB EFFICIENCY (pfr_advstats) — drops + accuracy
-- ---------------------------------------------------------------------------
create table if not exists nfl_player_efficiency (
  id bigint generated always as identity primary key,
  player_key text not null, season int not null, week int,
  receiving_drop int, receiving_drop_pct numeric,
  passing_bad_throws int, passing_bad_throw_pct numeric, passing_drop_pct numeric,
  target_rate numeric,
  updated_at timestamptz default now(), unique (player_key, season, week)
);

-- ---------------------------------------------------------------------------
-- 17. RECEIVER QUALITY (build_receiver_quality.py)
--     rec_cpoe = catches balls he statistically shouldn't ("catches bad balls") —
--     this is the SHIELD against an inaccurate QB. Plus snap-share security.
-- ---------------------------------------------------------------------------
create table if not exists nfl_receiver_quality (
  id bigint generated always as identity primary key,
  player_key text not null, player_name text, position text, season int not null,
  targets int, catches int, catch_rate numeric, exp_cp numeric, rec_cpoe numeric, adot numeric,
  offense_pct_mean numeric, offense_pct_sd numeric, games int,
  updated_at timestamptz default now(), unique (player_key, season)
);

-- ---------------------------------------------------------------------------
-- 18-19. PRESSURE PROFILES (build_pressure_profiles.py)
--   QB: sacks-per-pressure (escapability), and where the ball goes under duress
--       (TE dump-off lean, aDOT hold vs collapse) — this REDISTRIBUTES yardage
--       between a team's own pass-catchers.
--   TEAM: protection allowed (offense) vs pressure generated (defense).
-- ---------------------------------------------------------------------------
create table if not exists nfl_qb_pressure_profile (
  id bigint generated always as identity primary key,
  player_key text not null, player_name text, season int not null, attempts int,
  te_share_clean numeric, te_share_pressured numeric,
  adot_clean numeric, adot_pressured numeric, pressure_rate numeric,
  times_sacked int, times_pressured int, times_blitzed int, times_hurried int,
  sack_per_pressure numeric,
  updated_at timestamptz default now(), unique (player_key, season)
);

create table if not exists nfl_team_pressure (
  id bigint generated always as identity primary key,
  team_abbr text references nfl_teams(team_abbr), season int not null,
  dropbacks int, sacks_allowed int, hits_allowed int, sack_pct_allowed numeric,
  sacks int, hits int, plays int, sack_rate numeric, pressure_rate numeric,
  updated_at timestamptz default now(), unique (team_abbr, season)
);
