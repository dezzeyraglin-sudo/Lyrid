#!/usr/bin/env python3
"""
Lyrid NFL engine — defense scheme aggregator (Layer 5c-i).
Aggregates each defense's scheme TENDENCIES per season from nflverse participation:
  - man_rate / zone_rate (of charted coverage plays)
  - blitz_rate (5+ pass rushers)
  - heavy_box_rate (8+ defenders in box) -> rushing suppression signal
  - pressure_rate
  - coverage shell distribution (cover1/2/3/4 share)

IMPORTANT CAVEAT (baked into usage, not just docs):
  Participation/coverage data is delivered AFTER the season and currently ends at
  2024. So this is a PRIOR-SEASON tendency feature, never a live in-week feed.
  The engine uses opponent scheme tendency as a stable prior; it does not claim
  current-week coverage knowledge.

Writes nfl_defense_scheme (DDL in footer).
"""
import argparse, os
import pandas as pd
import requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"

def load_part(season):
    url = f"{NFLVERSE}/pbp_participation/pbp_participation_{season}.parquet"
    part = pd.read_parquet(url)
    # participation has no defense team column — join to pbp to get defteam.
    pbp = pd.read_parquet(
        f"{NFLVERSE}/pbp/play_by_play_{season}.parquet",
        columns=['game_id','play_id','defteam']
    )
    merged = part.merge(
        pbp, left_on=['nflverse_game_id','play_id'], right_on=['game_id','play_id'], how='left'
    )
    return merged

def scheme_by_defense(part, season):
    p = part.copy()
    # defense team column is 'defteam' in participation-merged; fall back if named differently
    defcol = 'defteam' if 'defteam' in p.columns else ('defense_team' if 'defense_team' in p.columns else None)
    if defcol is None:
        # participation file may need join to pbp for defteam; try 'defense'
        raise SystemExit("no defense team column in participation file — join to pbp on play_id/game_id needed")

    rows = []
    for team, g in p.groupby(defcol):
        cov = g[g['defense_man_zone_type'].isin(['MAN_COVERAGE','ZONE_COVERAGE'])]
        man = (cov['defense_man_zone_type'] == 'MAN_COVERAGE').mean() if len(cov) else None
        rushers = g['number_of_pass_rushers'].dropna()
        blitz = (rushers >= 5).mean() if len(rushers) else None
        box = g['defenders_in_box'].dropna()
        heavy_box = (box >= 8).mean() if len(box) else None
        press = g['was_pressure'].dropna()
        pressure = press.mean() if len(press) else None
        shells = g['defense_coverage_type'].value_counts(normalize=True)
        rows.append({
            'team_abbr': team, 'season': season,
            'man_rate': _r(man), 'zone_rate': _r(1-man if man is not None else None),
            'blitz_rate': _r(blitz), 'heavy_box_rate': _r(heavy_box),
            'pressure_rate': _r(pressure),
            'cover1_share': _r(shells.get('COVER_1')), 'cover2_share': _r(shells.get('COVER_2')),
            'cover3_share': _r(shells.get('COVER_3')), 'cover4_share': _r(shells.get('COVER_4')),
        })
    return pd.DataFrame(rows)

def _r(v):
    return None if v is None or pd.isna(v) else round(float(v), 4)

def upsert(df, table):
    url = os.environ['SUPABASE_URL'].rstrip('/') + f'/rest/v1/{table}'
    key = os.environ['SUPABASE_SERVICE_KEY']
    headers = {'apikey': key, 'Authorization': f'Bearer {key}',
               'Content-Type': 'application/json',
               'Prefer': 'resolution=merge-duplicates,return=minimal'}
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
    resp = requests.post(url + '?on_conflict=team_abbr,season', headers=headers, data=_json.dumps(rows, allow_nan=False), timeout=60)
    print(f"  {table}: {resp.status_code} ({len(rows)} rows)")
    if resp.status_code >= 300: print("   ", resp.text[:200])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    for s in args.seasons:
        print(f"\n=== defense scheme {s} ===")
        part = load_part(s)
        df = scheme_by_defense(part, s)
        if args.dry_run:
            print(df.sort_values('man_rate', ascending=False).to_string(index=False))
            continue
        upsert(df, 'nfl_defense_scheme')

if __name__ == '__main__':
    main()

# SCHEMA ADDITION:
# create table if not exists nfl_defense_scheme (
#   id bigint generated always as identity primary key,
#   team_abbr text references nfl_teams(team_abbr),
#   season int not null,
#   man_rate numeric, zone_rate numeric, blitz_rate numeric,
#   heavy_box_rate numeric, pressure_rate numeric,
#   cover1_share numeric, cover2_share numeric, cover3_share numeric, cover4_share numeric,
#   updated_at timestamptz default now(),
#   unique (team_abbr, season)
# );
