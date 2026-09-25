#!/usr/bin/env python3
"""
Lyrid NFL — RECENT-FORM DEFENSE (rolling last-N games).

Why: the defense-tier gate (which now carries the pass-game reads) is built on SEASON-LONG
averages. But a defense that lost its best corner three weeks ago, or has been gashed the last two
games, is a different unit than its season line — the same recency lesson that fixed the QB reads
(qb_form). This computes each defense's rolling last-N-game pass/rush EPA allowed, recency-weighted,
so the gate can blend 'what this D has been lately' with 'what it is on the season'.

Method (mirrors build_qb_form):
  1. From pbp, defensive pass/rush EPA allowed per team per week.
  2. Roll the last N games (default 4), recency-weighted (recent games count more).
  3. Tier each team's RECENT form vs the league (percentile) into elite / avg / soft, per phase.
Output: nfl_defense_form — team, recent pass/rush EPA allowed, tiers, games, last week.

Reads nflverse pbp (latest 2 seasons). Writes nfl_defense_form. Run game-day so it stays current:
  python3 data/nfl/build_defense_form.py --window 4
"""
import os, sys, json, argparse
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

def weekly_def_epa(seasons):
    frames = []
    for s in seasons:
        try:
            pbp = pd.read_parquet(f"{NFLVERSE}/pbp/play_by_play_{s}.parquet",
                    columns=['season', 'week', 'defteam', 'pass', 'rush', 'epa', 'season_type'])
        except Exception as e:
            print(f"  (skip {s}: {e})"); continue
        pbp = pbp[(pbp['season_type'] == 'REG') & pbp['epa'].notna() & pbp['defteam'].notna()]
        g = pbp.groupby(['defteam', 'season', 'week']).apply(lambda x: pd.Series({
            'pass_epa_allowed': x.loc[x['pass'] == 1, 'epa'].mean(),
            'rush_epa_allowed': x.loc[x['rush'] == 1, 'epa'].mean(),
            'plays': len(x)})).reset_index()
        frames.append(g)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

def build(window):
    seasons = sorted({pd.Timestamp.now().year, pd.Timestamp.now().year - 1})
    wk = weekly_def_epa(seasons)
    if not len(wk):
        print("no pbp data"); return pd.DataFrame()
    wk = wk.sort_values(['defteam', 'season', 'week'])
    rows = []
    for team, g in wk.groupby('defteam'):
        g = g.tail(window)                                   # last N games, latest seasons
        if len(g) < 2:
            continue
        w = np.linspace(0.6, 1.0, len(g))                    # recency weight: recent games count more
        def wmean(col):
            v = g[col].values; m = np.isfinite(v)
            return float(np.average(v[m], weights=w[m])) if m.any() else None
        rows.append({
            'team_abbr': team,
            'form_pass_epa_allowed': round(wmean('pass_epa_allowed'), 4) if wmean('pass_epa_allowed') is not None else None,
            'form_rush_epa_allowed': round(wmean('rush_epa_allowed'), 4) if wmean('rush_epa_allowed') is not None else None,
            'games': int(len(g)), 'last_season': int(g['season'].iloc[-1]), 'last_week': int(g['week'].iloc[-1]),
        })
    df = pd.DataFrame(rows)
    if not len(df):
        return df
    # tier RECENT form vs the league (low EPA allowed = strong defense right now)
    def tier(col, newcol):
        v = df[col]; q1, q2 = v.quantile(0.33), v.quantile(0.67)
        df[newcol] = np.where(v <= q1, 'elite', np.where(v >= q2, 'soft', 'avg'))
    tier('form_pass_epa_allowed', 'pass_form_tier')
    tier('form_rush_epa_allowed', 'rush_form_tier')
    return df

def upsert(df):
    df['updated_at'] = pd.Timestamp.now(tz='UTC').isoformat()   # explicit — upsert UPDATE won't fire the column default
    rows = df.where(pd.notna(df), None).to_dict('records')
    r = requests.post(f"{SB}/rest/v1/nfl_defense_form?on_conflict=team_abbr",
                      headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                      data=json.dumps(rows, allow_nan=False), timeout=60)
    print(f"  nfl_defense_form: {r.status_code} ({len(rows)} teams)")
    if r.status_code >= 300: print("   ", r.text[:200])

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--window', type=int, default=4)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    df = build(a.window)
    if not len(df): sys.exit(1)
    if a.dry_run:
        print(f"teams: {len(df)}  (rolling last-{a.window}-game defensive form)\n")
        show = df.sort_values('form_pass_epa_allowed')[['team_abbr', 'form_pass_epa_allowed', 'pass_form_tier', 'form_rush_epa_allowed', 'rush_form_tier', 'games', 'last_week']]
        print("=== best pass defenses RIGHT NOW (lowest recent pass EPA allowed) ===")
        print(show.head(6).to_string(index=False))
        print("\n=== worst pass defenses RIGHT NOW (soft — the receiving-over targets) ===")
        print(show.tail(6).to_string(index=False))
        sys.exit()
    upsert(df)

# SCHEMA:
# create table if not exists nfl_defense_form (
#   id bigint generated always as identity primary key,
#   team_abbr text not null unique,
#   form_pass_epa_allowed numeric, pass_form_tier text,
#   form_rush_epa_allowed numeric, rush_form_tier text,
#   games int, last_season int, last_week int,
#   updated_at timestamptz default now()
# );
