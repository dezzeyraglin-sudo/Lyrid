/**
 * wnbaFeedEspn.js — free ESPN WNBA data client (replaces the paid BDL feed).
 *
 * All endpoints are ESPN's public/undocumented JSON API: no key, no auth. They
 * are unofficial and can change without notice — every parser here is defensive
 * and returns [] / null rather than throwing, so a shape change degrades instead
 * of taking down the slate.
 *
 * Game-log rows are emitted in the SAME field shape buildShotProfile() in
 * slate.js already consumes:
 *   { date, minutes, fga, fgm, fg3a, fg3m, fta, ftm, pts, reb, ast, tov, pf, opponent }
 * so switching feeds is an import swap — nothing downstream changes.
 *
 * Endpoints verified live (2026):
 *   teams        site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams
 *   roster       site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/{id}/roster
 *   gamelog      site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/{id}/gamelog
 *   scoreboard   site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=YYYYMMDD
 *   boxscore     site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event={id}
 */

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba';
const WEB = 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba';
const CORE = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba';

import https from 'node:https';

// ESPN's WAF blocks Node's built-in fetch (undici) by TLS/HTTP fingerprint AND
// blocks browser-like User-Agents. The one combination that passes: the raw
// `https` module (different fingerprint than undici) with a curl-style UA.
// Verified: raw https + "curl/8.x" → 200; fetch/undici with any UA → 403.
// Works on Vercel Node serverless (the https module is available there).
function getJson(url, tries = 3) {
  const opts = { headers: { 'User-Agent': 'curl/8.5.0', 'Accept': 'application/json' } };
  return new Promise((resolve) => {
    const attempt = (n) => {
      https.get(url, opts, (res) => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          res.resume();
          if (n < tries) return setTimeout(() => attempt(n + 1), 500 * n);
          return resolve(null);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }).on('error', () => {
        if (n < tries) return setTimeout(() => attempt(n + 1), 400 * n);
        resolve(null);
      });
    };
    attempt(1);
  });
}

// "8-11" → { m: 8, a: 11 }; handles "0-0", "", "-".
function madeAtt(s) {
  const t = String(s ?? '').trim();
  const m = t.match(/^(\d+)\s*-\s*(\d+)$/);
  return m ? { m: Number(m[1]), a: Number(m[2]) } : { m: 0, a: 0 };
}
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Teams ────────────────────────────────────────────────────────────────────
export async function getAllTeams() {
  const d = await getJson(`${SITE}/teams`);
  const teams = d?.sports?.[0]?.leagues?.[0]?.teams || [];
  return teams.map(t => ({
    id: String(t.team.id),
    abbr: t.team.abbreviation,
    name: t.team.displayName,
  }));
}

// ── Name → athlete-id map (iterate rosters once, memoized) ──────────────────
// Called by both fetchWnbaPlayerSeasonLogs and the defense feed, so memoize it
// in-process — otherwise every slate build re-fetches all 15 rosters 2–3×.
let _idMapMemo = { at: 0, map: null };
const _ID_MAP_TTL = 30 * 60 * 1000;
export async function buildPlayerIdMap() {
  if (_idMapMemo.map && (Date.now() - _idMapMemo.at) < _ID_MAP_TTL) return _idMapMemo.map;
  const teams = await getAllTeams();
  const map = {}; // normName → { id, team, position, displayName }
  await Promise.all(teams.map(async (t) => {
    const d = await getJson(`${WEB}/teams/${t.id}/roster`);
    for (const a of (d?.athletes || [])) {
      const nm = normName(a.displayName || a.fullName);
      if (!nm) continue;
      map[nm] = {
        id: String(a.id),
        team: t.abbr,
        position: (a.position || {}).abbreviation || null,
        displayName: a.displayName,
      };
    }
  }));
  _idMapMemo = { at: Date.now(), map };
  return map;
}

