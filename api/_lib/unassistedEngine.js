// api/_lib/unassistedEngine.js
//
// UNASSISTED CONTACT ENGINE (May 23, 2026)
//
// PURPOSE
//   A third top-pick selection philosophy alongside SCORE and PROB.
//   Built on empirical analysis of 82 graded hitter best bets (5/19-5/23/2026)
//   showing systematic failure modes of the existing two engines.
//
// THE PROBLEM IT SOLVES
//   The tool was hitting 43.9% on hitter best bets — well below the 52.4%
//   needed at -110 juice and far below the 64-80% needed for PrizePicks/UD
//   power play payouts. The score-engine's compound-prop bias was
//   selecting hitters who got 0-for-4 shutouts 38% of the time.
//
// CORE PHILOSOPHY (from Devondrick's spec):
//   Select hitters with the best chance to put the ball in play and get
//   on base UNASSISTED — they don't need teammates to drive them in or
//   score them. They need to handle the pitcher's main arsenal with
//   either real sample size OR exceptional contact quality on small samples.
//
// DATA-DRIVEN CALIBRATION
//   Every threshold below is grounded in the historical performance data:
//
//   - Inflation gap > 0.15 → 31.6% win rate (n=19). REJECT.
//     (Picks where raw matched xwOBA inflates well above the regressed.)
//   - Recent form PA < 20 → too noisy to trust. REJECT.
//   - Hitter K% > 30 vs this arsenal → K-cluster risk dominates. REJECT.
//   - No pitch with ≥ 15 PA in arsenal coverage → small-sample inflation. REJECT.
//   - Regressed xwOBA sweet spot 0.50-0.60 → 60.9% win rate (n=23). BONUS.
//
// CHANGES IT DOES NOT MAKE
//   - The contact engine, compound engine, ecosystem, fragility scoring all
//     run as before. This module reads their outputs and applies selection.
//   - Score-engine and prob-engine remain accessible via the existing UI
//     toggle. Default flips to UNASSISTED; the others are alternates.
//   - No props are added or removed. Same prop universe; new top-pick logic.
//
// EXPORTED API
//   selectUnassistedTopPick(propRecs, hitterContext) → {
//     topPick: prop | null,        // chosen top pick (or null if all rejected)
//     eligibility: 'eligible' | 'caution' | 'rejected',
//     rejectionReasons: [...],     // why each ineligible prop was rejected
//     score: number,               // unassisted score of the top pick
//     audit: { ... }               // full breakdown
//   }

// =============================================================
// THRESHOLDS (grounded in 82-pick historical data)
// =============================================================

export const UNASSISTED_THRESHOLDS = Object.freeze({
  // Hard filters
  MAX_INFLATION_GAP: 0.15,           // adjustedMaxXwoba - regressedMaxXwoba
  MIN_RECENT_FORM_PA: 20,            // shadow recent-form sample size
  MAX_MATCHED_K_PCT: 30,             // hitter K% against this arsenal
  MIN_PA_AGAINST_MAIN_PITCH: 15,     // minimum PA against at least one of top 3 pitches
  TOP_PITCH_USAGE_THRESHOLD: 15,     // a "main pitch" is one with ≥ 15% usage

  // Scoring weights (calibrated to data buckets)
  W_HITS_PROB: 1.0,                  // primary: P(H ≥ 1) per game
  W_WALK_OBP: 0.5,                   // walks contribute to on-base unassisted
  W_MULTI_HIT: 0.3,                  // P(H ≥ 2) — drives HRR via contact path
  W_K_CLUSTER_PENALTY: 0.4,          // matched K% above season K%
  W_REGRESSED_SWEETNESS: 0.2,        // proximity to 0.55 sweet spot

  // Sweet spot for regressed xwOBA
  SWEET_SPOT_CENTER: 0.55,
  SWEET_SPOT_WIDTH: 0.10,            // half-width — full band is 0.45 to 0.65

  // Caution tier
  CAUTION_INFLATION_GAP: 0.10,       // 0.10-0.15 is caution, > 0.15 is rejection
  CAUTION_MATCHED_K_PCT: 27,         // 27-30 is caution
});

// =============================================================
// CORE SELECTION FUNCTION
// =============================================================

/**
 * Select a top pick using the unassisted-contact philosophy.
 *
 * @param {Array} propRecs - All prop candidates with attached probabilities,
 *                           fragility, and per-PA rates from upstream engines
 * @param {Object} ctx - Hitter context:
 *   {
 *     adjustedMaxXwoba: number,
 *     regressedMaxXwoba: number,
 *     matchedHitterK: number,          // matched K% against arsenal (0-100)
 *     seasonHitterK: number,           // hitter's season K% (0-100)
 *     matchedPitches: [{               // arsenal pitches with PA samples
 *       pitch: string,
 *       pitcherUsage: number,
 *       hitterPa: number,
 *       hitterXwoba: number
 *     }],
 *     recentFormPaUsed: number,
 *     pHit: { probability, baseline } | null,
 *     pCompound: { hrr, ... } | null,
 *     hitterBBPct: number,
 *     expectedPa: number
 *   }
 * @returns {Object} { topPick, eligibility, rejectionReasons, score, audit }
 */
