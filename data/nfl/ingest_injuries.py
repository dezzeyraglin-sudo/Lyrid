#!/usr/bin/env python3
"""
Lyrid NFL — INJURY ingest (server-readable injury table).

ESPN's league injury report is blocked (403) from Vercel's datacenter IP, but it reads fine
from a residential/GitHub runner. So we fetch it HERE (your machine or a GitHub Action) and
upsert to nfl_injuries; the slate then reads injuries from Supabase, server-side, where the
analysis runs — so injuries reach BOTH the total and the props (and get logged), instead of
the client-side workaround that can't touch the prop engine.

Run this whenever you refresh the slate (or on a game-day cron). It's one ESPN call.

Reads: ESPN /nfl/injuries. Writes: nfl_injuries (current snapshot, DDL footer).
"""
import os, json, re, subprocess, requests

SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries'
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json'}

# ESPN team displayName -> abbreviation (matches the abbrs used across the pipeline; LA/WAS per nflverse)
TEAM_ABBR = {
    'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL', 'Buffalo Bills': 'BUF',
    'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI', 'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE',
    'Dallas Cowboys': 'DAL', 'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
    'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX', 'Kansas City Chiefs': 'KC',
    'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC', 'Los Angeles Rams': 'LA', 'Miami Dolphins': 'MIA',
    'Minnesota Vikings': 'MIN', 'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
    'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT', 'San Francisco 49ers': 'SF',
    'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB', 'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
}
OUT = {'out', 'inactive', 'injured reserve', 'ir', 'suspended', 'suspension', 'did not play'}
DOUBT = {'doubtful', 'questionable'}

def norm_name(s):
    s = str(s or '').lower()
    s = re.sub(r"[.'`]", '', s)
    s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    s = re.sub(r'[^a-z ]', '', s)
    return re.sub(r'\s+', ' ', s).strip()

def fetch():
    # ESPN fingerprints Python's requests library and 403s it even from a residential IP,
    # but curl (and browsers) pass. Shell out to curl for the ESPN fetch; Supabase writes
    # below still use requests (Supabase has no such bot protection).
    try:
        r = requests.get(ESPN, headers=UA, timeout=30)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    out = subprocess.run(
        ['curl', '-s', '--max-time', '30', '-H', 'User-Agent: ' + UA['User-Agent'],
         '-H', 'Accept: application/json', ESPN],
        capture_output=True, text=True, timeout=40)
    if out.returncode != 0 or not out.stdout.strip():
        raise RuntimeError(f'ESPN fetch failed (curl rc={out.returncode}): {(out.stderr or "")[:200]}')
    return json.loads(out.stdout)

def rows_from(data):
    out = []
    for block in (data.get('injuries') or []):
        team = TEAM_ABBR.get(block.get('displayName'))
        for e in (block.get('injuries') or []):
            ath = e.get('athlete') or {}
            name = ath.get('displayName')
            if not name:
                continue
            st = str(e.get('status') or '').strip().lower()
            status = 'out' if st in OUT else ('doubtful' if st in DOUBT else 'active')
            detail = None
            det = e.get('details') or {}
            if isinstance(det, dict):
                detail = det.get('type') or det.get('detail')
            out.append({
                'player_key': norm_name(name),
                'player_name': name,
                'team_abbr': team,
                'position': (ath.get('position') or {}).get('abbreviation') if isinstance(ath.get('position'), dict) else ath.get('position'),
                'status': status,
                'status_raw': e.get('status'),
                'detail': detail,
                'blurb': e.get('shortComment') or e.get('longComment'),
            })
    # de-dup by player_key, keeping the most severe
    sev = {'out': 2, 'doubtful': 1, 'active': 0}
    best = {}
    for r in out:
        p = best.get(r['player_key'])
        if not p or sev[r['status']] > sev[p['status']] or (sev[r['status']] == sev[p['status']] and r['blurb'] and not p['blurb']):
            best[r['player_key']] = r
    return list(best.values())

def upsert(rows):
    if not rows:
        print("  nfl_injuries: 0 rows"); return
    # replace the snapshot: clear then insert (current-state table)
    requests.delete(f"{SB}/rest/v1/nfl_injuries?player_key=neq.__none__", headers={**H, 'Prefer': 'return=minimal'}, timeout=30)
    for i in range(0, len(rows), 500):
        r = requests.post(f"{SB}/rest/v1/nfl_injuries?on_conflict=player_key",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=json.dumps(rows[i:i+500], allow_nan=False), timeout=60)
        print(f"  nfl_injuries: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    data = fetch()
    rows = rows_from(data)
    counts = {}
    for r in rows: counts[r['status']] = counts.get(r['status'], 0) + 1
    print(f"fetched {len(rows)} injury records — {counts}")
    if a.dry_run:
        for r in sorted(rows, key=lambda x: x['status'])[:20]:
            print(f"  {r['status']:9} {r['player_name']:22} {r['team_abbr'] or '?':4} {r['position'] or '?':4} {r['detail'] or ''}")
        raise SystemExit
    upsert(rows)

# SCHEMA ADDITION:
# create table if not exists nfl_injuries (
#   player_key text primary key, player_name text, team_abbr text, position text,
#   status text, status_raw text, detail text, blurb text,
#   updated_at timestamptz default now()
# );
