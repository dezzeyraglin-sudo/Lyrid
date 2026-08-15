// api/_lib/wnba/wnbaDefenseFeed.js
//
// OPPOSING DEFENSE layer — for each team, tally what their OPPONENTS produced by
// position (G/F/C) in points, rebounds, assists over the last N games. A team that
// lets opposing guards score a lot has a "soft" guard defense; the engine boosts a
// guard's projection against them. Output: a multiplier per team × position ×
// market, centered on 1.0, plus a team-level points-allowed multiplier.
//
// DATA SOURCE: ESPN (free, keyless) — scoreboard for finished-game scores (team
// defense) and box scores for per-position allowed stats (position defense).
// Migrated off BallDontLie: team defense used BDL /games, position defense used
// BDL /player_stats (GOAT-gated, usually empty). ESPN makes position defense work
// with no key.
//
// CACHING: memoized in-process for MEMO_TTL_MS — one build per warm instance.
// FAIL-SAFE: any error → empty table; engine falls back to neutral 1.0 (DEF 50).

import { getScoreboard, getBoxScore, buildPlayerIdMap } from './wnbaFeedEspn.js';

const WINDOW_GAMES = Number(process.env.WNBA_DEF_WINDOW ?? 10);
const MEMO_TTL_MS = 6 * 60 * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.WNBA_DEF_LOOKBACK ?? 40);
const BOX_CONCURRENCY = Number(process.env.WNBA_DEF_BOX_CONC ?? 6);
let _memo = { at: 0, table: null };

const MULT_CLAMP = [0.88, 1.12];

