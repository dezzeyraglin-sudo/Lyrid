#!/usr/bin/env python3
"""
Lyrid NFL — DEFENSE-ARCHETYPE matchup history (the honest 'player vs the defense' signal).

The trap this avoids: "Brissett is 1/5 to the over vs the Seahawks" is 3-5 games of NOISE against
changing personnel — the 2020 Seahawks D shares almost nobody with the 2026 one. Team-NAME splits
are coincidences that look like patterns. This computes team-TYPE splits instead: how a player does
against a KIND of defense (top pass D, heavy blitz, stout run D). A player faces many defenses of
each type over a career, so the sample is large AND the archetype is stable year to year — a real
signal, where the team-name split is not.

Method:
  1. Grade every DEFENSE per season into archetype buckets, from data you already have:
       pass_d:  nfl_defense_suppression (pass EPA/yards allowed)  -> elite / avg / soft
       run_d:   nfl_defense_suppression (rush EPA/ypc allowed)    -> stout / avg / soft
       rush_d:  nfl_team_pressure (pressure_rate)                 -> high / avg / low
  2. For each player-game (weekly logs), look up the OPPONENT's archetype that season, and bucket
     the player's yardage output for his family.
  3. Aggregate per (player, family, archetype axis, bucket): games, mean yards, and a delta vs the
     player's OWN overall mean (so it's 'how much better/worse than his baseline vs this type').

Output: nfl_matchup_history — per player/family/axis/bucket. The engine reads it as a NUDGE
(a player who genuinely fades vs elite pass D gets shaded there), gated on a minimum game count
so a 2-game bucket never moves anything. Provisional until the graded record validates the nudge.

Reads: nflverse player_stats(weekly) + your Supabase defense tables. Writes: nfl_matchup_history.
"""
import os, sys, json, argparse
import pandas as pd, numpy as np, requests

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
SB = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}
MIN_GAMES = 4   # a bucket needs >=4 games before it's trustworthy (else it's team-name-split noise)

FAM_COL = {'passing_yards': 'passing_yards', 'rushing_yards': 'rushing_yards', 'receiving_yards': 'receiving_yards'}
POS_FAM = {'QB': ['passing_yards'], 'RB': ['rushing_yards', 'receiving_yards'],
           'WR': ['receiving_yards'], 'TE': ['receiving_yards'], 'FB': ['rushing_yards', 'receiving_yards']}

def norm(s):
    import re
    s = str(s or '').lower(); s = re.sub(r"[.'`]", '', s); s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    s = re.sub(r'[^a-z ]', '', s); return re.sub(r'\s+', ' ', s).strip()

def sb_get(table, select='*'):
    try:
        r = requests.get(f"{SB}/rest/v1/{table}?select={select}", headers=H, timeout=60)
        return r.json() if r.status_code < 300 else []
    except Exception:
        return []

def defense_archetypes(seasons):
    """team+season -> {pass_d, run_d, rush_pressure} bucket labels, from your defense tables."""
    supp = pd.DataFrame(sb_get('nfl_defense_suppression',
              'team_abbr,season,pass_epa_allowed,rush_epa_allowed,ypc_allowed,pass_success_allowed,rush_success_allowed'))
    press = pd.DataFrame(sb_get('nfl_team_pressure', 'team_abbr,season,pressure_rate'))
    arch = {}
    if len(supp):
        supp = supp[supp['season'].isin(seasons)]
        for season, g in supp.groupby('season'):
            def bucket(col, lo_is_good, labels):
                v = pd.to_numeric(g[col], errors='coerce'); q1, q2 = v.quantile(0.33), v.quantile(0.67)
                out = {}
                for _, row in g.iterrows():
                    x = row[col]
                    if pd.isna(x): out[row['team_abbr']] = 'avg'; continue
                    lvl = 'lo' if x <= q1 else ('hi' if x >= q2 else 'avg')
                    # lo_is_good: low value = strong defense
                    out[row['team_abbr']] = labels[('strong' if lvl == 'lo' else ('soft' if lvl == 'hi' else 'avg'))] if lo_is_good \
                        else labels[('soft' if lvl == 'lo' else ('strong' if lvl == 'hi' else 'avg'))]
                return out
            pd_lab = bucket('pass_epa_allowed', True, {'strong': 'elite_pass_d', 'avg': 'avg_pass_d', 'soft': 'soft_pass_d'})
            rd_lab = bucket('rush_epa_allowed', True, {'strong': 'stout_run_d', 'avg': 'avg_run_d', 'soft': 'soft_run_d'})
            for tm in g['team_abbr']:
                arch.setdefault((tm, season), {})['pass_d'] = pd_lab.get(tm, 'avg_pass_d')
                arch[(tm, season)]['run_d'] = rd_lab.get(tm, 'avg_run_d')
    if len(press):
        press = press[press['season'].isin(seasons)]
        for season, g in press.groupby('season'):
            v = pd.to_numeric(g['pressure_rate'], errors='coerce'); q1, q2 = v.quantile(0.33), v.quantile(0.67)
            for _, row in g.iterrows():
                x = row['pressure_rate']
                lab = 'avg_rush' if pd.isna(x) else ('low_rush' if x <= q1 else ('high_rush' if x >= q2 else 'avg_rush'))
                arch.setdefault((row['team_abbr'], season), {})['rush_pressure'] = lab
    return arch

