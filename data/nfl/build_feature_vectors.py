#!/usr/bin/env python3
"""
Lyrid NFL — feature-vector precompute (context-conditioned comp POOL).

THREE CHANNELS per historical player-game, each computed ONLY from data available
before that week's kickoff (trailing shift(1) — the leakage guard):

  SKILL  (what the player controls, travels with him across teams/QBs):
     skill_volume_floor, skill_recent_form, skill_tshare, skill_ays, skill_carry
  ENVIRONMENT (what the offense hands him — swapped at projection time):
     team-rolling (slow):  env_proe, env_pace, env_passblock
     QB-specific (fast):   env_qb_adot, env_qb_deepconnect, env_qb_cpoe
  MILESTONE (late-season round-number chase → force-feed):
     milestone_pull   (proximity-to-1000 in a reachable late window; raise-only)

WHY THIS FIXES STALENESS BOTH WAYS: the environment is NOT baked into the player's
baseline. At projection time the slate builds the target as { the player's own SKILL
history } + { TONIGHT'S environment (current starter's QB channel + current team
profile) }. So a QB upgrade (Jefferson: bad-QB 2025 → Murray 2026) raises his comp
by swapping the env channel — no history rewrite needed — and a downgrade lowers it.

Reads: nfl_player_games, nfl_team_week_env, nfl_qb_week_env (env from build_env_history.py).
Writes: nfl_feature_vectors (feature_json holds the 3-channel vector; old keys kept for back-compat).
"""
import argparse, os, json, math
import pandas as pd, numpy as np, requests

SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

PROP_COLS = {'passing_yards': 'passing_yards', 'rushing_yards': 'rushing_yards', 'receiving_yards': 'receiving_yards'}
YARDS_COL = {'receiving_yards': 'tr_rec', 'rushing_yards': 'tr_rush', 'passing_yards': 'tr_pass'}
MIN_TRAIL = {'receiving_yards': 5.0, 'rushing_yards': 5.0, 'passing_yards': 50.0}

def fetch_table(table, select='*'):
    rows, start = [], 0
    while True:
        r = requests.get(f"{SB}/rest/v1/{table}",
                         headers={**H, 'Range-Unit': 'items', 'Range': f'{start}-{start+999}'},
                         params={'select': select}, timeout=60)
        try: b = r.json()
        except Exception: break
        if not isinstance(b, list) or not b: break
        rows += b
        if len(b) < 1000: break
        start += 1000
    return pd.DataFrame(rows)

def trailing(df, key, col, n=6):
    """Leakage-safe trailing mean: shift(1) excludes the current row, grouped by key."""
    if col not in df.columns: return pd.Series([np.nan] * len(df), index=df.index)
    return df.groupby(key)[col].transform(lambda s: pd.to_numeric(s, errors='coerce').shift(1).rolling(n, min_periods=2).mean())

def zstats(series):
    xs = pd.to_numeric(series, errors='coerce').replace([np.inf, -np.inf], np.nan).dropna()
    if len(xs) < 8: return (None, None)
    sd = float(xs.std())
    return (float(xs.mean()), sd if sd else 1.0)

def zf(v, ms, lo=-3.0, hi=3.0):
    m, sd = ms
    if v is None or m is None or not sd: return None
    try: v = float(v)
    except (TypeError, ValueError): return None
    if not math.isfinite(v): return None
    return round(max(lo, min(hi, (v - m) / sd)), 4)

def _z(v, mean, sd):
    try: v = float(v)
    except (TypeError, ValueError): return None
    if not math.isfinite(v): return None
    if mean is None: return v
    return (v - mean) / sd if sd else None

def _safe(v):
    if v is None: return None
    try: f = float(v)
    except (TypeError, ValueError): return v
    return f if math.isfinite(f) else None

def milestone_pull(cum, games_left, family):
    """Raise-only late-season 1000-yard chase. Models PROXIMITY (not raw total), so it
    can't re-encode talent. ~0 for most players/most weeks; lights up only when a
    reachable round number is within a late-season push."""
    if family == 'passing_yards': return 0.0
    if cum is None or games_left is None or games_left <= 0 or games_left > 4: return 0.0
    target = 1000.0
    if cum >= target: return 0.0                       # clinched (raise-only; coast-down pending audit)
    per_game = (target - cum) / games_left
    if per_game < 30 or per_game > 130: return 0.0     # too easy (no force-feed) / out of reach
    pull = (1.0 - abs(per_game - 80) / 80) * (1.0 - (games_left - 1) / 4)
    return round(max(0.0, min(1.0, pull)), 3)

