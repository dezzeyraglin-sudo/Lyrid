// api/wnba/slate.js
//
// WNBA SLATE ENDPOINT (May 22, 2026 — Session 5)
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
//
// =============================================================
// v2 ENGINE INTEGRATION (May 22, 2026 — Session 5)
// =============================================================
// This file additively layers the v2 projection engine on top of the existing
// analyzeBasketballProp pipeline. v2 modules:
//
//   - injuryFeed.js              -- pulls ESPN injuries, normalizes statuses
//   - minutesProjection.js       -- per-player minutes w/ injury awareness
//   - teammateRedistribution.js  -- reallocates minutes/usage when stars sit
//   - pointsProjection.js        -- possession-based points (Stage 1)
//   - reboundsProjection.js      -- per-minute rebounds w/ matchup multiplier (Stage 1)
//
// HOW IT'S LAYERED:
//   - Old engine still produces `projection`, `recommendation`, `edge`, `scores`, etc.
//     UI reads these fields unchanged.
//   - New engine produces `_v2Projection` attached to each analysis. UI ignores by default.
//   - Injuries are fetched ONCE per slate (not per player) for efficiency.
//   - Backup minutes/usage redistribution runs ONCE per team before per-player
//     projections, so backups have their boosted role baked in.
//
// SHADOW MODE:
//   - Set WNBA_V2_PROJECTIONS=true (default) to compute and attach v2 projections.
//   - Set WNBA_V2_PROJECTIONS=false to skip them entirely (zero overhead).
//
// VALIDATION PLAN:
//   - Log both old and v2 projections for 2 weeks
//   - Compare against actual outcomes; compute MAE for each engine per market
//   - Promote v2 to primary only if MAE is materially better
// =============================================================

import { analyzeBasketballProp } from "../_lib/basketball/basketballProps.js";
import { analyzeUnifiedProp } from "../_lib/basketball/unifiedPointsEngine.js";
import { analyzeReboundProp } from "../_lib/basketball/reboundEnvironmentEngine.js";
import { analyzeGameLine } from "../_lib/basketball/gameLineEngine.js";
import { buildAuditEntry } from "../_lib/basketball/basketballAudit.js";
import { getGamesForDate, getTodaysGames } from "../_lib/wnba/wnbaSchedule.js";
import { getTopPlayersForTeam } from "../_lib/wnba/wnbaPlayerData.js";
import { aggregateRecentForm } from "../_lib/wnba/wnbaGameLog.js";
import { getAllTeamStats } from "../_lib/wnba/wnbaTeamData.js";
import { fetchWnbaGameLines } from "../_lib/wnba/oddsLines.js";
import { fetchWnbaProps } from "../_lib/wnba/bdlFeed.js";

// v2 engine modules (ESM)
import { fetchEspnWnbaInjuries } from "../_lib/basketball/injuryFeed.js";
import { computeProjMinutes } from "../_lib/basketball/minutesProjection.js";
import { redistributeOutMinutes } from "../_lib/basketball/teammateRedistribution.js";
import { computeProjPoints } from "../_lib/basketball/pointsProjection.js";
import { computeProjRebounds } from "../_lib/basketball/reboundsProjection.js";

// Auth (May 31, 2026) — auth-aware but no enforcement during pre-monetization.
// When MONETIZATION_LAUNCHED is set, this resolves real user identity; otherwise
// returns the canned PRE_MONETIZATION_USER (Pro tier, zero latency).
import { tryAuth } from "../_lib/auth.js";

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

