// api/_lib/wnba/wnbaGameLog.js
//
// WNBA PLAYER GAME LOG MODULE (June 1, 2026 — basketball-reference migration)
//
// HISTORY:
//   Session 2 (May 16) — built against stats.wnba.com /playergamelog
//   June 1 — migrated to basketball-reference after stats.wnba.com confirmed
//     unreachable from Vercel. This was the recent-form feed that silently
//     returned null on every call and (because of timeout+retry) was a major
//     source of slate latency.
//
// CONTRACT (UNCHANGED): exports fetchPlayerGameLog / getRecentGames /
//   aggregateRecentForm with the same signatures and the same normalized game
//   shape, so slate.js and basketballProps.js need no changes.
//
// SOURCE (verified live June 1):
//   /wnba/players/{first-letter}/{slug}/gamelog/{season}
//   table id="wnba_pgl_basic" — one row per game.
//   bbref game-log columns (data-stat): date_game, team_id, opp_id,
//     game_location ('@' = away, '' = home), game_result, mp ("MM:SS"),
//     pts, trb, ast, stl, blk, tov, fg, fga, fg3, ft, fta, plus_minus.
//   NOTE: mp is a "MM:SS" STRING here (unlike stats.wnba.com's decimal) —
//   parseMinutes() converts it.

import { fetchBbrefPage, unwrapCommentedTables, extractTableHtml, parseTableRows } from './bbrefClient.js';

const GAMELOG_TABLE_IDS = ['wnba_pgl_basic', 'pgl_basic'];

// --- GLOBAL bbref CONCURRENCY GATE --------------------------------------------
// The slate fans out ~30 game-log fetches at once (one per player across all
// games). basketball-reference 429s that burst, which starved the engine of
// real data and produced the flat fallback scores. This gate caps simultaneous
// bbref game-log requests and spaces them slightly so bbref stops throttling.
// Tunable via env; defaults are conservative enough to clear bbref's limiter.
const BBREF_MAX_CONCURRENT = Number(process.env.BBREF_MAX_CONCURRENT ?? 2);
const BBREF_GAP_MS = Number(process.env.BBREF_GAP_MS ?? 350);
let _active = 0;
const _queue = [];
let _lastStart = 0;

function _drain() {
  if (_active >= BBREF_MAX_CONCURRENT || _queue.length === 0) return;
  const sinceLast = Date.now() - _lastStart;
  const wait = Math.max(0, BBREF_GAP_MS - sinceLast);
  const { fn, resolve, reject } = _queue.shift();
  _active++;
  _lastStart = Date.now() + wait;
  setTimeout(() => {
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { _active--; _drain(); });
  }, wait);
  // Try to start another (respects the concurrency cap inside the guard).
  _drain();
}

// Run an async bbref task through the gate.
function gateBbref(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject });
    _drain();
  });
}

/**
 * Build the bbref game-log path for a player slug.
 * Slug "wilsoa01w" → /wnba/players/w/wilsoa01w/gamelog/2026
 */
function gameLogPath(slug, season) {
  const s = String(slug).trim();
  const first = s.charAt(0).toLowerCase();
  return `/wnba/players/${first}/${s}/gamelog/${season}`;
}

