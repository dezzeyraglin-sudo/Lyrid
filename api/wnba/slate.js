// api/wnba/slate.js
//
// WNBA SLATE ENDPOINT (May 16, 2026 — Session 4)
//
// POST /api/wnba/slate
//
// Generates a full slate of prop analyses for a day's WNBA games.
// Top 4 players per team × 3 markets (points, rebounds, assists) per player.
//
// Caller can:
//   - Specify a date (default: today)
//   - Inject betting lines per game (spread, total)
//   - Override default market list
//   - Override default top-N (default: 4 per team)
//
// SCALING NOTES:
//   - 6 games × 2 teams × 4 players × 3 markets = 144 analyses
//   - 5-10 second cold-cache latency
//   - <2 second warm-cache latency (subsequent slate calls in same hour)
//
// FAILURE PHILOSOPHY:
//   - Partial results > nothing
//   - Each (game, player, market) analysis is independent
//   - Failed analyses tagged with error, included in summary
//   - Slate returns even if some sub-fetches fail

import { analyzeBasketballProp } from "../_lib/basketball/basketballProps.js";
import { buildAuditEntry } from "../_lib/basketball/basketballAudit.js";
import { getGamesForDate, getTodaysGames } from "../_lib/wnba/wnbaSchedule.js";
import { getTopPlayersForTeam } from "../_lib/wnba/wnbaPlayerData.js";
import { aggregateRecentForm } from "../_lib/wnba/wnbaGameLog.js";
import { getAllTeamStats } from "../_lib/wnba/wnbaTeamData.js";

// =============================================================
// FEATURE FLAGS
// =============================================================

const WNBA_ENABLED = (() => {
  const v = process.env.WNBA_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
})();

const WNBA_SLATE_ENABLED = (() => {
  const v = process.env.WNBA_SLATE_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
})();

const WNBA_SHADOW_MODE = (() => {
  const v = process.env.WNBA_SHADOW_MODE;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
})();

const WNBA_AUDIT_ENABLED = (() => {
  const v = process.env.WNBA_AUDIT_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
})();

// =============================================================
// DEFAULTS
// =============================================================

const DEFAULT_MARKETS = ['points', 'rebounds', 'assists'];
const DEFAULT_TOP_N = 4;
const DEFAULT_SPREAD = 0;        // pick'em if no line provided
const DEFAULT_TOTAL = 164;       // WNBA league average total

// =============================================================
// SLATE GENERATION
// =============================================================

/**
 * Generate a slate of prop analyses.
 *
 * @param {Object} opts
 * @param {string} opts.date - YYYY-MM-DD (default: today)
 * @param {Array<string>} opts.markets - which markets to analyze (default: points/reb/ast)
 * @param {number} opts.topN - top N players per team (default: 4)
 * @param {Object} opts.lines - betting lines keyed by gameId: { gameId: { spread, total, propLines: { playerName_market: line }}}
 * @param {number} opts.season - WNBA season year
 * @returns {Promise<Object>} slate result with games + analyses
 */