// ESPN abbreviations → the slate's tricodes so table keys match slate.js lookups.
const ESPN_TO_SLATE = {
  ATL: 'ATL', CHI: 'CHI', CON: 'CON', DAL: 'DAL', GS: 'GSV', IND: 'IND',
  LA: 'LAS', LV: 'LVA', MIN: 'MIN', NY: 'NYL', PHX: 'PHX', POR: 'POR',
  SEA: 'SEA', TOR: 'TOR', WSH: 'WAS',
};
function toSlateTri(espnAbbr) {
  const a = String(espnAbbr || '').toUpperCase();
  return ESPN_TO_SLATE[a] || a;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function posBucket(raw) {
  const p = String(raw || '').toUpperCase();
  if (!p) return null;
  if (p.startsWith('G')) return 'G';
  if (p.startsWith('C')) return 'C';
  if (p.startsWith('F')) return 'F';
  if (p.includes('GUARD')) return 'G';
  if (p.includes('CENTER')) return 'C';
  if (p.includes('FORWARD')) return 'F';
  return null;
}

const MARKETS = ['points', 'rebounds', 'assists'];
function mkAcc() {
  return { points: { sum: 0, n: 0 }, rebounds: { sum: 0, n: 0 }, assists: { sum: 0, n: 0 } };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export async function buildWnbaDefenseTable(opts = {}) {
  if (!opts.noCache && _memo.table && (Date.now() - _memo.at) < MEMO_TTL_MS) {
    return { ..._memo.table, _audit: { ...(_memo.table._audit || {}), servedFromMemo: true } };
  }
  const warnings = [];

  const days = [];
  const today = new Date();
  for (let i = 0; i < LOOKBACK_DAYS; i++) { const d = new Date(today); d.setDate(d.getDate() - i); days.push(ymd(d)); }
  const finals = [];
  await mapLimit(days, 6, async (day) => {
    const sb = await getScoreboard(day).catch(() => []);
    for (const g of sb) {
      if (String(g.status || '').toUpperCase().includes('FINAL')
        && Number.isFinite(g.homeScore) && Number.isFinite(g.awayScore) && g.homeScore > 0) {
        finals.push({ eventId: g.eventId, date: g.date, home: toSlateTri(g.home), away: toSlateTri(g.away), homeScore: g.homeScore, awayScore: g.awayScore });
      }
    }
  });
  finals.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  if (finals.length === 0) {
    const empty = { byTeam: {}, teamDefense: {}, leagueAvg: null, _audit: { source: 'espn', warnings: ['no finished games in lookback window'], builtAt: new Date().toISOString() } };
    _memo = { at: Date.now(), table: empty };
    return empty;
  }

  // TEAM DEFENSE — points allowed per game vs league average.
  const teamAllowed = {};
  const ensureTeam = (t) => (teamAllowed[t] = teamAllowed[t] || { sum: 0, n: 0 });
  const teamSeen = {};
  for (const g of finals) {
    if (!g.home || !g.away) continue;
    teamSeen[g.home] = teamSeen[g.home] || 0; teamSeen[g.away] = teamSeen[g.away] || 0;
    if (teamSeen[g.home] < WINDOW_GAMES) { ensureTeam(g.home).sum += g.awayScore; ensureTeam(g.home).n++; teamSeen[g.home]++; }
    if (teamSeen[g.away] < WINDOW_GAMES) { ensureTeam(g.away).sum += g.homeScore; ensureTeam(g.away).n++; teamSeen[g.away]++; }
  }
  let lgSum = 0, lgN = 0;
  for (const t of Object.keys(teamAllowed)) { lgSum += teamAllowed[t].sum; lgN += teamAllowed[t].n; }
  const lgAllowedPerGame = lgN > 0 ? lgSum / lgN : null;
  const teamDefense = {};
  for (const t of Object.keys(teamAllowed)) {
    const a = teamAllowed[t];
    if (a.n >= 2 && lgAllowedPerGame) {
      const perGame = a.sum / a.n;
      const m = Math.max(MULT_CLAMP[0], Math.min(MULT_CLAMP[1], perGame / lgAllowedPerGame));
      teamDefense[t] = { allowedPerGame: Number(perGame.toFixed(1)), leagueAvg: Number(lgAllowedPerGame.toFixed(1)), multiplier: Number(m.toFixed(3)), rating: m > 1.03 ? 'SOFT' : m < 0.97 ? 'TOUGH' : 'AVERAGE', games: a.n };
    }
  }

  // POSITION DEFENSE — box scores for in-window games, tally opponents by position.
  let idMap = {};
  try { idMap = await buildPlayerIdMap(); } catch { warnings.push('roster map failed — position defense skipped'); }
  const posById = {};
  for (const v of Object.values(idMap)) if (v?.id) posById[v.id] = v.position;

  const pullSeen = {}; const gamesToPull = [];
  for (const g of finals) {
    pullSeen[g.home] = pullSeen[g.home] || 0; pullSeen[g.away] = pullSeen[g.away] || 0;
    if (pullSeen[g.home] < WINDOW_GAMES || pullSeen[g.away] < WINDOW_GAMES) { gamesToPull.push(g); pullSeen[g.home]++; pullSeen[g.away]++; }
  }

  const allowed = {};
  const ensure = (team) => (allowed[team] = allowed[team] || { G: mkAcc(), F: mkAcc(), C: mkAcc() });
  // Team OFFENSIVE style — tracked PER GAME so we can window it (L10 / L5) and catch
  // recent coaching/scheme changes rather than smearing a season average.
  const offenseByGame = {};   // team -> [{ date, fga, fg3a, fta, fgm, ast, pts }]
  let rowsSeen = 0;
  await mapLimit(gamesToPull, BOX_CONCURRENCY, async (game) => {
    const box = await getBoxScore(game.eventId).catch(() => []);
    const teamTotals = {};    // this game's per-team totals
    for (const row of box) {
      const playerTeam = toSlateTri(row.team);
      if (playerTeam) {
        const tt = teamTotals[playerTeam] = teamTotals[playerTeam] || { fga: 0, fg3a: 0, fta: 0, fgm: 0, ast: 0, pts: 0 };
        tt.fga += num(row.fga) || 0; tt.fg3a += num(row.fg3a) || 0; tt.fta += num(row.fta) || 0;
        tt.fgm += num(row.fgm) || 0; tt.ast += num(row.ast) || 0; tt.pts += num(row.pts) || 0;
      }
      const defenseTeam = playerTeam === game.home ? game.away : playerTeam === game.away ? game.home : null;
      if (!defenseTeam) continue;
      const bucket = posBucket(posById[row.athleteId]);
      if (!bucket) continue;
      if (!(Number(row.minutes) >= 5)) continue;
      const acc = ensure(defenseTeam)[bucket];
      if (num(row.pts) != null) { acc.points.sum += row.pts; acc.points.n++; }
      if (num(row.reb) != null) { acc.rebounds.sum += row.reb; acc.rebounds.n++; }
      if (num(row.ast) != null) { acc.assists.sum += row.ast; acc.assists.n++; }
      rowsSeen++;
    }
    for (const [t, tt] of Object.entries(teamTotals)) {
      (offenseByGame[t] = offenseByGame[t] || []).push({ date: game.date, ...tt });
    }
  });

  const leagueAcc = { G: mkAcc(), F: mkAcc(), C: mkAcc() };
  for (const team of Object.keys(allowed))
    for (const pos of ['G', 'F', 'C'])
      for (const mk of MARKETS) { const a = allowed[team][pos][mk]; if (a.n > 0) { leagueAcc[pos][mk].sum += a.sum; leagueAcc[pos][mk].n += a.n; } }
  const leagueAvg = {};
  for (const pos of ['G', 'F', 'C']) { leagueAvg[pos] = {}; for (const mk of MARKETS) { const a = leagueAcc[pos][mk]; leagueAvg[pos][mk] = a.n > 0 ? a.sum / a.n : null; } }
  const byTeam = {};
  for (const team of Object.keys(allowed)) {
    byTeam[team] = {};
    for (const pos of ['G', 'F', 'C']) {
      byTeam[team][pos] = {};
      for (const mk of MARKETS) {
        const a = allowed[team][pos][mk], lg = leagueAvg[pos][mk];
        byTeam[team][pos][mk] = (a.n >= 3 && lg && lg > 0) ? Number(Math.max(MULT_CLAMP[0], Math.min(MULT_CLAMP[1], (a.sum / a.n) / lg)).toFixed(3)) : null;
      }
    }
  }

  // Team style fingerprints over L10 and L5 windows. The L5/L10 split catches a
  // recent style shift (new rotation, pace change) before a season average would.
  const winStats = (games, n) => {
    const g = games.slice(0, n);
    if (g.length < 2) return null;
    const sum = (f) => g.reduce((a, x) => a + (Number(x[f]) || 0), 0);
    const fga = sum('fga');
    if (fga < 40) return null;
    return {
      threeRate: sum('fg3a') / fga,
      ftRate: sum('fta') / fga,
      astRate: sum('fgm') > 0 ? sum('ast') / sum('fgm') : 0,
      ppg: sum('pts') / g.length,
      games: g.length,
    };
  };
  const rawWindows = {};
  for (const [t, games] of Object.entries(offenseByGame)) {
    games.sort((a, b) => String(b.date).localeCompare(String(a.date)));   // newest first
    const l10 = winStats(games, 10), l5 = winStats(games, 5);
    if (l10 || l5) rawWindows[t] = { l10, l5 };
  }
  // League baselines from the L10 windows (stable denominator).
  const l10s = Object.values(rawWindows).map(w => w.l10).filter(Boolean);
  const lgAvg = (f) => l10s.length ? l10s.reduce((a, s) => a + s[f], 0) / l10s.length : 0;
  const lgThree = lgAvg('threeRate'), lgPpg = lgAvg('ppg'), lgAst = lgAvg('astRate'), lgFt = lgAvg('ftRate');

  const tagWindow = (s) => {
    if (!s) return { tags: [], missProfile: 'BALANCED' };
    const tags = [];
    if (s.threeRate >= lgThree * 1.12) tags.push('three-heavy');
    else if (s.threeRate <= lgThree * 0.88) tags.push('paint-oriented');
    if (s.ftRate >= lgFt * 1.15) tags.push('attacks the rim');
    else if (s.ftRate <= lgFt * 0.85) tags.push('jump-shooting');
    if (s.astRate >= lgAst * 1.10) tags.push('ball-movement');
    else if (s.astRate <= lgAst * 0.90) tags.push('iso-heavy');
    if (s.ppg >= lgPpg * 1.06) tags.push('high-scoring');
    else if (s.ppg <= lgPpg * 0.94) tags.push('low-scoring');
    return {
      tags,
      missProfile: s.threeRate >= lgThree * 1.08 ? 'PERIMETER' : s.threeRate <= lgThree * 0.92 ? 'PAINT' : 'BALANCED',
    };
  };

  const teamStyle = {};
  for (const [t, w] of Object.entries(rawWindows)) {
    // Recency-weighted blend (L5 leads, L10 stabilizes) drives the under read.
    const l5 = w.l5, l10 = w.l10, primary = l5 || l10;
    const blend = (f) => (l5 && l10) ? 0.6 * l5[f] + 0.4 * l10[f] : (primary ? primary[f] : 0);
    const bThree = blend('threeRate'), bPpg = blend('ppg');
    // UNDER-ENVIRONMENT score, grounded in the 443-pick audit: unders hit 81% vs
    // suppressing/paint defenses and 51% vs three-heavy/fast teams. Suppression
    // rises as scoring pace and three-rate fall.
    const paceZ = lgPpg > 0 ? (bPpg - lgPpg) / lgPpg : 0;       // + = high scoring
    const threeZ = lgThree > 0 ? (bThree - lgThree) / lgThree : 0; // + = three-heavy
    const heat = paceZ + threeZ;   // higher = faster/hotter environment (bad for unders)
    // Conservative factors: the opponent effect is real (permutation p≈0.015) but
    // has no clean mechanism and noisy per-team estimates, so this is a mild causal
    // PRIOR (fast games = more possessions = harder unders), not a fitted edge.
    let underEnv, underFactor;
    if (heat <= -0.10) { underEnv = 'SUPPRESS'; underFactor = 1.05; }   // mildly favors unders
    else if (heat >= 0.12) { underEnv = 'FAST'; underFactor = 0.95; }   // mildly fades unders
    else { underEnv = 'NEUTRAL'; underFactor = 1.0; }
    // Recent-shift flag: L5 miss profile diverges from L10 → coaching/rotation change.
    const p5 = tagWindow(l5).missProfile, p10 = tagWindow(l10).missProfile;
    const styleShift = (l5 && l10 && p5 !== p10) ? { from: p10, to: p5 } : null;

    teamStyle[t] = {
      l10: l10 ? { ...l10, threePct: Math.round(l10.threeRate * 100), ...tagWindow(l10) } : null,
      l5: l5 ? { ...l5, threePct: Math.round(l5.threeRate * 100), ...tagWindow(l5) } : null,
      // top-level = the recency-weighted read the engine consumes
      threePct: Math.round(bThree * 100),
      ppg: Number(bPpg.toFixed(1)),
      missProfile: bThree >= lgThree * 1.08 ? 'PERIMETER' : bThree <= lgThree * 0.92 ? 'PAINT' : 'BALANCED',
      tags: tagWindow({ threeRate: bThree, ftRate: blend('ftRate'), astRate: blend('astRate'), ppg: bPpg }).tags,
      underEnv, underFactor, styleShift,
    };
  }

  const result = { byTeam, teamDefense, teamStyle, leagueAvg, _audit: { source: 'espn', window: WINDOW_GAMES, teams: Object.keys(byTeam).length, teamDefenseTeams: Object.keys(teamDefense).length, styleTeams: Object.keys(teamStyle).length, finishedGames: finals.length, gamesPulled: gamesToPull.length, rowsSeen, warnings, builtAt: new Date().toISOString() } };
  _memo = { at: Date.now(), table: result };
  return result;
}

export function defenseMultiplier(table, opponentTeam, position, market) {
  if (!table || !table.byTeam) return null;
  const pos = posBucket(position);
  const mk = String(market || '').toLowerCase();
  const marketKey = mk.includes('rebound') ? 'rebounds' : mk.includes('assist') ? 'assists' : mk.includes('point') ? 'points' : null;
  if (!pos || !marketKey) return null;
  const t = table.byTeam[opponentTeam];
  if (!t || !t[pos]) return null;
  return t[pos][marketKey] ?? null;
}

export function teamDefenseFor(table, opponentTeam) {
  if (!table || !table.teamDefense) return null;
  return table.teamDefense[opponentTeam] || null;
}

/**
 * Team offensive style fingerprint for one team, or null.
 * { threeRate, ftRate, astRate, ppg, threePct, missProfile, tags[] }
 */
export function teamStyleFor(table, team) {
  if (!table || !table.teamStyle) return null;
  return table.teamStyle[team] || null;
}
