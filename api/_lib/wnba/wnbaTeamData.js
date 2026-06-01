// api/_lib/wnba/wnbaTeamData.js
//
// WNBA TEAM DATA MODULE (June 1, 2026 — basketball-reference migration)
//
// HISTORY:
//   Session 2 (May 16) — built against stats.wnba.com /leaguedashteamstats
//   June 1 — migrated to basketball-reference. stats.wnba.com is unreachable
//     from Vercel; this module's dead calls were the largest single source of
//     slate latency (timeout+retry on every call). Now sourced from bbref team
//     pages, which respond in ~96ms and cache for an hour.
//
// CONTRACT (UNCHANGED): getAllTeamStats(season) → { ABBR: {...} } and
//   getTeamStats(abbr, season) → {...}. The merged per-team shape matches the
//   previous version so matchupEngine.js and possessionEnvironment.js are
//   unaffected: { pace, offRating, defRating, netRating, reboundAllowed,
//   assistAllowed, threeAllowed, rimProtection, paintPointsAllowed, foulRate,
//   turnoverPressure, switchRate, dropRate, _raw }.
//
// SOURCE (verified live June 1):
//   /wnba/teams/{ABBR}/{season}.html
//   The team/opponent summary table carries BOTH the team's own per-game stats
//   (unprefixed, e.g. pts_per_g) and opponent allowed stats (opp_ prefixed,
//   e.g. opp_pts_per_g, opp_fg_pct, opp_trb_per_g). We locate that table by the
//   presence of `opp_pts_per_g` and flat-extract its cells — robust to table id.
//
//   PACE + RATINGS: bbref WNBA does NOT publish team pace / OFF_RTG / DEF_RTG as
//   plain fields (only per-player leaderboards). We DERIVE them from the
//   possession estimate using team + opponent shot/rebound/turnover counts that
//   ARE present. Standard formula; flagged in _raw.paceSource.
//
//   SWITCH/DROP coverage rates remain unavailable (no public source) → neutral 50,
//   same as before. matchupEngine treats 50 as neutral.

import { fetchBbrefPage, unwrapCommentedTables } from './bbrefClient.js';

// The 15 WNBA franchises (tricodes match the rest of the codebase / injuryFeed).
const WNBA_TEAMS = ['ATL', 'CHI', 'CON', 'DAL', 'GSV', 'IND', 'LVA', 'LAS', 'MIN', 'NYL', 'PHX', 'POR', 'SEA', 'TOR', 'WAS'];

const TTL_MS = 60 * 60 * 1000;
const _cache = new Map();

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }

