#!/usr/bin/env python3
"""
Lyrid NFL — DEFENSE VS ROLE-RANK (the WR1-vs-room fix + blowup-inflation kill).

The trap this fixes (found by hand, now automated): room-level "yards allowed to WRs" is a bad proxy
for a WR1 prop. Dallas and Indy leak lots of WR yards — but to WR2/WR3/slot, not the WR1. A WR1 over
vs them is a mirage. And most "soft" averages are ONE blowup game (Adams 195 vs NYG) — the mean lies.

This computes, per defense, yards allowed to the OPPOSING team's WR1 / WR2 / TE1 / RB1 specifically
(by target-leader rank, not just position), over the current season, WITH a consistency count: in how
many of those games did the role clear a "soft" threshold. A defense soft in ALL games is a real
target; one inflated by a single blowup is flagged, not featured.

  role_rank: WR1 (target leader), WR2 (2nd), TE1, RB1 — the roles props are actually on
  avg_yds / games : the mean and sample
  soft_games      : how many games the role cleared the soft threshold (consistency, not average)
  consistency     : soft_games / games  (1.0 = soft every game = REAL; low = blowup-inflated = TRAP)
  top_games       : the actual per-game values (so the UI can show "[44, 195]")

Current-season only when it has >=2 games (no stale-2025 backfill). Output: nfl_defense_vs_role.
Run weekly (season job):  python3 data/nfl/build_defense_vs_role.py
"""
import os, sys, json, argparse
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

# soft threshold per role (yds allowed that counts as "gave up a real game" to that role)
SOFT = {'WR1': 70, 'WR2': 45, 'TE1': 45, 'RB1': 65}

def current_nfl_season():
    import datetime
    d = datetime.date.today()
    return d.year if d.month >= 3 else d.year - 1

def load(seasons):
    frames = []
    for s in seasons:
        try: frames.append(pd.read_parquet(f"{NFLVERSE}/stats_player/stats_player_week_{s}.parquet"))
        except Exception: continue
    if not frames: return pd.DataFrame()
    df = pd.concat(frames, ignore_index=True)
    return df[(df.get('season_type', 'REG') == 'REG') & df['opponent_team'].notna()].copy()

def role_map(df, season):
    """Per (team, season): WR1/WR2 by target rank among WRs, TE1 among TEs, RB1 by rush+rec among RBs."""
    out = {}
    d = df[df['season'] == season].copy()
    for col in ['targets', 'receiving_yards', 'rushing_yards']:
        d[col] = pd.to_numeric(d.get(col), errors='coerce').fillna(0)
    # WR ranks by targets
    wr = d[d['position'] == 'WR'].groupby(['team', 'player_display_name'])['targets'].sum().reset_index()
    wr['rk'] = wr.groupby('team')['targets'].rank(ascending=False, method='first')
    for _, r in wr.iterrows():
        if r['rk'] <= 2: out[(r['team'], r['player_display_name'])] = f"WR{int(r['rk'])}"
    # TE1 by targets
    te = d[d['position'] == 'TE'].groupby(['team', 'player_display_name'])['targets'].sum().reset_index()
    te['rk'] = te.groupby('team')['targets'].rank(ascending=False, method='first')
    for _, r in te.iterrows():
        if r['rk'] == 1: out[(r['team'], r['player_display_name'])] = 'TE1'
    # RB1 by rush+rec yards
    rb = d[d['position'] == 'RB'].copy(); rb['tot'] = rb['rushing_yards'] + rb['receiving_yards']
    rbg = rb.groupby(['team', 'player_display_name'])['tot'].sum().reset_index()
    rbg['rk'] = rbg.groupby('team')['tot'].rank(ascending=False, method='first')
    for _, r in rbg.iterrows():
        if r['rk'] == 1: out[(r['team'], r['player_display_name'])] = 'RB1'
    return out

def build():
    cur = current_nfl_season()
    df = load([cur, cur - 1])
    if not len(df): print("no data"); return pd.DataFrame()
    # role map from the CURRENT season (who is each team's WR1 now)
    roles = role_map(df, cur)
    d = df[df['season'] == cur].copy()
    if d['week'].nunique() < 2:      # very early — fall back to include prior season for a base
        d = df.copy()
    for col in ['receiving_yards', 'rushing_yards']:
        d[col] = pd.to_numeric(d.get(col), errors='coerce').fillna(0)
    d['role'] = d.apply(lambda r: roles.get((r['team'], r['player_display_name'])), axis=1)
    d['yds'] = np.where(d['position'] == 'RB', d['rushing_yards'] + d['receiving_yards'], d['receiving_yards'])
    d = d[d['role'].notna()]
    rows = []
    for (opp, role), g in d.groupby(['opponent_team', 'role']):
        per = g.groupby(['season', 'week'])['yds'].sum()
        vals = [int(round(v)) for v in per.values]
        thr = SOFT.get(role, 60)
        soft = int((per >= thr).sum())
        rows.append({
            'team_abbr': opp, 'role_rank': role,
            'avg_yds': round(float(per.mean()), 1), 'games': int(len(per)),
            'soft_games': soft, 'consistency': round(soft / len(per), 2) if len(per) else 0,
            'top_games': json.dumps(vals[-4:]),   # most recent up to 4
        })
    return pd.DataFrame(rows)

def upsert(df):
    df['updated_at'] = pd.Timestamp.now(tz='UTC').isoformat()
    rows = df.where(pd.notna(df), None).to_dict('records')
    for i in range(0, len(rows), 500):
        r = requests.post(f"{SB}/rest/v1/nfl_defense_vs_role?on_conflict=team_abbr,role_rank",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=json.dumps(rows[i:i+500], allow_nan=False), timeout=60)
        print(f"  nfl_defense_vs_role: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    df = build()
    if not len(df): sys.exit(1)
    if a.dry_run:
        wr1 = df[df['role_rank'] == 'WR1'].sort_values('avg_yds', ascending=False)
        print("=== softest vs WR1 — AVG can lie, CONSISTENCY is the truth ===")
        for _, r in wr1.head(10).iterrows():
            tag = 'REAL (soft every game)' if r['consistency'] == 1.0 else ('BLOWUP-INFLATED (fade)' if r['soft_games'] <= 1 else 'mixed')
            print(f"  {r['team_abbr']:4} {r['avg_yds']:6}/g  soft {r['soft_games']}/{r['games']}  {r['top_games']:16} -> {tag}")
        sys.exit()
    upsert(df)

# SCHEMA:
# create table if not exists nfl_defense_vs_role (
#   id bigint generated always as identity primary key,
#   team_abbr text not null, role_rank text not null,
#   avg_yds numeric, games int, soft_games int, consistency numeric, top_games jsonb,
#   updated_at timestamptz default now(), unique (team_abbr, role_rank)
# );
