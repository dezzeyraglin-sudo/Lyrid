#!/usr/bin/env python3
"""
Lyrid NFL — WEEK-LEVEL environment history (the context-conditioning foundation).

Context conditioning splits every comp-pool player-game into three channels:
  * PLAYER SKILL   — what he controls (target share, YAC, carry share) [player_games]
  * ENVIRONMENT    — what the offense hands him:
        - QB-SPECIFIC  (fast-moving): aDOT, deep-attempt rate, deep completion%, CPOE
        - TEAM-ROLLING (slow-moving): PROE, pace/plays, pass-block (sack) rate
  * MILESTONE      — late-season round-number chase [computed in build_feature_vectors]

This script builds the ENVIRONMENT half at TEAM-WEEK and QB-WEEK granularity so the
feature build can trail it (shift(1)) into a leakage-safe "as-of-kickoff" value.

WHY WEEK-LEVEL, NOT SEASON: tagging a 2025 game with the team's FULL-SEASON 2025 PROE
or a QB's full-season deep-ball leaks the rest of the season into that game — the
backtest looks brilliant and fails live. These are raw weekly facts ONLY; the trailing
window that makes them pre-kickoff is applied downstream, exactly like the existing
player trailing guard. Nothing here is an average over the season.

Reads: nflverse pbp (play-by-play). Writes: nfl_team_week_env, nfl_qb_week_env (DDL footer).
"""
import argparse, os, math, json
import pandas as pd, numpy as np, requests

SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
NV = "https://github.com/nflverse/nflverse-data/releases/download"
DEEP_AIR = 20   # air yards for a "deep" attempt (matches build_explosive_profiles)

def load_pbp(season):
    cols = ['season', 'week', 'posteam', 'play_type', 'pass', 'rush', 'pass_attempt', 'sack',
            'complete_pass', 'air_yards', 'yards_gained', 'pass_oe',
            'passer_player_id', 'passer_player_name', 'cpoe', 'qb_dropback']
    df = pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
                         columns=[c for c in cols if True])
    return df

# ---------------------------------------------------------------------------
# TEAM-WEEK environment (team-rolling channel: PROE, pace, pass-block)
# ---------------------------------------------------------------------------
def team_week(pbp, season):
    d = pbp[pbp.posteam.notna()].copy()
    rows = []
    for (team, wk), g in d.groupby(['posteam', 'week']):
        run_pass = g[g.play_type.isin(['pass', 'run'])]
        plays = len(run_pass)
        if plays < 10:
            continue  # not a real offensive sample (e.g., forfeited/odd week)
        passes = int((run_pass['pass'] == 1).sum())
        proe = g.loc[g.pass_oe.notna(), 'pass_oe'].mean()          # already a % per play
        dropbacks = int(((g.pass_attempt == 1) | (g.sack == 1)).sum())
        sacks = int((g.sack == 1).sum())
        rows.append({
            'team_abbr': team, 'season': int(season), 'week': int(wk),
            'plays': plays,
            'pass_rate': round(passes / plays, 4) if plays else None,
            'proe': round(float(proe), 3) if pd.notna(proe) else None,
            'dropbacks': dropbacks,
            'sack_rate_allowed': round(sacks / dropbacks, 4) if dropbacks else None,
        })
    return pd.DataFrame(rows)

# ---------------------------------------------------------------------------
# QB-WEEK environment (QB-specific channel: aDOT, deep rate, deep comp%, CPOE)
# ---------------------------------------------------------------------------
def qb_week(pbp, season):
    p = pbp[(pbp.pass_attempt == 1) & pbp.passer_player_id.notna()].copy()
    p['is_deep'] = (p.air_yards >= DEEP_AIR).astype(float)
    rows = []
    for (pid, wk), g in p.groupby(['passer_player_id', 'week']):
        att = len(g)
        if att < 5:
            continue  # not a meaningful passing sample that week
        deep = g[g.is_deep == 1]
        deep_att = len(deep)
        name = g['passer_player_name'].dropna().iloc[0] if g['passer_player_name'].notna().any() else None
        team = g['posteam'].dropna().iloc[0] if 'posteam' in g and g['posteam'].notna().any() else None
        rows.append({
            'player_key': pid, 'player_name': name, 'team_abbr': team,
            'season': int(season), 'week': int(wk),
            'attempts': int(att),
            'adot': round(float(g.air_yards.mean()), 2) if g.air_yards.notna().any() else None,
            'deep_att_rate': round(deep_att / att, 4) if att else None,
            'deep_comp_pct': round(float((deep.complete_pass == 1).mean()), 4) if deep_att else None,
            'deep_ypa': round(float(deep.yards_gained.sum() / deep_att), 2) if deep_att else None,
            'cpoe': round(float(g.cpoe.mean()), 3) if g.cpoe.notna().any() else None,
        })
    return pd.DataFrame(rows)

def upsert(df, table, conflict):
    if df is None or df.empty:
        print(f"  {table}: 0 rows"); return
    url = SB + f'/rest/v1/{table}'
    def clean(v):
        if v is None: return None
        if isinstance(v, (np.floating, float)):
            f = float(v); return None if not math.isfinite(f) else f
        if isinstance(v, (np.integer,)): return int(v)
        if isinstance(v, (np.bool_,)): return bool(v)
        return v
    rows = [{k: clean(v) for k, v in r.items()} for r in df.where(pd.notna(df), None).to_dict('records')]
    for i in range(0, len(rows), 500):
        body = json.dumps(rows[i:i + 500], allow_nan=False)
        r = requests.post(url + f'?on_conflict={conflict}',
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=body, timeout=60)
        print(f"  {table}: {r.status_code} ({min(i + 500, len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    for s in a.seasons:
        print(f"\n=== env history {s} ===")
        pbp = load_pbp(s)
        tw = team_week(pbp, s); qw = qb_week(pbp, s)
        print(f"  team-weeks: {len(tw)}   qb-weeks: {len(qw)}")
        if a.dry_run:
            print("-- team-week (top PROE) --")
            print(tw.sort_values('proe', ascending=False).head(6).to_string(index=False))
            print("-- qb-week (top deep-att rate) --")
            print(qw.sort_values('deep_att_rate', ascending=False).head(6)[['player_name', 'week', 'attempts', 'adot', 'deep_att_rate', 'deep_comp_pct', 'cpoe']].to_string(index=False))
            continue
        upsert(tw, 'nfl_team_week_env', 'team_abbr,season,week')
        upsert(qw, 'nfl_qb_week_env', 'player_key,season,week')

# SCHEMA ADDITIONS:
# create table if not exists nfl_team_week_env (
#   id bigint generated always as identity primary key,
#   team_abbr text not null, season int not null, week int not null,
#   plays int, pass_rate numeric, proe numeric, dropbacks int, sack_rate_allowed numeric,
#   updated_at timestamptz default now(), unique (team_abbr, season, week)
# );
# create table if not exists nfl_qb_week_env (
#   id bigint generated always as identity primary key,
#   player_key text not null, player_name text, team_abbr text, season int not null, week int not null,
#   attempts int, adot numeric, deep_att_rate numeric, deep_comp_pct numeric, deep_ypa numeric, cpoe numeric,
#   updated_at timestamptz default now(), unique (player_key, season, week)
# );
