#!/usr/bin/env python3
"""
Lyrid NFL — data diagnostics in ONE command (no re-exporting env vars, no hand-built curls).

Loads Supabase creds from data/nfl/.env (or repo .env, or the environment) so a fresh
terminal Just Works. Answers the questions we keep running by hand:

  python3 data/nfl/diagnose_nfl.py                         # overall health: table + vector counts
  python3 data/nfl/diagnose_nfl.py --player "James Cook"   # is he in the data? does he have vectors?
  python3 data/nfl/diagnose_nfl.py --player "James Cook" "Bucky Irving" "Josh Allen"

The player check is the "baseline pending" decoder: it resolves the name -> player_key in
nfl_player_games, then counts that key's feature vectors per family and tells you plainly:
  * not in player_games        -> ingest/name issue
  * in player_games, 0 vectors -> feature-build GAP (rebuild)
  * has vectors                -> slate-side resolution bug (name->key lookup at analysis time)

Uses requests to Supabase (no ESPN 403 issue — that was only ESPN's endpoint).
"""
import os, sys, json, argparse, urllib.parse
import requests

FAMILIES = ['passing_yards', 'rushing_yards', 'receiving_yards', 'pass_rush_yards', 'rush_rec_yards']
TABLES = ['nfl_player_games', 'nfl_feature_vectors', 'nfl_team_scoring', 'nfl_defender_impact',
          'nfl_injuries', 'nfl_team_week_env', 'nfl_qb_week_env', 'nfl_env_norms',
          'nfl_defense_suppression']

def load_env():
    """Load SUPABASE_URL/KEY from environment, else from data/nfl/.env or repo-root .env."""
    url, key = os.environ.get('SUPABASE_URL'), os.environ.get('SUPABASE_SERVICE_KEY')
    if url and key:
        return url.rstrip('/'), key, 'environment'
    here = os.path.dirname(os.path.abspath(__file__))
    for path in [os.path.join(here, '.env'), os.path.join(here, '..', '..', '.env')]:
        if os.path.exists(path):
            vals = {}
            for line in open(path):
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
            url = url or vals.get('SUPABASE_URL')
            key = key or vals.get('SUPABASE_SERVICE_KEY')
            if url and key:
                return url.rstrip('/'), key, path
    return None, None, None

SB, KEY, SRC = load_env()
if not SB or not KEY:
    print("!! No Supabase creds found. Set them once so every run works:\n"
          "   echo 'SUPABASE_URL=https://xtldczxlibdkwqvgmnob.supabase.co' >  data/nfl/.env\n"
          "   echo 'SUPABASE_SERVICE_KEY=your_service_key'                  >> data/nfl/.env\n"
          "   (add data/nfl/.env to .gitignore)")
    sys.exit(1)
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}'}

def count(table, query=''):
    """Exact row count via Content-Range, without pulling the rows."""
    url = f"{SB}/rest/v1/{table}?select=id{('&' + query) if query else ''}"
    try:
        r = requests.get(url, headers={**H, 'Prefer': 'count=exact', 'Range': '0-0', 'Range-Unit': 'items'}, timeout=30)
        cr = r.headers.get('Content-Range', '')
        if '/' in cr:
            tot = cr.split('/')[-1]
            return int(tot) if tot.isdigit() else 0
        # fallback: some tables lack an id column — select * and page-count
        r2 = requests.get(f"{SB}/rest/v1/{table}?select=*{('&' + query) if query else ''}",
                          headers={**H, 'Prefer': 'count=exact', 'Range': '0-0'}, timeout=30)
        cr2 = r2.headers.get('Content-Range', '')
        return int(cr2.split('/')[-1]) if '/' in cr2 and cr2.split('/')[-1].isdigit() else 0
    except Exception as e:
        return f'ERR {e}'

def get(table, query, select='*'):
    r = requests.get(f"{SB}/rest/v1/{table}?select={select}&{query}", headers=H, timeout=30)
    try:
        return r.json()
    except Exception:
        return []

def health():
    print(f"creds: loaded from {SRC}\n")
    print("=== table row counts ===")
    for t in TABLES:
        print(f"  {t:26} {count(t)}")
    print("\n=== feature vectors by family ===")
    for fam in FAMILIES:
        print(f"  {fam:18} {count('nfl_feature_vectors', f'prop_type=eq.{fam}')}")
    print("\n=== env_norms (need 6) + injuries by status ===")
    norms = get('nfl_env_norms', 'order=metric', 'metric,mean,sd')
    print("  norms:", ', '.join(r['metric'] for r in norms) if isinstance(norms, list) else norms)
    for st in ['out', 'doubtful', 'active']:
        print(f"  injuries {st:9} {count('nfl_injuries', f'status=eq.{st}')}")

def player(name):
    enc = urllib.parse.quote(name)
    rows = get('nfl_player_games', f'player_name=eq.{enc}', 'player_name,player_key,team_abbr,position')
    print(f"\n=== {name} ===")
    if not isinstance(rows, list) or not rows:
        print("  NOT in nfl_player_games -> ingest/name issue (PP name may differ, suffix, or 2nd player)")
        return
    keys = {}
    for r in rows:
        keys.setdefault(r['player_key'], r)
    for k, meta in keys.items():
        print(f"  player_key {k}  ({meta.get('team_abbr')}, {meta.get('position')})")
        vecs = get('nfl_feature_vectors', f'player_key=eq.{k}', 'season,prop_type')
        if not isinstance(vecs, list) or not vecs:
            print("    0 feature vectors  -> BUILD GAP (rebuild build_feature_vectors)  [would show 'baseline pending']")
            continue
        byfam = {}
        for v in vecs:
            byfam.setdefault(v['prop_type'], set()).add(v.get('season'))
        for fam in FAMILIES:
            if fam in byfam:
                yrs = sorted(str(s) for s in byfam[fam])
                print(f"    {fam:18} {len(byfam[fam])} seasons ({', '.join(yrs)})")
        missing = [f for f in FAMILIES if f not in byfam]
        if missing:
            print(f"    (no vectors for: {', '.join(missing)} — pending only if the prop is one of these)")
        print("    -> has vectors: if the app still says 'baseline pending', it's a SLATE name->key resolution bug")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--player', nargs='+', help='one or more player names to diagnose')
    a = ap.parse_args()
    if a.player:
        for nm in a.player:
            player(nm)
    else:
        health()
