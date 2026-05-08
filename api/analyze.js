// api/analyze.js
// Core mismatch engine with park + umpire context.
// Calls helper functions DIRECTLY (no HTTP) to avoid Vercel cold-start 404 issues.

import { PARK_FACTORS_BY_TEAM, PARK_GEO, getParkGeo } from './_data/parkFactors.js';
import { UMPIRE_FACTORS, classifyUmp, getAbsAdjustedFactors } from './_data/umpireFactors.js';
import { getProbables, getPitcherArsenal, getBullpenProfile, getLineup, getHitterStats, getHitterSplits, getPitcherSplits, getHitterPitchTypeByHand, getGameOdds, getPitcherHomeRoadSplits, getPitcherRecentStarts } from './_lib/data.js';
import { getBlendedInningSplits } from './_lib/pitcherInnings.js';
import { getWeatherForecast, computeWeatherImpact } from './_lib/weather.js';
import { getHitterSituationalByMlbam } from './_lib/brefSplits.js';
import { detectPitcherRole } from './_lib/pitcherRole.js';
import { buildGameLineRecommendations } from './_lib/gameLineBets.js';
import { estimatePropProbability, estimateTotalProbability, estimateSpreadProbability, estimateMoneylineProbability, americanToImpliedProb, computeEdge } from './_lib/probability.js';
import { buildPitcherProps, evaluatePitcherProp } from './_lib/pitcherProps.js';
import { computeFirstInningProbability } from './_lib/firstInning.js';
import { computeHrProjection, computeHrAudit } from './_lib/hrEmpirical.js';
import { getMatchupConversionRates } from './_lib/conversionRate.js';
import { getLineupRispPerformance, applyRispAdjustment, buildLineupConversionTier } from './_lib/batterRisp.js';
import { fetchPitcherPropsLines, getPitcherLinesByName } from './_lib/pitcherPropsLines.js';
import { tryAuth, checkAndIncrementQuota, AuthError } from './_lib/auth.js';

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

    const sides = [
      { hitTeamId: game.awayTeam.id, pitcher: game.homePitcher, pitTeamAbbr: game.homeTeam.abbreviation, key: 'awayVsHome', side: 'away' },
      { hitTeamId: game.homeTeam.id, pitcher: game.awayPitcher, pitTeamAbbr: game.awayTeam.abbreviation, key: 'homeVsAway', side: 'home' }
    ];

    // Kick off pitcher prop lines fetch (DraftKings via The Odds API) in parallel with
    // side processing. Single fetch per request returns lines for ALL games on the slate;
    // cached 15 min on the server. If the fetch fails or no key is configured, sides
    // proceed with projection-only (graceful degradation). Resolved AFTER side processing
    // and applied post-hoc to grade projections against book lines.
    const propsLinesPromise = fetchPitcherPropsLines().catch(() => null);

    // Process both sides in parallel using helpers directly (no HTTP)
    const sideResults = await Promise.all(sides.map(async s => {
      if (!s.pitcher || !s.hitTeamId) return null;

      const [arsenal, lineup, bullpen, pitcherSplits, inningSplits, pitcherRole, homeRoadSplits, recentStarts] = await Promise.all([
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
        getPitcherRecentStarts(s.pitcher.id, season, 3).catch(() => [])
      ]);

      const keyPitches = arsenal.slice(0, 3);
      const keyBullpenPitches = (bullpen.pitches || []).slice(0, 3);
      const topHitters = lineup.slice(0, 9);

      // Fetch hitter stats + splits in parallel (plus deep per-pitch-per-hand if requested)
      const hitterData = await Promise.all(topHitters.map(async h => {
        try {
          // In deep mode, fetch per-pitch-type xwOBA filtered by THIS pitcher's handedness
          // Switch hitters: the "effective hand" logic happens downstream; we pull for pitcher hand
          const deepPromise = deepMode
            ? getHitterPitchTypeByHand(h.id, season, s.pitcher.hand).catch(() => [])
            : Promise.resolve([]);

          const [stats, splits, deepPitchTypes] = await Promise.all([
            getHitterStats(h.id, season),
            getHitterSplits(h.id, season).catch(() => ({ vsR: null, vsL: null })),
            deepPromise
          ]);
          return { ...h, stats, splits, deepPitchTypes };
        } catch {
          return { ...h, stats: { overall: {}, pitchTypes: [] }, splits: { vsR: null, vsL: null }, deepPitchTypes: [] };
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
            pa: pitSplitSide.pa,
            smallSample: pitSplitSide.pa < 40
          };
        }

        const adjustedMaxXwoba = maxXwoba * contextMultiplier;
        const adjustedEdge = edgeScore * contextMultiplier;

        let tier = null;
        if (adjustedMaxXwoba >= 0.420) tier = 'elite';
        else if (adjustedMaxXwoba >= 0.370) tier = 'strong';
        else if (adjustedMaxXwoba >= 0.330) tier = 'solid';

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
          bullpenTier
        });

        return {
          hitterId: h.id,
          hitter: h.name,
          hand: h.hand,
          position: h.position,
          battingOrder: h.battingOrder || null,
          matchedPitches,
          maxXwoba: maxXwoba.toFixed(3),
          adjustedMaxXwoba: adjustedMaxXwoba.toFixed(3),
          edgeScore: edgeScore.toFixed(3),
          adjustedEdgeScore: adjustedEdge.toFixed(3),
          contextMultiplier: contextMultiplier.toFixed(3),
          adjustments,
          tier,
          description,
          propRecs,
          platoonMeta,
          hasDeepData,
          // Bullpen cross-reference
          bullpenMatches,
          bullpenMaxXwoba: bullpenMaxXwoba.toFixed(3),
          bullpenEdgeScore: bullpenEdgeScore.toFixed(3),
          bullpenTier,
          seasonStats: {
            xwoba: overall.xwoba?.value || null,
            barrelPct: overall.barrel_batted_rate?.value || null,
            hardHitPct: overall.hard_hit_percent?.value || null,
            avgEV: overall.avg_exit_velocity?.value || null,
            kPct: overall.k_percent?.value || null
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
              bullpenTier
            });

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
        // FULL GAME bonus (edges vs both SP and BP)
        if (h.tier && h.bullpenTier) topScore *= 1.18;
        // Reverse split / strong platoon bonus (if adjustment is meaningfully hitter-favoring)
        const platoonAdj = (h.adjustments || []).find(a => a.type === 'platoon' && a.favor === 'hitter');
        if (platoonAdj) {
          const mult = parseFloat(platoonAdj.multiplier || 1);
          if (mult > 1.08) topScore *= 1.08;
        }
        // Reverse split specifically gets extra weight (market undervalued angle)
        if (h.platoonMeta?.reverseSplit) topScore *= 1.05;
        return { ...h, _topPickScore: topScore };
      }).sort((a, b) => b._topPickScore - a._topPickScore);

      // First entry (if it meets a minimum quality bar) is the TOP PICK
      let topPick = null;
      if (withTopPickScore.length > 0) {
        const candidate = withTopPickScore[0];
        const candidateQualifies = candidate.tier === 'elite' ||
                                   (candidate.tier === 'strong' && parseFloat(candidate.adjustedMaxXwoba) >= 0.380) ||
                                   (candidate.tier === 'solid' && candidate.bullpenTier);
        if (candidateQualifies) {
          candidate.isTopPick = true;
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

          // Prop unit sizing based on composite score and tier
          // ELITE + FULL GAME edge: 2u · ELITE or STRONG + FG: 1u · SOLID or single-edge: 0.5u
          let propUnits = 0.5;
          if (candidate.tier === 'elite' && candidate.bullpenTier === 'FULL_GAME') propUnits = 2;
          else if (candidate.tier === 'elite' || (candidate.tier === 'strong' && candidate.bullpenTier === 'FULL_GAME')) propUnits = 1;
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
        opposingLineup: deepMode ? hitterData : null
      });

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
          hrAuditTop  // top 3 HR audit projections, regardless of tier
        }
      };
    }));

    sideResults.forEach(r => { if (r) results[r.key] = r.data; });

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

    // ===== FIRST-INNING SCORING PROJECTION =====
    // YRFI/NRFI uses 1st-inning xwOBA-against from inning splits + lineup tier + park/weather/ump context
    results.firstInning = computeFirstInningProbability(
      results.awayVsHome,
      results.homeVsAway,
      { parkFactor, weatherImpact: results.weatherImpact, umpire: results.umpire }
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
      umpire: results.umpire,
      weatherImpact: results.weatherImpact,
      conversionRates,                  // NEW: stranded-runner / RISP signal
      odds
    });
    results.projection = projection;
    results.odds = odds;
    results.conversionRates = conversionRates;

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
function buildGameProjection({ awayVsHome, homeVsAway, parkFactor, umpire, weatherImpact, conversionRates, odds }) {
  // MLB 2024-2025 league avg runs per team per game: ~4.45
  const BASELINE_RUNS = 4.45;

  // Map aggregate side data into multipliers
  const sideMult = (side) => {
    if (!side) return { lineupMult: 1.0, pitcherMult: 1.0, bullpenMult: 1.0, factors: {} };

    const lt = side.lineupTier;
    // Lineup quality: map the average max-xwoba-vs-this-arsenal to a run multiplier
    // League avg is around .320 — elite lineup tier tops out near .380
    // Use a soft curve so elite lineups don't over-project
    const avgMaxXw = parseFloat(lt?.avgMaxXwoba || 0.320);
    const lineupMult = 1.0 + ((avgMaxXw - 0.320) * 2.4);   // .040 above avg → +9.6%

    // Pitcher quality: use starter's season xwOBA-against (from arsenal weighted avg)
    let pitcherXwAgainst = null;
    if (side.pitcherArsenal && side.pitcherArsenal.length > 0) {
      const totalPitches = side.pitcherArsenal.reduce((s, p) => s + (p.pitches || 0), 0);
      if (totalPitches > 0) {
        const weighted = side.pitcherArsenal.reduce((s, p) => {
          const x = parseFloat(p.xwoba || 0);
          return s + (x * (p.pitches || 0));
        }, 0);
        pitcherXwAgainst = weighted / totalPitches;
      }
    }
    // Lower xwOBA-against = better pitcher = suppresses runs
    // League avg xwOBA-against is ~.320; ace at ~.270; replacement at ~.360
    const pitcherMult = pitcherXwAgainst
      ? 1.0 + ((pitcherXwAgainst - 0.320) * 2.0)   // ace .270 → 0.90x, bad .360 → 1.08x
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
        pitcherXwAgainst: pitcherXwAgainst ? pitcherXwAgainst.toFixed(3) : null,
        bullpenXwAgainst: bullpenXwAgainst ? bullpenXwAgainst.toFixed(3) : null,
        inningMult: inningMult.toFixed(3),
        controlTier: isplits?.controlTier || null,
        meltdownInning: isplits?.meltdownInning || null,
        lineupTierLabel: lt?.label || 'UNKNOWN'
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

  // Conversion rate multipliers: how efficiently each team converts scoring chances into runs.
  // Applied to the team's OWN run total (their offense converts their own opportunities).
  // 1.0 = league avg; <1.0 = strands runners; >1.0 = clutch / efficient.
  // Capped at ±8% in the source module to prevent overfitting.
  const awayConvMult = conversionRates?.away?.conversionMult || 1.0;
  const homeConvMult = conversionRates?.home?.conversionMult || 1.0;

  // Final projections — now including conversion rate
  const projAwayRuns = BASELINE_RUNS * awayComp.lineupMult * awayPitcherBlend * parkRunMult * umpRunMult * weatherRunMult * awayConvMult;
  const projHomeRuns = BASELINE_RUNS * homeComp.lineupMult * homePitcherBlend * parkRunMult * umpRunMult * weatherRunMult * homeConvMult;
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
    factors: {
      away: awayComp.factors,
      home: homeComp.factors,
      parkRunMult: parkRunMult.toFixed(3),
      umpRunMult: umpRunMult.toFixed(3),
      awayConvMult: awayConvMult.toFixed(3),
      homeConvMult: homeConvMult.toFixed(3)
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
    totalScore,
    summary
  };
}

// ===== PROP RECOMMENDATIONS =====
// Ranks prop types by edge quality for this specific matchup
function buildPropRecommendations({ hitter, matchedPitches, maxXwoba, overall, parkFactor, adjustments, tier, bullpenMaxXwoba, bullpenTier }) {
  if (!tier || matchedPitches.length === 0) return [];

  const barrel = parseFloat(overall.barrel_batted_rate?.value || 0);
  const hardHit = parseFloat(overall.hard_hit_percent?.value || 0);
  const ev = parseFloat(overall.avg_exit_velocity?.value || 0);
  const kPct = parseFloat(overall.k_percent?.value || 22);
  const seasonXwoba = parseFloat(overall.xwoba?.value || 0);
  const maxXslg = matchedPitches.reduce((max, mp) => {
    const x = parseFloat(mp.hitterXslg || 0);
    return x > max ? x : max;
  }, 0);

  // Bullpen boost: full-game props (fantasy score, HRR, TB) benefit most because
  // they accumulate over 5-6 additional innings of exposure vs relievers
  const bpX = bullpenMaxXwoba || 0;
  const bpFullGameBoost = bpX >= 0.370 ? 1.18 :
                          bpX >= 0.330 ? 1.10 :
                          bpX >= 0.290 ? 1.03 :
                          bpX > 0 ? 0.94 : 1.0;
  // Single-event props (HR, hit) get a smaller boost since one event in the whole game is enough
  const bpEventBoost = bpX >= 0.370 ? 1.10 :
                       bpX >= 0.330 ? 1.05 :
                       bpX >= 0.290 ? 1.01 :
                       bpX > 0 ? 0.97 : 1.0;

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
    { key: 'TB',       label: 'TB 1.5',         platform: 'BOTH', score: tbScore,    reason: tbReason(maxXslg, barrel, hrParkBoost) + bpTag },
    { key: 'RBI',      label: 'RBI 0.5',        platform: 'BOTH', score: rbiScore,   reason: rbiReason(maxXwoba, barrel, runParkBoost) + bpTag },
    { key: 'R',        label: 'RUNS 0.5',       platform: 'BOTH', score: rScore,     reason: rReason(maxXwoba, kPct, runParkBoost) + bpTag },
    { key: 'HRR',      label: 'H+R+RBI 1.5',    platform: 'PP',   score: hrr,        reason: 'Multiple pathways to over' + bpTag },
    { key: 'PP_FS_6',  label: 'PP FS 6',        platform: 'PP',   score: fs_pp6,     reason: `Projected ~${projFS.toFixed(1)} pts${bpTag}` },
    { key: 'PP_FS_8',  label: 'PP FS 8',        platform: 'PP',   score: fs_pp8,     reason: `Projected ~${projFS.toFixed(1)} pts${bpTag}` },
    { key: 'UD_FS_5',  label: 'UD FS 5',        platform: 'UD',   score: fs_ud5,     reason: `Projected ~${projFS.toFixed(1)} pts${bpTag}` },
    { key: 'UD_FS_7',  label: 'UD FS 7',        platform: 'UD',   score: fs_ud7,     reason: `Projected ~${projFS.toFixed(1)} pts${bpTag}` }
  ];

  // Sort by score, take top 4
  allProps.sort((a, b) => b.score - a.score);
  const ranked = allProps.slice(0, 4);

  // Tag the first as best bet
  ranked.forEach((p, i) => { p.rank = i; p.isBest = i === 0; });

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