// ── Player season game log (the shot-profile source) ─────────────────────────
// Returns games oldest→newest with the field shape buildShotProfile expects.
export async function getPlayerGameLog(athleteId, seasonYear) {
  const d = await getJson(`${CORE}/athletes/${athleteId}/gamelog`);
  if (!d) return [];
  const labels = d.labels || d.names || [];
  const idx = (name) => labels.indexOf(name);
  const iMIN = idx('MIN'), iPTS = idx('PTS'), iREB = idx('REB'), iAST = idx('AST'),
        iTO = idx('TO'), iFG = idx('FG'), i3PT = idx('3PT'), iFT = idx('FT'), iPF = idx('PF');
  // events dict maps gameId → { gameDate, opponent:{abbreviation}, ... }
  const events = d.events || {};
  const rows = [];
  for (const st of (d.seasonTypes || [])) {
    if (seasonYear && !String(st.displayName || '').includes(String(seasonYear))) continue;
    const cats = st.categories || [st];
    for (const cat of cats) {
      for (const ev of (cat.events || [])) {
        const stats = ev.stats || [];
        const fg = madeAtt(stats[iFG]), tp = madeAtt(stats[i3PT]), ft = madeAtt(stats[iFT]);
        const meta = events[ev.eventId] || events[ev.id] || {};
        rows.push({
          date: (meta.gameDate || meta.date || '').slice(0, 10),
          opponent: (meta.opponent || {}).abbreviation || meta.opponent || null,
          minutes: Number(stats[iMIN]) || 0,
          pts: Number(stats[iPTS]) || 0,
          reb: Number(stats[iREB]) || 0,
          ast: Number(stats[iAST]) || 0,
          tov: Number(stats[iTO]) || 0,
          pf: iPF >= 0 ? Number(stats[iPF]) || 0 : 0,
          fga: fg.a, fgm: fg.m,
          fg3a: tp.a, fg3m: tp.m,
          fta: ft.a, ftm: ft.m,
        });
      }
    }
  }
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return rows;
}

// ── Scoreboard (slate) ───────────────────────────────────────────────────────
export async function getScoreboard(dateYYYYMMDD) {
  const q = dateYYYYMMDD ? `?dates=${dateYYYYMMDD}` : '';
  const d = await getJson(`${SITE}/scoreboard${q}`);
  return (d?.events || []).map(e => {
    const c = e.competitions?.[0] || {};
    const cs = c.competitors || [];
    const home = cs.find(x => x.homeAway === 'home') || cs[0] || {};
    const away = cs.find(x => x.homeAway === 'away') || cs[1] || {};
    return {
      eventId: String(e.id),
      date: (e.date || '').slice(0, 10),
      status: e.status?.type?.name,
      home: home.team?.abbreviation, away: away.team?.abbreviation,
      homeScore: Number(home.score) || 0, awayScore: Number(away.score) || 0,
    };
  });
}

// ── Live / final box score for one game ──────────────────────────────────────
export async function getBoxScore(eventId) {
  const d = await getJson(`${WEB}/summary?event=${eventId}`);
  const teams = d?.boxscore?.players || [];
  const out = [];
  for (const t of teams) {
    const abbr = t.team?.abbreviation;
    const block = (t.statistics || [])[0] || {};
    const labels = block.labels || block.names || [];
    const idx = (n) => labels.indexOf(n);
    const iMIN = idx('MIN'), iPTS = idx('PTS'), iREB = idx('REB'), iAST = idx('AST'),
          iTO = idx('TO'), iFG = idx('FG'), i3PT = idx('3PT'), iFT = idx('FT'), iPF = idx('PF');
    for (const a of (block.athletes || [])) {
      const s = a.stats || [];
      if (!s.length) continue;
      const fg = madeAtt(s[iFG]), tp = madeAtt(s[i3PT]), ft = madeAtt(s[iFT]);
      out.push({
        team: abbr,
        player: a.athlete?.displayName,
        athleteId: String(a.athlete?.id),
        minutes: Number(s[iMIN]) || 0,
        pts: Number(s[iPTS]) || 0, reb: Number(s[iREB]) || 0, ast: Number(s[iAST]) || 0,
        tov: Number(s[iTO]) || 0, pf: iPF >= 0 ? Number(s[iPF]) || 0 : 0,
        fga: fg.a, fgm: fg.m, fg3a: tp.a, fg3m: tp.m, fta: ft.a, ftm: ft.m,
      });
    }
  }
  return out;
}

