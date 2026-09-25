#!/usr/bin/env python3
"""
Lyrid NFL — QB RECENT-FORM skill score (the "is he playing well NOW" number).

The QB-competency gate used to pass any QB with a passing baseline + volume — which let
career-backup-quality (Brissett) and past-their-peak (late Rodgers) starters feature their whole
receiving corps. Tenure and attempt volume are not skill. This builds a RECENCY-WINDOWED skill
score so the gate keys on current play, not reputation.

Source (free): nflverse weekly player_stats — per-game `dakota` (EPA+CPOE composite) and
passing_epa. We take each QB's last N REG games (default 8), require a minimum start sample,
average dakota (recency-weighted), and z-score within the window's QB population -> qb_form 0..1.

  qb_form ~ 0.5  = league-average starter
  qb_form >= ~0.55 = competent-or-better (features)
  qb_form <  ~0.40 = playing poorly / backup-quality (gate the corps)

Output: nfl_qb_form (one row per QB, current). The gate reads qb_form instead of "has a baseline".

Reads: nflverse player_stats (weekly). Writes: nfl_qb_form (DDL footer).
"""
import os, sys, json, argparse
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

def norm(s):
    import re
    s = str(s or '').lower()
    s = re.sub(r"[.'`]", '', s); s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    s = re.sub(r'[^a-z ]', '', s); return re.sub(r'\s+', ' ', s).strip()

def build(window, min_games):
    df = pd.read_parquet(f"{NFLVERSE}/player_stats/player_stats.parquet")
    df = df[(df.get('season_type', 'REG') == 'REG')]
    # restrict to the latest 2 seasons so 'recent form' means CURRENT QBs and CURRENT play —
    # otherwise a retired QB's last-8 (from years ago) pollutes the population + z-score.
    maxS = int(df['season'].max()); df = df[df['season'] >= maxS - 1]
    # QB games = real starts (>=15 attempts) so we grade starters, not mop-up
    qb = df[df['attempts'].fillna(0) >= 15].copy()
    qb['dakota'] = pd.to_numeric(qb['dakota'], errors='coerce')
    qb = qb.dropna(subset=['dakota'])
    qb = qb.sort_values(['player_id', 'season', 'week'])
    rows = []
    for pid, g in qb.groupby('player_id'):
        last = g.tail(window)
        if len(last) < min_games:
            continue
        # recency weight: most recent game weighted highest (linear ramp)
        w = np.arange(1, len(last) + 1, dtype=float)
        form_dakota = float(np.average(last['dakota'].values, weights=w))
        form_epa = float(np.average(pd.to_numeric(last['passing_epa'], errors='coerce').fillna(0).values, weights=w))
        rows.append({
            'player_id': pid,
            'player_name': last['player_display_name'].iloc[-1],
            'games': int(len(last)),
            'form_dakota': form_dakota,
            'form_epa_per_game': round(form_epa, 2),
            'last_season': int(last['season'].iloc[-1]),
            'last_week': int(last['week'].iloc[-1]),
        })
    r = pd.DataFrame(rows)
    if not len(r):
        return r
    # z-score dakota across the current QB population -> 0..1 via logistic
    z = (r['form_dakota'] - r['form_dakota'].mean()) / (r['form_dakota'].std() or 1)
    r['qb_form'] = (1 / (1 + np.exp(-z))).round(4)
    r['tier'] = np.where(r['qb_form'] >= 0.62, 'good',
                np.where(r['qb_form'] >= 0.45, 'average',
                np.where(r['qb_form'] >= 0.32, 'below_avg', 'poor')))
    r['player_key'] = r['player_name'].map(norm)
    return r.sort_values('qb_form', ascending=False)

def upsert(r):
    cols = ['player_key', 'player_name', 'games', 'form_dakota', 'form_epa_per_game', 'qb_form', 'tier', 'last_season', 'last_week']
    r2 = r[cols].copy()
    r2['form_dakota'] = r2['form_dakota'].round(4)
    r2 = r2.sort_values('games', ascending=False).drop_duplicates(subset=['player_key'], keep='first')
    r2['updated_at'] = pd.Timestamp.now(tz='UTC').isoformat()   # explicit — upsert UPDATE won't fire the column default
    rows = r2.where(pd.notna(r2), None).to_dict('records')
    for i in range(0, len(rows), 500):
        rr = requests.post(f"{SB}/rest/v1/nfl_qb_form?on_conflict=player_key",
                           headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                           data=json.dumps(rows[i:i+500], allow_nan=False), timeout=60)
        print(f"  nfl_qb_form: {rr.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if rr.status_code >= 300: print("   ", rr.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--window', type=int, default=8, help='rolling games to grade (last N)')
    ap.add_argument('--min-games', type=int, default=4)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    r = build(a.window, a.min_games)
    if not len(r): print("no rows"); sys.exit(1)
    if a.dry_run:
        print(f"=== BEST recent-form QBs (last {a.window} starts) ===")
        print(r.head(12)[['player_name', 'games', 'form_dakota', 'form_epa_per_game', 'qb_form', 'tier']].to_string(index=False))
        print("\n=== WORST recent-form (these + their WRs should NOT feature) ===")
        print(r.tail(10)[['player_name', 'games', 'form_dakota', 'qb_form', 'tier']].to_string(index=False))
        # spotlight the ones that motivated this
        for nm in ['Jacoby Brissett', 'Aaron Rodgers', 'Patrick Mahomes', 'Jalen Hurts', 'Bo Nix']:
            row = r[r['player_name'] == nm]
            if len(row): print(f"  spotlight {nm:20} qb_form {row['qb_form'].iloc[0]}  tier {row['tier'].iloc[0]}")
        sys.exit()
    upsert(r)

# SCHEMA:
# create table if not exists nfl_qb_form (
#   id bigint generated always as identity primary key,
#   player_key text not null unique, player_name text, games int,
#   form_dakota numeric, form_epa_per_game numeric, qb_form numeric, tier text,
#   last_season int, last_week int, updated_at timestamptz default now()
# );