function toNum(v) {
  if (v == null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// =============================================================
// FLAT CELL EXTRACTION
// =============================================================
// Pull every data-stat→text cell out of a chunk of table HTML into one map.
// Used on the team/opponent summary table, where each stat is a distinct
// (prefixed) data-stat so there are no collisions.

function flattenCells(tableHtml) {
  const cells = {};
  const re = /data-stat="([a-z0-9_]+)"[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
  let m;
  while ((m = re.exec(tableHtml)) !== null) {
    const stat = m[1];
    const text = m[2].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!(stat in cells) && text !== '') cells[stat] = text; // first non-empty wins
  }
  return cells;
}

// Find the <table> whose body contains a given data-stat, return its HTML.
function findTableContaining(html, dataStat) {
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    if (m[0].includes(`data-stat="${dataStat}"`)) return m[0];
  }
  return null;
}

// =============================================================
// PER-TEAM FETCH
// =============================================================

/**
 * Fetch + parse one team's page into a flat stat map.
 * @returns {Promise<Object|null>} flat { pts_per_g, opp_pts_per_g, ... } or null
 */
async function fetchTeamCells(abbr, season) {
  const html = await fetchBbrefPage(`/wnba/teams/${abbr}/${season}.html`, { ttlMs: TTL_MS });
  if (!html) return null;
  const unwrapped = unwrapCommentedTables(html);
  const tableHtml = findTableContaining(unwrapped, 'opp_pts_per_g');
  if (!tableHtml) {
    console.warn(`[wnbaTeamData] no team/opponent table for ${abbr} (${season})`);
    return null;
  }
  return flattenCells(tableHtml);
}

// =============================================================
// DERIVE PACE + RATINGS FROM POSSESSIONS
// =============================================================
// poss/game ≈ 0.5 * ((FGA + 0.44*FTA - ORB + TOV) + opp equivalents)
// Pace ≈ possessions per game for a 40-min WNBA game.
// ORtg = 100 * team pts / poss ; DRtg = 100 * opp pts / poss

function derivePaceAndRatings(c) {
  const fga = toNum(c.fga_per_g), fta = toNum(c.fta_per_g), orb = toNum(c.orb_per_g), tov = toNum(c.tov_per_g);
  const ofga = toNum(c.opp_fga_per_g), ofta = toNum(c.opp_fta_per_g), oorb = toNum(c.opp_orb_per_g), otov = toNum(c.opp_tov_per_g);
  const pts = toNum(c.pts_per_g), opts = toNum(c.opp_pts_per_g);

  const teamPoss = Number.isFinite(fga) ? (fga + 0.44 * (fta || 0) - (orb || 0) + (tov || 0)) : NaN;
  const oppPoss = Number.isFinite(ofga) ? (ofga + 0.44 * (ofta || 0) - (oorb || 0) + (otov || 0)) : NaN;

  let pace = NaN, paceSource = 'unavailable';
  if (Number.isFinite(teamPoss) && Number.isFinite(oppPoss)) {
    pace = 0.5 * (teamPoss + oppPoss); paceSource = 'derived_possessions';
  } else if (Number.isFinite(teamPoss)) {
    pace = teamPoss; paceSource = 'derived_team_only';
  }

  const offRating = (Number.isFinite(pts) && Number.isFinite(pace) && pace > 0) ? (100 * pts / pace) : NaN;
  const defRating = (Number.isFinite(opts) && Number.isFinite(pace) && pace > 0) ? (100 * opts / pace) : NaN;

  return { pace, offRating, defRating, paceSource };
}

// =============================================================
// MERGED TEAM STATS (engine-facing) — same contract as before
// =============================================================

export async function getAllTeamStats(season = 2026) {
  const cacheKey = `allTeams:${season}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Fetch all teams in parallel (cached individually by bbrefClient too).
  const settled = await Promise.all(
    WNBA_TEAMS.map(async abbr => ({ abbr, cells: await fetchTeamCells(abbr, season).catch(() => null) }))
  );

  const teams = settled.filter(t => t.cells);
  if (teams.length === 0) return {};

  // League averages for the opponent-allowed scoring scale.
  const avg = computeLeagueAverages(teams.map(t => t.cells));

  const merged = {};
  for (const { abbr, cells: c } of teams) {
    const { pace, offRating, defRating, paceSource } = derivePaceAndRatings(c);
    const ownPf = toNum(c.pf_per_g);

    merged[abbr] = {
      teamId: null,            // bbref has no numeric team id; abbr is the key
      name: abbr,
      abbr,
      gamesPlayed: Number(toNum(c.g)) || null,

      pace: Number.isFinite(pace) ? Number(pace.toFixed(1)) : 80,
      offRating: Number.isFinite(offRating) ? Number(offRating.toFixed(1)) : 100,
      defRating: Number.isFinite(defRating) ? Number(defRating.toFixed(1)) : 100,
      netRating: (Number.isFinite(offRating) && Number.isFinite(defRating)) ? Number((offRating - defRating).toFixed(1)) : 0,

      // Opponent allowed → 0-100 (higher = leakier defense / more allowed)
      reboundAllowed: scoreVsLeague(toNum(c.opp_trb_per_g), avg.opp_trb_per_g),
      assistAllowed:  scoreVsLeague(toNum(c.opp_ast_per_g), avg.opp_ast_per_g),
      threeAllowed:   scoreVsLeague(toNum(c.opp_fg3_per_g), avg.opp_fg3_per_g),
      // Rim protection: lower opp FG% = better D = higher score (inverse)
      rimProtection:  scoreVsLeague(toNum(c.opp_fg_pct), avg.opp_fg_pct, true),
      paintPointsAllowed: scoreVsLeague(toNum(c.opp_pts_per_g), avg.opp_pts_per_g),

      foulRate: Number.isFinite(ownPf) ? ownPf : 21,
      turnoverPressure: scoreVsLeague(toNum(c.opp_tov_per_g), avg.opp_tov_per_g),

      switchRate: 50,   // unavailable from bbref — neutral
      dropRate: 50,     // unavailable from bbref — neutral

      _raw: {
        paceSource,
        pts_per_g: toNum(c.pts_per_g),
        opp_pts_per_g: toNum(c.opp_pts_per_g),
        opp_fg_pct: toNum(c.opp_fg_pct),
        opp_fg3_pct: toNum(c.opp_fg3_pct),
        opp_trb_per_g: toNum(c.opp_trb_per_g),
        opp_ast_per_g: toNum(c.opp_ast_per_g),
        opp_tov_per_g: toNum(c.opp_tov_per_g),
        opp_fta_per_g: toNum(c.opp_fta_per_g),
        // surfaced for matchup/whistle work and for deriveOppMissRate in slate.js:
        opp_fg_pct_decimal: Number.isFinite(toNum(c.opp_fg_pct)) ? toNum(c.opp_fg_pct) : null,
        source: 'basketball-reference'
      }
    };
  }

  cacheSet(cacheKey, merged);
  return merged;
}

export async function getTeamStats(abbr, season = 2026) {
  const all = await getAllTeamStats(season);
  return all[String(abbr).toUpperCase()] || null;
}

// =============================================================
// LEAGUE AVERAGES + SCORING (same scale as before)
// =============================================================

function computeLeagueAverages(cellMaps) {
  const fields = ['opp_trb_per_g', 'opp_ast_per_g', 'opp_fg3_per_g', 'opp_fg_pct', 'opp_pts_per_g', 'opp_tov_per_g'];
  const sums = {}, counts = {};
  for (const f of fields) { sums[f] = 0; counts[f] = 0; }
  for (const c of cellMaps) {
    for (const f of fields) {
      const v = toNum(c[f]);
      if (Number.isFinite(v)) { sums[f] += v; counts[f] += 1; }
    }
  }
  const avg = {};
  for (const f of fields) avg[f] = counts[f] > 0 ? sums[f] / counts[f] : 0;
  return avg;
}

function scoreVsLeague(value, leagueAvg, inverse = false) {
  const v = Number(value), a = Number(leagueAvg);
  if (!Number.isFinite(v) || !Number.isFinite(a) || a === 0) return 50;
  const ratio = v / a;
  let score = 50 + (ratio - 1) * 100;
  if (inverse) score = 100 - score;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export const _testing = {
  WNBA_TEAMS, flattenCells, findTableContaining, derivePaceAndRatings,
  computeLeagueAverages, scoreVsLeague, _cache
};
