// api/analyze.js
// Core mismatch engine with park + umpire context.
// Calls helper functions DIRECTLY (no HTTP) to avoid Vercel cold-start 404 issues.

import { PARK_FACTORS_BY_TEAM, PARK_GEO, getParkGeo } from './_data/parkFactors.js';
import { UMPIRE_FACTORS, classifyUmp, getAbsAdjustedFactors } from './_data/umpireFactors.js';
import { getProbables, getPitcherArsenal, getBullpenProfile, getLineup, getHitterStats, getHitterSplits, getPitcherSplits, getHitterPitchTypeByHand, getGameOdds, getPitcherHomeRoadSplits, getPitcherRecentStarts, getPitcherCareerStats, getPitcherVsTeam, getHitterVsPitcher } from './_lib/data.js';
import { getBlendedInningSplits } from './_lib/pitcherInnings.js';
import { getWeatherForecast, computeWeatherImpact } from './_lib/weather.js';
import { computeEnvironmentImpact } from './_lib/environmentImpact.js';
import { getHitterSituationalByMlbam } from './_lib/brefSplits.js';
import { detectPitcherRole } from './_lib/pitcherRole.js';
import { buildGameLineRecommendations } from './_lib/gameLineBets.js';
import { estimatePropProbability, estimateTotalProbability, estimateSpreadProbability, estimateMoneylineProbability, americanToImpliedProb, computeEdge } from './_lib/probability.js';
import { buildPitcherProps, evaluatePitcherProp } from './_lib/pitcherProps.js';
import { computeFirstInningProbability } from './_lib/firstInning.js';
import { computeHrProjection, computeHrAudit } from './_lib/hrEmpirical.js';
import { classifyHitter, classifyPitcher, getTierShift, applyTierShift, buildDamageNote, detectDemonTrap } from './_lib/damageArchetype.js';
import { getRecentFormCached, fetchHitterGameLog } from './_lib/recentForm.js';
import { getMatchupConversionRates } from './_lib/conversionRate.js';
import { getLineupRispPerformance, applyRispAdjustment, buildLineupConversionTier } from './_lib/batterRisp.js';
import { fetchPitcherPropsLines, getPitcherLinesByName } from './_lib/pitcherPropsLines.js';
import { tryAuth, checkAndIncrementQuota, AuthError } from './_lib/auth.js';
import { computeHitProbability, computeHrProbability, computeXbhProbability } from './_lib/contactProbability.js';
import { computeCompoundProbabilities } from './_lib/compoundProbability.js';
import { getGameEcosystems } from './_lib/teamEcosystem.js';
import { selectUnassistedTopPick } from './_lib/unassistedEngine.js';
// (Phase 2 — May 29, 2026) Per-hitter lineup support factor for HRR conversion math
import { computeLineupSupportFactor, applyLineupSupportToProb } from './_lib/lineupSupport.js';
import {
  aggregateLineupSignals,
  computeYrfiTopOfOrderBoost,
  computeGameTotalLineupAdjustment,
  computeArsenalVulnerability,
  LINEUP_SIGNAL_AGGREGATION_ENABLED
} from './_lib/lineupSignalAggregator.js';
import { computeAirDensity, adjustPitcherArsenal, getEnvironmentNarrative } from './_lib/altitudeEngine.js';

// PITCHER'S DUEL FIX (May 9, 2026)
// Feature-flagged calibration changes that address the model's failure to
// detect pitcher's duels. See PITCHERS_DUEL_FIX.md for the full analysis.
//
// Three changes work together:
//   1. lineupMult uses a regressed xwOBA (50% max + 50% weighted) instead of
//      pure best-case max — recognizes that elite pitchers control which
//      pitches hitters see
//   2. pitcherMult has an amplified slope below xwOBA-against 0.290 — true
//      elite pitchers suppress runs much more than the linear mapping suggests
//   3. Dual-elite SP detector applies an additional -7% suppression when both
//      starting pitchers have xwOBA-against ≤ 0.290
//
// Flag default: ON. The fix is well-justified by the 9-game analysis showing
// 8 of 9 games projected 10+ runs when the actuals averaged 8.0. Flip to OFF
// via Vercel env var if it overcorrects.
const PITCHER_DUEL_FIX_ENABLED = (() => {
  const v = process.env.PITCHER_DUEL_FIX_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;  // default on
})();

// SLUGFEST FIX (May 9, 2026)
// Mirror of the pitcher's duel fix for the OPPOSITE failure mode: model
// projects 9-13 on games that end 14-20+ runs. SEA@CWS finished 20 runs,
// projected 12.87 — and the model COULDN'T tell that game apart from
// NYY@MIL (both elite SPs) which projected 12.64. The model compresses
// every game into the 10-13 range.
//
// The fix uses a multi-factor conjunction signal: when bad pitching meets
// stacked lineups in a hitter park with multiple HR threats, the projection
// gets nudged up. Magnitude is intentionally modest (+7% / +10%) — better
// to nudge in the right direction than overshoot.
//
// Flag default: ON. Flip via Vercel env var if it overshoots.
const SLUGFEST_FIX_ENABLED = (() => {
  const v = process.env.SLUGFEST_FIX_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;  // default on
})();

// HITTER TIER REGRESSION (May 9, 2026) — DEFAULT OFF
// The pitcher's duel fix added regression of avgMaxXwoba toward avgWeightedXwoba
// for the run total's lineupMult. That was server-side and applied at the
// LINEUP level. The same root-cause issue still exists at the PER-HITTER level:
// individual hitter tier classification (elite/strong/solid) and top pick
// selection both use raw adjustedMaxXwoba — the theoretical best-case xwOBA
// against the pitcher's best matchup pitch.
//
// Empirical evidence from 928 graded picks (May 9):
//   All-time:    463-465  (49.9%)
//   Top picks:   154-177  (46.5%)  <-- WORST, should be best
//   Elite tier:  391-397  (49.6%)
//   Strong tier:  72-68   (51.4%)  <-- BEST, should be lower than Elite
//
// Tier inversion (Strong > Elite) and top-pick underperformance both indicate
// the picker is selecting hitters whose theoretical max is high but expected
// output is normal. Same demon-trap pattern the pitcher's duel fix addressed
// for run totals.
//
// This flag enables: per-hitter regression of adjustedMaxXwoba toward
// adjustedEdgeScore (usage-weighted xwOBA) using a 50/50 blend, same as the
// lineup-level fix. Re-tuned tier thresholds will follow once empirical
// calibration data is collected next session.
//
// Flag default: OFF. We need to validate calibration before flipping live —
// untuned regression could shift the tier distribution unpredictably and
// briefly degrade results before we re-tune thresholds. See
// HITTER_TIER_REGRESSION_DESIGN.md for the calibration plan.
const HITTER_TIER_REGRESSION_ENABLED = (() => {
  const v = process.env.HITTER_TIER_REGRESSION_ENABLED;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  return false;  // default off — calibration needed first
})();

// TB 1.5 prop generation flag.
// Disabled May 10, 2026 — 928-pick analysis showed TB 1.5 hit at 33.3% on 12
// historical picks. Sample is small but the result is so far below break-even
// that surfacing TB recs is net-negative EV. Re-enable once Damage Quality
// Phase 2 archetype classifier can scope TB to ELITE_POWER hitters
// specifically — that's the population for whom TB 1.5 is a real edge.
const TB_PROP_ENABLED = (() => {
  const v = process.env.TB_PROP_ENABLED;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  return false;  // default off
})();

// DAMAGE QUALITY PHASE 2 — ARCHETYPE CLASSIFIER (May 15, 2026)
// Three flags for staged rollout:
//   _ENABLED:           classify hitter/pitcher archetypes, log them, surface in UI (no model effect)
//   _APPLY_TIER_SHIFTS: actually apply the tier matrix to per-hitter tier classification
//   _DEMON_TRAPS:       run demon trap detection on high-confidence prop lines
//
// Initial deploy: _ENABLED=true, others=false (shadow mode). Lets us audit
// classification accuracy and tier-shift recommendations against real outcomes
// for 3-5 slates before changing model behavior. After validation, flip
// _APPLY_TIER_SHIFTS. Demon traps last — requires market data reliability.
const DAMAGE_QUALITY_ENABLED = (() => {
  const v = process.env.DAMAGE_QUALITY_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;  // default on (shadow mode is safe — just adds data)
})();
const DAMAGE_QUALITY_APPLY_TIER_SHIFTS = (() => {
  const v = process.env.DAMAGE_QUALITY_APPLY_TIER_SHIFTS;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  return false;  // default off — shadow mode until validated
})();
const DAMAGE_QUALITY_DEMON_TRAPS = (() => {
  const v = process.env.DAMAGE_QUALITY_DEMON_TRAPS;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  return false;  // default off — requires market data flow first
})();

// RECENT FORM WEIGHTING (Wave 4, May 15, 2026)
// Two flags for staged rollout:
//   _ENABLED:  apply the formMultiplier to HR scoring (model behavior change)
//   _DISPLAY:  compute and surface the form record in UI (no model impact)
//
// Initial deploy: _ENABLED=false, _DISPLAY=true (shadow mode). Module computes
// classifications for every hitter, logs them with each pick, surfaces in UI,
// but HR projection is not adjusted. After 1 week of data we validate that
// HOT/SCORCHING picks outperform NEUTRAL and COLD/INJURY_RISK underperform.
// If criteria met, flip _ENABLED to apply multipliers.
const RECENT_FORM_ENABLED = (() => {
  const v = process.env.RECENT_FORM_ENABLED;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  return false;  // default off — validate in shadow mode first
})();
const RECENT_FORM_DISPLAY = (() => {
  const v = process.env.RECENT_FORM_DISPLAY;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;  // default on — surface form info even when not applied
})();

// Amplified pitcher multiplier — adds a non-linear correction for elite
// xwOBA-against. The base linear mapping ((xw - 0.320) × 2.0) systematically
// undercounts truly elite SPs because their impact is non-linear: a .240 SP
// doesn't suppress runs 10% more than a .280 SP, he suppresses them 30% more.
//
// When xwOBA-against drops below 0.290, each additional 0.010 below adds
// another 4% suppression on top of the base linear contribution.
function pitcherMultFromXwAmplified(xw) {
  if (xw == null) return 1.0;
  // Base linear suppression: slope 2.0 across the full range.
  // For xw=.320 (league avg) → mult=1.00. For xw=.280 → -0.08 base.
  const baseDelta = (xw - 0.320) * 2.0;

  // ELITE AMPLIFICATION (May 23, 2026 fix — TEX@COL contradiction)
  //
  // Old: threshold .290, slope 4.0, floor 0.5 → .280 pitcher = 0.88 mult
  // New: threshold .300, slope 6.0, floor 0.55 → .280 pitcher = 0.78 mult
  //
  // Rationale: a .280 xwOBA-against starter should suppress runs by ~22%,
  // not 12%. The old amp was too lenient and lost to lineup×park product
  // even when the SP was clearly the dominant factor in the matchup.
  //
  // Calibration:
  //   .320 = league avg = 1.00
  //   .310 = above avg = 0.98
  //   .300 = elite threshold = 0.96
  //   .290 = strong elite = 0.90
  //   .280 = elite = 0.78
  //   .270 = ace = 0.70
  //   .260 = dominant = 0.62 (floored)
  //   .250 = generational = 0.55 (floor)
  //
  // The amplification kicks in below .300 (was .290) because the practical
  // top-of-rotation arms (Skubal, Skenes, Crochet, Webb) live in .270-.295
  // range and the old model treated them like .310 arms.
  const eliteAmp = xw < 0.300 ? (0.300 - xw) * 6.0 : 0;
  return Math.max(0.55, 1.0 + baseDelta - eliteAmp);
}

