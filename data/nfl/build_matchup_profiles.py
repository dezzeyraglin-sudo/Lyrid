#!/usr/bin/env python3
"""
Lyrid NFL — MATCHUP PROFILES: the structured matchup report behind every prop.

Builds, season-to-date for the current season, from free nflverse data:
  TEAM   offense       EPA/play, success rate, plays/game, pass rate, explosive-play rate, points/game
         OL pass       sack rate allowed, pressures allowed per dropback, QB time to throw
         OL run        RB yards BEFORE contact per carry (blocking), stuffed-run rate allowed
         DL pass       pressure rate, sack rate
         DL run        YPC allowed, stuff rate, yards before contact allowed
         secondary     yards/attempt allowed, pass EPA allowed, explosive-pass rate allowed
         corners       top CBs by targets: yards/target and passer rating allowed
  PLAYER receivers     snap share (last 3), target share, NGS separation, cushion, air-yards share, YAC over expected
         rushers       yards before / after contact per carry, broken tackles, rush yards over expected, snap share
         QBs           time to throw, completion % over expected, aggressiveness
Every team metric carries a league rank, 1 = best for that unit.

Route participation (routes run) is not in free data; snap share is the stand-in. This is CONTEXT for
the card and the tracked Matchup Read — matchup ratings did not predict results vs the line in weeks 1-4.

Writes nfl_matchup_profile (kind, key, data jsonb). Run weekly (refresh_all.py, season group).
"""
import os, re, sys, json, argparse, datetime
import numpy as np, pandas as pd, requests

NV = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
FIX = {'LA': 'LAR', 'WSH': 'WAS', 'JAC': 'JAX', 'OAK': 'LV', 'SD': 'LAC', 'STL': 'LAR'}
fx = lambda t: FIX.get(t, t)

def season():
    d = datetime.date.today(); return d.year if d.month >= 3 else d.year - 1

def norm(s):
    s = str(s or '').lower(); s = re.sub(r"[.'`]", '', s); s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    s = re.sub(r'[^a-z ]', '', s); return re.sub(r'\s+', ' ', s).strip()

def rnd(x, n=3):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else round(float(x), n)

def ranked(values, higher_is_better):
    """{team: (value, rank)} with rank 1 = best for that unit."""
    s = pd.Series(values).dropna()
    r = s.rank(ascending=not higher_is_better, method='min').astype(int)
    return {t: {'v': rnd(s[t]), 'rank': int(r[t]), 'of': int(len(s))} for t in s.index}

