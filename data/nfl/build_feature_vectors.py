#!/usr/bin/env python3
"""
Lyrid NFL — feature-vector precompute (the comp POOL).

This is the depth half of the "both" design. It turns every historical
player-game into a standardized feature vector + the realized yardage outcome,
and writes them to nfl_feature_vectors. The live slate endpoint then runs kNN
against this pool. Bigger + richer pool = better neighbors = sharper P(over) =
more edge, so we build the fullest pool the loaded data supports.

LEAKAGE GUARD: every feature for (player, season, week) is computed from data
available BEFORE that week's kickoff — trailing aggregates only, never the game
itself. as_of_kickoff records the cutoff.

Reads: nfl_player_games (+ the aggregate tables already loaded).
Writes: nfl_feature_vectors (feature_json holds the packed kNN vector).
"""
import argparse, os, json, math
import pandas as pd, numpy as np, requests

SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
NV = "https://github.com/nflverse/nflverse-data/releases/download"

PROP_COLS = {
    'passing_yards': 'passing_yards',
    'rushing_yards': 'rushing_yards',
    'receiving_yards': 'receiving_yards',
}

def fetch_player_games():
    """Pull loaded player-games back from Supabase (paged)."""
    rows, start = [], 0
    while True:
        r = requests.get(f"{SB}/rest/v1/nfl_player_games",
                         headers={**H, 'Range-Unit': 'items', 'Range': f'{start}-{start+999}'},
                         params={'select': '*'}, timeout=60)
        b = r.json()
        if not b: break
        rows += b
        if len(b) < 1000: break
        start += 1000
    return pd.DataFrame(rows)

def trailing(df, col, n=6):
    """Leakage-safe trailing mean: shift(1) so the current week is excluded."""
    return df.groupby('player_key')[col].transform(
        lambda s: s.shift(1).rolling(n, min_periods=2).mean())

def build(seasons):
    pg = fetch_player_games()
    if pg.empty:
        print("  no player_games in DB — run ingest_nflverse.py first"); return pd.DataFrame()
    pg = pg[pg.season.isin(seasons)].copy()
    pg = pg.sort_values(['player_key', 'season', 'week'])
    for num in ['passing_yards','rushing_yards','receiving_yards','targets','carries',
                'target_share','air_yards_share']:
        if num in pg.columns: pg[num] = pd.to_numeric(pg[num], errors='coerce')

    # trailing (pre-kickoff) volume + form signals
    pg['tr_targets'] = trailing(pg, 'targets') if 'targets' in pg else np.nan
    pg['tr_tshare'] = trailing(pg, 'target_share') if 'target_share' in pg else np.nan
    pg['tr_rec'] = trailing(pg, 'receiving_yards')
    pg['tr_rush'] = trailing(pg, 'rushing_yards')
    pg['tr_pass'] = trailing(pg, 'passing_yards')
    pg['tr_carries'] = trailing(pg, 'carries') if 'carries' in pg else np.nan

    out = []
    # explicit per-family column maps — no string-slicing that silently misses
    # (the old fam.split()[:4] produced 'rece' and missed tr_rec entirely).
    YARDS_COL = {'receiving_yards': 'tr_rec', 'rushing_yards': 'tr_rush', 'passing_yards': 'tr_pass'}
    for fam, col in PROP_COLS.items():
        sub = pg[pg[col].notna()].copy()
        yc = YARDS_COL[fam]
        sub = sub[sub[yc].notna()]  # player had a real trailing role in THIS family
        for _, r in sub.iterrows():
            # volume floor: family-appropriate, clamped so a thin sample can't
            # produce an impossible score like -3.83.
            if fam == 'receiving_yards':
                vf = _z(r.get('tr_tshare'), 0.14, 0.07)
            elif fam == 'rushing_yards':
                vf = _z(r.get('tr_carries'), 12, 6)
            else:
                vf = _z(r.get('tr_pass'), 230, 60)
            if vf is not None:
                vf = max(-3.0, min(3.0, vf))
            feat = {
                'volume_floor': vf,
                'recent_form': _z(r.get(yc), None, None),  # trailing yards in THIS family
                'trailing_yards': r.get(yc),               # outcome basis, same family
            }
            outcome = float(r[col])
            out.append({
                'player_key': r['player_key'], 'season': int(r['season']), 'week': int(r['week']),
                'prop_type': fam,
                'as_of_kickoff': f"{int(r['season'])}-09-01T00:00:00Z",  # coarse; refined by ingest later
                'volume_floor_score': _safe(feat['volume_floor']),
                'line_softness': None,
                'feature_json': {k: _safe(v) for k, v in feat.items()},
            })
    return pd.DataFrame(out)

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
    rows = [{k: (v if k == 'feature_json' else clean(v, k in ints)) if not isinstance(v, dict)
             else clean(v) for k, v in r.items()} for r in rows]
    for i in range(0, len(rows), 500):
        body = json.dumps(rows[i:i+500], allow_nan=False)
        r = requests.post(f"{SB}/rest/v1/nfl_feature_vectors?on_conflict=player_key,season,week,prop_type",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=body, timeout=60)
        print(f"  feature_vectors: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    df = build(a.seasons)
    print(f"built {len(df)} feature vectors across {len(a.seasons)} seasons")
    if a.dry_run:
        print(df.head(8).to_string()); raise SystemExit
    if len(df): upsert(df)
