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

// ── Name → athlete-id map (iterate rosters once, cache upstream) ──────────────
export async function buildPlayerIdMap() {
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
 * Drop-in for bdlFeed.fetchWnbaSeasonGames(season).
 * Returns { games: [{ date, home, away, homeScore, awayScore, status }] } from the
 * ESPN scoreboard across the season window (used by buildEmpiricalTotals; it reads
 * g.date and scores). Walks day-by-day from the season opener to the slate date.
 * @param {number} season
 * @param {Object} [opts] { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
 */
export async function fetchWnbaSeasonGames(season, opts = {}) {
  // WNBA season roughly mid-May → late-Sept; default to that window for the year.
  const from = opts.from ? new Date(opts.from) : new Date(`${season}-05-10`);
  const to = opts.to ? new Date(opts.to) : new Date();
  const days = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    days.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }
  const all = [];
  await mapLimit(days, 6, async (ymd) => {
    const sb = await getScoreboard(ymd);
    for (const g of sb) all.push({
      date: g.date, home: g.home, away: g.away,
      homeScore: g.homeScore, awayScore: g.awayScore, status: g.status,
      total: (g.homeScore || 0) + (g.awayScore || 0),
    });
  });
  all.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { games: all, _audit: { source: 'espn', days: days.length, games: all.length } };
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