def build(y):
    pbp = pd.read_parquet(f"{NV}/pbp/play_by_play_{y}.parquet",
        columns=['game_id', 'season_type', 'week', 'posteam', 'defteam', 'home_team', 'away_team', 'home_score', 'away_score',
                 'play_type', 'epa', 'success', 'yards_gained', 'qb_dropback', 'sack', 'rush_attempt', 'pass_attempt', 'passing_yards'])
    pbp = pbp[(pbp.season_type == 'REG') & pbp.posteam.notna()].copy()
    pbp['posteam'] = pbp.posteam.map(fx); pbp['defteam'] = pbp.defteam.map(fx)
    plays = pbp[pbp.play_type.isin(['pass', 'run'])].copy()
    plays['explosive'] = ((plays.pass_attempt == 1) & (plays.yards_gained >= 20)) | ((plays.rush_attempt == 1) & (plays.yards_gained >= 10))
    rush = plays[plays.rush_attempt == 1]; drop = pbp[pbp.qb_dropback == 1]; pa = plays[plays.pass_attempt == 1]
    games = pbp.groupby('posteam').game_id.nunique()
    g = pbp.drop_duplicates('game_id')
    pts = pd.concat([g.assign(t=g.home_team.map(fx), p=g.home_score)[['t', 'p']], g.assign(t=g.away_team.map(fx), p=g.away_score)[['t', 'p']]]).groupby('t').p.mean()

    pr = pd.read_parquet(f"{NV}/pfr_advstats/advstats_week_rush_{y}.parquet"); pr = pr[pr.game_type == 'REG'].copy()
    pr['team'] = pr.team.map(fx); pr['opponent'] = pr.opponent.map(fx)
    pdf = pd.read_parquet(f"{NV}/pfr_advstats/advstats_week_def_{y}.parquet"); pdf = pdf[pdf.game_type == 'REG'].copy()
    pdf['team'] = pdf.team.map(fx); pdf['opponent'] = pdf.opponent.map(fx)
    rost = pd.read_parquet(f"{NV}/weekly_rosters/roster_weekly_{y}.parquet", columns=['pfr_id', 'position']).dropna().drop_duplicates('pfr_id')
    pos_by_pfr = rost.set_index('pfr_id').position.to_dict()
    ngp = pd.read_parquet(f"{NV}/nextgen_stats/ngs_passing.parquet"); ngp = ngp[(ngp.season == y) & (ngp.week == 0)].copy(); ngp['team_abbr'] = ngp.team_abbr.map(fx)

    M = {}
    def put(section, name, values, hib):
        for t, v in ranked(values, hib).items():
            M.setdefault(t, {}).setdefault(section, {})[name] = v
    # offense
    put('offense', 'epa_play', plays.groupby('posteam').epa.mean(), True)
    put('offense', 'success_rate', plays.groupby('posteam').success.mean(), True)
    put('offense', 'plays_pg', plays.groupby('posteam').size() / games, True)
    put('offense', 'pass_rate', drop.groupby('posteam').size() / (drop.groupby('posteam').size() + rush.groupby('posteam').size()), True)
    put('offense', 'explosive_rate', plays.groupby('posteam').explosive.mean(), True)
    put('offense', 'points_pg', pts, True)
    # OL pass protection
    put('ol_pass', 'sack_rate_allowed', drop.groupby('posteam').sack.mean(), False)
    put('ol_pass', 'pressure_rate_allowed', pdf.groupby('opponent').def_pressures.sum() / drop.groupby('posteam').size(), False)
    # QB time to throw is a STYLE, not a quality (a quick release is why some lines allow few pressures),
    # so it's stored as a plain value with no rank.
    ttt = ngp.sort_values('attempts', ascending=False).drop_duplicates('team_abbr').set_index('team_abbr').avg_time_to_throw
    for t, v in ttt.items(): M.setdefault(t, {}).setdefault('ol_pass', {})['qb_time_to_throw'] = {'v': rnd(v, 2)}
    # OL run blocking
    put('ol_run', 'ybc_per_carry', pr.groupby('team').rushing_yards_before_contact.sum() / pr.groupby('team').carries.sum(), True)
    put('ol_run', 'stuffed_rate', (rush.yards_gained <= 0).groupby(rush.posteam).mean(), False)
    # DL pass rush
    put('dl_pass', 'pressure_rate', pdf.groupby('team').def_pressures.sum() / drop.groupby('defteam').size(), True)
    put('dl_pass', 'sack_rate', drop.groupby('defteam').sack.mean(), True)
    # DL run defense
    put('dl_run', 'ypc_allowed', rush.groupby('defteam').yards_gained.sum() / rush.groupby('defteam').size(), False)
    put('dl_run', 'stuff_rate', (rush.yards_gained <= 0).groupby(rush.defteam).mean(), True)
    put('dl_run', 'ybc_allowed', pr.groupby('opponent').rushing_yards_before_contact.sum() / pr.groupby('opponent').carries.sum(), False)
    # secondary
    put('secondary', 'ypa_allowed', pa.groupby('defteam').passing_yards.sum() / pa.groupby('defteam').size(), False)
    put('secondary', 'pass_epa_allowed', pa.groupby('defteam').epa.mean(), False)
    put('secondary', 'explosive_pass_allowed', (pa.yards_gained >= 20).groupby(pa.defteam).mean(), False)
    # corners
    pdf['pos'] = pdf.pfr_player_id.map(pos_by_pfr)
    cb = pdf[pdf.pos.isin(['CB', 'DB'])].copy()
    cb['rating_x_tgt'] = pd.to_numeric(cb.def_passer_rating_allowed, errors='coerce') * cb.def_targets
    agg = cb.groupby(['team', 'pfr_player_name']).agg(tgt=('def_targets', 'sum'), yds=('def_yards_allowed', 'sum'), rx=('rating_x_tgt', 'sum')).reset_index()
    agg = agg[agg.tgt >= 8]
    for t, gg in agg.groupby('team'):
        top = gg.sort_values('tgt', ascending=False).head(3)
        M.setdefault(t, {})['corners'] = [{'name': r.pfr_player_name, 'targets': int(r.tgt), 'ypt': rnd(r.yds / r.tgt, 1),
                                           'rating': rnd(r.rx / r.tgt, 1)} for r in top.itertuples()]
    for t in M: M[t]['games'] = int(games.get(t, 0))
    rows = [{'kind': 'team', 'key': t, 'data': d} for t, d in M.items()]

    # ---- players ----
    P = {}
    snaps = pd.read_parquet(f"{NV}/snap_counts/snap_counts_{y}.parquet"); snaps = snaps[snaps.game_type == 'REG'].copy()
    snaps['key'] = snaps.player.map(norm); snaps['pct'] = pd.to_numeric(snaps.offense_pct, errors='coerce')
    snap3 = snaps[snaps.pct > 0].sort_values('week').groupby('key').tail(3).groupby('key').pct.mean()
    W = pd.read_parquet(f"{NV}/stats_player/stats_player_week_{y}.parquet"); W = W[W.season_type == 'REG'].copy()
    W['targets'] = pd.to_numeric(W.targets, errors='coerce').fillna(0); W['key'] = W.player_display_name.map(norm)
    tt = W.groupby('team').targets.sum(); ts = W.groupby(['key', 'team']).targets.sum().reset_index()
    tshare = {r.key: r.targets / tt[r.team] for r in ts.itertuples() if tt.get(r.team, 0) > 0}
    ngr = pd.read_parquet(f"{NV}/nextgen_stats/ngs_receiving.parquet"); ngr = ngr[(ngr.season == y) & (ngr.week == 0)]
    for r in ngr.itertuples():
        k = norm(r.player_display_name)
        P.setdefault(k, {})['receiving'] = {'separation': rnd(r.avg_separation, 2), 'cushion': rnd(r.avg_cushion, 2),
            'air_yards_share': rnd(r.percent_share_of_intended_air_yards, 1), 'yac_over_expected': rnd(r.avg_yac_above_expectation, 2), 'targets': int(r.targets)}
    pra = pr.groupby('pfr_player_name').agg(c=('carries', 'sum'), ybc=('rushing_yards_before_contact', 'sum'), yac=('rushing_yards_after_contact', 'sum'),
                                            bt=('rushing_broken_tackles', 'sum'), g=('week', 'nunique')).reset_index()
    for r in pra[pra.c >= 10].itertuples():
        P.setdefault(norm(r.pfr_player_name), {})['rushing'] = {'ybc_per_carry': rnd(r.ybc / r.c, 2), 'yac_per_carry': rnd(r.yac / r.c, 2),
            'broken_tackle_rate': rnd(r.bt / r.c, 3), 'carries_pg': rnd(r.c / max(r.g, 1), 1)}
    ngu = pd.read_parquet(f"{NV}/nextgen_stats/ngs_rushing.parquet"); ngu = ngu[(ngu.season == y) & (ngu.week == 0)]
    for r in ngu.itertuples():
        P.setdefault(norm(r.player_display_name), {}).setdefault('rushing', {}).update({'ryoe_per_att': rnd(r.rush_yards_over_expected_per_att, 2),
            'box8_rate': rnd(r.percent_attempts_gte_eight_defenders, 1)})
    for r in ngp.itertuples():
        P.setdefault(norm(r.player_display_name), {})['passing'] = {'time_to_throw': rnd(r.avg_time_to_throw, 2),
            'cpoe': rnd(r.completion_percentage_above_expectation, 1), 'aggressiveness': rnd(r.aggressiveness, 1)}
    for k in P:
        if k in snap3.index: P[k]['snap_share'] = rnd(snap3[k], 3)
        if k in tshare: P[k]['target_share'] = rnd(tshare[k], 3)
    rows += [{'kind': 'player', 'key': k, 'data': d} for k, d in P.items()]
    return rows, M, P

