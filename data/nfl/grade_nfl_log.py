#!/usr/bin/env python3
"""
Lyrid NFL — grade the shared history in Supabase (nfl_prop_log). Replaces browser-side grading.

For every ungraded row dated before today:
  prop   find the player's team game on/after the slate date; once final, take his stat line from
         nflverse weekly stats. Win/loss/push by the logged lean. Box score posted but he isn't in it
         -> 'dnp' (graded, excluded from records). Not final / stats not posted yet -> retried next run.
  total  final score (home + away) vs the logged lean.
Run by refresh_all.py (both groups), so the GitHub Action grades automatically.
    python3 data/nfl/grade_nfl_log.py            # grade
    python3 data/nfl/grade_nfl_log.py --dry-run  # show what would be graded
"""
import os, re, sys, json, argparse, datetime
import pandas as pd, requests

NV = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
TO_NV = {'LAR': 'LA', 'WSH': 'WAS', 'JAC': 'JAX', 'OAK': 'LV', 'SD': 'LAC', 'STL': 'LA'}
STAT = {'passing_yards': ['passing_yards'], 'rushing_yards': ['rushing_yards'], 'receiving_yards': ['receiving_yards'],
        'rush_rec_yards': ['rushing_yards', 'receiving_yards'], 'pass_rush_yards': ['passing_yards', 'rushing_yards']}

def norm(s):
    s = str(s or '').lower(); s = re.sub(r"[.'`]", '', s); s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    s = re.sub(r'[^a-z ]', '', s); return re.sub(r'\s+', ' ', s).strip()

def season_of(d):
    return d.year if d.month >= 3 else d.year - 1

def fetch_ungraded(today):
    out, off = [], 0
    while True:
        r = requests.get(f"{SB}/rest/v1/nfl_prop_log?graded=eq.false&log_date=lt.{today}&select=kind,log_date,log_key,prop_type,entry"
                         f"&order=log_date.asc&limit=1000&offset={off}", headers=H, timeout=60)
        r.raise_for_status(); chunk = r.json(); out += chunk
        if len(chunk) < 1000: return out
        off += 1000

def load_season(y):
    g = pd.read_parquet(f"{NV}/pbp/play_by_play_{y}.parquet", columns=['game_id', 'season_type', 'week', 'game_date', 'home_team', 'away_team', 'home_score', 'away_score'])
    g = g[g.season_type == 'REG'].drop_duplicates('game_id').copy(); g['game_date'] = pd.to_datetime(g.game_date).dt.date
    W = pd.read_parquet(f"{NV}/stats_player/stats_player_week_{y}.parquet"); W = W[W.season_type == 'REG'].copy()
    for c in ['passing_yards', 'rushing_yards', 'receiving_yards']: W[c] = pd.to_numeric(W[c], errors='coerce').fillna(0)
    W['key'] = W.player_display_name.map(norm)
    return g, W

def game_for(G, team, d):
    """The team's game on or within 6 days after the slate date."""
    t = TO_NV.get(team, team)
    m = G[((G.home_team == t) | (G.away_team == t)) & (G.game_date >= d) & (G.game_date <= d + datetime.timedelta(days=6))]
    return m.sort_values('game_date').iloc[0] if len(m) else None

def grade(rows, today):
    data, graded, skipped = {}, [], {'not final': 0, 'no stats yet': 0, 'not played yet': 0}
    for row in rows:
        d = datetime.date.fromisoformat(row['log_date']); y = season_of(d)
        if y not in data: data[y] = load_season(y)
        G, W = data[y]; e = dict(row['entry'])
        if row['kind'] == 'total':
            g = game_for(G, e.get('home'), d)
            if g is None: skipped['not played yet'] += 1; continue
            if pd.isna(g.home_score) or g.game_date >= today: skipped['not final'] += 1; continue
            actual = float(g.home_score + g.away_score)
        else:
            g = game_for(G, e.get('team'), d)
            if g is None: skipped['not played yet'] += 1; continue
            if pd.isna(g.home_score) or g.game_date >= today: skipped['not final'] += 1; continue
            t = TO_NV.get(e.get('team'), e.get('team'))
            wk = W[(W.week == g.week) & (W.team == t)]
            if wk.empty: skipped['no stats yet'] += 1; continue
            me = wk[wk.key == norm(e.get('player'))]
            if me.empty:
                e.update({'actual': None, 'result': 'dnp', 'error': None, 'graded': True, 'gradedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
                graded.append({**row, 'graded': True, 'result': 'dnp', 'entry': e}); continue
            actual = float(me[STAT[row['prop_type']]].sum(axis=1).iloc[0])
        line, lean = e.get('line'), e.get('lean')
        if line is None or lean not in ('OVER', 'UNDER'): result = None
        elif actual == float(line): result = 'push'
        else: result = 'win' if ((actual > float(line)) == (lean == 'OVER')) else 'loss'
        proj = e.get('projection') if row['kind'] == 'prop' else e.get('projected')
        e.update({'actual': actual, 'result': result, 'error': round(float(proj) - actual, 1) if proj is not None else None,
                  'graded': True, 'gradedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        graded.append({**row, 'graded': True, 'result': result, 'entry': e})
    return graded, skipped

def write(graded):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    body = [{'kind': g['kind'], 'log_date': g['log_date'], 'log_key': g['log_key'], 'prop_type': g['prop_type'],
             'graded': True, 'result': g['result'], 'entry': g['entry'], 'updated_at': now} for g in graded]
    for i in range(0, len(body), 500):
        r = requests.post(f"{SB}/rest/v1/nfl_prop_log?on_conflict=kind,log_date,log_key",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=json.dumps(body[i:i + 500], allow_nan=False), timeout=60)
        print(f"  nfl_prop_log graded: {r.status_code} ({min(i + 500, len(body))}/{len(body)})")
        if r.status_code >= 300: print("   ", r.text[:200]); sys.exit(1)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    today = datetime.date.today()
    rows = fetch_ungraded(today.isoformat())
    print(f"ungraded rows dated before {today}: {len(rows)}")
    if not rows: sys.exit(0)
    graded, skipped = grade(rows, today)
    res = pd.Series([g['result'] for g in graded]).value_counts().to_dict() if graded else {}
    print(f"gradable now: {len(graded)} {res} | waiting: {skipped}")
    if a.dry_run or not graded: sys.exit(0)
    write(graded)
