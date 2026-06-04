// api/_lib/wnba/wnbaDefenseFeed.js
//
// OPPOSING DEFENSE layer — the piece that was "NO DEFENSE DATA" / DEF 50.
//
// WHAT IT DOES: for each team, look at their last N games, and tally what their
// OPPONENTS produced by position (G/F/C) in points, rebounds, and assists. A team
// that lets opposing guards score a lot has a "soft" guard defense; the engine
// then boosts a guard's projection against them (and vice versa). Output is a
// multiplier per team × position × market, centered on 1.0 (league average).
//
// DATA SOURCE: BDL Game Player Stats (/stats), unlocked on the ALL-STAR tier.
// No props/odds needed here — this is built purely from box scores, so ALL-STAR
// is sufficient. Position comes from the player row; markets map to pts/reb/ast.
//
// CACHING: the whole league table is expensive to compute (N games × ~24 rows ×
// every team), so it's cached in Supabase via wnbaCache for DEFENSE_MAX_AGE_MS
// and ideally warmed by the cron. A slate read is then a single cache hit.
//
// FAIL-SAFE: any error → returns an empty table; the engine falls back to the
// neutral 1.0 multiplier (DEF 50), exactly as before. Never throws.

import { cacheRead, cacheWrite, CACHE_KEYS } from './wnbaCache.js';

const WINDOW_GAMES = Number(process.env.WNBA_DEF_WINDOW ?? 10);   // last N games per team
const DEFENSE_MAX_AGE_MS = 6 * 60 * 60 * 1000;                    // 6h cache freshness
const BDL_BASE = 'https://api.balldontlie.io/wnba/v1';

// Cap how far a single matchup can move a projection, mirroring the engine's own
// defense clamp. Raw allowed-ratios can be noisy on small samples.
const MULT_CLAMP = [0.88, 1.12];

function authHeaders() {
  const key = process.env.BDL_API_KEY || '';
  return { Authorization: key, apikey: key };
}

async function bdlGet(path, params = {}) {
  const url = new URL(BDL_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(`${k}[]`, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: ctrl.signal });
    clearTimeout(timer);
    let body = null; try { body = await res.json(); } catch { /* */ }
    return { status: res.status, body };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, body: null, error: e.message };
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Normalize a raw position string to G / F / C buckets (WNBA + bbref variants).
function posBucket(raw) {
  const p = String(raw || '').toUpperCase();
  if (!p) return null;
  if (p.startsWith('G')) return 'G';
  if (p.startsWith('C')) return 'C';
  if (p.startsWith('F')) return 'F';
  // Combo positions: take the first listed (e.g. "G-F" → G).
  if (p.includes('GUARD')) return 'G';
  if (p.includes('CENTER')) return 'C';
  if (p.includes('FORWARD')) return 'F';
  return null;
}

const MARKETS = ['points', 'rebounds', 'assists'];
const STAT_OF = { points: 'pts', rebounds: 'reb', assists: 'ast' };

/**
 * Build the league defense table from box scores.
 * Returns: {
 *   byTeam: { TRI: { G: {points:m, rebounds:m, assists:m}, F:{...}, C:{...} } },
 *   leagueAvg: { G:{points,rebounds,assists}, F:{...}, C:{...} },
 *   _audit: {...}
 * }
 * All multipliers are centered on 1.0 (team allowed / league allowed), clamped.
 */