def upsert(rows):
    now = pd.Timestamp.now(tz='UTC').isoformat()
    for r in rows: r['updated_at'] = now
    for i in range(0, len(rows), 500):
        rr = requests.post(f"{SB}/rest/v1/nfl_matchup_profile?on_conflict=kind,key",
                           headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                           data=json.dumps(rows[i:i + 500], allow_nan=False), timeout=60)
        print(f"  nfl_matchup_profile: {rr.status_code} ({min(i + 500, len(rows))}/{len(rows)})")
        if rr.status_code >= 300: print("   ", rr.text[:200]); sys.exit(1)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--team', nargs='*')
    a = ap.parse_args(); y = season()
    rows, M, P = build(y)
    if a.dry_run:
        print(f"season {y}: {sum(1 for r in rows if r['kind']=='team')} teams, {sum(1 for r in rows if r['kind']=='player')} players")
        for t in (a.team or ['ATL', 'NO']):
            print(f"\n{t}: " + json.dumps(M.get(t), indent=None)[:900])
        for nm in ['bijan robinson', 'chris olave']:
            print(f"\n{nm}: {json.dumps(P.get(nm))}")
        sys.exit()
    upsert(rows)

# SCHEMA:
# create table if not exists nfl_matchup_profile (
#   id bigint generated always as identity primary key,
#   kind text not null, key text not null, data jsonb not null,
#   updated_at timestamptz default now(), unique (kind, key)
# );
