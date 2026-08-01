#!/usr/bin/env python3
"""
Lyrid NFL — penalty drag (Layer 5f-iii).
Measures how often a team's own penalties ERASE completed pass plays
(play_type == 'no_play' + offensive penalty). These wipe real receiving yards
while leaving target/volume data looking healthy.
Validated 2024: NE 4.10% of pass plays wiped vs LA 1.34% — ~3x spread.
Top causes: Offensive Holding, OPI, Ineligible Downfield.
Writes nfl_team_penalty_drag (DDL footer).
"""
import argparse, os
import pandas as pd, requests
NV="https://github.com/nflverse/nflverse-data/releases/download"

def build(season):
    pbp=pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
        columns=['posteam','penalty','penalty_team','penalty_type','play_type','desc','pass_attempt'])
    nop=pbp[pbp.play_type=='no_play']
    wiped=nop[nop.desc.str.contains('pass',case=False,na=False)&(nop.penalty_team==nop.posteam)]
    denom=pbp[pbp.pass_attempt==1].groupby('posteam').size().rename('pass_plays')
    num=wiped.groupby('posteam').size().rename('wiped_pass_plays')
    df=pd.concat([denom,num],axis=1).fillna(0).reset_index().rename(columns={'posteam':'team_abbr'})
    df['nullify_pct']=(df.wiped_pass_plays/df.pass_plays).round(4)
    top=wiped.groupby(['posteam','penalty_type']).size().reset_index(name='n')
    top=top.sort_values('n',ascending=False).groupby('posteam').head(1).set_index('posteam')['penalty_type']
    df['top_penalty']=df.team_abbr.map(top)
    df['season']=season
    return df[df.team_abbr.notna()]

def upsert(df,table):
    url=os.environ['SUPABASE_URL'].rstrip('/')+f'/rest/v1/{table}'
    key=os.environ['SUPABASE_SERVICE_KEY']
    h={'apikey':key,'Authorization':f'Bearer {key}','Content-Type':'application/json',
       'Prefer':'resolution=merge-duplicates,return=minimal'}
    rows=df.where(pd.notna(df),None).to_dict('records')
    r=requests.post(url+'?on_conflict=team_abbr,season',headers=h,json=rows,timeout=60)
    print(f"  {table}: {r.status_code} ({len(rows)} rows)")

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--seasons',nargs='+',type=int,required=True)
    ap.add_argument('--dry-run',action='store_true'); a=ap.parse_args()
    for s in a.seasons:
        print(f"\n=== penalty drag {s} ===")
        df=build(s)
        if a.dry_run:
            print(df.sort_values('nullify_pct',ascending=False).head(8).to_string(index=False)); continue
        upsert(df,'nfl_team_penalty_drag')

# SCHEMA ADDITION:
# create table if not exists nfl_team_penalty_drag (
#   id bigint generated always as identity primary key,
#   team_abbr text references nfl_teams(team_abbr), season int not null,
#   pass_plays int, wiped_pass_plays int, nullify_pct numeric, top_penalty text,
#   updated_at timestamptz default now(), unique (team_abbr, season)
# );
