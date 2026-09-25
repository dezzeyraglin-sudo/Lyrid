#!/usr/bin/env python3
"""
Lyrid NFL — DEFENSE PACE / PASS-VOLUME-FACED (the volume half of a pass-game read).

Why: the defense-tier gate scores EFFICIENCY (yards per target allowed) but ignores VOLUME. A
soft pass D that faces 42 pass attempts/game is a far better receiving-over spot than an equally
soft D that faces 32 — same efficiency, ~30% more chances. Yards = efficiency x volume, and we've
been blind to the volume half. This measures how many plays and pass attempts each defense faces
per game (fast/slow pace, pass-heavy/run-heavy opponents), tiered across the league.

Method: from pbp, per defense — plays faced/game, pass attempts faced/game, pass rate faced.
Tiered high/avg/low by pass-attempts-faced percentile. Recency-weighted toward this season.
Output: nfl_defense_pace. Wired as a VOLUME modifier on the pass-game read (a soft-D over is
stronger in a high-volume spot, weaker in a low-volume one).

Reads nflverse pbp (latest 2 seasons). Run seasonally or every few weeks (pace moves slowly):
  python3 data/nfl/build_defense_pace.py
"""
import os, sys, json, argparse
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

def build(seasons):
    frames = []
    for s in seasons:
        try:
            pbp = pd.read_parquet(f"{NFLVERSE}/pbp/play_by_play_{s}.parquet",
                    columns=['season', 'week', 'defteam', 'play_type', 'pass', 'season_type', 'game_id'])
        except Exception as e:
            print(f"  (skip {s}: {e})"); continue
        pbp = pbp[(pbp['season_type'] == 'REG') & pbp['defteam'].notna() & pbp['play_type'].isin(['pass', 'run'])]
        frames.append(pbp)
    if not frames:
        print("no pbp data"); return pd.DataFrame()
    pbp = pd.concat(frames, ignore_index=True)
    latest = pbp['season'].max()
    # recency: weight the latest season 2x the prior one
    pbp['w'] = np.where(pbp['season'] == latest, 2.0, 1.0)
    rows = []
    for team, g in pbp.groupby('defteam'):
        games = g['game_id'].nunique()
        if not games:
            continue
        wsum = g['w'].sum()
        plays_pg = len(g) / games
        # weighted pass rate faced (recency), then attempts/game from the actual latest-season rate
        pass_rate = float(np.average(g['pass'].fillna(0), weights=g['w'])) if wsum else 0
        latest_g = g[g['season'] == latest]
        lg_games = latest_g['game_id'].nunique() or games
        pass_att_pg = (latest_g['pass'].sum() / lg_games) if lg_games else (g['pass'].sum() / games)
        rows.append({
            'team_abbr': team, 'plays_pg': round(plays_pg, 1),
            'pass_att_pg': round(float(pass_att_pg), 1), 'pass_rate_faced': round(pass_rate, 3),
            'games': int(games), 'last_season': int(latest),
        })
    df = pd.DataFrame(rows)
    if not len(df):
        return df
    # tier by pass attempts faced (the volume that matters for receiving/passing overs)
    v = df['pass_att_pg']; q1, q2 = v.quantile(0.33), v.quantile(0.67)
    df['volume_tier'] = np.where(v >= q2, 'high_volume', np.where(v <= q1, 'low_volume', 'avg_volume'))
    return df

def upsert(df):
    df['updated_at'] = pd.Timestamp.now(tz='UTC').isoformat()   # explicit — upsert UPDATE won't fire the column default
    rows = df.where(pd.notna(df), None).to_dict('records')
    r = requests.post(f"{SB}/rest/v1/nfl_defense_pace?on_conflict=team_abbr",
                      headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                      data=json.dumps(rows, allow_nan=False), timeout=60)
    print(f"  nfl_defense_pace: {r.status_code} ({len(rows)} teams)")
    if r.status_code >= 300: print("   ", r.text[:200])

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    seasons = sorted({pd.Timestamp.now().year, pd.Timestamp.now().year - 1})
    df = build(seasons)
    if not len(df): sys.exit(1)
    if a.dry_run:
        print(f"teams: {len(df)}\n=== HIGH-volume defenses (face most pass attempts — stronger receiving-over spots) ===")
        print(df.sort_values('pass_att_pg', ascending=False).head(6)[['team_abbr', 'pass_att_pg', 'plays_pg', 'pass_rate_faced', 'volume_tier']].to_string(index=False))
        print("\n=== LOW-volume defenses (fewest attempts — receiving overs need MORE than soft coverage here) ===")
        print(df.sort_values('pass_att_pg').head(6)[['team_abbr', 'pass_att_pg', 'plays_pg', 'pass_rate_faced', 'volume_tier']].to_string(index=False))
        sys.exit()
    upsert(df)

# SCHEMA:
# create table if not exists nfl_defense_pace (
#   id bigint generated always as identity primary key,
#   team_abbr text not null unique,
#   plays_pg numeric, pass_att_pg numeric, pass_rate_faced numeric,
#   volume_tier text, games int, last_season int,
#   updated_at timestamptz default now()
# );
