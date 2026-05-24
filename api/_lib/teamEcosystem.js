// api/_lib/teamEcosystem.js
//
// TEAM OFFENSIVE ECOSYSTEM (May 23, 2026)
//
// PURPOSE
//   Provides the team-level offensive context that was missing from the
//   compound probability engine. A hitter's individual quality is necessary
//   but not sufficient for predicting compound prop outcomes — the lineup
//   around them determines:
//     - How many PAs they actually get (lineup turnover)
//     - Whether they score after reaching base (teammates driving them in)
//     - Whether they drive in runs (teammates getting on ahead of them)
//
//   Without these, the engine inflates compound props for hitters embedded
//   in dead offenses (e.g. White Sox, Athletics, Marlins-tier teams) and
//   underweights hitters in run-producing ecosystems (Dodgers, Yankees,
//   Diamondbacks at home).
//
// DATA SOURCE
//   MLB Stats API public endpoint:
//   https://statsapi.mlb.com/api/v1/teams/{teamId}/stats?stats=season&group=hitting
//   No auth required. Returns the standard hitting stat block including OBP,
//   OPS, runs, LOB, RISP, etc.
//
// CACHING
//   Team season stats change slowly (10-day moving averages drift ~0.005 OBP
//   per week). We cache for 12 hours per team. Memory only — no persistence.
//
// FALLBACK
//   If the fetch fails or returns garbage, we return a NEUTRAL profile (league
//   average) rather than null. Downstream code can treat this as "no signal"
//   without crashing. We flag it via `audit.source = 'fallback'` so we can
//   detect missing data in the audit.

const teamCache = new Map();  // key: `${teamId}-${season}`, val: { fetchedAt, profile }
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;  // 12 hours

// League-average benchmarks (2024-2025 MLB). Used as fallback profile and as
// the normalization anchor for downstream calculations.
export const LEAGUE_ECOSYSTEM = Object.freeze({
  obp: 0.318,           // league avg OBP
  ops: 0.715,           // league avg OPS
  runsPerGame: 4.45,    // league avg R/G
  lobPerGame: 6.85,     // league avg LOB/game
  risp: 0.243,          // league avg BA with runners in scoring position
  woba: 0.315,          // league avg wOBA (anchor)
  gamesPlayed: 50       // typical mid-season sample size for stability scoring
});

/**
 * Fetch a team's season hitting profile.
 *
 * @param {number|string} teamId - MLB team ID (e.g. 145 = WSox)
 * @param {number} [season] - 4-digit year, defaults to current
 * @returns {Promise<Object>} {
 *   obp, ops, runsPerGame, lobPerGame, risp, woba,
 *   gamesPlayed, sampleSize, audit: { source, fetchedAt, teamId, season }
 * }
 */
