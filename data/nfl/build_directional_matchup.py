#!/usr/bin/env python3
"""
Lyrid NFL — DIRECTIONAL MATCHUP engine (how the hand-analysis actually found edges).

The real method isn't "soft defense -> bet the over." It's DIRECTIONAL ALIGNMENT:
  * WR:  the receiver's route LOCATION (outside vs slot/inside) vs where the defense bleeds.
         "Adams is 94% outside; LAC allows 168 outside yds/g to WRs" -> edge. A slot WR vs LAC
         is NOT an edge even though LAC is 'soft', because LAC only leaks outside.
  * RB:  the runner's GAP tendency (inside vs outside) vs where the defense leaks.
         "Walker runs inside 77%; Miami allows 5.6 YPC inside vs 3.9 league" -> edge. Miami being
         tough OUTSIDE doesn't matter because Walker doesn't run there.

Room-level and even position-level stats AVERAGE OVER the direction that matters, which is why they
mislead. This splits both the DEFENSE (what it allows by direction) and the PLAYER (his own
direction tendency) so the engine can align them.

Tags (nflverse pbp): pass_location left/right = outside, middle = inside/slot.
                     run_gap guard/tackle = inside, end = outside.

ROLLING: rebuilt weekly (season job). Uses the CURRENT season's last-N games (default 3) so it
tracks the defense/player as they are NOW, and rolls forward automatically as weeks are played.
Season is auto-computed — never needs a hardcoded year.

Writes: nfl_defense_directional (per defense) + nfl_player_direction (per WR/RB).
"""
import os, sys, json, argparse
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

def current_nfl_season():
    import datetime
    d = datetime.date.today()
    return d.year if d.month >= 3 else d.year - 1

def load(seasons):
    frames = []
    for s in seasons:
        try:
            frames.append(pd.read_parquet(f"{NFLVERSE}/pbp/play_by_play_{s}.parquet",
                columns=['season', 'week', 'game_id', 'defteam', 'pass_attempt', 'rush_attempt',
                         'pass_location', 'run_gap', 'receiver_player_id', 'rusher_player_id',
                         'receiving_yards', 'rushing_yards', 'season_type']))
        except Exception:
            continue
    if not frames: return pd.DataFrame()
    df = pd.concat(frames, ignore_index=True)
    return df[df.get('season_type', 'REG') == 'REG'].copy()

def roster_pos(seasons):
    pos = {}
    for s in seasons:
        try:
            r = pd.read_parquet(f"{NFLVERSE}/weekly_rosters/roster_weekly_{s}.parquet", columns=['gsis_id', 'position'])
            pos.update(r.drop_duplicates('gsis_id').set_index('gsis_id')['position'].to_dict())
        except Exception:
            continue
    return pos

def _norm(s):
    import re
    s = str(s or '').lower(); s = re.sub(r"[.'`]", '', s); s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    s = re.sub(r'[^a-z ]', '', s); return re.sub(r'\s+', ' ', s).strip()

def build_defense(df, pos, window):
    """Per defense, last-N games: WR outside/inside yds/g, RB inside/outside YPC, with consistency."""
    cur = df['season'].max()
    d = df[df['season'] == cur]
    if d['week'].nunique() < 2: d = df   # very early fallback
    # WR passing directional
    p = d[(d['pass_attempt'] == 1) & d['pass_location'].notna() & d['receiver_player_id'].notna()].copy()
    p['rpos'] = p['receiver_player_id'].map(pos); p = p[p['rpos'] == 'WR']
    p['dir'] = p['pass_location'].map({'left': 'outside', 'right': 'outside', 'middle': 'inside'})
    # RB rushing directional
    r = d[(d['rush_attempt'] == 1) & d['run_gap'].notna() & d['rusher_player_id'].notna()].copy()
    r['rpos'] = r['rusher_player_id'].map(pos); r = r[r['rpos'] == 'RB']
    r['dir'] = r['run_gap'].map({'guard': 'inside', 'tackle': 'inside', 'end': 'outside'})

    rows = []
    for team in sorted(set(d['defteam'].dropna())):
        rec = {'team_abbr': team}
        # last-N games for this defense
        gp = p[p['defteam'] == team]; gr = r[r['defteam'] == team]
        recent_games = sorted(set(gp['game_id']).union(set(gr['game_id'])))[-window:]
        gp = gp[gp['game_id'].isin(recent_games)]; gr = gr[gr['game_id'].isin(recent_games)]
        ng = len(recent_games)
        rec['games'] = ng
        # WR outside/inside per game + consistency (soft in how many games)
        for dname, sub in [('outside', gp[gp['dir'] == 'outside']), ('inside', gp[gp['dir'] == 'inside'])]:
            per = sub.groupby('game_id')['receiving_yards'].sum()
            rec[f'wr_{dname}_pg'] = round(float(per.sum() / ng), 1) if ng else None
            thr = 110 if dname == 'outside' else 70
            rec[f'wr_{dname}_soft_games'] = int((per >= thr).sum())
        # RB inside/outside YPC allowed
        for dname in ['inside', 'outside']:
            sub = gr[gr['dir'] == dname]
            att = len(sub); yds = sub['rushing_yards'].sum()
            rec[f'rb_{dname}_ypc'] = round(float(yds / att), 2) if att else None
            rec[f'rb_{dname}_att'] = int(att)
        rows.append(rec)
    return pd.DataFrame(rows)

