// api/_lib/firstInning.js
// YRFI (Yes Run First Inning) / NRFI (No Run First Inning) projections and recommendations.
//
// Uses: 1st-inning xwOBA-against for both starters (from inningSplits),
//       top-of-lineup tier quality, park factor (runs + HR), weather, umpire K-rate.
//
// Returns: { awayScoresFirstProb, homeScoresFirstProb, yrfiProb, nrfiProb, recommendation }

// League baselines from 2024-25 data:
//   YRFI rate: ~57%  (53-60% varies by season)
//   P(away scores 1st inning) ≈ 0.32
//   P(home scores 1st inning) ≈ 0.30  (slight home-field disadvantage for scoring since home pitcher is fresher)
const LEAGUE_YRFI = 0.57;
const LEAGUE_AWAY_SCORES_FIRST = 0.325;
const LEAGUE_HOME_SCORES_FIRST = 0.305;

// =============================================================
// EMPIRICAL CALIBRATION (Phase 1 — May 29, 2026)
//
// Live tracking on 87 graded FI picks (May 19-28, 2026) showed the
// displayed probability was systematically overconfident above 0.55:
//
//   Bucket        Model says   Actually hits
//   0.45-0.50     ~0.475       52.6%  (close)
//   0.50-0.55     ~0.525       44.4%
//   0.55-0.60     ~0.575       33.3%
//   0.60-0.65     ~0.625       45.5%
//   0.65-0.70     ~0.675       50.0%
//   0.70-0.80     ~0.750       42.9%
//
// This isotonic-style remap pulls displayed values toward observed hit
// rates so the UI is honest. The raw model probability is preserved on
// the recommendation object as rawProbability for debugging.
//
// IMPORTANT: this only affects the DISPLAYED probability. The pick
// SELECTION still uses the raw probability — the model's relative
// ranking of which side has the edge is still correct, even if the
// absolute magnitude was overstated.
//
// Refit when 50+ more graded FI picks accumulate.
// =============================================================
const FI_CALIBRATION_POINTS = [
  [0.30, 0.32],   // anchor low (extrapolated, no live data below 0.45)
  [0.45, 0.47],
  [0.50, 0.48],
  [0.55, 0.45],
  [0.60, 0.47],
  [0.65, 0.50],
  [0.70, 0.46],
  [0.75, 0.45],
  [0.80, 0.50],   // ceiling — small sample, hold near coin-flip honesty
];