// v2 engine toggle. Default: ON in shadow mode (attached but ignored by UI).
const WNBA_V2_PROJECTIONS = (() => {
  const v = process.env.WNBA_V2_PROJECTIONS;
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
  // Default date = "today" in US Eastern (the WNBA's scheduling timezone), NOT
  // UTC. toISOString() returns UTC, which rolls to tomorrow after ~7-8pm in the
  // US and makes that night's games vanish mid-evening. en-CA gives YYYY-MM-DD.
  const date = opts.date || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const markets = Array.isArray(opts.markets) && opts.markets.length ? opts.markets : DEFAULT_MARKETS;
  const topN = Number(opts.topN) || DEFAULT_TOP_N;
  const lines = opts.lines || {};
  // Season also in Eastern, for the same rollover reason.
  const season = Number(opts.season) || Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric',
  }).format(new Date()));

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

  // STEP 2b: Pre-fetch injury report ONCE for the whole slate (v2 only)
  // Failure here is non-fatal: v2 just runs with all players AVAILABLE.
  let injuryReport = null;
  if (WNBA_V2_PROJECTIONS) {
    // Injuries come from BallDontLie (via injuryFeed, ESPN removed). Fail-safe:
    // on any failure injuryReport is an empty-but-valid report, players show AVAILABLE.
    injuryReport = await fetchEspnWnbaInjuries().catch(err => {
      warnings.push(`injury feed failed: ${err.message} (running with no injury data)`);
      return null;
    });
    if (injuryReport?._audit) {
      warnings.push(`injuries: ${injuryReport._audit.count ?? 0} via ${injuryReport._audit.pathUsed || injuryReport.source || 'bdl'}`);
    }
  }

  // STEP 2c: Pre-fetch real game lines ONCE for the whole slate (The Odds API).
  // Free tier: game total + spread per game. Non-fatal — if ODDS_API_KEY is
  // unset or the API returns nothing, gameLineFeed.byTeam is empty and we fall
  // back to inferred lines exactly as before.
  let gameLineFeed = { byTeam: {}, _audit: { gamesReturned: 0 } };
  try {
    gameLineFeed = await fetchWnbaGameLines();
    if (gameLineFeed._audit?.warnings?.length) {
      warnings.push(...gameLineFeed._audit.warnings.map(w => `Odds API: ${w}`));
    }
  } catch (err) {
    warnings.push(`Odds API lines fetch failed: ${err.message}`);
  }

  // STEP 2d: Pre-fetch real PLAYER PROP lines ONCE (BallDontLie, GOAT tier).
  // Merged into each game's propLines below so the existing precedence holds:
  // caller-provided line > BDL prop line > engine-inferred line. Non-fatal: if
  // BDL_API_KEY is unset or tier-gated, propLines stays empty and we infer.
  let bdlProps = { propLines: {}, _audit: {} };
  try {
    bdlProps = await fetchWnbaProps(date);
    if (bdlProps._audit?.warnings?.length) {
      warnings.push(...bdlProps._audit.warnings.map(w => `BDL: ${w}`));
    }
  } catch (err) {
    warnings.push(`BDL props fetch failed: ${err.message}`);
  }
  const bdlPropLines = bdlProps.propLines || {};
  const bdlPropsAvailable = Object.keys(bdlPropLines).length > 0;

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
    // Merge BDL player-prop lines into this game's propLines. Caller-provided
    // lines win; BDL fills the rest. Result feeds the existing per-prop lookup
    // (gameLines.propLines[playerName_market]) with no downstream change.
    if (bdlPropsAvailable) {
      gameLines.propLines = { ...bdlPropLines, ...(gameLines.propLines || {}) };
    }
    // Real lines from The Odds API, looked up by either team's tricode.
    const feedLine = gameLineFeed.byTeam[homeAbbr] || gameLineFeed.byTeam[awayAbbr] || null;
    // Precedence: explicit caller line > Odds API feed > default fallback.
    const spread = Number(gameLines.spread ?? feedLine?.spread ?? DEFAULT_SPREAD);
    const total = Number(gameLines.total ?? feedLine?.total ?? DEFAULT_TOTAL);
    const lineSource = Number.isFinite(Number(gameLines.spread)) ? 'caller'
      : (feedLine?.spread != null ? `odds_api:${feedLine.bookUsed}` : 'default');

    // ===== GAME-LINE PROJECTION (OUR MODEL) =====
    // Project total / spread / moneyline from team efficiency + pace + the minor
    // defensive factors, and compare to the book line when present. Non-fatal:
    // if team objects are thin, the engine degrades and we just omit it.
    let gameLine = null;
    try {
      const homeTeamObj = allTeamStats[homeAbbr];
      const awayTeamObj = allTeamStats[awayAbbr];
      if (homeTeamObj && awayTeamObj) {
        gameLine = analyzeGameLine({
          home: homeTeamObj,
          away: awayTeamObj,
          bookLine: feedLine ? { total: feedLine.total, spread: feedLine.spread, bookUsed: feedLine.bookUsed } : null,
        }, 'WNBA');
      }
    } catch (glErr) {
      warnings.push(`Game-line projection failed for ${game.gameId}: ${glErr.message}`);
    }

    gameContexts[game.gameId] = {
      gameId: game.gameId,
      home: homeAbbr,
      away: awayAbbr,
      gameTimeET: game.gameTimeET,
      status: game.status,
      spread,
      total,
      linesProvided: !!lines[game.gameId],
      lineSource,
      // OUR MODEL: engine-projected lines beside the book line (MLB-style).
      gameLine
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
      // v2: build per-team rosters with projected minutes + redistributed usage
      // before running per-market analyses. This way every (player, market) call
      // sees the boosted minutes/usage that come from injuries.
      let v2HomeRoster = null;
      let v2AwayRoster = null;
      if (WNBA_V2_PROJECTIONS) {
        try {
          v2HomeRoster = buildV2Roster(homePlayers, homeAbbr, injuryReport, { spread: spread, is_b2b: false });
          v2AwayRoster = buildV2Roster(awayPlayers, awayAbbr, injuryReport, { spread: -spread, is_b2b: false });
        } catch (err) {
          warnings.push(`v2 roster build failed for ${homeAbbr}@${awayAbbr}: ${err.message}`);
        }
      }

      // For each player, for each market, kick off an analysis
      const tasks = [];
      const allPlayers = [
        ...homePlayers.map(p => ({ player: p, isHome: true, opponent: awayAbbr, team: homeAbbr, v2Roster: v2HomeRoster, v2OpponentRoster: v2AwayRoster })),
        ...awayPlayers.map(p => ({ player: p, isHome: false, opponent: homeAbbr, team: awayAbbr, v2Roster: v2AwayRoster, v2OpponentRoster: v2HomeRoster }))
      ];

      for (const { player, isHome, opponent, team, v2Roster, v2OpponentRoster } of allPlayers) {
        // Get recent form once per player (cached for subsequent market calls)
        const recentFormPromise = aggregateRecentForm(player.id, 10, 'points', season).catch(() => null);

        for (const market of markets) {
          tasks.push(
            buildAndRunAnalysis({
              player, isHome, opponent, team, market, season, game, spread, total,
              recentFormPromise, allTeamStats, gameLines,
              v2Roster, v2OpponentRoster, injuryReport
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

  // v2 audit: roll up injury context for the slate-level summary
  const v2Summary = WNBA_V2_PROJECTIONS && injuryReport ? {
    injuriesAttached: true,
    injuredPlayerCount: injuryReport.all?.length || 0,
    injuredTeamCount: Object.keys(injuryReport.byTeamAbbrev || {}).length,
    fetchedAt: injuryReport.fetchedAt
  } : {
    injuriesAttached: false,
    note: WNBA_V2_PROJECTIONS ? 'injury feed failed; v2 ran without injury data' : 'v2 disabled (WNBA_V2_PROJECTIONS=false)'
  };

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
      durationMs: Date.now() - startedAt,
      v2: v2Summary
    }
  };
}

/**
 * Build the input for one (player, market) pair, run analysis, return result.
 * Catches errors and tags them so they don't break the whole slate.
 */
// ----- Unified-output → card adapters -----
// The card UI consumes chips, hardFlags, and a hitRate. The unified engine
// reports structured layers instead, so translate them here.

function deriveHitRate(u) {
  // Use the over-probability as a rough "hit rate vs the (inferred) line".
  if (u && u.probOver != null && Number.isFinite(Number(u.probOver))) {
    return Math.round(Number(u.probOver) * 100);
  }
  return null;
}

function buildChipsFromUnified(u, player, reboundExtras) {
  const chips = [];
  if (player?.primaryCreator) chips.push('PRIMARY CREATOR');
  if (player?.primaryOption || (player?.usageRate >= 28)) chips.push('PRIMARY OPTION');
  const m = u?.multipliers || {};
  if (m.usageFunnel && m.usageFunnel > 1.0) chips.push('USAGE FUNNEL');
  if (m.matchup_opposingDefense && m.matchup_opposingDefense > 1.03) chips.push('SOFT DEFENSE');
  if (m.matchup_opposingDefense && m.matchup_opposingDefense < 0.97) chips.push('TOUGH DEFENSE');
  if (m.coverage_coachingScheme && m.coverage_coachingScheme !== 1.0) chips.push('COVERAGE EDGE');
  if (m.whistle && m.whistle > 1.02) chips.push('WHISTLE');
  // Rebound-environment chips
  if (reboundExtras?.environment?.oppType && reboundExtras.environment.oppProfileSource === 'REAL') {
    const t = reboundExtras.environment.oppType;
    if (t === 'PERIMETER') chips.push('LONG-MISS ENV');
    else if (t === 'DOWNHILL_PAINT') chips.push('SHORT-MISS ENV');
    else if (t === 'PULLUP_MIDRANGE') chips.push('MID-MISS ENV');
  }
  if (reboundExtras?.equity?.archetype) {
    const eq = reboundExtras.equity.equityMultiplier;
    if (eq != null && eq >= 1.05) chips.push('REBOUND EQUITY +');
    else if (eq != null && eq <= 0.95) chips.push('REBOUND EQUITY −');
  }
  return chips;
}

function buildHardFlagsFromUnified(u, player, reboundExtras) {
  const flags = [];
  const sc = u?.scores || {};
  if (sc.roleStability != null && sc.roleStability < 40) flags.push('ROLE TOO FRAGILE');
  if (sc.variance != null && sc.variance < 35) flags.push('HIGH VARIANCE');
  const dc = u?.dataCompleteness || {};
  if (dc.opposingDefense && dc.opposingDefense !== 'REAL') flags.push('NO DEFENSE DATA');
  if (u?.confidence != null && u.confidence < 45) flags.push('LOW CONFIDENCE');
  // Rebound trap is the headline flag for the rebounds market.
  if (reboundExtras?.trap?.isTrap) flags.push('REBOUND TRAP');
  return flags;
}

async function buildAndRunAnalysis({
  player, isHome, opponent, team, market, season, game,
  spread, total, recentFormPromise, allTeamStats, gameLines,
  v2Roster, v2OpponentRoster, injuryReport
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
      // FG% for the engine's shooting-efficiency layer: season FG% plus a recent
      // FG% (hot/cold form) derived from the game-log shot totals.
      fgPct: player.fgPct ?? player._raw?.FG_PCT ?? null,
      fgPctRecent: (recentForm?.totals && recentForm.totals.fga > 0)
        ? Number((recentForm.totals.fgm / recentForm.totals.fga).toFixed(3))
        : null,
      ...(recentForm ? {
        minutesLast5: recentForm.minutesLast5,
        minutesCv: recentForm.minutesCv,
        expectedMinutes: recentForm.minutesAvg
      } : {})
    };

    // Look up line: caller can provide per-prop lines via gameLines.propLines[playerName_market]
    const propLineKey = `${player.name}_${market}`;
    const explicitLine = gameLines.propLines?.[propLineKey];
    const hasRealLine = Number.isFinite(Number(explicitLine));
    const line = hasRealLine ? Number(explicitLine) : inferLineFromPlayer(player, market);
    // 'provided' = a real book/prop line (caller or BDL); 'inferred' = engine guess.
    const propLineSource = hasRealLine ? 'provided' : 'inferred';

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

    // ===== ENGINE SELECTION =====
    // Rebounds run through the rebound-ENVIRONMENT engine (opponent shot
    // geography → miss profile → archetype equity → trap). Everything else runs
    // the unified points engine (blended cores + defense/coverage/whistle).
    const marketLower = String(market).toLowerCase();
    const isRebounds = marketLower.includes('rebound') || marketLower === 'reb' || marketLower === 'trb';

    let unified;
    let reboundExtras = null;
    try {
      if (isRebounds) {
        const reb = analyzeReboundProp(input, 'WNBA');
        unified = {
          line: reb.line, projection: reb.projection, edge: reb.edge,
          recommendation: reb.recommendation, confidence: reb.confidence,
          tier: reb.tier, hitRate: deriveHitRate(reb), scores: reb.scores,
          probOver: reb.probOver, probUnder: reb.probUnder,
          floor: reb.floor, ceiling: reb.ceiling,
          multipliers: reb.multipliers, dataCompleteness: reb.dataCompleteness,
          cores: null, layerDetail: null,
        };
        // Rebound-specific surfaces for the card.
        reboundExtras = {
          environment: reb.environment, equity: reb.equity,
          trap: reb.trap, variance: reb.variance,
        };
      } else {
        unified = analyzeUnifiedProp(input, 'WNBA');
      }
    } catch (uerr) {
      // Engine must never break the slate — fall back to the legacy v1 result.
      const legacy = analyzeBasketballProp(input, 'WNBA');
      unified = {
        line: legacy.line, projection: legacy.projection, edge: legacy.edge,
        recommendation: legacy.recommendation, confidence: legacy.confidence,
        tier: legacy.label, hitRate: legacy.hitRate, scores: legacy.scores || {},
        chips: legacy.chips || [], dataCompleteness: { engine: 'legacy-fallback', error: uerr.message },
        floor: null, ceiling: null, cores: null, multipliers: null,
      };
    }

    // Pull this player's injury status off the v2 roster (buildV2Roster computed
    // it but it never reached the card). Name-normalized match. If OUT, the card
    // shows an OUT badge and the pick is forced to PASS — an out player is not a play.
    const _normName = (s) => String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    let injuryStatus = 'AVAILABLE', injuryDetail = null;
    if (Array.isArray(v2Roster)) {
      const re = v2Roster.find(r => _normName(r.playerName) === _normName(player.name));
      if (re) { injuryStatus = re.status || 'AVAILABLE'; injuryDetail = re._injury?.detail || null; }
    }
    const isOut = injuryStatus === 'OUT';
    const isDoubtful = injuryStatus === 'DOUBTFUL';

    return {
      gameId: game.gameId,
      player: player.name,
      team,
      opponent,
      market,
      // Injury status surfaced to the card. OUT players are forced to PASS.
      injuryStatus,
      injuryDetail,
      line: unified.line,
      projection: unified.projection,
      edge: unified.edge,
      recommendation: isOut ? 'PASS' : unified.recommendation,
      confidence: isOut ? 0 : unified.confidence,
      label: isOut ? 'OUT' : (isDoubtful ? 'RISK' : unified.tier),
      hitRate: unified.hitRate ?? deriveHitRate(unified),
      scores: unified.scores,
      chips: unified.chips || buildChipsFromUnified(unified, player, reboundExtras),
      hardFlags: buildHardFlagsFromUnified(unified, player, reboundExtras),
      lineSource: propLineSource,
      shadowMode: WNBA_SHADOW_MODE,
      _dataQuality: player._dataQuality,
      // Richer unified outputs surfaced for the card + debugging.
      probOver: unified.probOver,
      probUnder: unified.probUnder,
      floor: unified.floor,
      ceiling: unified.ceiling,
      cores: unified.cores,
      multipliers: unified.multipliers,
      layerDetail: unified.layerDetail,
      dataCompleteness: unified.dataCompleteness,
      // Player context for the advantage explanation (all real when present).
      playerContext: {
        usageRate: player.usageRate ?? null,
        position: player.position ?? null,
        tsPct: player.tsPct ?? null,
        expectedMinutes: playerWithRecent.expectedMinutes ?? null,
        last5Avg: playerWithRecent.last5Avg ?? null,
        last10Avg: playerWithRecent.last10Avg ?? null,
        seasonAvg: player.seasonAvg ?? null,
        fgPctRecent: playerWithRecent.fgPctRecent ?? null,
        primaryCreator: player.primaryCreator ?? false,
      },
      // Rebound-environment surfaces (null for non-rebound markets).
      reboundEnvironment: reboundExtras?.environment || null,
      reboundEquity: reboundExtras?.equity || null,
      reboundTrap: reboundExtras?.trap || null,
      reboundVariance: reboundExtras?.variance || null
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

// =============================================================
// v2 PROJECTION HELPERS
// =============================================================

/**
 * Build a v2 roster for one team: list of players with projected minutes,
 * confidence, usage (possibly boosted by injury redistribution), and other
 * inputs needed by downstream point/rebound modules.
 *
 * This runs ONCE per team per slate call. Per-market projections then
 * pull from this roster to get the right minutes/usage.
 *
 * @param {Array} players - raw players from getTopPlayersForTeam
 * @param {string} teamAbbrev - team abbreviation
 * @param {Object|null} injuryReport - normalized injury report from injuryFeed
 * @param {Object} gameContext - { spread, is_b2b }
 * @returns {Array} v2 roster with injury status, projMinutes, confidence, usage attached
 */
function buildV2Roster(players, teamAbbrev, injuryReport, gameContext) {
  if (!Array.isArray(players) || players.length === 0) return [];

  // Injuries are keyed by ESPN's numeric IDs, but our player.id is now the bbref
  // slug — those never match. Build a NAME index from the report so we can match
  // reliably (names match across providers; IDs don't). Accent/punctuation-insensitive.
  const normName = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const injuryByName = {};
  const injuryList = injuryReport?.all || injuryReport?.players || [];
  if (Array.isArray(injuryList)) {
    for (const inj of injuryList) {
      const nm = inj.playerName || inj.name || inj.athlete || inj.player;
      if (nm) injuryByName[normName(nm)] = inj;
    }
  }
  // Also fold any name-keyed index the feed may already expose.
  if (injuryReport?.byName) {
    for (const [k, v] of Object.entries(injuryReport.byName)) injuryByName[normName(k)] = v;
  }

  // Build minimal v2-shaped player objects from the player + _raw data the slate already has.
  const roster = players.map(p => {
    const raw = p._raw || {};
    const gp = Number(raw.GP) || Number(raw.gp) || 10;
    const gs = Number(raw.GS) || Number(raw.gs) || 0;
    const mpg = Number(raw.MIN) || Number(raw.MPG) || Number(raw.mpg) || 0;
    const ppg = Number(raw.PTS) || Number(raw.PPG) || 0;
    const rpg = Number(raw.REB) || Number(raw.RPG) || 0;

    // Derive per-minute rates (used by points & rebounds engines)
    const reb_per_min = mpg > 0 ? rpg / mpg : 0;

    // True shooting %: if not provided, derive from FG%/3P%/FT% if available, else fall back.
    // TS = PTS / (2 * (FGA + 0.44*FTA))
    let ts_pct = Number(raw.TS_PCT) || Number(raw.ts_pct);
    if (!Number.isFinite(ts_pct)) {
      const fga = Number(raw.FGA) || 0;
      const fta = Number(raw.FTA) || 0;
      const denom = 2 * (fga + 0.44 * fta);
      ts_pct = denom > 0 ? ppg / denom : 0.535; // league avg fallback
    }

    // Usage rate: if not provided, approximate from FGA + TO + 0.44*FTA per game.
    // Real USG% needs team-level pace data; this is a rough proxy.
    let usage = Number(raw.USG_PCT) || Number(raw.usage);
    // UNITS FIX (June 1, 2026): wnbaPlayerData surfaces USG_PCT in PERCENTAGE
    // form (e.g. 28.4), but pointsProjection.js expects a DECIMAL fraction
    // (LEAGUE_AVG_USAGE = 0.20). Without this, points blew up ~100x and railed
    // at the 2x-season ceiling (e.g. a 16-ppg player projecting 32.00).
    if (Number.isFinite(usage) && usage > 1) usage = usage / 100;
    if (!Number.isFinite(usage)) {
      const fga = Number(raw.FGA) || 0;
      const fta = Number(raw.FTA) || 0;
      const tov = Number(raw.TOV) || Number(raw.TO) || 0;
      const possessionsUsed = fga + tov + 0.44 * fta;
      // Crude usage estimate: player's possessions used / team possessions in player's minutes.
      // Without team pace, fall back to 0.20 (league avg) and let downstream flag it.
      usage = possessionsUsed > 0 ? Math.min(0.40, possessionsUsed / 16) : 0.20;
    }

    // Look up injury status — by NAME first (reliable), ID as a fallback.
    const injury = injuryByName[normName(p.name)]
      || injuryReport?.byPlayerId?.[String(p.id)]
      || null;
    const status = injury?.status || 'AVAILABLE';

    return {
      playerId: String(p.id),
      playerName: p.name,
      position: raw.POS || raw.position || p.position || 'F',
      // Stats for minutes engine
      season_mpg: mpg,
      gp,
      gs,
      last5_mpg: undefined, // populated from recentForm downstream if needed
      // Stats for points engine
      season_ppg: ppg,
      usage,
      ts_pct,
      // Stats for rebounds engine
      season_reb_per_min: reb_per_min,
      // Injury status
      status,
      _injury: injury,
    };
  });

  // STEP A: project minutes for each player (handles GTD/DOUBTFUL/OUT)
  for (const p of roster) {
    try {
      const projection = computeProjMinutes(p, gameContext, p._injury);
      p.projMinutes = projection.projMinutes;
      p.confidence = projection.confidence;
      p._minutesAudit = projection.audit;
    } catch (err) {
      // If any single player blows up, default to season MPG and continue
      p.projMinutes = p.season_mpg;
      p.confidence = 50;
      p._minutesAudit = { error: err.message };
    }
  }

  // STEP B: redistribute minutes/usage from OUT players to teammates
  // (modifies the roster in place; OUT players keep projMinutes=0,
  // backups get boosted projMinutes and usage)
  try {
    const { audit: redistAudit } = redistributeOutMinutes(roster);
    // Attach redistribution audit at roster level (not per-player)
    roster._redistributionAudit = redistAudit;
  } catch (err) {
    roster._redistributionAudit = { error: err.message };
  }

  return roster;
}

/**
 * Compute v2 projection for one (player, market) pair.
 *
 * Returns a compact object with the projection, confidence, floor, ceiling, and audit.
 * Markets not yet supported by v2 (assists, threes, PRA) return null with a note.
 *
 * @param {Object} args
 * @returns {Object|null}
 */
function computeV2Projection({ player, market, v2Roster, v2OpponentRoster, teamData, opponentTeam, spread, isHome, recentForm }) {
  // Look up this player's v2 roster entry (already has projMinutes/confidence/usage)
  const v2Player = v2Roster.find(p => p.playerId === String(player.id));
  if (!v2Player) return null;

  // If the player is OUT, every market projects to 0 — short-circuit.
  if (v2Player.status === 'OUT' || v2Player.projMinutes === 0) {
    return {
      projection: 0,
      confidence: 0,
      floor: 0,
      ceiling: 0,
      market,
      status: v2Player.status,
      note: 'player is OUT or has zero projected minutes',
      engineVersion: 'v2.0.0-shadow',
    };
  }

  // Build game context for the projection.
  // We derive opponent pace/def rating/miss rate from opponentTeam if available;
  // each module has its own fallbacks for missing fields.
  const gameContext = {
    team_pace: Number(teamData.pace) || Number(teamData.PACE) || undefined,
    opp_pace: Number(opponentTeam.pace) || Number(opponentTeam.PACE) || undefined,
    opp_def_rating: Number(opponentTeam.def_rating) || Number(opponentTeam.DEF_RTG) || undefined,
    opp_miss_rate: deriveOppMissRate(opponentTeam),
    spread: isHome ? spread : -spread,
    is_b2b: false, // TODO: derive from schedule
  };

  // Merge recent form data into v2Player for projection
  // (recentForm.games is a list of recent games; we use it to derive last5 metrics
  // for whichever market is being projected)
  if (recentForm?.games && recentForm.games.length > 0) {
    const last5Games = recentForm.games.slice(0, 5);
    const m = String(market).toLowerCase();
    if (m === 'points' || m.includes('point')) {
      const avg = last5Games.reduce((s, g) => s + (Number(g.points) || 0), 0) / last5Games.length;
      v2Player.last5_ppg = avg;
    } else if (m === 'rebounds' || m.includes('rebound') || m === 'reb') {
      const last5Mins = last5Games.reduce((s, g) => s + (Number(g.minutes) || 0), 0);
      const last5Rebs = last5Games.reduce((s, g) => s + (Number(g.rebounds) || 0), 0);
      v2Player.last5_reb_per_min = last5Mins > 0 ? last5Rebs / last5Mins : undefined;
    }
  }

  // Route to the right engine
  const m = String(market).toLowerCase();
  if (m === 'points' || m.includes('point')) {
    const result = computeProjPoints(v2Player, gameContext);
    return {
      projection: result.projPoints,
      confidence: result.confidence,
      floor: result.floor,
      ceiling: result.ceiling,
      market,
      factors: result.factors,
      audit: result.audit,
      status: v2Player.status,
      engineVersion: 'v2.0.0-shadow',
    };
  }

  if (m === 'rebounds' || m.includes('rebound') || m === 'reb') {
    const result = computeProjRebounds(v2Player, gameContext, v2Player._injury);
    return {
      projection: result.projRebounds,
      confidence: result.confidence,
      floor: result.floor,
      ceiling: result.ceiling,
      market,
      factors: result.factors,
      audit: result.audit,
      status: v2Player.status,
      engineVersion: 'v2.0.0-shadow',
    };
  }

  // Markets not yet built: assists, threes, PRA combos.
  // Return a stub so the field is always present in shadow logs.
  return {
    projection: null,
    market,
    status: v2Player.status,
    note: `market '${market}' not yet implemented in v2 engine`,
    engineVersion: 'v2.0.0-shadow',
  };
}

/**
 * Derive opponent miss rate from team stats. Tries multiple field name variations
 * since different upstream feeds use different conventions.
 */
function deriveOppMissRate(opponentTeam) {
  if (!opponentTeam) return undefined;
  // Direct miss rate
  if (Number.isFinite(Number(opponentTeam.miss_rate))) return Number(opponentTeam.miss_rate);
  // Derive from FG%
  const fgPct = Number(opponentTeam.fg_pct) || Number(opponentTeam.FG_PCT) || Number(opponentTeam.fgPct);
  if (Number.isFinite(fgPct) && fgPct > 0) {
    return 1 - (fgPct > 1 ? fgPct / 100 : fgPct);
  }
  // Derive from FGM/FGA
  const fgm = Number(opponentTeam.fgm) || Number(opponentTeam.FGM);
  const fga = Number(opponentTeam.fga) || Number(opponentTeam.FGA);
  if (Number.isFinite(fgm) && Number.isFinite(fga) && fga > 0) {
    return 1 - (fgm / fga);
  }
  return undefined; // let module fall back to league average
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

  // ============ AUTH (May 31, 2026) ============
  // Resolve user identity if signed in. In pre-monetization mode this returns
  // a canned Pro user — no DB call, no latency. When monetization launches,
  // this will resolve real users from the Authorization header.
  // No enforcement yet: WNBA is in shadow mode (no real lines/recs to gate).
  // Add checkAndIncrementQuota() here later when WNBA exits shadow mode.
  const user = await tryAuth(req, res);
  if (res.headersSent) return;

  try {
    const body = await readBody(req);

    // GET request (or POST with empty body): generate today's slate with defaults
    if (req.method === 'GET' || Object.keys(body).length === 0) {
      const slate = await generateSlate({});
      return res.status(200).json({
        ok: true,
        generatedAt: new Date().toISOString(),
        shadowMode: WNBA_SHADOW_MODE,
        v2ProjectionsEnabled: WNBA_V2_PROJECTIONS,
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
      v2ProjectionsEnabled: WNBA_V2_PROJECTIONS,
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