def build_players(df, pos, window):
    """Per WR: outside-target %. Per RB: inside-carry %. (the player's own tendency — the align half)"""
    cur = df['season'].max()
    d = df[df['season'] == cur]
    if d['week'].nunique() < 2: d = df
    rows = []
    # WR route-location tendency
    p = d[(d['pass_attempt'] == 1) & d['pass_location'].notna() & d['receiver_player_id'].notna()].copy()
    p['rpos'] = p['receiver_player_id'].map(pos); p = p[p['rpos'] == 'WR']
    p['out'] = p['pass_location'].isin(['left', 'right']).astype(int)
    wr = p.groupby('receiver_player_id').agg(name=('receiver_player_id', 'size'), out=('out', 'sum'), tot=('pass_attempt', 'sum')).reset_index()
    # need names — pull from a name column if present; else key only
    nm = d.dropna(subset=['receiver_player_id']).groupby('receiver_player_id').size()  # placeholder
    for _, row in wr.iterrows():
        if row['tot'] < 6: continue
        rows.append({'player_id': row['receiver_player_id'], 'position': 'WR',
                     'outside_pct': round(float(row['out'] / row['tot']), 2),
                     'inside_pct': round(float(1 - row['out'] / row['tot']), 2),
                     'sample': int(row['tot'])})
    # RB gap tendency
    r = d[(d['rush_attempt'] == 1) & d['run_gap'].notna() & d['rusher_player_id'].notna()].copy()
    r['rpos'] = r['rusher_player_id'].map(pos); r = r[r['rpos'] == 'RB']
    r['inside'] = r['run_gap'].isin(['guard', 'tackle']).astype(int)
    rb = r.groupby('rusher_player_id').agg(inside=('inside', 'sum'), tot=('rush_attempt', 'sum')).reset_index()
    for _, row in rb.iterrows():
        if row['tot'] < 8: continue
        rows.append({'player_id': row['rusher_player_id'], 'position': 'RB',
                     'inside_pct': round(float(row['inside'] / row['tot']), 2),
                     'outside_pct': round(float(1 - row['inside'] / row['tot']), 2),
                     'sample': int(row['tot'])})
    df2 = pd.DataFrame(rows)
    # attach names + keys from rosters
    return df2

def attach_names(dfp, seasons):
    names = {}
    for s in seasons:
        try:
            r = pd.read_parquet(f"{NFLVERSE}/weekly_rosters/roster_weekly_{s}.parquet",
                                columns=['gsis_id', 'full_name'])
            names.update(r.dropna(subset=['gsis_id']).drop_duplicates('gsis_id').set_index('gsis_id')['full_name'].to_dict())
        except Exception:
            continue
    dfp['player_name'] = dfp['player_id'].map(names)
    dfp['player_key'] = dfp['player_name'].map(_norm)
    return dfp[dfp['player_key'].astype(bool)]

def upsert(df, table, conflict):
    df = df.copy(); df['updated_at'] = pd.Timestamp.now(tz='UTC').isoformat()
    rows = df.where(pd.notna(df), None).to_dict('records')
    for i in range(0, len(rows), 500):
        r = requests.post(f"{SB}/rest/v1/{table}?on_conflict={conflict}",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=json.dumps(rows[i:i+500], allow_nan=False), timeout=60)
        print(f"  {table}: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--window', type=int, default=3, help='rolling games per defense (default last 3)')
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    cur = current_nfl_season(); seasons = [cur, cur - 1]
    df = load(seasons)
    if not len(df): print("no pbp"); sys.exit(1)
    pos = roster_pos(seasons)
    dfn = build_defense(df, pos, a.window)
    plr = attach_names(build_players(df, pos, a.window), seasons)
    if a.dry_run:
        print(f"=== DEF directional (last {a.window}) — softest vs OUTSIDE WR ===")
        d = dfn.sort_values('wr_outside_pg', ascending=False)
        for _, r in d.head(8).iterrows():
            print(f"  {r['team_abbr']:4} WR out {r['wr_outside_pg']}/g (soft {r['wr_outside_soft_games']}/{r['games']}) | in {r['wr_inside_pg']}/g | RB in {r['rb_inside_ypc']} out {r['rb_outside_ypc']} YPC")
        print("\n=== PLAYER tendencies — boundary WRs (align vs soft-outside D) ===")
        w = plr[plr['position'] == 'WR'].sort_values('outside_pct', ascending=False)
        print(w.head(5)[['player_name', 'outside_pct', 'sample']].to_string(index=False))
        print("\n=== inside-heavy RBs (align vs soft-inside D) ===")
        rr = plr[plr['position'] == 'RB'].sort_values('inside_pct', ascending=False)
        print(rr.head(5)[['player_name', 'inside_pct', 'sample']].to_string(index=False))
        sys.exit()
    upsert(dfn, 'nfl_defense_directional', 'team_abbr')
    upsert(plr, 'nfl_player_direction', 'player_key')

# SCHEMA:
# create table if not exists nfl_defense_directional (
#   id bigint generated always as identity primary key, team_abbr text not null unique,
#   games int, wr_outside_pg numeric, wr_outside_soft_games int, wr_inside_pg numeric, wr_inside_soft_games int,
#   rb_inside_ypc numeric, rb_inside_att int, rb_outside_ypc numeric, rb_outside_att int,
#   updated_at timestamptz default now()
# );
# create table if not exists nfl_player_direction (
#   id bigint generated always as identity primary key, player_key text not null unique,
#   player_id text, player_name text, position text,
#   outside_pct numeric, inside_pct numeric, sample int, updated_at timestamptz default now()
# );