export async function buildWnbaDefenseTable(opts = {}) {
  // Read warm cache first unless told to force-refresh (cron passes noCache).
  if (!opts.noCache) {
    try {
      const cached = await cacheRead(CACHE_KEYS.defense(), DEFENSE_MAX_AGE_MS);
      if (cached && cached.value && cached.value.byTeam) {
        cached.value._audit = { ...(cached.value._audit || {}), servedFromCache: true, ageMs: cached.ageMs };
        return cached.value;
      }
    } catch { /* fall through */ }
  }

  const warnings = [];
  if (!process.env.BDL_API_KEY) {
    return { byTeam: {}, leagueAvg: null, _audit: { keyPresent: false, warnings: ['BDL_API_KEY not set'] } };
  }

  // 1) Recent finished games (a single window across the league; WINDOW_GAMES per
  //    team is approximated by pulling the league's recent finals and tallying).
  //    Pull a generous recent set, then keep each team's last WINDOW_GAMES.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const start = new Date(); start.setDate(start.getDate() - 45);
  const startYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(start);

  const gamesRes = await bdlGet('/games', { start_date: startYmd, end_date: today, per_page: 100 });
  if (gamesRes.status === 401) return { byTeam: {}, leagueAvg: null, _audit: { httpStatus: 401, warnings: ['stats/games need ALL-STAR+ tier'] } };
  if (gamesRes.status !== 200) return { byTeam: {}, leagueAvg: null, _audit: { httpStatus: gamesRes.status, warnings: ['games fetch failed'] } };

  const finals = (gamesRes.body?.data || [])
    .filter(g => /final/i.test(String(g.status || '')))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  // Map game → {home, away} abbreviations, and cap per-team window.
  const teamGameCount = {};
  const gamesToPull = [];
  for (const g of finals) {
    const home = g.home_team?.abbreviation;
    const away = g.visitor_team?.abbreviation;
    if (!home || !away) continue;
    teamGameCount[home] = (teamGameCount[home] || 0);
    teamGameCount[away] = (teamGameCount[away] || 0);
    if (teamGameCount[home] < WINDOW_GAMES || teamGameCount[away] < WINDOW_GAMES) {
      gamesToPull.push({ id: g.id, home, away });
      teamGameCount[home]++; teamGameCount[away]++;
    }
  }

  // 2) For each game, pull box scores and attribute each player's output to the
  //    DEFENSE they faced (their opponent), bucketed by the player's position.
  //    allowed[team][pos][stat] = { sum, n }
  const allowed = {};
  const ensure = (team) => (allowed[team] = allowed[team] || {
    G: mkAcc(), F: mkAcc(), C: mkAcc(),
  });
  let rowsSeen = 0;

  for (const game of gamesToPull) {
    const st = await bdlGet('/stats', { game_ids: [game.id], per_page: 100 });
    if (st.status === 401) { warnings.push('stats 401 — tier'); break; }
    if (st.status !== 200) { warnings.push(`stats ${game.id} HTTP ${st.status}`); continue; }
    for (const row of (st.body?.data || [])) {
      const playerTeam = row.team?.abbreviation || row.player?.team?.abbreviation;
      if (!playerTeam) continue;
      // The defense that faced this player = the other team in this game.
      const defenseTeam = playerTeam === game.home ? game.away
        : playerTeam === game.away ? game.home : null;
      if (!defenseTeam) continue;
      const bucket = posBucket(row.player?.position ?? row.position);
      if (!bucket) continue;
      const minRaw = row.min ?? row.minutes;
      const minutes = (typeof minRaw === 'string' && minRaw.includes(':')) ? num(minRaw.split(':')[0]) : num(minRaw);
      if (minutes == null || minutes < 5) continue;   // skip garbage-time noise
      const acc = ensure(defenseTeam)[bucket];
      const pts = num(row.pts ?? row.points);
      const reb = num(row.reb ?? row.rebounds ?? row.total_rebounds);
      const ast = num(row.ast ?? row.assists);
      if (pts != null) { acc.points.sum += pts; acc.points.n++; }
      if (reb != null) { acc.rebounds.sum += reb; acc.rebounds.n++; }
      if (ast != null) { acc.assists.sum += ast; acc.assists.n++; }
      rowsSeen++;
    }
  }

  // 3) League averages per position+market (the baseline each team is measured vs).
  const leagueAcc = { G: mkAcc(), F: mkAcc(), C: mkAcc() };
  for (const team of Object.keys(allowed)) {
    for (const pos of ['G', 'F', 'C']) {
      for (const mk of MARKETS) {
        const a = allowed[team][pos][mk];
        if (a.n > 0) { leagueAcc[pos][mk].sum += a.sum; leagueAcc[pos][mk].n += a.n; }
      }
    }
  }
  const leagueAvg = {};
  for (const pos of ['G', 'F', 'C']) {
    leagueAvg[pos] = {};
    for (const mk of MARKETS) {
      const a = leagueAcc[pos][mk];
      leagueAvg[pos][mk] = a.n > 0 ? a.sum / a.n : null;   // avg allowed per player-game
    }
  }

  // 4) Convert each team's allowed-per-game into a multiplier vs league average.
  //    >1 = team allows MORE than average → soft defense → boost the prop.
  const byTeam = {};
  for (const team of Object.keys(allowed)) {
    byTeam[team] = {};
    for (const pos of ['G', 'F', 'C']) {
      byTeam[team][pos] = {};
      for (const mk of MARKETS) {
        const a = allowed[team][pos][mk];
        const lg = leagueAvg[pos][mk];
        if (a.n >= 3 && lg && lg > 0) {
          const perGame = a.sum / a.n;
          let m = perGame / lg;
          m = Math.max(MULT_CLAMP[0], Math.min(MULT_CLAMP[1], m));
          byTeam[team][pos][mk] = Number(m.toFixed(3));
        } else {
          byTeam[team][pos][mk] = null;   // not enough sample → engine stays neutral
        }
      }
    }
  }

  const result = {
    byTeam, leagueAvg,
    _audit: {
      keyPresent: true, window: WINDOW_GAMES, teams: Object.keys(byTeam).length,
      gamesPulled: gamesToPull.length, rowsSeen, warnings, builtAt: new Date().toISOString(),
    },
  };
  try { await cacheWrite(CACHE_KEYS.defense(), result); } catch { /* */ }
  return result;
}

function mkAcc() {
  return { points: { sum: 0, n: 0 }, rebounds: { sum: 0, n: 0 }, assists: { sum: 0, n: 0 } };
}

/**
 * Look up the defense multiplier for one (opponentTeam, position, market).
 * Returns a number centered on 1.0, or null if no data (engine stays neutral).
 */
export function defenseMultiplier(table, opponentTeam, position, market) {
  if (!table || !table.byTeam) return null;
  const pos = posBucket(position);
  const mk = String(market || '').toLowerCase();
  const marketKey = mk.includes('rebound') ? 'rebounds'
    : mk.includes('assist') ? 'assists'
    : mk.includes('point') ? 'points' : null;
  if (!pos || !marketKey) return null;
  const t = table.byTeam[opponentTeam];
  if (!t || !t[pos]) return null;
  return t[pos][marketKey] ?? null;
}
