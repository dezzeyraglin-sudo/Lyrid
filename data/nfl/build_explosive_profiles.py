#!/usr/bin/env python3
"""
Lyrid NFL — explosiveness profiles (the chunk-play layer). THREE tables from
nflverse pbp, all free:

  nfl_receiver_explosive  — per WR/TE/RB: aDOT, deep-target rate, explosive-catch
     rate (20+ yd receptions), breakaway rate (40+), YPC, and a position-normalized
     explosiveness_score. This is what separates a boom-bust FIELD-STRETCHER (JSN,
     Chase, Jefferson) from a POSSESSION chain-mover AT THE SAME TARGET VOLUME — the
     one axis the 2-D comp vector can't see, so JSN gets pooled with dink-and-dunk
     receivers and his fat right tail averages away.

  nfl_qb_deepball  — per QB: aDOT, deep-attempt rate (20+ air yds), deep completion%,
     deep YPA, and a deepball_score. Captures the "takes deep shots" trait (Darnold)
     that all-throws CPOE hides. A gunslinger lifts his receivers' ceiling AND his own
     passing yards; a checkdown QB caps both.

  nfl_defense_explosive_allowed  — per defense, per position group: deep-target and
     explosive-catch rate ALLOWED. The matchup amplifier — a boom receiver vs a
     defense that bleeds chunk plays is the real ceiling day.

These feed a SKEW-AWARE tail model (nflExplosiveness.js): boom raises P(over) at a
STIFF line (above the comp median) and LOWERS it at a soft line, because the same
variance that gives a 130-yd game gives a 3-for-40 dud. It's an additive correction
until explosiveness becomes a comp-vector feature, at which point the pool captures
it directly.

Thresholds: DEEP_AIR=20 (deep attempt/target), EXPL_YDS=20 (explosive reception),
BREAK_YDS=40 (breakaway). Tune on backtest before any of this moves a tier label.
"""
import argparse, os, math, json
import pandas as pd, numpy as np, requests

NV = "https://github.com/nflverse/nflverse-data/releases/download"
DEEP_AIR = 20
EXPL_YDS = 20
BREAK_YDS = 40

def roster_pos(season):
    rost = pd.read_parquet(f"{NV}/weekly_rosters/roster_weekly_{season}.parquet",
                           columns=['gsis_id', 'position'])
    return rost.drop_duplicates('gsis_id').set_index('gsis_id')['position'].to_dict()

def _zwithin(df, col, group=None):
    if group is None:
        s = df[col]
        return ((s - s.mean()) / (s.std() or 1))
    return df.groupby(group)[col].transform(lambda s: (s - s.mean()) / (s.std() or 1))

# ---------------------------------------------------------------------------
# 1. RECEIVER explosiveness
# ---------------------------------------------------------------------------
def build_receiver(season, min_targets=30):
    pbp = pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
        columns=['receiver_player_id', 'receiver_player_name', 'air_yards',
                 'complete_pass', 'pass_attempt', 'receiving_yards'])
    p = pbp[(pbp.pass_attempt == 1) & pbp.receiver_player_id.notna()].copy()
    p['is_deep'] = (p.air_yards >= DEEP_AIR).astype(float)
    g = p.groupby(['receiver_player_id', 'receiver_player_name'])
    rec = g.agg(targets=('pass_attempt', 'sum'), receptions=('complete_pass', 'sum'),
                rec_yards=('receiving_yards', 'sum'), adot=('air_yards', 'mean'),
                deep_targets=('is_deep', 'sum')).reset_index()
    comp = p[p.complete_pass == 1].copy()
    comp['expl'] = (comp.receiving_yards >= EXPL_YDS).astype(float)
    comp['brk'] = (comp.receiving_yards >= BREAK_YDS).astype(float)
    ex = comp.groupby('receiver_player_id').agg(
        expl_catches=('expl', 'sum'), brk_catches=('brk', 'sum')).reset_index()
    rec = rec.merge(ex, on='receiver_player_id', how='left')
    rec = rec[rec.targets >= min_targets].copy()

    reps = rec.receptions.replace(0, np.nan)
    rec['deep_target_rate'] = (rec.deep_targets / rec.targets).round(4)
    rec['explosive_catch_rate'] = (rec.expl_catches / reps).round(4)
    rec['breakaway_rate'] = (rec.brk_catches / reps).round(4)
    rec['yprc'] = (rec.rec_yards / reps).round(2)
    rec['adot'] = rec.adot.round(2)
    pos = roster_pos(season)
    rec['position'] = rec.receiver_player_id.map(pos)
    rec['pos_group'] = rec.position.where(rec.position.isin(['WR', 'TE', 'RB']), 'WR')

    # explosiveness_score = position-normalized z of the deep/explosive metrics
    parts = ['adot', 'deep_target_rate', 'explosive_catch_rate', 'yprc']
    for c in parts:
        rec[c + '_z'] = _zwithin(rec, c, 'pos_group')
    rec['explosiveness_score'] = rec[[c + '_z' for c in parts]].mean(axis=1).round(4)
    rec['season'] = season
    for c in ['targets', 'receptions']:
        rec[c] = rec[c].fillna(0).astype(int)
    rec = rec.rename(columns={'receiver_player_id': 'player_key', 'receiver_player_name': 'player_name'})
    return rec[['player_key', 'player_name', 'position', 'pos_group', 'season',
                'targets', 'receptions', 'adot', 'deep_target_rate',
                'explosive_catch_rate', 'breakaway_rate', 'yprc', 'explosiveness_score']]

