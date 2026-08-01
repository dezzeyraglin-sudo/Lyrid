#!/usr/bin/env python3
"""
Lyrid NFL — pressure profiles (Layer 5h).
Per QB:  sacks-per-pressure, pressure rate faced, TE-share + aDOT under pressure
         vs clean pocket (throwaways excluded).
Per team: pressure allowed (offense) and pressure generated (defense).

Validated 2024: TE lean B.Young +3.6pp / D.Jones +3.5pp / Herbert +2.9pp;
aDOT under pressure J.Allen +7.1 (escapes and throws deep) vs Purdy -1.2 (checkdown).
Throwaways are only 0.4% of pressured attempts, so they do NOT drive the effect.

Writes nfl_qb_pressure_profile + nfl_team_pressure (DDL footer).
"""
import argparse, os
import pandas as pd, requests
NV="https://github.com/nflverse/nflverse-data/releases/download"

def build_qb(season, min_att=200):
    part=pd.read_parquet(f"{NV}/pbp_participation/pbp_participation_{season}.parquet",
        columns=['nflverse_game_id','play_id','was_pressure'])
    pbp=pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
        columns=['game_id','play_id','passer_player_id','passer_player_name','receiver_player_id',
                 'air_yards','pass_attempt','sack','desc','posteam','defteam'])
    m=pbp.merge(part,left_on=['game_id','play_id'],right_on=['nflverse_game_id','play_id'],how='inner')
    rost=pd.read_parquet(f"{NV}/weekly_rosters/roster_weekly_{season}.parquet",columns=['gsis_id','position'])
    pos=rost.drop_duplicates('gsis_id').set_index('gsis_id')['position'].to_dict()
    m['rec_pos']=m.receiver_player_id.map(pos)
    m['throwaway']=m.desc.str.contains('thrown away',case=False,na=False)
    pa=m[(m.pass_attempt==1)&(~m.throwaway)]
    def agg(d):
        cl=d[d.was_pressure==0]; pr=d[d.was_pressure==1]
        return pd.Series({
            'attempts':len(d),
            'te_share_clean':(cl.rec_pos=='TE').mean() if len(cl) else None,
            'te_share_pressured':(pr.rec_pos=='TE').mean() if len(pr) else None,
            'adot_clean':cl.air_yards.mean(),'adot_pressured':pr.air_yards.mean(),
            'pressure_rate':d.was_pressure.mean(),
        })
    q=pa.groupby(['passer_player_id','passer_player_name']).apply(agg,include_groups=False).reset_index()
    q=q[q.attempts>=min_att]
    # sacks per pressure from PFR
    try:
        pf=pd.read_parquet(f"{NV}/pfr_advstats/advstats_week_pass_{season}.parquet")
        s=pf.groupby('pfr_player_name').agg(times_sacked=('times_sacked','sum'),
            times_pressured=('times_pressured','sum'),times_blitzed=('times_blitzed','sum'),
            times_hurried=('times_hurried','sum')).reset_index()
        s['sack_per_pressure']=(s.times_sacked/s.times_pressured).round(4)
        s['_last']=s.pfr_player_name.str.split(' ').str[-1].str.lower()
        q['_last']=q.passer_player_name.str.split('.').str[-1].str.lower()
        # last-name join can match multiple players (e.g. two 'Jones'); keep the
        # PFR row with the most pressures per last name, then dedupe on player_key.
        s=s.sort_values('times_pressured',ascending=False).drop_duplicates('_last')
        q=q.merge(s.drop(columns=['pfr_player_name']),on='_last',how='left').drop(columns=['_last'])
        q=q.drop_duplicates('passer_player_id')
    except Exception as e: print("  [warn] pfr:",str(e)[:70])
    q['season']=season
    return q.rename(columns={'passer_player_id':'player_key','passer_player_name':'player_name'}).round(4)

def build_team(season):
    pbp=pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
        columns=['posteam','defteam','sack','pass_attempt','qb_hit'])
    d=pbp[(pbp.pass_attempt==1)|(pbp.sack==1)]
    off=d.groupby('posteam').agg(dropbacks=('pass_attempt','count'),sacks_allowed=('sack','sum'),
        hits_allowed=('qb_hit','sum')).reset_index().rename(columns={'posteam':'team_abbr'})
    off['sack_pct_allowed']=(off.sacks_allowed/off.dropbacks).round(4)
    dfn=d.groupby('defteam').agg(sacks=('sack','sum'),hits=('qb_hit','sum'),
        plays=('pass_attempt','count')).reset_index().rename(columns={'defteam':'team_abbr'})
    dfn['sack_rate']=(dfn.sacks/dfn.plays).round(4)
    dfn['pressure_rate']=((dfn.sacks+dfn.hits)/dfn.plays).round(4)
    m=off.merge(dfn,on='team_abbr',how='outer'); m['season']=season
    return m.round(4)

def upsert(df,table,conflict):
    import math
    url=os.environ['SUPABASE_URL'].rstrip('/')+f'/rest/v1/{table}'
    key=os.environ['SUPABASE_SERVICE_KEY']
    h={'apikey':key,'Authorization':f'Bearer {key}',
       'Content-Type':'application/json',
       'Prefer':'resolution=merge-duplicates,return=minimal'}
    rows=df.where(pd.notna(df),None).to_dict('records')
    # bulletproof: walk every value and null out any non-finite float,
    # regardless of column dtype (df.replace can miss inf in object columns).
    for row in rows:
        for k,v in row.items():
            if isinstance(v,float) and not math.isfinite(v):
                row[k]=None
    r=requests.post(url+f'?on_conflict={conflict}',headers=h,json=rows,timeout=60)
    print(f"  {table}: {r.status_code} ({len(rows)} rows)")

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--seasons',nargs='+',type=int,required=True)
    ap.add_argument('--dry-run',action='store_true'); a=ap.parse_args()
    for s in a.seasons:
        print(f"\n=== pressure profiles {s} ===")
        q=build_qb(s); t=build_team(s)
        if a.dry_run:
            q['te_lean']=(q.te_share_pressured-q.te_share_clean).round(3)
            print(q.nlargest(5,'te_lean')[['player_name','attempts','te_lean','adot_clean','adot_pressured']].to_string(index=False))
            continue
        upsert(q,'nfl_qb_pressure_profile','player_key,season'); upsert(t,'nfl_team_pressure','team_abbr,season')

# SCHEMA ADDITIONS:
# create table if not exists nfl_qb_pressure_profile (
#   id bigint generated always as identity primary key,
#   player_key text not null, player_name text, season int not null, attempts int,
#   te_share_clean numeric, te_share_pressured numeric,
#   adot_clean numeric, adot_pressured numeric, pressure_rate numeric,
#   times_sacked int, times_pressured int, times_blitzed int, times_hurried int,
#   sack_per_pressure numeric,
#   updated_at timestamptz default now(), unique (player_key, season)
# );
# create table if not exists nfl_team_pressure (
#   id bigint generated always as identity primary key,
#   team_abbr text references nfl_teams(team_abbr), season int not null,
#   dropbacks int, sacks_allowed int, hits_allowed int, sack_pct_allowed numeric,
#   sacks int, hits int, plays int, sack_rate numeric, pressure_rate numeric,
#   updated_at timestamptz default now(), unique (team_abbr, season)
# );
