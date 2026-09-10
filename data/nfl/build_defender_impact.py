#!/usr/bin/env python3
"""
Lyrid NFL engine — DEFENDER IMPACT table (the foundation for defensive-injury effects).

The whole problem with "a major defender is out" is distinguishing a DPOY edge rusher from
the fourth corner. That's a per-player MEASUREMENT, not a hardcoded position weight. This
builds it from nflverse pbp (per-defender events) + participation (snaps) + rosters (pos):

  pass_rush_score  — sacks + QB hits + TFLs on pass, per pass snap (z vs position group)
  coverage_score   — passes defensed + interceptions, per snap (z vs position group)
  run_score        — TFLs/stops on run, per run snap (z vs position group)
  impact_score     — overall, snap-weighted
  impact_type      — pass_rush | coverage | run  (the defender's PRIMARY effect)
  snap_share       — starter vs rotational

WHY impact_type MATTERS: it decides which OPPOSING props lift when this defender is out.
  pass_rush out  -> opposing QB/passing/receiving overs get a tailwind (more time to throw)
  coverage out   -> opposing receiving overs lift (a shadow corner gone)
  run out        -> opposing rushing overs lift (a run-stuffer gone)
So the afflicted-props effect is DATA-DRIVEN per defender, not a flat "defender out -> boost".

Leakage note: season-level (pairs with the season-level defense tables). For in-season use
the current season to-date is trailing by nature.

Reads: nflverse pbp, pbp_participation, rosters. Writes: nfl_defender_impact (DDL footer).
CONFIRM the participation/roster column names against a live file (flagged inline) — nflverse
renames columns; the build degrades gracefully (snap_share null) if participation is absent.
"""
import argparse, os, json, math
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

# roster position -> impact position group (a CB is compared to CBs, an edge to edges)
POS_GROUP = {
    'DE': 'EDGE', 'OLB': 'EDGE', 'EDGE': 'EDGE',
    'DT': 'DL', 'NT': 'DL', 'DL': 'DL',
    'ILB': 'LB', 'MLB': 'LB', 'LB': 'LB',
    'CB': 'CB', 'DB': 'CB',
    'S': 'S', 'FS': 'S', 'SS': 'S', 'SAF': 'S',
}

def load_pbp(season):
    cols = ['season', 'game_id', 'play_id', 'defteam', 'play_type', 'pass', 'rush', 'epa',
            'sack', 'qb_hit', 'tackled_for_loss', 'interception',
            'sack_player_id', 'half_sack_1_player_id', 'half_sack_2_player_id',
            'qb_hit_1_player_id', 'qb_hit_2_player_id',
            'pass_defense_1_player_id', 'pass_defense_2_player_id',
            'interception_player_id',
            'tackle_for_loss_1_player_id', 'tackle_for_loss_2_player_id',
            'forced_fumble_player_1_player_id']
    df = pd.read_parquet(f"{NFLVERSE}/pbp/play_by_play_{season}.parquet")
    keep = [c for c in cols if c in df.columns]
    return df[keep]

def load_snaps(season):
    """Per-defender snap counts from participation's defense_players list. Best-effort."""
    try:
        part = pd.read_parquet(f"{NFLVERSE}/pbp_participation/pbp_participation_{season}.parquet")
    except Exception as e:
        print(f"  [snaps] participation unavailable ({e}) — snap_share will be null"); return None, None
    col = next((c for c in ['defense_players', 'defense_player_ids'] if c in part.columns), None)
    if col is None:
        print("  [snaps] no defense_players column — snap_share null"); return None, None
    part = part[[col]].dropna()
    # defense_players is a ';'-separated list of gsis ids per play
    exploded = part[col].astype(str).str.split(';').explode().str.strip()
    exploded = exploded[exploded != '']
    snaps = exploded.value_counts()                 # id -> defensive snaps played
    team_snaps = len(part)                            # total defensive plays (approx league-wide)
    return snaps, team_snaps

def _first_id(row, cols):
    for c in cols:
        v = row.get(c)
        if v is not None and pd.notna(v) and str(v) != '': return str(v)
    return None

