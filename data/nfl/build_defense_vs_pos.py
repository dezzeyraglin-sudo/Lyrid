#!/usr/bin/env python3
"""
Lyrid NFL — DEFENSE-VS-POSITION trailing report (user-facing evidence panel).

Shows, when a game is analyzed: how many yards the OPPONENT defense has allowed to each position
(WR / TE / RB) over their last 3, 5, and 10 games — averaged — plus the specific opposing players
who did it. "PHI, last 5: 82 yds/g to WRs (allowed 157 to Worthy, 90 to Nacua...)."

IMPORTANT — this is DESCRIPTIVE CONTEXT, not a gate signal. A 3-game window is 3 opponents with
different personnel: great for a user to eyeball, too noisy to drive a projection. The archetype
tables (season-normalized, large-sample) remain the signal; this is the human-readable evidence on
top. Do NOT wire these numbers into computeFeatured.

Method: from weekly player logs, per (defense, position), take their last N games (across the latest
2 seasons, most recent first), average the position's total yards allowed per game, and keep the top
opposing players by yards in the window. Windows: 3, 5, 10.

Output: nfl_defense_vs_pos — one row per (team, position), with w3/w5/w10 averages + top players.
Run game-day (opponent outputs change weekly):
  python3 data/nfl/build_defense_vs_pos.py
"""
import os, sys, json, argparse
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
POS = ['WR', 'TE', 'RB']
WINDOWS = [3, 5, 10]

def build():
    seasons = sorted({pd.Timestamp.now().year, pd.Timestamp.now().year - 1})
    frames = []
    for s in seasons:
        try:
            df = pd.read_parquet(f"{NFLVERSE}/player_stats/player_stats.parquet",
                    columns=['player_display_name', 'position', 'season', 'week', 'opponent_team',
                             'receiving_yards', 'rushing_yards', 'targets', 'carries', 'season_type'])
        except Exception:
            df = pd.read_parquet(f"{NFLVERSE}/player_stats/player_stats.parquet")
        df = df[(df.get('season_type', 'REG') == 'REG') & (df['season'] == s) & df['opponent_team'].notna()]
        frames.append(df)
        break  # the parquet already holds all seasons; one read is enough
    allrows = pd.read_parquet(f"{NFLVERSE}/player_stats/player_stats.parquet")
    allrows = allrows[(allrows.get('season_type', 'REG') == 'REG') & (allrows['season'].isin(seasons)) & allrows['opponent_team'].notna()]

    # the yardage stat that matters per position
    def yds(r):
        return r['rushing_yards'] if r['position'] == 'RB' else r['receiving_yards']

    rows = []
    for (defteam, pos), g in allrows.groupby(['opponent_team', 'position']):
        if pos not in POS:
            continue
        col = 'rushing_yards' if pos == 'RB' else 'receiving_yards'
        g = g[pd.to_numeric(g[col], errors='coerce').notna()].copy()
        g[col] = pd.to_numeric(g[col], errors='coerce')
        # sort most-recent first; a "game" for the defense = one week (sum the position's yards that week)
        perweek = g.groupby(['season', 'week']).agg(
            pos_yds=(col, 'sum')).reset_index().sort_values(['season', 'week'], ascending=False)
        rec = {'team_abbr': defteam, 'position': pos}
        for w in WINDOWS:
            wk = perweek.head(w)
            rec[f'avg_w{w}'] = round(float(wk['pos_yds'].mean()), 1) if len(wk) else None
            rec[f'games_w{w}'] = int(len(wk))
        # top opposing players by yards in the last-5 window (the "who did it" list)
        recent_weeks = set(map(tuple, perweek.head(5)[['season', 'week']].values.tolist()))
        recent = g[g.apply(lambda r: (r['season'], r['week']) in recent_weeks, axis=1)]
        top = (recent.groupby('player_display_name')[col].sum().sort_values(ascending=False).head(4))
        rec['top_players'] = json.dumps([{'name': n, 'yds': int(y)} for n, y in top.items() if y > 0])
        rows.append(rec)
    return pd.DataFrame(rows)

def upsert(df):
    df['updated_at'] = pd.Timestamp.now(tz='UTC').isoformat()
    rows = df.where(pd.notna(df), None).to_dict('records')
    for i in range(0, len(rows), 500):
        r = requests.post(f"{SB}/rest/v1/nfl_defense_vs_pos?on_conflict=team_abbr,position",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=json.dumps(rows[i:i+500], allow_nan=False), timeout=60)
        print(f"  nfl_defense_vs_pos: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    df = build()
    if not len(df): print("no data"); sys.exit(1)
    if a.dry_run:
        print(f"rows: {len(df)} (team x position)\n")
        # show the softest recent pass-defense-vs-WR spots (the eyeball value)
        wr = df[df['position'] == 'WR'].sort_values('avg_w5', ascending=False)
        print("=== softest vs WR, last 5 games (yds/g allowed) ===")
        for _, r in wr.head(6).iterrows():
            tp = json.loads(r['top_players'] or '[]')
            who = ', '.join(f"{t['name']} {t['yds']}" for t in tp[:3])
            print(f"  {r['team_abbr']:4} {r['avg_w5']:5}/g  (w3 {r['avg_w3']}, w10 {r['avg_w10']}) — {who}")
        sys.exit()
    upsert(df)

# SCHEMA:
# create table if not exists nfl_defense_vs_pos (
#   id bigint generated always as identity primary key,
#   team_abbr text not null, position text not null,
#   avg_w3 numeric, games_w3 int, avg_w5 numeric, games_w5 int, avg_w10 numeric, games_w10 int,
#   top_players jsonb, updated_at timestamptz default now(),
#   unique (team_abbr, position)
# );
