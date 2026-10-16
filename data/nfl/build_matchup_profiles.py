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
        columns=['game_id', 'play_id', 'rusher_player_id', 'season_type', 'week', 'posteam', 'defteam', 'home_team', 'away_team', 'home_score', 'away_score',
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
    COVSPLIT = {}
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
    # ---- BLITZ PACKAGES, FRONTS, OFFENSIVE STYLE (FTN charting, current season) ----
    try:
        ftn = pd.read_parquet(f"{NV}/ftn_charting/ftn_charting_{y}.parquet")
        j = pbp.merge(ftn[['nflverse_game_id', 'nflverse_play_id', 'n_blitzers', 'n_pass_rushers', 'n_defense_box', 'is_play_action', 'is_motion', 'is_screen_pass']],
                      left_on=['game_id', 'play_id'], right_on=['nflverse_game_id', 'nflverse_play_id'], how='inner')
        jd = j[j.qb_dropback == 1].copy(); jd['blitz'] = pd.to_numeric(jd.n_blitzers, errors='coerce').fillna(0) > 0
        jr = j[j.rush_attempt == 1].copy()
        put('blitz', 'blitz_rate', jd.groupby('defteam').blitz.mean(), True)
        put('blitz', 'six_plus_rushers', (pd.to_numeric(jd.n_pass_rushers, errors='coerce') >= 6).groupby(jd.defteam).mean(), True)
        put('blitz', 'epa_allowed_when_blitzing', jd[jd.blitz].groupby('defteam').epa.mean(), False)
        put('blitz', 'epa_allowed_standard_rush', jd[~jd.blitz].groupby('defteam').epa.mean(), False)
        for t, v in jd.groupby('defteam').n_pass_rushers.apply(lambda s: pd.to_numeric(s, errors='coerce').mean()).items():
            M.setdefault(t, {}).setdefault('blitz', {})['avg_pass_rushers'] = {'v': rnd(v, 2)}
        put('fronts', 'stacked_box_rate', (pd.to_numeric(jr.n_defense_box, errors='coerce') >= 8).groupby(jr.defteam).mean(), True)
        put('style', 'epa_vs_blitz', jd[jd.blitz].groupby('posteam').epa.mean(), True)
        put('style', 'epa_vs_standard_rush', jd[~jd.blitz].groupby('posteam').epa.mean(), True)
        put('style', 'play_action_rate', jd.groupby('posteam').is_play_action.mean(), True)
        put('style', 'motion_rate', j.groupby('posteam').is_motion.mean(), True)
        put('style', 'faced_stacked_box_rate', (pd.to_numeric(jr.n_defense_box, errors='coerce') >= 8).groupby(jr.posteam).mean(), False)
    except Exception as e:
        print(f"  [ftn] blitz/front data unavailable: {str(e)[:60]}")
    put('ol_run', 'run_10plus_rate', (rush.yards_gained >= 10).groupby(rush.posteam).mean(), True)
    put('ol_run', 'run_20plus_rate', (rush.yards_gained >= 20).groupby(rush.posteam).mean(), True)
    put('dl_run', 'run_10plus_allowed', (rush.yards_gained >= 10).groupby(rush.defteam).mean(), False)
    put('dl_run', 'run_20plus_allowed', (rush.yards_gained >= 20).groupby(rush.defteam).mean(), False)
    # ---- COVERAGE (last completed season: NGS participation isn't published until after a season) ----
    cov_season = y - 1
    try:
        part = pd.read_parquet(f"{NV}/pbp_participation/pbp_participation_{cov_season}.parquet",
                               columns=['nflverse_game_id', 'play_id', 'defense_man_zone_type', 'defense_coverage_type'])
        pb = pd.read_parquet(f"{NV}/pbp/play_by_play_{cov_season}.parquet",
                             columns=['game_id', 'play_id', 'season_type', 'defteam', 'pass_attempt', 'receiver_player_id', 'yards_gained'])
        pb = pb[(pb.season_type == 'REG') & (pb.pass_attempt == 1)].copy(); pb['defteam'] = pb.defteam.map(fx)
        cv = pb.merge(part, left_on=['game_id', 'play_id'], right_on=['nflverse_game_id', 'play_id'], how='inner')
        mz = cv[cv.defense_man_zone_type.isin(['MAN_COVERAGE', 'ZONE_COVERAGE'])]
        for t, gg in mz.groupby('defteam'):
            shells = cv[cv.defteam == t].defense_coverage_type.replace('', np.nan).dropna().value_counts(normalize=True)
            M.setdefault(t, {})['coverage'] = {'season': cov_season, 'man_rate': rnd((gg.defense_man_zone_type == 'MAN_COVERAGE').mean()),
                'shells': {k: rnd(v) for k, v in shells.head(5).items()}}
        rmap = pd.read_parquet(f"{NV}/weekly_rosters/roster_weekly_{cov_season}.parquet", columns=['gsis_id', 'full_name']).dropna().drop_duplicates('gsis_id').set_index('gsis_id').full_name.to_dict()
        mz = mz[mz.receiver_player_id.notna()].copy(); mz['key'] = mz.receiver_player_id.map(rmap).map(norm)
        for k, gg in mz.groupby('key'):
            man = gg[gg.defense_man_zone_type == 'MAN_COVERAGE']; zone = gg[gg.defense_man_zone_type == 'ZONE_COVERAGE']
            if len(man) >= 12 and len(zone) >= 12:
                COVSPLIT[k] = {'season': cov_season, 'man_ypt': rnd(man.yards_gained.sum() / len(man), 1), 'man_tgts': int(len(man)),
                               'zone_ypt': rnd(zone.yards_gained.sum() / len(zone), 1), 'zone_tgts': int(len(zone))}
    except Exception as e:
        print(f"  [coverage] {cov_season} participation unavailable: {str(e)[:60]}")
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
    last = W.sort_values('week').groupby('key').tail(1).set_index('key')
    for k in P:
        if k in last.index: P[k]['team'] = fx(last.loc[k, 'team']); P[k]['position'] = last.loc[k, 'position']
    rr = pd.read_parquet(f"{NV}/weekly_rosters/roster_weekly_{y}.parquet", columns=['gsis_id', 'full_name']).dropna().drop_duplicates('gsis_id').set_index('gsis_id').full_name.to_dict()
    ru2 = rush[rush.rusher_player_id.notna()].copy(); ru2['key'] = ru2.rusher_player_id.map(rr).map(norm)
    for k, gg in ru2.groupby('key'):
        if len(gg) >= 15:
            P.setdefault(k, {}).setdefault('rushing', {}).update({'carries': int(len(gg)), 'run_10plus_rate': rnd((gg.yards_gained >= 10).mean()),
                'run_20plus_rate': rnd((gg.yards_gained >= 20).mean()), 'stuffed_rate': rnd((gg.yards_gained <= 0).mean())})
    for k, v in COVSPLIT.items(): P.setdefault(k, {})['vs_coverage'] = v
    try:
        Q = pd.concat([pd.read_parquet(f"{NV}/stats_player/stats_player_week_{s}.parquet") for s in [y - 1, y]], ignore_index=True)
        Q = Q[(Q.season_type == 'REG') & (Q.position == 'QB')].copy()
        for c in ['attempts', 'passing_yards']: Q[c] = pd.to_numeric(Q[c], errors='coerce').fillna(0)
        Q['key'] = Q.player_display_name.map(norm); Q['t'] = Q.season * 100 + Q.week
        TA = Q.groupby(['team', 't']).attempts.sum().reset_index()
        lg_ypa = Q[Q.attempts >= 15].passing_yards.sum() / Q[Q.attempts >= 15].attempts.sum()
        for k, gg in Q[Q.attempts >= 15].groupby('key'):
            h = gg.sort_values('t').tail(8)
            if len(h) < 2: continue
            th = TA[TA.team == h.team.iloc[-1]].sort_values('t').tail(6)
            w = np.linspace(0.6, 1.0, len(h)); a = h.attempts.sum()
            P.setdefault(k, {})['qb_model'] = {'att_own': rnd(np.average(h.attempts, weights=w), 2), 'team_att': rnd(th.attempts.mean(), 2) if len(th) else None,
                'ypa': rnd((h.passing_yards.sum() + lg_ypa * 250) / (a + 250), 3), 'starts': int(len(h))}
            P[k].setdefault('team', fx(h.team.iloc[-1])); P[k].setdefault('position', 'QB')
    except Exception as e:
        print(f"  [qb] inputs unavailable: {str(e)[:60]}")
    rows += [{'kind': 'player', 'key': k, 'data': d} for k, d in P.items()]
    gm = pbp.drop_duplicates('game_id'); pts_all = float((gm.home_score + gm.away_score).sum())
    tds = pd.read_parquet(f"{NV}/pbp/play_by_play_{y}.parquet", columns=['season_type', 'touchdown', 'td_team'])
    tds = tds[(tds.season_type == 'REG') & (tds.touchdown == 1) & tds.td_team.notna()]
    rows.append({'kind': 'meta', 'key': 'league', 'data': {
        'run_10plus': rnd((rush.yards_gained >= 10).mean()), 'run_20plus': rnd((rush.yards_gained >= 20).mean()), 'stuffed': rnd((rush.yards_gained <= 0).mean()),
        'td_per_point': rnd(len(tds) / pts_all, 4) if pts_all else None,
        'qb_att_coef': [0.4241, -0.0784, 0.2771, 5.6237], 'qb_typical_miss': 58}})
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