# which archetype axis matters for which family
FAM_AXIS = {'passing_yards': ['pass_d', 'rush_pressure'], 'receiving_yards': ['pass_d', 'rush_pressure'],
            'rushing_yards': ['run_d']}

def build(seasons):
    arch = defense_archetypes(seasons)
    if not arch:
        print("no defense archetypes (are nfl_defense_suppression / nfl_team_pressure populated?)"); return pd.DataFrame()
    # current-season weekly stats are in year-suffixed files; the un-suffixed one lags (stops ~2yrs back)
    frames = []
    for s in seasons:
        try: frames.append(pd.read_parquet(f"{NFLVERSE}/stats_player/stats_player_week_{s}.parquet"))
        except Exception: continue
    if not frames:
        print("no weekly player stats for", seasons); return pd.DataFrame()
    logs = pd.concat(frames, ignore_index=True)
    logs = logs[(logs.get('season_type', 'REG') == 'REG') & (logs['season'].isin(seasons))]
    rows = []
    for pid, g in logs.groupby('player_id'):
        pos = str(g['position'].iloc[-1]).upper()
        name = g['player_display_name'].iloc[-1]
        for fam in POS_FAM.get(pos, []):
            col = FAM_COL[fam]
            gg = g[pd.to_numeric(g[col], errors='coerce').notna()].copy()
            # a real game for this family (avoid 0-snap noise)
            if fam == 'passing_yards': gg = gg[gg['attempts'].fillna(0) >= 10]
            elif fam == 'rushing_yards': gg = gg[gg['carries'].fillna(0) >= 3]
            else: gg = gg[gg['targets'].fillna(0) >= 1]
            if len(gg) < 6:
                continue
            base_mean = pd.to_numeric(gg[col], errors='coerce').mean()
            for axis in FAM_AXIS.get(fam, []):
                gg['_bucket'] = gg.apply(lambda r: (arch.get((r['opponent_team'], r['season'])) or {}).get(axis), axis=1)
                for bucket, sub in gg.groupby('_bucket'):
                    if not bucket or len(sub) < MIN_GAMES:
                        continue
                    m = pd.to_numeric(sub[col], errors='coerce').mean()
                    rows.append({
                        'player_key': norm(name), 'player_name': name, 'position': pos,
                        'prop_family': fam, 'axis': axis, 'bucket': bucket,
                        'games': int(len(sub)), 'mean_yards': round(float(m), 1),
                        'delta_vs_self': round(float(m - base_mean), 1),
                        'self_mean': round(float(base_mean), 1),
                    })
    return pd.DataFrame(rows)

def upsert(df):
    rows = df.where(pd.notna(df), None).to_dict('records')
    for i in range(0, len(rows), 500):
        r = requests.post(f"{SB}/rest/v1/nfl_matchup_history?on_conflict=player_key,prop_family,axis,bucket",
                          headers={**H, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                          data=json.dumps(rows[i:i+500], allow_nan=False), timeout=60)
        print(f"  nfl_matchup_history: {r.status_code} ({min(i+500,len(rows))}/{len(rows)})")
        if r.status_code >= 300: print("   ", r.text[:200]); break

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--seasons', nargs='+', type=int, required=True)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    df = build(a.seasons)
    if not len(df): sys.exit(1)
    if a.dry_run:
        print(f"rows: {len(df)}  (players x family x axis x bucket, each >= {MIN_GAMES} games)\n")
        # show the strongest matchup splits (biggest delta vs self, real sample)
        strong = df[df['games'] >= 6].reindex(df[df['games'] >= 6]['delta_vs_self'].abs().sort_values(ascending=False).index)
        print("=== biggest matchup effects (yards vs this D-type minus own baseline) ===")
        print(strong.head(16)[['player_name', 'prop_family', 'axis', 'bucket', 'games', 'mean_yards', 'self_mean', 'delta_vs_self']].to_string(index=False))
        sys.exit()
    upsert(df)

# SCHEMA:
# create table if not exists nfl_matchup_history (
#   id bigint generated always as identity primary key,
#   player_key text not null, player_name text, position text,
#   prop_family text not null, axis text not null, bucket text not null,
#   games int, mean_yards numeric, delta_vs_self numeric, self_mean numeric,
#   updated_at timestamptz default now(), unique (player_key, prop_family, axis, bucket)
# );
