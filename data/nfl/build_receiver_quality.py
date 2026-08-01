#!/usr/bin/env python3
"""
Lyrid NFL — receiver resilience + snap security (Layer 5g).

receiver CPOE: actual catch rate minus mean completion probability of his targets
  (pbp `cp`). Positive = converts throws he statistically shouldn't — the
  "catches bad balls" trait that SHIELDS a receiver from an inaccurate QB.
  Validated 2024: Kittle +18.2, M.Andrews +17.7, Thielen +16.4; brittle ~-12/-14.
  League mean ~+1.8, sd ~6.0. TE-skewed, so we store position for normalization.

snap security: mean + SD of offense_pct. High mean + LOW sd = every-down (Garrett
  Wilson .963/.044). High mean + high sd = role changing, baseline is stale.

Writes nfl_receiver_quality (DDL footer).
"""
import argparse, os
import pandas as pd, requests
NV="https://github.com/nflverse/nflverse-data/releases/download"

def build(season, min_targets=30):
    pbp=pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
        columns=['receiver_player_id','receiver_player_name','complete_pass','cp','pass_attempt','air_yards'])
    p=pbp[(pbp.pass_attempt==1)&pbp.cp.notna()&pbp.receiver_player_id.notna()]
    g=p.groupby(['receiver_player_id','receiver_player_name']).agg(
        targets=('pass_attempt','sum'),catches=('complete_pass','sum'),
        exp_cp=('cp','mean'),adot=('air_yards','mean')).reset_index()
    g=g[g.targets>=min_targets]
    g['catch_rate']=g.catches/g.targets
    g['rec_cpoe']=((g.catch_rate-g.exp_cp)*100).round(2)
    g=g.rename(columns={'receiver_player_id':'player_key','receiver_player_name':'player_name'})

    # snaps
    try:
        s=pd.read_parquet(f"{NV}/snap_counts/snap_counts_{season}.parquet")
        sn=s[s.offense_snaps>0].groupby('pfr_player_id').agg(
            position=('position','first'),
            offense_pct_mean=('offense_pct','mean'),offense_pct_sd=('offense_pct','std'),
            games=('week','count')).reset_index()
        # snap file keys on pfr id; join on name as a pragmatic fallback
        nm=s[s.offense_snaps>0].groupby('player').agg(
            position=('position','first'),
            offense_pct_mean=('offense_pct','mean'),offense_pct_sd=('offense_pct','std'),
            games=('week','count')).reset_index()
        g['_last']=g.player_name.str.split('.').str[-1].str.lower()
        nm['_last']=nm.player.str.split(' ').str[-1].str.lower()
        g=g.merge(nm[['_last','position','offense_pct_mean','offense_pct_sd','games']],
                  on='_last',how='left').drop_duplicates('player_key').drop(columns=['_last'])
    except Exception as e:
        print("  [warn] snaps:",str(e)[:70])
        for c in ['position','offense_pct_mean','offense_pct_sd','games']: g[c]=None
    g['season']=season
    return g.round(4)

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
    for i in range(0,len(rows),500):
        r=requests.post(url+'?on_conflict=player_key,season',headers=h,data=_json.dumps(rows[i:i+500], allow_nan=False),timeout=60)
        print(f"  {table}: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--seasons',nargs='+',type=int,required=True)
    ap.add_argument('--dry-run',action='store_true'); a=ap.parse_args()
    for s in a.seasons:
        print(f"\n=== receiver quality {s} ===")
        df=build(s)
        if a.dry_run:
            print(df.nlargest(6,'rec_cpoe')[['player_name','targets','rec_cpoe','offense_pct_mean']].to_string(index=False)); continue
        upsert(df,'nfl_receiver_quality')

# SCHEMA ADDITION:
# create table if not exists nfl_receiver_quality (
#   id bigint generated always as identity primary key,
#   player_key text not null, player_name text, position text, season int not null,
#   targets int, catches int, catch_rate numeric, exp_cp numeric, rec_cpoe numeric, adot numeric,
#   offense_pct_mean numeric, offense_pct_sd numeric, games int,
#   updated_at timestamptz default now(), unique (player_key, season)
# );