export async function getTeamEcosystem(teamId, season) {
  if (!teamId) return fallbackProfile(teamId, season, 'no_team_id');

  const yr = season || new Date().getFullYear();
  const cacheKey = `${teamId}-${yr}`;
  const cached = teamCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.profile;
  }

  const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${yr}`;
  let json;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return fallbackProfile(teamId, yr, `http_${res.status}`);
    }
    json = await res.json();
  } catch (err) {
    return fallbackProfile(teamId, yr, `fetch_error: ${err.message}`);
  }

  // Parse the response. MLB Stats API nests stats under stats[0].splits[0].stat.
  // Fields are strings — convert numerically.
  const stat = json?.stats?.[0]?.splits?.[0]?.stat;
  if (!stat || typeof stat !== 'object') {
    return fallbackProfile(teamId, yr, 'no_stat_block');
  }

  // Parse with defensive numeric coercion. MLB returns strings like ".318" or "318".
  const num = (v, fallback) => {
    if (v == null) return fallback;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const games = num(stat.gamesPlayed, 1);
  const runs = num(stat.runs, 0);
  const lob = num(stat.leftOnBase, 0);

  const profile = {
    obp:          num(stat.obp, LEAGUE_ECOSYSTEM.obp),
    ops:          num(stat.ops, LEAGUE_ECOSYSTEM.ops),
    runsPerGame:  games > 0 ? runs / games : LEAGUE_ECOSYSTEM.runsPerGame,
    lobPerGame:   games > 0 ? lob / games  : LEAGUE_ECOSYSTEM.lobPerGame,
    // RISP: MLB API exposes this as a separate split request. For now, derive
    // an approximate from team batting context. If we need true RISP later,
    // it's a second API call to /stats?group=hitting&sitCodes=risp.
    risp:         num(stat.avg, LEAGUE_ECOSYSTEM.risp),  // season BA as proxy until split-fetched
    woba:         deriveWobaFromObpSlg(num(stat.obp, LEAGUE_ECOSYSTEM.obp), num(stat.slg, LEAGUE_ECOSYSTEM.ops - LEAGUE_ECOSYSTEM.obp)),
    gamesPlayed:  games,
    sampleSize:   games >= 20 ? 'stable' : games >= 10 ? 'building' : 'low',
    audit: {
      source: 'mlb_stats_api',
      fetchedAt: Date.now(),
      teamId,
      season: yr,
      rawObp: stat.obp,
      rawRuns: runs,
      rawGames: games
    }
  };

  teamCache.set(cacheKey, { fetchedAt: Date.now(), profile });
  return profile;
}

/**
 * Fetch ecosystems for both teams in a game, in parallel.
 */
export async function getGameEcosystems(awayTeamId, homeTeamId, season) {
  const [away, home] = await Promise.all([
    getTeamEcosystem(awayTeamId, season),
    getTeamEcosystem(homeTeamId, season)
  ]);
  return { away, home };
}

/**
 * Compute the lineup continuation factor for a team given their season OBP.
 *
 * This factor scales `expectedPa` for hitters on this team. A team with OBP
 * 0.350 (above league) extends innings more, so hitters see more PAs. A team
 * with OBP 0.280 (well below league) cuts innings short.
 *
 * Anchored at league avg = 1.0. Sub-linear to dampen tails.
 *
 *   OBP 0.350 → factor 1.06  (top-5 offense)
 *   OBP 0.318 → factor 1.00  (league avg)
 *   OBP 0.290 → factor 0.94  (below avg)
 *   OBP 0.260 → factor 0.86  (dead offense — Sheets/Langeliers tier)
 *
 * Exponent 0.7 dampens the effect so we don't fully halve PAs for a 25% OBP
 * team. PA loss is real but capped — the worst lineups still go through their
 * order roughly once and a half.
 */
export function lineupContinuationFactor(teamObp) {
  const obp = Number.isFinite(teamObp) ? teamObp : LEAGUE_ECOSYSTEM.obp;
  return Math.pow(obp / LEAGUE_ECOSYSTEM.obp, 0.7);
}

/**
 * Compute the team's R/PA-on-base conditional rate.
 *
 * Given the hitter reaches base, what's the probability he scores? This is the
 * "teammates driving him in" signal. Approximate as:
 *
 *   pScore | onBase = team R/G ÷ team times-on-base/G
 *
 * Derives an approximate from runs + lob: runs / (runs + lob) ≈ score-rate.
 * Anchored at league avg ~0.31.
 *
 * If we don't have R/G + LOB data, fall back to 0.31.
 */
export function teamRunConversionRate(ecosystem) {
  const e = ecosystem || {};
  if (!Number.isFinite(e.runsPerGame) || !Number.isFinite(e.lobPerGame)) {
    return 0.31;  // league avg
  }
  const totalOnBase = e.runsPerGame + e.lobPerGame;
  if (totalOnBase <= 0) return 0.31;
  const rate = e.runsPerGame / totalOnBase;
  // Bound to [0.20, 0.42] — extreme values usually indicate small sample
  return Math.max(0.20, Math.min(0.42, rate));
}

/**
 * Inning-extension probability. Composite signal:
 *   - Team OBP (does the lineup get on?)
 *   - Team R/G (does the lineup produce?)
 *   - Inverted LOB (do they convert opportunities or strand?)
 *
 * Higher = lineup turns over more, hitter sees more PAs.
 * Range: 0.85 to 1.15, anchored at 1.0 = league avg.
 */
export function inningExtensionFactor(ecosystem) {
  const e = ecosystem || LEAGUE_ECOSYSTEM;
  const obpRatio = (e.obp || LEAGUE_ECOSYSTEM.obp) / LEAGUE_ECOSYSTEM.obp;
  const rpgRatio = (e.runsPerGame || LEAGUE_ECOSYSTEM.runsPerGame) / LEAGUE_ECOSYSTEM.runsPerGame;
  // LOB inverted — high LOB means strands runners, which DOESN'T extend innings
  // (a runner gets stranded when the inning ends with him on base; that's not
  // good news for hitter PA count). Normalize as ratio.
  const lobRatio = LEAGUE_ECOSYSTEM.lobPerGame / (e.lobPerGame || LEAGUE_ECOSYSTEM.lobPerGame);

  // Weighted geometric mean. Sublinear so tails don't blow up.
  const composite = Math.pow(obpRatio, 0.45)
                  * Math.pow(rpgRatio, 0.35)
                  * Math.pow(lobRatio, 0.20);

  // Clamp to a reasonable band — even the worst team plays through 9 innings
  return Math.max(0.85, Math.min(1.15, composite));
}

// --- Internal helpers ---

function deriveWobaFromObpSlg(obp, slg) {
  // Rough approximation: wOBA ≈ 0.7*OBP + 0.3*SLG (calibrated to league avg)
  // Not a substitute for true wOBA but gives a comparable single-stat anchor.
  if (!Number.isFinite(obp) || !Number.isFinite(slg)) return LEAGUE_ECOSYSTEM.woba;
  return 0.7 * obp + 0.3 * slg;
}

function fallbackProfile(teamId, season, reason) {
  return {
    ...LEAGUE_ECOSYSTEM,
    sampleSize: 'fallback',
    audit: {
      source: 'fallback',
      reason,
      teamId,
      season,
      fetchedAt: Date.now()
    }
  };
}
