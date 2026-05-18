// api/_lib/wnba/wnbaTeamData.js
//
// WNBA TEAM DATA MODULE (May 16, 2026 — Session 2)
//
// Provides team-level inputs for the engine's possessionEnvironment and
// matchupEngine layers:
//   - pace, offensive/defensive rating
//   - rebound percentage allowed
//   - assist percentage allowed
//   - turnover pressure
//   - shooting profile allowed (3pt, paint, etc.)
//
// Note: WNBA doesn't expose all the same "allowed" splits that NBA does.
// We compute league-relative scores (0-100 scale) where possible and fall
// back to neutral defaults where data isn't available.

import { fetchWnbaStats, parseResultSet, _testing as apiTesting } from './wnbaStatsApi.js';

// =============================================================
// TEAM ROSTER (for player ID → team lookup)
// =============================================================

/**
 * Get a team's current roster.
 * Endpoint: /stats/commonteamroster
 */
export async function getTeamRoster(teamId, season = 2026) {
  const response = await fetchWnbaStats('/commonteamroster', {
    LeagueID: '10',
    TeamID: String(teamId),
    Season: String(season)
  }, { ttlMs: apiTesting.TTL.roster });
  if (!response) return [];
  return parseResultSet(response, 'CommonTeamRoster');
}

// =============================================================
// TEAM STATS — BASE + ADVANCED
// =============================================================

/**
 * Get all teams' base + advanced stats for the season.
 * One call covers the whole league; we filter for the team(s) we need.
 *
 * Endpoint: /stats/leaguedashteamstats
 */
export async function listAllTeamsBase(season = 2026) {
  const response = await fetchWnbaStats('/leaguedashteamstats', {
    LeagueID: '10',
    Season: String(season),
    SeasonType: 'Regular Season',
    PerMode: 'PerGame',
    MeasureType: 'Base',
    PaceAdjust: 'N',
    PlusMinus: 'N',
    Rank: 'N',
    LastNGames: '0',
    Month: '0',
    OpponentTeamID: '0',
    Period: '0',
    GameSegment: '',
    Location: '',
    Outcome: '',
    SeasonSegment: '',
    DateFrom: '',
    DateTo: '',
    TeamID: '0',
    VsConference: '',
    VsDivision: ''
  }, { ttlMs: apiTesting.TTL.teamStats });
  if (!response) return [];
  return parseResultSet(response, 'LeagueDashTeamStats');
}

export async function listAllTeamsAdvanced(season = 2026) {
  const response = await fetchWnbaStats('/leaguedashteamstats', {
    LeagueID: '10',
    Season: String(season),
    SeasonType: 'Regular Season',
    PerMode: 'PerGame',
    MeasureType: 'Advanced',     // includes PACE, DEF_RATING, OFF_RATING, etc.
    PaceAdjust: 'N',
    PlusMinus: 'N',
    Rank: 'N',
    LastNGames: '0',
    Month: '0',
    OpponentTeamID: '0',
    Period: '0',
    GameSegment: '',
    Location: '',
    Outcome: '',
    SeasonSegment: '',
    DateFrom: '',
    DateTo: '',
    TeamID: '0',
    VsConference: '',
    VsDivision: ''
  }, { ttlMs: apiTesting.TTL.teamStats });
  if (!response) return [];
  return parseResultSet(response, 'LeagueDashTeamStats');
}

/**
 * Get "opponent stats" — what stats teams allow when playing this team's defense.
 * This is what we need for matchupEngine's reboundAllowed, assistAllowed, etc.
 *
 * Endpoint: /stats/leaguedashteamstats with MeasureType=Opponent
 */
export async function listAllTeamsOpponent(season = 2026) {
  const response = await fetchWnbaStats('/leaguedashteamstats', {
    LeagueID: '10',
    Season: String(season),
    SeasonType: 'Regular Season',
    PerMode: 'PerGame',
    MeasureType: 'Opponent',
    PaceAdjust: 'N',
    PlusMinus: 'N',
    Rank: 'N',
    LastNGames: '0',
    Month: '0',
    OpponentTeamID: '0',
    Period: '0',
    GameSegment: '',
    Location: '',
    Outcome: '',
    SeasonSegment: '',
    DateFrom: '',
    DateTo: '',
    TeamID: '0',
    VsConference: '',
    VsDivision: ''
  }, { ttlMs: apiTesting.TTL.teamStats });
  if (!response) return [];
  return parseResultSet(response, 'LeagueDashTeamStats');
}

// =============================================================
// MERGED TEAM STATS — the function the engine consumes
// =============================================================

/**
 * Get all team stats merged into the shape `possessionEnvironment.js` and
 * `matchupEngine.js` expect.
 *
 * Returns: { TEAM_ABBR: { pace, defRating, rimProtection, reboundAllowed, ... } }
 *
 * @param {number} season
 * @returns {Promise<Object>} keyed by team abbreviation
 */