// Helper for lineup signal aggregator: infer the weighted xwOBA-against of
// the pitcher on the OPPOSING side. Returns null if arsenal data is missing.
// Used by computeArsenalVulnerability to decide whether to halve a boost
// against an elite pitcher.
function inferPitcherWeightedXw(sideData) {
  const arsenal = sideData?.pitcherArsenal;
  if (!Array.isArray(arsenal) || arsenal.length === 0) return null;
  const totalPitches = arsenal.reduce((s, p) => s + (p.pitches || 0), 0);
  if (totalPitches <= 0) return null;
  const weighted = arsenal.reduce((s, p) => {
    const x = parseFloat(p.xwoba || 0);
    return s + (x * (p.pitches || 0));
  }, 0);
  return weighted / totalPitches;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { gamePk, deep } = req.query;
  if (!gamePk) return res.status(400).json({ error: 'gamePk required' });
  const deepMode = deep === '1' || deep === 'true';

  // ============ AUTH + QUOTA GATE ============
  // Free tier: 3 deep analyses per day. Pro/Sharp: unlimited. Anonymous: must sign in for deep.
  // Fast mode is unrestricted for everyone (no quota check).
  const user = await tryAuth(req, res);
  if (res.headersSent) return;

  let quotaInfo = null;
  if (deepMode) {
    try {
      quotaInfo = await checkAndIncrementQuota(user, 'deep_analyses');
    } catch (err) {
      if (err instanceof AuthError) {
        return res.status(err.status).json({
          error: err.message,
          code: err.code,
          tier: user?.tier || null,
          upgradeUrl: '/upgrade',
        });
      }
      console.error('[analyze] quota check failed:', err);
      // Don't block the request on quota system failures — degrade gracefully
    }
  }

  const season = new Date().getFullYear();

  try {
    // 1. Get today's slate & find the game
    // Use ET date since MLB schedules by ET - UTC midnight is already tomorrow for night games
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const sched = await getProbables(today);
    let game = (sched.games || []).find(g => String(g.gamePk) === String(gamePk));

    // If not found on ET-today, try yesterday and tomorrow (covers edge cases)
    if (!game) {
      const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      for (const d of [yesterday, tomorrow]) {
        const s = await getProbables(d).catch(() => ({ games: [] }));
        const g = (s.games || []).find(g => String(g.gamePk) === String(gamePk));
        if (g) { game = g; break; }
      }
    }

    if (!game) {
      return res.status(404).json({ error: 'Game not found on schedule (tried today +/- 1 day ET)' });
    }

    // 2. Park factor
    let parkFactor = null;
    let parkGeo = null;
    if (game.homeTeam?.abbreviation) {
      const key = game.homeTeam.abbreviation.toUpperCase();
      if (PARK_FACTORS_BY_TEAM[key]) {
        parkFactor = { ...PARK_FACTORS_BY_TEAM[key], team: key };
      }
      parkGeo = getParkGeo(key);
    }

    // 3. Umpire + Weather (parallel with everything else)
    const umpPromise = fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);

    const weatherPromise = (parkGeo && game.gameDateET && game.gameTime)
      ? getWeatherForecast(parkGeo.lat, parkGeo.lng, game.gameDateET, game.gameTime).catch(() => null)
      : Promise.resolve(null);

    const results = {
      gamePk,
      awayTeam: game.awayTeam,
      homeTeam: game.homeTeam,
      venue: game.venue,
      gameTime: game.gameTime,
      gameDateET: game.gameDateET,
      park: parkFactor,
      parkGeo,
      umpire: null,
      weather: null,
      weatherImpact: null,
      envImpact: null,
      deepMode,
      awayVsHome: null,
      homeVsAway: null
    };

    // Resolve umpire
    const liveFeed = await umpPromise;
    if (liveFeed) {
      const officials = liveFeed?.gameData?.officials || [];
      const hp = officials.find(o => o.officialType === 'Home Plate' || o.officialType === 'Home');
      if (hp) {
        const umpName = hp.official?.fullName || '';
        const factors = getAbsAdjustedFactors(umpName);
        const classification = classifyUmp(factors);
        results.umpire = {
          assigned: true,
          name: umpName,
          factors,
          absAdjusted: factors.absAdjusted || false,
          highOverturn: factors.highOverturn || false,
          ...classification
        };
      } else {
        results.umpire = { assigned: false, message: 'Not yet posted (~1-3hr before first pitch)' };
      }
    }

    // Resolve weather
    const weather = await weatherPromise;
    if (weather && parkGeo) {
      results.weather = weather;
      results.weatherImpact = computeWeatherImpact(weather, parkGeo);
    }

    // Composite environment impact: park × weather + interaction terms.
    // Replaces the flat `parkRunMult * weatherRunMult` chain in
    // buildGameProjection. Addresses the +2.9 runs UNDER calibration bias
    // by surfacing interactions (hot×wind-out, hitter-park×hot, altitude×hot,
    // pitcher-park×cold) the flat product missed. Computed even when weather
    // is unavailable — falls back gracefully to park-only multiplier.
    if (parkFactor || results.weatherImpact) {
      results.envImpact = computeEnvironmentImpact(parkFactor, results.weatherImpact, parkGeo);
    }

    const sides = [
      { hitTeamId: game.awayTeam.id, hitTeamAbbr: game.awayTeam.abbreviation, pitcher: game.homePitcher, pitTeamAbbr: game.homeTeam.abbreviation, key: 'awayVsHome', side: 'away' },
      { hitTeamId: game.homeTeam.id, hitTeamAbbr: game.homeTeam.abbreviation, pitcher: game.awayPitcher, pitTeamAbbr: game.awayTeam.abbreviation, key: 'homeVsAway', side: 'home' }
    ];

    // Kick off pitcher prop lines fetch (DraftKings via The Odds API) in parallel with
    // side processing. Single fetch per request returns lines for ALL games on the slate;
    // cached 15 min on the server. If the fetch fails or no key is configured, sides
    // proceed with projection-only (graceful degradation). Resolved AFTER side processing
    // and applied post-hoc to grade projections against book lines.
    const propsLinesPromise = fetchPitcherPropsLines().catch(() => null);

    // TEAM ECOSYSTEM FETCH (May 23, 2026)
    //
    // Fetches season-to-date team OBP, R/G, LOB/G, and OPS for both teams in
    // the game. Used downstream by the compound engine to:
    //   - Adjust expectedPa via lineup continuation factor
    //   - Set rPerOnBase (hitter's actual scoring rate from teammate context)
    //   - Compute fragility score (dead offenses penalize compound props)
    //
    // Cached 12h per team. Falls back to league averages on fetch failure.
    // Resolves before per-side processing so each side gets its ecosystem.
    const ecosystemsPromise = getGameEcosystems(
      game.awayTeam?.id,
      game.homeTeam?.id,
      season
    ).catch(err => {
      console.warn('[ecosystem] fetch failed, using league fallback:', err?.message);
      return { away: null, home: null };
    });
    const ecosystems = await ecosystemsPromise;

    // Process both sides in parallel using helpers directly (no HTTP)
    const sideResults = await Promise.all(sides.map(async s => {
      if (!s.pitcher || !s.hitTeamId) return null;

      const [arsenal, lineup, bullpen, pitcherSplits, inningSplits, pitcherRole, homeRoadSplits, recentStarts, careerStats, vsTeamHistory] = await Promise.all([
        getPitcherArsenal(s.pitcher.id, season).catch(() => []),
        getLineup(s.hitTeamId, gamePk, s.side).catch(() => []),
        getBullpenProfile(s.pitTeamAbbr, season, s.pitcher.id).catch(() => ({ pitches: [], pitcherCount: 0 })),
        getPitcherSplits(s.pitcher.id, season).catch(() => ({ vsR: null, vsL: null })),
        // Inning splits fetched in deep mode only (heavy data pull) or when game has odds (likely big-money matchup)
        (deepMode ? getBlendedInningSplits(s.pitcher.id).catch(() => null) : Promise.resolve(null)),
        // Role detection — always runs, lightweight call
        detectPitcherRole(s.pitcher.id).catch(() => null),
        // Home/road splits — lightweight, always fetched. Used to surface dome-vs-outdoor
        // and altitude effects on pitcher performance.
        getPitcherHomeRoadSplits(s.pitcher.id, season).catch(() => ({ home: null, road: null })),
        // Recent starts — last 3 starts with IP/K/BB/ER. Used for form trend display
        // and to inform Outs projection (already in role data, but explicit history adds context).
        getPitcherRecentStarts(s.pitcher.id, season, 5).catch(() => []),
        // PITCHER NOVELTY (May 9, 2026): career stats for novelty detection.
        // Lineups facing rookies/recent-callups have no MLB tape on the arsenal,
        // get dominated first time through. The Yesavage failure mode.
        // Cheap MLB Stats API call; fails gracefully to null.
        getPitcherCareerStats(s.pitcher.id).catch(() => null),
        // PITCHER-VS-TEAM HISTORY (July 2026): does this arm own this specific
        // lineup? Real head-to-head starts across current + 2 prior seasons.
        // The Matthew Liberatore vs ATL case. Null unless >= 2 prior starts.
        getPitcherVsTeam(s.pitcher.id, s.hitTeamAbbr, season).catch(() => null)
      ]);

      const keyPitches = arsenal.slice(0, 3);
      const keyBullpenPitches = (bullpen.pitches || []).slice(0, 3);
      const topHitters = lineup.slice(0, 9);

      // Fetch hitter stats + splits in parallel (plus deep per-pitch-per-hand if requested)
      // Also fetch recent form (last 10 games) when feature is enabled, in parallel.
      const hitterData = await Promise.all(topHitters.map(async h => {
        try {
          // In deep mode, fetch per-pitch-type xwOBA filtered by THIS pitcher's handedness
          // Switch hitters: the "effective hand" logic happens downstream; we pull for pitcher hand
          const deepPromise = deepMode
            ? getHitterPitchTypeByHand(h.id, season, s.pitcher.hand).catch(() => [])
            : Promise.resolve([]);

          // Recent form fetch — only when display or active flag is on.
          // Uses hrAudit cache first, falls back to MLB API. Defensive: any
          // failure returns null and we proceed without form data.
          const recentFormPromise = (RECENT_FORM_DISPLAY || RECENT_FORM_ENABLED)
            ? getRecentFormCached({
                hitterId: h.id,
                hitterName: h.name,
                seasonStats: null,  // populated downstream once we have season stats
                hrAuditEntries: [],  // populated server-side: state.hrAudit is client-only
                fetchGameLog: (id) => fetchHitterGameLog(id, season)
              }).catch(err => {
                console.warn(`[recentForm] failed for ${h.name}:`, err.message);
                return null;
              })
            : Promise.resolve(null);

          const [stats, splits, deepPitchTypes, recentForm, vsPitcher] = await Promise.all([
            getHitterStats(h.id, season),
            getHitterSplits(h.id, season).catch(() => ({ vsR: null, vsL: null })),
            deepPromise,
            recentFormPromise,
            // HITTER-VS-PITCHER (July 2026): career BvP line vs tonight's
            // starter. Real MLB vsPlayer endpoint. Mirror of pitcher-vs-team.
            // Null under 5 AB; flagged noisy under 15.
            getHitterVsPitcher(h.id, s.pitcher.id).catch(() => null)
          ]);
          return { ...h, stats, splits, deepPitchTypes, recentForm, vsPitcher };
        } catch {
          return { ...h, stats: { overall: {}, pitchTypes: [] }, splits: { vsR: null, vsL: null }, deepPitchTypes: [], recentForm: null };
        }
      }));

      // DEEP MODE ONLY: per-batter RISP performance fetch (career + season blended,
      // regressed to mean by sample size). Used downstream for RBI prop adjustment
      // and lineup-level conversion tier.
      // PERF: limit to top 6 batters in lineup (high-leverage spots see more PAs and
      // dominate the conversion-tier signal). Cuts API volume from 9 → 6 per side,
      // helps avoid MLB Stats API throttling under load.
      const rispMap = deepMode
        ? await getLineupRispPerformance(topHitters.slice(0, 6).map(h => h.id)).catch(() => ({}))
        : {};

      const analyzed = hitterData.map(h => {
        const pitchTypes = h.stats?.pitchTypes || [];
        const overall = h.stats?.overall || {};
        const deepPitchTypes = h.deepPitchTypes || [];
        const hasDeepData = deepMode && deepPitchTypes.length > 0;

        // Helper: find matching pitch entry preferring deep data if available with enough sample
        const findHitterPerf = (pitcherPitch) => {
          const pLower = (pitcherPitch.type || '').toLowerCase();
          const pCode = (pitcherPitch.typeCode || '').toUpperCase();
          const matcher = (pt) => {
            const ptLower = (pt.type || '').toLowerCase();
            const ptCode = (pt.typeCode || '').toUpperCase();
            return (ptCode && ptCode === pCode) ||
                   ptLower === pLower ||
                   ptLower.includes(pLower) ||
                   pLower.includes(ptLower) ||
                   (pLower.includes('4-seam') && ptLower.includes('four-seam')) ||
                   (pLower.includes('four-seam') && ptLower.includes('4-seam'));
          };
          // Deep data preferred when PA sample is meaningful (≥ 3)
          if (hasDeepData) {
            const deep = deepPitchTypes.find(matcher);
            if (deep && deep.xwoba && deep.pa >= 3) {
              return { ...deep, _source: 'deep' };
            }
          }
          const shallow = pitchTypes.find(matcher);
          return shallow ? { ...shallow, _source: 'shallow' } : null;
        };

        const matchedPitches = [];
        let maxXwoba = 0;
        let edgeScore = 0;

        for (const kp of keyPitches) {
          const hitterPerf = findHitterPerf(kp);
          if (hitterPerf && hitterPerf.xwoba) {
            const xw = parseFloat(hitterPerf.xwoba);
            matchedPitches.push({
              pitch: kp.type,
              pitcherUsage: kp.usage,
              hitterXwoba: hitterPerf.xwoba,
              hitterXslg: hitterPerf.xslg,
              hitterPa: hitterPerf.pa || null,
              // ARSENAL-MATCHED CONTACT METRICS (May 18, 2026)
              // Hitter's K% and Whiff% AGAINST THIS PITCH TYPE — the strikeout
              // equivalent of arsenal-matched xwOBA. Feeds the contact-probability
              // engine's matchedKRate input.
              hitterKPct: hitterPerf.kPct ? parseFloat(hitterPerf.kPct) : null,
              hitterWhiffPct: hitterPerf.whiffPct ? parseFloat(hitterPerf.whiffPct) : null,
              // PITCHER'S whiff/K rate WITH THIS PITCH — how dominant the pitch is
              pitcherKPct: kp.kPct ? parseFloat(kp.kPct) : null,
              pitcherWhiffPct: kp.whiffPct ? parseFloat(kp.whiffPct) : null,
              // PITCHER ALLOWED-CONTACT PER PITCH (May 18 fix — replaces silent defaults)
              // Savant arsenal payload may expose any of these field names depending on
              // the upstream remap. We probe several plausible names and surface whatever
              // is present. Engine treats nulls correctly (pitcherDataPoints reflects
              // what's actually known). Confirmed via diagnostic in audit log.
              pitcherAllowedHardHit: (() => {
                const v = kp.hardHitPct ?? kp.hardHit ?? kp.hard_hit_percent ?? kp.allowedHardHit;
                const n = parseFloat(v);
                return Number.isFinite(n) ? n : null;
              })(),
              pitcherAllowedEv: (() => {
                const v = kp.avgEv ?? kp.exitVel ?? kp.avg_hit_speed ?? kp.allowedEv;
                const n = parseFloat(v);
                return Number.isFinite(n) ? n : null;
              })(),
              pitcherAllowedBarrel: (() => {
                const v = kp.barrelPct ?? kp.barrel ?? kp.barrel_batted_rate ?? kp.allowedBarrel;
                const n = parseFloat(v);
                return Number.isFinite(n) ? n : null;
              })(),
              // ALLOWED BA and SLG (added May 23, 2026)
              //
              // The upstream pitch-arsenal payload exposes per-pitch-type
              // allowed batting average (ba) and slugging (slg) but NOT exit
              // velocity or barrel rate. These two fields fill the EV/BAR gap
              // for Layer 2's pitcher suppression branch in contactProbability.js.
              //
              // Field name probes are intentionally narrow — the payload uses
              // bare `ba` and `slg` (verified via the L2 _kpKeys diagnostic).
              // Falling back to broader names (battingAverage, sluggingPct,
              // etc.) in case the payload schema shifts.
              pitcherAllowedBa: (() => {
                const v = kp.ba ?? kp.battingAverage ?? kp.allowedBa;
                const n = parseFloat(v);
                return Number.isFinite(n) ? n : null;
              })(),
              pitcherAllowedSlg: (() => {
                const v = kp.slg ?? kp.sluggingPct ?? kp.slugging ?? kp.allowedSlg;
                const n = parseFloat(v);
                return Number.isFinite(n) ? n : null;
              })(),
              // L2 DIAGNOSTIC (May 23, 2026 — TEMPORARY)
              // Capture the raw key names available on this pitch so the UI L2
              // diagnostic chip can show us EXACTLY what fields the upstream
              // arsenal payload is exposing. Right now HH wires but EV and BAR
              // miss — we don't know which field names ARE present for EV/BAR.
              // Once we see them, we add the matching name to the probe lookup
              // (~lines 488-497) and L2 goes from PARTIAL (1/3) to WIRED (3/3).
              // Remove this field when L2 is confirmed WIRED.
              _kpKeys: Object.keys(kp || {}).filter(k => !k.startsWith('_')),
              source: hitterPerf._source,    // 'deep' or 'shallow'
              smallSample: hitterPerf._source === 'deep' && hitterPerf.pa < 10
            });
            if (xw > maxXwoba) maxXwoba = xw;
            const usageWeight = parseFloat(kp.usage || 10) / 100;
            edgeScore += xw * usageWeight;
          }
        }

        // Same scoring against bullpen composite arsenal
        const bullpenMatches = [];
        let bullpenMaxXwoba = 0;
        let bullpenEdgeScore = 0;
        for (const bp of keyBullpenPitches) {
          const bpLower = (bp.type || '').toLowerCase();
          const hitterPerf = pitchTypes.find(pt => {
            const ptLower = (pt.type || '').toLowerCase();
            return ptLower === bpLower ||
                   ptLower.includes(bpLower) ||
                   bpLower.includes(ptLower) ||
                   (bpLower.includes('4-seam') && ptLower.includes('four-seam')) ||
                   (bpLower.includes('four-seam') && ptLower.includes('4-seam'));
          });
          if (hitterPerf && hitterPerf.xwoba) {
            const xw = parseFloat(hitterPerf.xwoba);
            bullpenMatches.push({
              pitch: bp.type,
              pitcherUsage: bp.usage,
              hitterXwoba: hitterPerf.xwoba,
              hitterXslg: hitterPerf.xslg,
              hitterKPct: hitterPerf.kPct ? parseFloat(hitterPerf.kPct) : null,
              hitterWhiffPct: hitterPerf.whiffPct ? parseFloat(hitterPerf.whiffPct) : null,
              bullpenXwobaAllowed: bp.xwoba
            });
            if (xw > bullpenMaxXwoba) bullpenMaxXwoba = xw;
            const usageWeight = parseFloat(bp.usage || 10) / 100;
            bullpenEdgeScore += xw * usageWeight;
          }
        }

        // Park + umpire adjustments
        const adjustments = [];
        let contextMultiplier = 1.0;

        if (parkFactor) {
          const barrelPct = parseFloat(overall.barrel_batted_rate?.value || 0);
          const useHrFactor = barrelPct >= 10;
          const pfVal = useHrFactor
            ? (h.hand === 'L' ? parkFactor.lhbHr : parkFactor.rhbHr)
            : parkFactor.runs;
          const pfMult = pfVal / 100;
          contextMultiplier *= pfMult;
          if (Math.abs(pfMult - 1.0) >= 0.04) {
            adjustments.push({
              type: 'park',
              label: `${parkFactor.name} ${useHrFactor?'HR':'Run'} PF ${pfVal > 100 ? '+' : ''}${(pfVal-100)}`,
              multiplier: pfMult.toFixed(3),
              favor: pfMult > 1 ? 'hitter' : 'pitcher'
            });
          }
        }

        if (results.umpire?.assigned && results.umpire.factors) {
          const umpRunsMult = results.umpire.factors.runs || 1.0;
          contextMultiplier *= umpRunsMult;
          if (Math.abs(umpRunsMult - 1.0) >= 0.02) {
            adjustments.push({
              type: 'umpire',
              label: `${results.umpire.name} ${umpRunsMult > 1 ? '+' : ''}${((umpRunsMult-1)*100).toFixed(0)}% runs`,
              multiplier: umpRunsMult.toFixed(3),
              favor: umpRunsMult > 1 ? 'hitter' : 'pitcher'
            });
          }
        }

        // ===== PLATOON ADJUSTMENT =====
        // Compare hitter's vs-this-hand OPS to overall expectation.
        // Switch hitters: use opposite-hand splits relative to pitcher hand.
        const pitcherHand = s.pitcher.hand;  // 'R' or 'L'
        const hitterHand = h.hand;            // 'R', 'L', or 'S' (switch)
        // Which splits row applies to THIS matchup
        const effectiveBatSide = hitterHand === 'S'
          ? (pitcherHand === 'L' ? 'R' : 'L')   // SHB bats opposite of pitcher
          : hitterHand;
        const hitterVsThis = pitcherHand === 'R' ? h.splits?.vsR : h.splits?.vsL;
        const hitterVsOther = pitcherHand === 'R' ? h.splits?.vsL : h.splits?.vsR;

        // Platoon metadata for UI
        let platoonMeta = {
          pitcherHand,
          effectiveBatSide,
          vsThisOps: hitterVsThis?.ops || null,
          vsThisPa: hitterVsThis?.pa || 0,
          vsOtherOps: hitterVsOther?.ops || null,
          vsOtherPa: hitterVsOther?.pa || 0,
          smallSample: (hitterVsThis?.pa || 0) < 30 && (hitterVsThis?.pa || 0) > 0,
          noData: !hitterVsThis || hitterVsThis.pa === 0,
          reverseSplit: false,
          sameHand: (effectiveBatSide === pitcherHand),
          pitcher: null   // filled after pitcher splits computed
        };

        // Only adjust if we have meaningful sample
        if (hitterVsThis && hitterVsThis.pa >= 10 && hitterVsThis.ops) {
          const vsThisOps = parseFloat(hitterVsThis.ops);
          // Reference baseline: average MLB OPS is ~.720, but use hitter's overall if we can infer
          // Simpler: compare vs-this-hand to vs-other-hand if both exist, else to .720 league avg
          let baseline = 0.720;
          let deltaVsOther = null;
          if (hitterVsOther && hitterVsOther.pa >= 10 && hitterVsOther.ops) {
            baseline = (vsThisOps + parseFloat(hitterVsOther.ops)) / 2;
            deltaVsOther = vsThisOps - parseFloat(hitterVsOther.ops);
          }
          // Platoon multiplier: OPS 100 points above baseline = +10% score
          const opsDelta = vsThisOps - baseline;
          const rawMult = 1 + (opsDelta * 1.0);  // .100 OPS above baseline -> 1.10x
          // Clamp to avoid extremes from small samples
          const sampleClamp = hitterVsThis.pa < 30 ? 0.5 : 1.0;   // small sample damped 50%
          const platoonMult = 1 + ((rawMult - 1) * sampleClamp);
          const clampedMult = Math.max(0.82, Math.min(1.22, platoonMult));

          contextMultiplier *= clampedMult;

          // Reverse split detection: traditionally RHB hit LHP better, LHB hit RHP better.
          // A reverse split is when same-handed matchup actually favors the hitter by .050+ OPS
          if (deltaVsOther !== null && platoonMeta.sameHand && deltaVsOther >= 0.050) {
            platoonMeta.reverseSplit = true;
          }
          // Reverse splits for opposite-hand too: e.g. LHB hits LHP better than RHP (unusual)
          if (deltaVsOther !== null && !platoonMeta.sameHand && deltaVsOther >= 0.080) {
            // opposite-hand matchup but hitter is actually worse vs opposite? unusual reverse
            // Don't flag — standard splits expect this to favor hitter already
          }
          if (deltaVsOther !== null && !platoonMeta.sameHand && deltaVsOther <= -0.080) {
            // Hitter is WORSE vs opposite hand than same hand — that's a reverse split too
            platoonMeta.reverseSplit = true;
          }

          platoonMeta.multiplier = clampedMult.toFixed(3);
          platoonMeta.delta = deltaVsOther !== null ? deltaVsOther.toFixed(3) : null;

          if (Math.abs(clampedMult - 1.0) >= 0.03) {
            const favor = clampedMult > 1 ? 'hitter' : 'pitcher';
            const samplTag = hitterVsThis.pa < 30 ? ' · small sample' : '';
            const reverseTag = platoonMeta.reverseSplit ? ' · REVERSE SPLIT' : '';
            adjustments.push({
              type: 'platoon',
              label: `vs ${pitcherHand}HP ${vsThisOps.toFixed(3)} OPS (${hitterVsThis.pa}PA)${reverseTag}${samplTag}`,
              multiplier: clampedMult.toFixed(3),
              favor
            });
          }
        }

        // Pitcher-side platoon metadata for UI: pitcher's performance vs this hitter's effective hand
        const pitSplitSide = effectiveBatSide === 'R' ? pitcherSplits?.vsR : pitcherSplits?.vsL;
        if (pitSplitSide && pitSplitSide.pa >= 10) {
          platoonMeta.pitcher = {
            vsBatSide: effectiveBatSide,
            opsAgainst: pitSplitSide.opsAgainst,
            kPct: pitSplitSide.kPct,
            // (Added — confirmed real: getPitcherSplits in data.js already
            // computes bbPct from baseOnBalls/plateAppearances for this exact
            // vsR/vsL split, same source as kPct/opsAgainst above.)
            bbPct: pitSplitSide.bbPct,
            pa: pitSplitSide.pa,
            smallSample: pitSplitSide.pa < 40
          };
        }

        // CALIBRATION (May 10, 2026): Cap cumulative contextMultiplier at 1.40.
        // 928-pick calibration revealed that picks with adjustedMaxXwoba > 0.70
        // hit at 39.8% (n=140) — anti-predictive vs mid-zone picks at 50%.
        // Root cause: park × umpire × platoon multipliers compounded to 1.5+
        // on hitter-friendly games, inflating adjustedMaxXwoba beyond the
        // predictive zone and clustering picks on chalk matchups the market
        // had already priced in. Cap preserves all context signal up to a
        // reasonable ceiling.
        const cappedContextMultiplier = Math.min(1.40, contextMultiplier);
        // (Phase 1 — May 29, 2026) Cap the final adjustedMaxXwoba at 0.80.
        // Live data on n=169 produced values up to 1.434 (Yelich) and 1.293
        // (Cruz) — physically nonsense pre-PA projections. These were
        // displayed to users as confident TOP PICK ELITE recommendations
        // and lost. The cap preserves all signal up to a sane ceiling
        // (0.80 = "Bonds peak season" — beyond that is multiplier runaway).
        // The capped flag is consumed by the fade engine (Component 6).
        const ADJUSTED_XWOBA_CEILING = 0.80;
        const rawAdjustedMaxXwoba = maxXwoba * cappedContextMultiplier;
        const adjustedMaxXwoba = Math.min(rawAdjustedMaxXwoba, ADJUSTED_XWOBA_CEILING);
        const adjustedXwobaCapped = rawAdjustedMaxXwoba > ADJUSTED_XWOBA_CEILING;
        const adjustedEdge = edgeScore * cappedContextMultiplier;

        // HITTER TIER REGRESSION (flag-gated, default OFF)
        // 50/50 blend of best-case (adjustedMaxXwoba) and expected (adjustedEdge).
        // edgeScore is already usage-weighted (sum of xw × usage_pct for matched
        // pitches), so it represents the expected xwOBA across the pitcher's
        // actual arsenal distribution — not the theoretical max.
        //
        // When the flag is on, tier classification uses regressed value. When
        // off, behavior is identical to before (uses adjustedMaxXwoba). Both
        // values are always surfaced in the output for diagnostic comparison.
        const regressedMaxXwoba = (adjustedMaxXwoba + adjustedEdge) / 2;
        const tierEvalXwoba = HITTER_TIER_REGRESSION_ENABLED ? regressedMaxXwoba : adjustedMaxXwoba;

        let tier = null;
        if (tierEvalXwoba >= 0.420) tier = 'elite';
        else if (tierEvalXwoba >= 0.370) tier = 'strong';
        else if (tierEvalXwoba >= 0.330) tier = 'solid';

        // Build plain-language edge description
        const description = buildEdgeDescription({
          hitter: h,
          matchedPitches,
          maxXwoba,
          overall,
          adjustments,
          parkFactor,
          tier
        });

        // Bullpen mismatch tier
        let bullpenTier = null;
        if (bullpenMaxXwoba >= 0.420) bullpenTier = 'elite';
        else if (bullpenMaxXwoba >= 0.370) bullpenTier = 'strong';
        else if (bullpenMaxXwoba >= 0.330) bullpenTier = 'solid';

        // DAMAGE QUALITY PHASE 2 — archetype classification + matchup tier shift
        // (May 15, 2026). Phase 1 already populates seasonStats batted-ball %s
        // (gbPct, fbPct, ldPct, etc) and arsenal is already loaded. This block
        // classifies both hitter and pitcher, computes the matchup tier shift,
        // and optionally applies it (when DAMAGE_QUALITY_APPLY_TIER_SHIFTS is on).
        //
        // In shadow mode (default), archetypes are computed and surfaced in the
        // output but tier classification stays on the existing logic. Lets us
        // validate classification accuracy before changing model behavior.
        let damageHitterArchetype = null;
        let damagePitcherArchetype = null;
        let damageTierShift = 0;
        let damageNote = null;
        if (DAMAGE_QUALITY_ENABLED) {
          // classifyHitter expects raw season stats with batted-ball % keys.
          // Build the input object from the data we already have.
          damageHitterArchetype = classifyHitter({
            gb_percent: overall.gb_percent?.value,
            fb_percent: overall.fb_percent?.value,
            ld_percent: overall.ld_percent?.value,
            popup_percent: overall.popup_percent?.value,
            sweet_spot_percent: overall.sweet_spot_percent?.value,
            pull_percent: overall.pull_percent?.value,
            barrel_batted_rate: overall.barrel_batted_rate?.value,
            k_percent: overall.k_percent?.value,
            batted_balls: overall.batted_balls?.value ?? overall.bbe?.value ?? 0
          });
          damagePitcherArchetype = classifyPitcher(arsenal);
          damageTierShift = getTierShift(damageHitterArchetype, damagePitcherArchetype);
          damageNote = buildDamageNote(damageHitterArchetype, damagePitcherArchetype, damageTierShift);

          // SHADOW MODE: only apply the shift if the second flag is on.
          if (DAMAGE_QUALITY_APPLY_TIER_SHIFTS && tier && damageTierShift !== 0) {
            tier = applyTierShift(tier, damageTierShift);
          }
        }

        // Build ranked prop recommendations
        const propRecs = buildPropRecommendations({
          hitter: h,
          matchedPitches,
          maxXwoba,
          overall,
          parkFactor,
          adjustments,
          tier,
          bullpenMaxXwoba,
          bullpenTier,
          // TEAM ECOSYSTEM (May 23, 2026)
          // s.side determines which team is hitting. The hitter belongs to
          // s.side's team — pass that team's ecosystem (OBP, R/G, LOB/G)
          // so the compound engine can adjust expectedPa and fragility.
          teamEcosystem: s.side === 'away' ? ecosystems.away : ecosystems.home,
          // gameTotal is not yet available at this point (odds resolved later).
          // The compound engine handles null gracefully — it just skips the
          // game-total PA adjustment factor and relies on ecosystem + pitcher K%.
          gameTotal: null
        });

        return {
          hitterId: h.id,
          hitter: h.name,
          hand: h.hand,
          position: h.position,
          battingOrder: h.battingOrder || null,
          vsPitcher: h.vsPitcher || null,  // HITTER-VS-PITCHER: BvP "owns this arm" (July 2026)
          matchedPitches,
          maxXwoba: maxXwoba.toFixed(3),
          adjustedMaxXwoba: adjustedMaxXwoba.toFixed(3),
          // (Phase 1 — May 29, 2026) Capped-flag for fade engine Component 6
          // and PRIME tier rejection. Raw value also exposed for debug.
          adjustedXwobaCapped,
          rawAdjustedMaxXwoba: rawAdjustedMaxXwoba.toFixed(3),
          edgeScore: edgeScore.toFixed(3),
          adjustedEdgeScore: adjustedEdge.toFixed(3),
          // (Drop #3 Fix #5 — May 30, 2026) Gap-penalized edge score.
          // May 30 audit (n=177) showed inflation_gap is the strongest
          // single predictor of W/L (Cohen's d = -0.28, NEGATIVE) while
          // adjustedMaxXwoba is mildly INVERTED (d = -0.14).
          // This composite penalizes edge for gap, giving us a metric
          // that's positively correlated with outcomes.
          // Used by render layer + future tier ranking work.
          gapPenalizedEdge: (adjustedEdge - 2 * Math.max(0, (adjustedMaxXwoba - regressedMaxXwoba))).toFixed(3),
          // (Drop #5 Fix #5 — May 31, 2026) Pitcher BB% exposed for fade engine.
          // May 31 audit (n=181) showed losers averaged 0.47 BB vs winners 0.36
          // — losing hitters get pitched around. Walks don't count for HRR.
          // Pitchers with BB% > 11% are a structural HRR fade signal.
          _pitcherBbPct: (() => {
            if (!inningSplits?.perInning) return null;
            const innings = Object.values(inningSplits.perInning);
            let bbSum = 0, paSum = 0;
            for (const i of innings) {
              if (i.bbPct != null && i.pa) {
                bbSum += i.bbPct * i.pa;
                paSum += i.pa;
              }
            }
            return paSum > 0 ? bbSum / paSum : null;  // already decimal (0.10 = 10%)
          })(),
          // HITTER TIER REGRESSION diagnostic — always populated, used to
          // compare classifier behavior with/without the flag enabled.
          regressedMaxXwoba: regressedMaxXwoba.toFixed(3),
          tierEvalXwoba: tierEvalXwoba.toFixed(3),
          tierRegressionEnabled: HITTER_TIER_REGRESSION_ENABLED,
          contextMultiplier: contextMultiplier.toFixed(3),
          cappedContextMultiplier: cappedContextMultiplier.toFixed(3),
          adjustments,
          tier,
          description,
          propRecs,
          platoonMeta,
          hasDeepData,
          // (Phase 2 — May 29, 2026) PRIME tier classification + lineup support.
          // Default values; populated downstream by classifyPrimeTier()
          // and the lineup-support pass after all hitters are analyzed.
          isPrime: false,
          isPrimeEligible: false,
          primeScore: null,
          primeRejectReason: null,
          lineupSupport: null,
          fragility: null,
          // Bullpen cross-reference
          bullpenMatches,
          bullpenMaxXwoba: bullpenMaxXwoba.toFixed(3),
          bullpenEdgeScore: bullpenEdgeScore.toFixed(3),
          bullpenTier,
          // DAMAGE QUALITY PHASE 2 fields (always populated when flag is on,
          // null when DAMAGE_QUALITY_ENABLED=false). Shadow mode flag tells
          // the UI to show "(shadow)" indicator when tier isn't actually shifted.
          damageHitterArchetype,
          damagePitcherArchetype,
          damageTierShift,
          damageNote,
          damageShadowMode: DAMAGE_QUALITY_ENABLED && !DAMAGE_QUALITY_APPLY_TIER_SHIFTS,
          // RECENT FORM fields (Wave 4, May 15, 2026). When DISPLAY is on,
          // surface a slim summary for the UI chip + audit log. The full
          // record (with rates and deltas) lives in h.recentForm but isn't
          // serialized into the response to keep payload size sane.
          recentForm: (RECENT_FORM_DISPLAY && h.recentForm) ? {
            label: h.recentForm.formLabel,
            multiplier: h.recentForm.formMultiplier,
            gamesUsed: h.recentForm.gamesUsed,
            paUsed: h.recentForm.paUsed,
            source: h.recentForm.source,
            hot: h.recentForm.flags?.hot || false,
            scorching: h.recentForm.flags?.scorching || false,
            cold: h.recentForm.flags?.cold || false,
            injuryRisk: h.recentForm.flags?.injuryRisk || false,
            applied: RECENT_FORM_ENABLED,  // false = shadow mode (display only)
            // Small selection of useful stats for the audit panel
            recentH: h.recentForm.recent?.h ?? null,
            recentHR: h.recentForm.recent?.hr ?? null,
            recentAvg: h.recentForm.recent?.avg != null ? parseFloat(h.recentForm.recent.avg.toFixed(3)) : null,
            recentIso: h.recentForm.recent?.iso != null ? parseFloat(h.recentForm.recent.iso.toFixed(3)) : null
          } : null,
          seasonStats: {
            xwoba: overall.xwoba?.value || null,
            barrelPct: overall.barrel_batted_rate?.value || null,
            hardHitPct: overall.hard_hit_percent?.value || null,
            avgEV: overall.avg_exit_velocity?.value || null,
            kPct: overall.k_percent?.value || null,
            // (Added — walk-rate for PA-outcome modeling.) Confirmed: Savant's
            // custom leaderboard requests bb_percent (CUSTOM_URL in data.js),
            // and the mapping into `overall.bb_percent` was fixed there —
            // it was previously requested but never mapped, always null.
            bbPct: overall.bb_percent?.value || null,
            // PHASE 1 DAMAGE QUALITY: batted-ball percentages for archetype
            // classification. Null when Savant doesn't return data — Phase 2
            // classifier treats null as BALANCED (no archetype edge).
            gbPct: overall.gb_percent?.value || null,
            fbPct: overall.fb_percent?.value || null,
            ldPct: overall.ld_percent?.value || null,
            popupPct: overall.popup_percent?.value || null,
            sweetSpotPct: overall.sweet_spot_percent?.value || null,
            pullPct: overall.pull_percent?.value || null,
            oppoPct: overall.oppo_percent?.value || null,
            // Tier 3 QUALITY-OF-CONTACT adds — power (xslg) + launch profile
            // for the HR / multi-hit matchup banner. Null when Savant omits them.
            xslg: overall.xslg?.value || null,
            xba: overall.xba?.value || null,
            launchAngle: overall.launch_angle?.value || null
          },
          // HR Chance scoring (v2 — EMPIRICALLY-CALIBRATED, see _lib/hrEmpirical.js)
          // Replaces v1's hand-tuned integer scoring with multipliers grounded in
          // sabermetric research (barrel→HR conversion, park factors, weather effects).
          //
          // Two outputs from one computation:
          //   - `hrChance` — null below SOLID threshold (governs whether badge fires)
          //   - `hrAudit`  — always populated (diagnostic; helps audit model behavior)
          ...(function computeHr() {
            // Pass null cleanly when stat is missing — barrelMultiplier and friends
            // treat null as "no information" (neutral mult). Falling back to 0 used to
            // make missing data look like "limited power" which tanked the projection.
            const barrelRaw = overall.barrel_batted_rate?.value;
            const barrel = (barrelRaw != null && !isNaN(parseFloat(barrelRaw))) ? parseFloat(barrelRaw) : null;
            const hardHitRaw = overall.hard_hit_percent?.value;
            const hardHit = (hardHitRaw != null && !isNaN(parseFloat(hardHitRaw))) ? parseFloat(hardHitRaw) : null;
            const kPctRaw = overall.k_percent?.value;
            const kPct = (kPctRaw != null && !isNaN(parseFloat(kPctRaw))) ? parseFloat(kPctRaw) : null;
            const bestMatchedXwoba = matchedPitches.reduce((max, p) => Math.max(max, parseFloat(p.hitterXwoba || 0)), 0);
            // Identify dominant pitch (highest xwOBA in the matched set) for driver text
            const dominantMatch = matchedPitches.reduce(
              (best, p) => parseFloat(p.hitterXwoba || 0) > parseFloat(best?.hitterXwoba || 0) ? p : best,
              null
            );
            const dominantPitch = dominantMatch?.type || null;

            // Park HR factor (handedness-aware). Weather is factored separately
            // inside the empirical module via weatherMultiplier — don't double-apply.
            const parkHrMult = parkFactor ? getParkHrMult(parkFactor, effectiveBatSide) : 1.0;

            // Pitcher HR vulnerability — derive HR/9 from splits vs effective hand
            let pitcherHrPer9 = null;
            const pitSplit = effectiveBatSide === 'R' ? pitcherSplits?.vsR : pitcherSplits?.vsL;
            if (pitSplit && pitSplit.pa >= 30 && pitSplit.hr != null) {
              const hrPerPa = pitSplit.hr / Math.max(1, pitSplit.pa);
              pitcherHrPer9 = hrPerPa * 4.3 * 9;  // ~4.3 PA per inning, so HR/9 = HR/PA × 4.3 × 9
            }

            // Sample size for the hitter — sum of vsR + vsL PAs from this hitter's splits
            const seasonPa = (h.splits?.vsR?.pa || 0) + (h.splits?.vsL?.pa || 0);

            // Platoon adjustment already computed earlier in this batter's analysis
            const platoonAdjustment = adjustments.find(a => a.type === 'platoon');

            // Single computation, both outputs. computeHrAudit always returns the
            // projection; we derive hrChance by gating on the SOLID threshold.
            //
            // Wave 4 (May 15, 2026): pass recentForm only when RECENT_FORM_ENABLED.
            // When in shadow mode (_DISPLAY only), we surface the record at the
            // hitter level for UI but DON'T apply the multiplier to scoring.
            const audit = computeHrAudit({
              barrelPct: barrel,
              hardHitPct: hardHit,
              kPct,
              seasonPa,
              bestMatchedXwoba,
              dominantPitch,
              pitcherHrPer9,
              parkHrMult,
              parkName: parkFactor?.name,
              weatherImpact: results.weatherImpact,
              batSide: effectiveBatSide,
              platoonAdjustment,
              bullpenTier,
              recentForm: RECENT_FORM_ENABLED ? h.recentForm : null
            });

            // PER-GAME HR TIER (May 23, 2026 — Item 7: structural overhaul)
            //
            // Previously the HR tier (ELITE/STRONG/SOLID) came from the per-PA
            // HR rate. That made the label number misleading — "ELITE 11.5%"
            // told you the per-PA rate, but the prop you'd bet (HR 0.5 over)
            // is per-game. P(HR ≥ 1) per game for an 11.5%/PA hitter over 4.2
            // PA is ~40%, not 11.5%.
            //
            // This step layers a per-game probability + per-game tier on top
            // of the existing audit. We preserve `projectedHrPerPa` for any
            // downstream code that reads it, but add:
            //   - audit.projectedHrPerGame  : P(HR ≥ 1) compounded over PAs
            //   - audit.tierPerGame         : tier from per-game probability
            //   - audit.tierLabelPerGame    : display label for per-game tier
            //
            // The original `audit.tier` (per-PA-derived) is left alone for
            // backward compatibility. UI prefers `tierPerGame` when present.
            //
            // Per-game thresholds (calibrated against archetypal profiles):
            //   ELITE  if P(HR≥1) >= 35%   (rare — power hitter + good park + soft SP)
            //   STRONG if P(HR≥1) >= 25%
            //   SOLID  if P(HR≥1) >= 18%
            //   below 18% → no tier label
            if (audit && Number.isFinite(audit.projectedHrPerPa)) {
              const ePa = expectedPaForLineupSlot(h.battingOrder);
              const perPa = audit.projectedHrPerPa;
              const perGame = 1 - Math.pow(1 - perPa, ePa);
              audit.projectedHrPerGame = perGame;
              audit.expectedPaForHrTier = ePa;

              let perGameTier = null;
              let perGameLabel = null;
              if (perGame >= 0.35) { perGameTier = 'elite';  perGameLabel = 'ELITE';  }
              else if (perGame >= 0.25) { perGameTier = 'strong'; perGameLabel = 'STRONG'; }
              else if (perGame >= 0.18) { perGameTier = 'solid';  perGameLabel = 'SOLID';  }
              audit.tierPerGame = perGameTier;
              audit.tierLabelPerGame = perGameLabel;
            }

            // (Drop #17 — June 7, 2026) EMPIRICAL HR TIER OVERRIDE
            // (Drop #18 — June 7, 2026) Split PLATINUM into ELITE + PLATINUM.
            //
            // Full audit on n=1,854 graded HR audit entries (April 23 - May 25):
            //
            //   ELITE ✧    : Barrel ≥ 15% AND HR/9 ≥ 2.0
            //                → 54.5% HR rate, 6/11, CI [28%, 79%]
            //                → thirds 33/67/60 (improving)
            //                → ~0.5 fires/slate
            //
            //   PLATINUM ✦ : Barrel ≥ 15% AND HR/9 1.8-2.0 (leftover from
            //                original PLATINUM after ELITE carved out)
            //                → 28.6% HR rate, 2/7, CI [8%, 64%]
            //                → small subset, watch in production
            //                → ~0.3 fires/slate
            //
            //   GOLD ★     : Barrel ≥ 12% AND HR/9 ≥ 1.8
            //                OR Barrel ≥ 15% AND park boost ≥ +10%
            //                → 22.4% HR rate, 13/58, CI [14%, 35%]
            //                → ~2.4 fires/slate
            //
            //   SILVER ◆   : Barrel ≥ 10% AND (HR/9 ≥ 1.5 OR park ≥ +10%)
            //                OR Barrel ≥ 12% AND HR/9 ≥ 1.5
            //                → 13.6% HR rate, 26/191, CI [9%, 19%]
            //                → ~8 fires/slate
            //
            //   BRONZE ◇   : per-game tier solid+ (legacy fallback)
            //                → 11.9% HR rate, 71/598
            //
            // Replaces existing elite/strong/solid tiers entirely.
            // _lib/hrEmpirical.js is not modified — override happens after the
            // fact. Original per-PA/per-game tiers stay on audit as
            // _legacyTier/_legacyTierPerGame for diagnostic.
            if (audit) {
              const _b = (barrel != null) ? parseFloat(barrel) : 0;
              const _hr9 = (pitcherHrPer9 != null) ? parseFloat(pitcherHrPer9) : 0;
              const _parkBoost = (parkHrMult != null) ? (parseFloat(parkHrMult) - 1) * 100 : 0;
              // (Drop #21 — June 7, 2026) Sample-size gate.
              // Barrel% requires ~50 batted balls to stabilize, which means
              // roughly 150-200 PA in season. Below 100 PA the rate is too
              // noisy to trust for empirical tier classification — small-
              // sample hitters get demoted one tier. Below 30 PA: no empirical
              // tier at all (fall through to legacy bronze if available).
              const _pa = (seasonPa != null) ? parseInt(seasonPa, 10) : 0;
              const _sampleTier = _pa >= 100 ? 'full' : (_pa >= 30 ? 'thin' : 'insufficient');

              // Preserve legacy tiers for diagnostic
              audit._legacyTier = audit.tier;
              audit._legacyTierLabel = audit.tierLabel;
              audit._legacyTierPerGame = audit.tierPerGame;
              audit._legacyTierLabelPerGame = audit.tierLabelPerGame;

              audit._empBarrel = _b;
              audit._empHrPer9 = _hr9;
              audit._empParkBoost = _parkBoost;
              audit._empSeasonPa = _pa;
              audit._empSampleTier = _sampleTier;

              let empTier = null;
              let empLabel = null;
              let empBacktestRate = null;
              let empBacktestN = null;

              // ELITE ✧ : extreme barrel + very vulnerable pitcher (54.5%)
              if (_b >= 15 && _hr9 >= 2.0) {
                empTier = 'elite';
                empLabel = 'ELITE';
                empBacktestRate = 0.545;
                empBacktestN = 11;
              // PLATINUM ✦ : extreme barrel + vulnerable pitcher (28.6%, watch)
              } else if (_b >= 15 && _hr9 >= 1.8) {
                empTier = 'platinum';
                empLabel = 'PLATINUM';
                empBacktestRate = 0.286;
                empBacktestN = 7;
              // GOLD ★ : strong barrel + vulnerable pitcher OR strong barrel + park boost
              } else if ((_b >= 12 && _hr9 >= 1.8) || (_b >= 15 && _parkBoost >= 10)) {
                empTier = 'gold';
                empLabel = 'GOLD';
                empBacktestRate = 0.224;
                empBacktestN = 58;
              // SILVER ◆ : above-avg barrel + (vulnerable pitcher OR favorable park)
              } else if ((_b >= 10 && (_hr9 >= 1.5 || _parkBoost >= 10))
                         || (_b >= 12 && _hr9 >= 1.5)) {
                empTier = 'silver';
                empLabel = 'SILVER';
                empBacktestRate = 0.136;
                empBacktestN = 191;
              // BRONZE ◇ : any positive signal (legacy fallback)
              } else if (audit._legacyTierPerGame === 'solid'
                         || audit._legacyTierPerGame === 'strong'
                         || audit._legacyTierPerGame === 'elite'
                         || audit._legacyTier === 'solid'
                         || audit._legacyTier === 'strong'
                         || audit._legacyTier === 'elite') {
                empTier = 'bronze';
                empLabel = 'BRONZE';
                empBacktestRate = 0.119;
                empBacktestN = 598;
              }

              // (Drop #21 — June 7, 2026) SAMPLE-SIZE DEMOTION
              //
              // Barrel% is the master signal in our tier classifier, but it
              // doesn't stabilize until ~150-200 PA. Eric Haase on 6/7 showed
              // ELITE 34.2% off Barrel 21.9% — but only 47 PA backing it.
              // Statcast noise can swing that ±5% on small samples.
              //
              // Rule: < 30 PA blocks empirical tier entirely (fall to legacy
              // bronze if available, else null). 30-99 PA demotes by one
              // step. ≥ 100 PA: no demotion.
              //
              // We also stamp _empSampleDemoted on the audit so the UI can
              // show an INSUFFICIENT/THIN DATA chip in the badge tooltip.
              const _tierLadder = ['bronze', 'silver', 'gold', 'platinum', 'elite'];
              if (empTier && _sampleTier === 'insufficient') {
                audit._empSampleDemoted = `< 30 PA — empirical tier suppressed (was ${empLabel})`;
                empTier = null;
                empLabel = null;
                empBacktestRate = null;
                empBacktestN = null;
                // Bronze fallback if legacy tier present (matches existing branch above)
                if (audit._legacyTierPerGame === 'solid'
                    || audit._legacyTierPerGame === 'strong'
                    || audit._legacyTierPerGame === 'elite'
                    || audit._legacyTier === 'solid'
                    || audit._legacyTier === 'strong'
                    || audit._legacyTier === 'elite') {
                  empTier = 'bronze';
                  empLabel = 'BRONZE';
                  empBacktestRate = 0.119;
                  empBacktestN = 598;
                }
              } else if (empTier && _sampleTier === 'thin') {
                const idx = _tierLadder.indexOf(empTier);
                if (idx > 0) {
                  const demotedTier = _tierLadder[idx - 1];
                  audit._empSampleDemoted = `Thin data (${_pa} PA) — demoted ${empLabel} → ${demotedTier.toUpperCase()}`;
                  empTier = demotedTier;
                  empLabel = demotedTier.toUpperCase();
                  // Backtest rates per tier (matching the classifier branches above)
                  switch (empTier) {
                    case 'platinum': empBacktestRate = 0.286; empBacktestN = 7;  break;
                    case 'gold':     empBacktestRate = 0.224; empBacktestN = 58; break;
                    case 'silver':   empBacktestRate = 0.136; empBacktestN = 191; break;
                    case 'bronze':   empBacktestRate = 0.119; empBacktestN = 598; break;
                  }
                }
              }

              // Map empirical tier → existing 'elite/strong/solid' enum so
              // downstream code (badges, filters, lineup gating) keeps working.
              let mappedLegacyTier = null;
              if (empTier === 'elite') mappedLegacyTier = 'elite';
              else if (empTier === 'platinum') mappedLegacyTier = 'elite';
              else if (empTier === 'gold') mappedLegacyTier = 'elite';
              else if (empTier === 'silver') mappedLegacyTier = 'strong';
              else if (empTier === 'bronze') mappedLegacyTier = 'solid';

              audit.tier = mappedLegacyTier;
              audit.tierLabel = empLabel;
              audit.tierPerGame = mappedLegacyTier;
              audit.tierLabelPerGame = empLabel;
              audit.empiricalTier = empTier;
              audit.empiricalTierLabel = empLabel;
              audit.empiricalBacktestRate = empBacktestRate;
              audit.empiricalBacktestN = empBacktestN;
            }

            return {
              hrChance: audit.tier ? audit : null,  // null below SOLID — preserves existing badge gating
              hrAudit: audit  // always populated — used by per-side digest for diagnostic
            };
          })()
        };
      });

      const tiered = analyzed
        .filter(h => h.tier)
        .sort((a, b) => parseFloat(b.adjustedEdgeScore) - parseFloat(a.adjustedEdgeScore));

      // TOP PICK: most advantageous hitter on this side
      // Uses a composite score rewarding: adjusted edge × tier weight × bullpen-full-game bonus × platoon bonus
      const tierWeight = { elite: 1.30, strong: 1.15, solid: 1.0 };
      const withTopPickScore = tiered.map(h => {
        let topScore = parseFloat(h.adjustedEdgeScore || 0);
        topScore *= (tierWeight[h.tier] || 1.0);
        // FULL GAME bonus REMOVED (May 10, 2026 calibration).
        // 928-pick analysis confirmed the design doc hypothesis: SP-only picks
        // hit 51.8% (n=247), FULL GAME picks hit 49.1% (n=698). The bullpen edge
        // correlates with the SP edge (same pitcher tendencies surfacing twice
        // in the arsenal), so the 1.18× was treating correlated signals as
        // independent. Visual FULL GAME label still surfaces for context, but
        // it no longer biases pick selection.
        // if (h.tier && h.bullpenTier) topScore *= 1.18;
        // Reverse split / strong platoon bonus (if adjustment is meaningfully hitter-favoring)
        const platoonAdj = (h.adjustments || []).find(a => a.type === 'platoon' && a.favor === 'hitter');
        if (platoonAdj) {
          const mult = parseFloat(platoonAdj.multiplier || 1);
          if (mult > 1.08) topScore *= 1.08;
        }
        // Reverse split specifically gets extra weight (market undervalued angle)
        if (h.platoonMeta?.reverseSplit) topScore *= 1.05;
        // Switch-hitter vs RHP boost (May 10, 2026 calibration).
        // 928-pick analysis: switch hitters vs RHP hit 60.4% (n=53). Durable
        // empirical edge with no current modifier. Modest boost (1.06) since
        // sample is moderate and we don't want to overweight a single signal.
        if (h.hand === 'S' && h.platoonMeta?.pitcherHand === 'R') topScore *= 1.06;
        return { ...h, _topPickScore: topScore };
      }).sort((a, b) => b._topPickScore - a._topPickScore);

      // First entry (if it meets a minimum quality bar) is the TOP PICK
      let topPick = null;
      if (withTopPickScore.length > 0) {
        const candidate = withTopPickScore[0];
        // Use the same regressed value as tier classification when flag is on,
        // so the qualification check is consistent with the tier assignment.
        const candidateQualifyingXw = HITTER_TIER_REGRESSION_ENABLED
          ? parseFloat(candidate.regressedMaxXwoba || candidate.adjustedMaxXwoba)
          : parseFloat(candidate.adjustedMaxXwoba);
        // (Phase 1 — May 29, 2026) Removed bullpenTier from qualifier path.
        // Live data on n=169 showed bullpenTier='strong' at 35% WR and NULL
        // at 55% WR — inverted/noisy signal. Solid-tier no longer qualifies
        // via bullpen alone. Until the bullpen tier assignment logic is
        // rebuilt, only the primary xwoba-based tier drives qualification.
        const candidateQualifies = candidate.tier === 'elite' ||
                                   (candidate.tier === 'strong' && candidateQualifyingXw >= 0.380);

        // (Drop #3 Fix #2 — May 30, 2026) HARD GAP REJECT.
        // May 30 data on n=177 showed a sharp cliff at gap = 0.10:
        //   gap 0.05-0.10: 55% WR (n=62) — above breakeven
        //   gap 0.10-0.13: 26% WR (n=34) — catastrophic 29pt drop
        //   gap 0.10+ overall: 27% WR (n=95)
        // The fade engine awards points for gap but still lets these
        // through if the candidate is otherwise elite. The data says
        // gap >= 0.10 should HARD REJECT — disqualify entirely, not
        // just shade. Independent of fade engine scoring.
        const candidateAdj = parseFloat(candidate.adjustedMaxXwoba);
        const candidateReg = parseFloat(candidate.regressedMaxXwoba);
        const candidateGap = (Number.isFinite(candidateAdj) && Number.isFinite(candidateReg))
          ? (candidateAdj - candidateReg) : 0;
        const failedGapReject = candidateGap >= 0.10;
        if (failedGapReject) {
          candidate._gapRejected = true;
          candidate._gapRejectValue = candidateGap;
        }

        // (Drop #5 Fix #4 — May 31, 2026) PA-floor fade signal.
        //
        // May 31 audit (n=181) showed winners averaged 4.25 PA vs losers
        // 3.83 PA — an 11% gap. Hitters with projected PA < 4.0 are
        // structurally disadvantaged on HRR/HITS because they get fewer
        // shots at the line. Lineup support factor weights slot but the
        // PA-opportunity downside isn't aggressive enough.
        //
        // Two rules:
        //   1. PA < 4.0 → flag candidate as PA-disadvantaged. Doesn't
        //      block qualification but downgrades PRIME eligibility.
        //   2. Slot 7+ → never PRIME-eligible regardless of other criteria.
        //      Bottom-of-order hitters might be "elite-tier" by xwoba but
        //      they can't carry PRIME marketing claims when they hit 3.7
        //      PA on average and miss the cycle entirely in tight games.
        const candidateSlot = parseInt(candidate.battingOrder) || 0;
        const candidateExpectedPa = (candidateSlot >= 1 && candidateSlot <= 9)
          ? expectedPaForLineupSlot(candidateSlot)
          : 4.0;
        candidate._expectedPa = candidateExpectedPa;
        candidate._paDisadvantaged = candidateExpectedPa < 4.0;
        candidate._bottomOfOrder = candidateSlot >= 7;
        if (candidateQualifies && !failedGapReject) {
          candidate.isTopPick = true;

          // (Phase 2 — May 29, 2026) Classify for PRIME tier eligibility.
          // The fade engine result is stashed on the candidate by the
          // render-time applyFadeOverrides() pass; until that runs we
          // pass null and rely on classifyPrimeTier's defensive default.
          const primeResult = classifyPrimeTier(candidate, candidate._fadeResult);
          candidate.isPrimeEligible = primeResult.isPrime;
          candidate.primeScore = primeResult.score;
          candidate.primeRejectReason = primeResult.rejectReason;
          // isPrime stays false here; final per-game and per-slate cap
          // is applied later (per-game in this analyze.js, per-slate at render).

          const baseReasons = buildTopPickReasons(candidate);
          // Inning-based reasoning layer (only if inningSplits loaded)
          const abTiming = inningSplits ? estimateAtBatTiming(candidate.battingOrder, inningSplits) : null;
          if (abTiming && abTiming.alignsWithMeltdown) {
            const mAb = abTiming.meltdownAb;
            baseReasons.push(`🎯 AB ${mAb.ab} aligns with ${ordinal(inningSplits.meltdownInning)}-inning meltdown (pitcher xwOBA ${inningSplits.meltdownXw?.toFixed(3)})`);
          } else if (abTiming && abTiming.bestAb) {
            const bAb = abTiming.bestAb;
            baseReasons.push(`Best window: AB ${bAb.ab} in inning ${bAb.inning} (pitcher xwOBA ${bAb.xwobaAgainst?.toFixed(3)})`);
          }
          if (inningSplits?.controlTier === 'wild' || inningSplits?.controlTier === 'below-average') {
            baseReasons.push(`Pitcher has ${inningSplits.controlTier} control — walk props viable`);
          }

          // (Phase 1 — May 29, 2026) Removed FULL_GAME comparison. The
          // bullpenTier assignment block only produces 'elite' / 'strong' /
          // 'solid' / null — 'FULL_GAME' was never assigned, so the prior
          // unit-sizing logic was dead and always fell through to 0.5u.
          // Units now driven by primary tier only.
          let propUnits = 0.5;
          if (candidate.tier === 'elite') propUnits = 2;
          else if (candidate.tier === 'strong') propUnits = 1;
          else propUnits = 0.5;

          topPick = {
            hitterId: candidate.hitterId,
            hitter: candidate.hitter,
            hand: candidate.hand,
            tier: candidate.tier,
            adjustedMaxXwoba: candidate.adjustedMaxXwoba,
            bullpenTier: candidate.bullpenTier,
            bestProp: (candidate.propRecs || []).find(p => p.isBest) || null,
            reasons: baseReasons,
            abTiming,
            units: propUnits,
            source: deepMode ? 'deep' : 'fast',
            verified: deepMode,
            scoreValue: candidate._topPickScore
          };
        }
      }

      // Put tiered back into original sort order (by adjustedEdgeScore), preserving isTopPick flag
      const finalTiered = tiered.map(h => {
        const flagged = withTopPickScore.find(f => f.hitterId === h.hitterId);
        return flagged ? { ...h, isTopPick: !!flagged.isTopPick } : h;
      });

      // Aggregate pitcher-vs-lineup tier
      const lineupTier = computeLineupTier(analyzed, arsenal);

      // DEEP MODE: lineup-level RISP "Conversion Tier" — counts batters by RISP signal class.
      // Surfaced alongside the arsenal-based lineup tier. Tells the user how many batters
      // in this lineup are above-average RISP performers (clutch hitters who drive runs in)
      // vs. below-average (strand runners). Useful as a secondary lineup quality signal.
      const lineupConversionTier = deepMode
        ? buildLineupConversionTier(rispMap, topHitters)
        : null;

      // Pitcher inning narrative — rich analysis of control, meltdown pattern, shutdown inning
      const pitcherNarrative = inningSplits ? buildPitcherInningNarrative(inningSplits, s.pitcher) : null;

      // Per-AB prop timing: map each hitter (batting order slot) to their likely PA innings
      // and flag which AB aligns with pitcher's meltdown inning
      if (inningSplits) {
        finalTiered.forEach(h => {
          const abTiming = estimateAtBatTiming(h.battingOrder, inningSplits);
          if (abTiming) h.abTiming = abTiming;
        });
      }

      // Situational splits — only in deep mode, only for ELITE+STRONG hitters (rate-limit awareness).
      // Tries current season first, falls back to prior season if <30 PA.
      if (deepMode) {
        const qualifyingHitters = finalTiered.filter(h => h.tier === 'elite' || h.tier === 'strong');
        if (qualifyingHitters.length > 0) {
          const currentYear = new Date().getFullYear();
          const situationalResults = await Promise.allSettled(
            qualifyingHitters.map(async h => {
              let splits = await getHitterSituationalByMlbam(h.hitterId, currentYear);
              if (!splits || (splits.overall?.PA || 0) < 30) {
                const priorSplits = await getHitterSituationalByMlbam(h.hitterId, currentYear - 1);
                if (priorSplits && (priorSplits.overall?.PA || 0) >= 30) splits = priorSplits;
              }
              return { hitterId: h.hitterId, splits };
            })
          );
          const situationalMap = new Map();
          for (const r of situationalResults) {
            if (r.status === 'fulfilled' && r.value?.splits) {
              situationalMap.set(r.value.hitterId, r.value.splits);
            }
          }
          finalTiered.forEach(h => {
            const sp = situationalMap.get(h.hitterId);
            if (sp?.signals) {
              h.situational = {
                season: sp.season,
                overallPA: sp.overall?.PA,
                overallOPS: sp.overall?.OPS,
                signals: sp.signals
              };
              // Apply situational boosts to prop recommendations
              applySituationalPropBoosts(h, sp.signals, inningSplits);
            }
          });
        }
      }

      // ===== PROBABILITY ESTIMATION =====
      // Attach a hit-probability to every prop rec, and a best-prop summary on the hitter.
      const probCtx = {
        parkFactor,
        weatherImpact: results.weatherImpact,
        umpire: results.umpire,
        pitcherRole
      };
      finalTiered.forEach(h => {
        // Attach RISP data to the hitter (deep mode only — rispMap is empty otherwise)
        // This is exposed in the API response so the UI can render a RISP chip on each card
        if (rispMap[h.id]) {
          h.risp = rispMap[h.id];
        }

        if (!h.propRecs) return;
        h.propRecs.forEach(p => {
          const propKey = p.key;
          // Map UD/PP fantasy score props to their closest underlying (HRR proxy)
          const modelKey = ['H','HR','TB','RBI','R','HRR'].includes(propKey) ? propKey
            : (propKey.startsWith('PP_FS') || propKey.startsWith('UD_FS')) ? 'HRR'
            : null;
          if (!modelKey) return;
          const prob = estimatePropProbability(h, modelKey, probCtx);
          if (prob) {
            p.probability = prob.probability;
            p.probabilityBaseline = prob.baseline;
            p.probabilityModifiers = prob.modifiers;

            // DEEP MODE: apply RISP adjustment to RBI / H+R+RBI / R props
            // Capped at ±15% per the RISP_INFLUENCE_CAP constant in batterRisp.js
            // Only adjusts when sample is meaningful (signal !== 'insufficient')
            if (deepMode && h.risp) {
              const labelForRisp = p.label || propKey;
              const rispAdj = applyRispAdjustment(p.probability, h.risp, labelForRisp);
              if (rispAdj.applied) {
                p.probabilityPreRisp = p.probability;
                p.probability = rispAdj.adjustedProb;
                p.rispAdjustment = rispAdj.adjustment;
                p.rispSignal = rispAdj.signal;
                // Add a modifier entry so the audit trail shows the RISP adjustment
                if (!p.probabilityModifiers) p.probabilityModifiers = [];
                p.probabilityModifiers.push({
                  source: 'risp',
                  effect: rispAdj.adjustment,
                  detail: rispAdj.detail
                });
              }
            }
          }
        });
        // Also attach best prop's probability at hitter level for top-pick display
        const bestP = h.propRecs.find(p => p.isBest);
        if (bestP?.probability != null) {
          h.bestPropProbability = bestP.probability;
        }
      });

      // Update top pick object with probability if present
      if (topPick && topPick.bestProp?.probability != null) {
        topPick.probability = topPick.bestProp.probability;
      }

      // ===== PITCHER PROPS =====
      // Uses the pitcher data already gathered — arsenal + inning splits + role + opposing lineup tier.
      // In deep mode, also passes the lineup's per-pitch-type K rates so the K projection
      // can be built from actual lineup-vs-arsenal vulnerability rather than a flat K%.
      const pitcherProps = buildPitcherProps(s.pitcher, {
        role: pitcherRole,
        inningSplits,
        arsenal,
        lineupTier,
        parkFactor,
        weatherImpact: results.weatherImpact,
        umpire: results.umpire,
        // DEEP MODE: pass lineup with per-pitch deep data for sharp K projection
        opposingLineup: deepMode ? hitterData : null,
        // PITCHER NOVELTY: career stats for rookie/callup K boost
        careerStats
      });
      // ====================================================================
      // ARCHETYPE -> STRIKEOUT PROJECTION (LIVE — user's call). A whiff-ace with
      // above-avg velo misses more bats -> nudge the K projection OVER; a
      // contact-buffet / soft-velo arm -> nudge UNDER. CONSERVATIVE +/-8% cap so
      // it adjusts, never dominates, the arsenal-vs-lineup K engine that already
      // ran inside buildPitcherProps (avoids double-counting the same whiff).
      // Uses the Tier-2 pitch velo now on `arsenal` (data.js). UNVALIDATED
      // magnitude — stamped (_archetypeK) on projection.ks + the ks rec so the
      // DK-line grading pass can validate it and reweight/pull. Deploy after
      // data.js+savant.js (needs velo). Falls back to whiff-only if velo absent.
      // ====================================================================
      try {
        const _LG_VELO = { FF:93.9,FA:93.9,SI:93.3,FT:93.3,FC:89.0,SL:85.0,ST:82.0,SV:83.5,CU:79.5,KC:81.5,CS:74.0,CH:85.5,FS:85.5,FO:84.5,SC:86.0,KN:76.0 };
        let _wSum=0,_whiffNum=0,_whiffW=0,_veloNum=0,_veloW=0;
        for (const _p of (arsenal || [])) {
          const _u = parseFloat(_p.usage); const _w = Number.isFinite(_u) ? _u : 1; _wSum += _w;
          const _wh = parseFloat(_p.whiffPct); if (Number.isFinite(_wh)) { _whiffNum += _wh*_w; _whiffW += _w; }
          const _v = parseFloat(_p.velo); const _b = _LG_VELO[String(_p.typeCode||'').toUpperCase()];
          if (Number.isFinite(_v) && Number.isFinite(_b)) { _veloNum += (_v-_b)*_w; _veloW += _w; }
        }
        const _wWhiff = _whiffW>0 ? _whiffNum/_whiffW : null;
        const _veloDelta = _veloW>0 ? +(_veloNum/_veloW).toFixed(1) : null;
        if (_wWhiff != null && pitcherProps) {
          // FULLY IMPLEMENTED (2026-07-28): whiff is the direct K driver, velo the
          // secondary stuff signal (Tier-2 data). Widened from the initial +/-8%
          // nudge to a first-class +/-12% component after the 7/28 slate validated
          // the direction (Lugo 2K under, Nola 4K under, Williams 12K over). The
          // opposing lineup's K-resistance is the CO-driver and already lives in
          // buildPitcherProps' lineup-vs-arsenal number; this is the pitcher-stuff
          // overlay on top. Stamped + easy to retune from the grading log.
          const _whiffDelta = _wWhiff - 24.5;
          const _stuff = _whiffDelta + (_veloDelta != null ? _veloDelta*0.6 : 0);
          const _kFactor = Math.min(1.12, Math.max(0.88, +(1 + _whiffDelta*0.012 + (_veloDelta != null ? _veloDelta*0.007 : 0)).toFixed(3)));
          if (_kFactor !== 1) {
            const _stamp = { factor:_kFactor, stuffScore:+_stuff.toFixed(1), wWhiff:+_wWhiff.toFixed(1), veloDelta:_veloDelta, live:true, unvalidated:true };
            if (pitcherProps.projection && Number.isFinite(parseFloat(pitcherProps.projection.ks))) {
              _stamp.ksBefore = +parseFloat(pitcherProps.projection.ks).toFixed(2);
              pitcherProps.projection.ks = +(parseFloat(pitcherProps.projection.ks) * _kFactor).toFixed(2);
              _stamp.ksAfter = pitcherProps.projection.ks;
            }
            for (const _rec of (pitcherProps.recommendations || [])) {
              if (_rec.type === 'strikeouts' && Number.isFinite(parseFloat(_rec.projection))) {
                _rec.projection = +(parseFloat(_rec.projection) * _kFactor).toFixed(2);
                _rec._archetypeK = _stamp;
              }
            }
            pitcherProps._archetypeK = _stamp;
          }
        }
      } catch (_) {}

      // RECENT-FORM PITCHER OVERLAY (2026-08-07, window 5 starts): the archetype/K read
      // above is driven entirely by SEASON arsenal + career novelty — it is blind to a
      // pitcher who has been declining his last several starts, which is exactly why
      // season-strong "under/suppress" reads busted on slumping arms. Symmetric to the
      // hitter formMultiplier: fold the last-5-starts K/9 trend into the K projection
      // (30% weight, +/-12% cap) and stamp a shelled/surging signal the client uses to
      // demote suppression/UNDER reads. A 5-start window smooths one-off blowups so the
      // read tracks a genuine trend, not a single rough night. recentStarts is fetched
      // above (display) — now it also drives the read. Requires >=3 starts to fire.
      try {
        const _rs = Array.isArray(recentStarts) ? recentStarts.filter(g => g && parseFloat(g.ip) > 0) : [];
        if (_rs.length >= 3 && pitcherProps) {
          const _ip = _rs.reduce((a, g) => a + parseFloat(g.ip), 0);
          const _k  = _rs.reduce((a, g) => a + (g.k  || 0), 0);
          const _er = _rs.reduce((a, g) => a + (g.er || 0), 0);
          const _h  = _rs.reduce((a, g) => a + (g.hits || 0), 0);
          const recentK9  = _ip > 0 ? +(9 * _k  / _ip).toFixed(2) : null;
          const recentEra = _ip > 0 ? +(9 * _er / _ip).toFixed(2) : null;
          const recentH9  = _ip > 0 ? +(9 * _h  / _ip).toFixed(2) : null;
          const shelled = (recentEra != null && recentEra >= 5.5) || (recentH9 != null && recentH9 >= 11);
          const surging = (recentK9 != null && recentK9 >= 10.5) && (recentEra == null || recentEra <= 3.5);
          let _rkFactor = 1;
          if (recentK9 != null) _rkFactor = Math.min(1.12, Math.max(0.88, +(1 + 0.30 * (recentK9 / 8.5 - 1)).toFixed(3)));
          const _rfStamp = { recentK9, recentEra, recentH9, shelled, surging, factor: _rkFactor, starts: _rs.length, live: true, unvalidated: true };
          if (_rkFactor !== 1 && pitcherProps.projection && Number.isFinite(parseFloat(pitcherProps.projection.ks))) {
            _rfStamp.ksBefore = +parseFloat(pitcherProps.projection.ks).toFixed(2);
            pitcherProps.projection.ks = +(parseFloat(pitcherProps.projection.ks) * _rkFactor).toFixed(2);
            _rfStamp.ksAfter = pitcherProps.projection.ks;
            for (const _rec of (pitcherProps.recommendations || [])) {
              if (_rec.type === 'strikeouts' && Number.isFinite(parseFloat(_rec.projection))) {
                _rec.projection = +(parseFloat(_rec.projection) * _rkFactor).toFixed(2);
                _rec._recentFormK = _rfStamp;
              }
            }
          }
          pitcherProps._recentForm = _rfStamp;
        }
      } catch (_) {}

      // Top 3 HR projections regardless of tier — used for diagnostic display so
      // the user can see what the model is *almost* badging. Pulls from the same
      // empirical computation that gates the actual badge — never affects the badge.
      const hrAuditTop = analyzed
        .filter(h => h.hrAudit && h.hrAudit.projectedHrPerPa != null)
        .map(h => ({
          name: h.hitter,
          hand: h.hand,
          projectedHrPerPa: h.hrAudit.projectedHrPerPa,
          tier: h.hrAudit.tier,  // may be null when below SOLID
          tierLabel: h.hrAudit.tierLabel,
          multiplier: h.hrAudit.multiplier,
          drivers: h.hrAudit.drivers || [],
          confidence: h.hrAudit.confidence,
          sampleWarning: h.hrAudit.sampleWarning,
          // Pass through the diagnostic trace so the frontend can console-log
          // every input + multiplier per audit row. Lets us identify which
          // factor is breaking the projection without guessing.
          _debug: h.hrAudit._debug || null
        }))
        .sort((a, b) => b.projectedHrPerPa - a.projectedHrPerPa)
        .slice(0, 3);

      return {
        key: s.key,
        data: {
          pitcher: s.pitcher,
          pitcherArsenal: arsenal,
          pitcherSplits,
          pitcherHomeRoadSplits: homeRoadSplits,
          pitcherRecentStarts: recentStarts,
          pitcherCareerStats: careerStats,  // PITCHER NOVELTY: surfaces rookie/callup status
          pitcherVsTeam: vsTeamHistory,  // PITCHER-VS-TEAM: "owns this lineup" history (July 2026)
          inningSplits,
          pitcherNarrative,
          pitcherRole,
          pitcherProps,
          bullpen: {
            pitches: keyBullpenPitches,
            pitcherCount: bullpen.pitcherCount || 0,
            totalPitches: bullpen.totalPitches || 0
          },
          mismatches: finalTiered,
          topPick,
          lineupTier,
          lineupConversionTier,
          // (Drop #4 — May 30, 2026) Lineup confirmation status.
          // Surfaces in UI as confirmation chip ("✓ LINEUPS CONFIRMED" green
          // when team has posted official batting order, "⚠ LINEUP PROJECTED"
          // yellow when we fell back to active roster, no official lineup yet).
          // Solves the Murakami-class failure at the user-decision layer:
          // user sees the chip and knows whether to manually verify before
          // locking entries.
          lineupMeta: (lineup && lineup._lineupMeta) ? {
            source: lineup._lineupMeta.source,
            fetchedAt: lineup._lineupMeta.fetchedAt,
            phantom: lineup._lineupMeta.phantom || null,
            gameTime: game.gameTime || null,
            gameStatus: game.status || null
          } : null,
          hrAuditTop  // top 3 HR audit projections, regardless of tier
        }
      };
    }));

    sideResults.forEach(r => { if (r) results[r.key] = r.data; });

    // =========================================================
    // LINEUP SUPPORT FACTOR + HITS PREFERENCE (Phase 2 — May 29, 2026)
    //
    // Per-hitter lineup support: closes the HRR orphan-hit gap by
    // factoring in batting-order slot, team R/G, OBP of hitters
    // ahead, and quality of hitters behind. All inputs already
    // loaded — this is pure wiring, no new fetches.
    //
    // HITS-over-HRR preference: when the unassisted engine selects
    // HRR and HITS is within 10 prob points, prefer HITS. May 29
    // audit showed same hitter pool went 58% HITS vs 42% HRR.
    //
    // Both passes mutate the mismatch objects in place. Run BEFORE
    // the lineupSignalAggregator (line ~1475) which reads matchups
    // — but the aggregator only reads xwoba/tier fields, not props,
    // so order is safe.
    // =========================================================
    try {
      const sides = [
        { key: 'awayVsHome', ecoSide: 'away' },
        { key: 'homeVsAway', ecoSide: 'home' }
      ];
      for (const sideSpec of sides) {
        const sideData = results[sideSpec.key];
        if (!sideData?.mismatches) continue;
        const eco = ecosystems?.[sideSpec.ecoSide];
        const allHitters = sideData.mismatches;

        for (const m of allHitters) {
          // Compute support factor
          const support = computeLineupSupportFactor(m, {
            teamEcosystem: eco,
            allHitters
          });
          m.lineupSupport = support;

          // Apply to compound prop probabilities (per-PA contact stays raw).
          // The factor is applied differently per prop type — see
          // applyLineupSupportToProb in lineupSupport.js.
          if (m.propRecs) {
            for (const prop of m.propRecs) {
              if (prop.probability && prop.key) {
                const rawProb = prop.probability;
                const adjustedProb = applyLineupSupportToProb(rawProb, support, prop.key);
                prop.rawProbability = rawProb;
                prop.probability = +adjustedProb.toFixed(3);
                prop.lineupSupportAdjustment = +(adjustedProb - rawProb).toFixed(3);
              }
            }

            // HITS-over-HRR preference: if unassisted picked HRR, check HITS.
            // (Drop #3 — May 30, 2026) HITS-over-HRR preference DISABLED.
            // User constraint: HRR must remain a primary prop because not all
            // betting platforms offer standalone HITS. May 30 data analysis
            // showed L-HRR's 36% WR was NOT a prop-type problem — it was a
            // gap/ctx/regressed-xwoba bucketing problem. With the new hard
            // gap reject (Drop #3 Fix #2) and tightened PRIME range (Fix #1),
            // HRR + good buckets hits 68% (SWEET, n=19) — same level as HITS.
            // applyHitsOverHrrPreference(m.propRecs);
          }
        }
      }
    } catch (err) {
      console.warn('[analyze] lineup support / HITS preference pass failed:', err.message);
      // Non-fatal — continue without these adjustments
    }

    // ===== PITCHER PROP LINES (DraftKings via The Odds API) =====
    // Resolve the lines fetch and grade each side's pitcher projection against the line.
    // Adds .lineGrade to the K and Outs prop rows when a matching DK line is found.
    // Falls back gracefully when no key is configured, the fetch failed, or the pitcher's
    // line isn't published (openers, late call-ups, etc.). User can still enter manually.
    try {
      const { gradeProjectionVsLine } = await import('./_lib/pitcherPropsLines.js');
      const pitcherPropsLines = await propsLinesPromise;
      if (pitcherPropsLines) {
        for (const r of sideResults) {
          if (!r?.data?.pitcherProps?.recommendations) continue;
          const pitcherName = r.data.pitcher?.name || r.data.pitcher?.fullName;
          if (!pitcherName) continue;

          const pitcherLines = getPitcherLinesByName(pitcherPropsLines, pitcherName);
          if (!pitcherLines) continue;

          // Attach the matched lines block to the pitcher props for UI display
          r.data.pitcherProps.bookLines = {
            book: 'DraftKings',
            ks: pitcherLines.ks || null,
            outs: pitcherLines.outs || null,
            matchedName: pitcherLines.rawName || pitcherName
          };

          // Grade each prop recommendation that has a matching line
          const projection = r.data.pitcherProps.projection || {};
          for (const rec of r.data.pitcherProps.recommendations) {
            const isKsRow = rec.type === 'strikeouts';
            const isOutsRow = rec.type === 'outs';

            if (isKsRow && pitcherLines.ks) {
              const grade = gradeProjectionVsLine(projection.ks, pitcherLines.ks, 'ks');
              if (grade) {
                rec.lineGrade = grade;
                rec.book = 'DraftKings';
              }
            } else if (isOutsRow && pitcherLines.outs) {
              const grade = gradeProjectionVsLine(projection.outs, pitcherLines.outs, 'outs');
              if (grade) {
                rec.lineGrade = grade;
                rec.book = 'DraftKings';
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[analyze] Pitcher props line grading failed:', err.message);
      // Non-fatal — analysis continues with projection-only props
    }

    // ===== ONE TOP PICK PER GAME =====
    // Keep only the higher-scoring top pick across both sides; null out the other.
    // Tiebreakers (stable, deterministic): scoreValue desc → FULL_GAME bullpen edge →
    // deep-mode verified → higher adj xwOBA → alphabetical hitter name.
    {
      const a = results.awayVsHome?.topPick || null;
      const h = results.homeVsAway?.topPick || null;
      if (a && h) {
        const cmp = (x, y) => {
          if ((y.scoreValue || 0) !== (x.scoreValue || 0)) return (y.scoreValue || 0) - (x.scoreValue || 0);
          const xFull = x.bullpenTier === 'FULL_GAME' ? 1 : 0;
          const yFull = y.bullpenTier === 'FULL_GAME' ? 1 : 0;
          if (xFull !== yFull) return yFull - xFull;
          const xDeep = x.verified ? 1 : 0;
          const yDeep = y.verified ? 1 : 0;
          if (xDeep !== yDeep) return yDeep - xDeep;
          if ((y.adjustedMaxXwoba || 0) !== (x.adjustedMaxXwoba || 0)) return (y.adjustedMaxXwoba || 0) - (x.adjustedMaxXwoba || 0);
          return (x.hitter || '').localeCompare(y.hitter || '');
        };
        // Negative result means away wins (a should stay), positive means home wins
        const winnerIsAway = cmp(a, h) <= 0;
        const losingSide = winnerIsAway ? results.homeVsAway : results.awayVsHome;
        // Null the losing side's topPick AND clear the corresponding mismatch's isTopPick flag
        if (losingSide?.topPick && Array.isArray(losingSide.mismatches)) {
          const losingId = losingSide.topPick.hitterId;
          for (const m of losingSide.mismatches) {
            if (m.hitterId === losingId) m.isTopPick = false;
          }
        }
        losingSide.topPick = null;
      }
    }

    // ========================================================
    // LINEUP SIGNAL AGGREGATION (May 25, 2026 — Connections 1-3)
    //
    // Reads the per-hitter unassisted tier, fragility, and inflation data
    // from each side's mismatches list, aggregates into top-of-order and
    // full-lineup signals, then derives multipliers for:
    //
    //   - YRFI scoring probability   (top-of-order strength)
    //   - Game total                  (full-lineup robustness/fragility)
    //   - Arsenal vulnerability       (concentrated regressed advantage)
    //
    // Default ON per LINEUP_SIGNAL_AGGREGATION_ENABLED. When false, every
    // computed multiplier returns 1.0 and behavior reverts to legacy. All
    // multipliers are conservatively bounded (YRFI [0.85,1.20], game total
    // [0.90,1.10], arsenal [0.92,1.10]).
    //
    // The audit data is surfaced on results.lineupSignalAudit for both
    // network-tab inspection and (via the client) console diagnostics.
    // ========================================================
    let lineupSignalAudit = null;
    let awayYrfiSignal = null, homeYrfiSignal = null;
    let awayGameTotalSignal = null, homeGameTotalSignal = null;
    let awayArsenalSignal = null, homeArsenalSignal = null;

    if (LINEUP_SIGNAL_AGGREGATION_ENABLED) {
      try {
        const awayAggregated = aggregateLineupSignals(results.awayVsHome?.mismatches || []);
        const homeAggregated = aggregateLineupSignals(results.homeVsAway?.mismatches || []);

        // YRFI signals: away top-of-order vs home pitcher → applies to awayScoresProb
        awayYrfiSignal = computeYrfiTopOfOrderBoost(awayAggregated);
        homeYrfiSignal = computeYrfiTopOfOrderBoost(homeAggregated);

        // Game total signals: full lineup adjustments
        awayGameTotalSignal = computeGameTotalLineupAdjustment(awayAggregated);
        homeGameTotalSignal = computeGameTotalLineupAdjustment(homeAggregated);

        // Arsenal vulnerability: pass weighted pitcher xwOBA when available
        // (the side facing the pitcher is what we score)
        const homePitcherXw = inferPitcherWeightedXw(results.awayVsHome);
        const awayPitcherXw = inferPitcherWeightedXw(results.homeVsAway);
        awayArsenalSignal = computeArsenalVulnerability(
          results.awayVsHome?.mismatches || [],
          homePitcherXw
        );
        homeArsenalSignal = computeArsenalVulnerability(
          results.homeVsAway?.mismatches || [],
          awayPitcherXw
        );

        lineupSignalAudit = {
          enabled: true,
          away: {
            aggregated: awayAggregated.audit,
            yrfi: awayYrfiSignal,
            gameTotal: awayGameTotalSignal,
            arsenal: awayArsenalSignal
          },
          home: {
            aggregated: homeAggregated.audit,
            yrfi: homeYrfiSignal,
            gameTotal: homeGameTotalSignal,
            arsenal: homeArsenalSignal
          }
        };
      } catch (err) {
        console.warn('[lineupSignalAggregator] failed:', err.message);
        lineupSignalAudit = { enabled: true, error: err.message };
      }
    } else {
      lineupSignalAudit = { enabled: false };
    }
    results.lineupSignalAudit = lineupSignalAudit;

    // ===== FIRST-INNING SCORING PROJECTION =====
    // YRFI/NRFI uses 1st-inning xwOBA-against from inning splits + lineup tier + park/weather/ump context.
    // PLUS (May 25, 2026): top-of-order strength signals AND arsenal vulnerability
    // signals from lineupSignalAggregator. The arsenal signal closes a pitcher-
    // analysis asymmetry — previously YRFI had per-hitter lineup intelligence but
    // treated the opposing pitcher as a single aggregate xwOBA-against number.
    results.firstInning = computeFirstInningProbability(
      results.awayVsHome,
      results.homeVsAway,
      {
        parkFactor,
        weatherImpact: results.weatherImpact,
        umpire: results.umpire,
        awayLineupSignal: awayYrfiSignal,
        homeLineupSignal: homeYrfiSignal,
        awayArsenalSignal,
        homeArsenalSignal
      }
    );

    // ===== GAME-LEVEL PROJECTION =====
    // Use aggregated side data + context to project runs and win probability
    const gameDate = game.gameDateET || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const oddsPromise = getGameOdds(
      game.awayTeam.abbreviation,
      game.homeTeam.abbreviation,
      gameDate
    ).catch(() => null);

    // Fetch team-level RISP / stranded-runner conversion rates in parallel with odds.
    // These adjust the projected total based on each team's season-long efficiency at
    // converting scoring opportunities into actual runs.
    const conversionPromise = getMatchupConversionRates(
      game.awayTeam.id,
      game.homeTeam.id
    ).catch(() => ({ away: null, home: null }));

    const [odds, conversionRates] = await Promise.all([oddsPromise, conversionPromise]);

    const projection = buildGameProjection({
      awayVsHome: results.awayVsHome,  // away hitters vs home pitcher
      homeVsAway: results.homeVsAway,  // home hitters vs away pitcher
      parkFactor,
      homeTeamAbbr: game.homeTeam?.abbreviation || null,  // for altitude engine park lookup
      umpire: results.umpire,
      weatherImpact: results.weatherImpact,
      rawWeather: results.weather,      // raw weather for altitude engine (humidity not on weatherImpact)
      envImpact: results.envImpact,    // NEW: composite park×weather with interactions
      conversionRates,                  // NEW: stranded-runner / RISP signal
      odds,
      // NEW (May 25, 2026): lineup-aggregator multipliers
      // awayGameTotalSignal/awayArsenalSignal apply to the AWAY side's run
      // production. homeGameTotalSignal/homeArsenalSignal apply to home.
      awayGameTotalSignal,
      homeGameTotalSignal,
      awayArsenalSignal,
      homeArsenalSignal
    });
    results.projection = projection;
    results.odds = odds;
    results.conversionRates = conversionRates;

    // (Drop #7 — June 3, 2026) PROJECTION-STRATEGY GATE.
    //
    // Replaces Drop #5 Fix #2 (NRFI-only tier downgrade for low totals).
    //
    // June 3 deep audit (n=133 FI bets, n=49 with extreme projections) found
    // that the model's CALIBRATED PROBABILITY has zero predictive power:
    //   prob 0.45-0.50: 47% WR (n=64)
    //   prob 0.50-0.55: 44% WR (n=19)
    //   prob 0.55-0.60: 33% WR (n=9)
    //   prob 0.60-0.70: 47% WR (n=34)
    //   prob 0.70+:     43% WR (n=7)
    //   Conclusion: probability and outcome are uncorrelated.
    //
    // BUT projection magnitude IS strongly predictive at the extremes:
    //   projTotal ≤6.0, YRFI bet: 9-1 (90%) on n=10
    //   projTotal ≥9.5, NRFI bet: 21-13 (62%) on n=34
    //   projTotal 6.0-9.5 middle: 41% WR on n=89 (no edge)
    //   Combined extreme strategy: 30-14 (68%) on n=44, +20u profit at -110
    //
    // STRATEGY (STRONG-only, MODERATE tier dropped after backtest showed
    // 40%/33% WR — not edge):
    //   projTotal ≤6.0 → YRFI STRONG (1.5u)
    //   projTotal ≥9.5 → NRFI STRONG (1.5u)
    //   projTotal 6.0-9.5 → PASS
    //
    // OVERRIDES the model's probability-based pick. Model's pre-strategy
    // state preserved on _originalSide/_originalTier/_originalProb for
    // diagnostic auditing.
    if (results.firstInning?.recommendation && projection) {
      const fi = results.firstInning.recommendation;
      const projTotal = parseFloat(projection.projTotal) || 0;

      // Preserve original recommendation for diagnostics
      const _originalSide = fi.side;
      const _originalTier = fi.tier;
      const _originalUnits = fi.units;
      const _originalProb = fi.probability;

      // STRONG-only — MODERATE tier removed after backtest showed 40%/33%
      let newSide = null, newTier = 'PASS', newUnits = 0, strategyReason = null;
      if (projTotal > 0 && projTotal <= 6.0) {
        newSide = 'YRFI';
        newTier = 'STRONG';
        newUnits = 1.5;
        strategyReason = `Extreme low projection (${projTotal.toFixed(2)} ≤ 6.0): backtest 10-1 (91% WR, n=11)`;
      } else if (projTotal >= 9.5) {
        // (Drop #10 — June 5, 2026) NRFI GATE TIGHTENED to 0.60.
        //
        // Drop #7 hotfix (June 3) introduced 0.65 cap → 17-9 (65%) on n=26.
        // Fresh n=140 audit (June 5) shows the 0.60-0.65 sub-bucket hits only
        // 56% (5-4) — barely break-even at -110. Tightening to 0.60 cap:
        //
        //   ≤ 0.65 (previous): 18-9 (67%) on n=27, +11.1u
        //   ≤ 0.60 (new):      13-5 (72%) on n=18, +10.2u  ← STABLE: T1 67%, T2 67%, T3 83%
        //   ≤ 0.55:            13-5 (72%) on n=18 — same picks, same outcomes
        //
        // The 0.60 cap excludes 9 marginal picks that went 5-4 (56%) and
        // matched the toxic borderline zone where June 4's BAL@BOS parlay
        // got buried. Stable across all three time thirds in backtest.
        const modelYrfiProb = _originalSide === 'YRFI' ? _originalProb : (1 - (_originalProb || 0));
        if (modelYrfiProb && modelYrfiProb > 0.60) {
          strategyReason = `High projection (${projTotal.toFixed(2)} ≥ 9.5) but model YRFI conviction too strong (${(modelYrfiProb*100).toFixed(0)}% > 60% gate). NRFI strategy 5-4 (56%) in this bucket — PASS.`;
        } else {
          newSide = 'NRFI';
          newTier = 'STRONG';
          newUnits = 1.5;
          strategyReason = `Extreme high projection (${projTotal.toFixed(2)} ≥ 9.5) + model YRFI ≤ 60% gate: backtest 13-5 (72% WR, n=18)`;
        }
      } else {
        strategyReason = projTotal > 0
          ? `Middle projection (${projTotal.toFixed(2)}): no edge between 6.0-9.5 (backtest 41% WR, n=89)`
          : 'No projection available';
      }

      // Apply the new recommendation
      fi._originalSide = _originalSide;
      fi._originalTier = _originalTier;
      fi._originalUnits = _originalUnits;
      fi._originalProb = _originalProb;
      fi._strategyReason = strategyReason;
      fi._projTotal = projTotal;

      fi.side = newSide;
      fi.pick = newSide;
      fi.tier = newTier;
      fi.units = newUnits;

      // Probability display logic.
      //
      // (Drop #7 hotfix — June 3, 2026) Original code set probability=null when
      // strategy overrode model direction, which the UI rendered as "0.0%" —
      // showing "NRFI STRONG 0.0%" next to "YRFI 65%" looks broken and erodes
      // trust. Replace with the EMPIRICAL backtest WR so the user sees what
      // the historical data actually says about this strategy.
      //
      // YRFI STRONG (proj ≤ 6.0): 9-1 (90%) on n=10 → display 0.90
      // NRFI STRONG (proj ≥ 9.5 + gate): 17-9 (65%) on n=26 → display 0.65
      // When strategy and model AGREE on direction, preserve model prob.
      if (newSide && _originalSide === newSide && _originalProb) {
        // Strategy agrees with model — use model's probability
        fi.probability = _originalProb;
        fi._directionMatch = true;
        fi._probabilitySource = 'model';
      } else if (newSide && _originalSide && _originalSide !== newSide) {
        // Strategy overrides model — use backtest WR for honest display
        // YRFI STRONG: 91% (10-1) on n=11. NRFI STRONG (≤0.60 gate): 72% (13-5) on n=18.
        fi.probability = newSide === 'YRFI' ? 0.91 : 0.72;
        fi._directionMatch = false;
        fi._probabilitySource = 'backtest';
        fi._strategyReason += ` (overrides model's ${_originalSide} call at ${((_originalSide==='YRFI' ? _originalProb : 1-_originalProb)*100).toFixed(0)}%)`;
      } else if (newSide) {
        // Strategy fires but model had no rec — use backtest WR
        fi.probability = newSide === 'YRFI' ? 0.91 : 0.72;
        fi._directionMatch = null;
        fi._probabilitySource = 'backtest';
      } else {
        // Strategy passed — keep model's original prob for diagnostics, UI hides it
        fi.probability = null;
        fi._directionMatch = null;
        fi._probabilitySource = null;
      }
    }

    // Game-line bet recommendations (ML/Spread/Total) — runs after projection + odds are ready
    results.gameLineBets = buildGameLineRecommendations({
      projection,
      odds,
      teams: { awayTeam: results.awayTeam, homeTeam: results.homeTeam }
    });

    // Attach probabilities to each game-line bet
    if (results.gameLineBets && projection) {
      const gl = results.gameLineBets;
      if (gl.total && projection.projTotal != null && odds?.total != null) {
        const totalProbs = estimateTotalProbability(Number(projection.projTotal), Number(odds.total));
        if (totalProbs && gl.total.side) {
          gl.total.probability = gl.total.side === 'OVER' ? totalProbs.overProb : totalProbs.underProb;
        }
      }
      if (gl.moneyline && gl.moneyline.side) {
        // projection.homeWinProb is stored as a percentage string ("62.5"), divide by 100 for decimal
        const homeWPDecimal = Number(projection.homeWinProb) / 100;
        gl.moneyline.probability = estimateMoneylineProbability(homeWPDecimal, gl.moneyline.side);
        if (gl.moneyline.price != null) {
          gl.moneyline.edge = computeEdge(gl.moneyline.probability, gl.moneyline.price);
        }
      }
      if (gl.spread && gl.spread.side && gl.spread.favored) {
        gl.spread.probability = estimateSpreadProbability(
          Number(projection.projHomeRuns) - Number(projection.projAwayRuns),
          gl.spread.marketLine,
          gl.spread.favored,
          gl.spread.side
        );
      }
      if (gl.overallBest) {
        if (gl.overallBest.type === 'total') gl.overallBest.probability = gl.total?.probability;
        else if (gl.overallBest.type === 'moneyline') gl.overallBest.probability = gl.moneyline?.probability;
        else if (gl.overallBest.type === 'spread') gl.overallBest.probability = gl.spread?.probability;
      }
    }

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');

    // Attach quota + tier info so client can update its UI ("2 of 3 deep analyses today")
    if (quotaInfo) {
      results._quota = {
        deep_analyses: {
          used: quotaInfo.used,
          limit: quotaInfo.limit === Infinity ? null : quotaInfo.limit,
        },
      };
    }
    if (user) {
      results._user = { tier: user.tier, isPro: user.isPro, isSharp: user.isSharp };
    }

    return res.status(200).json(results);
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

// ===== GAME PROJECTION =====
// Build expected runs per team, win probability, and compare to market O/U
function buildGameProjection({ awayVsHome, homeVsAway, parkFactor, homeTeamAbbr, umpire, weatherImpact, rawWeather, envImpact, conversionRates, odds, awayGameTotalSignal, homeGameTotalSignal, awayArsenalSignal, homeArsenalSignal }) {
  // MLB 2024-2025 league avg runs per team per game: ~4.45
  const BASELINE_RUNS = 4.45;

  // ===== AIR DENSITY (May 23, 2026 — altitudeEngine integration) =====
  //
  // Compute the air density once at game level. Both sides' pitchers throw
  // in the same park, so they get the same density adjustment to their
  // arsenals. The xwOBA shifts will differ per pitcher only because their
  // arsenals are made up of different pitch types (4-seam-heavy gets hit
  // harder at Coors than sinker-heavy).
  //
  // Field name sources (verified against weather.js):
  //   - tempF: from weatherImpact (re-exposed by computeWeatherImpact)
  //   - humidity: from rawWeather (NOT exposed by computeWeatherImpact; comes
  //     directly from Open-Meteo as percent 0-100, so we convert to fraction)
  //   - isDome: from weatherImpact (set when dome detected closed)
  //
  // If rawWeather is unavailable (e.g. weather fetch failed), we still get
  // tempF and isDome from weatherImpact and the engine falls back to the
  // park's typical humidity. Humidity is the smallest of the three effects
  // so this graceful degradation is acceptable.
  const wx = weatherImpact || {};
  const rw = rawWeather || {};
  const tempF = typeof wx.tempF === 'number' ? wx.tempF
    : (typeof rw.tempF === 'number' ? rw.tempF : undefined);
  // Humidity comes from raw weather as percent (0-100); convert to fraction
  let humidityFraction = undefined;
  if (typeof rw.humidity === 'number') {
    humidityFraction = rw.humidity > 1.5 ? rw.humidity / 100 : rw.humidity;
  }
  const airDensityResult = computeAirDensity(homeTeamAbbr, {
    temp_f: tempF,
    humidity: humidityFraction,
    isDome: !!wx.isDome,
  });
  const airDensity = airDensityResult.density;
  const airDensityAudit = airDensityResult.audit;

  // Map aggregate side data into multipliers
  const sideMult = (side) => {
    if (!side) return { lineupMult: 1.0, pitcherMult: 1.0, bullpenMult: 1.0, factors: {} };

    const lt = side.lineupTier;
    // Lineup quality: map the average xwOBA-vs-this-arsenal to a run multiplier.
    //
    // PITCHER DUEL FIX: When enabled, regress avgMaxXwoba (best-case per
    // hitter) toward avgWeightedXwoba (expected vs actual pitch distribution).
    // The "max" is what hitters do when they get their pitch; the "weighted"
    // is what they actually average across the pitcher's full arsenal. Pitchers
    // — especially elite ones — control which pitches hitters see, so the
    // weighted is closer to reality. 50/50 blend recognizes neither extreme is
    // quite right.
    //
    // Without the fix, lineupMult could push to 1.22+ on EXPLOITABLE-tier
    // lineups, which combined with weak pitcher suppression produced 12+ run
    // projections on games that ended 4-6 runs.
    const avgMaxXw = parseFloat(lt?.avgMaxXwoba || 0.320);
    const avgWeightedXw = parseFloat(lt?.avgWeightedXwoba || avgMaxXw);
    const effectiveXw = PITCHER_DUEL_FIX_ENABLED && avgWeightedXw > 0
      ? (avgMaxXw * 0.5) + (avgWeightedXw * 0.5)
      : avgMaxXw;
    const lineupMult = 1.0 + ((effectiveXw - 0.320) * 2.4);   // .040 above avg → +9.6%

    // Pitcher quality: use starter's season xwOBA-against (from arsenal weighted avg)
    //
    // ALTITUDE ADJUSTMENT (May 23, 2026 — altitudeEngine integration):
    //   Before computing the weighted xwOBA, adjust each pitch in the arsenal
    //   for the game's air density. A 4-seam-heavy pitcher at Coors gets
    //   significant inflation (~+0.070 xwOBA on the 4-seam); a sinker-heavy
    //   command pitcher gets only modest inflation (~+0.021 on the sinker).
    //   Sea-level parks skip this entirely (no noise).
    let pitcherXwAgainst = null;
    let altitudeAudit = null;
    if (side.pitcherArsenal && side.pitcherArsenal.length > 0) {
      // Apply altitude adjustment to the arsenal first
      const { adjustedArsenal, audit } = adjustPitcherArsenal(side.pitcherArsenal, airDensity);
      altitudeAudit = audit;

      const totalPitches = adjustedArsenal.reduce((s, p) => s + (p.pitches || 0), 0);
      if (totalPitches > 0) {
        const weighted = adjustedArsenal.reduce((s, p) => {
          const x = parseFloat(p.xwoba || 0);
          return s + (x * (p.pitches || 0));
        }, 0);
        pitcherXwAgainst = weighted / totalPitches;
      }
    }
    // Lower xwOBA-against = better pitcher = suppresses runs.
    //
    // PITCHER DUEL FIX: Use the amplified mapping (defined at top of file) that
    // adds non-linear suppression below 0.290 xwOBA. Truly elite SPs (.240-.280)
    // suppress runs much more aggressively than the linear curve suggests.
    const pitcherMult = pitcherXwAgainst
      ? (PITCHER_DUEL_FIX_ENABLED
          ? pitcherMultFromXwAmplified(pitcherXwAgainst)
          : 1.0 + ((pitcherXwAgainst - 0.320) * 2.0))
      : 1.0;

    // Bullpen quality: similar mapping using weighted xwOBA-against across bullpen arsenal
    let bullpenXwAgainst = null;
    if (side.bullpen?.pitches && side.bullpen.pitches.length > 0) {
      const totalBpPitches = side.bullpen.pitches.reduce((s, p) => s + (p.pitches || 0), 0);
      if (totalBpPitches > 0) {
        const weightedBp = side.bullpen.pitches.reduce((s, p) => {
          const x = parseFloat(p.xwoba || 0);
          return s + (x * (p.pitches || 0));
        }, 0);
        bullpenXwAgainst = weightedBp / totalBpPitches;
      }
    }
    // Bullpen only sees ~40% of PAs (late innings), so effect is weaker
    const bullpenMult = bullpenXwAgainst
      ? 1.0 + ((bullpenXwAgainst - 0.320) * 0.8)
      : 1.0;

    // Inning-splits overlay: if pitcher has a known meltdown pattern, nudge the pitcherMult upward
    // If elite control, nudge it downward
    let inningMult = 1.0;
    const isplits = side.inningSplits;
    if (isplits) {
      // Meltdown signal: if any inning has xwOBA-against >=.400 with ≥15 PA, pitcher is more volatile
      if (isplits.meltdownXw >= 0.400 && isplits.meltdownDelta >= 0.040) {
        inningMult *= 1.04;  // +4% runs expected
      }
      // Control signal
      if (isplits.controlTier === 'wild') inningMult *= 1.06;
      else if (isplits.controlTier === 'below-average') inningMult *= 1.02;
      else if (isplits.controlTier === 'elite') inningMult *= 0.96;
      // Times through order degradation
      const f = isplits.groups?.firstTime;
      const s = isplits.groups?.secondTime;
      if (f?.pa >= 20 && s?.pa >= 20 && f.xwobaAgainst != null && s.xwobaAgainst != null) {
        const ttDelta = s.xwobaAgainst - f.xwobaAgainst;
        if (ttDelta >= 0.050) inningMult *= 1.03;  // fades hard second time through
      }
    }

    return {
      lineupMult,
      pitcherMult: pitcherMult * inningMult,  // apply inning overlay to pitcher multiplier
      bullpenMult,
      factors: {
        avgMaxXw: avgMaxXw.toFixed(3),
        avgWeightedXw: avgWeightedXw > 0 ? avgWeightedXw.toFixed(3) : null,
        effectiveXw: effectiveXw.toFixed(3),
        pitcherXwAgainst: pitcherXwAgainst ? pitcherXwAgainst.toFixed(3) : null,
        bullpenXwAgainst: bullpenXwAgainst ? bullpenXwAgainst.toFixed(3) : null,
        inningMult: inningMult.toFixed(3),
        controlTier: isplits?.controlTier || null,
        meltdownInning: isplits?.meltdownInning || null,
        lineupTierLabel: lt?.label || 'UNKNOWN',
        altitudeAudit  // NEW: per-pitch altitude xwOBA shifts (null if near sea level)
      }
    };
  };

  // Away runs: away hitters vs (home SP + home BP)
  const awayComp = sideMult(awayVsHome);
  // Home runs: home hitters vs (away SP + away BP)
  const homeComp = sideMult(homeVsAway);

  // Park factor: applies to both teams
  const parkRunMult = parkFactor ? (parkFactor.runs || 100) / 100 : 1.0;
  // Umpire factor: applies to both teams
  const umpRunMult = umpire?.factors?.runs || 1.0;
  // Weather factor: temperature + wind + precip effect on run environment
  const weatherRunMult = weatherImpact?.runMult || 1.0;

  // Composite environment multiplier: park × weather + interaction terms.
  // When envImpact is available, it replaces `parkRunMult * weatherRunMult`
  // in the run projection chain. Surfaces interactions the flat product
  // missed (hot×wind-out compounding, hitter-park×hot, altitude×hot, etc.)
  // that drive the +2.9 runs UNDER calibration bias.
  //
  // We keep parkRunMult and weatherRunMult defined separately above for the
  // narrative section that references them, but the actual projection math
  // uses the composite when available.
  const envRunMult = envImpact?.runMult ?? (parkRunMult * weatherRunMult);

  // PITCHER-AWARE ENV EXPOSURE (May 23, 2026 fix — TEX@COL contradiction)
  //
  // Problem: envRunMult is applied symmetrically to both teams. A +15% Coors
  // boost gets multiplied into BOTH offenses regardless of who they face.
  // When one team has an elite SP, the opposing offense still gets the full
  // park boost despite the SP capping their offensive ceiling.
  //
  // Fix: fade the *positive* portion of env exposure based on the quality of
  // the opposing pitcher. An offense facing a .280-xwOBA-against ace at Coors
  // shouldn't get the full +15% boost — the elite arm flattens the variance
  // the park exploits.
  //
  // Mechanics:
  //   - Only fades env BOOSTS (envRunMult > 1.0). Suppressive parks (Petco,
  //     Tropicana) still apply fully because they reduce baseline output
  //     regardless of pitcher quality.
  //   - Fade strength scales with how elite the opposing pitcher is.
  //     .300 xw-against → no fade (0%). .280 → 50% fade. .260 → 80% fade.
  //   - Each side gets its own envRunMult based on the OPPOSING pitcher's
  //     quality. So if TEX has an elite SP, COL's env boost fades; TEX's
  //     own env boost stays intact (they face the COL SP, which is not elite).
  //
  // This is the structural fix for the symmetric-park-multiplier bug.
  // Surfaces in factors.envPitcherFade per side for diagnostics.
  const computeSideEnvMult = (opposingPitcherXw) => {
    if (envRunMult <= 1.0) return envRunMult;  // suppressive park: no fade
    const xw = parseFloat(opposingPitcherXw || 0.320);
    if (!xw || xw >= 0.300) return envRunMult;  // non-elite opposing arm: full boost
    const fadeStrength = Math.min(0.80, (0.300 - xw) * 25); // .280→.50, .260→.80, capped
    const boostPortion = envRunMult - 1.0;
    const fadedBoost = boostPortion * (1 - fadeStrength);
    return 1.0 + fadedBoost;
  };
  // For projAwayRuns: away offense faces homePitcher (homeComp's pitcher is the AWAY SP though...)
  // Naming note: awayComp = away hitters vs home SP. So awayComp.factors.pitcherXwAgainst = HOME SP's xw.
  // For away offense, the opposing pitcher's xw is awayComp.factors.pitcherXwAgainst.
  // For home offense, the opposing pitcher's xw is homeComp.factors.pitcherXwAgainst.
  const awayEnvMult = computeSideEnvMult(awayComp.factors.pitcherXwAgainst);
  const homeEnvMult = computeSideEnvMult(homeComp.factors.pitcherXwAgainst);

  // Blend starter + bullpen influence on opposing offense
  // Traditional SP: 60/40 SP/BP. Opener/bulk/shifted: 25/75 (bullpen carries more innings).
  // Short-starter: 45/55 (still starts but gives way earlier).
  const blendWeight = (side) => {
    const role = side?.pitcherRole?.role;
    if (role === 'opener' || role === 'bulk' || role === 'shifted') return { sp: 0.25, bp: 0.75 };
    if (role === 'short-starter') return { sp: 0.45, bp: 0.55 };
    return { sp: 0.60, bp: 0.40 };
  };
  const aw = blendWeight(awayVsHome);
  const hw = blendWeight(homeVsAway);
  const awayPitcherBlend = (awayComp.pitcherMult * aw.sp) + (awayComp.bullpenMult * aw.bp);
  const homePitcherBlend = (homeComp.pitcherMult * hw.sp) + (homeComp.bullpenMult * hw.bp);

  // PITCHER DUEL FIX (Change 3 of 3): Dual-elite SP detector.
  //
  // When BOTH starting pitchers have xwOBA-against ≤ 0.290, apply an
  // additional -7% multiplicative suppression to both teams' projections.
  // This catches the conjunction effect that the additive multiplier chain
  // misses: two elite SPs together suppress runs more than the product of
  // their individual suppressions.
  //
  // Magnitude (-7%) is intentionally modest because Changes 1 and 2 already
  // do most of the work. This is the "extra nudge" for the specific case
  // where both starters can lock down their respective opposing lineups.
  //
  // Surfaces in factors.dualEliteSuppression so we can see when it fires.
  const awaySpXw = parseFloat(awayComp.factors.pitcherXwAgainst || 0.320);
  const homeSpXw = parseFloat(homeComp.factors.pitcherXwAgainst || 0.320);
  const awaySpElite = awaySpXw > 0 && awaySpXw <= 0.290;
  const homeSpElite = homeSpXw > 0 && homeSpXw <= 0.290;
  const dualEliteFactor = (PITCHER_DUEL_FIX_ENABLED && awaySpElite && homeSpElite) ? 0.93 : 1.0;

  // SLUGFEST FIX: Multi-factor conjunction detector for explosive offensive games.
  //
  // Pattern from SEA@CWS (12.87 projected → 20 actual):
  //   - Both SPs xwOBA-against ≥ 0.330 (mediocre to bad)
  //   - Both lineups EXPLOITABLE-tier with 7+/9 hitters tiered
  //   - Hitter-friendly park (Rate Field: +13% HR, runMult ≥ 1.05)
  //   - Multiple HR-elite hitters (3+ projected ≥ 6%/PA)
  //
  // Score the conjunction. When 3+ signals fire, nudge projection up.
  // When 4+ fire, nudge harder. Modest magnitudes (+7% / +10%) because
  // we don't want to overshoot and create new failure modes.
  //
  // Surfaces in factors.slugfestScore + factors.slugfestFactor for diagnostics.
  let slugfestScore = 0;
  const slugfestSignals = [];

  // Signal 1: Both SPs bad (≥ 0.330 xwOBA-against)
  const bothSPsBad = awaySpXw >= 0.330 && homeSpXw >= 0.330;
  if (bothSPsBad) {
    slugfestScore += 1;
    slugfestSignals.push(`both SPs bad (${awaySpXw.toFixed(3)}/${homeSpXw.toFixed(3)})`);
  }

  // Signal 2: Both lineups EXPLOITABLE with high hitter coverage (7+/9 tiered)
  const awayLineupTier = awayVsHome?.lineupTier;
  const homeLineupTier = homeVsAway?.lineupTier;
  const awayStacked = awayLineupTier?.tier === 'exploitable' && (awayLineupTier.tieredCount || 0) >= 7;
  const homeStacked = homeLineupTier?.tier === 'exploitable' && (homeLineupTier.tieredCount || 0) >= 7;
  if (awayStacked && homeStacked) {
    slugfestScore += 1;
    slugfestSignals.push(`both lineups stacked (${awayLineupTier.tieredCount}/9 + ${homeLineupTier.tieredCount}/9 EXPLOITABLE)`);
  }

  // Signal 3: Hitter park (env multiplier ≥ 1.05 OR park HR factor strongly positive)
  // Use envRunMult since it's already computed and incorporates park × weather
  const hitterEnvironment = envRunMult >= 1.05;
  if (hitterEnvironment) {
    slugfestScore += 1;
    slugfestSignals.push(`hitter park/weather (env ×${envRunMult.toFixed(3)})`);
  }

  // Signal 4: Multiple HR-elite hitters across both lineups (3+ projected ≥ 6% HR/PA)
  // hrAuditTop is the top-3 per side from the empirical HR projection module
  const awayHrTop = awayVsHome?.hrAuditTop || [];
  const homeHrTop = homeVsAway?.hrAuditTop || [];
  const allHrProjections = [...awayHrTop, ...homeHrTop]
    .map(h => h.projectedHrPerPa || 0);
  const hrEliteCount = allHrProjections.filter(p => p >= 0.06).length;
  if (hrEliteCount >= 3) {
    slugfestScore += 1;
    slugfestSignals.push(`${hrEliteCount} HR-elite hitters`);
  }

  // Signal 5 (half-weight): Both pitchers have a meltdown inning ≤ 7th
  // Indicates both teams have a high-leverage scoring window in regulation
  const awayMeltInn = parseInt(awayComp.factors.meltdownInning || 0, 10);
  const homeMeltInn = parseInt(homeComp.factors.meltdownInning || 0, 10);
  const dualMeltdownAlign = awayMeltInn > 0 && awayMeltInn <= 7 && homeMeltInn > 0 && homeMeltInn <= 7;
  if (dualMeltdownAlign) {
    slugfestScore += 0.5;
    slugfestSignals.push(`meltdown innings align (away ${awayMeltInn}th / home ${homeMeltInn}th)`);
  }

  // Convert score to multiplicative factor
  let slugfestFactor = 1.0;
  if (SLUGFEST_FIX_ENABLED) {
    if (slugfestScore >= 4) slugfestFactor = 1.10;       // 4+ signals: +10%
    else if (slugfestScore >= 3) slugfestFactor = 1.07;  // 3 signals: +7%
    // Below 3 signals: no boost — conjunction not strong enough
  }

  // Conversion rate multipliers: how efficiently each team converts scoring chances into runs.
  // Applied to the team's OWN run total (their offense converts their own opportunities).
  // 1.0 = league avg; <1.0 = strands runners; >1.0 = clutch / efficient.
  // Capped at ±8% in the source module to prevent overfitting.
  const awayConvMult = conversionRates?.away?.conversionMult || 1.0;
  const homeConvMult = conversionRates?.home?.conversionMult || 1.0;

  // ========================================================
  // LINEUP SIGNAL MULTIPLIERS (May 25, 2026 — Connections 1 & 3)
  //
  // Hitter-aggregator multipliers that nudge each side's run projection
  // based on per-hitter intelligence the legacy lineup tier missed.
  //
  //   awayGameTotalMult: scales awayRuns by lineup fragility/eligibility
  //   awayArsenalMult:   scales awayRuns by lineup concentration of regressed
  //                      advantages vs the pitcher's specific arsenal
  //
  // Both are conservatively bounded in the aggregator module ([0.90,1.10]
  // and [0.92,1.10] respectively). Falls back to 1.0 if signals are absent
  // (legacy callers without aggregator integration still work).
  // ========================================================
  const awayLineupSignalMult = (awayGameTotalSignal?.multiplier || 1.0)
                              * (awayArsenalSignal?.multiplier || 1.0);
  const homeLineupSignalMult = (homeGameTotalSignal?.multiplier || 1.0)
                              * (homeArsenalSignal?.multiplier || 1.0);

  // Final projections — now including lineup-aggregator signals, conversion
  // rate, composite environment, dual-elite, and slugfest.
  // PITCHER-AWARE ENV EXPOSURE (May 23, 2026): each side uses its own envMult,
  // which fades the boost portion based on the opposing pitcher's quality.
  const rawProjAwayRuns = BASELINE_RUNS * awayComp.lineupMult * awayPitcherBlend * awayEnvMult * umpRunMult * awayConvMult * dualEliteFactor * slugfestFactor * awayLineupSignalMult;
  const rawProjHomeRuns = BASELINE_RUNS * homeComp.lineupMult * homePitcherBlend * homeEnvMult * umpRunMult * homeConvMult * dualEliteFactor * slugfestFactor * homeLineupSignalMult;

  // (Inning Audit Fix #3 — May 30, 2026)
  // Calibration scalar to address the +0.77 run mean over-projection
  // observed across 131 audited games (69% scored UNDER projection).
  // Applied symmetrically to away and home so the YRFI/NRFI split
  // logic downstream is unaffected — only the magnitude is honest.
  //
  // (Inning Audit Fix #4 — May 30, 2026)
  // Asymmetric calibration: away projections were +0.07 (accurate)
  // while home projections were -0.84 (over-projected). Apply a
  // separate, stronger pull to the home side only.
  //
  // (Drop #5 Fix #3 — May 31, 2026)
  // May 31 audit (n=159 games) showed home projections were still
  // over-projecting by -0.42 runs while away was +0.15. The 0.86
  // home scalar was a partial fix — tighten to 0.82 to close more
  // of the remaining gap. Don't go below 0.80; if -0.42 persists
  // at 0.82 there's a structural upstream bias that needs an audit,
  // not a scalar.
  const PROJECTION_SCALE_AWAY = 0.98;   // away was nearly accurate
  const PROJECTION_SCALE_HOME = 0.82;   // was 0.86, tightened to close residual -0.42 bias
  const projAwayRuns = rawProjAwayRuns * PROJECTION_SCALE_AWAY;
  const projHomeRuns = rawProjHomeRuns * PROJECTION_SCALE_HOME;
  const projTotal = projAwayRuns + projHomeRuns;

  // Win probability via Pythagorean expectation (exp = 1.83 for MLB)
  const ra = Math.max(0.5, projAwayRuns);
  const rh = Math.max(0.5, projHomeRuns);
  const homeWinProb = Math.pow(rh, 1.83) / (Math.pow(rh, 1.83) + Math.pow(ra, 1.83));

  // Projected winner
  const projWinner = projHomeRuns > projAwayRuns ? 'home' : 'away';
  const projMargin = Math.abs(projHomeRuns - projAwayRuns);

  // Confidence label
  let confidenceLabel = 'TOSS-UP';
  if (projMargin >= 1.5) confidenceLabel = 'STRONG LEAN';
  else if (projMargin >= 0.8) confidenceLabel = 'CLEAR LEAN';
  else if (projMargin >= 0.3) confidenceLabel = 'SLIGHT LEAN';

  // Compare to market total if we have odds
  let marketComparison = null;
  if (odds && odds.hasOdds && odds.total) {
    const marketTotal = parseFloat(odds.total);
    const diff = projTotal - marketTotal;
    let lean = 'NEUTRAL';
    let leanStrength = 'none';
    if (Math.abs(diff) < 0.3) {
      lean = 'NEUTRAL';
      leanStrength = 'none';
    } else if (diff > 0) {
      lean = 'OVER';
      leanStrength = diff >= 1.0 ? 'strong' : diff >= 0.5 ? 'moderate' : 'slight';
    } else {
      lean = 'UNDER';
      leanStrength = diff <= -1.0 ? 'strong' : diff <= -0.5 ? 'moderate' : 'slight';
    }

    // Low-scoring flag: if projected total is well below market AND under 7.5
    const lowScoring = projTotal < 7.5 && diff < -0.3;
    const highScoring = projTotal > 9.5 && diff > 0.3;

    marketComparison = {
      marketTotal,
      projTotal: projTotal.toFixed(2),
      diff: diff.toFixed(2),
      lean,
      leanStrength,
      lowScoring,
      highScoring,
      // Market implied win prob from moneyline (Vegas home fav)
      marketFavorite: odds.favorite || null,
      ourFavorite: projWinner === 'home' ? 'HOME' : 'AWAY'
    };
  }

  // ==== REASONING NARRATIVE BUILDERS ====
  // Build explanation of what drives our projection
  const projReasoning = [];

  // DOMINANT FACTOR DETECTOR (May 23, 2026 fix — narrative coherence)
  //
  // Problem: the projReasoning array lists every factor we considered. When a
  // game has 8 reasons all bulleted equally, the user sees "elite SP suppresses"
  // right next to "Coors +15%" and assumes both apply with equal force. They
  // don't — one is the dominant signal, the others are noise.
  //
  // Fix: detect when a single factor is the bottleneck and surface it as the
  // headline. Currently four bottleneck patterns:
  //   - ELITE_AWAY_SP / ELITE_HOME_SP: one starter is ≤ .290 xwOBA-against
  //     AND the other side's offense is being suppressed enough to dominate
  //   - DUAL_ELITE: both starters ≤ .290 (pitcher's duel)
  //   - DOME_SUPPRESS: dome game with both SPs decent (stable conditions favor pitchers)
  //   - HITTER_BOMB: 3+ slugfest signals AND no elite SP on either side
  //
  // Surfaces in projection.dominantFactor for the UI to read and render as
  // a callout instead of mixing with the bullet list.
  let dominantFactor = null;
  const awaySpXwNum = awaySpXw || 0;
  const homeSpXwNum = homeSpXw || 0;
  const awaySpIsElite = awaySpXwNum > 0 && awaySpXwNum <= 0.290;
  const homeSpIsElite = homeSpXwNum > 0 && homeSpXwNum <= 0.290;
  const eitherSpBad = awaySpXwNum >= 0.340 || homeSpXwNum >= 0.340;

  if (awaySpIsElite && homeSpIsElite) {
    dominantFactor = {
      type: 'DUAL_ELITE_SP',
      headline: `Pitcher's duel: both starters elite (away .${Math.round(awaySpXwNum*1000)}, home .${Math.round(homeSpXwNum*1000)} xwOBA-against)`,
      bias: 'UNDER',
      strength: 'strong',
    };
  } else if (awaySpIsElite && !eitherSpBad) {
    // Away SP elite, home SP not awful = away SP dominates the projection
    dominantFactor = {
      type: 'ELITE_AWAY_SP',
      headline: `Away SP is the bottleneck (.${Math.round(awaySpXwNum*1000)} xwOBA-against) — home offense suppressed regardless of park/lineup`,
      bias: 'UNDER',
      strength: 'strong',
    };
  } else if (homeSpIsElite && !eitherSpBad) {
    dominantFactor = {
      type: 'ELITE_HOME_SP',
      headline: `Home SP is the bottleneck (.${Math.round(homeSpXwNum*1000)} xwOBA-against) — away offense suppressed regardless of park/lineup`,
      bias: 'UNDER',
      strength: 'strong',
    };
  } else if (weatherImpact?.isDome && awaySpXwNum > 0 && awaySpXwNum <= 0.330 && homeSpXwNum > 0 && homeSpXwNum <= 0.330) {
    dominantFactor = {
      type: 'DOME_STABLE',
      headline: `Dome environment + competent SPs both sides — stable conditions favor pitcher repeatability`,
      bias: 'UNDER',
      strength: 'moderate',
    };
  } else if (slugfestScore >= 3 && !awaySpIsElite && !homeSpIsElite) {
    dominantFactor = {
      type: 'SLUGFEST',
      headline: `Slugfest setup: ${slugfestSignals.slice(0, 3).join(', ')}`,
      bias: 'OVER',
      strength: slugfestScore >= 4 ? 'strong' : 'moderate',
    };
  }

  // Lineup quality reasoning
  const awayTier = awayVsHome?.lineupTier;
  const homeTier = homeVsAway?.lineupTier;
  if (awayTier?.label && awayTier.label !== 'NO DATA' && awayTier.label !== 'TOUGH MATCHUP') {
    if (awayTier.tier === 'exploitable' || awayTier.tier === 'leaky') {
      projReasoning.push(`Away offense can exploit home SP arsenal (${awayTier.label}: ${awayTier.eliteCount}E/${awayTier.strongCount}S/${awayTier.solidCount}So)`);
    }
  }
  if (awayTier?.tier === 'tough') {
    projReasoning.push(`Away offense suppressed by home SP (${awayTier.label})`);
  }
  if (homeTier?.label && homeTier.label !== 'NO DATA' && homeTier.label !== 'TOUGH MATCHUP') {
    if (homeTier.tier === 'exploitable' || homeTier.tier === 'leaky') {
      projReasoning.push(`Home offense can exploit away SP arsenal (${homeTier.label}: ${homeTier.eliteCount}E/${homeTier.strongCount}S/${homeTier.solidCount}So)`);
    }
  }
  if (homeTier?.tier === 'tough') {
    projReasoning.push(`Home offense suppressed by away SP (${homeTier.label})`);
  }

  // Pitcher quality reasoning
  if (awayComp.factors.pitcherXwAgainst) {
    const pxw = parseFloat(awayComp.factors.pitcherXwAgainst);
    if (pxw >= 0.360) projReasoning.push(`Home SP poor xwOBA-against .${Math.round(pxw*1000).toString().padStart(3,'0')} — elevates away offense`);
    else if (pxw <= 0.285) projReasoning.push(`Home SP elite xwOBA-against .${Math.round(pxw*1000).toString().padStart(3,'0')} — suppresses away offense`);
  }
  if (homeComp.factors.pitcherXwAgainst) {
    const pxw = parseFloat(homeComp.factors.pitcherXwAgainst);
    if (pxw >= 0.360) projReasoning.push(`Away SP poor xwOBA-against .${Math.round(pxw*1000).toString().padStart(3,'0')} — elevates home offense`);
    else if (pxw <= 0.285) projReasoning.push(`Away SP elite xwOBA-against .${Math.round(pxw*1000).toString().padStart(3,'0')} — suppresses home offense`);
  }

  // Bullpen reasoning
  if (awayComp.factors.bullpenXwAgainst) {
    const bxw = parseFloat(awayComp.factors.bullpenXwAgainst);
    if (bxw >= 0.355) projReasoning.push(`Home bullpen weak (${bxw.toFixed(3)} xwOBA-against) — late-game run exposure`);
    else if (bxw <= 0.290) projReasoning.push(`Home bullpen elite (${bxw.toFixed(3)} xwOBA-against) — locks down late`);
  }
  if (homeComp.factors.bullpenXwAgainst) {
    const bxw = parseFloat(homeComp.factors.bullpenXwAgainst);
    if (bxw >= 0.355) projReasoning.push(`Away bullpen weak (${bxw.toFixed(3)} xwOBA-against) — late-game run exposure`);
    else if (bxw <= 0.290) projReasoning.push(`Away bullpen elite (${bxw.toFixed(3)} xwOBA-against) — locks down late`);
  }

  // Inning-split reasoning (control + meltdown patterns from blended current+prior data)
  const awaySplits = awayVsHome?.inningSplits;
  const homeSplits = homeVsAway?.inningSplits;
  if (awaySplits) {
    if (awaySplits.controlTier === 'wild') projReasoning.push(`Home SP is wild (${awaySplits.controlTier}) — walks inflate away offense`);
    else if (awaySplits.controlTier === 'elite') projReasoning.push(`Home SP has elite control — suppresses free passes`);
    if (awaySplits.meltdownInning && awaySplits.meltdownXw >= 0.400 && (awaySplits.meltdownDelta || 0) >= 0.040) {
      projReasoning.push(`Home SP meltdown in ${ordinal(awaySplits.meltdownInning)} inning (xwOBA ${awaySplits.meltdownXw.toFixed(3)}) — high-leverage window for overs`);
    }
  }
  if (homeSplits) {
    if (homeSplits.controlTier === 'wild') projReasoning.push(`Away SP is wild (${homeSplits.controlTier}) — walks inflate home offense`);
    else if (homeSplits.controlTier === 'elite') projReasoning.push(`Away SP has elite control — suppresses free passes`);
    if (homeSplits.meltdownInning && homeSplits.meltdownXw >= 0.400 && (homeSplits.meltdownDelta || 0) >= 0.040) {
      projReasoning.push(`Away SP meltdown in ${ordinal(homeSplits.meltdownInning)} inning (xwOBA ${homeSplits.meltdownXw.toFixed(3)}) — high-leverage window for overs`);
    }
  }

  // Role-based warnings (opener, shift, short-starter) — sharpest signal when they appear
  const awayRole = awayVsHome?.pitcherRole;
  const homeRole = homeVsAway?.pitcherRole;
  const roleNarrative = (role, sideLabel) => {
    if (!role || role.role === 'traditional' || role.role === 'unknown') return null;
    switch (role.role) {
      case 'opener':
        return `${sideLabel} is using an opener (${role.avgIpRecent} IP avg recently) — bullpen carries the majority of innings`;
      case 'bulk':
        return `${sideLabel} is a bulk reliever, not a traditional starter — bullpen workload`;
      case 'shifted':
        return `${sideLabel} recently shifted to relief role — K-prop/workload lines may be stale`;
      case 'short-starter':
        return `${sideLabel} is a short-start pitcher (${role.avgIpRecent} IP recent avg) — bullpen sees more exposure`;
    }
    return null;
  };
  const awayRoleNote = roleNarrative(awayRole, 'Home SP');
  if (awayRoleNote) projReasoning.push(awayRoleNote);
  const homeRoleNote = roleNarrative(homeRole, 'Away SP');
  if (homeRoleNote) projReasoning.push(homeRoleNote);

  // Park reasoning
  if (parkRunMult >= 1.05) projReasoning.push(`${parkFactor?.name || 'Park'} is run-friendly (+${Math.round((parkRunMult-1)*100)}% runs)`);
  else if (parkRunMult <= 0.95) projReasoning.push(`${parkFactor?.name || 'Park'} suppresses runs (${Math.round((parkRunMult-1)*100)}% runs)`);

  // Umpire reasoning
  if (umpRunMult >= 1.03) projReasoning.push(`Home plate ump has high-run tendency (+${Math.round((umpRunMult-1)*100)}%)`);
  else if (umpRunMult <= 0.97) projReasoning.push(`Home plate ump has low-run tendency (${Math.round((umpRunMult-1)*100)}%)`);

  // Weather reasoning (temp + wind + precip)
  if (weatherImpact && !weatherImpact.isDome) {
    (weatherImpact.narrative || []).forEach(r => projReasoning.push(r));
  } else if (weatherImpact?.isDome) {
    projReasoning.push(weatherImpact.narrative[0] || 'Dome environment — no weather effect');
  }

  // Environment interaction reasoning — surfaces compounding effects the
  // flat park*weather product missed. Hot×wind-out, hitter-park×hot, etc.
  // Full diagnostic UI lands in Session 2 of the environment refactor.
  if (envImpact?.interactions?.length) {
    envImpact.interactions.forEach(ix => projReasoning.push(ix.narrative));
  }

  // Dual-elite SP suppression reasoning — fires when both starters have
  // xwOBA-against ≤ 0.290. Communicates the conjunction effect that's been
  // applied to the projection.
  if (dualEliteFactor < 1.0) {
    projReasoning.push(`Dual-elite pitcher's duel — both SPs suppress (xwOBA-against ${awaySpXw.toFixed(3)} vs ${homeSpXw.toFixed(3)}) — projection reduced ${Math.round((1 - dualEliteFactor) * 100)}%`);
  }

  // Slugfest reasoning — fires when 3+ signals align (bad SPs + stacked
  // lineups + hitter park + multiple HR threats). Communicates the
  // multi-factor conjunction that's been detected.
  if (slugfestFactor > 1.0) {
    projReasoning.push(`Slugfest setup — ${slugfestSignals.join(' · ')} — projection boosted ${Math.round((slugfestFactor - 1) * 100)}%`);
  }

  // Conversion rate reasoning — only push when there's a meaningful signal
  if (conversionRates?.away && conversionRates.away.signal !== 'neutral' && conversionRates.away.signal !== 'insufficient') {
    if (conversionRates.away.signal === 'efficient' || conversionRates.away.signal === 'slight-edge') {
      projReasoning.push(`Away offense converts efficiently — ${conversionRates.away.detail}`);
    } else if (conversionRates.away.signal === 'stranded' || conversionRates.away.signal === 'slight-drag') {
      projReasoning.push(`Away offense leaves runners on — ${conversionRates.away.detail}`);
    }
  }
  if (conversionRates?.home && conversionRates.home.signal !== 'neutral' && conversionRates.home.signal !== 'insufficient') {
    if (conversionRates.home.signal === 'efficient' || conversionRates.home.signal === 'slight-edge') {
      projReasoning.push(`Home offense converts efficiently — ${conversionRates.home.detail}`);
    } else if (conversionRates.home.signal === 'stranded' || conversionRates.home.signal === 'slight-drag') {
      projReasoning.push(`Home offense leaves runners on — ${conversionRates.home.detail}`);
    }
  }

  // Why our projection differs from market (reasoning for divergence)
  const marketReasoning = [];
  if (marketComparison && marketComparison.leanStrength !== 'none') {
    const diff = parseFloat(marketComparison.diff);
    if (diff > 0) {
      // We project OVER market
      marketReasoning.push(`Our projection is ${Math.abs(diff).toFixed(2)} runs higher than ${marketComparison.marketTotal} line`);
      // Look for specific drivers
      if (awayTier?.tier === 'exploitable' || awayTier?.tier === 'leaky') {
        marketReasoning.push(`Market may be undervaluing the away lineup's edges vs home SP arsenal`);
      }
      if (homeTier?.tier === 'exploitable' || homeTier?.tier === 'leaky') {
        marketReasoning.push(`Market may be undervaluing the home lineup's edges vs away SP arsenal`);
      }
      if (awayComp.factors.pitcherXwAgainst && parseFloat(awayComp.factors.pitcherXwAgainst) >= 0.350) {
        marketReasoning.push(`Home SP has been more hittable than public perception suggests`);
      }
      if (homeComp.factors.pitcherXwAgainst && parseFloat(homeComp.factors.pitcherXwAgainst) >= 0.350) {
        marketReasoning.push(`Away SP has been more hittable than public perception suggests`);
      }
      if (parkRunMult >= 1.05) {
        marketReasoning.push(`Run-friendly park environment stacks with offensive edges`);
      }
    } else {
      // We project UNDER market
      marketReasoning.push(`Our projection is ${Math.abs(diff).toFixed(2)} runs lower than ${marketComparison.marketTotal} line`);
      if (awayTier?.tier === 'tough') {
        marketReasoning.push(`Away lineup struggles vs home SP arsenal more than market accounts for`);
      }
      if (homeTier?.tier === 'tough') {
        marketReasoning.push(`Home lineup struggles vs away SP arsenal more than market accounts for`);
      }
      if (awayComp.factors.pitcherXwAgainst && parseFloat(awayComp.factors.pitcherXwAgainst) <= 0.295) {
        marketReasoning.push(`Home SP has been suppressing contact (low xwOBA-against)`);
      }
      if (homeComp.factors.pitcherXwAgainst && parseFloat(homeComp.factors.pitcherXwAgainst) <= 0.295) {
        marketReasoning.push(`Away SP has been suppressing contact (low xwOBA-against)`);
      }
      if (parkRunMult <= 0.95) {
        marketReasoning.push(`Pitcher-friendly park depresses scoring more than market accounts for`);
      }
      if (umpRunMult <= 0.97) {
        marketReasoning.push(`Umpire's large strike zone expected to depress scoring`);
      }
    }
  }

  // Moneyline divergence reasoning
  const winnerReasoning = [];
  if (odds && odds.hasOdds && odds.favorite) {
    const weFavorHome = projWinner === 'home';
    const marketFavorsHome = odds.favorite === odds.homeTeam;
    const agreement = weFavorHome === marketFavorsHome;
    if (!agreement && projMargin >= 0.3) {
      // We disagree with the market on the winner
      const ourPick = projWinner === 'home' ? 'HOME' : 'AWAY';
      winnerReasoning.push(`DISAGREEMENT: Our model picks ${ourPick} while market favors ${odds.favorite}`);
      // Key drivers
      if (projWinner === 'home' && homeTier?.tier !== 'tough') {
        winnerReasoning.push(`Home offense has arsenal edges vs away SP that market isn't pricing in`);
      }
      if (projWinner === 'away' && awayTier?.tier !== 'tough') {
        winnerReasoning.push(`Away offense has arsenal edges vs home SP that market isn't pricing in`);
      }
      const favComp = marketFavorsHome ? homeComp : awayComp;
      const favTier = marketFavorsHome ? homeTier : awayTier;
      if (favTier?.tier === 'tough') {
        winnerReasoning.push(`Market's favorite faces a tough arsenal matchup we're discounting`);
      }
    } else if (agreement) {
      winnerReasoning.push(`Model aligns with market favorite (${odds.favorite})`);
    }
  }

  const narrative = {
    projectionReasons: projReasoning,     // what drives our projection
    marketDivergenceReasons: marketReasoning,  // why our total differs from book
    winnerReasons: winnerReasoning         // moneyline agreement/disagreement reasoning
  };

  return {
    projAwayRuns: projAwayRuns.toFixed(2),
    projHomeRuns: projHomeRuns.toFixed(2),
    projTotal: projTotal.toFixed(2),
    projMargin: projMargin.toFixed(2),
    projWinner,
    confidenceLabel,
    homeWinProb: (homeWinProb * 100).toFixed(1),
    awayWinProb: ((1 - homeWinProb) * 100).toFixed(1),
    dominantFactor,  // NEW: bottleneck headline (May 23, 2026 fix)
    factors: {
      away: awayComp.factors,
      home: homeComp.factors,
      parkRunMult: parkRunMult.toFixed(3),
      weatherRunMult: weatherRunMult.toFixed(3),
      envRunMult: envRunMult.toFixed(3),
      awayEnvMult: awayEnvMult.toFixed(3),  // NEW: per-side env after pitcher fade
      homeEnvMult: homeEnvMult.toFixed(3),  // NEW: per-side env after pitcher fade
      envInteractions: envImpact?.interactions?.length || 0,
      airDensity: airDensity.toFixed(4),       // NEW: altitudeEngine air density
      airDensityAudit,                          // NEW: how density was computed
      umpRunMult: umpRunMult.toFixed(3),
      awayConvMult: awayConvMult.toFixed(3),
      homeConvMult: homeConvMult.toFixed(3),
      dualEliteFactor: dualEliteFactor.toFixed(3),
      pitcherDuelFixEnabled: PITCHER_DUEL_FIX_ENABLED,
      slugfestScore: slugfestScore.toFixed(1),
      slugfestFactor: slugfestFactor.toFixed(3),
      slugfestSignals,
      slugfestFixEnabled: SLUGFEST_FIX_ENABLED,
      // NEW (May 25, 2026): lineup-aggregator multipliers applied to each side
      awayLineupSignalMult: awayLineupSignalMult.toFixed(3),
      homeLineupSignalMult: homeLineupSignalMult.toFixed(3),
      awayGameTotalSignal: awayGameTotalSignal || null,
      homeGameTotalSignal: homeGameTotalSignal || null,
      awayArsenalSignal: awayArsenalSignal || null,
      homeArsenalSignal: homeArsenalSignal || null
    },
    conversionRates: conversionRates || { away: null, home: null },
    marketComparison,
    narrative
  };
}

// ===== EDGE DESCRIPTION GENERATOR =====
// Builds a plain-language explanation of WHY a hitter has an edge in this matchup
function buildEdgeDescription({ hitter, matchedPitches, maxXwoba, overall, adjustments, parkFactor, tier }) {
  if (!tier || matchedPitches.length === 0) return null;

  const parts = [];

  // Primary reason: the best pitch-type mismatch
  const best = matchedPitches.reduce((a, b) =>
    parseFloat(a.hitterXwoba) > parseFloat(b.hitterXwoba) ? a : b
  );
  const bestXwoba = parseFloat(best.hitterXwoba);

  // Craft the hook based on xwOBA severity
  let verb;
  if (bestXwoba >= 0.500) verb = 'demolishes';
  else if (bestXwoba >= 0.420) verb = 'crushes';
  else if (bestXwoba >= 0.370) verb = 'handles';
  else verb = 'does well vs';

  parts.push(`${verb} the ${best.pitch.toLowerCase()} (${bestXwoba.toFixed(3)} xwOBA)`);

  // Usage context — if the pitcher throws it a lot, the edge is bigger
  const usage = parseFloat(best.pitcherUsage || 0);
  if (usage >= 35) {
    parts[0] += `, and the pitcher leans on it heavily (${usage.toFixed(0)}% usage)`;
  } else if (usage >= 20) {
    parts[0] += ` (${usage.toFixed(0)}% usage)`;
  }

  // Secondary pitch crushed?
  const others = matchedPitches
    .filter(m => m !== best && parseFloat(m.hitterXwoba) >= 0.370)
    .sort((a, b) => parseFloat(b.hitterXwoba) - parseFloat(a.hitterXwoba));
  if (others.length > 0) {
    parts.push(`Also strong vs the ${others[0].pitch.toLowerCase()} (${others[0].hitterXwoba})`);
  }

  // Power profile
  const barrel = parseFloat(overall.barrel_batted_rate?.value || 0);
  const hardHit = parseFloat(overall.hard_hit_percent?.value || 0);
  const ev = parseFloat(overall.avg_exit_velocity?.value || 0);
  const powerSignals = [];
  if (barrel >= 12) powerSignals.push(`${barrel.toFixed(1)}% barrel`);
  if (hardHit >= 45) powerSignals.push(`${hardHit.toFixed(0)}% hard-hit`);
  if (ev >= 91) powerSignals.push(`${ev.toFixed(1)} EV`);
  if (powerSignals.length >= 2) {
    parts.push(`Elite contact quality (${powerSignals.join(', ')})`);
  } else if (powerSignals.length === 1) {
    parts.push(powerSignals[0]);
  }

  // Context adjustments
  const hitterAdjustments = adjustments.filter(a => a.favor === 'hitter');
  if (hitterAdjustments.length > 0) {
    const parkAdj = hitterAdjustments.find(a => a.type === 'park');
    const umpAdj = hitterAdjustments.find(a => a.type === 'umpire');
    const ctxBits = [];
    if (parkAdj && parkFactor) {
      ctxBits.push(`${parkFactor.name} boost`);
    }
    if (umpAdj) {
      ctxBits.push('hitter-friendly ump');
    }
    if (ctxBits.length > 0) {
      parts.push(`Boosted by ${ctxBits.join(' + ')}`);
    }
  }

  const pitcherAdjustments = adjustments.filter(a => a.favor === 'pitcher');
  if (pitcherAdjustments.length > 0 && hitterAdjustments.length === 0) {
    // Only mention headwinds if nothing helped
    const badParkAdj = pitcherAdjustments.find(a => a.type === 'park');
    if (badParkAdj && parkFactor) {
      parts.push(`(${parkFactor.name} suppresses offense — still clears tier)`);
    }
  }

  // Join as sentences
  return parts.join('. ') + '.';
}

// ===== PITCHER-VS-LINEUP TIER =====
// Aggregates mismatch data across the full lineup to score how exploitable the pitcher is overall
function computeLineupTier(analyzedHitters, arsenal) {
  const total = analyzedHitters.length;
  if (total === 0) {
    return {
      tier: 'unknown',
      label: 'No lineup data',
      eliteCount: 0,
      strongCount: 0,
      solidCount: 0,
      tieredCount: 0,
      lineupSize: 0,
      avgMaxXwoba: null,
      summary: 'Lineup unavailable'
    };
  }

  const eliteCount = analyzedHitters.filter(h => h.tier === 'elite').length;
  const strongCount = analyzedHitters.filter(h => h.tier === 'strong').length;
  const solidCount = analyzedHitters.filter(h => h.tier === 'solid').length;
  const tieredCount = eliteCount + strongCount + solidCount;

  // Average adjusted max xwOBA across whole lineup (not just tiered)
  const xwobas = analyzedHitters
    .map(h => parseFloat(h.adjustedMaxXwoba))
    .filter(x => !isNaN(x) && x > 0);
  const avgMaxXwoba = xwobas.length > 0
    ? (xwobas.reduce((a, b) => a + b, 0) / xwobas.length)
    : 0;

  // Average usage-weighted xwOBA across whole lineup. This is the EXPECTED
  // xwOBA when accounting for the pitcher's actual pitch distribution, not
  // just each hitter's best-case match. Used in buildGameProjection's
  // lineupMult math to regress maxXwoba toward expected.
  //
  // edgeScore is already computed per-hitter as sum(xw * usage_fraction),
  // which is the weighted xwoba directly. We average it across the lineup.
  const edgeScores = analyzedHitters
    .map(h => parseFloat(h.adjustedEdgeScore != null ? h.adjustedEdgeScore : h.edgeScore))
    .filter(x => !isNaN(x) && x > 0);
  const avgWeightedXwoba = edgeScores.length > 0
    ? (edgeScores.reduce((a, b) => a + b, 0) / edgeScores.length)
    : 0;

  // Weighted score: elite counts 3x, strong 2x, solid 1x
  // Plus bonus for high average xwOBA across whole lineup
  const weightedScore = (eliteCount * 3) + (strongCount * 2) + (solidCount * 1);
  const avgBonus = avgMaxXwoba >= 0.370 ? 3 : avgMaxXwoba >= 0.330 ? 2 : avgMaxXwoba >= 0.300 ? 1 : 0;
  const totalScore = weightedScore + avgBonus;

  // Tier assignment
  let tier, label, summary;
  if (eliteCount >= 2 || totalScore >= 10) {
    tier = 'exploitable';
    label = 'EXPLOITABLE';
    summary = `Lineup can stack against this arsenal (${eliteCount} elite, ${strongCount} strong, ${solidCount} solid across ${total} hitters)`;
  } else if (eliteCount >= 1 || totalScore >= 6) {
    tier = 'leaky';
    label = 'LEAKY';
    summary = `Multiple hitters have edges (${tieredCount}/${total} tiered, avg xwOBA ${avgMaxXwoba.toFixed(3)})`;
  } else if (tieredCount >= 2 || totalScore >= 3) {
    tier = 'spot';
    label = 'SPOT START';
    summary = `A couple of hitters can do damage, but arsenal mostly holds up`;
  } else if (arsenal.length === 0) {
    tier = 'unknown';
    label = 'NO DATA';
    summary = 'Pitcher arsenal not available yet (early season / low sample)';
  } else {
    tier = 'tough';
    label = 'TOUGH MATCHUP';
    summary = `Arsenal suppresses this lineup (${tieredCount}/${total} with any edge, avg xwOBA ${avgMaxXwoba.toFixed(3)})`;
  }

  return {
    tier,
    label,
    eliteCount,
    strongCount,
    solidCount,
    tieredCount,
    lineupSize: total,
    avgMaxXwoba: avgMaxXwoba.toFixed(3),
    avgWeightedXwoba: avgWeightedXwoba.toFixed(3),
    totalScore,
    summary
  };
}

// ===== PROP RECOMMENDATIONS =====
// Ranks prop types by edge quality for this specific matchup
// =============================================================
// PER-PA → PER-GAME PROBABILITY CONVERSION
// =============================================================
//
// PURPOSE
//   The contact engine (computeHitProbability, computeHrProbability,
//   computeXbhProbability) returns PER-PLATE-APPEARANCE probabilities. But the
//   prop lines we display these against are PER-GAME "at least N" lines:
//     HITS 0.5 → P(at least 1 hit in the game)
//     HR 0.5   → P(at least 1 HR in the game)
//     TB 1.5   → P(at least 2 total bases in the game)
//     RBI 0.5  → P(at least 1 RBI)
//     RUNS 0.5 → P(at least 1 run scored)
//
//   Previously the per-PA rate was attached directly to the prop, producing
//   probabilities that looked too low (e.g. HR 0.5 @ 16% on a 10.5% HR/PA
//   hitter — should be ~36% over 4 PAs).
//
//   This module compounds the per-PA rate across the hitter's expected PAs.
//
// EXPECTED PA BY LINEUP SLOT
//   Slot 1-2:  ~4.4 PA (leadoff gets the most ABs)
//   Slot 3-4:  ~4.2 PA
//   Slot 5-6:  ~4.0 PA
//   Slot 7-9:  ~3.7 PA
//   Unknown:   4.0 PA (league average)
//
// NOTE: These are EXPECTED PAs assuming a 9-inning game. Extra innings,
//   substitutions, or injury would change this — but the prop lines are set
//   for typical games, so this matches market behavior.
//
// "AT LEAST K" FORMULA
//   For events where individual PAs are roughly independent (HR, hits, XBH):
//     P(at least 1 in N PAs) = 1 - (1 - p)^N
//   For "at least 2" we use binomial: 1 - P(0) - P(1) where
//     P(j) = C(N,j) × p^j × (1-p)^(N-j)
//
// CAVEATS
//   - RBI and RUNS depend on teammates (RBI needs runners on; RUNS needs to
//     get on base AND for someone to drive you in). The per-PA "RBI event"
//     rate from computeXbhProbability is an approximation; compounding is
//     directionally right but not perfect.
//   - TB 1.5 means "at least 2 bases" which could be one 2B/3B/HR OR two
//     singles. We approximate as P(≥1 XBH) since the per-XBH rate dominates
//     for power hitters.

// =============================================================
// PRIME TIER CLASSIFIER (Phase 2 — May 29, 2026)
//
// PRIME is the marketing-grade tier. Picks here are the cohort validated
// at 70% WR on n=27 in the May 29 audit. Criteria require ALL of:
//
//   1. Regressed xwoba in 0.45–0.55 sweet spot
//   2. Context multiplier 1.05–1.15 (boosted but not runaway)
//   3. Inflation gap < 0.10
//   4. NOT capped (multiplier didn't hit the 0.80 ceiling)
//   5. NOT a form trap (SCORCHING + ctx > 1.10)
//   6. PASSED fade engine (high_fade auto-disqualifies)
//   7. NOT fragile (per computeFragility — small samples, weak arsenal, etc)
//
// Hard cap: max 2 PRIME per game in analyze.js, max 5 per slate at render.
// =============================================================
const PRIME_CRITERIA = Object.freeze({
  // (Drop #3 — May 30, 2026) Tightened from 0.45-0.55 to 0.48-0.54.
  // May 30 data analysis showed 73% WR on reg 0.51-0.54 (n=15) and
  // 65% WR on reg 0.48-0.54 (n=42) vs only 47% on the broader 0.45-0.55
  // band. Narrowing PRIME to the validated peak.
  REG_MIN: 0.48,
  REG_MAX: 0.54,
  CTX_MIN: 1.05,
  CTX_MAX: 1.15,
  MAX_INFLATION_GAP: 0.10,
  MAX_PER_GAME: 2,
});

function classifyPrimeTier(matchup, fadeResult) {
  const reasons = [];

  const reg = parseFloat(matchup.regressedMaxXwoba);
  const adj = parseFloat(matchup.adjustedMaxXwoba);
  const ctx = parseFloat(matchup.contextMultiplier);
  const capped = matchup.adjustedXwobaCapped;
  // Pull form label from either nested .recentForm.label or flat field
  const formLabel = matchup.recentForm?.label || matchup.recentFormLabel || null;
  const gap = (Number.isFinite(adj) && Number.isFinite(reg)) ? (adj - reg) : 0;

  if (!Number.isFinite(reg) || !Number.isFinite(adj) || !Number.isFinite(ctx)) {
    return { isPrime: false, rejectReason: 'missing_calibration_fields', score: null };
  }

  // === Criterion 1: regressed sweet spot ===
  if (reg < PRIME_CRITERIA.REG_MIN || reg >= PRIME_CRITERIA.REG_MAX) {
    reasons.push(`regressed_${reg.toFixed(3)}_outside_${PRIME_CRITERIA.REG_MIN}-${PRIME_CRITERIA.REG_MAX}`);
  }

  // === Criterion 2: context multiplier sweet spot ===
  if (ctx < PRIME_CRITERIA.CTX_MIN || ctx >= PRIME_CRITERIA.CTX_MAX) {
    reasons.push(`ctx_${ctx.toFixed(3)}_outside_${PRIME_CRITERIA.CTX_MIN}-${PRIME_CRITERIA.CTX_MAX}`);
  }

  // === Criterion 3: honest inflation gap ===
  if (gap >= PRIME_CRITERIA.MAX_INFLATION_GAP) {
    reasons.push(`inflation_gap_${gap.toFixed(3)}_too_wide`);
  }

  // === Criterion 4: not capped ===
  if (capped) {
    reasons.push('multiplier_capped');
  }

  // === Criterion 5: not a form trap ===
  if (formLabel === 'SCORCHING' && ctx > 1.10) {
    reasons.push('form_trap_scorching_inflated');
  }

  // === Criterion 6: fade engine passed ===
  // Note: fadeResult may not be available at qualification time
  // (it's computed at render). Defensive check — if absent, defer to render.
  if (fadeResult && fadeResult.tier === 'high_fade') {
    reasons.push('fade_engine_rejection');
  }

  // === Criterion 7: not fragile ===
  const frag = computeFragility(matchup);
  matchup.fragility = frag;  // surface for UI
  if (frag.level === 'moderate' || frag.level === 'fragile') {
    reasons.push(`fragility_${frag.level}`);
  }

  // === Criterion 8: PA opportunity floor (Drop #5 Fix #4 — May 31, 2026) ===
  // May 31 audit (n=181) showed winners avg 4.25 PA, losers 3.83 PA.
  // Bottom-of-order hitters (slot 7+) get 3.7 PA on average and miss
  // the cycle entirely in tight games — disqualify from PRIME regardless
  // of xwoba. Picks with projected PA < 4.0 are PA-disadvantaged.
  if (matchup._bottomOfOrder) {
    reasons.push(`bottom_of_order_slot_${matchup.battingOrder || '?'}`);
  }
  if (matchup._paDisadvantaged) {
    reasons.push(`pa_disadvantaged_proj_${(matchup._expectedPa || 0).toFixed(1)}`);
  }

  if (reasons.length > 0) {
    return { isPrime: false, rejectReason: reasons.join(';'), score: null };
  }

  // PRIME-eligible. Score for ranking when capping.
  const ctxProximity = 1 - Math.abs(ctx - 1.10) / 0.05;     // 1.0 at center, 0 at edges
  const regProximity = 1 - Math.abs(reg - 0.50) / 0.05;
  const gapCleanness = 1 - (gap / PRIME_CRITERIA.MAX_INFLATION_GAP);
  const score = (ctxProximity * 0.40) + (regProximity * 0.40) + (gapCleanness * 0.20);

  return { isPrime: true, rejectReason: null, score: Number(score.toFixed(3)) };
}

// =============================================================
// FRAGILITY CHECK (Phase 2 — May 29, 2026)
//
// Even within PRIME criteria, some picks are statistically fragile:
// small recent-form samples, near-cliff regressed values, weak arsenal
// coverage, near-caution K%. This function returns a fragility report;
// PRIME candidates with level=moderate or worse drop back to ELITE.
//
// Output: { score, level: 'solid'|'minor'|'moderate'|'fragile', issues }
// =============================================================
function computeFragility(matchup) {
  const issues = [];
  let score = 0;

  // Small recent form sample
  const rfPa = parseInt(matchup.recentForm?.paUsed) || parseInt(matchup.recentFormPaUsed) || 0;
  if (rfPa > 0 && rfPa < 20) {
    issues.push(`recent_form_pa_${rfPa}`);
    score += 1;
  }

  // Edge of context bucket — too close to the danger zone
  const ctx = parseFloat(matchup.contextMultiplier) || 1.0;
  if (ctx > 1.13) {
    issues.push(`ctx_near_inflation_${ctx.toFixed(3)}`);
    score += 1;
  }

  // Weak arsenal coverage (insufficient PA vs main pitches)
  const matched = matchup.matchedPitches || [];
  const mainPitchPaTotal = matched
    .filter(p => parseFloat(p.pitcherUsage) >= 15)
    .reduce((sum, p) => sum + (parseInt(p.hitterPa) || 0), 0);
  if (mainPitchPaTotal > 0 && mainPitchPaTotal < 30) {
    issues.push(`arsenal_pa_${mainPitchPaTotal}`);
    score += 1;
  }

  // Bottom of the PRIME regressed range — closer to the cliff
  const reg = parseFloat(matchup.regressedMaxXwoba) || 0;
  if (reg > 0 && reg < 0.47) {
    issues.push(`reg_near_bottom_${reg.toFixed(3)}`);
    score += 1;
  }

  // Matched K% near caution threshold
  const matchedK = parseFloat(matchup.matchedHitterK);
  if (Number.isFinite(matchedK) && matchedK > 25) {
    issues.push(`matched_k_${matchedK.toFixed(1)}`);
    score += 1;
  }

  let level;
  if (score === 0) level = 'solid';
  else if (score === 1) level = 'minor';
  else if (score === 2) level = 'moderate';
  else level = 'fragile';

  return { score, level, issues };
}

// =============================================================
// HITS-OVER-HRR PREFERENCE (Phase 2 — May 29, 2026)
//
// May 29 audit: same hitter pool went 58% on HITS vs 42% on HRR
// (n=26 / n=143). The 16pt gap reflects the "lineup conversion"
// failure mode for HRR that HITS doesn't have.
//
// Until the lineupSupport factor proves it closed the HRR gap,
// when both H and HRR are eligible and within 10 probability
// points, prefer H. Respects the model when HRR is dramatically
// stronger (>10pt gap = model signaling something concrete).
// =============================================================
function applyHitsOverHrrPreference(propRecs) {
  if (!propRecs || propRecs.length < 2) return;

  const currentBest = propRecs.find(p => p.isBest);
  if (!currentBest || currentBest.key !== 'HRR') return;

  const hitsAlt = propRecs.find(p => p.key === 'H');
  if (!hitsAlt || !hitsAlt.probability) return;

  const hrrProb = currentBest.probability || 0;
  const hitsProb = hitsAlt.probability || 0;

  // Only flip if HITS is reasonable (>= 0.45) AND within 10pts of HRR
  if (hitsProb >= 0.45 && (hrrProb - hitsProb) < 0.10) {
    currentBest.isBest = false;
    hitsAlt.isBest = true;
    hitsAlt._hitsPreferenceApplied = true;
    hitsAlt._hitsPreferenceReason = `HRR_prob_${hrrProb.toFixed(2)}_HITS_prob_${hitsProb.toFixed(2)}_within_10pts`;
  }
}

function expectedPaForLineupSlot(slot) {
  const s = parseInt(slot) || 0;
  if (s === 1 || s === 2) return 4.4;
  if (s === 3 || s === 4) return 4.2;
  if (s === 5 || s === 6) return 4.0;
  if (s >= 7 && s <= 9) return 3.7;
  return 4.0;  // unknown lineup slot
}

/**
 * Compound a per-PA probability into a per-game "at least K" probability.
 *
 * @param {number} pPerPa  - Per-PA rate (0-1)
 * @param {number} expectedPa - Expected plate appearances in the game
 * @param {number} k       - Threshold ("at least k"). 1 for 0.5 lines, 2 for 1.5 lines.
 * @returns {number} Per-game probability of at least k events.
 */
function compoundPerPaToGame(pPerPa, expectedPa, k = 1) {
  if (!Number.isFinite(pPerPa) || pPerPa <= 0) return 0;
  if (!Number.isFinite(expectedPa) || expectedPa <= 0) return 0;
  // Clamp probability to avoid pathological inputs blowing up
  const p = Math.min(0.85, Math.max(0, pPerPa));
  const n = Math.max(1, Math.min(8, expectedPa));  // 1-8 PA realistic bounds

  if (k <= 1) {
    // P(at least 1) = 1 - P(0) = 1 - (1-p)^n
    return 1 - Math.pow(1 - p, n);
  }
  // P(at least k) via binomial — accumulate P(0..k-1) and subtract from 1
  // For our use cases k is small (≤3), so this is cheap.
  let cumulativeBelow = 0;
  for (let j = 0; j < k; j++) {
    cumulativeBelow += binomialPmf(n, j, p);
  }
  return Math.max(0, 1 - cumulativeBelow);
}

/**
 * Binomial PMF with non-integer n (using gamma function approximation).
 * For our case n is between 3.7 and 4.4 — non-integer. We use the standard
 * trick: compute C(n,k) via the Beta function relationship.
 * For small k (0, 1, 2, 3) we can just inline the formula.
 */
function binomialPmf(n, k, p) {
  if (k === 0) return Math.pow(1 - p, n);
  if (k === 1) return n * p * Math.pow(1 - p, n - 1);
  if (k === 2) return (n * (n - 1) / 2) * p * p * Math.pow(1 - p, n - 2);
  if (k === 3) return (n * (n - 1) * (n - 2) / 6) * Math.pow(p, 3) * Math.pow(1 - p, n - 3);
  // For k≥4 we'd need a real gamma function; not needed for current prop lines
  return 0;
}

/**
 * Parse a prop label like "HR 0.5" or "TB 1.5" and return the threshold k.
 * "0.5" → 1 (at least 1), "1.5" → 2, "2.5" → 3.
 */
function thresholdFromLine(label) {
  if (!label) return 1;
  const m = String(label).match(/(\d+\.?\d*)/);
  if (!m) return 1;
  const lineValue = parseFloat(m[1]);
  if (!Number.isFinite(lineValue)) return 1;
  // Line is "over 0.5" → need 1, "over 1.5" → need 2, "over 2.5" → need 3
  return Math.floor(lineValue) + 1;
}

function buildPropRecommendations({ hitter, matchedPitches, maxXwoba, overall, parkFactor, adjustments, tier, bullpenMaxXwoba, bullpenTier, teamEcosystem, gameTotal }) {
  if (!tier || matchedPitches.length === 0) return [];

  // === CONTACT PROBABILITY ENGINE (May 18, 2026) — SHADOW MODE ===
  // Runs alongside existing heuristic scoring. Outputs attach to each prop
  // so the UI can display probability and audit log captures it for backtesting.
  // Existing `score` still drives selection. After backtest validation, flip
  // selection to use probability. See contactProbability.js for the engine.
  const _pitcherInfo = matchedPitches[0] || {};
  const _umpFavor = (adjustments || []).find(a => a.type === 'umpire')?.favor || null;

  // ARSENAL-WEIGHTED K AND WHIFF RATES (May 18, 2026)
  // Sportsbooks bake hitter-vs-arsenal-K-rate into prop lines. Season K% misses it.
  // For each pitch the pitcher throws, weight hitter's K% AGAINST THAT PITCH by
  // how often the pitcher uses it. Sum = expected K% for this matchup.
  // Same for whiff%. Both fall back to null if pitch-type data is missing — the
  // engine's contact layer handles nulls by falling back to season-K only.
  let _matchedKSum = 0, _matchedKWeight = 0;
  let _matchedWhiffSum = 0, _matchedWhiffWeight = 0;
  let _matchedPitcherKSum = 0, _matchedPitcherKWeight = 0;
  // PITCHER ALLOWED-CONTACT AGGREGATION (May 18 fix)
  // Replaces silent defaults that previously zeroed Layer 2 pitcher suppression.
  // Each pitch's allowed stat is usage-weighted across the pitcher's mix, with
  // independent weight tracking per stat so partial coverage degrades gracefully.
  let _allowedHhSum = 0, _allowedHhWeight = 0;
  let _allowedEvSum = 0, _allowedEvWeight = 0;
  let _allowedBarSum = 0, _allowedBarWeight = 0;
  // ALLOWED BA/SLG (added May 23, 2026)
  // The upstream pitch-arsenal payload exposes ba and slg per pitch but not
  // EV/barrel. These two aggregations replace the missing EV/BAR coverage
  // and feed Layer 2's pitcher suppression branch.
  let _allowedBaSum = 0, _allowedBaWeight = 0;
  let _allowedSlgSum = 0, _allowedSlgWeight = 0;
  for (const mp of matchedPitches) {
    const usage = parseFloat(mp.pitcherUsage || 0) / 100;
    if (usage <= 0) continue;
    if (mp.hitterKPct != null && Number.isFinite(mp.hitterKPct)) {
      _matchedKSum += mp.hitterKPct * usage;
      _matchedKWeight += usage;
    }
    if (mp.hitterWhiffPct != null && Number.isFinite(mp.hitterWhiffPct)) {
      _matchedWhiffSum += mp.hitterWhiffPct * usage;
      _matchedWhiffWeight += usage;
    }
    if (mp.pitcherKPct != null && Number.isFinite(mp.pitcherKPct)) {
      _matchedPitcherKSum += mp.pitcherKPct * usage;
      _matchedPitcherKWeight += usage;
    }
    if (mp.pitcherAllowedHardHit != null && Number.isFinite(mp.pitcherAllowedHardHit)) {
      _allowedHhSum += mp.pitcherAllowedHardHit * usage;
      _allowedHhWeight += usage;
    }
    if (mp.pitcherAllowedEv != null && Number.isFinite(mp.pitcherAllowedEv)) {
      _allowedEvSum += mp.pitcherAllowedEv * usage;
      _allowedEvWeight += usage;
    }
    if (mp.pitcherAllowedBarrel != null && Number.isFinite(mp.pitcherAllowedBarrel)) {
      _allowedBarSum += mp.pitcherAllowedBarrel * usage;
      _allowedBarWeight += usage;
    }
    if (mp.pitcherAllowedBa != null && Number.isFinite(mp.pitcherAllowedBa)) {
      _allowedBaSum += mp.pitcherAllowedBa * usage;
      _allowedBaWeight += usage;
    }
    if (mp.pitcherAllowedSlg != null && Number.isFinite(mp.pitcherAllowedSlg)) {
      _allowedSlgSum += mp.pitcherAllowedSlg * usage;
      _allowedSlgWeight += usage;
    }
  }
  // Normalize: divide by weight covered. If pitcher's arsenal only has 70% of pitches
  // with data, normalize against that 70% so the rate reflects the data we have.
  const _matchedHitterK = _matchedKWeight > 0 ? _matchedKSum / _matchedKWeight : null;
  const _matchedHitterWhiff = _matchedWhiffWeight > 0 ? _matchedWhiffSum / _matchedWhiffWeight : null;
  const _matchedPitcherK = _matchedPitcherKWeight > 0 ? _matchedPitcherKSum / _matchedPitcherKWeight : null;
  const _pitcherAllowedHardHit = _allowedHhWeight > 0 ? _allowedHhSum / _allowedHhWeight : null;
  const _pitcherAllowedEv = _allowedEvWeight > 0 ? _allowedEvSum / _allowedEvWeight : null;
  const _pitcherAllowedBarrel = _allowedBarWeight > 0 ? _allowedBarSum / _allowedBarWeight : null;
  const _pitcherAllowedBa = _allowedBaWeight > 0 ? _allowedBaSum / _allowedBaWeight : null;
  const _pitcherAllowedSlg = _allowedSlgWeight > 0 ? _allowedSlgSum / _allowedSlgWeight : null;

  const _engineInputs = {
    hitter: {
      // Use arsenal-matched K% when available, season K% otherwise.
      // Matched K% is the strongest signal: it answers "how often does THIS hitter
      // strike out against THIS pitcher's pitch mix" rather than season average.
      kPct: _matchedHitterK != null ? _matchedHitterK : parseFloat(overall.k_percent?.value || 22.5),
      seasonKPct: parseFloat(overall.k_percent?.value || 22.5),
      matchedKPct: _matchedHitterK,
      matchedWhiffPct: _matchedHitterWhiff,
      barrelPct: parseFloat(overall.barrel_batted_rate?.value || 8),
      hardHitPct: parseFloat(overall.hard_hit_percent?.value || 38),
      avgEv: parseFloat(overall.avg_exit_velocity?.value || 88.5),
      xwoba: parseFloat(overall.xwoba?.value || 0.315),
      ldPct: parseFloat(overall.line_drive_percent?.value || overall.ld_percent?.value || 21),
      fbPct: parseFloat(overall.fly_ball_percent?.value || overall.fb_percent?.value || 24),
      pullPct: parseFloat(overall.pull_percent?.value || 40),
      sprintSpeed: parseFloat(overall.sprint_speed?.value || (hitter && hitter.sprintSpeed) || 27)
    },
    pitcher: {
      // Pitcher K%: use arsenal-weighted K% across pitch types when available
      kPct: _matchedPitcherK != null ? _matchedPitcherK : parseFloat(_pitcherInfo.pitcherKPct || _pitcherInfo.kPct || 22.5),
      seasonKPct: parseFloat(_pitcherInfo.pitcherKPct || _pitcherInfo.kPct || 22.5),
      matchedKPct: _matchedPitcherK,
      // PITCHER ALLOWED-CONTACT (May 18 fix)
      // Pass null when missing — engine's pitcherDataPoints counter tracks coverage.
      // DO NOT default to league baselines (38/88.5/7.5): that silently zeroed Layer 2
      // pitcher suppression because (value - baseline) = 0 for every pitcher.
      allowedHardHit: _pitcherAllowedHardHit,
      allowedEv: _pitcherAllowedEv,
      allowedBarrel: _pitcherAllowedBarrel,
      // BA/SLG ALLOWED (added May 23, 2026)
      // The upstream pitch-arsenal payload exposes ba and slg per pitch but
      // NOT exit velocity or barrel rate. Layer 2's pitcher suppression branch
      // reads these as the practical signals — calibrated coefficients in
      // contactProbability.js produce ~0.009 deviation at typical deltas, in
      // the same magnitude band as HH/EV/BAR so no signal dominates.
      allowedBa: _pitcherAllowedBa,
      allowedSlg: _pitcherAllowedSlg
    },
    matchedXwoba: parseFloat(maxXwoba || 0) || null,
    parkBoosts: {
      runs: parkFactor ? (parkFactor.runs || 100) / 100 : 1.0,
      hr: parkFactor
        ? ((hitter && hitter.hand === 'L') ? (parkFactor.lhbHr || 100) : (parkFactor.rhbHr || 100)) / 100
        : 1.0
    },
    ump: { favor: _umpFavor }
  };

  let _pHit = null, _pHr = null, _pXbh = null;
  try {
    _pHit = computeHitProbability(_engineInputs);
    _pHr  = computeHrProbability(_engineInputs);
    _pXbh = computeXbhProbability(_engineInputs);
  } catch (err) {
    console.warn('[contactEngine] computation failed:', err.message);
  }
  // === END CONTACT PROBABILITY ENGINE ===

  // === COMPOUND PROBABILITY ENGINE (May 23, 2026) ===
  //
  // Builds per-game probabilities for compound props that depend on multiple
  // stat categories at once:
  //   - H+R+RBI ≥ 1.5 and ≥ 2.5
  //   - PrizePicks Fantasy Score ≥ 6, ≥ 7, ≥ 8
  //   - Underdog Fantasy Score ≥ 5, ≥ 6, ≥ 7
  //
  // Method: Monte Carlo simulation (5000 trials per hitter, ~5-10ms cost).
  //   - Builds per-PA event distribution from contact engine outputs + Statcast
  //     walk/HBP rates
  //   - Simulates expected PAs per game using lineup-slot-based expected PA
  //   - Tallies H, R, RBI, BB, HR, doubles, triples, K, SB per trial
  //   - Computes HRR and FS distributions, extracts probabilities at thresholds
  //
  // FS scoring weights from confirmed PP/UD scoring tables (May 23, 2026).
  //
  // Inputs:
  //   - pHit, pHr, pXbh from contact engine (per-PA rates)
  //   - hitterKPct from matched K% (or season fallback)
  //   - hitterBBPct from Statcast bb_percent
  //   - hitterHbpPct from Statcast hbp_percent (fallback ~1.2%)
  //   - sprintSpeed from Statcast sprint_speed
  //   - expectedPa from lineup slot (computed via helper)
  //
  // Gracefully returns null if contact engine outputs are unavailable —
  // compound props then fall back to score-based selection.
  let _pCompound = null;
  if (_pHit || _pHr || _pXbh) {
    try {
      _pCompound = computeCompoundProbabilities({
        // Contact engine outputs (per-PA rates) — null-safe
        pHit: _pHit?.probability,
        pHr:  _pHr?.probability,
        pXbh: _pXbh?.probability,
        // Hitter season rates from Statcast overall
        hitterKPct: _matchedHitterK != null
          ? _matchedHitterK
          : parseFloat(overall.k_percent?.value || 22.5),
        hitterBBPct: parseFloat(overall.bb_percent?.value || 8.5),
        hitterHbpPct: parseFloat(overall.hbp_percent?.value || 1.2),
        sprintSpeed: parseFloat(overall.sprint_speed?.value || 27),
        // Game context
        expectedPa: expectedPaForLineupSlot(hitter?.battingOrder),
        // TEAM ECOSYSTEM (May 23, 2026) — phases out fragile-offense false positives
        //
        // teamEcosystem comes from the parent analyzeGame ecosystem fetch.
        // null is acceptable — engine falls back to league averages but applies
        // an uncertainty penalty in fragility scoring.
        //
        // opposingPitcherKPct uses _matchedPitcherK (arsenal-weighted) when
        // available — most accurate signal for THIS pitcher vs THIS lineup,
        // not season average.
        //
        // gameTotal is the market line (8.5 = league avg). When unavailable
        // (typical at prop-build time before odds are awaited), null is
        // graceful — engine uses pitcher K + ecosystem alone to adjust PA.
        teamEcosystem,
        opposingPitcherKPct: _matchedPitcherK != null
          ? _matchedPitcherK
          : parseFloat(_pitcherInfo.pitcherKPct || _pitcherInfo.kPct || 22.5),
        gameTotal
      });
    } catch (err) {
      console.warn('[compoundEngine] computation failed:', err.message);
    }
  }
  // === END COMPOUND PROBABILITY ENGINE ===

  const barrel = parseFloat(overall.barrel_batted_rate?.value || 0);
  const hardHit = parseFloat(overall.hard_hit_percent?.value || 0);
  const ev = parseFloat(overall.avg_exit_velocity?.value || 0);
  const kPct = parseFloat(overall.k_percent?.value || 22);
  const seasonXwoba = parseFloat(overall.xwoba?.value || 0);
  const maxXslg = matchedPitches.reduce((max, mp) => {
    const x = parseFloat(mp.hitterXslg || 0);
    return x > max ? x : max;
  }, 0);

  // BULLPEN SUPPRESSION (May 23, 2026 — Item 5: continuous replacement)
  //
  // Previously a 4-step staircase that produced 7% jumps in boost for tiny
  // xwOBA differences (0.329 → 1.03x, 0.331 → 1.10x). Replaced with linear
  // interpolation over the same magnitude range so neighboring bullpens with
  // similar real performance get similar treatment.
  //
  // Range anchors (preserved from staircase):
  //   bpX = 0.250 (very weak BP) → 0.94x  (slight suppression vs neutral)
  //   bpX = 0.310 (mid)          → 1.06x  (mild boost)
  //   bpX = 0.380 (very strong)  → 1.18x  (full boost)
  //
  //   bpX = 0 (no data) → 1.0x (neutral fallback)
  //
  // Full-game props (HRR, FS, TB, RBI, R) use the larger range (0.94–1.18)
  // because they accumulate over 5-6 BP innings. Event props (HR, hit) use
  // a compressed range (0.97–1.10) because one event in the whole game is
  // enough — late-inning exposure matters less.
  const bpX = bullpenMaxXwoba || 0;
  let bpFullGameBoost, bpEventBoost;
  if (bpX === 0) {
    // No bullpen data at all — neutral
    bpFullGameBoost = 1.0;
    bpEventBoost = 1.0;
  } else {
    // Linear interpolation. t ∈ [0,1] over the band [0.250, 0.380]
    const t = Math.max(0, Math.min(1, (bpX - 0.250) / (0.380 - 0.250)));
    // Full-game: 0.94 → 1.18 (range 0.24)
    bpFullGameBoost = 0.94 + t * 0.24;
    // Event: 0.97 → 1.10 (range 0.13)
    bpEventBoost = 0.97 + t * 0.13;
  }

  // Park factor helpers
  const hrParkBoost = parkFactor
    ? (hitter.hand === 'L' ? (parkFactor.lhbHr || 100) : (parkFactor.rhbHr || 100)) / 100
    : 1.0;
  const runParkBoost = parkFactor ? (parkFactor.runs || 100) / 100 : 1.0;
  const hitterFriendlyUmp = adjustments.some(a => a.type === 'umpire' && a.favor === 'hitter');

  // ---- Score each prop type ----
  // Scoring scale 0-100. Higher = stronger play.

  // HIT prop — hitter gets at least 1 hit (single-event, small boost)
  let hitScore = 0;
  hitScore += maxXwoba * 100;
  hitScore += (seasonXwoba * 50);
  hitScore += (hardHit / 2);
  hitScore -= Math.max(0, (kPct - 20)) * 1.2;
  hitScore += runParkBoost > 1.03 ? 8 : 0;
  hitScore += hitterFriendlyUmp ? 4 : 0;
  hitScore *= bpEventBoost;

  // HR prop — single event; small bullpen boost
  let hrScore = 0;
  if (barrel >= 8) hrScore += barrel * 2;
  if (ev >= 90) hrScore += (ev - 88) * 3;
  hrScore += maxXslg * 60;
  if (hrParkBoost >= 1.05) hrScore += (hrParkBoost - 1) * 80;
  if (hrParkBoost <= 0.92) hrScore -= (1 - hrParkBoost) * 60;
  hrScore -= Math.max(0, (kPct - 25)) * 0.6;
  hrScore *= bpEventBoost;

  // TB prop — accumulates over game, full bullpen boost
  let tbScore = 0;
  tbScore += maxXslg * 80;
  tbScore += barrel * 1.3;
  tbScore += maxXwoba * 40;
  tbScore += hardHit / 3;
  if (hrParkBoost >= 1.05) tbScore += (hrParkBoost - 1) * 40;
  tbScore -= Math.max(0, (kPct - 22)) * 0.8;
  tbScore *= bpFullGameBoost;

  // RBI prop — accumulates
  let rbiScore = 0;
  rbiScore += maxXwoba * 90;
  rbiScore += barrel * 0.8;
  rbiScore += maxXslg * 25;
  rbiScore += runParkBoost > 1.03 ? 10 : 0;
  rbiScore += hitterFriendlyUmp ? 5 : 0;
  rbiScore -= Math.max(0, (kPct - 22)) * 0.6;
  rbiScore *= bpFullGameBoost;

  // R prop — accumulates
  let rScore = 0;
  rScore += maxXwoba * 80;
  rScore += (seasonXwoba * 40);
  rScore += runParkBoost > 1.03 ? 8 : 0;
  rScore -= Math.max(0, (kPct - 22)) * 0.9;
  rScore *= bpFullGameBoost;

  // HRR 1.5 — multi-pathway over, heavily benefits from bullpen edge
  const hrr = (Math.max(hitScore * 0.9, rbiScore * 0.85, rScore * 0.85) + 8) * bpFullGameBoost;

  // Fantasy score projection - estimate points from signals
  // Rough heuristic: expected PA ~4, weight by contact & power profile
  const estSingles = maxXwoba * 1.2;       // ~xwOBA converted to contact rate
  const estXBH = maxXslg * 0.6;            // extra-base hits
  const estHR = (barrel / 100) * 0.4;      // barrel-based HR rate per PA
  const estR = maxXwoba * 0.8 * runParkBoost;
  const estRBI = maxXwoba * 0.9 * runParkBoost;
  const estBB = Math.max(0, (parseFloat(overall.bb_percent?.value || 8) / 100)) * 4;
  // Raw FS projection from signals (starter exposure only)
  const rawProjFS = (estSingles * 3) + (estXBH * 6) + (estHR * 10) + (estR * 2) + (estRBI * 2) + (estBB * 2);
  // Bullpen-adjusted FS projection — bullpen drives ~40% of total PA exposure
  const projFS = rawProjFS * bpFullGameBoost;

  // PP/UD Fantasy Score props - score based on how comfortably we clear the line
  const fs_pp6 = (projFS - 6) * 12 + 40;
  const fs_pp8 = (projFS - 8) * 12 + 30;
  const fs_ud5 = (projFS - 5) * 12 + 42;
  const fs_ud7 = (projFS - 7) * 12 + 32;

  // Bullpen tag for reason strings
  const bpTag = bullpenTier === 'elite' ? ' · bullpen crush' :
                bullpenTier === 'strong' ? ' · bullpen edge' :
                bullpenTier === 'solid' ? ' · bullpen solid' :
                bpX > 0 && bpX < 0.290 ? ' · bullpen tough' : '';

  const allProps = [
    { key: 'H',        label: 'HITS 0.5',       platform: 'BOTH', score: hitScore,   reason: hitReason(maxXwoba, kPct, hardHit, runParkBoost) + bpTag },
    { key: 'HR',       label: 'HR 0.5',         platform: 'BOTH', score: hrScore,    reason: hrReason(barrel, ev, maxXslg, hrParkBoost, hitter.hand, parkFactor) + bpTag },
    // TB 1.5 disabled by default — see TB_PROP_ENABLED flag definition near top of file.
    // Scoped to ELITE_POWER archetype hitters only after Damage Quality Phase 2 ships.
    ...(TB_PROP_ENABLED ? [
    { key: 'TB',       label: 'TB 1.5',         platform: 'BOTH', score: tbScore,    reason: tbReason(maxXslg, barrel, hrParkBoost) + bpTag },
    ] : []),
    { key: 'RBI',      label: 'RBI 0.5',        platform: 'BOTH', score: rbiScore,   reason: rbiReason(maxXwoba, barrel, runParkBoost) + bpTag },
    { key: 'R',        label: 'RUNS 0.5',       platform: 'BOTH', score: rScore,     reason: rReason(maxXwoba, kPct, runParkBoost) + bpTag },
    { key: 'HRR',      label: 'H+R+RBI 1.5',    platform: 'PP',   score: hrr,        reason: 'Multiple pathways to over' + bpTag },
    { key: 'PP_FS_6',  label: 'PP FS 6',        platform: 'PP',   score: fs_pp6,     reason: `Projected ~${projFS.toFixed(1)} pts${bpTag}` },
    { key: 'PP_FS_8',  label: 'PP FS 8',        platform: 'PP',   score: fs_pp8,     reason: `Projected ~${projFS.toFixed(1)} pts${bpTag}` },
    { key: 'UD_FS_5',  label: 'UD FS 5',        platform: 'UD',   score: fs_ud5,     reason: `Projected ~${projFS.toFixed(1)} pts${bpTag}` },
    { key: 'UD_FS_7',  label: 'UD FS 7',        platform: 'UD',   score: fs_ud7,     reason: `Projected ~${projFS.toFixed(1)} pts${bpTag}` }
  ];

  // PARALLEL ENGINE SELECTION (May 23, 2026)
  //
  // Previously: sort by score, take top 4, attach probabilities to survivors.
  //   Problem: when the client toggled to PROB mode, the probability engine
  //   could only re-rank within score's pre-selected top 4. If a prop had
  //   strong probability but mediocre score (e.g. RUNS 0.5 with 78% per-game
  //   probability), it never reached the client because score's top 4 didn't
  //   include it.
  //
  // Now: attach probabilities to ALL props first, then take the UNION of:
  //   - top 4 by score (existing behavior, drives default SCORE engine)
  //   - top 4 by probability (drives the new PROB engine)
  //
  // Union size is typically 4-6 props (high overlap), worst case 8. Each
  // engine's top 4 is guaranteed available to the client. The client's
  // applyMlbEngineRanking() in index.html re-orders and picks ★ BEST.

  // Step 1: Attach probabilities to ALL props (not just the top 4).
  //
  // The engine outputs per-PA probabilities. Props are per-game "at least N"
  // lines. We compound across the hitter's expected PAs (varies by lineup
  // slot, defaults to 4.0 PA). The per-PA rate is preserved in the audit so
  // we can see both.
  //
  // Different prop keys consume different probability outputs:
  //   H, R       → P(Hit) — at least one hit / accumulates from PA hits
  //   HR         → P(HR)
  //   TB, RBI    → P(XBH) — extra-base-hit probability (most predictive)
  //   HRR        → compound engine P(H+R+RBI ≥ 2)  [added May 23, 2026]
  //   PP_FS_6/8  → compound engine P(PP Fantasy Score ≥ line)
  //   UD_FS_5/7  → compound engine P(UD Fantasy Score ≥ line)
  const _ePa = expectedPaForLineupSlot(hitter?.battingOrder);
  allProps.forEach(p => {
    const _kThreshold = thresholdFromLine(p.label);
    if (_pHit && p.key === 'H') {
      p.probability = compoundPerPaToGame(_pHit.probability, _ePa, _kThreshold);
      p.probabilityBaseline = _pHit.baseline;
      p.probabilityPerPa = _pHit.probability;
      p.expectedPa = _ePa;
    }
    else if (_pHit && p.key === 'R') {
      p.probability = compoundPerPaToGame(_pHit.probability, _ePa, _kThreshold);
      p.probabilityBaseline = _pHit.baseline;
      p.probabilityPerPa = _pHit.probability;
      p.expectedPa = _ePa;
    }
    else if (_pHr && p.key === 'HR') {
      p.probability = compoundPerPaToGame(_pHr.probability, _ePa, _kThreshold);
      p.probabilityBaseline = _pHr.baseline;
      p.probabilityPerPa = _pHr.probability;
      p.expectedPa = _ePa;
    }
    else if (_pXbh && p.key === 'TB') {
      p.probability = compoundPerPaToGame(_pXbh.probability, _ePa, _kThreshold);
      p.probabilityBaseline = _pXbh.baseline;
      p.probabilityPerPa = _pXbh.probability;
      p.expectedPa = _ePa;
    }
    else if (_pXbh && p.key === 'RBI') {
      p.probability = compoundPerPaToGame(_pXbh.probability, _ePa, _kThreshold);
      p.probabilityBaseline = _pXbh.baseline;
      p.probabilityPerPa = _pXbh.probability;
      p.expectedPa = _ePa;
    }
    // COMPOUND PROPS (May 23, 2026)
    // Use Monte Carlo simulator's per-game probabilities directly. These are
    // already per-game (1.5 lines, FS lines), no further compounding needed.
    else if (_pCompound && p.key === 'HRR') {
      // H+R+RBI 1.5 → P(H+R+RBI ≥ 2)
      p.probability = _pCompound.hrr.p15;
      p.probabilityBaseline = null;  // no clean per-PA baseline for compound
      p.expectedPa = _ePa;
      p.compoundExpected = _pCompound.hrr.expected;
    }
    else if (_pCompound && p.key === 'PP_FS_6') {
      p.probability = _pCompound.ppFs.p6;
      p.expectedPa = _ePa;
      p.compoundExpected = _pCompound.ppFs.expected;
    }
    else if (_pCompound && p.key === 'PP_FS_8') {
      p.probability = _pCompound.ppFs.p8;
      p.expectedPa = _ePa;
      p.compoundExpected = _pCompound.ppFs.expected;
    }
    else if (_pCompound && p.key === 'UD_FS_5') {
      p.probability = _pCompound.udFs.p5;
      p.expectedPa = _ePa;
      p.compoundExpected = _pCompound.udFs.expected;
    }
    else if (_pCompound && p.key === 'UD_FS_7') {
      p.probability = _pCompound.udFs.p7;
      p.expectedPa = _ePa;
      p.compoundExpected = _pCompound.udFs.expected;
    }

    // FRAGILITY ATTACHMENT (May 23, 2026)
    //
    // Attach fragility metadata to EVERY prop when the compound engine ran.
    // Fragility describes the ecosystem the hitter is embedded in — that
    // applies equally to compound props (HRR, FS) AND single-stat props
    // (HITS, R, RBI). A Sheets HITS 0.5 over is fragile for the same reason
    // a Sheets HRR 1.5 over is fragile: low team OBP suppresses PA count,
    // which suppresses per-game probability across every prop.
    //
    // Client uses `p.fragility.eliminationTier` to refuse the ★ BEST badge
    // on props with tier='eliminated' regardless of nominal probability.
    if (_pCompound) {
      p.fragility = {
        score: _pCompound.fragility.score,
        tier: _pCompound.fragility.eliminationTier,
        pathwayDiversity: _pCompound.pathways.diversity
      };
    }

    // Audit fields — always attached when contact engine ran successfully,
    // regardless of whether this specific prop is one of the H/R/HR/TB/RBI
    // keys that gets a probability.
    if (_pHit || _pHr || _pXbh) {
      p._engineAudit = {
        pHit: _pHit?.probability,
        pHitQuality: _pHit?.quality,
        pHr: _pHr?.probability,
        pXbh: _pXbh?.probability,
        layers: {
          contact: _pHit?.layers?.contact?.deviation,
          quality: _pHit?.layers?.quality?.deviation,
          conversion: _pHit?.layers?.conversion?.deviation
        },
        // ARSENAL-MATCHED RATES — surface these so we can see where the signal
        // diverges from season averages. Useful for diagnosing and for UI display.
        matchedHitterK: _matchedHitterK,
        matchedHitterWhiff: _matchedHitterWhiff,
        matchedPitcherK: _matchedPitcherK,
        seasonHitterK: parseFloat(overall.k_percent?.value || 22.5),
        kRateGapVsSeason: _matchedHitterK != null
          ? Number((_matchedHitterK - parseFloat(overall.k_percent?.value || 22.5)).toFixed(2))
          : null,
        // PITCHER ALLOWED-CONTACT WIRING (May 18 fix diagnostic)
        // Non-null means Layer 2 pitcher suppression is computing real deviation;
        // null means the upstream arsenal payload doesn't expose these field names
        // and we need to inspect getPitcherArsenal output. Engine's
        // _pHit.layers.quality.components.pitcherDataPoints will then read > 0.
        pitcherAllowedHardHit: _pitcherAllowedHardHit,
        pitcherAllowedEv: _pitcherAllowedEv,
        pitcherAllowedBarrel: _pitcherAllowedBarrel,
        // BA/SLG ALLOWED (added May 23, 2026) — surfaced for UI L2 chip
        pitcherAllowedBa: _pitcherAllowedBa,
        pitcherAllowedSlg: _pitcherAllowedSlg,
        pitcherAllowedWired: (_pitcherAllowedHardHit != null
                              || _pitcherAllowedEv != null
                              || _pitcherAllowedBarrel != null
                              || _pitcherAllowedBa != null
                              || _pitcherAllowedSlg != null),
        // L2 DIAGNOSTIC (May 23, 2026 — TEMPORARY)
        // First matched pitch's raw key names. When L2 is PARTIAL or OFF, the
        // UI chip displays these so we can see what field names the upstream
        // arsenal payload IS exposing. Add the matching names to the per-pitch
        // probe lookup in this file (~lines 488-497) to wire L2 to WIRED.
        // Remove this field when L2 is confirmed WIRED across the slate.
        _firstPitchKpKeys: (matchedPitches[0] && matchedPitches[0]._kpKeys) || [],
        // COMPOUND PROBABILITY SUMMARY (May 23, 2026)
        // Full Monte Carlo output for diagnostics. Used by UI to show
        // expected fantasy score / distribution percentiles on prop tooltips.
        // Extended (May 23, 2026 — structural overhaul):
        //   pathways  → which pathways cleared the prop (diagnoses fragility)
        //   fragility → 0-100 score + tier (eligible/caution/eliminated)
        //   ecosystem → team OBP/R/G used to adjust expectedPa
        compound: _pCompound ? {
          hrr: _pCompound.hrr,
          ppFs: _pCompound.ppFs,
          udFs: _pCompound.udFs,
          pathways: _pCompound.pathways,
          fragility: _pCompound.fragility,
          ecosystem: _pCompound.audit.teamEcosystem,
          expectedPaAdjustment: _pCompound.audit.expectedPaAdjustment,
          nTrials: _pCompound.audit.nTrials
        } : null
      };
    }
  });

  // Step 2: Compute both top 4s, build union.
  //
  // Score top 4: existing behavior — uses heuristic scores
  // Probability top 4: filters to props with valid probability values.
  //   With the compound engine (May 23, 2026), HRR / PP_FS_* / UD_FS_* now
  //   have probabilities, so they're eligible for PROB engine selection.
  //   The PROB engine can now genuinely pick compound props as top.
  const byScore = [...allProps].sort((a, b) => (b.score || 0) - (a.score || 0));
  const byProb = [...allProps]
    .filter(p => Number.isFinite(p.probability))
    .sort((a, b) => (b.probability || 0) - (a.probability || 0));

  const scoreTop4 = byScore.slice(0, 4);
  const probTop4 = byProb.slice(0, 4);

  // Union via Set (object identity dedup — we're holding the same prop refs)
  const unionSet = new Set([...scoreTop4, ...probTop4]);
  // Re-sort the union by score so the wire format remains stable (clients that
  // don't apply the toggle will see score order, matching legacy behavior).
  // The client's applyMlbEngineRanking() will re-order based on the active toggle.
  const ranked = [...unionSet].sort((a, b) => (b.score || 0) - (a.score || 0));

  // Step 3: Tag rank and isBest. These reflect SCORE engine (default), since
  // SCORE is the safe default and clients without the toggle code see this.
  // Client's applyMlbEngineRanking() overrides isBest based on the active toggle.
  ranked.forEach((p, i) => {
    p.rank = i;
    p.isBest = i === 0;
  });

  // =========================================================
  // UNASSISTED ENGINE SELECTION (May 23, 2026 — Request B)
  //
  // A third top-pick philosophy, calibrated against 82 graded picks of
  // historical data. Backtested win rate on "eligible" tier: 63.6% (n=33),
  // compared to the current engine's 43.9% overall hit rate. The engine
  // refuses to make a top pick when the hitter has any of:
  //
  //   - Inflation gap > 0.15 (small-sample matched xwOBA noise)
  //   - Matched K% > 30 against this arsenal
  //   - Recent form sample < 20 PA
  //   - No main pitch with ≥ 15 PA in arsenal coverage
  //
  // For eligible hitters, the engine scores each prop on:
  //   - P(H ≥ 1) per game (primary signal)
  //   - Walk-implied OBP
  //   - P(H ≥ 2) — multi-hit pathway to HRR
  //   - K-cluster penalty (matched K% above season K%)
  //   - Regressed xwOBA sweet-spot proximity (0.55 ± 0.10)
  //
  // Excludes R/RBI/HR props as ineligible (require teammates / variance).
  //
  // The result attaches to each prop:
  //   p.unassistedRank   : 0 if selected, null otherwise
  //   p.unassistedScore  : the engine's scoring (only on selected prop)
  //   p.unassistedTier   : 'eligible' | 'caution' | 'rejected'
  //
  // The selection metadata is also attached to the first prop's
  // _engineAudit.unassisted block for UI display.
  let unassistedResult = null;
  try {
    unassistedResult = selectUnassistedTopPick(ranked, {
      adjustedMaxXwoba: maxXwoba,
      regressedMaxXwoba: parseFloat(adjustments?.regressedMaxXwoba || maxXwoba),
      matchedHitterK: _matchedHitterK,
      seasonHitterK: parseFloat(overall.k_percent?.value || 22.5),
      recentFormPaUsed: hitter?.recentForm?.paUsed || 0,
      matchedPitches,                 // full arsenal — engine reads pitcherUsage and hitterPa
      pHit: _pHit,
      expectedPa: expectedPaForLineupSlot(hitter?.battingOrder),
      hitterBBPct: parseFloat(overall.bb_percent?.value || 8.5)
    });
  } catch (err) {
    console.warn('[unassistedEngine] selection failed:', err.message);
  }

  if (unassistedResult) {
    // Tag every prop with unassistedRank (null if not the top pick) and the
    // overall tier so the UI knows whether to allow ★ BEST in unassisted mode.
    ranked.forEach(p => {
      p.unassistedRank = (p === unassistedResult.topPick) ? 0 : null;
      p.unassistedTier = unassistedResult.eligibility;
    });
    if (unassistedResult.topPick) {
      unassistedResult.topPick.unassistedScore = unassistedResult.score;
    }
    // Surface the audit on the first prop for client inspection
    if (ranked[0]) {
      ranked[0]._unassistedAudit = {
        eligibility: unassistedResult.eligibility,
        topPickKey: unassistedResult.topPick?.key || null,
        topPickLabel: unassistedResult.topPick?.label || null,
        score: unassistedResult.score,
        rejectionReasons: unassistedResult.rejectionReasons,
        arsenal: unassistedResult.audit?.checks?.arsenal,
        inflationGap: unassistedResult.audit?.checks?.inflationGap,
        cautionReasons: unassistedResult.audit?.cautionReasons || []
      };
    }
  }

  return ranked;
}

function hitReason(maxXwoba, kPct, hardHit, parkBoost) {
  const bits = [];
  if (maxXwoba >= 0.420) bits.push('elite pitch-type edge');
  else if (maxXwoba >= 0.370) bits.push('strong pitch-type edge');
  if (hardHit >= 45) bits.push('high hard-hit rate');
  if (kPct <= 18) bits.push('rarely strikes out');
  if (parkBoost > 1.05) bits.push('offensive park');
  return bits.length ? bits.join(', ') : 'Contact profile is solid';
}

function hrReason(barrel, ev, xslg, parkBoost, hand, park) {
  const bits = [];
  if (barrel >= 12) bits.push(`${barrel.toFixed(1)}% barrel rate`);
  if (ev >= 92) bits.push(`${ev.toFixed(1)} mph EV`);
  if (xslg >= 0.500) bits.push(`${xslg.toFixed(3)} xSLG vs arsenal`);
  if (parkBoost >= 1.08) bits.push(`${park?.name || 'park'} big HR boost for ${hand}HB`);
  return bits.length ? bits.join(', ') : 'Modest HR signals';
}

function tbReason(xslg, barrel, parkBoost) {
  const bits = [];
  if (xslg >= 0.500) bits.push(`${xslg.toFixed(3)} xSLG vs arsenal`);
  if (barrel >= 10) bits.push(`${barrel.toFixed(1)}% barrel`);
  if (parkBoost >= 1.05) bits.push('power park');
  return bits.length ? bits.join(', ') : 'Moderate extra-base upside';
}

function rbiReason(xwoba, barrel, parkBoost) {
  const bits = [];
  if (xwoba >= 0.400) bits.push('elite matchup');
  if (barrel >= 10) bits.push(`${barrel.toFixed(1)}% barrel`);
  if (parkBoost > 1.03) bits.push('run-friendly park');
  return bits.length ? bits.join(', ') : 'Middle-of-order opportunity';
}

function rReason(xwoba, kPct, parkBoost) {
  const bits = [];
  if (xwoba >= 0.400) bits.push('gets on base vs this arsenal');
  if (kPct <= 18) bits.push('puts ball in play');
  if (parkBoost > 1.03) bits.push('run-friendly park');
  return bits.length ? bits.join(', ') : 'Decent OBP profile';
}

// ===== TOP PICK REASONING =====
// Explains WHY this hitter is the top pick on their side
function buildTopPickReasons(h) {
  const reasons = [];

  // Tier-based opener
  if (h.tier === 'elite') reasons.push(`Elite tier matchup (${h.adjustedMaxXwoba} adj xwOBA)`);
  else if (h.tier === 'strong') reasons.push(`Strong tier matchup (${h.adjustedMaxXwoba} adj xwOBA)`);
  else if (h.tier === 'solid') reasons.push(`Solid matchup (${h.adjustedMaxXwoba} adj xwOBA)`);

  // Full game coverage is a huge plus
  if (h.tier && h.bullpenTier) {
    reasons.push(`FULL GAME edge — both SP and bullpen favorable`);
  }

  // Best matched pitch
  const bestPitch = (h.matchedPitches || []).reduce((a, b) =>
    (!a || parseFloat(b.hitterXwoba) > parseFloat(a.hitterXwoba)) ? b : a, null);
  if (bestPitch) {
    const xw = parseFloat(bestPitch.hitterXwoba);
    const pitchName = bestPitch.pitch;
    const usage = bestPitch.pitcherUsage;
    if (xw >= 0.500) reasons.push(`Demolishes ${pitchName} (${bestPitch.hitterXwoba} xwOBA · pitcher throws ${usage}%)`);
    else if (xw >= 0.420) reasons.push(`Crushes ${pitchName} (${bestPitch.hitterXwoba} xwOBA · pitcher throws ${usage}%)`);
    else if (xw >= 0.370) reasons.push(`Handles ${pitchName} well (${bestPitch.hitterXwoba} xwOBA · pitcher throws ${usage}%)`);
  }

  // Platoon angle
  const platAdj = (h.adjustments || []).find(a => a.type === 'platoon' && a.favor === 'hitter');
  if (platAdj) {
    if (h.platoonMeta?.reverseSplit) {
      reasons.push(`⚡ Reverse split edge — ${platAdj.label}`);
    } else {
      reasons.push(`Platoon advantage — ${platAdj.label}`);
    }
  }

  // Park/ump favor
  const parkAdj = (h.adjustments || []).find(a => a.type === 'park' && a.favor === 'hitter');
  if (parkAdj) reasons.push(parkAdj.label);
  const umpAdj = (h.adjustments || []).find(a => a.type === 'umpire' && a.favor === 'hitter');
  if (umpAdj) reasons.push(umpAdj.label);

  return reasons;
}

// Handedness-specific park HR factor (returns multiplier where 1.0 = neutral)
function getParkHrMult(parkFactor, batSide) {
  if (!parkFactor) return 1.0;
  const pf = batSide === 'L' ? parkFactor.lhbHr : parkFactor.rhbHr;
  if (pf == null) return (parkFactor.hr || 100) / 100;
  return pf / 100;
}

// ==================== PITCHER INNING ANALYSIS ====================

// Build detailed narrative from inning splits data
function buildPitcherInningNarrative(splits, pitcher) {
  if (!splits) return null;
  const n = {
    pitcherName: pitcher?.name || 'Pitcher',
    pitcherHand: pitcher?.hand || '?',
    control: null,
    controlReason: null,
    meltdownReason: null,
    shutdownReason: null,
    timesThroughOrder: null,
    firstInningRisk: null,
    sampleWarning: null,
    keyInsights: []
  };

  const groups = splits.groups || {};
  const f = groups.firstTime;
  const s = groups.secondTime;
  const t = groups.thirdTime;

  // Control narrative
  if (splits.controlTier) {
    const bbPctOverall = splits.perInning ? Object.values(splits.perInning).reduce((sum, i) => sum + (i.bbPct || 0) * (i.pa || 0), 0) / Math.max(1, Object.values(splits.perInning).reduce((sum, i) => sum + (i.pa || 0), 0)) : null;
    const pct = bbPctOverall ? (bbPctOverall * 100).toFixed(1) : '?';
    switch (splits.controlTier) {
      case 'elite':
        n.control = 'elite';
        n.controlReason = `Elite control (${pct}% BB) — rarely hurts himself, fade walk/HBP props`;
        break;
      case 'above-average':
        n.control = 'above-avg';
        n.controlReason = `Above-average control (${pct}% BB)`;
        break;
      case 'average':
        n.control = 'average';
        n.controlReason = `Average control (${pct}% BB)`;
        break;
      case 'below-average':
        n.control = 'below-avg';
        n.controlReason = `Below-average control (${pct}% BB) — target opposing walk props`;
        break;
      case 'wild':
        n.control = 'wild';
        n.controlReason = `Wild (${pct}% BB) — strong target for opposing walks + H+R+RBI overs`;
        break;
    }
  }

  // Times through the order comparison
  if (f?.pa >= 20 && s?.pa >= 20 && f.xwobaAgainst != null && s.xwobaAgainst != null) {
    const delta = s.xwobaAgainst - f.xwobaAgainst;
    if (delta >= 0.040) {
      n.timesThroughOrder = {
        pattern: 'fades',
        firstXw: f.xwobaAgainst,
        secondXw: s.xwobaAgainst,
        delta,
        description: `Fades 2nd time through order (1st: ${f.xwobaAgainst.toFixed(3)} → 2nd: ${s.xwobaAgainst.toFixed(3)}, +${delta.toFixed(3)}). Hitters see him better on 2nd/3rd PA.`
      };
      n.keyInsights.push(`2nd-3rd AB hitters have ${((delta/f.xwobaAgainst)*100).toFixed(0)}% higher xwOBA-against`);
    } else if (delta <= -0.030) {
      n.timesThroughOrder = {
        pattern: 'settles',
        firstXw: f.xwobaAgainst,
        secondXw: s.xwobaAgainst,
        delta,
        description: `Settles in 2nd time through (1st: ${f.xwobaAgainst.toFixed(3)} → 2nd: ${s.xwobaAgainst.toFixed(3)}). Early innings are the window.`
      };
      n.keyInsights.push(`First time through hitters have best chance — target 1st/2nd AB props`);
    } else {
      n.timesThroughOrder = {
        pattern: 'consistent',
        firstXw: f.xwobaAgainst,
        secondXw: s.xwobaAgainst,
        delta,
        description: `Consistent across the order (1st: ${f.xwobaAgainst.toFixed(3)}, 2nd: ${s.xwobaAgainst.toFixed(3)}).`
      };
    }
  }

  // Meltdown inning narrative
  if (splits.meltdownInning && splits.meltdownXw) {
    const mi = splits.meltdownInning;
    const delta = splits.meltdownDelta || 0;
    const whatsIn = mi <= 3 ? 'fresh innings' : mi <= 6 ? '2nd time through' : 'late/fatigue';
    n.meltdownReason = `Meltdown inning: ${ordinal(mi)} (xwOBA ${splits.meltdownXw.toFixed(3)}, ${whatsIn}). ${delta > 0.040 ? 'Significantly worse than his overall rate — high-leverage window for overs.' : 'Only modestly worse than overall.'}`;
    if (delta > 0.040) {
      n.keyInsights.push(`Inning ${mi} is when hitters tee off — ${splits.meltdownXw.toFixed(3)} xwOBA-against`);
    }
  }

  // First-inning-specific risk
  if (splits.perInning?.[1]?.pa >= 15) {
    const inn1 = splits.perInning[1];
    if (inn1.xwobaAgainst != null && inn1.xwobaAgainst >= 0.360) {
      n.firstInningRisk = `Slow starter — 1st inning xwOBA ${inn1.xwobaAgainst.toFixed(3)} (${inn1.pa} PA). Consider 1st-inning YRFI / team-total-over-first-3.`;
      n.keyInsights.push(`Vulnerable in 1st inning — consider YRFI / over 1st 3 innings`);
    } else if (inn1.xwobaAgainst != null && inn1.xwobaAgainst <= 0.270) {
      n.firstInningRisk = `Strong starter — 1st inning xwOBA ${inn1.xwobaAgainst.toFixed(3)}. Fade early overs.`;
    }
  }

  // Shutdown inning narrative
  if (splits.shutdownInning && splits.shutdownXw && splits.shutdownXw < 0.280) {
    n.shutdownReason = `Dominant in ${ordinal(splits.shutdownInning)} (xwOBA ${splits.shutdownXw.toFixed(3)}). Hitters struggle there — avoid props around that AB.`;
  }

  // Sample warnings
  const totalPa = Object.values(splits.perInning || {}).reduce((sum, i) => sum + (i.pa || 0), 0);
  if (totalPa < 150) {
    n.sampleWarning = `Limited sample (${totalPa} blended PA) — predictions will be less reliable. Lean heavier on arsenal matchup.`;
  }

  return n;
}

// Estimate which AB of the game a hitter (at batting order slot) is most likely to hit their prop
// Assumes ~9 batters per team per time through the order
function estimateAtBatTiming(battingOrder, inningSplits) {
  if (!battingOrder || !inningSplits?.perInning) return null;
  const slot = parseInt(battingOrder) || null;
  if (!slot || slot < 1 || slot > 9) return null;

  // Approx inning for each AB. First AB: slot 1-3 in inning 1, 4-6 inning 1-2, 7-9 inning 2.
  // More precisely: each PA uses ~1/9 of the lineup, so:
  //   AB1: hitter's slot / 9 * 1 = inning 1 (for slots 1-5), inning 2 (for slots 6-9)
  //   AB2: roughly 9 batters later → add ~3 innings
  //   AB3: 18 batters later → add ~6 innings

  // Simple model: slot S faces pitcher first in inning ceil(S/4.5), then every ~3 innings after
  // Refine: assume pitcher throws 4 batters per inning (standard)
  const batsPerInning = 4;
  const ab1Inning = Math.max(1, Math.ceil(slot / batsPerInning));
  const ab2Inning = ab1Inning + Math.ceil(9 / batsPerInning);
  const ab3Inning = ab2Inning + Math.ceil(9 / batsPerInning);
  const ab4Inning = ab3Inning + Math.ceil(9 / batsPerInning);

  const abs = [
    { ab: 1, inning: ab1Inning, xwobaAgainst: inningSplits.perInning[ab1Inning]?.xwobaAgainst },
    { ab: 2, inning: ab2Inning, xwobaAgainst: inningSplits.perInning[ab2Inning]?.xwobaAgainst },
    { ab: 3, inning: ab3Inning, xwobaAgainst: inningSplits.perInning[ab3Inning]?.xwobaAgainst },
    { ab: 4, inning: ab4Inning <= 9 ? ab4Inning : null, xwobaAgainst: ab4Inning <= 9 ? inningSplits.perInning[ab4Inning]?.xwobaAgainst : null }
  ].filter(a => a.inning != null && a.inning <= 9);

  // Find the AB with highest xwOBA-against = best PA for the hitter
  let bestAb = null, bestXw = 0;
  for (const a of abs) {
    if (a.xwobaAgainst != null && a.xwobaAgainst > bestXw) {
      bestXw = a.xwobaAgainst;
      bestAb = a;
    }
  }

  // Meltdown alignment — is any of this hitter's ABs in the meltdown inning?
  const meltdownAb = inningSplits.meltdownInning
    ? abs.find(a => a.inning === inningSplits.meltdownInning)
    : null;

  return {
    slot,
    abs,
    bestAb: bestAb ? { ab: bestAb.ab, inning: bestAb.inning, xwobaAgainst: bestAb.xwobaAgainst } : null,
    meltdownAb: meltdownAb ? { ab: meltdownAb.ab, inning: meltdownAb.inning } : null,
    alignsWithMeltdown: !!meltdownAb,
    pitcherMeltdownInning: inningSplits.meltdownInning
  };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ==================== SITUATIONAL PROP BOOSTS ====================
// Given a hitter's actionable situational signals, boost/demote the relevant prop
// recommendations so the "BEST BET" surfacing reflects these edges.
function applySituationalPropBoosts(hitter, signals, pitcherInningSplits) {
  if (!hitter.propRecs || !signals) return;

  const boost = (propKey, points, reason) => {
    const prop = hitter.propRecs.find(p => p.key === propKey);
    if (!prop) return;
    const before = prop.score || 0;
    prop.score = before + points;
    prop.situationalBoosts = prop.situationalBoosts || [];
    prop.situationalBoosts.push({ points, reason });
  };

  // RISP actionable & positive → boost RBI / H+R+RBI props
  if (signals.risp?.actionable && signals.risp.delta >= 0.080) {
    boost('RBI', 8, `RISP clutch: +${signals.risp.delta.toFixed(3)} OPS in ${signals.risp.PA} PA`);
    boost('HRR', 5, `RISP clutch helps H+R+RBI`);
  }
  // RISP actionable & negative → demote RBI
  if (signals.risp?.actionable && signals.risp.delta <= -0.080) {
    boost('RBI', -8, `Struggles with RISP: ${signals.risp.delta.toFixed(3)} OPS in ${signals.risp.PA} PA`);
  }

  // Ahead-in-count → boost walk props (walks aren't in main prop list, so skip if not present)
  // (we don't currently expose a walk-only prop key; walk edge shows as deep-dive hint only)

  // Behind-in-count collapse
  if (signals.behind?.actionable && signals.behind.delta <= -0.150) {
    boost('TB', -4, `Collapses when behind: ${signals.behind.delta.toFixed(3)} OPS`);
    boost('H', -3, `Collapses when behind: ${signals.behind.delta.toFixed(3)} OPS`);
  }

  // First-pitch aggressive
  if (signals.firstPitch?.actionable && signals.firstPitch.delta >= 0.150) {
    boost('HR', 4, `Attacks first pitches: ${signals.firstPitch.OPS?.toFixed(3)} OPS on 0-0`);
    boost('TB', 3, `Aggressive on 0-0`);
  }

  // Inning alignment with pitcher meltdown — stacked signal
  if (pitcherInningSplits?.meltdownInning) {
    const mi = pitcherInningSplits.meltdownInning;
    let hitterInningSignal = null;
    if (mi <= 3) hitterInningSignal = signals.inningsEarly;
    else if (mi <= 6) hitterInningSignal = signals.inningsMiddle;
    else hitterInningSignal = signals.inningsLate;

    if (hitterInningSignal?.actionable && hitterInningSignal.delta >= 0.080) {
      boost('TB', 8, `Hitter excels in pitcher's meltdown window (inn ${mi})`);
      boost('HR', 6, `Stacked signal in meltdown inning`);
      boost('HRR', 6, `Stacked signal in meltdown inning`);
    }
  }

  // Late-inning fade
  if (signals.inningsLate?.actionable && signals.inningsLate.delta <= -0.100) {
    boost('HR', -3, `Fades late: ${signals.inningsLate.delta.toFixed(3)} OPS in innings 7+`);
  }

  // Re-pick best prop after all boosts
  if (hitter.propRecs.length > 0) {
    hitter.propRecs.forEach(p => p.isBest = false);
    const best = hitter.propRecs.reduce((a, b) => (b.score || 0) > (a.score || 0) ? b : a);
    if ((best.score || 0) > 0) best.isBest = true;
  }
}
