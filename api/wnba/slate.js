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
import { classifyWnbaPlay, detectPRA, computePRAProjection } from "../_lib/basketball/wnbaUnderModel.js";
import { analyzeGameLine } from "../_lib/basketball/gameLineEngine.js";
import { buildWnbaDefenseTable, defenseMultiplier, teamDefenseFor } from "../_lib/wnba/wnbaDefenseFeed.js";
import { externalCoverageSignal, externalFoulRate, externalPaceSignal } from "../_lib/wnba/wnbaExternalSignals.js";
import { buildAuditEntry } from "../_lib/basketball/basketballAudit.js";
import { getGamesForDate, getTodaysGames } from "../_lib/wnba/wnbaSchedule.js";
import { getTopPlayersForTeam } from "../_lib/wnba/wnbaPlayerData.js";
import { aggregateRecentForm, aggregateFromGames } from "../_lib/wnba/wnbaGameLog.js";
import { getAllTeamStats } from "../_lib/wnba/wnbaTeamData.js";
import { fetchWnbaGameLines } from "../_lib/wnba/oddsLines.js";
import { fetchWnbaProps, fetchWnbaSeasonGames, fetchWnbaPlayerSeasonLogs, getSpin } from "../_lib/wnba/wnbaFeedEspn.js";
import { buildEmpiricalTotals } from "../_lib/wnba/wnbaEmpiricalTotals.js";
import { evaluatePropSignal } from "../_lib/wnba/wnbaPropSignal.js";

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
const DEFAULT_TOP_N = 6;   // starting five + one rotation slot of slack
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
  // Floor at 5 so the whole projected starting five always shows, even if the
  // client sends a smaller topN. A larger client value is still respected.
  const topN = Math.max(Number(opts.topN) || DEFAULT_TOP_N, 5);
  const lines = opts.lines || {};
  const playerBiasOverride = opts.playerBias || null;   // rolling per-player bias from client
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
  const bdlPropMeta = bdlProps.propMeta || {};
  const bdlPropsAvailable = Object.keys(bdlPropLines).length > 0;

  // STEP 2d-PP: PrizePicks STANDARD lines — the real market the tool analyzes
  // against. Fetched once, standard-only (demon/goblin are no-bets). Non-fatal: if
  // partner-api 403s from Vercel's IP range, this stays empty and manual/inferred
  // lines take over — the app never depends on it (per the pp-lines caveats).
  let ppLines = { ok: false, byKey: {}, altIndex: {}, lines: [] };
  try {
    // Dynamic import: if ppLines.js isn't deployed, this is a catchable failure,
    // not a load-time crash of the whole function. The slate degrades to
    // manual/inferred lines — it must never depend on the PP module existing.
    const { fetchWnbaPpLines } = await import("../_lib/wnba/ppLines.js");
    ppLines = await fetchWnbaPpLines({ standardOnly: true });
    if (!ppLines.ok) warnings.push(`PP lines unavailable: ${ppLines.reason || 'unknown'}${ppLines.blocked ? ' (IP blocked)' : ''}`);
    else warnings.push(`PP lines: ${ppLines.standardCount} standard, ${ppLines.altCount} alt`);
  } catch (err) {
    warnings.push(`PP lines module unavailable: ${err.message}`);
  }
  const ppAltIndex = ppLines.altIndex || {};
  // Build propLines keyed "name_market" from the STANDARD lines. The slate's
  // existing normalized-name fallback joins these to bbref player names.
  const ppPropLines = {}, ppPropMeta = {};
  for (const l of (ppLines.lines || [])) {
    if (!l.isStandard) continue;
    const nm = l.name || l.displayName;
    if (!nm || l.line == null) continue;
    const key = `${nm}_${l.market}`;
    if (!(key in ppPropLines)) {
      ppPropLines[key] = l.line;
      ppPropMeta[key] = { book: 'prizepicks', oddsType: l.oddsType };
    }
    // also key under displayName spelling if it differs
    if (l.displayName && l.displayName !== nm) {
      const k2 = `${l.displayName}_${l.market}`;
      if (!(k2 in ppPropLines)) { ppPropLines[k2] = l.line; ppPropMeta[k2] = { book: 'prizepicks', oddsType: l.oddsType }; }
    }
  }
  const ppPropsAvailable = Object.keys(ppPropLines).length > 0;

  // STEP 2e: Season-wide player game logs from BDL (replaces the bbref scrape,
  // which Sports-Reference 429-blocks from Vercel's shared IPs). Fetched ONCE per
  // slate, cached per season, name-keyed. Feeds cold-form recentForm below.
  let bdlPlayerLogs = { byName: {} };
  try {
    bdlPlayerLogs = await fetchWnbaPlayerSeasonLogs(season);
    const a = bdlPlayerLogs._audit || {};
    if (a.warnings?.length) warnings.push(...a.warnings.map(w => `BDL logs: ${w}`));
  } catch (err) {
    warnings.push(`BDL player logs fetch failed: ${err.message}`);
  }

  // OPPOSING DEFENSE table (pts/reb/ast allowed by position, last 10G). Built once
  // per slate from box scores (ALL-STAR /stats). Cached in Supabase. Fail-safe:
  // on any error this is an empty table and the engine stays neutral (DEF 50).
  let defenseTable = { byTeam: {}, leagueAvg: null, _audit: {} };
  try {
    defenseTable = await buildWnbaDefenseTable();
    if (defenseTable._audit?.warnings?.length) {
      warnings.push(...defenseTable._audit.warnings.map(w => `DEF: ${w}`));
    }
  } catch (err) {
    warnings.push(`Defense table failed: ${err.message}`);
  }

  // Empirical team-totals evaluator (rolling team off/def vs league proxy line).
  // Built once per slate from this season's finished games that PRECEDE the slate
  // date (no leakage). Fail-safe: stays null if BDL/season history is unavailable.
  let empiricalTotals = null;
  try {
    const seasonData = await fetchWnbaSeasonGames(season);
    // Only use games strictly before the slate date so today's results can't leak.
    const priorGames = (seasonData.games || []).filter(g => g.date && g.date < date);
    if (priorGames.length >= 10) {
      empiricalTotals = buildEmpiricalTotals(priorGames, season);
    } else {
      warnings.push(`Empirical totals: only ${priorGames.length} prior games this season — rule dormant until ~10+`);
    }
  } catch (err) {
    warnings.push(`Empirical totals build failed: ${err.message}`);
  }

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
    // Line precedence: caller-provided (manual) > PrizePicks standard > inferred.
    // PP is the primary market; manual entry overrides it (corrections/fallback).
    if (ppPropsAvailable || bdlPropsAvailable) {
      gameLines.propLines = { ...ppPropLines, ...bdlPropLines, ...(gameLines.propLines || {}) };
      gameLines.propMeta = { ...ppPropMeta, ...bdlPropMeta, ...(gameLines.propMeta || {}) };
    }
    // Real lines from The Odds API, looked up by either team's tricode.
    const feedLine = gameLineFeed.byTeam[homeAbbr] || gameLineFeed.byTeam[awayAbbr] || null;
    // Precedence: explicit caller line > Odds API feed > default fallback.
    const spread = Number(gameLines.spread ?? feedLine?.spread ?? DEFAULT_SPREAD);
    const total = Number(gameLines.total ?? feedLine?.total ?? DEFAULT_TOTAL);
    // Caller-provided total lines to grade against: full game + optional half lines.
    // Any of these can be typed in per game; each drives its own over/under lean.
    const totalLines = {
      full: Number.isFinite(Number(gameLines.total)) ? Number(gameLines.total) : (Number.isFinite(total) ? total : null),
      firstHalf: Number.isFinite(Number(gameLines.firstHalfTotal ?? gameLines.total1h)) ? Number(gameLines.firstHalfTotal ?? gameLines.total1h) : null,
      secondHalf: Number.isFinite(Number(gameLines.secondHalfTotal ?? gameLines.total2h)) ? Number(gameLines.secondHalfTotal ?? gameLines.total2h) : null,
    };
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

    // Empirical team-total edge (tiered BRONZE/GOLD/PLATINUM). Attached to the
    // gameLine so the card and game-bets logger can surface it. Null when dormant.
    let empiricalEdge = null;
    if (empiricalTotals) {
      try { empiricalEdge = empiricalTotals.evaluate(homeAbbr, awayAbbr); }
      catch (eErr) { warnings.push(`Empirical edge failed for ${game.gameId}: ${eErr.message}`); }
    }
    if (gameLine && empiricalEdge) gameLine.empiricalTotal = empiricalEdge;

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
      gameLine,
      // Projected game total from recent scoring rate × opponent defense, with the
      // first-half / second-half split and a market comparison. Environment read (±13).
      projectedTotal: estimateGameTotal(homeAbbr, awayAbbr, defenseTable, totalLines),
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
          v2HomeRoster = buildV2Roster(homePlayers, homeAbbr, injuryReport, { spread: spread, is_b2b: false, teamPace: Number(allTeamStats[homeAbbr]?.pace) || Number(allTeamStats[homeAbbr]?.PACE) || null });
          v2AwayRoster = buildV2Roster(awayPlayers, awayAbbr, injuryReport, { spread: -spread, is_b2b: false, teamPace: Number(allTeamStats[awayAbbr]?.pace) || Number(allTeamStats[awayAbbr]?.PACE) || null });
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
        // Recent form STRICTLY from BDL box scores (bbref is SR-429'd on Vercel).
        // Name-keyed (same normalization as the prop-line join); exclude the slate
        // date and later so there's no same-day leakage. Computed once per player.
        const _logKey = normPlayerName(player.name);
        const _bdlGames = ((bdlPlayerLogs.byName?.[_logKey]?.games) || [])
          .filter(g => !g.date || g.date < date);
        const recentFormPromise = Promise.resolve(
          _bdlGames.length ? aggregateFromGames(_bdlGames, 10, 'points') : null
        );
        // Shots-to-clear scoring profile (per-player, market-independent). Built
        // from the same leakage-filtered logs; carried onto every analysis so the
        // points path can read P(over) off a distribution instead of a mean.
        const _shotProfile = _bdlGames.length ? buildShotProfile(_bdlGames, 10) : null;
        // Recent shooting form (bonus read): raw last-10 / last-5 FGA + FG% + TS%
        // straight from the game logs — "who's actually shooting well right now",
        // shown next to the tool's projection on the card.
        const _shootingForm = _bdlGames.length ? buildShootingForm(_bdlGames) : null;

        for (const market of markets) {
          tasks.push(
            buildAndRunAnalysis({
              player, isHome, opponent, team, market, season, game, spread, total, date,
              recentFormPromise, allTeamStats, gameLines,
              v2Roster, v2OpponentRoster, injuryReport, defenseTable,
              shotProfile: _shotProfile, shootingForm: _shootingForm, ppAltIndex, playerBiasOverride
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
  const allAnalysesRaw = gameResults.flat().filter(Boolean);

  // Remove OUT players from the slate entirely (preference: don't show them as
  // cards at all). Capture them first so we can report who's out + who benefits.
  const outAnalyses = allAnalysesRaw.filter(a => a.injuryStatus === 'OUT');
  const allAnalyses = allAnalysesRaw.filter(a => a.injuryStatus !== 'OUT');

  // Dedup the removed players (one entry per name, not per market) for the summary.
  const removedOut = [];
  const _seenOut = new Set();
  for (const a of outAnalyses) {
    const key = (a.player || '').toLowerCase();
    if (_seenOut.has(key)) continue;
    _seenOut.add(key);
    removedOut.push({ player: a.player, team: a.team, detail: a.injuryDetail || null });
  }

  // Stamp the unified bet model onto every analysis. classifyWnbaPlay encodes the
  // three validated edges (GUARANTEED/PLATINUM/GOLD) from 264 graded picks, plus
  // player bans (Mabrey), opponent modifiers (CHI/TOR), and watches (Howard/Austin).
  // PRA detection: an "assists" line > 8.0 is a mislabeled combo line → re-route to
  // GUARANTEED when the edge ≥ 4. This is the honest bet signal; it replaces the
  // inverted finalEdgeScore label.
  const praByPlayerGame = {};
  for (const a of allAnalyses) {
    if (a.error) continue;
    const lean = (a.projection != null && a.line != null)
      ? (Number(a.projection) >= Number(a.line) ? 'OVER' : 'UNDER')
      : null;
    const effectiveMarket = detectPRA(a.market, a.line) ? 'pra' : a.market;
    if (effectiveMarket !== a.market) a.detectedAsPRA = true;
    a.empTier = classifyWnbaPlay({
      market: effectiveMarket,
      lean,
      line: Number(a.line),
      projection: Number(a.projection),
      role: a.scores?.roleStability ?? a.scores?.role ?? 50,
      player: a.player,
      opponent: a.opponent,
    });
    // Accumulate components for a PRA composite projection.
    const pgKey = `${a.player}|${a.gameId || a.opponent}`;
    if (!praByPlayerGame[pgKey]) praByPlayerGame[pgKey] = {};
    const mk = (a.market || '').toLowerCase();
    if (mk === 'points') praByPlayerGame[pgKey].ptsProj = Number(a.projection);
    if (mk === 'rebounds') praByPlayerGame[pgKey].rebProj = Number(a.projection);
    if (mk === 'assists') praByPlayerGame[pgKey].astProj = Number(a.projection);
  }
  // Attach the PRA composite projection where all three components exist.
  for (const a of allAnalyses) {
    if (a.error) continue;
    const pg = praByPlayerGame[`${a.player}|${a.gameId || a.opponent}`];
    if (pg && pg.ptsProj != null && pg.rebProj != null && pg.astProj != null) {
      a.praProjection = computePRAProjection(pg.ptsProj, pg.rebProj, pg.astProj);
    }
  }

  // STEP 5: Organize output
  const successful = allAnalyses.filter(a => !a.error && a.recommendation !== 'PASS');
  const passes = allAnalyses.filter(a => a.recommendation === 'PASS');
  const errors = allAnalyses.filter(a => a.error);

  // Rank by EMPIRICAL tier first (what actually hits), then finalEdge as tiebreak.
  // The old finalEdge-only sort floated points-overs to the top because finalEdge
  // rewarded the inflated projection; this puts validated assists/rebounds unders first.
  const EMP_RANK = { GUARANTEED: 6, PLATINUM: 5, GOLD: 4, LEAN: 3, UNGRADED: 2, PASS: 1, AVOID: 0, BANNED: 0 };
  successful.sort((a, b) => {
    const ar = EMP_RANK[a.empTier?.tier] ?? 2;
    const br = EMP_RANK[b.empTier?.tier] ?? 2;
    if (ar !== br) return br - ar;
    return (b.scores?.finalEdge || 0) - (a.scores?.finalEdge || 0);
  });

  // ── COLLAPSE: every prop → one verdict (stages 2-4 + under-only routing) ──
  // Stage 3 game guard, computed per game from the projected total vs the market total.
  const gameGuardById = {};
  for (const g of Object.values(gameContexts)) {
    const pt = g.projectedTotal;
    const gap = (pt && Number.isFinite(Number(g.total)) && Number(g.total) > 0)
      ? Number((pt.total - Number(g.total)).toFixed(1)) : null;
    gameGuardById[g.gameId] = (gap != null && Math.abs(gap) > GAME_GUARD_THRESHOLD)
      ? { suppress: true, modelTotal: pt.total, marketTotal: Number(g.total), gap }
      : { suppress: false, modelTotal: pt?.total ?? null, marketTotal: Number(g.total) || null, gap };
    g.gameGuard = gameGuardById[g.gameId];   // surfaced on the game row
  }
  // Resolve one verdict per prop and stamp it as the authoritative call.
  for (const a of successful) {
    a.verdict = resolveVerdict(a, gameGuardById[a.gameId]);
  }

  // Signal selector (Tonight's Signal / bestPlays) obeys the SAME confidence block
  // grading does: eligible UNDER verdicts only — never an over, a killed play, or a
  // game with no defense data. This closes the selector gate that let a no-data game
  // become the featured signal.
  const bestPlays = successful
    .filter(a => a.verdict?.call === 'UNDER' && a.verdict?.signalEligible)
    .slice(0, 10);

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

  // Injury summary for the UI: who was removed (out) and who benefits, grouped
  // by team. Beneficiaries are derived from the surviving analyses' benefitsFrom.
  const beneficiaryByName = {};
  for (const a of allAnalyses) {
    if (a.benefitsFrom && !beneficiaryByName[a.player]) {
      beneficiaryByName[a.player] = {
        player: a.player, team: a.team,
        minGain: a.benefitsFrom.minGain,
        projMinutes: a.benefitsFrom.projMinutes,
        becauseOut: a.benefitsFrom.out,
      };
    }
  }
  const injuriesSummary = {
    out: removedOut,                                   // [{player, team, detail}]
    beneficiaries: Object.values(beneficiaryByName)    // [{player, team, minGain, projMinutes, becauseOut}]
      .sort((x, y) => y.minGain - x.minGain),
  };

  return {
    date,
    buildTag: 'futureproof-alpha-2026-08-18',   // deploy marker — confirms this code is live
    ppLines: { ok: ppLines.ok, standardCount: ppLines.standardCount || 0, altCount: ppLines.altCount || 0, blocked: !!ppLines.blocked },
    season,
    games: Object.values(gameContexts),
    analyses: successful,
    passes,
    errors,
    bestPlays,
    injuries: injuriesSummary,
    warnings,
    summary: {
      games: games.length,
      teams: games.length * 2,
      playersAnalyzed: new Set(allAnalyses.map(a => a.player)).size,
      totalAnalyses: allAnalyses.length,
      recommendations: successful.length,
      passes: passes.length,
      removedOut: removedOut.length,
      errors: errors.length,
      durationMs: Date.now() - startedAt,
      // Deploy/verification marker: tells you at a glance whether the defense
      // feed is live (teams>0) or not yet deployed/no data (teams=0).
      defenseTable: {
        version: 'defense-v1',
        teams: Object.keys(defenseTable?.byTeam || {}).length,
        builtAt: defenseTable?._audit?.builtAt || null,
        audit: defenseTable?._audit || null,
      },
      // Marker for the empirical totals rule: proxyLine non-null means it's live.
      empiricalTotals: {
        version: 'emp-totals-v1',
        active: !!empiricalTotals,
        proxyLine: empiricalTotals?.proxyLine ?? null,
        audit: empiricalTotals?._audit || null,
      },
      // BDL player-prop marker: distinguishes "no key/401 (tier)" vs "games but
      // zero prop rows (BDL carried none)" vs "rows present but names didn't join"
      // (lineCount>0 but few props end up 'provided'). The feed is otherwise silent
      // on a 0-row success, so this is the single field that tells the three apart.
      bdlProps: {
        version: 'bdl-props-v1',
        available: bdlPropsAvailable,
        lineCount: Object.keys(bdlPropLines).length,
        audit: bdlProps?._audit || null,
      },
      // BDL season player-logs marker (cold-form recentForm source). players>0 with
      // statsEndpoint '/player_stats' => feed live; 0 with a warning => endpoint/tier.
      bdlPlayerLogs: {
        version: 'bdl-logs-v1',
        players: Object.keys(bdlPlayerLogs.byName || {}).length,
        audit: bdlPlayerLogs?._audit || null,
      },
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

// ── GROUNDED PER-CARD REASONS ────────────────────────────────────────────────
// Plain-English explanations of WHY a pick leans over/under — but every reason
// fires ONLY from a real computed number crossing a threshold. Nothing here is
// invented flavor; un-groundable factors (coverage scheme, opponent whistle) are
// silent unless their feed is populated. Each reason is { dir:'OVER'|'UNDER'|'BOTH',
// tag, text }; the card shows the ones matching the pick's lean direction.
function buildPropReasons(ctx) {
  const { market, unified, shotProfile: sp, shotsToClear: stc, minutesSecurity: ms,
          reboundExtras, raw, propSignal, opponent, spinRead, opponentStyle, adaptiveRead, blowoutRisk } = ctx;
  const mk = String(market || '').toLowerCase();
  const m = unified?.multipliers || {};
  const opp = opponent || 'the opponent';
  const out = [];
  const add = (dir, tag, text) => out.push({ dir, tag, text });
  const r1 = (x) => Math.round(x * 10) / 10;

  // Per-player suppression correction — the model's chronic bias on this player.
  if (ctx.lowSample) add('UNDER', 'THIN SAMPLE',
    `Only ${ctx.lowSample.games} recent games — a rookie, call-up, return, or early-season move. Baseline is unstable; read shown but not signal-eligible.`);
  if (ctx.biasCorrection && ctx.biasCorrection.correction) {
    const bc = ctx.biasCorrection;
    if (bc.correction > 0) add('UNDER', 'SUPPRESSION FADE',
      `Model chronically under-projects this player (${bc.fromRolling ? 'recent' : 'season'} bias +${bc.bias} over ${bc.n}) — projection lifted +${bc.correction}; treat the under with caution.`);
    else add('UNDER', 'OVER-PROJECTED',
      `Model chronically over-projects this player (bias ${bc.bias} over ${bc.n}) — projection trimmed ${bc.correction}; the under is stronger than the raw number.`);
  }
  // Blowout risk (spread-derived) — suppresses counting stats game-wide, underdog most.
  if (blowoutRisk) add('UNDER', blowoutRisk.isUnderdog ? 'BLOWOUT RISK · UNDERDOG' : 'BLOWOUT RISK',
    blowoutRisk.note);

  // Adaptive shrinkage regime (points): a hot-shooting spike gets shrunk toward
  // baseline (variance → leans under vs an inflated line); a volume/role riser is
  // trusted (real → leans over). Only speaks when the regime is decisive.
  if (adaptiveRead) {
    if (adaptiveRead.regime === 'ROLE_REANCHOR') add('OVER', 'ROLE RE-ANCHOR',
      `Inheriting starter minutes${adaptiveRead.reanchor ? ` (~${Math.round(adaptiveRead.reanchor.projMin)} min)` : ''} — baseline re-anchored from ${adaptiveRead.baseProjection} to ${adaptiveRead.adjProjection} pts; the old form line understates the new role.`);
    else if (adaptiveRead.regime === 'HOT_SHOOTING') add('UNDER', 'HOT-SHOOTING NOISE',
      `Recent points are up on shooting efficiency, not shot volume — the model shrinks a hot streak toward the ${adaptiveRead.baseProjection} baseline rather than chasing it.`);
    else if (adaptiveRead.regime === 'RISING') add('OVER', 'REAL RISER',
      `Shot volume is up with role/opportunity support (not just a hot streak) — the form-adjusted baseline rises to ${adaptiveRead.adjProjection}.`);
    else if (adaptiveRead.regime === 'COLD_SHOOTING') add('OVER', 'COLD-SHOOTING NOISE',
      `Recent dip is efficiency, not lost volume — treated as variance and shrunk back toward the ${adaptiveRead.baseProjection} baseline.`);
    // Rebounds / assists rate regimes.
    else if (adaptiveRead.regime === 'HOT_FINISHING') add('UNDER', 'TEAMMATE-FINISHING NOISE',
      `Assists are up on steady minutes, not more creation — an assist needs a teammate to make the shot, so this shrinks toward the ${adaptiveRead.baseProjection} baseline as likely finishing luck.`);
    else if (adaptiveRead.regime === 'COLD_FINISHING') add('OVER', 'FINISHING VARIANCE',
      `Assists dipped on teammate cold-shooting, not lost creation — shrunk back toward the ${adaptiveRead.baseProjection} baseline.`);
    else if (adaptiveRead.regime === 'RATE_UP') add('OVER', 'BOARD RATE UP',
      `Grabbing a higher rebound rate on steady minutes — rebound rate is sticky, so this is treated as mostly real (adjusted to ${adaptiveRead.adjProjection}).`);
    else if (adaptiveRead.regime === 'MINUTES_UP') add('OVER', 'MINUTES UP',
      `More minutes lately lift the ${mk} baseline to ${adaptiveRead.adjProjection}.`);
  }

  // Opponent style (data-grounded scheme proxy). Rebounds: a perimeter-heavy
  // opponent generates long misses that leak to guards/wings; a paint team keeps
  // misses short for the bigs. Under-environment: a fast/high-scoring opponent
  // means more possessions (pressures unders); a slow/low-scoring one favors them.
  if (opponentStyle && Array.isArray(opponentStyle.tags)) {
    if (mk === 'rebounds') {
      if (opponentStyle.missProfile === 'PERIMETER') add('BOTH', 'LONG MISS',
        `${opp} is three-heavy (${opponentStyle.threePct}% of shots) — long misses carom past the paint, so boards leak to guards and wings.`);
      else if (opponentStyle.missProfile === 'PAINT') add('BOTH', 'SHORT MISS',
        `${opp} is paint-oriented — misses stay short in the restricted area, favoring the biggest bodies.`);
    }
    if (opponentStyle.underEnv === 'SUPPRESS') add('UNDER', 'SLOW ENV',
      `${opp}'s recent games run slow/low-scoring — fewer possessions, a mildly favorable under environment.`);
    else if (opponentStyle.underEnv === 'FAST') add('OVER', 'FAST ENV',
      `${opp}'s recent games run fast/high-scoring — more possessions and scoring chances, which pressures unders.`);
    if (opponentStyle.styleShift) add('BOTH', 'STYLE SHIFT',
      `${opp} has shifted look lately (${opponentStyle.styleShift.from}→${opponentStyle.styleShift.to} over their last 5) — recent games matter more than the season here.`);
  }

  // Role change from the Spin blurb — applies to ALL markets (a demotion crushes
  // points, rebounds AND assists at once). Only when the note is still fresh.
  if (spinRead && spinRead.active) {
    if (spinRead.side === 'UNDER') add('UNDER', 'STALE STARTER',
      `Recently benched${spinRead.replacedBy ? ' for ' + spinRead.replacedBy : ''}${spinRead.gap != null ? ` — production fell ${spinRead.gap} pts in the reserve role` : ''}. Line still reflects the old starter role.`);
    else if (spinRead.side === 'OVER') add('OVER', 'ROLE BUMP',
      `Recently moved into the starting lineup — minutes and usage step up.`);
  }

  if (mk === 'points') {
    const minAvg = Number(sp?.minAvg) || Number(unified?.expectedMinutes) || null;
    if (sp && minAvg) {
      const fga = (sp.f2aPerMin + sp.f3aPerMin) * minAvg;
      const fta = sp.ftaPerMin * minAvg;
      if (fga < 10) add('UNDER', 'LOW VOLUME',
        `Projects only ~${r1(fga)} field-goal attempts in ${Math.round(minAvg)} min — not enough volume to comfortably clear a scoring line.`);
      else if (fga >= 16) add('OVER', 'HIGH VOLUME',
        `High shot volume — ~${r1(fga)} attempts a night gives plenty of chances to get there.`);
      if (fta < 2) add('UNDER', 'NO FT CUSHION',
        `Rarely gets to the line (~${r1(fta)} FTA/game), so there's no free-throw cushion if shots aren't falling.`);
      else if (fta >= 6) add('OVER', 'FT FLOOR',
        `Lives at the line (~${r1(fta)} FTA/game) — free throws give the over a floor even on a cold shooting night.`);
      if (sp.pct2 != null && sp.pct2 < 0.44) add('UNDER', 'COLD 2PT',
        `Converting a cold ${Math.round(sp.pct2 * 100)}% on twos lately — inefficient looks drag the scoring down.`);
      if (sp.pct3 != null && sp.pct3 >= 0.40 && sp.f3aPerMin * minAvg >= 4) add('OVER', 'HOT 3PT',
        `Hot from three (${Math.round(sp.pct3 * 100)}% on ~${r1(sp.f3aPerMin * minAvg)} attempts) — three-point volume raises the ceiling fast.`);
      if (stc && stc.mean > 0 && stc.sd / stc.mean >= 0.28) add('BOTH', 'STREAKY',
        `Streaky scorer — game-to-game swing of ±${r1(stc.sd)} around a ${r1(stc.mean)} projection makes the line closer to a coin-flip than it looks.`);
    }
    // Minutes security — the master variable from the PBP audit.
    if (ms && ms.level === 'RISK') add('UNDER', 'MINUTES RISK',
      `Floating/volatile minutes — the projection over-shoots when playing time falls short, so the read leans under.`);
    else if (ms && ms.level === 'SECURE') add('BOTH', 'MINUTES SECURE',
      `Locked rotation role — minutes are dependable, so the projection is trustworthy in either direction.`);
    if (m.matchup_opposingDefense != null) {
      if (m.matchup_opposingDefense < 0.97) add('UNDER', 'TOUGH D',
        `${opp} grades as a tough scoring matchup — good looks are harder to come by.`);
      else if (m.matchup_opposingDefense > 1.03) add('OVER', 'SOFT D',
        `${opp} gives up clean looks in this matchup — the model marks scoring up.`);
    }
  }

  if (mk === 'assists') {
    if (Number.isFinite(Number(unified?.projection)) && Number.isFinite(Number(unified?.line))) {
      const gap = Number(unified.line) - Number(unified.projection);
      if (gap >= 1.0) add('UNDER', 'BELOW LINE',
        `Projects ${r1(unified.projection)} assists against a ${unified.line} line — the setup volume isn't there most nights.`);
      else if (gap <= -1.0) add('OVER', 'ABOVE LINE',
        `Projects ${r1(unified.projection)} assists over a ${unified.line} line — creating more than the book is pricing.`);
    }
    if (m.coverage_coachingScheme != null && m.coverage_coachingScheme < 0.97) add('UNDER', 'COVERAGE',
      `${opp}'s scheme pressures the primary handler off the ball, shifting them out of the playmaking role.`);
  }

  if (mk === 'rebounds') {
    const env = reboundExtras?.environment;
    if (env?.oppProfileSource === 'REAL' && env.oppType) {
      if (env.oppType === 'PERIMETER') add('BOTH', 'LONG MISS',
        `${opp} shoots a lot of threes — long misses carom past the paint, so boards leak to guards and wings rather than the primary big.`);
      else if (env.oppType === 'DOWNHILL_PAINT') add('BOTH', 'SHORT MISS',
        `${opp} attacks the paint — short misses stay in the restricted area, favoring the biggest bodies.`);
    }
    const eq = reboundExtras?.equity?.equityMultiplier;
    if (eq != null && eq <= 0.95) add('UNDER', 'EQUITY −',
      `Rebound share works against this player's role in the matchup — fewer available boards come their way.`);
    else if (eq != null && eq >= 1.05) add('OVER', 'EQUITY +',
      `Rebound share favors this player's role tonight — more available boards funnel to them.`);
  }

  const tov = Number(raw?.TOV ?? raw?.tov ?? raw?.TO);
  if (Number.isFinite(tov) && tov >= 3) add('UNDER', 'TURNOVERS',
    `Turnover-prone (~${r1(tov)} a game) — possessions that end without a made shot, assist, or rebound.`);
  if (propSignal && propSignal.recent != null && propSignal.baseline != null
      && propSignal.side === 'UNDER' && propSignal.recent < propSignal.baseline)
    add('UNDER', 'COOLING', `Cooling off — last few games (~${r1(propSignal.recent)}) are running below the season baseline (${r1(propSignal.baseline)}).`);
  if (m.usageFunnel != null && m.usageFunnel > 1.02) add('OVER', 'USAGE FUNNEL',
    `A teammate is out — usage funnels up (${r1(m.usageFunnel)}× the normal share of touches).`);

  return out;
}

// ── SHOTS-TO-CLEAR: shot profile + distributional points estimate ────────────
// Builds a per-player scoring mechanism from raw BDL game logs and reads
// P(points > line) off the resulting distribution instead of a single mean.
// All inputs come straight from the game logs — no team totals needed.
//
// There is no shot-location data in BDL for the WNBA, so "hot spots" aren't
// available; the 2PA/3PA/FTA mix is the closest proxy for HOW a player scores
// (rim-pressure vs jump-shooter vs whistle-drawer). Foul/whistle factors ride in
// through the FTA rate and FT%.

function _parseMin(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v);
  if (s.includes(':')) { const [m, sec] = s.split(':'); return (Number(m) || 0) + (Number(sec) || 0) / 60; }
  return Number(s) || 0;
}
function _numf(...vals) { for (const v of vals) { const n = Number(v); if (Number.isFinite(n)) return n; } return 0; }

/**
 * Recent shooting form (bonus card read): raw last-10 and last-5 window shooting
 * straight from the game logs. FGA is avg attempts/game, fgPct is real FG% over the
 * window (makes÷attempts), tsPct is true shooting (PTS ÷ 2(FGA + 0.44·FTA)). Shows
 * customers who's actually producing before the matchup, alongside the projection.
 * @param {Array} games  raw game rows (sorted oldest→newest if dated)
 * @returns {Object|null} { l10:{gp,fga,fgPct,tsPct,ppg}, l5:{...} }
 */
// ── SINGLE-VERDICT PIPELINE ──────────────────────────────────────────────────
// Every prop enters once and exits with exactly ONE verdict — OVER, UNDER, or PASS.
// No stage sits beside another stage's call; each can only narrow toward the verdict.
// This collapses the two subsystems that used to co-render (bidirectional v2
// projection + under-only validated model) so nothing can lean both ways again.
//
// Stage 1 (signed edge) is a.recommendation / a.edge, computed upstream.
// Stage 2: a role/minutes veto CONSUMES the tier — it doesn't annotate it. The tier
//   hit-rates were measured on stable-role players, so an unstable role invalidates
//   the tier's premise (that number doesn't describe this play) → kill, one grade out.
// Stage 3: a game-level projection guard — if the model total disagrees with the
//   market total by more than the model's own error, that's ONE broken projection,
//   not N edges; suppress the game's props rather than grade a cascade.
// Stage 4: data-sufficiency floor — a prop with no defense data can't be a signal.
// Routing: UNDER is the only validated, bettable side (June backtest found no
//   tradeable over signal). Over gaps are computed and shown as CONTEXT, never
//   promoted to a bettable tier. If the only edge is on the over side → PASS.
const GAME_GUARD_THRESHOLD = 12.7;   // model-vs-market total gap that flags a broken game projection

function resolveVerdict(a, gameGuard) {
  const side = String(a.recommendation || '').toUpperCase();   // OVER | UNDER | PASS
  const edge = a.edge;
  // Data floor: no defense data, OR too thin a player baseline (rookie/trade/return).
  const dataOk = !((a.hardFlags || []).includes('NO DEFENSE DATA')) && !a.lowSample;

  // Stage 3 — game projection guard (runs first: a broken game invalidates all its props).
  if (gameGuard?.suppress) {
    return { call: 'PASS', tier: 'PASS', side, edge, signalEligible: false, killedBy: 'GAME_PROJECTION',
      note: `Model total ${gameGuard.modelTotal} vs market ${gameGuard.marketTotal} (${gameGuard.gap > 0 ? '+' : ''}${gameGuard.gap}) — a calibrated model almost never misses a sharp total by this much, so this is one broken projection, not a slate of edges. Props suppressed for this game.` };
  }

  // Routing — overs are context only, never a bettable tier.
  if (side === 'OVER') {
    return { call: 'PASS', tier: 'CONTEXT', side: 'OVER', edge, signalEligible: false,
      note: `Over gap ${edge > 0 ? '+' : ''}${edge} shown as context — there is no validated over tier (backtest found no tradeable over signal), so it is never promoted to a bet.` };
  }
  if (side !== 'UNDER') {
    return { call: 'PASS', tier: 'PASS', side, edge, signalEligible: false };
  }

  // Stage 2 — veto CONSUMES the under tier. Role instability invalidates the premise.
  const vetoes = [];
  if (a.biasVeto) vetoes.push(`chronically under-projected (+${a.biasVeto.correction} correction lifts ${a.biasVeto.rawProjection}→line)`);
  if (a.minutesConflict) vetoes.push('model/minutes conflict');
  if (a.roleConflict) vetoes.push('inheriting starter minutes (role re-anchor)');
  if (a.spinRead?.active) vetoes.push(`role change — ${a.spinRead.badge}`);
  if (a.adaptiveRead?.regime === 'ROLE_REANCHOR') vetoes.push('minutes inherited from an absence');
  if (a.minutesSecurity?.level === 'RISK') vetoes.push('minutes at risk');
  if (a.benefitsFrom && Array.isArray(a.benefitsFrom.out) && a.benefitsFrom.out.length && Number(a.benefitsFrom.minGain) >= 3) {
    vetoes.push(`role boosted by ${a.benefitsFrom.out.join(', ')} out`);
  }
  if (vetoes.length) {
    return { call: 'PASS', tier: 'PASS', side: 'UNDER', edge, signalEligible: false, killedBy: 'ROLE_UNSTABLE',
      note: `Tier premise invalid: the under hit-rate was measured on stable-role players, but ${vetoes.join('; ')} — that number doesn't describe this play. Vetoed to PASS.` };
  }

  // Survived every stage — the UNDER verdict stands as the single call. Data floor
  // governs whether it's eligible to be surfaced as a signal.
  return { call: 'UNDER', tier: a.tier, side: 'UNDER', edge, confidence: a.confidence, signalEligible: dataOk };
}

// ── ADAPTIVE SHRINKAGE ───────────────────────────────────────────────────────
// Regression-to-the-mean with an evidence-driven weight. Move a BASELINE toward
// RECENT by w = n/(n+K), where n is recent sample measured in OPPORTUNITIES (not
// games) and K is prior skepticism. Evidence of a real regime change lowers K so
// recent data moves the estimate fast; absent evidence, K stays high and recent is
// shrunk hard toward baseline. This one estimator will later serve player form,
// opponent adjustment, and projection-bias correction — three priors, one machine.
// Seed per-player projection-bias from the 1,670-pick audit. [bias, n]; bias =
// mean(actual - projection), + = model under-projects. FALLBACK ONLY — a rolling
// map passed in the request supersedes this, since bias drifts (e.g. a role change
// can flip a player's sign between months). Never hard-kill an under on seed alone.
const PLAYER_BIAS_SEED = {
  'aja wilson': {points:[-2.9,11], rebounds:[1.2,11]},
  'aliyah boston': {points:[-2.6,11], assists:[-1.0,11]},
  'allisha gray': {points:[-2.6,13], assists:[1.2,13]},
  'alyssa thomas': {points:[-5.0,10], rebounds:[1.2,9]},
  'aneesah morrow': {points:[-4.6,6], rebounds:[-2.6,6]},
  'angel reese': {points:[-2.5,13], rebounds:[2.4,13]},
  'arike ogunbowale': {points:[-2.5,11], rebounds:[1.2,11]},
  'awa fam': {points:[-1.6,11], rebounds:[-1.0,11]},
  'azzi fudd': {points:[-1.3,9]},
  'breanna stewart': {points:[1.4,12]},
  'bridget carleton': {points:[-3.0,10], rebounds:[2.1,10]},
  'brittney griner': {points:[-1.8,6]},
  'carla leite': {points:[-4.5,10]},
  'chelsea gray': {points:[-2.3,12]},
  'courtney williams': {points:[-3.3,9]},
  'dearica hamby': {points:[-2.1,10]},
  'dominique malonga': {rebounds:[1.2,11]},
  'flaujae johnson': {points:[2.3,12]},
  'gabby williams': {points:[-4.5,9]},
  'jackie young': {points:[3.9,14]},
  'jessica shepard': {points:[-2.3,10], assists:[-1.2,10], rebounds:[2.8,9]},
  'jonquel jones': {points:[-2.1,13], rebounds:[-1.1,13]},
  'kayla mcbride': {points:[3.5,12]},
  'kelsey mitchell': {points:[1.3,11], rebounds:[1.2,11]},
  'kiki iriafen': {rebounds:[1.4,11]},
  'marina mabrey': {points:[-2.5,10]},
  'michaela onyenwere': {points:[-1.6,12]},
  'monique akoa makani': {points:[-1.5,7]},
  'natasha howard': {points:[-3.2,12]},
  'natisha hiedeman': {points:[-1.3,14], rebounds:[1.2,14]},
  'nneka ogwumike': {assists:[1.4,10], rebounds:[1.3,10]},
  'olivia miles': {points:[2.6,12], assists:[2.1,12]},
  'paige bueckers': {points:[2.0,10]},
  'pauline astier': {points:[-2.7,10]},
  'rae burrell': {assists:[1.1,8]},
  'rhyne howard': {points:[-2.4,13], rebounds:[1.0,13]},
  'shakira austin': {points:[-5.0,12]},
  'skylar diggins': {points:[-3.7,8]},
  'sonia citron': {points:[-2.2,11]},
  'sophie cunningham': {points:[-3.5,11]},
  'sydney taylor': {assists:[1.0,6]},
  'veronica burton': {points:[-5.2,9]},
};

// Per-player suppression correction. Look up this player+market's projection bias
// (rolling override first, else the seed), shrink it toward zero by sample size so
// thin data barely moves, and return the capped correction to ADD to the projection.
// Positive lifts an under-projected player (fades their under); negative lowers an
// over-projected one (strengthens the under). `fromRolling` marks trustworthy live
// data vs the older seed.
function playerBiasCorrection(name, market, override) {
  // Own normalizer (module-scope safe) — matches how the seed keys were built:
  // lowercase, strip accents and non-[a-z ], collapse spaces. Must NOT reference the
  // function-local _normName inside buildAndRunAnalysis.
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const key = norm(name);
  const mk = String(market || '').toLowerCase();
  let src = null, fromRolling = false;
  if (override && override[key] && override[key][mk]) { src = override[key][mk]; fromRolling = true; }
  else if (PLAYER_BIAS_SEED[key] && PLAYER_BIAS_SEED[key][mk]) { src = PLAYER_BIAS_SEED[key][mk]; }
  if (!src) return null;
  const bias = Number(src[0]), n = Number(src[1]);
  if (!Number.isFinite(bias) || !Number.isFinite(n) || n < 4) return null;
  const s = shrinkToward(0, bias, n, 10);           // K=10: n=14 keeps ~58%, n=6 ~38%
  const correction = Math.max(-4, Math.min(4, Number(s.value.toFixed(1))));
  return { bias, n, correction, fromRolling, weight: s.weight };
}

function shrinkToward(baseline, recent, nOpportunities, K) {
  const n = Math.max(0, Number(nOpportunities) || 0);
  const k = Math.max(1e-6, Number(K) || 1);
  const w = n / (n + k);
  const b = Number(baseline), r = Number(recent);
  if (!Number.isFinite(b)) return { value: r, weight: 1, w };
  if (!Number.isFinite(r)) return { value: b, weight: 0, w: 0 };
  return { value: b + w * (r - b), weight: Number(w.toFixed(3)) };
}

// Regime evidence → a multiplier that lowers the OPPORTUNITY K (moves the estimate
// faster). Follows the hierarchy: role change fastest, then opportunity, then
// process, then pure outcome. Each independent signal compounds.
function regimeEvidenceMult({ spinRead, minutesSecurity, benefitsFrom, shootingForm }) {
  let mult = 1;
  // ROLE change (fastest): Spin role move or an injury-driven role.
  if (spinRead && spinRead.active) mult *= 2.2;
  else if (benefitsFrom && Array.isArray(benefitsFrom.out) && benefitsFrom.out.length) mult *= 1.7;
  // OPPORTUNITY change (fast): secure/elevated minutes, and PERSISTENCE — the L5
  // volume move holding vs L10 rather than one spike game.
  if (minutesSecurity && minutesSecurity.level === 'SECURE') mult *= 1.3;
  const l5 = shootingForm?.l5, l10 = shootingForm?.l10;
  if (l5 && l10 && l5.fga != null && l10.fga != null) {
    const persist = Math.abs(l5.fga - l10.fga);   // volume shift that L10 already partly reflects
    if (persist >= 2) mult *= 1.25;               // the change is sticking across the window
  }
  return Math.min(mult, 3.5);   // cap so no single pick swings wildly
}

// Points decomposition: points = FGA (opportunity, sticky) × points-per-FGA
// (efficiency, noisy). Shrink each axis separately — opportunity with a small K
// (trust recent volume), efficiency with a large K (hot shooting is shrunk hard) —
// then recombine. Baseline = L10, recent = L5. ADDITIVE for now (shadow mode):
// emits an adjusted read + regime label; does not yet override the projection.
function buildAdaptivePoints({ shootingForm, evidence = {}, minutes = {} }) {
  const base = shootingForm?.l10, recent = shootingForm?.l5;
  if (!base || !recent || !(base.fga > 0) || !(recent.fga > 0)) return null;
  let baseFga = base.fga, recentFga = recent.fga;
  const basePps = base.ppg / base.fga, recentPps = recent.ppg / recent.fga;

  // ROLE RE-ANCHOR — the Nelson-Ododa fix. When a player inherits an absent
  // starter's minutes (benefitsFrom → projected minutes >> their baseline minutes),
  // BOTH L10 and L5 reflect the OLD bench role. Shrinking between two stale windows
  // can't see the new role. So scale the opportunity baseline to the projected
  // minutes (per-minute shot rate × new minutes) BEFORE shrinkage runs. Efficiency
  // (points-per-shot) is rate-based and role-independent, so it carries over.
  let reanchor = null;
  const baseMin = Number(minutes.baseline), projMin = Number(minutes.projected);
  if (Number.isFinite(baseMin) && baseMin > 5 && Number.isFinite(projMin) && projMin > baseMin * 1.12) {
    const fgaPerMin = baseFga / baseMin;
    const newFga = fgaPerMin * projMin;
    reanchor = { fromFga: Number(baseFga.toFixed(1)), toFga: Number(newFga.toFixed(1)), baseMin, projMin,
      fromPts: Number((baseFga * basePps).toFixed(1)), toPts: Number((newFga * basePps).toFixed(1)) };
    baseFga = newFga;                 // opportunity baseline now reflects the new role
  }

  const nOpp = recentFga * (recent.gp || 5);
  const evMult = regimeEvidenceMult(evidence);
  const K_OPP = 30 / evMult;
  const K_EFF = 90;

  // With a fresh re-anchor, recent volume is stale for the new role → trust the
  // re-anchored baseline for opportunity rather than shrinking toward stale recent.
  let oppValue, oppWeight;
  if (reanchor) { oppValue = baseFga; oppWeight = 0; }
  else { const o = shrinkToward(baseFga, recentFga, nOpp, K_OPP); oppValue = o.value; oppWeight = o.weight; }
  const eff = shrinkToward(basePps, recentPps, nOpp, K_EFF);
  const adjProjection = Number((oppValue * eff.value).toFixed(1));
  const baseProjection = Number((base.fga * basePps).toFixed(1));   // pre-re-anchor baseline

  const fgaDelta = recentFga - base.fga, ppsDelta = recentPps - basePps;
  let regime, regimeNote;
  if (reanchor) { regime = 'ROLE_REANCHOR'; regimeNote = `inheriting starter minutes — baseline re-anchored ${reanchor.fromPts}→${reanchor.toPts} pts at ${Math.round(projMin)} min`; }
  else if (fgaDelta >= 2 && evMult > 1.2) { regime = 'RISING'; regimeNote = 'volume up with role/opportunity support — real riser'; }
  else if (fgaDelta >= 2) { regime = 'VOLUME_UP'; regimeNote = 'taking more shots lately'; }
  else if (Math.abs(fgaDelta) < 1.5 && ppsDelta >= 0.18) { regime = 'HOT_SHOOTING'; regimeNote = 'points up on efficiency, not volume — shrunk toward baseline as likely variance'; }
  else if (Math.abs(fgaDelta) < 1.5 && ppsDelta <= -0.18) { regime = 'COLD_SHOOTING'; regimeNote = 'efficiency dip on steady volume — treated as variance'; }
  else if (fgaDelta <= -2) { regime = 'VOLUME_DOWN'; regimeNote = 'fewer shots lately'; }
  else { regime = 'STABLE'; regimeNote = 'no meaningful regime change'; }

  return {
    adjProjection, baseProjection,
    delta: Number((adjProjection - baseProjection).toFixed(1)),
    regime, regimeNote, evidenceMult: Number(evMult.toFixed(2)), reanchor,
    opportunity: { base: Number(base.fga.toFixed(1)), reanchored: reanchor ? reanchor.toFga : null, recent: recentFga, adjusted: Number(oppValue.toFixed(1)), weight: oppWeight },
    efficiency: { basePps: Number(basePps.toFixed(2)), recentPps: Number(recentPps.toFixed(2)), adjusted: Number(eff.value.toFixed(2)), weight: eff.weight },
    nOpp, kOpp: Number(K_OPP.toFixed(1)), kEff: K_EFF,
  };
}

// Rebounds / assists decomposition: STAT = minutes (opportunity, sticky) × per-minute
// RATE. The rate is the analog of the points efficiency axis — but the two markets sit
// at opposite ends of stickiness, so they get very different shrinkage:
//   • Rebounds: rate (reb/min) is a stable role/physical trait — shrink LIGHTLY (small
//     K). The noisy part is how many misses were available (game environment), which
//     the opponent miss-profile partly explains, not the player.
//   • Assists: rate (ast/min) carries heavy TEAMMATE-FINISHING noise — an assist only
//     counts if a teammate makes the shot, which is out of the player's control. So a
//     recent assist spike on flat minutes is the hot-shooting analog and is shrunk HARD
//     (large K). Honest ceiling: without potential-assist tracking (no WNBA feed), we
//     can't isolate creation from finishing the way FGA/TS% isolate volume from luck.
// Minutes re-anchors to projected minutes on a role change, same as points.
function buildAdaptiveCounting({ market, shootingForm, evidence = {}, minutes = {} }) {
  const base = shootingForm?.l10, recent = shootingForm?.l5;
  if (!base || !recent) return null;
  const isReb = market === 'rebounds';
  const statKey = isReb ? 'reb' : 'ast';
  const rateKey = isReb ? 'rebPerMin' : 'astPerMin';
  const baseMin = Number(base.min), recentMin = Number(recent.min);
  if (!(baseMin > 0) || !(recentMin > 0)) return null;
  const baseRate = Number(base[rateKey]) || 0, recentRate = Number(recent[rateKey]) || 0;

  // Re-anchor minutes to projected if a role change (both windows are stale otherwise).
  let anchorMin = baseMin, reanchor = null;
  const projMin = Number(minutes.projected), bMin = Number(minutes.baseline) || baseMin;
  if (Number.isFinite(projMin) && bMin > 5 && projMin > bMin * 1.12) {
    anchorMin = projMin;
    reanchor = { fromMin: Number(bMin.toFixed(1)), toMin: Number(projMin.toFixed(1)),
      from: Number((baseRate * bMin).toFixed(1)), to: Number((baseRate * projMin).toFixed(1)) };
  }

  const nMin = recentMin * (recent.gp || 5);          // recent total minutes = evidence unit
  const evMult = regimeEvidenceMult(evidence);
  const K_RATE = isReb ? 55 : 95;                     // reb rate sticky (small K); ast rate noisy (large K)
  const K_MIN = 120 / evMult;                         // minutes opportunity, in minute-units

  let minValue, minWeight;
  if (reanchor) { minValue = anchorMin; minWeight = 0; }
  else { const o = shrinkToward(baseMin, recentMin, nMin, K_MIN); minValue = o.value; minWeight = o.weight; }
  const rate = shrinkToward(baseRate, recentRate, nMin, K_RATE);
  const adjProjection = Number((minValue * rate.value).toFixed(1));
  const baseProjection = Number((baseMin * baseRate).toFixed(1));

  const minDelta = recentMin - baseMin, rateDelta = recentRate - baseRate;
  const ratePctUp = baseRate > 0 ? rateDelta / baseRate : 0;
  let regime, regimeNote;
  if (reanchor) {
    regime = 'ROLE_REANCHOR';
    regimeNote = `inheriting minutes — baseline re-anchored ${reanchor.from}→${reanchor.to} at ${Math.round(projMin)} min`;
  } else if (minDelta >= 3 && evMult > 1.2) {
    regime = 'RISING'; regimeNote = 'minutes/role up with support — real riser';
  } else if (minDelta >= 3) {
    regime = 'MINUTES_UP'; regimeNote = 'more minutes lately';
  } else if (Math.abs(minDelta) < 2 && ratePctUp >= 0.20) {
    regime = isReb ? 'RATE_UP' : 'HOT_FINISHING';
    regimeNote = isReb
      ? 'grabbing a higher rebound rate on steady minutes — rebound rate is sticky, treated as mostly real'
      : 'assists up on steady minutes, not more creation — likely teammate hot-shooting, shrunk toward baseline';
  } else if (Math.abs(minDelta) < 2 && ratePctUp <= -0.20) {
    regime = isReb ? 'RATE_DOWN' : 'COLD_FINISHING';
    regimeNote = isReb ? 'rebound rate dipped on steady minutes' : 'assists down on teammate cold-shooting — treated as variance';
  } else {
    regime = 'STABLE'; regimeNote = 'no meaningful regime change';
  }

  return {
    market, adjProjection, baseProjection,
    delta: Number((adjProjection - baseProjection).toFixed(1)),
    regime, regimeNote, evidenceMult: Number(evMult.toFixed(2)), reanchor,
    opportunity: { baseMin: Number(baseMin.toFixed(1)), recentMin: Number(recentMin.toFixed(1)), adjustedMin: Number(minValue.toFixed(1)), weight: minWeight },
    rate: { base: Number(baseRate.toFixed(3)), recent: Number(recentRate.toFixed(3)), adjusted: Number(rate.value.toFixed(3)), weight: rate.weight, perGameBase: Number(base[statKey]), perGameRecent: Number(recent[statKey]) },
    nMin, kRate: K_RATE,
  };
}
// Project a game's total from recent team SCORING RATE (sticky) × opponent defense,
// shrunk toward league mean so recent FG% variance (the noisy part) doesn't drive
// it. Backtested on 101 games: corr 0.62 with actual, mean abs error ~12.7 pts,
// beats the naive league-average baseline. Halves: WNBA 1H is ~49.4% of the total
// empirically — essentially even, so we split near 50/50 rather than pretending to
// a per-team half edge the data doesn't support. This is a scoring-ENVIRONMENT read
// (and a market-total sanity check), not a precise number — carry the ±13 with it.
const FIRST_HALF_SHARE = 0.494;   // empirical WNBA 1H share of game total
function estimateGameTotal(homeAbbr, awayAbbr, defenseTable, totalLines) {
  const style = defenseTable?.teamStyle || {};
  const def = defenseTable?.teamDefense || {};
  const offH = style[homeAbbr]?.ppg, offA = style[awayAbbr]?.ppg;
  const allowH = def[homeAbbr]?.allowedPerGame, allowA = def[awayAbbr]?.allowedPerGame;
  if (![offH, offA, allowH, allowA].every(v => Number.isFinite(Number(v)))) return null;
  const ppgs = Object.values(style).map(s => s.ppg).filter(v => Number.isFinite(Number(v)));
  const lgPPG = ppgs.length ? ppgs.reduce((a, b) => a + b, 0) / ppgs.length : 82;
  // Shrink recent rates toward league (tames shooting variance — the FG% noise).
  const SHRINK = 0.25;
  const sh = (x) => x + SHRINK * (lgPPG - x);
  // Ratio/matchup method: expected points = own offense × opponent defense / league.
  const expHome = (sh(offH) * sh(allowA)) / lgPPG;
  const expAway = (sh(offA) * sh(allowH)) / lgPPG;
  const total = expHome + expAway;
  const projFirstHalf = total * FIRST_HALF_SHARE;
  const projSecondHalf = total * (1 - FIRST_HALF_SHARE);
  const FULL_ERR = 12.7, HALF_ERR = 7.5;   // half error scales ~1/√2 of the full-game error
  const out = {
    total: Number(total.toFixed(1)),
    home: Number(expHome.toFixed(1)),
    away: Number(expAway.toFixed(1)),
    firstHalf: Number(projFirstHalf.toFixed(1)),
    secondHalf: Number(projSecondHalf.toFixed(1)),
    error: FULL_ERR,
    method: 'recent scoring rate (shrunk 25% to league) × opponent defense',
    note: 'scoring-environment read, ±13; halves are near-even (~49/51), thin per-team signal',
  };
  // Grade the projection against each caller-provided line. A lean only fires when
  // the gap clears that line's error band — otherwise it's inside the noise (NONE).
  const grade = (proj, line, err) => {
    const l = Number(line);
    if (!Number.isFinite(l) || l <= 0) return null;
    const diff = Number((proj - l).toFixed(1));
    return { line: l, projected: Number(proj.toFixed(1)), diff, lean: Math.abs(diff) >= err ? (diff > 0 ? 'OVER' : 'UNDER') : 'NONE' };
  };
  const lines = totalLines || {};
  out.vsLines = {
    full: grade(total, lines.full, FULL_ERR),
    firstHalf: grade(projFirstHalf, lines.firstHalf, HALF_ERR),
    secondHalf: grade(projSecondHalf, lines.secondHalf, HALF_ERR),
  };
  return out;
}

function buildShootingForm(games) {
  if (!Array.isArray(games) || games.length === 0) return null;
  const withDate = games.every(g => g && (g.date || g.game_date));
  const sorted = withDate
    ? [...games].sort((a, b) => String(a.date || a.game_date).localeCompare(String(b.date || b.game_date)))
    : [...games];
  const played = sorted.filter(g => Number(g.minutes ?? g.min ?? g.mp) > 0);
  const win = (n) => {
    const g = played.slice(-n);
    if (!g.length) return null;
    const sum = (f) => g.reduce((a, x) => a + (Number(x[f]) || 0), 0);
    const fga = sum('fga'), fgm = sum('fgm'), fta = sum('fta'), pts = sum('pts');
    const reb = sum('reb'), ast = sum('ast'), min = sum('minutes');
    return {
      gp: g.length,
      fga: Number((fga / g.length).toFixed(1)),
      fgm: Number((fgm / g.length).toFixed(1)),        // avg makes/game — "shots they actually make"
      fgPct: fga > 0 ? Math.round((fgm / fga) * 100) : null,
      tsPct: (fga + 0.44 * fta) > 0 ? Math.round((pts / (2 * (fga + 0.44 * fta))) * 100) : null,
      ppg: Number((pts / g.length).toFixed(1)),
      reb: Number((reb / g.length).toFixed(1)),         // rebounds & assists per game
      ast: Number((ast / g.length).toFixed(1)),
      min: Number((min / g.length).toFixed(1)),          // minutes/game (opportunity base)
      rebPerMin: min > 0 ? reb / min : 0,                // rate axes — stickier than shooting
      astPerMin: min > 0 ? ast / min : 0,
    };
  };
  return { l10: win(10), l5: win(5) };
}

/**
 * REGRESSION WATCH — the fill-in shelf-life read. When a player is filling in for
 * absent teammate(s) (benefitsFrom.out), their recent shooting form is inflated by
 * the extra usage. This flags that, and — crucially — reads the absent star's injury
 * status + returnDate so the customer knows WHEN usage snaps back to them.
 *   REGRESSION WATCH  → a star is trending back (GTD, or returnDate within ~3 days):
 *                       the L5/L10 numbers are a ceiling, pullback imminent.
 *   ROLE-BOOSTED      → star still out with no near return: form is real for now,
 *                       but conditional. Only fires when recent form is actually up.
 * Future-proof: keys off the live injury feed + returnDate, so it updates itself as
 * statuses change — no hardcoding of who's out.
 */
// BLOWOUT RISK — a spread-derived under signal. Backtest (1,585 joined games): a
// 20+ blowout hits the under ~72%, and it splits winner 69% / loser 76%. The
// mechanism is NOT an NBA-style minutes cap — WNBA benches are short, so starters
// play through blowouts. Instead, once the game is decided BOTH sides ease: the
// winner coasts (over-perf -0.4) and the blown-out loser's offense tanks harder
// (-1.2). So this is a game-WIDE counting-stat under nudge, weighted toward the
// underdog (the likely loser), not gated to starters. Pre-game proxy = the spread.
function buildBlowoutRisk({ spread, isHome, usage }) {
  const s = Number(spread);
  if (!Number.isFinite(s)) return null;
  const absSpread = Math.abs(s);
  if (absSpread < 4) return null;                 // not enough spread for real blowout risk
  const favoredBy = isHome ? -s : s;              // + if this player's team is favored
  const isUnderdog = favoredBy < 0;               // getting the points → likely loser → suppresses more
  let risk;
  if (absSpread >= 9) risk = 'HIGH';
  else if (absSpread >= 6) risk = 'MODERATE';
  else risk = 'MILD';

  // ALPHA EXEMPTION — the primary usage option does NOT get the blowout under.
  // WNBA benches are short, so stars play THROUGH blowouts and carry the load: the
  // losing team's alpha fuels the comeback, the winner's alpha builds the lead.
  // Confirmed live (ATL 97-LV 82, 15-pt blowout): Wilson 34min/18 FGA→44 PRA and
  // Howard 39min/19 FGA→30 PRA both blew way over their unders while role player
  // NaLyssa Smith (22min/5 FGA) faded to 16 and hit. The suppression is real — but
  // only for role players. High recent shot volume (or a big-minute high-role star)
  // marks the alpha, who is exempt.
  const fga = Number(usage?.fga), minAvg = Number(usage?.minAvg), role = Number(usage?.role);
  const bf = usage?.benefitsFrom;
  const projMin = Number(usage?.projMinutes);
  const reanchored = !!usage?.reanchored;
  const establishedAlpha = (Number.isFinite(fga) && fga >= 13)
    || (Number.isFinite(minAvg) && minAvg >= 32 && Number.isFinite(role) && role >= 85);
  // FUTURE-PROOF: a backward FGA test is blind to a newly-minted alpha (injury
  // fill-in, promoted starter) whose recent shot volume hasn't caught up. Fire the
  // exemption on the FORWARD role signals too — inheriting a departed starter's
  // minutes, a role re-anchor, or a big projected-minutes load — so tonight's alpha
  // is caught on night one, not after ten games.
  const emergingAlpha = reanchored
    || (bf && Array.isArray(bf.out) && bf.out.length && Number(bf.minGain) >= 3 && Number.isFinite(projMin) && projMin >= 30)
    || (Number.isFinite(projMin) && projMin >= 34);
  const isAlpha = establishedAlpha || emergingAlpha;
  if (isAlpha) {
    const emerging = !establishedAlpha && emergingAlpha;
    return {
      risk, side: 'NONE', isAlpha: true, emerging, favoredBy: Number(favoredBy.toFixed(1)), isUnderdog, confBoost: 0,
      badge: emerging ? 'BLOWOUT · new alpha exempt' : 'BLOWOUT · alpha exempt',
      note: emerging
        ? `${absSpread}-pt spread, but this player is projected into an alpha role tonight (${bf?.out?.length ? bf.out.join(', ') + ' out, ' : ''}${Number.isFinite(projMin) ? Math.round(projMin) + ' min' : 'elevated load'}) — new alphas carry the load through blowouts too, so the blowout under does NOT apply.`
        : `${absSpread}-pt spread, but this is the team's primary usage option — WNBA stars play through blowouts and carry the load (comeback or lead), so the blowout under does NOT apply. Treat as neutral/over-context.`,
    };
  }

  const base = risk === 'HIGH' ? 6 : risk === 'MODERATE' ? 4 : 2;
  const confBoost = isUnderdog ? base + 2 : base; // underdog carries the extra weight
  return {
    risk, side: 'UNDER', favoredBy: Number(favoredBy.toFixed(1)), isUnderdog, confBoost, isAlpha: false,
    badge: 'BLOWOUT RISK · leans under',
    note: isUnderdog
      ? `${absSpread}-pt underdog — teams that get blown out suppress hardest (76% under in 20+ blowouts) as the offense stalls once the game's decided. Counting-stat under.`
      : `${absSpread}-pt favorite — even the winning side eases once it's out of hand (69% under in 20+ blowouts); production drops though the starters stay in. Counting-stat under.`,
  };
}

function buildRegressionWatch({ shootingForm, seasonPpg, benefitsFrom, injuryReport, slateDate }) {
  if (!benefitsFrom || !Array.isArray(benefitsFrom.out) || !benefitsFrom.out.length) return null;
  // Match how injuryReport.byName is keyed (wnbaFeedEspn.normName): strip to [a-z ].
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const byName = injuryReport?.byName || {};
  const today = slateDate ? new Date(slateDate) : new Date();
  const stars = benefitsFrom.out.map((name) => {
    const inj = byName[norm(name)] || null;
    let daysToReturn = null;
    if (inj?.returnDate) {
      const rd = new Date(inj.returnDate);
      if (!Number.isNaN(rd.getTime())) daysToReturn = Math.round((rd - today) / 86400000);
    }
    const trendingBack = (inj && /GTD|QUESTION|DOUBT|DAY/i.test(inj.status || ''))
      || (daysToReturn != null && daysToReturn <= 3 && daysToReturn >= -1);
    return { name, status: inj?.status || 'OUT', returnDate: inj?.returnDate || null, daysToReturn, trendingBack };
  });
  const l5 = shootingForm?.l5;
  const spikePct = (l5 && Number(seasonPpg) > 0 && l5.ppg != null)
    ? Math.round((l5.ppg / Number(seasonPpg) - 1) * 100) : null;
  const elevated = spikePct != null && spikePct >= 15;
  const imminent = stars.filter(s => s.trendingBack);

  if (imminent.length) {
    const s = imminent[0];
    const when = s.returnDate ? ` (expected back ${s.returnDate})` : '';
    return {
      level: 'REGRESSION', badge: 'REGRESSION WATCH', stars: imminent.map(x => x.name),
      returnDate: s.returnDate, spikePct,
      note: `${imminent.map(x => x.name).join(', ')} trending back${when} — recent form was boosted by the absence. Usage returns to them; treat the L5/L10 line as a ceiling and expect a pullback.`,
    };
  }
  if (elevated) {
    return {
      level: 'BOOSTED', badge: 'ROLE-BOOSTED', stars: benefitsFrom.out, spikePct,
      note: `Elevated role (${spikePct > 0 ? '+' + spikePct + '% ' : ''}vs season) with ${benefitsFrom.out.join(', ')} out — recent form is real for now but regresses when they return.`,
    };
  }
  return null;
}

/**
 * Build a scoring profile from a player's raw game logs.
 * @param {Array} games  raw BDL game rows (any order; sorted by date if present)
 * @param {number} N     use the most-recent N games (default 10)
 * @returns {Object|null} { gamesUsed, minAvg, minStd, minCv,
 *   f2aPerMin, f3aPerMin, ftaPerMin, pct2, pct3, pctFt, hasShotData }
 */
function buildShotProfile(games, N = 10) {
  if (!Array.isArray(games) || games.length === 0) return null;
  // Sort oldest→newest when dates exist, then take the last N.
  const withDate = games.every(g => g && (g.date || g.game_date));
  const sorted = withDate
    ? [...games].sort((a, b) => String(a.date || a.game_date).localeCompare(String(b.date || b.game_date)))
    : [...games];
  const recent = sorted.slice(-N);

  const mins = [];
  let f2a = 0, f2m = 0, f3a = 0, f3m = 0, fta = 0, ftm = 0, totMin = 0, sawSplit = false;
  for (const g of recent) {
    const min = _parseMin(g.minutes ?? g.min ?? g.mp);
    if (min <= 0) continue;
    const gFga = _numf(g.fga, g.FGA, g.field_goals_attempted);
    const gFgm = _numf(g.fgm, g.FGM, g.field_goals_made);
    const gF3a = _numf(g.fg3a, g.FG3A, g.fga3, g.three_pointers_attempted, g.three_point_field_goals_attempted);
    const gF3m = _numf(g.fg3m, g.FG3M, g.three_pointers_made, g.three_point_field_goals_made);
    const gFta = _numf(g.fta, g.FTA, g.free_throws_attempted);
    const gFtm = _numf(g.ftm, g.FTM, g.free_throws_made);
    if (gF3a > 0 || gFta > 0) sawSplit = true;
    mins.push(min); totMin += min;
    f2a += Math.max(0, gFga - gF3a); f2m += Math.max(0, gFgm - gF3m);
    f3a += gF3a; f3m += gF3m; fta += gFta; ftm += gFtm;
  }
  if (mins.length === 0 || totMin <= 0) return null;

  const minAvg = totMin / mins.length;
  const minStd = mins.length > 1
    ? Math.sqrt(mins.reduce((s, m) => s + (m - minAvg) ** 2, 0) / (mins.length - 1)) : 4;

  // League-average fallbacks when a rate/percentage is undefined at this sample.
  return {
    gamesUsed: mins.length,
    minAvg: Number(minAvg.toFixed(1)),
    minStd: Number(minStd.toFixed(1)),
    minCv: Number((minStd / minAvg).toFixed(3)),
    f2aPerMin: f2a / totMin,
    f3aPerMin: f3a / totMin,
    ftaPerMin: fta / totMin,
    pct2: f2a > 0 ? Number((f2m / f2a).toFixed(3)) : 0.47,
    pct3: f3a > 0 ? Number((f3m / f3a).toFixed(3)) : 0.33,
    pctFt: fta > 0 ? Number((ftm / fta).toFixed(3)) : 0.80,
    hasShotData: sawSplit,
  };
}

// Standard normal CDF (Abramowitz & Stegun 7.1.26).
function _normCdf(z) {
  const s = z < 0 ? -1 : 1; const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/**
 * Distributional points estimate: P(points > line) from the shot profile.
 * Analytic (sum-of-binomials → normal approx with a minutes-uncertainty term),
 * so it's O(1) per pick — serverless-safe at slate scale.
 *
 * @param {Object} prof  buildShotProfile() output
 * @param {number} line  points line
 * @returns {Object|null} { mean, sd, pOver, side, conviction, attempts:{a2,a3,aft}, hasShotData }
 */
// ── MINUTES SECURITY ─────────────────────────────────────────────────────────
// The PBP audit showed the points projection is nearly unbiased when a player
// gets a full load (32+ min → +1.4 error) but collapses when minutes fall short
// (<20 min → −8.1). Role stability predicts actual minutes (role≥85 ≈ 31 min vs
// role<70 ≈ 25), and on graded picks role<70 landed UNDER 63% of the time. So
// minutes security is the master signal for whether to TRUST the read or lean
// UNDER. Returns a factor that haircuts expected minutes for the distribution
// (risky minutes → lower mean → the model itself leans under) plus a badge the
// card/board picks up.
function wnbaMinutesSecurity(role, minCv) {
  const r = Number(role);
  const cv = Number(minCv);
  const hasR = Number.isFinite(r), hasCv = Number.isFinite(cv);
  // Risk rises as role falls and minutes volatility rises.
  const volatile = hasCv && cv > 0.30;
  const steady = hasCv && cv < 0.18;
  if (hasR && r >= 85 && !volatile) {
    return { level: 'SECURE', read: 'TRUST', minutesFactor: 1.00,
      badge: 'MINUTES SECURE', note: 'Locked rotation role — the projection is trustworthy in either direction.' };
  }
  if ((hasR && r < 70) || volatile) {
    return { level: 'RISK', read: 'UNDER', minutesFactor: 0.88,
      badge: 'MINUTES RISK · leans under', note: 'Floating/volatile minutes — historically underperforms the line (role<70 landed under 63%). Read leans UNDER.' };
  }
  // Moderate — mild haircut, no strong directional promotion.
  return { level: 'MODERATE', read: 'LEAN', minutesFactor: steady ? 0.98 : 0.95,
    badge: 'MINUTES MODERATE', note: 'Semi-stable role — mild minutes risk; trust the read but size accordingly.' };
}

function shotsToClearPoints(prof, line, security) {
  if (!prof || !Number.isFinite(Number(line))) return null;
  // Apply the minutes-security haircut: risky minutes shrink expected playing time,
  // which lowers the whole scoring distribution and makes the model itself lean under.
  const mf = (security && Number.isFinite(security.minutesFactor)) ? security.minutesFactor : 1.0;
  const m = prof.minAvg * mf;
  const a2 = prof.f2aPerMin * m, a3 = prof.f3aPerMin * m, aft = prof.ftaPerMin * m;
  const { pct2, pct3, pctFt } = prof;
  const mean = 2 * a2 * pct2 + 3 * a3 * pct3 + aft * pctFt;
  // Variance from the scoring binomials...
  let variance =
    4 * a2 * pct2 * (1 - pct2) +
    9 * a3 * pct3 * (1 - pct3) +
    1 * aft * pctFt * (1 - pctFt);
  // ...plus minutes uncertainty: attempts scale with minutes, so a swingy role
  // widens the whole point distribution. Fold in (mean × minutesCV)².
  variance += (mean * (prof.minCv || 0)) ** 2;
  const sd = Math.max(1e-6, Math.sqrt(variance));
  // P(points > line). Half-point lines need no continuity correction; integer
  // lines get a +0.5 push so "over 20" means ≥21.
  const thresh = Number.isInteger(line) ? line + 0.5 : line;
  const pOver = 1 - _normCdf((thresh - mean) / sd);
  const side = pOver >= 0.5 ? 'OVER' : 'UNDER';
  return {
    mean: Number(mean.toFixed(1)),
    sd: Number(sd.toFixed(1)),
    pOver: Number(pOver.toFixed(3)),
    side,
    conviction: Number(Math.max(pOver, 1 - pOver).toFixed(3)),
    attempts: { a2: Number(a2.toFixed(1)), a3: Number(a3.toFixed(1)), aft: Number(aft.toFixed(1)) },
    minutesFactor: mf,
    hasShotData: prof.hasShotData,
  };
}

async function buildAndRunAnalysis({
  player, isHome, opponent, team, market, season, game, date,
  spread, total, recentFormPromise, allTeamStats, gameLines,
  v2Roster, v2OpponentRoster, injuryReport, defenseTable, shotProfile, shootingForm, ppAltIndex, playerBiasOverride
}) {
  try {
    // Get opponent team stats from the pre-fetched map
    const opponentTeam = allTeamStats[opponent] || { abbr: opponent };
    const teamData = allTeamStats[team] || { abbr: team };

    // ── EXTERNAL SIGNAL SOCKETS ──────────────────────────────────────────────
    // Each engine layer reads a known field; whenever a feed populates that field,
    // the layer activates AUTOMATICALLY (no engine change needed). This is the
    // single place to wire any future data source — fill the field and it flows.
    //
    //   DEF  → opponentTeam.defenseMultiplier   (live: wnbaDefenseFeed, /stats)
    //   COV  → opponentTeam.coverage            (unwired: needs a scheme source)
    //   WHISTLE → opponentTeam.foulRate         (unwired: needs team foul-rate source)
    //   ENV  → input.environmentMultiplier      (unwired: needs a pace source)
    //   USAGE FUNNEL → already fed by teammateRedistribution when a player is OUT
    //
    // DEF — opposing defense. Two tiers, both wired:
    //   • player-position multiplier (GOAT /player_stats) → engine projection input
    //   • team-level rating (ALL-STAR /games) → straight bets + card chip
    if (defenseTable && defenseTable.byTeam) {
      const dm = defenseMultiplier(defenseTable, opponent, player.position, market);
      if (dm != null) opponentTeam.defenseMultiplier = dm;   // positional (GOAT)
    }
    // Team-level defense always attaches when available (works on ALL-STAR now).
    const teamDef = teamDefenseFor(defenseTable, opponent);
    // Opponent OFFENSIVE style fingerprint (three-heavy / paint / miss profile) —
    // the data-grounded proxy for scheme; enriches matchup reads and drives the
    // rebounds miss-environment logic without a Synergy feed.
    const opponentStyle = defenseTable?.teamStyle?.[opponent] || null;
    // COV — coaching coverage scheme. Socket ready: if any source provides a
    // per-opponent coverage signal, expose it here and the layer turns on.
    //   e.g. opponentTeam.coverage = { scheme, vsArchetypeMultiplier }
    if (typeof externalCoverageSignal === 'function') {
      try { const c = externalCoverageSignal(opponent, player, market); if (c != null) opponentTeam.coverage = c; } catch (_) {}
    }
    // WHISTLE — opponent foul rate. Socket ready: a team-foul-rate feed sets this
    // and the whistle layer (already FTA-aware) starts using the matchup.
    if (typeof externalFoulRate === 'function') {
      try { const fr = externalFoulRate(opponent); if (fr != null) opponentTeam.foulRate = fr; } catch (_) {}
    }
    // ENV — pace/environment. Socket ready: a pace feed sets envMultiplierOverride
    // and the environment layer activates. Threaded onto the engine input below.
    let envMultiplierOverride = null;
    if (typeof externalPaceSignal === 'function') {
      try { envMultiplierOverride = externalPaceSignal(opponent, team, total); } catch (_) {}
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Wait for recent form (was already initiated in parallel)
    const recentForm = await recentFormPromise;

    // Rotowire "Spin" blurb + role-change read for this player. Memoized per athlete
    // in the feed, so the 3 markets share one fetch. Non-fatal — never blocks a card.
    let _spin = null;
    try { _spin = await getSpin(player.name); } catch { _spin = null; }

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

    // Shots-to-clear: distributional P(over) for the POINTS market, computed from
    // the per-player shot profile + the resolved line. Market-independent profile
    // is attached to every analysis; the clear-probability only applies to points.
    // If the shot logs lacked the 2PA/3PA/FTA split, hasShotData is false and the
    // UI should treat this as informational until the feed carries shot splits.
    let shotsToClear = null;
    let minutesSecurity = null;
    if (shotProfile && market.toLowerCase() === 'points') {
      // Prefer the projected minutes the minutes engine resolved (injury bumps),
      // falling back to the profile's own average.
      const projMin = Number(playerWithRecent.expectedMinutes);
      const prof = Number.isFinite(projMin) && projMin > 0
        ? { ...shotProfile, minAvg: projMin } : shotProfile;
      // Minutes-security signal (the master variable from the PBP audit) — drives
      // the haircut applied to the distribution AND the badge on the card.
      minutesSecurity = wnbaMinutesSecurity(
        playerWithRecent.role ?? player.scores?.roleStability ?? player.role,
        shotProfile.minCv
      );
      // line is resolved just below in `unified`; compute after we have it.
      shotsToClear = { _prof: prof, _sec: minutesSecurity }; // resolved post-line
    }

    // Look up line: caller can provide per-prop lines via gameLines.propLines[playerName_market].
    // Exact match first; if that misses, retry on a NORMALIZED name. BDL's player names and
    // Basketball Reference's differ in punctuation/diacritics/casing (e.g. "A'ja Wilson" vs
    // "A'Ja Wilson"), and an exact-string miss silently forces the line to 'inferred' — which
    // collapses the engine edge to ~0 and drops the pick from Best Bets.
    const propLineKey = `${player.name}_${market}`;
    let explicitLine = gameLines.propLines?.[propLineKey];
    let matchedKey = propLineKey;
    if (!Number.isFinite(Number(explicitLine)) && gameLines.propLines) {
      const wantName = normPlayerName(player.name);
      for (const k of Object.keys(gameLines.propLines)) {
        const us = k.lastIndexOf('_');
        if (us < 0 || k.slice(us + 1) !== market) continue;
        if (normPlayerName(k.slice(0, us)) === wantName) {
          explicitLine = gameLines.propLines[k];
          matchedKey = k;
          break;
        }
      }
    }
    const hasRealLine = Number.isFinite(Number(explicitLine));
    const line = hasRealLine ? Number(explicitLine) : inferLineFromPlayer(player, market);
    // 'provided' = a real book/prop line (caller or PrizePicks); 'inferred' = engine guess.
    const propLineSource = hasRealLine ? 'provided' : 'inferred';
    // Book/vendor for a real line (e.g. "prizepicks"), surfaced to the card.
    const lineMeta = hasRealLine ? (gameLines.propMeta?.[matchedKey] || gameLines.propMeta?.[propLineKey] || null) : null;
    // ALT-ONLY: no standard line, but PrizePicks lists this prop as demon/goblin.
    // That's a no-bet under the standing rule — but a different fact from "not on
    // the board," so the card can say which. Checked only when we had to infer.
    let altOnly = null;
    if (!hasRealLine && ppAltIndex) {
      const nk = normPlayerName(player.name) + '|' + market;
      // ppAltIndex keys are normalizeName (strips suffixes) — try a loose match too.
      const loose = normPlayerName(player.name).replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim() + '|' + market;
      const hit = ppAltIndex[nk] || ppAltIndex[loose];
      if (hit) altOnly = hit;   // 'demon' | 'goblin'
    }

    const input = {
      player: playerWithRecent,
      team: teamData,
      opponent: opponentTeam,
      market,
      line,
      environmentMultiplier: envMultiplierOverride,   // pace socket (null until fed)
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

    // Resolve the shots-to-clear estimate now that the points line is known.
    if (shotsToClear && shotsToClear._prof && Number.isFinite(Number(unified.line))) {
      shotsToClear = shotsToClearPoints(shotsToClear._prof, Number(unified.line), shotsToClear._sec);
    } else {
      shotsToClear = null;
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
      if (re) {
        injuryStatus = re.status || 'AVAILABLE'; injuryDetail = re._injury?.detail || null;
        // Backfill a real usage rate for the card when the player object didn't carry
        // one (BDL season averages often omit USG_PCT). buildV2Roster computed a
        // possession-share usage from team pace; surface it as a percentage.
        if ((player.usageRate == null || !Number.isFinite(Number(player.usageRate))) && re.usagePct != null) {
          player.usageRate = re.usagePct;
        }
      }
    }
    const isOut = injuryStatus === 'OUT';
    const isDoubtful = injuryStatus === 'DOUBTFUL';

    // Beneficiary context: if a teammate is OUT, surface who's out and how much
    // THIS player gains from it (so the card can say "boosted by X out").
    let benefitsFrom = null;
    const ben = Array.isArray(v2Roster) ? v2Roster._beneficiaries : null;
    if (ben && ben.out?.length) {
      const myGain = (ben.gainers || []).find(g => _normName(g.name) === _normName(player.name));
      if (myGain && myGain.minGain >= 1.5) {
        benefitsFrom = {
          out: ben.out.map(o => o.name),
          minGain: myGain.minGain,
          projMinutes: myGain.projMinutes,
        };
      }
    }

    // Regression watch — recent form's shelf-life when filling in for absent stars.
    const regressionWatch = buildRegressionWatch({
      shootingForm, seasonPpg: player.seasonAvg, benefitsFrom, injuryReport, slateDate: date,
    });

    // Blowout-risk under signal from the spread (game-wide, underdog-weighted),
    // with the alpha exemption — the primary usage option plays through blowouts.
    // ── PER-PLAYER SUPPRESSION CORRECTION ──────────────────────────────────
    // The model chronically under-projects certain high-usage players (Young,
    // Reese, Bueckers, and the alpha overs from live slips). Lift the projection by
    // this player+market's shrunk bias, re-derive the edge, and — only on a
    // meaningful, trustworthy signal — kill an under whose corrected projection now
    // reaches the line. This is the root-cause fix under the alpha overs and the
    // Bonner miss. Applied to the LIVE projection, not shadow.
    const biasFix = playerBiasCorrection(player.name, market, playerBiasOverride);
    if (biasFix && biasFix.correction && Number.isFinite(Number(unified.projection))) {
      unified.rawProjection = unified.projection;
      unified.projection = Number((Number(unified.projection) + biasFix.correction).toFixed(1));
      unified.biasCorrection = biasFix;
      const L = Number(unified.line);
      if (Number.isFinite(L)) {
        unified.edge = Number((unified.projection - L).toFixed(1));
        // Kill an under the correction lifts to the line — but only when the signal
        // is strong enough to trust (rolling data, or a solid seed): |corr|>=1.5, n>=8.
        const lean = String(unified.recommendation || unified.lean || '').toUpperCase();
        const trustworthy = (biasFix.fromRolling || (biasFix.n >= 8 && Math.abs(biasFix.correction) >= 1.5));
        if (lean === 'UNDER' && biasFix.correction > 0 && trustworthy && unified.projection >= L - 0.5) {
          unified.recommendation = 'PASS';
          unified.tier = 'PASS';
          unified.biasVeto = { correction: biasFix.correction, rawProjection: unified.rawProjection, line: L, n: biasFix.n, source: biasFix.fromRolling ? 'rolling' : 'seed' };
        }
      }
    }

    // DATA-SUFFICIENCY FLOOR — a player with too few games is a thin, unstable
    // baseline: a rookie, a call-up, an injury return, or an early-season trade.
    // We don't pretend to know — flag low sample, keep them off the featured signal,
    // and let the read show without confident endorsement. (This catches early-season
    // trades, where the whole league is low-sample; a mid-season veteran trade with a
    // long prior-team log is the case a per-game team field would be needed to catch,
    // which ESPN's log doesn't expose — so we don't overclaim it.)
    const sampleGames = Number(shotProfile?.gamesUsed) || Number(shootingForm?.l10?.gp) || 0;
    const lowSample = sampleGames > 0 && sampleGames < 5 ? { games: sampleGames } : null;

    const blowoutRisk = buildBlowoutRisk({
      spread, isHome,
      usage: {
        fga: shootingForm?.l10?.fga, minAvg: shotProfile?.minAvg, role: player?.role ?? unified?.scores?.role,
        benefitsFrom, projMinutes: benefitsFrom?.projMinutes,
        // Same condition the role re-anchor uses — computed inline so it doesn't
        // depend on adaptiveRead being built first (it isn't yet at this point).
        reanchored: Number.isFinite(Number(benefitsFrom?.projMinutes)) && Number.isFinite(Number(shotProfile?.minAvg))
          && Number(benefitsFrom.projMinutes) > Number(shotProfile.minAvg) * 1.12,
      },
    });

    // Adaptive shrinkage read (points, shadow mode) — evidence-weighted regime
    // detection: separates a real volume/role riser from hot-shooting variance.
    const _mk = market.toLowerCase();
    const _adaptiveEvidence = { spinRead: _spin?.read, minutesSecurity, benefitsFrom, shootingForm };
    const _adaptiveMinutes = { baseline: shotProfile?.minAvg, projected: benefitsFrom?.projMinutes };
    const adaptiveRead = _mk === 'points'
      ? buildAdaptivePoints({ shootingForm, evidence: _adaptiveEvidence, minutes: _adaptiveMinutes })
      : (_mk === 'rebounds' || _mk === 'assists')
        ? buildAdaptiveCounting({ market: _mk, shootingForm, evidence: _adaptiveEvidence, minutes: _adaptiveMinutes })
        : null;

    // market, plus a parallel PRA signal (the fallback when standalone reb/ast props
    // aren't offered). recentForm.games is most-recent-first, so reverse to oldest→newest.
    let propSignal = null;
    let praSignal = null;
    try {
      if (recentForm?.games?.length) {
        const g2arr = (pick) => recentForm.games.map(pick)
          .filter(v => v != null && Number.isFinite(v)).reverse();
        // Minutes aligned oldest→newest for the rebounds minutes-drop sharpening.
        const priorMinutes = recentForm.games.map(g => Number(g.minutes))
          .filter(v => v != null && Number.isFinite(v)).reverse();
        const vals = g2arr(g => marketLower.includes('rebound') ? g.rebounds
          : marketLower.includes('assist') ? g.assists : g.points);
        propSignal = evaluatePropSignal(vals, isRebounds ? 'rebounds'
          : marketLower.includes('assist') ? 'assists' : 'points', priorMinutes);
        // PRA = points + rebounds + assists per game (only when all three present).
        const praVals = recentForm.games
          .map(g => (g.points != null && g.rebounds != null && g.assists != null)
            ? g.points + g.rebounds + g.assists : null)
          .filter(v => v != null && Number.isFinite(v)).reverse();
        praSignal = evaluatePropSignal(praVals, 'pra');
      }
    } catch (_) { propSignal = null; praSignal = null; }

    // ── SHOTS-TO-CLEAR: points engine (FULL LAUNCH) ──────────────────────────
    // For the points market the distributional shots-to-clear estimate REPLACES
    // the legacy mean projection (which graded ~47% directional and +2.84 biased).
    // Guardrail for launching before a backtest: only calls at/above CONV_BAR
    // surface as plays; everything softer is PASS, so we don't push low-confidence
    // points picks. Tune CONV_BAR from the backtest once it's run.
    if (market.toLowerCase() === 'points' && shotsToClear && Number.isFinite(shotsToClear.mean)) {
      const CONV_BAR = 0.60;   // minimum conviction to surface a points play
      const STRONG_BAR = 0.68; // conviction for the STRONG label
      const conv = shotsToClear.conviction;
      const sec = minutesSecurity || { read: 'LEAN', level: 'MODERATE' };
      unified.projection = shotsToClear.mean;
      unified.edge = Number((shotsToClear.mean - Number(unified.line)).toFixed(1));
      unified.probOver = shotsToClear.pOver;
      unified.probUnder = Number((1 - shotsToClear.pOver).toFixed(3));
      unified.pointsEngine = 'shots-to-clear';
      unified.minutesSecurity = sec;   // badge + read surfaced to the card

      // Minutes-security modulates the read (PBP audit): a RISK profile that still
      // says OVER is untrustworthy (minutes shortfall historically → under), so
      // demote it; a RISK profile saying UNDER is confirmed. A SECURE profile is
      // trusted in either direction.
      const overDespiteRisk = sec.read === 'UNDER' && shotsToClear.side === 'OVER';
      if (overDespiteRisk) {
        unified.recommendation = 'PASS';
        unified.confidence = Math.round(conv * 100);
        unified.tier = 'PASS';
        unified.minutesConflict = true;   // model says over, minutes say under → stand down
      } else if (conv >= CONV_BAR && !isOut) {
        unified.recommendation = shotsToClear.side;            // 'OVER' | 'UNDER'
        // Confirmed-under (risk + under) earns a small confidence bump; secure trusts as-is.
        const confirmed = sec.read === 'UNDER' && shotsToClear.side === 'UNDER';
        unified.confidence = Math.min(99, Math.round(conv * 100) + (confirmed ? 4 : 0));
        unified.tier = conv >= STRONG_BAR ? 'STRONG' : 'LEAN';
        unified.hitRate = shotsToClear.conviction;
      } else {
        unified.recommendation = 'PASS';
        unified.confidence = Math.round(conv * 100);
        unified.tier = 'PASS';
      }
    }

    // ROLE RE-ANCHOR guard (all points picks, any engine): a player inheriting an
    // absent starter's minutes whose re-anchored projection reaches the line must
    // not get a confident UNDER. This is the Nelson-Ododa fix — she was projected
    // 6.3 UNDER 9.5 while inheriting 32 minutes for two out bigs, and went for 21.
    if (market.toLowerCase() === 'points' && adaptiveRead?.regime === 'ROLE_REANCHOR'
        && (unified.recommendation === 'UNDER' || unified.lean === 'UNDER')
        && Number.isFinite(Number(unified.line))
        && Number.isFinite(adaptiveRead.adjProjection)
        && adaptiveRead.adjProjection >= Number(unified.line) - 1.5) {
      unified.recommendation = 'PASS';
      unified.tier = 'PASS';
      unified.confidence = Math.min(Number(unified.confidence) || 0, 40);
      unified.roleConflict = {
        line: Number(unified.line), baseProjection: adaptiveRead.baseProjection,
        reanchoredProjection: adaptiveRead.adjProjection, inheriting: benefitsFrom?.out || [],
        projMinutes: benefitsFrom?.projMinutes,
      };
    }

    return {
      gameId: game.gameId,
      player: player.name,
      team,
      opponent,
      market,
      // Injury status surfaced to the card. OUT players are forced to PASS.
      injuryStatus,
      injuryDetail,
      benefitsFrom,
      line: unified.line,
      projection: unified.projection,
      edge: unified.edge,
      recommendation: isOut ? 'PASS' : unified.recommendation,
      confidence: isOut ? 0 : (() => {
        // Mild under-environment nudge (conservative prior, ±5%). Only touches UNDER
        // picks; never flips a recommendation, just tilts conviction a little.
        let c = unified.confidence;
        const lean = String(unified.recommendation || unified.lean || '').toUpperCase();
        const f = Number(opponentStyle?.underFactor);
        if (lean === 'UNDER' && Number.isFinite(c) && Number.isFinite(f) && f !== 1) {
          c = Math.max(1, Math.min(99, Math.round(c * f)));
        }
        // Blowout-risk boost: a big spread suppresses counting stats game-wide
        // (underdog most). Additive conviction for unders, capped.
        if (lean === 'UNDER' && blowoutRisk && Number.isFinite(c)) {
          c = Math.max(1, Math.min(99, c + blowoutRisk.confBoost));
        }
        return c;
      })(),
      underEnv: opponentStyle?.underEnv || null,   // SUPPRESS | NEUTRAL | FAST (mild)
      label: isOut ? 'OUT' : (isDoubtful ? 'RISK' : unified.tier),
      hitRate: unified.hitRate ?? deriveHitRate(unified),
      scores: unified.scores,
      chips: unified.chips || buildChipsFromUnified(unified, player, reboundExtras),
      hardFlags: buildHardFlagsFromUnified(unified, player, reboundExtras),
      spin: _spin || null,             // full Rotowire blurb for display on every card
      shootingForm: shootingForm || null,   // L10/L5 FGA + FG% + TS% — recent-shooting bonus read
      opponentStyle: opponentStyle || null,   // opponent offensive fingerprint (matchup context)
      regressionWatch: regressionWatch || null,   // fill-in shelf-life / star-return read
      blowoutRisk: blowoutRisk || null,   // spread-derived game-wide under signal
      adaptiveRead: adaptiveRead || null,   // opportunity×efficiency shrinkage (points, shadow)
      roleConflict: unified.roleConflict || null,   // re-anchor stood down a bad under
      biasCorrection: unified.biasCorrection || null,   // per-player suppression correction applied
      biasVeto: unified.biasVeto || null,   // under killed because correction lifted proj to line
      rawProjection: unified.rawProjection ?? null,   // projection before bias correction
      lowSample: lowSample || null,   // thin baseline (rookie/trade/return) — low confidence
      spinRead: _spin?.read || null,   // role-change signal (STALE STARTER / ROLE BUMP) or null
      reasons: buildPropReasons({
        market, unified,
        shotProfile: shotProfile || null,
        shotsToClear: shotsToClear || null,
        minutesSecurity: minutesSecurity || null,
        reboundExtras, raw: player?._raw || null, propSignal, opponent,
        spinRead: _spin?.read || null, opponentStyle, adaptiveRead, blowoutRisk, biasCorrection: unified.biasCorrection || null, lowSample,
      }),
      lineSource: propLineSource,
      lineBook: lineMeta?.book || lineMeta?.vendor || null,
      altOnly: altOnly || null,   // 'demon' | 'goblin' when only an alt line exists (no-bet)
      propSignal,   // cold-form UNDER tier (or null) for THIS market
      praSignal,    // cold-form UNDER tier (or null) for PRA — fallback when reb/ast not offered
      // Diagnostic: how many game-log rows the bbref scrape returned for this player,
      // and the raw cold-form signal magnitude (recent3 − baseline10) for this market.
      // _recentGames === 0 across the slate => scrape is empty (signal can never fire);
      // _recentGames ~8-10 with propSignal null => logs fine, just no cold player tonight.
      _recentGames: (recentForm?.games?.length ?? 0),
      _playerId: player.id ?? null,   // diag: what gets passed to aggregateRecentForm (must be a bbref slug like "plumke01w")
      lineOdds: lineMeta ? { over: lineMeta.overOdds, under: lineMeta.underOdds } : null,
      lineUpdatedAt: lineMeta?.updatedAt || null,
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
        minutesLast5: playerWithRecent.minutesLast5 ?? null,
        minutesCv: playerWithRecent.minutesCv ?? null,
        last5Avg: playerWithRecent.last5Avg ?? null,
        last10Avg: playerWithRecent.last10Avg ?? null,
        // Market-specific season avg (matches last5/last10's market). player.seasonAvg
        // is points-only, which made rebounds/assists rows compare against the points
        // average ("last 5 1.8 under 11.8 season"). Use the per-market value the engine
        // already derived; fall back to points only if it's missing.
        seasonAvg: playerWithRecent.seasonAvg ?? player.seasonAvg ?? null,
        fgPctRecent: playerWithRecent.fgPctRecent ?? null,
        primaryCreator: player.primaryCreator ?? false,
        gamesPlayed: player.gamesPlayed ?? null,
        opponent,
        isHome: isHome ?? null,
        teamTotal: Number.isFinite(Number(total)) ? Number(total) : null,
      },
      // Rebound-environment surfaces (null for non-rebound markets).
      reboundEnvironment: reboundExtras?.environment || null,
      reboundEquity: reboundExtras?.equity || null,
      reboundTrap: reboundExtras?.trap || null,
      reboundVariance: reboundExtras?.variance || null,
      // Shots-to-clear: per-player scoring mechanism + distributional points read.
      //   shotProfile — 2PA/3PA/FTA rates + shooting %s (market-independent)
      //   shotsToClear — P(over) for the points line (null on non-points markets)
      // shotProfile.hasShotData=false means the logs lacked the shot split; treat
      // shotsToClear as informational (shadow) until the feed carries fg3a/fta.
      shotProfile: shotProfile || null,
      shotsToClear: shotsToClear || null,
      minutesSecurity: minutesSecurity || null,   // { level, read, badge, note } — card picks this up
      // Team-level opposing defense (ALL-STAR): { allowedPerGame, leagueAvg,
      // multiplier, rating SOFT|AVERAGE|TOUGH, games }. null until enough games.
      teamDefense: teamDef || null
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
    const gp = Number(p.gamesPlayed) || Number(raw.GP) || Number(raw.g) || Number(raw.gp) || 10;
    const gs = Number(raw.GS) || Number(raw.gs) || Number(raw.gs_gp) || 0;
    // Minutes: prefer the REAL resolved values on the player object (expectedMinutes
    // from the game log, then season minutesAvg). bbref's raw per-game column is `mp`
    // (lowercase), NOT `MIN` — reading MIN gave 0, which zeroed redistribution so no
    // one ever showed as benefiting from an OUT player.
    const mpg = Number(p.expectedMinutes) || Number(p.minutesAvg)
      || Number(raw.mp) || Number(raw.MIN) || Number(raw.MPG) || 0;
    const ppg = Number(p.seasonAvg) || Number(raw.pts) || Number(raw.PTS) || Number(raw.PPG) || 0;
    const rpg = Number(raw.trb) || Number(raw.REB) || Number(raw.RPG) || 0;

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

    // Usage rate: prefer a REAL usage figure (BDL USG_PCT or a resolved value),
    // then a real possession-based estimate, then a crude proxy as last resort.
    //
    // Real usage = the share of the team's possessions a player ends while on court:
    //   USG% = (FGA + 0.44·FTA + TOV) ÷ (teamPace × MP/40)
    // teamPace is the team's possessions per 40-minute game; MP/40 is the fraction
    // of the game the player is on the floor. This is the standard possession-share
    // definition and replaces the old `possessionsUsed / 16` guess, which had no
    // team or minutes normalization and drifted badly for high- and low-minute roles.
    let usage = Number(p.usageRate) || Number(raw.USG_PCT) || Number(raw.usage);
    if (Number.isFinite(usage) && usage > 1) usage = usage / 100;
    if (!Number.isFinite(usage)) {
      const fga = Number(raw.FGA) || Number(raw.fga) || 0;
      const fta = Number(raw.FTA) || Number(raw.fta) || 0;
      const tov = Number(raw.TOV) || Number(raw.TO) || Number(raw.tov) || 0;
      const possUsed = fga + 0.44 * fta + tov;
      const pace = Number(gameContext?.teamPace) || 81; // WNBA league-avg pace fallback
      const teamPossOnCourt = pace * (mpg > 0 ? mpg / 40 : 1);
      if (possUsed > 0 && teamPossOnCourt > 0) {
        usage = Math.max(0.05, Math.min(0.40, possUsed / teamPossOnCourt));
      } else {
        usage = possUsed > 0 ? Math.min(0.40, possUsed / 16) : 0.20; // last-resort proxy
      }
    }
    // Percentage form for display (playerContext.usageRate / card / drivers).
    const usagePct = Number.isFinite(usage) ? Number((usage * 100).toFixed(1)) : null;

    // Look up injury status — by NAME first (reliable), ID as a fallback.
    const injury = injuryByName[normName(p.name)]
      || injuryReport?.byPlayerId?.[String(p.id)]
      || null;
    const status = injury?.status || 'AVAILABLE';

    return {
      playerId: String(p.id),
      playerName: p.name,
      position: p.position || raw.pos || raw.POS || raw.position || 'F',
      // Stats for minutes engine
      season_mpg: mpg,
      gp,
      gs,
      last5_mpg: undefined, // populated from recentForm downstream if needed
      // Stats for points engine
      season_ppg: ppg,
      usage,
      usagePct,   // percentage form for the card / playerContext
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
  // Snapshot pre-redistribution minutes so we can measure who BENEFITS.
  const preMinutes = {};
  for (const p of roster) preMinutes[p.playerName] = Number(p.projMinutes ?? p.season_mpg) || 0;
  try {
    const { audit: redistAudit } = redistributeOutMinutes(roster);
    roster._redistributionAudit = redistAudit;
  } catch (err) {
    roster._redistributionAudit = { error: err.message };
  }

  // Build the "who benefits" map: out players → teammates whose projected
  // minutes/usage rose after redistribution. Self-contained from the boosted
  // roster (doesn't depend on the audit's internal shape).
  const outPlayers = roster.filter(p => p.status === 'OUT');
  const gainers = roster
    .filter(p => p.status !== 'OUT')
    .map(p => {
      const before = preMinutes[p.playerName] || 0;
      const after = Number(p.projMinutes) || before;
      const minGain = Math.round((after - before) * 10) / 10;
      return { name: p.playerName, minGain, projMinutes: Math.round(after * 10) / 10,
        usage: p.usage != null ? Math.round((p.usage > 1 ? p.usage : p.usage * 100)) : null };
    })
    .filter(g => g.minGain >= 1.5)            // meaningful bump only
    .sort((a, b) => b.minGain - a.minGain);

  roster._beneficiaries = outPlayers.length > 0 ? {
    out: outPlayers.map(p => ({ name: p.playerName, detail: p._injury?.detail || null })),
    gainers,
  } : null;

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
// Normalize a player name for robust prop-line joins. BDL prop keys are built from
// BallDontLie's player names while player.name now comes from Basketball Reference;
// punctuation, diacritics, generational suffixes, and casing differ, which silently
// fails an exact key match and forces every line to 'inferred'. Strip to a core form.
function normPlayerName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')    // strip accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')            // drop generational suffixes
    .replace(/[^a-z0-9 ]/g, '')                          // drop apostrophes/punctuation
    .replace(/\s+/g, ' ').trim();
}

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

// ── ONE-SHOT bbref DIAGNOSTIC (opt-in via ?bbrefProbe=1) ──────────────────────
// Fetches a known WNBA game-log page directly from THIS environment (i.e. Vercel)
// and reports exactly what basketball-reference returns here: HTTP status, size,
// page title, whether the wnba_pgl_basic table is present, and any block/challenge
// markers. This is the instrument for "game logs empty in prod but fine locally" —
// it shows whether bbref serves Vercel a 200+table, a 403/429, or a bot-challenge
// interstitial. Zero overhead unless the param is set.
async function runBbrefProbe() {
  const url = 'https://www.basketball-reference.com/wnba/players/p/plumke01w/gamelog/2026';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { headers, signal: controller.signal });
    const text = await r.text().catch(() => '');
    clearTimeout(timer);
    const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
    return {
      url,
      httpStatus: r.status,
      ms: Date.now() - started,
      bytes: text.length,
      hasGamelogTable: text.includes('wnba_pgl_basic'),
      title: titleMatch ? titleMatch[1].trim().slice(0, 120) : null,
      blockMarkers: ['just a moment', 'cloudflare', 'rate limited', 'access denied', 'captcha', 'enable javascript', '403 forbidden']
        .filter(m => text.toLowerCase().includes(m)),
    };
  } catch (err) {
    return { url, error: err.name === 'AbortError' ? 'timeout (8s)' : err.message, ms: Date.now() - started };
  }
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
    // Opt-in bbref diagnostic: ?bbrefProbe=1 attaches a one-shot live fetch result.
    const wantBbrefProbe = /[?&]bbrefProbe=1\b/.test(req.url || '');
    const bbrefProbe = wantBbrefProbe ? await runBbrefProbe() : undefined;

    // GET request (or POST with empty body): generate today's slate with defaults
    if (req.method === 'GET' || Object.keys(body).length === 0) {
      const slate = await generateSlate({});
      return res.status(200).json({
        ok: true,
        generatedAt: new Date().toISOString(),
        shadowMode: WNBA_SHADOW_MODE,
        v2ProjectionsEnabled: WNBA_V2_PROJECTIONS,
        ...(bbrefProbe ? { bbrefProbe } : {}),
        ...slate
      });
    }

    // POST: caller specifies date, markets, top N, lines
    const slate = await generateSlate({
      date: body.date,
      markets: body.markets,
      topN: body.topN,
      lines: body.lines,
      playerBias: body.playerBias,   // optional rolling {normName:{market:[bias,n]}} from client
      season: body.season
    });

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      shadowMode: WNBA_SHADOW_MODE,
      v2ProjectionsEnabled: WNBA_V2_PROJECTIONS,
      ...(bbrefProbe ? { bbrefProbe } : {}),
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
