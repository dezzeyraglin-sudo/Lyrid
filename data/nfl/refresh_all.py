#!/usr/bin/env python3
"""
Lyrid NFL — ONE command to refresh every data table, in the right order, with the right arguments.

    python3 data/nfl/refresh_all.py                 # everything
    python3 data/nfl/refresh_all.py --only recency  # game-day builds (injuries, form, pace, ...)
    python3 data/nfl/refresh_all.py --only season   # weekly builds (games -> env -> feature vectors -> tiers)
    python3 data/nfl/refresh_all.py --list          # show the plan without running anything

Why this exists: the builds have to run in a specific order (player games before env history before
feature vectors) with specific seasons (feature vectors need LAST season too, for 6-game baselines).
Running them by hand is how the engine sat on 2025 data for four weeks. This file is the single
source of truth — the GitHub Action calls it too, so local and automated runs can't drift apart.

- Loads SUPABASE_URL / SUPABASE_SERVICE_KEY from data/nfl/.env if they aren't already set.
- Works out the current NFL season itself (Jan-Feb belong to the prior season).
- Passes arguments explicitly, so it works with old and new versions of every build script.
- A failed step doesn't stop the rest; you get one summary at the end. Exit code 1 if a REQUIRED
  step failed (optional steps — tables you may not have created yet — only warn).
"""
import os, re, sys, time, argparse, datetime, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

def season():
    d = datetime.date.today()
    return d.year if d.month >= 3 else d.year - 1

def load_env():
    if os.environ.get('SUPABASE_URL') and os.environ.get('SUPABASE_SERVICE_KEY'):
        return 'environment'
    path = os.path.join(HERE, '.env')
    if not os.path.exists(path):
        return None
    for line in open(path):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return path

def plan(y):
    Y, P, PP = str(y), str(y - 1), str(y - 2)
    # (group, script, args, required)  — order matters within each group
    return [
        # ---- RECENCY: changes within a week; run before each slate ----
        ('recency', 'ingest_injuries.py',         [],                                   True),
        ('recency', 'build_qb_form.py',           ['--window', '8', '--min-games', '4'], True),
        ('recency', 'build_defense_form.py',      ['--window', '4'],                    True),
        ('recency', 'build_defense_pace.py',      [],                                   True),
        ('recency', 'build_defense_vs_pos.py',    [],                                   True),
        # ---- SEASON: rebuild after each week's games are final ----
        # projection inputs — ORDER MATTERS: games -> env -> feature vectors
        ('season',  'ingest_nflverse.py',         ['--seasons', Y],                     True),
        ('season',  'build_env_history.py',       ['--seasons', Y],                     True),
        ('season',  'build_feature_vectors.py',   ['--seasons', P, Y],                  True),   # prior season too: 6-game baselines
        # defense / team tiers
        ('season',  'build_defense_suppression.py', ['--seasons', Y],                   True),
        ('season',  'build_pressure_profiles.py', ['--seasons', Y],                     True),
        ('season',  'build_coverage_by_position.py', ['--seasons', Y],                  True),
        ('season',  'build_team_scoring.py',      ['--seasons', Y],                     True),
        ('season',  'build_team_tendencies.py',   ['--seasons', Y],                     True),
        ('season',  'build_matchup_history.py',   ['--seasons', PP, P, Y],              True),
        # the matchup report on every prop: team offense / OL / DL / secondary / corners + player profiles
        ('season',  'build_matchup_profiles.py',  [],                                   True),
        # matchup context for the card — optional until their tables are created
        ('season',  'build_defense_vs_role.py',   [],                                   False),
        ('season',  'build_directional_matchup.py', [],                                 False),
    ]

def main():
    ap = argparse.ArgumentParser(description='Refresh every Lyrid NFL data table in order.')
    ap.add_argument('--only', choices=['all', 'recency', 'season'], default='all')
    ap.add_argument('--list', action='store_true', help='show the plan and exit')
    a = ap.parse_args()

    y = season()
    steps = [s for s in plan(y) if a.only == 'all' or s[0] == a.only]
    if a.list:
        print(f"NFL season {y} — {len(steps)} steps ({a.only}):")
        for i, (g, sc, args, req) in enumerate(steps, 1):
            print(f"  {i:2}. [{g}] {sc} {' '.join(args)}{'' if req else '   (optional)'}")
        return 0

    src = load_env()
    if not src:
        print("No Supabase credentials: set SUPABASE_URL / SUPABASE_SERVICE_KEY or add data/nfl/.env"); return 1
    print(f"Lyrid NFL refresh — season {y}, {len(steps)} steps ({a.only}); credentials from {src}\n")

    results = []
    for i, (g, sc, args, req) in enumerate(steps, 1):
        path = os.path.join(HERE, sc)
        label = f"{i:2}/{len(steps)} {sc} {' '.join(args)}".rstrip()
        if not os.path.exists(path):
            print(f"  SKIP  {label}  (script not in data/nfl/)"); results.append((sc, 'missing', req)); continue
        t0 = time.time()
        p = subprocess.run([sys.executable, path, *args], capture_output=True, text=True)
        out = (p.stdout + p.stderr).strip().splitlines()
        # a build "fails" on a nonzero exit OR an HTTP error code printed by its upsert (4xx/5xx)
        bad_http = [l for l in out if re.search(r':\s(4\d\d|5\d\d)\s\(', l)]   # upserts print 'table: 400 (32 rows)'
        ok = p.returncode == 0 and not bad_http
        print(f"  {'OK  ' if ok else ('WARN' if not req else 'FAIL')}  {label}  ({time.time() - t0:.0f}s)")
        if not ok:
            tail = [l for l in out if 'NotOpenSSLWarning' not in l and 'warnings.warn' not in l][-4:]
            for l in tail: print(f"          {l[:160]}")
        results.append((sc, 'ok' if ok else 'failed', req))

    failed_req = [s for s, st, req in results if st == 'failed' and req]
    failed_opt = [s for s, st, req in results if st == 'failed' and not req]
    missing = [s for s, st, req in results if st == 'missing']
    print(f"\nDone: {sum(1 for _, st, _ in results if st == 'ok')}/{len(results)} OK"
          + (f" | FAILED: {', '.join(failed_req)}" if failed_req else '')
          + (f" | optional failed: {', '.join(failed_opt)}" if failed_opt else '')
          + (f" | not found: {', '.join(missing)}" if missing else ''))
    return 1 if failed_req else 0

if __name__ == '__main__':
    sys.exit(main())