async function generateSlate(opts = {}) {
  const date = opts.date || new Date().toISOString().split('T')[0];
  const markets = Array.isArray(opts.markets) && opts.markets.length ? opts.markets : DEFAULT_MARKETS;
  const topN = Number(opts.topN) || DEFAULT_TOP_N;
  const lines = opts.lines || {};
  const season = Number(opts.season) || new Date().getFullYear();

  const startedAt = Date.now();
  const warnings = [];

  // STEP 1: Get games for the date
  const games = await getGamesForDate(date).catch(err => {
    warnings.push(`Schedule fetch failed: ${err.message}`);
    return [];
  });

  if (games.length === 0) {
    return {
      date,
      season,
      games: [],
      analyses: [],
      bestPlays: [],
      passes: [],
      warnings: [...warnings, 'No games found for this date'],
      summary: { games: 0, players: 0, analyses: 0, passes: 0, durationMs: Date.now() - startedAt }
    };
  }

  // STEP 2: Pre-fetch team stats once for the whole slate (cache primer)
  const allTeamStats = await getAllTeamStats(season).catch(err => {
    warnings.push(`Team stats fetch failed: ${err.message}`);
    return {};
  });

  // STEP 3: For each game, build the list of (player, market) analyses to run
  const analysisPromises = [];
  const gameContexts = {};  // for output organization

  for (const game of games) {
    const homeAbbr = game.home?.abbr;
    const awayAbbr = game.away?.abbr;
    if (!homeAbbr || !awayAbbr) {
      warnings.push(`Game ${game.gameId} missing team abbreviation`);
      continue;
    }

    const gameLines = lines[game.gameId] || {};
    const spread = Number(gameLines.spread ?? DEFAULT_SPREAD);
    const total = Number(gameLines.total ?? DEFAULT_TOTAL);

    gameContexts[game.gameId] = {
      gameId: game.gameId,
      home: homeAbbr,
      away: awayAbbr,
      gameTimeET: game.gameTimeET,
      status: game.status,
      spread,
      total,
      linesProvided: !!lines[game.gameId]
    };

    // Get top players for both teams in parallel
    const teamPromise = Promise.all([
      getTopPlayersForTeam(homeAbbr, topN, season, 'points').catch(err => {
        warnings.push(`Top players fetch failed for ${homeAbbr}: ${err.message}`);
        return [];
      }),
      getTopPlayersForTeam(awayAbbr, topN, season, 'points').catch(err => {
        warnings.push(`Top players fetch failed for ${awayAbbr}: ${err.message}`);
        return [];
      })
    ]).then(async ([homePlayers, awayPlayers]) => {
      // For each player, for each market, kick off an analysis
      const tasks = [];
      const allPlayers = [
        ...homePlayers.map(p => ({ player: p, isHome: true, opponent: awayAbbr, team: homeAbbr })),
        ...awayPlayers.map(p => ({ player: p, isHome: false, opponent: homeAbbr, team: awayAbbr }))
      ];

      for (const { player, isHome, opponent, team } of allPlayers) {
        // Get recent form once per player (cached for subsequent market calls)
        const recentFormPromise = aggregateRecentForm(player.id, 10, 'points', season).catch(() => null);

        for (const market of markets) {
          tasks.push(
            buildAndRunAnalysis({
              player, isHome, opponent, team, market, season, game, spread, total,
              recentFormPromise, allTeamStats, gameLines
            })
          );
        }
      }

      return Promise.all(tasks);
    });

    analysisPromises.push(teamPromise);
  }

  // STEP 4: Wait for all games to finish
  const gameResults = await Promise.all(analysisPromises);
  const allAnalyses = gameResults.flat().filter(Boolean);

  // STEP 5: Organize output
  const successful = allAnalyses.filter(a => !a.error && a.recommendation !== 'PASS');
  const passes = allAnalyses.filter(a => a.recommendation === 'PASS');
  const errors = allAnalyses.filter(a => a.error);

  // Rank by finalEdge descending — top edges first
  successful.sort((a, b) => {
    const aScore = a.scores?.finalEdge || 0;
    const bScore = b.scores?.finalEdge || 0;
    return bScore - aScore;
  });

  // Top 10 across the slate
  const bestPlays = successful.slice(0, 10);

  return {
    date,
    season,
    games: Object.values(gameContexts),
    analyses: successful,
    passes,
    errors,
    bestPlays,
    warnings,
    summary: {
      games: games.length,
      teams: games.length * 2,
      playersAnalyzed: new Set(allAnalyses.map(a => a.player)).size,
      totalAnalyses: allAnalyses.length,
      recommendations: successful.length,
      passes: passes.length,
      errors: errors.length,
      durationMs: Date.now() - startedAt
    }
  };
}

/**
 * Build the input for one (player, market) pair, run analysis, return result.
 * Catches errors and tags them so they don't break the whole slate.
 */