export function selectUnassistedTopPick(propRecs, ctx) {
  const reasons = [];
  const audit = {
    thresholds: { ...UNASSISTED_THRESHOLDS },
    checks: {},
    candidateScores: []
  };

  if (!Array.isArray(propRecs) || propRecs.length === 0) {
    return { topPick: null, eligibility: 'rejected', rejectionReasons: ['no_props'], score: null, audit };
  }

  // === HARD FILTERS ===
  // These reject the entire hitter from unassisted-eligibility regardless
  // of which prop is being considered. The hitter himself isn't a clean
  // unassisted-contact play.

  const inflationGap = inflationGapFrom(ctx);
  audit.checks.inflationGap = inflationGap;
  if (inflationGap > UNASSISTED_THRESHOLDS.MAX_INFLATION_GAP) {
    reasons.push(`inflation_gap_${inflationGap.toFixed(3)} > ${UNASSISTED_THRESHOLDS.MAX_INFLATION_GAP}`);
  }

  const recentFormPa = ctx.recentFormPaUsed || 0;
  audit.checks.recentFormPa = recentFormPa;
  if (recentFormPa > 0 && recentFormPa < UNASSISTED_THRESHOLDS.MIN_RECENT_FORM_PA) {
    // Only reject if recent form data EXISTS but is too small.
    // No recent form data at all is acceptable (graceful — many hitters lack it).
    reasons.push(`recent_form_pa_${recentFormPa} < ${UNASSISTED_THRESHOLDS.MIN_RECENT_FORM_PA}`);
  }

  const matchedK = num(ctx.matchedHitterK, null);
  audit.checks.matchedK = matchedK;
  if (matchedK != null && matchedK > UNASSISTED_THRESHOLDS.MAX_MATCHED_K_PCT) {
    reasons.push(`matched_k_${matchedK.toFixed(1)} > ${UNASSISTED_THRESHOLDS.MAX_MATCHED_K_PCT}`);
  }

  // Arsenal coverage: hitter must have ≥ 15 PA against AT LEAST ONE main pitch.
  // A "main pitch" is one with ≥ 15% pitcher usage.
  // This is the strict arsenal coverage filter (Devondrick's spec).
  const arsenalCheck = checkArsenalCoverage(ctx);
  audit.checks.arsenal = arsenalCheck;
  if (!arsenalCheck.passes) {
    reasons.push(`no_main_pitch_with_min_pa (max=${arsenalCheck.maxPa}, threshold=${UNASSISTED_THRESHOLDS.MIN_PA_AGAINST_MAIN_PITCH})`);
  }

  // === ELIGIBILITY DETERMINATION ===

  let eligibility;
  if (reasons.length === 0) {
    // Check for soft cautions
    const cautionReasons = [];
    if (inflationGap > UNASSISTED_THRESHOLDS.CAUTION_INFLATION_GAP) {
      cautionReasons.push(`inflation_gap_${inflationGap.toFixed(3)}`);
    }
    if (matchedK != null && matchedK > UNASSISTED_THRESHOLDS.CAUTION_MATCHED_K_PCT) {
      cautionReasons.push(`matched_k_${matchedK.toFixed(1)}`);
    }
    eligibility = cautionReasons.length > 0 ? 'caution' : 'eligible';
    audit.cautionReasons = cautionReasons;
  } else {
    eligibility = 'rejected';
  }

  // If rejected, the hitter has no unassisted top pick. The UI falls back
  // to either showing no BEST badge, or to the SCORE/PROB engine's pick
  // (engine toggle determines).
  if (eligibility === 'rejected') {
    return {
      topPick: null,
      eligibility,
      rejectionReasons: reasons,
      score: null,
      audit
    };
  }

  // === PROP SCORING ===
  // Eligible hitter — score each prop by the unassisted-contact rubric.
  // Note we WANT to favor HITS over HRR even when HRR has higher headline
  // probability, because HRR depends on teammates. The scoring reflects this.

  const scored = propRecs.map(p => {
    const propScore = scoreUnassistedProp(p, ctx);
    audit.candidateScores.push({
      label: p.label,
      key: p.key,
      score: propScore.total,
      components: propScore.components,
      eligible: propScore.eligible
    });
    return { prop: p, score: propScore };
  });

  // Filter to props the unassisted engine considers eligible
  // (some props — RBI 0.5, RUNS 0.5 — are inherently NOT unassisted)
  const eligibleProps = scored.filter(s => s.score.eligible);

  if (eligibleProps.length === 0) {
    return {
      topPick: null,
      eligibility: 'rejected',
      rejectionReasons: ['no_eligible_prop_for_unassisted'],
      score: null,
      audit
    };
  }

  // Highest unassisted score wins
  eligibleProps.sort((a, b) => b.score.total - a.score.total);
  const winner = eligibleProps[0];

  return {
    topPick: winner.prop,
    eligibility,
    rejectionReasons: [],
    score: winner.score.total,
    audit
  };
}