def build(seasons):
    pg = fetch_table('nfl_player_games')
    if pg.empty:
        print("  no player_games in DB — run ingest_nflverse.py first"); return pd.DataFrame()
    pg = pg[pg.season.isin(seasons)].copy().sort_values(['player_key', 'season', 'week'])
    for c in ['passing_yards', 'rushing_yards', 'receiving_yards', 'targets', 'carries',
              'rush_attempts', 'target_share', 'air_yards_share']:
        if c in pg.columns: pg[c] = pd.to_numeric(pg[c], errors='coerce')
    carry_col = 'carries' if 'carries' in pg.columns else 'rush_attempts'

    # ---- SKILL: trailing (pre-kickoff) player signals ----
    pg['tr_tshare'] = trailing(pg, 'player_key', 'target_share')
    pg['tr_ays'] = trailing(pg, 'player_key', 'air_yards_share')
    pg['tr_rec'] = trailing(pg, 'player_key', 'receiving_yards')
    pg['tr_rush'] = trailing(pg, 'player_key', 'rushing_yards')
    pg['tr_pass'] = trailing(pg, 'player_key', 'passing_yards')
    pg['tr_carries'] = trailing(pg, 'player_key', carry_col)

    # ---- MILESTONE: trailing cumulative family yards + games left ----
    for fam, col in PROP_COLS.items():
        pg['cum_' + fam] = pg.groupby(['player_key', 'season'])[col].transform(
            lambda s: pd.to_numeric(s, errors='coerce').shift(1).cumsum())
    pg['games_left'] = (18 - pg['week']).clip(lower=0)   # entering week w of a 17-game season

    # ---- ENVIRONMENT: team-week + qb-week, trailed, z-scored vs league ----
    tw = fetch_table('nfl_team_week_env')
    qw = fetch_table('nfl_qb_week_env')
    teamEnvZ, qbEnvZ, primaryQB = {}, {}, {}
    if not tw.empty:
        tw = tw.sort_values(['team_abbr', 'season', 'week'])
        for c in ['proe', 'pass_rate', 'plays', 'sack_rate_allowed']: tw[c] = pd.to_numeric(tw.get(c), errors='coerce')
        # trailing across the season boundary (last season's tail primes week 1)
        tw['tr_proe'] = trailing(tw, 'team_abbr', 'proe')
        tw['tr_pace'] = trailing(tw, 'team_abbr', 'plays')
        tw['tr_sack'] = trailing(tw, 'team_abbr', 'sack_rate_allowed')
        TS = {'proe': zstats(tw['proe']), 'pace': zstats(tw['plays']), 'sack': zstats(tw['sack_rate_allowed'])}
        for _, r in tw.iterrows():
            teamEnvZ[(r['team_abbr'], int(r['season']), int(r['week']))] = {
                'env_proe': zf(r['tr_proe'], TS['proe']),
                'env_pace': zf(r['tr_pace'], TS['pace']),
                'env_passblock': (lambda z: (None if z is None else round(-z, 4)))(zf(r['tr_sack'], TS['sack'])),  # invert: low sack rate = good protection
            }
    if not qw.empty:
        qw = qw.sort_values(['player_key', 'season', 'week'])
        for c in ['adot', 'deep_att_rate', 'deep_comp_pct', 'cpoe', 'attempts']: qw[c] = pd.to_numeric(qw.get(c), errors='coerce')
        qw['tr_adot'] = trailing(qw, 'player_key', 'adot')
        qw['tr_deep'] = trailing(qw, 'player_key', 'deep_comp_pct')   # DEEP-CONNECT: does he complete deep
        qw['tr_cpoe'] = trailing(qw, 'player_key', 'cpoe')
        QS = {'adot': zstats(qw['adot']), 'deep': zstats(qw['deep_comp_pct']), 'cpoe': zstats(qw['cpoe'])}
        for _, r in qw.iterrows():
            qbEnvZ[(r['player_key'], int(r['season']), int(r['week']))] = {
                'env_qb_adot': zf(r['tr_adot'], QS['adot']),
                'env_qb_deepconnect': zf(r['tr_deep'], QS['deep']),
                'env_qb_cpoe': zf(r['tr_cpoe'], QS['cpoe']),
            }
        # the week's starter per team = most attempts that week (his TRAILING metrics are used)
        if 'team_abbr' in qw.columns:
            idx = qw.dropna(subset=['team_abbr']).groupby(['team_abbr', 'season', 'week'])['attempts'].idxmax()
            for _, r in qw.loc[idx].iterrows():
                primaryQB[(r['team_abbr'], int(r['season']), int(r['week']))] = r['player_key']

    empty_env_team = {'env_proe': None, 'env_pace': None, 'env_passblock': None}
    empty_env_qb = {'env_qb_adot': None, 'env_qb_deepconnect': None, 'env_qb_cpoe': None}

    out = []
    for fam, col in PROP_COLS.items():
        yc = YARDS_COL[fam]; thr = MIN_TRAIL[fam]
        sub = pg[pg[col].notna()].copy()
        sub = sub[sub[yc].notna() & (sub[yc] >= thr)]   # real role in THIS family
        for _, r in sub.iterrows():
            # --- SKILL: family-appropriate volume floor (unchanged logic) ---
            if fam == 'receiving_yards':
                vf = _z(r.get('tr_tshare'), 0.14, 0.07)
                if vf is None: vf = _z(r.get('tr_rec'), 45, 30)
            elif fam == 'rushing_yards':
                vf = _z(r.get('tr_carries'), 12, 6)
                if vf is None: vf = _z(r.get('tr_rush'), 40, 30)
            else:
                vf = _z(r.get('tr_pass'), 230, 60)
            if vf is not None: vf = max(-3.0, min(3.0, vf))

            team = r.get('team_abbr'); season = int(r['season']); week = int(r['week'])
            envT = teamEnvZ.get((team, season, week), empty_env_team)
            env_qb_pid = r['player_key'] if fam == 'passing_yards' else primaryQB.get((team, season, week))
            envQ = qbEnvZ.get((env_qb_pid, season, week), empty_env_qb)

            feat = {
                # SKILL channel
                'volume_floor': _safe(vf),                                   # (kept key for back-compat)
                'recent_form': _safe(_z(r.get(yc), None, None)),            # trailing yards in family
                'skill_tshare': _safe(_z(r.get('tr_tshare'), 0.14, 0.07)) if fam == 'receiving_yards' else None,
                'skill_ays': _safe(_z(r.get('tr_ays'), 0.12, 0.09)) if fam == 'receiving_yards' else None,
                'skill_carry': _safe(_z(r.get('tr_carries'), 12, 6)) if fam == 'rushing_yards' else None,
                # ENVIRONMENT channel (team-rolling + QB-specific)
                'env_proe': envT['env_proe'], 'env_pace': envT['env_pace'], 'env_passblock': envT['env_passblock'],
                'env_qb_adot': envQ['env_qb_adot'], 'env_qb_deepconnect': envQ['env_qb_deepconnect'], 'env_qb_cpoe': envQ['env_qb_cpoe'],
                # MILESTONE channel
                'milestone_pull': milestone_pull(_safe(r.get('cum_' + fam)), _safe(r.get('games_left')), fam),
                # labels / diagnostics
                'trailing_yards': _safe(r.get(yc)),
                'outcome_yards': float(r[col]),
            }
            out.append({
                'player_key': r['player_key'], 'season': season, 'week': week, 'prop_type': fam,
                'as_of_kickoff': f"{season}-09-01T00:00:00Z",
                'volume_floor_score': _safe(vf),
                'line_softness': None,
                'feature_json': {k: (_safe(v) if not isinstance(v, str) else v) for k, v in feat.items()},
            })
    return pd.DataFrame(out)

def upsert(df):
    def clean(v, as_int=False):
        if v is None: return None
        if isinstance(v, dict): return {k: clean(x) for k, x in v.items()}
        try: f = float(v)
        except (TypeError, ValueError): return v
        if not math.isfinite(f): return None
        return int(round(f)) if as_int else f
    ints = {'season', 'week'}
    rows = df.where(pd.notna(df), None).to_dict('records')
    rows = [{k: (v if k == 'feature_json' else clean(v, k in ints)) if not isinstance(v, dict) else clean(v)
             for k, v in r.items()} for r in rows]
    for i in range(0, len(rows), 500):
        body = json.dumps(rows[i:i+500], allow_nan=False)
        r = requests.post(f"{SB}/rest/v1/nfl_feature_vectors?on_conflict=player_key,season,week,prop_type",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'}, data=body, timeout=60)
        print(f"  feature_vectors: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    df = build(a.seasons)
    print(f"built {len(df)} context-conditioned feature vectors across {len(a.seasons)} seasons")
    if a.dry_run:
        if len(df):
            import pprint; pprint.pprint(df.iloc[0]['feature_json'])
        raise SystemExit
    if len(df): upsert(df)
