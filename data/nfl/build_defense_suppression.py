#!/usr/bin/env python3
"""
Lyrid NFL engine — defensive suppression aggregator (Layer 5d-i).
Per-defense, per-season suppression profile from nflverse pbp:
  pass: epa_allowed, success_allowed, sack_rate, qb_hit_rate
  rush: epa_allowed, success_allowed, ypc_allowed
These feed: (1) the suppression feature, (2) QB outlook, (3) shootout probability.
Writes nfl_defense_suppression (DDL footer).
"""
import argparse, os
import pandas as pd
import requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"

def load(season):
    return pd.read_parquet(f"{NFLVERSE}/pbp/play_by_play_{season}.parquet",
        columns=['defteam','play_type','epa','success','pass','rush','yards_gained','sack','qb_hit'])

def suppression(pbp, season):
    d = pbp[pbp['play_type'].isin(['pass','run'])].copy()
    p = d[d['pass']==1].groupby('defteam').agg(
        pass_epa_allowed=('epa','mean'), pass_success_allowed=('success','mean'),
        sack_rate=('sack','mean'), qb_hit_rate=('qb_hit','mean'))
    r = d[d['rush']==1].groupby('defteam').agg(
        rush_epa_allowed=('epa','mean'), rush_success_allowed=('success','mean'),
        ypc_allowed=('yards_gained','mean'))
    m = p.join(r).round(4).reset_index().rename(columns={'defteam':'team_abbr'})
    m['season'] = season
    return m

def upsert(df, table):
    url = os.environ['SUPABASE_URL'].rstrip('/') + f'/rest/v1/{table}'
    key = os.environ['SUPABASE_SERVICE_KEY']
    h = {'apikey':key,'Authorization':f'Bearer {key}','Content-Type':'application/json',
         'Prefer':'resolution=merge-duplicates,return=minimal'}
    import math as _math, json as _json
    import numpy as _np
    _INT_COLS = {'season','week','targets','completions','attempts','carries','plays',
                 'pass_plays','wiped_pass_plays','dropbacks','sacks','hits','sacks_allowed',
                 'hits_allowed','times_sacked','times_pressured','times_blitzed','times_hurried',
                 'catches','games'}
    def _clean(v, as_int=False):
        if v is None: return None
        if isinstance(v, dict): return {k:_clean(x) for k,x in v.items()}
        try: f=float(v)
        except (TypeError, ValueError): return v
        if not _math.isfinite(f): return None
        return int(round(f)) if as_int else f
    rows = df.where(pd.notna(df), None).to_dict('records')
    rows = [{k:_clean(v, as_int=(k in _INT_COLS)) for k,v in r.items()} for r in rows]
    resp = requests.post(url+'?on_conflict=team_abbr,season', headers=h, data=_json.dumps(rows, allow_nan=False), timeout=60)
    print(f"  {table}: {resp.status_code} ({len(rows)} rows)")
    if resp.status_code>=300: print("   ", resp.text[:200])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    for s in a.seasons:
        print(f"\n=== suppression {s} ===")
        m = suppression(load(s), s)
        if a.dry_run:
            print(m.sort_values('pass_epa_allowed').to_string(index=False)); continue
        upsert(m, 'nfl_defense_suppression')

if __name__ == '__main__':
    main()

# SCHEMA ADDITION:
# create table if not exists nfl_defense_suppression (
#   id bigint generated always as identity primary key,
#   team_abbr text references nfl_teams(team_abbr), season int not null,
#   pass_epa_allowed numeric, pass_success_allowed numeric, sack_rate numeric, qb_hit_rate numeric,
#   rush_epa_allowed numeric, rush_success_allowed numeric, ypc_allowed numeric,
#   updated_at timestamptz default now(), unique (team_abbr, season)
# );
