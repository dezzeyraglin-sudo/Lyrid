#!/usr/bin/env python3
"""
Lyrid NFL engine — nflverse ingest (Layer 4).
Pulls FREE nflverse data (player weekly stats, NGS, snaps) and upserts into Supabase.

RUN LOCALLY (not in Vercel/sandbox): needs your Supabase service key.
  export SUPABASE_URL=https://xtldczxlibdkwqvgmnob.supabase.co
  export SUPABASE_SERVICE_KEY=...        # service_role key, rotate after backfill
  python3 ingest_nflverse.py --seasons 2022 2023 2024 2025

Data source: nflverse-data GitHub release parquet (same data nfl_data_py wraps,
but pulled directly so it works without the nfl_data_py build toolchain).
Column mapping validated against real 2024 data (5,597 player-weeks).
"""
import argparse, os, sys, time
import pandas as pd
import requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"

def load_player_stats(season):
    url = f"{NFLVERSE}/player_stats/player_stats_{season}.parquet"
    return pd.read_parquet(url)

def load_snap_counts(season):
    try:
        url = f"{NFLVERSE}/snap_counts/snap_counts_{season}.parquet"
        return pd.read_parquet(url)
    except Exception as e:
        print(f"  [warn] snap counts {season}: {e}")
        return None

def load_ngs(season, stat_type):
    # stat_type in {passing, receiving, rushing}
    try:
        url = f"{NFLVERSE}/nextgen_stats/ngs_{season}_{stat_type}.parquet"
        return pd.read_parquet(url)
    except Exception:
        # fallback to combined file layout
        try:
            url = f"{NFLVERSE}/nextgen_stats/ngs_{stat_type}.parquet"
            df = pd.read_parquet(url)
            return df[df['season'] == season]
        except Exception as e:
            print(f"  [warn] NGS {stat_type} {season}: {e}")
            return None

# Map nflverse row -> nfl_player_games schema row
def build_rows(stats, snaps, ngs_rec, ngs_pass, ngs_rush, season):
    # index NGS + snaps for quick weekly lookup
    def idx(df, keycols):
        if df is None: return {}
        d = {}
        for _, r in df.iterrows():
            d[tuple(r[c] for c in keycols)] = r
        return d

    snap_idx = idx(snaps, ['pfr_player_id','week']) if snaps is not None else {}
    rec_idx  = idx(ngs_rec, ['player_gsis_id','week']) if ngs_rec is not None else {}
    pass_idx = idx(ngs_pass,['player_gsis_id','week']) if ngs_pass is not None else {}
    rush_idx = idx(ngs_rush,['player_gsis_id','week']) if ngs_rush is not None else {}

    rows = []
    for _, r in stats.iterrows():
        gsis = r.get('player_id')
        wk = r.get('week')
        rec = rec_idx.get((gsis, wk))
        pas = pass_idx.get((gsis, wk))
        rus = rush_idx.get((gsis, wk))
        rows.append({
            'player_key': gsis,
            'player_name': r.get('player_display_name'),
            'position': r.get('position'),
            'team_abbr': r.get('recent_team'),
            'opponent_abbr': r.get('opponent_team'),
            'season': int(season),
            'week': int(wk) if pd.notna(wk) else None,
            'passing_yards': _num(r.get('passing_yards')),
            'rushing_yards': _num(r.get('rushing_yards')),
            'receiving_yards': _num(r.get('receiving_yards')),
            'pass_attempts': _int(r.get('attempts')),
            'rush_attempts': _int(r.get('carries')),
            'targets': _int(r.get('targets')),
            'receptions': _int(r.get('receptions')),
            'target_share': _num(r.get('target_share')),
            'air_yards_share': _num(r.get('air_yards_share')),
            'cpoe': _num(pas.get('completion_percentage_above_expectation')) if pas is not None else None,
            'ryoe_per_att': _num(rus.get('rush_yards_over_expected_per_att')) if rus is not None else None,
            'avg_separation': _num(rec.get('avg_separation')) if rec is not None else None,
            'snaps': _int(snap_idx.get((r.get('pfr_id'), wk), {}).get('offense_snaps')) if snap_idx else None,
        })
    return rows

def _num(v):
    try:
        return float(v) if pd.notna(v) else None
    except Exception:
        return None

def _int(v):
    try:
        return int(v) if pd.notna(v) else None
    except Exception:
        return None

def upsert(rows, batch=500):
    url = os.environ['SUPABASE_URL'].rstrip('/') + '/rest/v1/nfl_player_games'
    key = os.environ['SUPABASE_SERVICE_KEY']
    headers = {
        'apikey': key, 'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
    }
    total = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i+batch]
        resp = requests.post(url + '?on_conflict=player_key,season,week',
                             headers=headers, json=chunk, timeout=60)
        if resp.status_code >= 300:
            print(f"  [error] upsert {i}: {resp.status_code} {resp.text[:200]}")
            break
        total += len(chunk)
        print(f"  upserted {total}/{len(rows)}")
        time.sleep(0.2)
    return total

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true', help='build rows, skip Supabase')
    args = ap.parse_args()

    for season in args.seasons:
        print(f"\n=== {season} ===")
        stats = load_player_stats(season)
        print(f"  player-weeks: {len(stats)}")
        snaps = load_snap_counts(season)
        ngs_rec = load_ngs(season, 'receiving')
        ngs_pass = load_ngs(season, 'passing')
        ngs_rush = load_ngs(season, 'rushing')
        rows = build_rows(stats, snaps, ngs_rec, ngs_pass, ngs_rush, season)
        # keep only skill positions with a yardage outcome
        rows = [r for r in rows if r['position'] in ('QB','RB','WR','TE')]
        print(f"  skill-position rows: {len(rows)}")
        if args.dry_run:
            import json
            print("  sample:", json.dumps(rows[0], default=str)[:300])
            continue
        upsert(rows)

if __name__ == '__main__':
    main()