// =============================================================
// HARD FILTER HELPERS
// =============================================================

function inflationGapFrom(ctx) {
  const adj = num(ctx.adjustedMaxXwoba, null);
  const reg = num(ctx.regressedMaxXwoba, null);
  if (adj == null || reg == null) return 0;
  return Math.max(0, adj - reg);
}

/**
 * Arsenal coverage check.
 * Returns { passes: bool, maxPa: number, mainPitchCount: number, ... }
 *
 * Logic:
 *   1. Identify "main pitches" — those with pitcherUsage ≥ 15%
 *   2. For at least ONE of those main pitches, hitterPa must be ≥ 15
 *   3. If no main pitches identified, fall back to the top 3 most-used
 *      pitches in the arsenal (defensive — pitcher might have a flat
 *      arsenal where no single pitch exceeds 15% usage)
 */
function checkArsenalCoverage(ctx) {
  const pitches = Array.isArray(ctx.matchedPitches) ? ctx.matchedPitches : [];
  if (pitches.length === 0) {
    return { passes: false, maxPa: 0, mainPitchCount: 0, reason: 'no_arsenal_data' };
  }

  // Main pitches: usage ≥ threshold
  let mainPitches = pitches.filter(p => (p.pitcherUsage || 0) >= UNASSISTED_THRESHOLDS.TOP_PITCH_USAGE_THRESHOLD);

  // Fallback: if no pitch exceeds the usage threshold, take the top 3 by usage
  // (some pitchers — e.g. true 4-pitch mixers — have all pitches below 15%)
  if (mainPitches.length === 0) {
    mainPitches = [...pitches].sort((a, b) => (b.pitcherUsage || 0) - (a.pitcherUsage || 0)).slice(0, 3);
  }

  // Check: does AT LEAST ONE main pitch have hitterPa ≥ MIN_PA?
  const maxPa = mainPitches.reduce((max, p) => Math.max(max, p.hitterPa || 0), 0);
  const passes = maxPa >= UNASSISTED_THRESHOLDS.MIN_PA_AGAINST_MAIN_PITCH;

  return {
    passes,
    maxPa,
    mainPitchCount: mainPitches.length,
    minPaRequired: UNASSISTED_THRESHOLDS.MIN_PA_AGAINST_MAIN_PITCH,
    pitches: mainPitches.map(p => ({
      pitch: p.pitch,
      usage: p.pitcherUsage,
      hitterPa: p.hitterPa,
      hitterXwoba: p.hitterXwoba
    }))
  };
}

// =============================================================
// PROP SCORING
// =============================================================

/**
 * Score a single prop by the unassisted-contact rubric.
 *
 * Returns { total: number, components: {...}, eligible: bool }
 *
 * Eligibility within the unassisted engine:
 *   - HITS  → fully eligible (the cleanest unassisted prop)
 *   - HRR   → eligible BUT scored based on multi-hit pathway, not HR/RBI
 *   - PP_FS / UD_FS → eligible but discounted (compound, ecosystem-dependent)
 *   - R, RBI → NOT eligible (assist-dependent props don't fit this engine)
 *   - HR    → NOT eligible (HR is variance, not unassisted skill)
 *   - TB    → eligible but heavily discounted (mostly hits, some XBH)
 */