export async function getAllTeamStats(season = 2026) {
  const [base, advanced, opponent] = await Promise.all([
    listAllTeamsBase(season),
    listAllTeamsAdvanced(season),
    listAllTeamsOpponent(season)
  ]);

  // Build league averages for normalization (used for "allowed" scoring)
  const leagueAvgs = computeLeagueAverages(opponent);

  const merged = {};
  for (const team of base) {
    const abbr = team.TEAM_ABBREVIATION;
    if (!abbr) continue;

    const adv = advanced.find(t => t.TEAM_ID === team.TEAM_ID) || {};
    const opp = opponent.find(t => t.TEAM_ID === team.TEAM_ID) || {};

    merged[abbr] = {
      teamId: Number(team.TEAM_ID),
      name: team.TEAM_NAME,
      abbr,
      gamesPlayed: Number(team.GP),

      // Pace and rating — direct from advanced stats
      pace: Number(adv.PACE) || 80,                  // WNBA average ~80
      offRating: Number(adv.OFF_RATING) || 100,
      defRating: Number(adv.DEF_RATING) || 100,
      netRating: Number(adv.NET_RATING) || 0,

      // Opponent shooting profile — what THIS team allows
      // Score relative to league: 0 = elite defense, 100 = leaky defense
      reboundAllowed: scoreVsLeague(opp.OPP_REB, leagueAvgs.OPP_REB),
      assistAllowed: scoreVsLeague(opp.OPP_AST, leagueAvgs.OPP_AST),
      threeAllowed: scoreVsLeague(opp.OPP_FG3M, leagueAvgs.OPP_FG3M),

      // Rim protection: lower opponent FG% inside is better defense.
      // Without /shotchart breakdown, use overall opponent FG% as proxy.
      // 100 = elite rim protection (low opp FG%), 0 = weak.
      rimProtection: scoreVsLeague(opp.OPP_FG_PCT, leagueAvgs.OPP_FG_PCT, true),

      // Paint points: not directly available; use opp 2PM as approximation
      paintPointsAllowed: scoreVsLeague(opp.OPP_PTS, leagueAvgs.OPP_PTS),

      // Foul rate — this team's own foul rate (used by environment for FT boost)
      foulRate: Number(base.find(t => t.TEAM_ID === team.TEAM_ID)?.PF) || 21,

      // Turnover pressure: how often opponents turn over the ball vs this team
      turnoverPressure: scoreVsLeague(opp.OPP_TOV, leagueAvgs.OPP_TOV),

      // Switch/drop rates not available from this endpoint; leave as neutral.
      switchRate: 50,
      dropRate: 50,

      // Raw values for debugging
      _raw: {
        PACE: Number(adv.PACE),
        DEF_RATING: Number(adv.DEF_RATING),
        OFF_RATING: Number(adv.OFF_RATING),
        OPP_REB: Number(opp.OPP_REB),
        OPP_AST: Number(opp.OPP_AST),
        OPP_FG3M: Number(opp.OPP_FG3M),
        OPP_FG_PCT: Number(opp.OPP_FG_PCT),
        OPP_TOV: Number(opp.OPP_TOV)
      }
    };
  }

  return merged;
}

/**
 * Get team stats for one team by abbreviation.
 * Convenience wrapper around getAllTeamStats.
 */
export async function getTeamStats(abbr, season = 2026) {
  const all = await getAllTeamStats(season);
  return all[abbr] || null;
}

// =============================================================
// LEAGUE AVERAGE HELPERS
// =============================================================

/**
 * Compute league average for relevant opponent fields. Used to normalize
 * per-team "allowed" stats to a 0-100 scale.
 */
function computeLeagueAverages(opponentRows) {
  if (!Array.isArray(opponentRows) || opponentRows.length === 0) return {};

  const sums = {};
  const counts = {};
  const fields = ['OPP_REB', 'OPP_AST', 'OPP_FG3M', 'OPP_FG_PCT', 'OPP_PTS', 'OPP_TOV'];
  for (const f of fields) {
    sums[f] = 0;
    counts[f] = 0;
  }

  for (const row of opponentRows) {
    for (const f of fields) {
      const v = Number(row[f]);
      if (Number.isFinite(v)) {
        sums[f] += v;
        counts[f] += 1;
      }
    }
  }

  const avgs = {};
  for (const f of fields) {
    avgs[f] = counts[f] > 0 ? sums[f] / counts[f] : 0;
  }
  return avgs;
}

/**
 * Score a team's stat vs league average on a 0-100 scale.
 * Default: higher value = higher score (e.g. opp rebounds allowed → 90 = allows lots of rebounds).
 * inverse=true: lower value = higher score (e.g. opp FG% → 90 = great rim protection).
 *
 * @param {number} value - team's value
 * @param {number} leagueAvg - league average
 * @param {boolean} inverse - flip the scale
 * @returns {number} 0-100 score
 */
function scoreVsLeague(value, leagueAvg, inverse = false) {
  const v = Number(value);
  const a = Number(leagueAvg);

  if (!Number.isFinite(v) || !Number.isFinite(a) || a === 0) return 50;

  // Ratio of team value to league avg. 1.0 = exactly league average.
  // Map to 0-100 such that:
  //   ratio of 0.80 → score 30 (well below avg)
  //   ratio of 1.00 → score 50 (avg)
  //   ratio of 1.20 → score 70 (well above avg)
  // Capped at [0, 100].
  const ratio = v / a;
  let score = 50 + (ratio - 1) * 100;  // 1% deviation = 1 point change
  if (inverse) score = 100 - score;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// =============================================================
// EXPORTS FOR TESTING
// =============================================================

export const _testing = {
  computeLeagueAverages,
  scoreVsLeague
};