# ---------------------------------------------------------------------------
# 2. QB deep-ball
# ---------------------------------------------------------------------------
def build_qb(season, min_att=150):
    pbp = pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
        columns=['passer_player_id', 'passer_player_name', 'air_yards',
                 'complete_pass', 'pass_attempt', 'yards_gained'])
    p = pbp[(pbp.pass_attempt == 1) & pbp.passer_player_id.notna()].copy()
    p['is_deep'] = (p.air_yards >= DEEP_AIR).astype(float)
    g = p.groupby(['passer_player_id', 'passer_player_name'])
    qb = g.agg(attempts=('pass_attempt', 'sum'), completions=('complete_pass', 'sum'),
               adot=('air_yards', 'mean'), deep_atts=('is_deep', 'sum')).reset_index()
    deep = p[p.is_deep == 1]
    dd = deep.groupby('passer_player_id').agg(
        deep_comps=('complete_pass', 'sum'), deep_yards=('yards_gained', 'sum')).reset_index()
    qb = qb.merge(dd, on='passer_player_id', how='left')
    qb = qb[qb.attempts >= min_att].copy()

    da = qb.deep_atts.replace(0, np.nan)
    qb['deep_att_rate'] = (qb.deep_atts / qb.attempts).round(4)
    qb['deep_comp_pct'] = (qb.deep_comps / da).round(4)
    qb['deep_ypa'] = (qb.deep_yards / da).round(2)
    qb['adot'] = qb.adot.round(2)
    for c in ['adot', 'deep_att_rate', 'deep_comp_pct', 'deep_ypa']:
        qb[c + '_z'] = _zwithin(qb, c)
    # deepball_score = TENDENCY: does he push it deep at all? Weights aDOT + deep-
    # attempt rate above accuracy. Use this for the QB's OWN passing tail (deep volume
    # inflates his yardage variance even when he's streaky).
    qb['deepball_score'] = (0.40 * qb['adot_z'] + 0.35 * qb['deep_att_rate_z']
                            + 0.25 * qb['deep_comp_pct_z']).round(4)
    # deep_connect_score = EFFICIENCY: does he actually COMPLETE deep? Use this for
    # the receiver-facing ceiling. A QB who attempts deep but misses (high deep_att_rate,
    # low deep_comp_pct / deep_ypa — the JJ McCarthy case) TANKS his deep receivers
    # rather than feeding them; deepball_score alone would wrongly credit him.
    qb['deep_connect_score'] = (0.6 * qb['deep_comp_pct_z'] + 0.4 * qb['deep_ypa_z']).round(4)
    qb['season'] = season
    qb['attempts'] = qb['attempts'].fillna(0).astype(int)
    qb = qb.rename(columns={'passer_player_id': 'player_key', 'passer_player_name': 'player_name'})
    return qb[['player_key', 'player_name', 'season', 'attempts', 'adot',
               'deep_att_rate', 'deep_comp_pct', 'deep_ypa', 'deepball_score', 'deep_connect_score']]

# ---------------------------------------------------------------------------
# 3. DEFENSE explosive-allowed (by position group)
# ---------------------------------------------------------------------------
def build_defense(season):
    pbp = pd.read_parquet(f"{NV}/pbp/play_by_play_{season}.parquet",
        columns=['defteam', 'receiver_player_id', 'air_yards', 'complete_pass',
                 'pass_attempt', 'receiving_yards'])
    pos = roster_pos(season)
    p = pbp[(pbp.pass_attempt == 1) & pbp.receiver_player_id.notna()].copy()
    p['rec_pos'] = p.receiver_player_id.map(pos)
    p['pos_group'] = p.rec_pos.where(p.rec_pos.isin(['WR', 'TE', 'RB']), 'WR')
    p['is_deep'] = (p.air_yards >= DEEP_AIR).astype(float)
    comp = p[p.complete_pass == 1].copy()
    comp['expl'] = (comp.receiving_yards >= EXPL_YDS).astype(float)

    rows = []
    for grp in ['WR', 'TE', 'RB']:
        g = p[p.pos_group == grp]; c = comp[comp.pos_group == grp]
        a = g.groupby('defteam').agg(targets=('pass_attempt', 'sum'),
                                     deep_targets=('is_deep', 'sum')).reset_index()
        b = c.groupby('defteam').agg(receptions=('complete_pass', 'sum'),
                                     expl_allowed=('expl', 'sum')).reset_index()
        m = a.merge(b, on='defteam', how='left')
        m['deep_target_rate_allowed'] = (m.deep_targets / m.targets).round(4)
        m['explosive_catch_rate_allowed'] = (m.expl_allowed / m.receptions.replace(0, np.nan)).round(4)
        m['pos_group'] = grp; m['season'] = season
        for col in ['targets', 'receptions']:
            m[col] = m[col].fillna(0).astype(int)
        rows.append(m.rename(columns={'defteam': 'team_abbr'}))
    df = pd.concat(rows, ignore_index=True)
    df = df[df.team_abbr.notna()]
    return df[['team_abbr', 'season', 'pos_group', 'targets', 'receptions',
               'deep_target_rate_allowed', 'explosive_catch_rate_allowed']]

