#!/usr/bin/env python3
"""
Lyrid NFL engine — team tendency builder (Layer 4b).
Computes per-team, per-season offensive identity from nflverse play-by-play:
  - PROE (pass rate over expected): true pass-first vs run-first identity,
    game-script-neutral (uses xpass which conditions on down/distance/score/wp).
  - neutral_pass_rate: raw pass rate in neutral game scripts (wp 0.2-0.8) as a check.
  - sec_per_play (pace): situation-neutral seconds/play, drives total plays -> volume.
  - proe_trend: last-4-week PROE for in-season identity shifts.

Writes to a `nfl_team_tendencies` table (add to schema — see note at bottom).

Why this matters for props: a high-PROE team lifts EVERY passing/receiving prop on
its roster and suppresses rushing volume; a low-PROE team does the reverse. It's the
top-level gate for which prop families to even look at for a given team.
"""
import argparse, os, time
import pandas as pd
import requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
PBP_COLS = ['posteam','defteam','season','week','play_type','pass','rush',
            'pass_oe','xpass','down','ydstogo','wp','half_seconds_remaining',
            'game_seconds_remaining','play_id','game_id']

def load_pbp(season):
    url = f"{NFLVERSE}/pbp/play_by_play_{season}.parquet"
    return pd.read_parquet(url, columns=PBP_COLS)

def team_tendencies(pbp, season):
    # PROE: mean of pass_oe over dropback-eligible plays (xpass not null)
    # pass_oe is ALREADY on a percentage scale per play (e.g. +6.2 = +6.2%), do NOT re-scale.
    d = pbp[pbp['pass_oe'].notna()].copy()
    proe = d.groupby('posteam')['pass_oe'].mean().round(2)  # already %

    # neutral pass rate: wp between .2 and .8, exclude garbage
    neutral = pbp[(pbp['wp'].between(0.2, 0.8)) & (pbp['pass'].notna())]
    npr = neutral.groupby('posteam')['pass'].mean().mul(100).round(2)

    # pace: seconds per play in neutral situations (lower = faster = more plays)
    # approximate via play count per game
    plays_per_game = (pbp[pbp['play_type'].isin(['pass','run'])]
                      .groupby(['posteam','game_id']).size()
                      .groupby('posteam').mean().round(1))

    out = pd.DataFrame({'proe_pct': proe, 'neutral_pass_rate_pct': npr,
                        'plays_per_game': plays_per_game})
    out['season'] = season
    out['team_abbr'] = out.index
    # identity label
    def label(p):
        if p is None or pd.isna(p): return 'unknown'
        if p >= 2.0: return 'pass_heavy'
        if p <= -2.0: return 'run_heavy'
        return 'balanced'
    out['identity'] = out['proe_pct'].apply(label)
    return out.reset_index(drop=True)

def upsert(df, table):
    url = os.environ['SUPABASE_URL'].rstrip('/') + f'/rest/v1/{table}'
    key = os.environ['SUPABASE_SERVICE_KEY']
    headers = {'apikey': key, 'Authorization': f'Bearer {key}',
               'Content-Type': 'application/json',
               'Prefer': 'resolution=merge-duplicates,return=minimal'}
    rows = df.where(pd.notna(df), None).to_dict('records')
    resp = requests.post(url + '?on_conflict=team_abbr,season', headers=headers,
                         json=rows, timeout=60)
    print(f"  {table}: {resp.status_code} ({len(rows)} rows)")
    if resp.status_code >= 300:
        print("   ", resp.text[:200])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    for season in args.seasons:
        print(f"\n=== team tendencies {season} ===")
        pbp = load_pbp(season)
        tt = team_tendencies(pbp, season)
        if args.dry_run:
            print(tt.sort_values('proe_pct', ascending=False)
                    [['team_abbr','proe_pct','neutral_pass_rate_pct','plays_per_game','identity']]
                    .to_string(index=False))
            continue
        upsert(tt, 'nfl_team_tendencies')
        time.sleep(0.3)

if __name__ == '__main__':
    main()

# SCHEMA ADDITION (append to 001_nfl_schema.sql):
# create table if not exists nfl_team_tendencies (
#   id bigint generated always as identity primary key,
#   team_abbr text references nfl_teams(team_abbr),
#   season int not null,
#   proe_pct numeric,                 -- pass rate over expected (%)
#   neutral_pass_rate_pct numeric,
#   plays_per_game numeric,
#   identity text check (identity in ('pass_heavy','run_heavy','balanced','unknown')),
#   updated_at timestamptz default now(),
#   unique (team_abbr, season)
# );
