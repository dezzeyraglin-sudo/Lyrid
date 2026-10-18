#!/usr/bin/env python3
"""
One-time: upload the browser's NFL history (from a Lyrid backup file) into Supabase nfl_prop_log.

    python3 data/nfl/migrate_history_to_supabase.py ~/Downloads/lyrid-full-backup-2026-10-05.json \
        --patch ~/Downloads/lyrid-nfl-cleanup-patch-2026-10-08.json

--patch applies the cleanup marks (placeholder / discounted lines excluded) before uploading.
Rows already in Supabase are left alone (the server's own log wins), so it's safe to re-run.
"""
import os, sys, json, argparse
import requests

def load_env():
    if os.environ.get('SUPABASE_URL') and os.environ.get('SUPABASE_SERVICE_KEY'): return
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(p):
        for line in open(p):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.strip().split('=', 1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('backup'); ap.add_argument('--patch'); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(); load_env()
    SB = os.environ.get('SUPABASE_URL', '').rstrip('/'); KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
    if not (SB and KEY): print("no Supabase credentials (data/nfl/.env)"); return 1
    d = json.load(open(os.path.expanduser(a.backup)))
    props = d.get('nflPropHistory') or {}; totals = d.get('nflTotalsHistory') or {}
    if a.patch:
        p = json.load(open(os.path.expanduser(a.patch)))
        for dt, es in (p.get('nflPropHistory') or {}).items():
            props.setdefault(dt, {}).update(es)
    rows = []
    for dt, day in props.items():
        if not isinstance(day, dict): continue
        for k, e in day.items():
            if isinstance(e, dict) and e.get('propType'):
                rows.append({'kind': 'prop', 'log_date': dt, 'log_key': k, 'prop_type': e['propType'],
                             'graded': bool(e.get('graded')), 'result': e.get('result'), 'entry': e})
    for dt, day in totals.items():
        if not isinstance(day, dict): continue
        for k, e in day.items():
            if isinstance(e, dict):
                rows.append({'kind': 'total', 'log_date': dt, 'log_key': k, 'prop_type': 'game_total',
                             'graded': bool(e.get('graded')), 'result': e.get('result'), 'entry': e})
    ex = sum(1 for r in rows if r['entry'].get('excluded'))
    print(f"{len(rows)} rows ({sum(1 for r in rows if r['kind']=='prop')} props, {sum(1 for r in rows if r['kind']=='total')} totals), "
          f"{sum(1 for r in rows if r['graded'])} graded, {ex} marked excluded")
    if a.dry_run: return 0
    H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=minimal'}
    for i in range(0, len(rows), 500):
        r = requests.post(f"{SB}/rest/v1/nfl_prop_log?on_conflict=kind,log_date,log_key", headers=H,
                          data=json.dumps(rows[i:i + 500], allow_nan=False, default=str), timeout=60)
        print(f"  uploaded {min(i + 500, len(rows))}/{len(rows)}: {r.status_code}")
        if r.status_code >= 300: print("   ", r.text[:300]); return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