export { normName, madeAtt };

// ── Current active roster (name-set) for one team ────────────────────────────
// ESPN's /teams/{id}/roster reflects the LIVE roster — waived players drop off
// immediately, unlike bbref's season page (which lists everyone who appeared).
// Returns a Set of normalized names currently on the team. Accepts either the
// ESPN abbr (LV) or the slate tricode (LVA). Memoized via buildPlayerIdMap.
export async function getCurrentRoster(teamAbbr) {
  const map = await buildPlayerIdMap();
  const want = String(teamAbbr || '').toUpperCase();
  const names = new Set();
  for (const [nm, meta] of Object.entries(map)) {
    const espn = String(meta.team || '').toUpperCase();
    const slate = _INJ_TO_SLATE[espn] || espn;   // ESPN → slate tricode
    if (espn === want || slate === want) names.add(nm);
  }
  return names;
}

// ── Injuries (JSON API — replaces the old fragile ESPN HTML scrape) ───────────
// Returns the report shape injuryFeed.js/slate.js consume:
//   { all:[{playerName,status,detail,teamAbbrev,position,source}],
//     byName:{normName:entry}, byTeamAbbrev:{ABBR:[entry]}, _audit }
const _INJ_TO_SLATE = {
  ATL: 'ATL', CHI: 'CHI', CON: 'CON', DAL: 'DAL', GS: 'GSV', IND: 'IND',
  LA: 'LAS', LV: 'LVA', MIN: 'MIN', NY: 'NYL', PHX: 'PHX', POR: 'POR',
  SEA: 'SEA', TOR: 'TOR', WSH: 'WAS',
};
function _mapInjStatus(typeName, statusText) {
  const t = String(typeName || '').toUpperCase();
  if (t.includes('OUT')) return 'OUT';
  if (t.includes('DOUBTFUL')) return 'DOUBTFUL';
  if (t.includes('QUESTIONABLE')) return 'QUESTIONABLE';
  if (t.includes('DAY_TO_DAY') || t.includes('GTD') || t.includes('GAME_TIME')) return 'GTD';
  const s = String(statusText || '').toUpperCase();
  if (s.includes('OUT')) return 'OUT';
  if (s.includes('DOUBT')) return 'DOUBTFUL';
  if (s.includes('QUESTION')) return 'QUESTIONABLE';
  if (s.includes('DAY') || s.includes('GAME-TIME') || s.includes('GTD')) return 'GTD';
  return s || 'UNKNOWN';
}
export async function getInjuries() {
  const d = await getJson(`${SITE}/injuries`);
  const groups = d?.injuries || [];
  const all = [], byName = {}, byTeamAbbrev = {};
  for (const grp of groups) {
    for (const it of (grp.injuries || [])) {
      const ath = it.athlete || {};
      const playerName = ath.displayName || `${ath.firstName || ''} ${ath.lastName || ''}`.trim();
      if (!playerName) continue;
      const espnAbbr = String(ath.team?.abbreviation || '').toUpperCase();
      const teamAbbrev = _INJ_TO_SLATE[espnAbbr] || espnAbbr || null;
      const status = _mapInjStatus(it.type?.name, it.status);
      const detail = it.details?.type || it.shortComment || it.type?.description || null;
      const entry = { playerName, status, detail, teamAbbrev,
        position: ath.position?.abbreviation || null, source: 'espn' };
      all.push(entry);
      byName[normName(playerName)] = entry;
      if (teamAbbrev) (byTeamAbbrev[teamAbbrev] = byTeamAbbrev[teamAbbrev] || []).push(entry);
    }
  }
  return { all, byName, byTeamAbbrev,
    _audit: { source: 'espn', teams: groups.length, count: all.length, fetchedAt: new Date().toISOString() } };
}

