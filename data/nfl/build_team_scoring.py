#!/usr/bin/env python3
"""
Lyrid NFL engine — team SCORING + offensive-EPA + pace aggregator (the offense half a
total needs). Mirrors build_defense_suppression's shape (per team, per season).

A total is team A points + team B points, and each team's points = their OFFENSE vs the
opponent's DEFENSE, scaled by pace. We already have the defense side (nfl_defense_suppression,
EPA-allowed) and tempo (nfl_team_week_env). This adds the offense side:
  points_for_pg, points_against_pg  — the real scoring anchors (from final scores)
  off_epa_play                      — offensive efficiency in expected-points units
  plays_pg                          — pace (offensive plays / game)

EPA is expected-points units, so it's a principled scoring signal, not a yardage proxy.
Season-level to pair 1:1 with the season-level defense table.

Reads: nflverse pbp. Writes: nfl_team_scoring (DDL footer).
"""
import argparse, os
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"

def load(season):
    return pd.read_parquet(f"{NFLVERSE}/pbp/play_by_play_{season}.parquet",
        columns=['game_id', 'season', 'week', 'home_team', 'away_team', 'home_score', 'away_score',
                 'posteam', 'play_type', 'epa', 'pass', 'rush'])

def team_scoring(pbp, season):
    # --- final scores per game -> per-team points for / against ---
    games = pbp[['game_id', 'home_team', 'away_team', 'home_score', 'away_score']] \
        .drop_duplicates('game_id').dropna(subset=['home_score', 'away_score'])
    long = pd.concat([
        games.rename(columns={'home_team': 'team_abbr', 'home_score': 'pf', 'away_score': 'pa'})[['team_abbr', 'pf', 'pa']],
        games.rename(columns={'away_team': 'team_abbr', 'away_score': 'pf', 'home_score': 'pa'})[['team_abbr', 'pf', 'pa']],
    ], ignore_index=True)
    sc = long.groupby('team_abbr').agg(
        points_for_pg=('pf', 'mean'), points_against_pg=('pa', 'mean'), games=('pf', 'size'))

    # --- offensive EPA/play + pace (offensive run/pass plays per game) ---
    off = pbp[pbp['play_type'].isin(['pass', 'run']) & pbp['posteam'].notna()]
    o = off.groupby('posteam').agg(off_epa_play=('epa', 'mean'), off_plays=('epa', 'size'))
    o.index.name = 'team_abbr'

    m = sc.join(o, how='left')
    m['plays_pg'] = (m['off_plays'] / m['games']).round(1)
    m['off_epa_play'] = m['off_epa_play'].round(4)
    m['points_for_pg'] = m['points_for_pg'].round(2)
    m['points_against_pg'] = m['points_against_pg'].round(2)
    m['season'] = int(season)
    m = m.reset_index()[['team_abbr', 'season', 'points_for_pg', 'points_against_pg',
                         'off_epa_play', 'plays_pg', 'games']]
    return m

def upsert(df, table):
    url = os.environ['SUPABASE_URL'].rstrip('/') + f'/rest/v1/{table}'
    key = os.environ['SUPABASE_SERVICE_KEY']
    h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
         'Prefer': 'resolution=merge-duplicates,return=minimal'}
    rows = df.where(pd.notna(df), None).to_dict('records')
    resp = requests.post(url + '?on_conflict=team_abbr,season', headers=h, json=rows, timeout=60)
    print(f"  {table}: {resp.status_code} ({len(rows)} rows)")
    if resp.status_code >= 300: print("   ", resp.text[:200])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    for s in a.seasons:
        print(f"\n=== team scoring {s} ===")
        m = team_scoring(load(s), s)
        if a.dry_run:
            print(m.sort_values('points_for_pg', ascending=False).to_string(index=False)); continue
        upsert(m, 'nfl_team_scoring')

if __name__ == '__main__':
    main()

# SCHEMA ADDITION:
# create table if not exists nfl_team_scoring (
#   id bigint generated always as identity primary key,
#   team_abbr text not null, season int not null,
#   points_for_pg numeric, points_against_pg numeric,
#   off_epa_play numeric, plays_pg numeric, games int,
#   updated_at timestamptz default now(), unique (team_abbr, season)
# );
