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
// CACHING: the league table is expensive to compute (N games × ~24 rows × every
// team), so it's memoized in-process for MEMO_TTL_MS — one build per warm instance
// rather than per player. No external store; always live on a cold instance.
//
// FAIL-SAFE: any error → returns an empty table; the engine falls back to the
// neutral 1.0 multiplier (DEF 50), exactly as before. Never throws.

// No external cache — always fetch live. A tiny in-memory memo prevents rebuilding
// the (heavy) league table once per player within a single slate run / warm
// serverless instance. TTL keeps it fresh; it's per-instance, not shared.
const WINDOW_GAMES = Number(process.env.WNBA_DEF_WINDOW ?? 10);   // last N games per team
const MEMO_TTL_MS = 6 * 60 * 60 * 1000;                          // in-memory freshness
const SEASON = Number(process.env.WNBA_SEASON ?? 2026);          // season to pull games for
const BDL_BASE = 'https://api.balldontlie.io/wnba/v1';
let _memo = { at: 0, table: null };

// Cap how far a single matchup can move a projection, mirroring the engine's own
// defense clamp. Raw allowed-ratios can be noisy on small samples.
const MULT_CLAMP = [0.88, 1.12];

// Map BDL abbreviations → the slate's tricodes, so the defense table keys match
// what slate.js looks up. BDL uses GS/NY/WSH/LV etc; slate uses GSV/NYL/WAS/LVA.
const BDL_TO_SLATE = {
  ATL: 'ATL', CHI: 'CHI', CON: 'CON', CONN: 'CON', DAL: 'DAL', GS: 'GSV', GSV: 'GSV',
  IND: 'IND', LV: 'LVA', LVA: 'LVA', LA: 'LAS', LAS: 'LAS', MIN: 'MIN', NY: 'NYL',
  NYL: 'NYL', PHO: 'PHX', PHX: 'PHX', SEA: 'SEA', WAS: 'WAS', WSH: 'WAS',
  TOR: 'TOR', POR: 'POR',
};
function toSlateTri(bdlAbbr) {
  const a = String(bdlAbbr || '').toUpperCase();
  return BDL_TO_SLATE[a] || a;
}

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
  // In-memory memo: skip a rebuild if we built recently in this instance.
  if (!opts.noCache && _memo.table && (Date.now() - _memo.at) < MEMO_TTL_MS) {
    return { ..._memo.table, _audit: { ...(_memo.table._audit || {}), servedFromMemo: true } };
  }

  const warnings = [];
  if (!process.env.BDL_API_KEY) {
    return { byTeam: {}, teamDefense: {}, leagueAvg: null, _audit: { keyPresent: false, warnings: ['BDL_API_KEY not set'] } };
  }

  // 1) Recent finished games for the season. BDL marks finished games status:"post"
  //    (NOT "Final"), carries home_score/away_score, and the games endpoint works
  //    on ALL-STAR. We pull the season and keep the most recent finished games.
  const gamesRes = await bdlGet('/games', { 'seasons[]': SEASON, per_page: 100 });
  if (gamesRes.status === 401) return { byTeam: {}, teamDefense: {}, leagueAvg: null, _audit: { httpStatus: 401, warnings: ['games need ALL-STAR+ tier'] } };
  if (gamesRes.status !== 200) return { byTeam: {}, teamDefense: {}, leagueAvg: null, _audit: { httpStatus: gamesRes.status, warnings: ['games fetch failed'] } };

  const finals = (gamesRes.body?.data || [])
    .filter(g => {
      const s = String(g.status || '').toLowerCase();
      // "post" = finished. Also accept "final"/"f" defensively.
      return (s === 'post' || s.includes('final') || s === 'f')
        && Number.isFinite(Number(g.home_score)) && Number.isFinite(Number(g.away_score))
        && Number(g.home_score) > 0;
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  // ── TEAM DEFENSE (works on ALL-STAR) ─────────────────────────────────────
  // For each team, how many points they ALLOW per game vs league average. A team
  // that allows a lot = soft defense (boost a straight OVER / a scorer against them).
  // teamAllowed[tri] = { sum, n }  (points the opponent scored against them)
  const teamAllowed = {};
  const ensureTeam = (tri) => (teamAllowed[tri] = teamAllowed[tri] || { sum: 0, n: 0 });
  // Per-team window: keep last WINDOW_GAMES finished games per team.
  const teamSeen = {};
  for (const g of finals) {
    const homeTri = toSlateTri(g.home_team?.abbreviation);
    const awayTri = toSlateTri(g.visitor_team?.abbreviation);
    if (!homeTri || !awayTri) continue;
    const hs = Number(g.home_score), as = Number(g.away_score);
    teamSeen[homeTri] = (teamSeen[homeTri] || 0);
    teamSeen[awayTri] = (teamSeen[awayTri] || 0);
    if (teamSeen[homeTri] < WINDOW_GAMES) { ensureTeam(homeTri).sum += as; ensureTeam(homeTri).n++; teamSeen[homeTri]++; }  // home allowed away's score
    if (teamSeen[awayTri] < WINDOW_GAMES) { ensureTeam(awayTri).sum += hs; ensureTeam(awayTri).n++; teamSeen[awayTri]++; }  // away allowed home's score
  }
  // League average points allowed per game.
  let lgSum = 0, lgN = 0;
  for (const tri of Object.keys(teamAllowed)) { lgSum += teamAllowed[tri].sum; lgN += teamAllowed[tri].n; }
  const lgAllowedPerGame = lgN > 0 ? lgSum / lgN : null;
  // teamDefense[tri] = { allowedPerGame, multiplier, rating, games }
  const teamDefense = {};
  for (const tri of Object.keys(teamAllowed)) {
    const a = teamAllowed[tri];
    if (a.n >= 2 && lgAllowedPerGame) {
      const perGame = a.sum / a.n;
      let m = perGame / lgAllowedPerGame;     // >1 = allows more = soft
      m = Math.max(MULT_CLAMP[0], Math.min(MULT_CLAMP[1], m));
      teamDefense[tri] = {
        allowedPerGame: Number(perGame.toFixed(1)),
        leagueAvg: Number(lgAllowedPerGame.toFixed(1)),
        multiplier: Number(m.toFixed(3)),
        rating: m > 1.03 ? 'SOFT' : m < 0.97 ? 'TOUGH' : 'AVERAGE',
        games: a.n,
      };
    }
  }

  // ── PLAYER-POSITION DEFENSE (GOAT-gated) ──────────────────────────────────
  // Attempt the per-position box-score build. /player_stats is Unauthorized on
  // ALL-STAR; if so, this whole block no-ops and byTeam stays empty (player
  // defense shows "needs upgrade", team defense still works). Drops in for GOAT.
  const allowed = {};
  const ensure = (team) => (allowed[team] = allowed[team] || { G: mkAcc(), F: mkAcc(), C: mkAcc() });
  let rowsSeen = 0, playerStatsBlocked = false;
  const gamesToPull = [];
  const pullSeen = {};
  for (const g of finals) {
    const homeTri = toSlateTri(g.home_team?.abbreviation);
    const awayTri = toSlateTri(g.visitor_team?.abbreviation);
    if (!homeTri || !awayTri) continue;
    pullSeen[homeTri] = (pullSeen[homeTri] || 0); pullSeen[awayTri] = (pullSeen[awayTri] || 0);
    if (pullSeen[homeTri] < WINDOW_GAMES || pullSeen[awayTri] < WINDOW_GAMES) {
      gamesToPull.push({ id: g.id, home: homeTri, away: awayTri });
      pullSeen[homeTri]++; pullSeen[awayTri]++;
    }
  }
  for (const game of gamesToPull) {
    const st = await bdlGet('/player_stats', { 'game_ids[]': game.id, per_page: 100 });
    if (st.status === 401 || st.status === 403 || /unauthorized/i.test(String(st.body?.error || ''))) {
      playerStatsBlocked = true;
      warnings.push('player_stats requires GOAT tier — team defense only');
      break;
    }
    if (st.status !== 200) { warnings.push(`player_stats ${game.id} HTTP ${st.status}`); continue; }
    for (const row of (st.body?.data || [])) {
      const playerTeam = toSlateTri(row.team?.abbreviation || row.player?.team?.abbreviation);
      if (!playerTeam) continue;
      const defenseTeam = playerTeam === game.home ? game.away : playerTeam === game.away ? game.home : null;
      if (!defenseTeam) continue;
      const bucket = posBucket(row.player?.position ?? row.position);
      if (!bucket) continue;
      const minRaw = row.min ?? row.minutes;
      const minutes = (typeof minRaw === 'string' && minRaw.includes(':')) ? num(minRaw.split(':')[0]) : num(minRaw);
      if (minutes == null || minutes < 5) continue;
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

  // League averages per position+market (only if player stats came through).
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
      leagueAvg[pos][mk] = a.n > 0 ? a.sum / a.n : null;
    }
  }
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
          byTeam[team][pos][mk] = null;
        }
      }
    }
  }

  const result = {
    byTeam,            // player-position defense (GOAT)
    teamDefense,       // team-level defense (ALL-STAR) ← works now
    leagueAvg,
    _audit: {
      keyPresent: true, season: SEASON, window: WINDOW_GAMES,
      teams: Object.keys(byTeam).length,
      teamDefenseTeams: Object.keys(teamDefense).length,
      finishedGames: finals.length, gamesPulled: gamesToPull.length,
      rowsSeen, playerStatsBlocked, warnings, builtAt: new Date().toISOString(),
    },
  };
  _memo = { at: Date.now(), table: result };
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

/**
 * Look up the TEAM-level defense for one opponent (works on ALL-STAR).
 * Returns { allowedPerGame, leagueAvg, multiplier, rating, games } or null.
 * rating ∈ SOFT | AVERAGE | TOUGH. Use for straight bets and the card chip.
 */
export function teamDefenseFor(table, opponentTeam) {
  if (!table || !table.teamDefense) return null;
  return table.teamDefense[opponentTeam] || null;
}