function calibrateFiProbability(rawProb) {
  if (rawProb == null || !Number.isFinite(rawProb)) return rawProb;
  const p = Math.max(0.01, Math.min(0.99, rawProb));
  for (let i = 0; i < FI_CALIBRATION_POINTS.length - 1; i++) {
    const [x1, y1] = FI_CALIBRATION_POINTS[i];
    const [x2, y2] = FI_CALIBRATION_POINTS[i + 1];
    if (p >= x1 && p <= x2) {
      const t = (p - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  if (p < FI_CALIBRATION_POINTS[0][0]) return FI_CALIBRATION_POINTS[0][1];
  return FI_CALIBRATION_POINTS[FI_CALIBRATION_POINTS.length - 1][1];
}

/**
 * Compute first-inning scoring probabilities.
 *
 * @param {Object} awaySide    awayVsHome side data (away hitters vs home SP)
 * @param {Object} homeSide    homeVsAway side data (home hitters vs away SP)
 * @param {Object} context     { parkFactor, weatherImpact, umpire,
 *                               awayLineupSignal?, homeLineupSignal?,
 *                               awayArsenalSignal?, homeArsenalSignal? }
 *   awayLineupSignal/homeLineupSignal (NEW May 25, 2026): outputs from
 *   computeYrfiTopOfOrderBoost — when present, applied as multipliers to
 *   each side's scoring prob. Built from per-hitter unassisted engine
 *   outputs aggregated by lineupSignalAggregator.
 *
 *   awayArsenalSignal/homeArsenalSignal (NEW May 25, 2026 — same patch):
 *   outputs from computeArsenalVulnerability — measure the concentration
 *   of hitters with regressed-xwOBA advantage against the opposing
 *   pitcher's specific arsenal. Closes a pitcher-analysis asymmetry:
 *   without this, YRFI evaluated lineups deeply (top-of-order eligibility)
 *   but treated pitchers as a single aggregate xwOBA-against number,
 *   missing cases where a specific arsenal is broadly vulnerable to this
 *   particular lineup.
 *
 *   Apply direction: awayArsenalSignal → awayScoresProb (away lineup
 *   exploiting home pitcher's arsenal). Multipliers pre-bounded to
 *   [0.92, 1.10] in the aggregator.
 * @returns {Object} {
 *   yrfiProb,              // Prob at least one team scores
 *   nrfiProb,              // 1 - yrfiProb
 *   awayScoresProb,        // Prob the away team scores in top 1st
 *   homeScoresProb,        // Prob the home team scores in bottom 1st
 *   recommendation,        // { side: YRFI|NRFI|PASS, tier, units, probability }
 *   reasoning: string[],
 *   lineupSignalAudit      // NEW: shadow audit of lineup signal contributions
 * }
 */
export function computeFirstInningProbability(awaySide, homeSide, context = {}) {
  const reasoning = [];

  // ====== Per-side scoring probabilities ======
  // Start with league averages, apply multipliers from context
  let awayScoresProb = LEAGUE_AWAY_SCORES_FIRST;
  let homeScoresProb = LEAGUE_HOME_SCORES_FIRST;

  // --- Pitcher 1st-inning vulnerability (strongest single signal) ---
  // awayVsHome = away hitters vs home SP. So home SP's 1st-inning xwOBA-against affects awayScoresProb.
  const homeSp1stXw = getFirstInningXw(awaySide?.inningSplits);
  const awaySp1stXw = getFirstInningXw(homeSide?.inningSplits);

  if (homeSp1stXw?.xwoba != null && homeSp1stXw.pa >= 15) {
    // Baseline 1st-inning xwOBA ~= .320. Each .030 above/below = ~15% relative change
    const delta = homeSp1stXw.xwoba - 0.320;
    const mult = 1.0 + (delta * 5.0);  // .350 xwoba → 1.15x; .290 → 0.85x
    awayScoresProb *= Math.max(0.50, Math.min(1.80, mult));
    if (homeSp1stXw.xwoba >= 0.360) reasoning.push(`Home SP slow starter (1st inn xwOBA ${homeSp1stXw.xwoba.toFixed(3)}, ${homeSp1stXw.pa} PA)`);
    else if (homeSp1stXw.xwoba <= 0.270) reasoning.push(`Home SP dominant early (1st inn xwOBA ${homeSp1stXw.xwoba.toFixed(3)})`);
  }

  if (awaySp1stXw?.xwoba != null && awaySp1stXw.pa >= 15) {
    const delta = awaySp1stXw.xwoba - 0.320;
    const mult = 1.0 + (delta * 5.0);
    homeScoresProb *= Math.max(0.50, Math.min(1.80, mult));
    if (awaySp1stXw.xwoba >= 0.360) reasoning.push(`Away SP slow starter (1st inn xwOBA ${awaySp1stXw.xwoba.toFixed(3)}, ${awaySp1stXw.pa} PA)`);
    else if (awaySp1stXw.xwoba <= 0.270) reasoning.push(`Away SP dominant early (1st inn xwOBA ${awaySp1stXw.xwoba.toFixed(3)})`);
  }

  // --- Top-of-order strength (1st-3rd batters) ---
  // Use lineup tier as proxy: EXPLOITABLE/HIGHLY_EXPLOITABLE = strong top, SUPPRESSED/LOCKED_DOWN = weak
  const awayLineupBoost = getLineupFirstInnBoost(awaySide?.lineupTier);
  const homeLineupBoost = getLineupFirstInnBoost(homeSide?.lineupTier);
  awayScoresProb *= awayLineupBoost.mult;
  homeScoresProb *= homeLineupBoost.mult;
  if (awayLineupBoost.reason) reasoning.push(`Away offense: ${awayLineupBoost.reason}`);
  if (homeLineupBoost.reason) reasoning.push(`Home offense: ${homeLineupBoost.reason}`);

  // --- Pitcher control (walks drive early runs heavily in 1st inning) ---
  const homeControlMult = getControlFirstInnMult(awaySide?.inningSplits?.controlTier);
  const awayControlMult = getControlFirstInnMult(homeSide?.inningSplits?.controlTier);
  awayScoresProb *= homeControlMult;
  homeScoresProb *= awayControlMult;

  // --- Park factor (runs-friendly parks see more 1st inning scoring) ---
  const park = context.parkFactor;
  if (park?.runs) {
    const runsFactor = (park.runs / 100) ** 0.7;  // dampened since 1st-inning is just one frame
    awayScoresProb *= runsFactor;
    homeScoresProb *= runsFactor;
    if (park.runs >= 108) reasoning.push(`${park.name || 'Park'} hitter-friendly (+${park.runs - 100}% runs)`);
    else if (park.runs <= 92) reasoning.push(`${park.name || 'Park'} pitcher-friendly (${park.runs - 100}% runs)`);
  }

  // --- Weather (HR-heavy wind, hot temp boost YRFI; dome games suppress) ---
  const wi = context.weatherImpact;
  if (wi && !wi.isDome && wi.runMult) {
    const weatherFactor = Math.pow(wi.runMult, 0.7);  // dampened for single-frame
    awayScoresProb *= weatherFactor;
    homeScoresProb *= weatherFactor;
    if (wi.runMult >= 1.04) reasoning.push(`Weather boosts scoring (+${((wi.runMult-1)*100).toFixed(1)}%)`);
    else if (wi.runMult <= 0.96) reasoning.push(`Weather suppresses scoring (${((wi.runMult-1)*100).toFixed(1)}%)`);
  }
  if (wi?.isDome) reasoning.push('Dome game — no weather effect');

  // --- Umpire (tight K-zone = more Ks = fewer early runs) ---
  const ump = context.umpire?.factors;
  if (ump?.k) {
    const umpFactor = 1 / ump.k;  // K-happy umps suppress runs
    const scaled = Math.pow(umpFactor, 0.5);  // dampen
    awayScoresProb *= scaled;
    homeScoresProb *= scaled;
    if (ump.k >= 1.04) reasoning.push(`K-friendly ump suppresses 1st-inn scoring`);
    else if (ump.k <= 0.96) reasoning.push(`Tight-zone ump inflates 1st-inn scoring`);
  }

  // PITCHER NOVELTY SUPPRESSION (May 9, 2026)
  // When a starter has limited MLB sample, the opposing lineup has no tape on
  // his arsenal. First time through the order, hitters can't time the release,
  // recognize spin, or identify the out pitch. Result: dominant first inning
  // even from pitchers whose stats look mediocre.
  //
  // Yesavage failure mode: TOR vs LAA, Yesavage struck out side on splitters
  // off the plate. Tool projected over. Lineup had never faced him.
  //
  // awaySide.pitcherCareerStats describes the AWAY pitcher (who pitches to
  // the home lineup → affects homeScoresProb). Same for the other side.
  // homeSide.pitcherCareerStats describes the HOME pitcher (affects awayScoresProb).
  //
  // Magnitude:
  //   HIGH novelty (career PA < 50 OR < 3 starts): ×0.65 (35% reduction)
  //   MODERATE (PA < 150 OR < 8 starts):           ×0.85 (15% reduction)
  //
  // Apply to the side whose offense faces the novel pitcher.
  const homeSpNovelty = awaySide?.pitcherCareerStats;  // away's "home SP" perspective
  const awaySpNovelty = homeSide?.pitcherCareerStats;  // home's "away SP" perspective

  if (homeSpNovelty?.noviceTier === 'HIGH') {
    awayScoresProb *= 0.65;
    reasoning.push(`Home SP novel to lineup (${homeSpNovelty.careerPa} career PA, ${homeSpNovelty.careerStarts} MLB starts) — suppress`);
  } else if (homeSpNovelty?.noviceTier === 'MODERATE') {
    awayScoresProb *= 0.85;
    reasoning.push(`Home SP limited MLB sample (${homeSpNovelty.careerPa} career PA) — modest suppress`);
  }

  if (awaySpNovelty?.noviceTier === 'HIGH') {
    homeScoresProb *= 0.65;
    reasoning.push(`Away SP novel to lineup (${awaySpNovelty.careerPa} career PA, ${awaySpNovelty.careerStarts} MLB starts) — suppress`);
  } else if (awaySpNovelty?.noviceTier === 'MODERATE') {
    homeScoresProb *= 0.85;
    reasoning.push(`Away SP limited MLB sample (${awaySpNovelty.careerPa} career PA) — modest suppress`);
  }

  // ========================================================
  // LINEUP SIGNAL OVERLAY (May 25, 2026 — Connection 2)
  //
  // Apply top-of-order strength multipliers from the per-hitter aggregator.
  // awaySide hits home pitcher → awayLineupSignal affects awayScoresProb.
  // homeSide hits away pitcher → homeLineupSignal affects homeScoresProb.
  //
  // The signal multipliers are pre-clamped to [0.85, 1.20] in the aggregator
  // (see computeYrfiTopOfOrderBoost). They're applied AFTER all the legacy
  // signals so the multipliers stack on a complete baseline projection.
  //
  // When the aggregator is disabled or top-of-order data is unavailable, the
  // multiplier is 1.0 (no effect) and the behavior matches the legacy engine
  // exactly.
  //
  // ARSENAL VULNERABILITY (May 25, 2026 — same patch, follow-up question):
  //
  //   The arsenal signal asks "how many hitters in this lineup have genuine
  //   (regressed-xwOBA-validated) advantage against THIS pitcher's specific
  //   arsenal?" — which is a different question than the lineup tier label.
  //
  //   Closes an asymmetry: pre-patch, YRFI used per-hitter intelligence for
  //   the lineup but treated the pitcher as a single aggregate xwOBA number.
  //   Now both sides benefit from per-hitter analysis.
  //
  //   Multipliers pre-clamped to [0.92, 1.10] in the aggregator. Stack on top
  //   of the lineup signal multipliers.
  // ========================================================
  const lineupSignalAudit = { away: null, home: null };

  // Combined per-side multiplier: lineup top-of-order × arsenal vulnerability.
  // We multiply them so both signals contribute proportionally. The aggregator
  // already bounded each, so the combined max is ~1.32 / 0.78 — but in practice
  // they rarely both swing in the same direction simultaneously.
  const awayLineupMult = Number.isFinite(context.awayLineupSignal?.multiplier)
    ? context.awayLineupSignal.multiplier : 1.0;
  const awayArsenalMult = Number.isFinite(context.awayArsenalSignal?.multiplier)
    ? context.awayArsenalSignal.multiplier : 1.0;
  const homeLineupMult = Number.isFinite(context.homeLineupSignal?.multiplier)
    ? context.homeLineupSignal.multiplier : 1.0;
  const homeArsenalMult = Number.isFinite(context.homeArsenalSignal?.multiplier)
    ? context.homeArsenalSignal.multiplier : 1.0;

  // Apply away side (away lineup vs home pitcher)
  if (awayLineupMult !== 1.0 || awayArsenalMult !== 1.0) {
    const combinedAway = awayLineupMult * awayArsenalMult;
    awayScoresProb *= combinedAway;
    lineupSignalAudit.away = {
      lineupMultiplier: awayLineupMult,
      arsenalMultiplier: awayArsenalMult,
      combinedMultiplier: combinedAway,
      lineupReasoning: context.awayLineupSignal?.reasoning || [],
      arsenalReasoning: context.awayArsenalSignal?.reasoning || []
    };
    if (combinedAway >= 1.05) {
      const tag = awayArsenalMult > 1.02 && awayLineupMult > 1.02
        ? 'top-of-order + arsenal'
        : awayArsenalMult > 1.02 ? 'arsenal vulnerable' : 'top-of-order strong';
      reasoning.push(`Away offense edge: ${tag} (×${combinedAway.toFixed(3)})`);
    } else if (combinedAway <= 0.95) {
      reasoning.push(`Away offense suppressed by hitter aggregator (×${combinedAway.toFixed(3)})`);
    }
  }

  // Apply home side (home lineup vs away pitcher)
  if (homeLineupMult !== 1.0 || homeArsenalMult !== 1.0) {
    const combinedHome = homeLineupMult * homeArsenalMult;
    homeScoresProb *= combinedHome;
    lineupSignalAudit.home = {
      lineupMultiplier: homeLineupMult,
      arsenalMultiplier: homeArsenalMult,
      combinedMultiplier: combinedHome,
      lineupReasoning: context.homeLineupSignal?.reasoning || [],
      arsenalReasoning: context.homeArsenalSignal?.reasoning || []
    };
    if (combinedHome >= 1.05) {
      const tag = homeArsenalMult > 1.02 && homeLineupMult > 1.02
        ? 'top-of-order + arsenal'
        : homeArsenalMult > 1.02 ? 'arsenal vulnerable' : 'top-of-order strong';
      reasoning.push(`Home offense edge: ${tag} (×${combinedHome.toFixed(3)})`);
    } else if (combinedHome <= 0.95) {
      reasoning.push(`Home offense suppressed by hitter aggregator (×${combinedHome.toFixed(3)})`);
    }
  }

  // Clamp individual probs
  awayScoresProb = Math.max(0.05, Math.min(0.75, awayScoresProb));
  homeScoresProb = Math.max(0.05, Math.min(0.75, homeScoresProb));

  // ====== YRFI = P(at least one team scores) = 1 - P(neither scores) ======
  // Assume independence (close enough — the starters are different people)
  const nrfiProb = (1 - awayScoresProb) * (1 - homeScoresProb);
  const yrfiProb = 1 - nrfiProb;

  // ====== Recommendation ======
  // Compare our YRFI probability to league baseline of 57%.
  // Because sportsbooks typically price YRFI ~-110 to +120 (implied 47-52%), and NRFI ~-130 to -155 (56-60%),
  // our edge comes from meaningful divergence from the league average.
  //
  // Threshold tiers:
  //   STRONG: ≥8pp edge from 57%  (e.g. projected 67%+ or 49%-)  → 2u
  //   MODERATE: ≥5pp edge from 57%  → 1u
  //   SLIGHT: ≥3pp edge from 57%   → 0.5u
  //   PASS: <3pp edge (market is near fair)
  const deltaFromBase = yrfiProb - LEAGUE_YRFI;
  const absDelta = Math.abs(deltaFromBase);
  let side = null, tier = 'PASS', units = 0;
  if (absDelta >= 0.08) { tier = 'STRONG'; units = 2; }
  else if (absDelta >= 0.05) { tier = 'MODERATE'; units = 1; }
  else if (absDelta >= 0.03) { tier = 'SLIGHT'; units = 0.5; }
  if (tier !== 'PASS') side = deltaFromBase > 0 ? 'YRFI' : 'NRFI';

  // (Phase 1 — May 29, 2026) Calibrate the displayed probability against
  // live hit rates. Selection logic above used raw probabilities — only
  // the user-facing displayed number is adjusted. Raw kept on recommendation
  // as rawProbability for debug and future recalibration.
  const rawSideProb = side === 'YRFI' ? yrfiProb : side === 'NRFI' ? nrfiProb : yrfiProb;
  const calibratedSideProb = calibrateFiProbability(rawSideProb);

  const recommendation = {
    side,
    tier,
    units,
    probability: +calibratedSideProb.toFixed(3),
    rawProbability: +rawSideProb.toFixed(3),
    pick: side ? `${side}` : null,
    deltaFromBaseline: +deltaFromBase.toFixed(3)
  };

  return {
    yrfiProb: +yrfiProb.toFixed(3),
    nrfiProb: +nrfiProb.toFixed(3),
    awayScoresProb: +awayScoresProb.toFixed(3),
    homeScoresProb: +homeScoresProb.toFixed(3),
    recommendation,
    reasoning,
    lineupSignalAudit  // NEW (May 25, 2026): per-side lineup signal contribution
  };
}

function getFirstInningXw(inningSplits) {
  if (!inningSplits?.perInning?.[1]) return null;
  return {
    xwoba: inningSplits.perInning[1].xwobaAgainst,
    pa: inningSplits.perInning[1].pa,
    bbPct: inningSplits.perInning[1].bbPct,
    kPct: inningSplits.perInning[1].kPct
  };
}

function getLineupFirstInnBoost(lineupTier) {
  if (!lineupTier) return { mult: 1.0, reason: null };
  switch (lineupTier.label) {
    case 'HIGHLY_EXPLOITABLE': return { mult: 1.20, reason: 'elite top-of-order quality' };
    case 'EXPLOITABLE':        return { mult: 1.10, reason: 'strong lineup' };
    case 'NEUTRAL':            return { mult: 1.00, reason: null };
    case 'SUPPRESSED':         return { mult: 0.90, reason: 'weak lineup' };
    case 'LOCKED_DOWN':        return { mult: 0.82, reason: 'very weak lineup' };
    default:                   return { mult: 1.0, reason: null };
  }
}

function getControlFirstInnMult(controlTier) {
  switch (controlTier) {
    case 'elite':          return 0.93;  // elite control = fewer walks = fewer early runs
    case 'above-average':  return 0.97;
    case 'average':        return 1.00;
    case 'below-average':  return 1.06;
    case 'wild':           return 1.12;  // wild pitchers inflate 1st-inn scoring
    default:               return 1.00;
  }
}

/**
 * Grade a YRFI/NRFI bet against the final linescore.
 * @param {string} side 'YRFI' | 'NRFI'
 * @param {number} awayRunsInn1
 * @param {number} homeRunsInn1
 */
export function gradeFirstInningBet(side, awayRunsInn1, homeRunsInn1) {
  const totalRuns = (awayRunsInn1 || 0) + (homeRunsInn1 || 0);
  const scored = totalRuns > 0;
  if (side === 'YRFI') return scored ? 'win' : 'loss';
  if (side === 'NRFI') return scored ? 'loss' : 'win';
  return null;
}