def tally(pbp, season):
    d = pbp[pbp['defteam'].notna()].copy()
    is_pass = d.get('pass', 0) == 1
    # accumulate per-defender event counts
    ev = {}   # id -> dict of counts + team
    def add(pid, key, n=1.0, team=None):
        if not pid: return
        r = ev.setdefault(pid, {'sacks': 0.0, 'qb_hits': 0.0, 'pass_def': 0.0, 'ints': 0.0,
                                'tfl_pass': 0.0, 'tfl_run': 0.0, 'ff': 0.0, 'team': team, 'pass_ev': 0.0, 'run_ev': 0.0})
        r[key] += n
        if team and not r['team']: r['team'] = team

    for _, row in d.iterrows():
        team = row.get('defteam'); passing = row.get('pass') == 1
        # sacks (full + halves)
        if 'sack_player_id' in row and pd.notna(row.get('sack_player_id')): add(str(row['sack_player_id']), 'sacks', 1.0, team)
        for hc in ['half_sack_1_player_id', 'half_sack_2_player_id']:
            if hc in row and pd.notna(row.get(hc)): add(str(row[hc]), 'sacks', 0.5, team)
        for hc in ['qb_hit_1_player_id', 'qb_hit_2_player_id']:
            if hc in row and pd.notna(row.get(hc)): add(str(row[hc]), 'qb_hits', 1.0, team)
        for pc in ['pass_defense_1_player_id', 'pass_defense_2_player_id']:
            if pc in row and pd.notna(row.get(pc)): add(str(row[pc]), 'pass_def', 1.0, team)
        if 'interception_player_id' in row and pd.notna(row.get('interception_player_id')): add(str(row['interception_player_id']), 'ints', 1.0, team)
        for tc in ['tackle_for_loss_1_player_id', 'tackle_for_loss_2_player_id']:
            if tc in row and pd.notna(row.get(tc)): add(str(row[tc]), 'tfl_pass' if passing else 'tfl_run', 1.0, team)
        if 'forced_fumble_player_1_player_id' in row and pd.notna(row.get('forced_fumble_player_1_player_id')): add(str(row['forced_fumble_player_1_player_id']), 'ff', 1.0, team)

    df = pd.DataFrame.from_dict(ev, orient='index')
    df.index.name = 'player_id'
    df['season'] = int(season)
    return df.reset_index()

def enrich(df, snaps, rosters):
    # snaps + names/positions
    if snaps is not None:
        df['snaps'] = df['player_id'].map(snaps).fillna(0).astype(float)
        mx = df['snaps'].max() or 1
        df['snap_share'] = (df['snaps'] / mx).round(3)     # relative to the busiest defender (proxy)
    else:
        df['snaps'] = np.nan; df['snap_share'] = np.nan
    if rosters is not None and len(rosters):
        rmap = rosters.set_index('gsis_id')[['full_name', 'position', 'team']].to_dict('index') \
            if 'gsis_id' in rosters.columns else {}
        df['player_name'] = df['player_id'].map(lambda i: (rmap.get(i) or {}).get('full_name'))
        df['position'] = df['player_id'].map(lambda i: (rmap.get(i) or {}).get('position'))
    else:
        df['player_name'] = None; df['position'] = None
    df['pos_group'] = df['position'].map(lambda p: POS_GROUP.get(str(p).upper(), 'OTHER'))

    # per-defender component scores (raw), snap-normalized where we have snaps
    denom = df['snaps'].where(df['snaps'] > 0, np.nan)
    df['pass_rush_raw'] = (df['sacks'] * 2.0 + df['qb_hits'] * 1.0 + df['tfl_pass'] * 1.0 + df['ff'] * 0.5)
    df['coverage_raw'] = (df['pass_def'] * 1.0 + df['ints'] * 2.5)
    df['run_raw'] = (df['tfl_run'] * 1.5)
    # z-score each component WITHIN position group (edge vs edge, CB vs CB)
    def zscore(s):
        sd = s.std()
        if sd is None or not np.isfinite(sd) or sd == 0: return (s - s.mean()) * 0.0  # lone/flat group -> neutral 0
        return (s - s.mean()) / sd
    for comp in ['pass_rush_raw', 'coverage_raw', 'run_raw']:
        df[comp.replace('_raw', '_score')] = df.groupby('pos_group')[comp].transform(zscore).fillna(0).round(3)
    # ---- impact TYPE: anchor on position/role, not idxmax-of-noise ----
    # Type routes which OPPOSING props an absence afflicts, so it must reflect the player's
    # JOB. A pass rusher with a few run tackles is still pass_rush; a lineman who bats a pass
    # is not 'coverage'. Corners cover, edges rush, interior linemen rush-or-stuff, LBs
    # cover-or-stuff, safeties cover-or-box. Pass-rush production (sacks/hits) gets priority
    # for the front seven because that's what defines a rusher.
    def classify(r):
        pg, pr, cov, run = r['pos_group'], r['pass_rush_score'], r['coverage_score'], r['run_score']
        if pg == 'CB': return 'coverage'
        if pg == 'S':  return 'coverage' if cov >= run - 0.5 else 'run'
        if pg == 'EDGE': return 'pass_rush'
        if pg == 'DL':  return 'pass_rush' if pr >= 1.0 else 'run'
        if pg == 'LB':
            if cov >= pr and cov >= run: return 'coverage'
            return 'pass_rush' if pr >= 1.5 else 'run'
        return 'pass_rush' if pr >= max(cov, run) else ('coverage' if cov >= run else 'run')
    df['impact_type'] = df.apply(classify, axis=1)
    # impact SCORE = the player's score in the thing they actually do (their type), snap-weighted
    tcol = {'pass_rush': 'pass_rush_score', 'coverage': 'coverage_score', 'run': 'run_score'}
    df['type_score'] = df.apply(lambda r: r[tcol[r['impact_type']]], axis=1)
    share = df['snap_share'].fillna(0.5)
    df['impact_score'] = (df['type_score'] * (0.5 + 0.5 * share)).round(3)
    return df

