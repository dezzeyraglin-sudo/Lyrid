#!/usr/bin/env python3
"""
Lyrid NFL — coverage allowed BY POSITION GROUP (Layer 5e).
RBs are covered by LBs/safeties, not corners, so RB-receiving matchups need their
own path: join pbp receivers to their position and aggregate per defense.
Validated 2024: DET 8.23 / DAL 7.65 worst vs RB receivers; LAC 4.05 best.
Writes nfl_defense_coverage_by_pos (DDL footer).
"""
import argparse, os
import pandas as pd, requests
NV="https://github.com/nflverse/nflverse-data/releases/download"

def build(season):
    pbp=pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
        columns=['defteam','receiver_player_id','receiving_yards','pass_attempt','complete_pass','epa'])
    rost=pd.read_parquet(f"{NV}/weekly_rosters/roster_weekly_{season}.parquet",columns=['gsis_id','position'])
    pos=rost.drop_duplicates('gsis_id').set_index('gsis_id')['position'].to_dict()
    p=pbp[pbp.pass_attempt==1].copy()
    p['rec_pos']=p.receiver_player_id.map(pos)
    rows=[]
    for grp in ['RB','TE','WR']:
        g=p[p.rec_pos==grp]
        a=g.groupby('defteam').agg(targets=('pass_attempt','sum'),yards=('receiving_yards','sum'),
                                   completions=('complete_pass','sum'),epa=('epa','mean')).reset_index()
        a['yards_per_target']=(a.yards/a.targets).round(3)
        a['catch_rate_allowed']=(a.completions/a.targets).round(3)
        a['pos_group']=grp; a['season']=season
        rows.append(a.rename(columns={'defteam':'team_abbr'}))
    return pd.concat(rows,ignore_index=True).round(4)

def upsert(df,table):
    url=os.environ['SUPABASE_URL'].rstrip('/')+f'/rest/v1/{table}'
    key=os.environ['SUPABASE_SERVICE_KEY']
    h={'apikey':key,'Authorization':f'Bearer {key}','Content-Type':'application/json',
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
    r=requests.post(url+'?on_conflict=team_abbr,season,pos_group',headers=h,data=_json.dumps(rows, allow_nan=False),timeout=60)
    print(f"  {table}: {r.status_code} ({len(rows)} rows)")
    if r.status_code>=300: print("   ",r.text[:200])

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--seasons',nargs='+',type=int,required=True)
    ap.add_argument('--dry-run',action='store_true'); a=ap.parse_args()
    for s in a.seasons:
        print(f"\n=== coverage by position {s} ===")
        df=build(s)
        if a.dry_run:
            print(df.sort_values(['pos_group','yards_per_target']).to_string(index=False)); continue
        upsert(df,'nfl_defense_coverage_by_pos')

# SCHEMA ADDITION:
# create table if not exists nfl_defense_coverage_by_pos (
#   id bigint generated always as identity primary key,
#   team_abbr text references nfl_teams(team_abbr), season int not null,
#   pos_group text check (pos_group in ('RB','TE','WR')) not null,
#   targets int, yards numeric, completions int, epa numeric,
#   yards_per_target numeric, catch_rate_allowed numeric,
#   updated_at timestamptz default now(), unique (team_abbr, season, pos_group)
# );