async function buildAndRunAnalysis({
  player, isHome, opponent, team, market, season, game,
  spread, total, recentFormPromise, allTeamStats, gameLines
}) {
  try {
    // Get opponent team stats from the pre-fetched map
    const opponentTeam = allTeamStats[opponent] || { abbr: opponent };
    const teamData = allTeamStats[team] || { abbr: team };

    // Wait for recent form (was already initiated in parallel)
    const recentForm = await recentFormPromise;

    // CRITICAL: re-derive seasonAvg for THIS market from raw counts.
    // The player object was built by getTopPlayersForTeam with market='points',
    // so player.seasonAvg is the points avg regardless of what we're analyzing.
    // For rebounds analysis we need rebounds avg, for assists we need assists.
    const marketSeasonAvg = pickRawForMarket(player._raw, market);

    // Also adjust last5/last10 if recent form data is available.
    // aggregateRecentForm was called with market='points' for caching reasons,
    // so we need to re-derive the recent-N averages from the game array.
    // The game array is on recentForm.games — use it.
    const last5Avg = recentForm?.games
      ? pickGamesAvgForMarket(recentForm.games.slice(0, 5), market)
      : marketSeasonAvg;
    const last10Avg = recentForm?.games
      ? pickGamesAvgForMarket(recentForm.games.slice(0, 10), market)
      : marketSeasonAvg;

    // Merge recent form + market-specific averages into player
    const playerWithRecent = {
      ...player,
      seasonAvg: marketSeasonAvg,
      last5Avg,
      last10Avg,
      ...(recentForm ? {
        minutesLast5: recentForm.minutesLast5,
        minutesCv: recentForm.minutesCv,
        expectedMinutes: recentForm.minutesAvg
      } : {})
    };

    // Look up line: caller can provide per-prop lines via gameLines.propLines[playerName_market]
    const propLineKey = `${player.name}_${market}`;
    const explicitLine = gameLines.propLines?.[propLineKey];
    const line = Number.isFinite(Number(explicitLine))
      ? Number(explicitLine)
      : inferLineFromPlayer(player, market);

    const input = {
      player: playerWithRecent,
      team: teamData,
      opponent: opponentTeam,
      market,
      line,
      game: {
        spread: isHome ? spread : -spread,   // home perspective by default; flip for away
        total,
        home: isHome,
        restDays: 1,           // TODO: derive from schedule
        backToBack: false      // TODO: derive from schedule
      }
    };

    const result = analyzeBasketballProp(input, 'WNBA');

    return {
      gameId: game.gameId,
      player: player.name,
      team,
      opponent,
      market,
      line: result.line,
      projection: result.projection,
      edge: result.edge,
      recommendation: result.recommendation,
      confidence: result.confidence,
      label: result.label,
      hitRate: result.hitRate,
      scores: result.scores,
      chips: result.chips,
      hardFlags: result.details?.hardFlags || [],
      lineSource: Number.isFinite(Number(explicitLine)) ? 'provided' : 'inferred',
      shadowMode: WNBA_SHADOW_MODE,
      // Diagnostic: data quality
      _dataQuality: player._dataQuality
    };
  } catch (err) {
    return {
      gameId: game.gameId,
      player: player?.name || 'unknown',
      team,
      opponent,
      market,
      error: err.message || 'analysis failed',
      recommendation: 'ERROR'
    };
  }
}

/**
 * Pick the right raw season-avg from player._raw based on market.
 *
 * The player object stored in our list comes from getTopPlayersForTeam which
 * was called with market='points' for caching. To do a rebounds analysis on
 * the same player, we need to swap seasonAvg to the rebounds count.
 */
function pickRawForMarket(raw, market) {
  if (!raw) return 0;
  const m = String(market).toLowerCase();
  if (m.includes('rebound') || m === 'reb') return Number(raw.REB) || 0;
  if (m.includes('assist') || m === 'ast') return Number(raw.AST) || 0;
  if (m.includes('three') || m.includes('3pm')) return Number(raw.FG3M) || 0;
  if (m.includes('pra')) return (Number(raw.PTS) || 0) + (Number(raw.REB) || 0) + (Number(raw.AST) || 0);
  if (m === 'pa') return (Number(raw.PTS) || 0) + (Number(raw.AST) || 0);
  if (m === 'pr') return (Number(raw.PTS) || 0) + (Number(raw.REB) || 0);
  return Number(raw.PTS) || 0;
}