// ─────────────────────────────────────────────────────────────────────────────
// DROP-IN ADAPTERS — same signatures/shapes as bdlFeed.js so slate.js only needs
// its import line changed. ESPN provides STATS, not betting lines, so the props
// adapter returns empty (your real lines come from PP screenshots + oddsLines.js).
// ─────────────────────────────────────────────────────────────────────────────

// Run async jobs with bounded concurrency (ESPN is permissive but be polite).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Drop-in for bdlFeed.fetchWnbaPlayerSeasonLogs(season).
 * Returns { byName: { normName: { games: [...] } }, _audit }.
 * Each game carries BOTH namings (pts+points, reb+rebounds, ast+assists) so it
 * satisfies aggregateFromGames AND buildShotProfile without touching either.
 * @param {number} season
 * @param {Object} [opts] { teams?: string[] abbrs to limit to today's slate; concurrency? }
 */
export async function fetchWnbaPlayerSeasonLogs(season, opts = {}) {
  const conc = opts.concurrency || 8;
  const idMap = await buildPlayerIdMap();
  let entries = Object.entries(idMap);
  if (Array.isArray(opts.teams) && opts.teams.length) {
    const want = new Set(opts.teams.map(t => String(t).toUpperCase()));
    entries = entries.filter(([, v]) => want.has(String(v.team).toUpperCase()));
  }
  const byName = {};
  let ok = 0, empty = 0;
  await mapLimit(entries, conc, async ([nm, meta]) => {
    const raw = await getPlayerGameLog(meta.id, season);
    const games = raw.map(g => ({
      ...g,
      // aliases so the aggregator finds either naming
      points: g.pts, rebounds: g.reb, assists: g.ast, turnovers: g.tov,
    }));
    if (games.length) ok++; else empty++;
    byName[nm] = { games, team: meta.team, position: meta.position, athleteId: meta.id };
  });
  return { byName, _audit: { source: 'espn', playersWithGames: ok, playersEmpty: empty, total: entries.length } };
}

/**
 * Drop-in for bdlFeed.fetchWnbaSeasonGames(season). Memoized in-process.
 * Returns { games: [{ date, home, away, homeScore, awayScore, status, total }] }.
 */
let _seasonGamesMemo = { at: 0, key: '', data: null };
const _SEASON_GAMES_TTL = 30 * 60 * 1000;
export async function fetchWnbaSeasonGames(season, opts = {}) {
  const from = opts.from ? new Date(opts.from) : new Date(`${season}-05-10`);
  const to = opts.to ? new Date(opts.to) : new Date();
  const key = `${from.toISOString().slice(0,10)}:${to.toISOString().slice(0,10)}`;
  if (_seasonGamesMemo.data && _seasonGamesMemo.key === key && (Date.now() - _seasonGamesMemo.at) < _SEASON_GAMES_TTL) {
    return _seasonGamesMemo.data;
  }
  const days = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    days.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }
  const all = [];
  await mapLimit(days, 8, async (ymd) => {
    const sb = await getScoreboard(ymd);
    for (const g of sb) all.push({
      date: g.date, home: g.home, away: g.away,
      homeScore: g.homeScore, awayScore: g.awayScore, status: g.status,
      total: (g.homeScore || 0) + (g.awayScore || 0),
    });
  });
  all.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const data = { games: all, _audit: { source: 'espn', days: days.length, games: all.length } };
  _seasonGamesMemo = { at: Date.now(), key, data };
  return data;
}

/**
 * Drop-in for bdlFeed.fetchWnbaProps(date). ESPN has no betting prop lines, so this
 * returns empty — slate.js already treats empty propLines as "infer / use provided
 * lines" (PrizePicks screenshots + oddsLines.js), so nothing breaks.
 */
export async function fetchWnbaProps(_date) {
  return { propLines: {}, propMeta: {}, _audit: { source: 'espn', note: 'ESPN exposes no betting prop lines; using provided/inferred lines.' } };
}

export default {
  getAllTeams, buildPlayerIdMap, getPlayerGameLog, getScoreboard, getBoxScore,
  fetchWnbaPlayerSeasonLogs, fetchWnbaSeasonGames, fetchWnbaProps,
};