function scoreUnassistedProp(prop, ctx) {
  const components = {};

  // === ELIGIBILITY GATE ===
  // Props that fundamentally require teammates are ineligible regardless of
  // probability. The unassisted engine refuses to make these its top pick.
  const fullyEligible = ['H', 'HRR'];
  const partiallyEligible = ['PP_FS_6', 'PP_FS_8', 'UD_FS_5', 'UD_FS_7', 'TB'];
  const ineligible = ['R', 'RBI', 'HR'];

  if (ineligible.includes(prop.key)) {
    return { total: -Infinity, components: { reason: 'requires_assists' }, eligible: false };
  }

  // === BASE SCORE: HITS PROBABILITY ===
  // The single strongest unassisted signal. Per-game P(H ≥ 1).
  const pHits = num(prop.probability, null);
  if (pHits == null && prop.key === 'H') {
    // No probability on HITS prop — engine couldn't run. Reject.
    return { total: -Infinity, components: { reason: 'no_hits_prob' }, eligible: false };
  }
  components.pHits = pHits;

  // For non-H props, derive a hits-equivalent score from the context's pHit
  // (the contact engine's per-PA hit rate compounded over expectedPa)
  const ctxHitProb = ctx.pHit?.probability;
  const ePa = ctx.expectedPa || 4.0;
  const hitsPerGameProb = pHits != null ? pHits
    : (Number.isFinite(ctxHitProb) ? (1 - Math.pow(1 - ctxHitProb, ePa)) : 0);
  components.hitsPerGameProb = hitsPerGameProb;

  let score = UNASSISTED_THRESHOLDS.W_HITS_PROB * hitsPerGameProb;

  // === WALK COMPONENT ===
  // Walks count as "on base unassisted." Use hitter's BB% × expectedPa as
  // an approximation of P(walk in game). Capped — we don't want to make
  // a walk-only hitter look like a strong unassisted pick.
  const bbPct = num(ctx.hitterBBPct, 8.5) / 100;
  const pWalkInGame = Math.min(0.40, 1 - Math.pow(1 - bbPct, ePa));
  components.pWalkInGame = pWalkInGame;
  score += UNASSISTED_THRESHOLDS.W_WALK_OBP * pWalkInGame;

  // === MULTI-HIT PATHWAY ===
  // P(H ≥ 2) — the "multi-hit path" that clears HRR independently of teammates.
  // The data showed 44% of HRR wins come via 2+ hits (no HR). This is the
  // strongest unassisted route to HRR clearance.
  // Approximate from per-PA hit rate: P(H ≥ 2 | ePa PAs) = 1 - P(0) - P(1)
  // Binomial: P(0) = (1-p)^ePa, P(1) = ePa * p * (1-p)^(ePa-1)
  let pMultiHit = 0;
  if (Number.isFinite(ctxHitProb)) {
    const p = ctxHitProb;
    const n = ePa;
    const p0 = Math.pow(1 - p, n);
    const p1 = n * p * Math.pow(1 - p, n - 1);
    pMultiHit = Math.max(0, 1 - p0 - p1);
  }
  components.pMultiHit = pMultiHit;
  score += UNASSISTED_THRESHOLDS.W_MULTI_HIT * pMultiHit;

  // === K-CLUSTER PENALTY ===
  // If matched K% is much higher than season K%, the pitcher's arsenal
  // creates above-baseline strikeout risk. Penalize.
  const matched = num(ctx.matchedHitterK, null);
  const season = num(ctx.seasonHitterK, null);
  let kPenalty = 0;
  if (matched != null && season != null) {
    const gap = Math.max(0, (matched - season) / 100);  // e.g. matched=30, season=22 → gap=0.08
    kPenalty = UNASSISTED_THRESHOLDS.W_K_CLUSTER_PENALTY * gap;
    components.kClusterPenalty = kPenalty;
    score -= kPenalty;
  } else {
    components.kClusterPenalty = 0;
  }

  // === REGRESSED XWOBA SWEET SPOT ===
  // Data showed regressed xwOBA in 0.50-0.60 hits 60.9% — the strongest
  // bucket. Bonus for proximity to 0.55, falling off linearly outside the
  // band [0.45, 0.65].
  const reg = num(ctx.regressedMaxXwoba, null);
  let sweetness = 0;
  if (reg != null) {
    const dist = Math.abs(reg - UNASSISTED_THRESHOLDS.SWEET_SPOT_CENTER);
    if (dist <= UNASSISTED_THRESHOLDS.SWEET_SPOT_WIDTH) {
      sweetness = 1 - (dist / UNASSISTED_THRESHOLDS.SWEET_SPOT_WIDTH);
    }
  }
  components.sweetness = sweetness;
  score += UNASSISTED_THRESHOLDS.W_REGRESSED_SWEETNESS * sweetness;

  // === PROP-TYPE DISCOUNTING ===
  // Even within the eligible set, prefer cleaner unassisted props.
  // HITS gets full credit. HRR gets 0.85x because it has an HR component.
  // FS / TB get 0.70x because they're compound-ish.
  let propMultiplier = 1.0;
  if (prop.key === 'HRR') propMultiplier = 0.85;
  else if (partiallyEligible.includes(prop.key)) propMultiplier = 0.70;
  components.propMultiplier = propMultiplier;
  score *= propMultiplier;

  return {
    total: score,
    components,
    eligible: fullyEligible.includes(prop.key) || partiallyEligible.includes(prop.key)
  };
}

// =============================================================
// HELPER
// =============================================================

function num(v, fallback) {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Exported for tests
export const _testing = {
  inflationGapFrom,
  checkArsenalCoverage,
  scoreUnassistedProp
};