/** Convert bbref "MM:SS" minutes to decimal. "34:12" → 34.2. Numbers pass through. */
function parseMinutes(v) {
  if (v == null || v === '') return 0;
  const str = String(v);
  if (str.includes(':')) {
    const [m, sec] = str.split(':').map(Number);
    if (Number.isFinite(m)) return Number((m + (Number(sec) || 0) / 60).toFixed(2));
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
}

function toNum(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch game-by-game stats for a player. Most recent last on bbref, so we
 * sort descending (most recent first) to match the previous contract.
 *
 * @param {string} playerId - bbref slug (e.g. "wilsoa01w")
 * @param {number} season
 * @returns {Promise<Array<Object>>}
 */
export async function fetchPlayerGameLog(playerId, season = 2026) {
  if (!playerId) return [];
  // A bbref slug is lowercase alphanumeric ending in a letter (e.g. citroso01w).
  // A player NAME (has a space/uppercase) would build a 404 URL — skip cleanly so
  // the caller falls back to season averages instead of hanging on a bad fetch.
  const looksLikeSlug = /^[a-z0-9]+$/.test(String(playerId)) && /[a-z]$/i.test(String(playerId));
  if (!looksLikeSlug) {
    console.warn(`[wnbaGameLog] "${playerId}" is not a bbref slug — skipping game-log fetch (no recent form)`);
    return [];
  }

  // Route through the global gate so the slate's ~30 simultaneous game-log
  // fetches become a capped, spaced stream — this is what stops bbref's 429s.
  const html = await gateBbref(() =>
    fetchBbrefPage(gameLogPath(playerId, season), { ttlMs: 30 * 60 * 1000 })
  );
  if (!html) return [];

  const unwrapped = unwrapCommentedTables(html);
  let tableHtml = null;
  for (const id of GAMELOG_TABLE_IDS) {
    tableHtml = extractTableHtml(unwrapped, id);
    if (tableHtml) break;
  }
  if (!tableHtml) {
    console.warn(`[wnbaGameLog] no game-log table for ${playerId} (${season})`);
    return [];
  }

  const rows = parseTableRows(tableHtml);

  const games = rows.map(r => {
    // Skip non-game rows (month separators, DNPs with no minutes/date).
    if (!r.date_game && !r.date) return null;
    const minutes = parseMinutes(r.mp);
    const isAway = (r.game_location || r.game_location_x || '') === '@';
    const team = r.team_id || r.team_name_abbr || '';
    const opp = r.opp_id || r.opp_name_abbr || '';

    const points = toNum(r.pts);
    const rebounds = toNum(r.trb);
    const assists = toNum(r.ast);

    return {
      date: parseGameDate(r.date_game || r.date),
      rawDate: r.date_game || r.date,
      gameId: r.game_id || null,
      matchup: team && opp ? `${team} ${isAway ? '@' : 'vs.'} ${opp}` : (r.matchup || ''),
      win: String(r.game_result || '').startsWith('W'),
      minutes,
      points,
      rebounds,
      assists,
      steals: toNum(r.stl),
      blocks: toNum(r.blk),
      turnovers: toNum(r.tov),
      threes: toNum(r.fg3),
      fga: toNum(r.fga),
      fgm: toNum(r.fg),
      fta: toNum(r.fta),
      ftm: toNum(r.ft),
      plusMinus: toNum(r.plus_minus),
      pra: points + rebounds + assists,
      pa: points + assists,
      pr: points + rebounds,
      ra: rebounds + assists
    };
  }).filter(Boolean);

  // bbref lists oldest→newest; sort to most-recent-first (defensive).
  games.sort((a, b) => {
    const ad = a.date ? new Date(a.date).getTime() : 0;
    const bd = b.date ? new Date(b.date).getTime() : 0;
    return bd - ad;
  });

  return games;
}

export async function getRecentGames(playerId, n = 10, season = 2026) {
  const all = await fetchPlayerGameLog(playerId, season);
  if (all.length === 0) return [];
  return all.slice(0, n);
}

/**
 * Aggregate recent form. Same return shape as before.
 */
export async function aggregateRecentForm(playerId, n = 10, market = 'points', season = 2026) {
  const games = await getRecentGames(playerId, n, season);
  if (games.length === 0) return null;

  const totals = { games: games.length, minutes: 0, points: 0, rebounds: 0, assists: 0,
    threes: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, turnovers: 0 };

  for (const g of games) {
    totals.minutes += g.minutes || 0;
    totals.points += g.points || 0;
    totals.rebounds += g.rebounds || 0;
    totals.assists += g.assists || 0;
    totals.threes += g.threes || 0;
    totals.fgm += g.fgm || 0;
    totals.fga += g.fga || 0;
    totals.ftm += g.ftm || 0;
    totals.fta += g.fta || 0;
    totals.turnovers += g.turnovers || 0;
  }

  const minutesArr = games.map(g => g.minutes || 0);
  const minutesMean = totals.minutes / games.length;
  const minutesVar = minutesArr.reduce((s, m) => s + (m - minutesMean) ** 2, 0) / games.length;
  const minutesCv = minutesMean > 0 ? Math.sqrt(minutesVar) / minutesMean : 0;

  const marketKey = String(market).toLowerCase();
  let recentAvg;
  if (marketKey.includes('rebound')) recentAvg = totals.rebounds / games.length;
  else if (marketKey.includes('assist')) recentAvg = totals.assists / games.length;
  else if (marketKey.includes('three') || marketKey.includes('3pm')) recentAvg = totals.threes / games.length;
  else if (marketKey.includes('pra')) recentAvg = (totals.points + totals.rebounds + totals.assists) / games.length;
  else if (marketKey === 'pa') recentAvg = (totals.points + totals.assists) / games.length;
  else if (marketKey === 'pr') recentAvg = (totals.points + totals.rebounds) / games.length;
  else recentAvg = totals.points / games.length;

  return {
    gamesUsed: games.length,
    recentAvg: Number(recentAvg.toFixed(2)),
    minutesAvg: Number(minutesMean.toFixed(2)),
    minutesCv: Number(minutesCv.toFixed(3)),
    last5Avg: gamesAvg(games.slice(0, 5), marketKey),
    last10Avg: gamesAvg(games.slice(0, 10), marketKey),
    minutesLast5: gamesAvg(games.slice(0, 5), 'minutes'),
    totals,
    games
  };
}

function gamesAvg(games, key) {
  if (games.length === 0) return 0;
  let total = 0;
  for (const g of games) {
    if (key === 'minutes') total += g.minutes || 0;
    else if (key.includes('rebound')) total += g.rebounds || 0;
    else if (key.includes('assist')) total += g.assists || 0;
    else if (key.includes('three') || key.includes('3pm')) total += g.threes || 0;
    else if (key.includes('pra')) total += g.pra || 0;
    else if (key === 'pa') total += g.pa || 0;
    else if (key === 'pr') total += g.pr || 0;
    else total += g.points || 0;
  }
  return Number((total / games.length).toFixed(2));
}

function parseGameDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

export const _testing = { gameLogPath, parseMinutes, parseGameDate, gamesAvg, GAMELOG_TABLE_IDS };
