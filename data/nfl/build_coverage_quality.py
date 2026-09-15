#!/usr/bin/env python3
"""
Lyrid NFL — per-defender COVERAGE QUALITY (the real shutdown metric).

The old defender-impact 'coverage' score was built from passes-defensed + INTs — ball-PRODUCTION
events. That's inverted for good corners: a shutdown corner is AVOIDED, so he records few PDs/INTs
and scored near zero (Diggs came out DEAD LAST on Dallas; Surtain looked average). Betting the
shadow gate on it would have steered you TOWARD elite corners instead of away.

This builds the correct signal from nflverse's PFR Advanced Defense mirror (free): per defender,
WHEN TARGETED — targets, completions, yards, yards/target, and passer-rating-allowed. Low rating
allowed = true shutdown. Surtain/Stingley/Humphrey rate elite here, as they should.

Output: nfl_coverage_quality (per player/season) with a 0..1 `shadow_score` where 1 = elite
lockdown. The shadow gate keys on this instead of the broken event score.

Reads: nflverse pfr_advstats/advstats_season_def. Writes: nfl_coverage_quality (DDL footer).
"""
import os, sys, json, argparse
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
COVER_POS = {'CB', 'DB', 'S', 'FS', 'SS', 'SAF'}   # coverage defenders only
MIN_TGT = 25   # need a real sample of targets to grade a defender's coverage

def load():
    return pd.read_parquet(f"{NFLVERSE}/pfr_advstats/advstats_season_def.parquet")

def build(seasons):
    df = load()
    df = df[df['season'].isin(seasons)].copy()
    # coverage defenders with a real target sample
    covset = {'CB','DB','S','FS','SS','SAF','RCB','LCB','NB','NCB'}
    df = df[df['pos'].astype(str).str.upper().str.split(r'[-/]').apply(lambda ps: any(p in covset for p in ps))]
    df = df[df['tgt'].fillna(0) >= MIN_TGT].copy()
    if not len(df):
        print("no rows after filters"); return df
    # shadow_score: primarily passer-rating-allowed (lower = better), blended with yards/target.
    # Rating scale ~ 39..120+; invert + z-score within season so 'elite' is comparable year to year.
    out = []
    for season, g in df.groupby('season'):
        rat = g['rat'].astype(float)
        ypt = g['yds_tgt'].astype(float)
        # z-scores (lower rating/ypt = better coverage -> higher score, so negate)
        rz = -(rat - rat.mean()) / (rat.std() or 1)
        yz = -(ypt - ypt.mean()) / (ypt.std() or 1)
        blend = 0.7 * rz + 0.3 * yz
        # map to 0..1 via logistic so 'elite' (blend >> 0) approaches 1
        score = 1 / (1 + np.exp(-blend))
        gg = g.copy()
        gg['shadow_score'] = score.round(4).values
        gg['rating_allowed'] = rat.round(1).values
        gg['yards_per_target'] = ypt.round(2).values
        out.append(gg)
    res = pd.concat(out)
    # tier label for readability
    res['shadow_tier'] = np.where(res['shadow_score'] >= 0.80, 'lockdown',
                          np.where(res['shadow_score'] >= 0.62, 'above_avg',
                          np.where(res['shadow_score'] >= 0.40, 'average', 'exploitable')))
    return res

def upsert(res):
    cols = {'player': 'player_name', 'pos': 'position', 'season': 'season', 'tgt': 'targets',
            'shadow_score': 'shadow_score', 'shadow_tier': 'shadow_tier',
            'rating_allowed': 'rating_allowed', 'yards_per_target': 'yards_per_target'}
    r = res[list(cols)].rename(columns=cols)
    r['player_key'] = r['player_name'].str.lower().str.replace(r"[.'`]", '', regex=True)\
        .str.replace(r'\b(jr|sr|ii|iii|iv|v)\b', '', regex=True).str.replace(r'[^a-z ]', '', regex=True)\
        .str.replace(r'\s+', ' ', regex=True).str.strip()
    r['targets'] = pd.to_numeric(r['targets'], errors='coerce').fillna(0).round().astype(int)
    # one row per (player_key, season) — a mid-season trade lists a player twice in PFR; keep the
    # larger-target sample so ON CONFLICT doesn't hit the same key twice in a batch.
    r = r.sort_values('targets', ascending=False).drop_duplicates(subset=['player_key', 'season'], keep='first')
    rows = r.where(pd.notna(r), None).to_dict('records')
    for i in range(0, len(rows), 500):
        rr = requests.post(f"{SB}/rest/v1/nfl_coverage_quality?on_conflict=player_key,season",
                           headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                           data=json.dumps(rows[i:i+500], allow_nan=False), timeout=60)
        print(f"  nfl_coverage_quality: {rr.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if rr.status_code >= 300: print("   ", rr.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    res = build(a.seasons)
    if not len(res): sys.exit(1)
    if a.dry_run:
        latest = res[res['season'] == max(a.seasons)].sort_values('shadow_score', ascending=False)
        print("\n=== TOP shadow corners (should be the real lockdown names) ===")
        print(latest.head(15)[['player', 'pos', 'tgt', 'rating_allowed', 'yards_per_target', 'shadow_score', 'shadow_tier']].to_string(index=False))
        print("\n=== most EXPLOITABLE (WRs vs these should be tailwinds, not fades) ===")
        print(latest.tail(8)[['player', 'pos', 'rating_allowed', 'shadow_score', 'shadow_tier']].to_string(index=False))
        sys.exit()
    upsert(res)

# SCHEMA:
# create table if not exists nfl_coverage_quality (
#   id bigint generated always as identity primary key,
#   player_key text not null, player_name text, position text, season int not null,
#   targets int, shadow_score numeric, shadow_tier text,
#   rating_allowed numeric, yards_per_target numeric,
#   updated_at timestamptz default now(), unique (player_key, season)
# );