# ---------------------------------------------------------------------------
def upsert(df, table, conflict):
    url = os.environ['SUPABASE_URL'].rstrip('/') + f'/rest/v1/{table}'
    key = os.environ['SUPABASE_SERVICE_KEY']
    h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
         'Prefer': 'resolution=merge-duplicates,return=minimal'}
    def clean(v):
        if v is None: return None
        if isinstance(v, (np.floating, float)):
            f = float(v); return None if not math.isfinite(f) else f
        if isinstance(v, (np.integer,)): return int(v)
        if isinstance(v, (np.bool_,)): return bool(v)
        return v
    rows = [{k: clean(v) for k, v in r.items()} for r in df.where(pd.notna(df), None).to_dict('records')]
    body = json.dumps(rows, allow_nan=False)
    r = requests.post(url + f'?on_conflict={conflict}', headers=h, data=body, timeout=60)
    print(f"  {table}: {r.status_code} ({len(rows)} rows)")
    if r.status_code >= 300: print("   ", r.text[:200])

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    for s in a.seasons:
        print(f"\n=== explosive profiles {s} ===")
        rec, qb, dfn = build_receiver(s), build_qb(s), build_defense(s)
        if a.dry_run:
            print("-- top field-stretchers --")
            print(rec.nlargest(8, 'explosiveness_score')[['player_name', 'pos_group', 'adot', 'explosive_catch_rate', 'explosiveness_score']].to_string(index=False))
            print("-- top deep-ball QBs (tendency) --")
            print(qb.nlargest(6, 'deepball_score')[['player_name', 'adot', 'deep_att_rate', 'deep_comp_pct', 'deepball_score', 'deep_connect_score']].to_string(index=False))
            print("-- throws deep but MISSES (high attempt rate, low connect) --")
            chuck = qb[qb.deep_att_rate >= qb.deep_att_rate.median()]
            print(chuck.nsmallest(6, 'deep_connect_score')[['player_name', 'deep_att_rate', 'deep_comp_pct', 'deep_ypa', 'deep_connect_score']].to_string(index=False))
            print("-- defenses bleeding chunk plays vs WR --")
            print(dfn[dfn.pos_group == 'WR'].nlargest(6, 'explosive_catch_rate_allowed')[['team_abbr', 'explosive_catch_rate_allowed', 'deep_target_rate_allowed']].to_string(index=False))
            continue
        upsert(rec, 'nfl_receiver_explosive', 'player_key,season')
        upsert(qb, 'nfl_qb_deepball', 'player_key,season')
        upsert(dfn, 'nfl_defense_explosive_allowed', 'team_abbr,season,pos_group')

# SCHEMA ADDITIONS:
# create table if not exists nfl_receiver_explosive (
#   id bigint generated always as identity primary key,
#   player_key text not null, player_name text, position text, pos_group text, season int not null,
#   targets int, receptions int, adot numeric, deep_target_rate numeric,
#   explosive_catch_rate numeric, breakaway_rate numeric, yprc numeric, explosiveness_score numeric,
#   updated_at timestamptz default now(), unique (player_key, season)
# );
# create table if not exists nfl_qb_deepball (
#   id bigint generated always as identity primary key,
#   player_key text not null, player_name text, season int not null,
#   attempts int, adot numeric, deep_att_rate numeric, deep_comp_pct numeric,
#   deep_ypa numeric, deepball_score numeric, deep_connect_score numeric,
#   updated_at timestamptz default now(), unique (player_key, season)
# );
# create table if not exists nfl_defense_explosive_allowed (
#   id bigint generated always as identity primary key,
#   team_abbr text references nfl_teams(team_abbr), season int not null,
#   pos_group text check (pos_group in ('WR','TE','RB')) not null,
#   targets int, receptions int, deep_target_rate_allowed numeric, explosive_catch_rate_allowed numeric,
#   updated_at timestamptz default now(), unique (team_abbr, season, pos_group)
# );