/**
 * Compute average of a stat across a list of games for a given market.
 */
function pickGamesAvgForMarket(games, market) {
  if (!Array.isArray(games) || games.length === 0) return 0;
  const m = String(market).toLowerCase();
  let total = 0;
  for (const g of games) {
    if (m.includes('rebound')) total += g.rebounds || 0;
    else if (m.includes('assist')) total += g.assists || 0;
    else if (m.includes('three') || m.includes('3pm')) total += g.threes || 0;
    else if (m.includes('pra')) total += g.pra || 0;
    else if (m === 'pa') total += g.pa || 0;
    else if (m === 'pr') total += g.pr || 0;
    else total += g.points || 0;
  }
  return Number((total / games.length).toFixed(2));
}

/**
 * If caller doesn't provide a prop line, infer one from the player's season avg.
 * This gives us SOMETHING to grade against — but the analysis is much less
 * meaningful because we're projecting near the inferred line by definition.
 *
 * Real prop lines from PrizePicks/Underdog should always be preferred.
 */
function inferLineFromPlayer(player, market) {
  const m = String(market).toLowerCase();
  const seasonAvg = Number(player.seasonAvg) || 0;
  // For inference: assume the line is the season avg, rounded to nearest 0.5
  // This is the "neutral" projection — analysis will show whether projection
  // suggests over or under.
  let raw;
  if (m.includes('rebound')) raw = Number(player._raw?.REB) || seasonAvg;
  else if (m.includes('assist')) raw = Number(player._raw?.AST) || seasonAvg;
  else if (m.includes('three')) raw = Number(player._raw?.FG3M) || seasonAvg;
  else raw = Number(player._raw?.PTS) || seasonAvg;
  // Round to nearest 0.5
  return Math.round(raw * 2) / 2;
}

// =============================================================
// HANDLER
// =============================================================

// =============================================================
// REQUEST BODY HELPER
// =============================================================
// Vercel Node.js serverless functions don't have req.json() — that's the
// Web/Edge Functions API. For Node functions, req is an IncomingMessage
// and Vercel automatically parses JSON bodies when Content-Type matches.
//
// BUG HISTORY (May 17, 2026): the original implementation used req.json(),
// which is the Fetch API method available on Web Requests. Calling it on
// a Node IncomingMessage produces a non-obvious error chain ending in
// "string did not match the expected pattern", a 0.1s response that looks
// like rate-limiting but is actually the platform rejecting the call before
// any external fetch.
//
// Three cases to handle:
//   - req.body is already an object → return it (Vercel pre-parsed)
//   - req.body is a string → try JSON.parse
//   - req.body is missing → manual stream read (older Vercel behavior)
async function readBody(req) {
  if (req.method !== 'POST') return {};
  // Case 1: Vercel pre-parsed the body
  if (req.body && typeof req.body === 'object') return req.body;
  // Case 2: Vercel left it as a string
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Case 3: Manual stream read (defensive fallback)
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

export default async function handler(req, res) {
  if (!WNBA_ENABLED) {
    return res.status(503).json({ ok: false, error: "WNBA endpoint disabled (WNBA_ENABLED=false)" });
  }
  if (!WNBA_SLATE_ENABLED) {
    return res.status(503).json({ ok: false, error: "WNBA slate endpoint disabled (WNBA_SLATE_ENABLED=false)" });
  }

  try {
    const body = await readBody(req);

    // GET request (or POST with empty body): generate today's slate with defaults
    if (req.method === 'GET' || Object.keys(body).length === 0) {
      const slate = await generateSlate({});
      return res.status(200).json({
        ok: true,
        generatedAt: new Date().toISOString(),
        shadowMode: WNBA_SHADOW_MODE,
        ...slate
      });
    }

    // POST: caller specifies date, markets, top N, lines
    const slate = await generateSlate({
      date: body.date,
      markets: body.markets,
      topN: body.topN,
      lines: body.lines,
      season: body.season
    });

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      shadowMode: WNBA_SHADOW_MODE,
      ...slate
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Slate generation failed",
      stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
    });
  }
}