def load_rosters(season):
    for path in [f"{NFLVERSE}/weekly_rosters/roster_weekly_{season}.parquet",
                 f"{NFLVERSE}/rosters/roster_{season}.parquet"]:
        try:
            r = pd.read_parquet(path)
            idcol = next((c for c in ['gsis_id', 'player_id', 'gsis_it_id'] if c in r.columns), None)
            namecol = next((c for c in ['full_name', 'player_name', 'football_name'] if c in r.columns), None)
            if idcol and namecol:
                r = r.rename(columns={idcol: 'gsis_id', namecol: 'full_name'})
                keep = ['gsis_id', 'full_name'] + [c for c in ['position', 'team'] if c in r.columns]
                return r[keep].dropna(subset=['gsis_id']).drop_duplicates('gsis_id')
        except Exception:
            continue
    print("  [rosters] unavailable — names/positions will be null (impact still computed by id)")
    return pd.DataFrame()

def upsert(df):
    cols = ['player_id', 'player_name', 'position', 'pos_group', 'team', 'season',
            'snap_share', 'pass_rush_score', 'coverage_score', 'run_score', 'impact_score', 'impact_type']
    out = df[[c for c in cols if c in df.columns]].copy()
    rows = out.where(pd.notna(out), None).to_dict('records')
    def clean(v):
        if isinstance(v, (np.floating, float)): return None if (v is None or not math.isfinite(v)) else float(v)
        if isinstance(v, (np.integer,)): return int(v)
        return v
    rows = [{k: clean(v) for k, v in r.items()} for r in rows]
    for i in range(0, len(rows), 500):
        r = requests.post(f"{SB}/rest/v1/nfl_defender_impact?on_conflict=player_id,season",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=json.dumps(rows[i:i+500], allow_nan=False), timeout=60)
        print(f"  nfl_defender_impact: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    for s in a.seasons:
        print(f"\n=== defender impact {s} ===")
        pbp = load_pbp(s)
        snaps, _ = load_snaps(s)
        rosters = load_rosters(s)
        df = enrich(tally(pbp, s), snaps, rosters)
        df = df[df['impact_score'].notna()]
        print(f"  defenders: {len(df)}")
        if a.dry_run:
            top = df.sort_values('impact_score', ascending=False).head(15)
            print(top[['player_name', 'pos_group', 'team', 'impact_type', 'snap_share',
                       'pass_rush_score', 'coverage_score', 'run_score', 'impact_score']].to_string(index=False))
            continue
        upsert(df)

if __name__ == '__main__':
    main()

# SCHEMA ADDITION:
# create table if not exists nfl_defender_impact (
#   id bigint generated always as identity primary key,
#   player_id text not null, player_name text, position text, pos_group text, team text,
#   season int not null, snap_share numeric,
#   pass_rush_score numeric, coverage_score numeric, run_score numeric,
#   impact_score numeric, impact_type text,
#   updated_at timestamptz default now(), unique (player_id, season)
# );
