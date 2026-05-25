// api/_lib/lineupSignalAggregator.js
//
// LINEUP SIGNAL AGGREGATOR (May 25, 2026)
//
// PURPOSE
//   Aggregates per-hitter engine outputs (unassisted scores, fragility,
//   inflation flags, contact probability) into team-level signals that the
//   game total and YRFI/NRFI engines can consume.
//
// THE GAP THIS FILLS
//   Before this module, hitter-level intelligence (compound engine,
//   ecosystem-aware fragility, unassisted engine rejection) stayed at the
//   hitter level. The game projection used aggregated TIER labels
//   (EXPLOITABLE / SUPPRESSED / etc) which collapse a lot of nuance.
//
//   When a team's 1-5 hitters are all tagged as unassisted-engine ELIGIBLE
//   with low fragility, that's a strong run-scoring signal that the old
//   aggregation completely missed. Conversely, when 3 of 5 top hitters are
//   REJECTED for inflation gaps or arsenal coverage failures, the lineup
//   projection should be suppressed — even if the lineup-tier label still
//   reads EXPLOITABLE based on raw season stats.
//
// PHILOSOPHY
//   - Lineup position matters: batters 1-5 produce ~60% of plate appearances
//     and ~70% of runs. Weight them more.
//   - Multiplicative dampening: aggregated signals are sublinear so one
//     outlier hitter doesn't dominate (Math.pow(x, 0.7)).
//   - Conservative bounds: every multiplier capped to [0.85, 1.15] so the
//     new signals nudge projections, never explode them.
//
// EXPORTED FUNCTIONS
//   - aggregateLineupSignals(matchups) → { topOfOrder, fullLineup, ... }
//   - computeYrfiTopOfOrderBoost(aggregated) → multiplier (0.85-1.20)
//   - computeGameTotalLineupAdjustment(aggregated) → multiplier (0.90-1.10)
//   - computeArsenalVulnerability(matchups, pitcherXwAgainst) → multiplier

// ============================================================
// FEATURE FLAG
// ============================================================

// May 25, 2026 — DEFAULT ON per user request.
// When false, all aggregator-driven multipliers are forced to 1.0, meaning
// the projections fall back to the legacy (pre-aggregator) behavior. Useful
// if a calibration issue is suspected and you want to A/B against the prior
// engine without code changes.
export const LINEUP_SIGNAL_AGGREGATION_ENABLED = true;


// ============================================================
// CORE AGGREGATION
// ============================================================

/**
 * Aggregate per-hitter signals into team-level structure.
 *
 * @param {Array} matchups - array of per-hitter matchup objects from
 *   buildPropRecommendations. Each is expected to have:
 *   {
 *     hitter, battingOrder, tier,
 *     fragility: { score, tier },
 *     unassistedTier: 'eligible' | 'caution' | 'rejected',
 *     adjustedMaxXwoba, regressedMaxXwoba,
 *     contextMultiplier, _engineAudit: { ... }
 *   }
 * @returns {Object} aggregated signals
 */
export function aggregateLineupSignals(matchups) {
  if (!LINEUP_SIGNAL_AGGREGATION_ENABLED || !Array.isArray(matchups) || matchups.length === 0) {
    return neutralAggregation();
  }

  // Sort by batting order so we can split top-of-order vs bottom
  const sorted = matchups
    .filter(m => Number.isFinite(m?.battingOrder) && m.battingOrder > 0)
    .sort((a, b) => a.battingOrder - b.battingOrder);

  // If no batting order info is available (a defensive fallback when lineup
  // hasn't been confirmed yet), we can't aggregate meaningfully. Return
  // neutral so the consumers fall back to existing logic.
  if (sorted.length === 0) {
    return neutralAggregation();
  }

  const topOfOrder = sorted.filter(m => m.battingOrder <= 5);
  const fullLineup = sorted;

  return {
    topOfOrder: aggregateGroup(topOfOrder, 'top'),
    fullLineup: aggregateGroup(fullLineup, 'full'),
    audit: {
      topOfOrderCount: topOfOrder.length,
      fullLineupCount: fullLineup.length,
      sampleHitters: sorted.slice(0, 5).map(m => ({
        slot: m.battingOrder,
        name: m.hitter,
        unassistedTier: m.unassistedTier || 'unknown',
        fragilityScore: m.fragility?.score ?? null,
        adjustedXw: m.adjustedMaxXwoba,
        regressedXw: m.regressedMaxXwoba
      }))
    }
  };
}

/**
 * Aggregate a subset of matchups (either top-of-order or full lineup) into
 * a compact signal block.
 */
function aggregateGroup(matchups, label) {
  if (matchups.length === 0) {
    return { count: 0, ...neutralSignals() };
  }

  const fragilityScores = matchups
    .map(m => Number(m.fragility?.score))
    .filter(Number.isFinite);
  const avgFragility = fragilityScores.length > 0
    ? fragilityScores.reduce((s, v) => s + v, 0) / fragilityScores.length
    : 50;  // neutral default when no fragility data

  // Unassisted tier distribution
  let unassistedEligible = 0, unassistedCaution = 0, unassistedRejected = 0, unassistedUnknown = 0;
  for (const m of matchups) {
    const t = m.unassistedTier;
    if (t === 'eligible') unassistedEligible++;
    else if (t === 'caution') unassistedCaution++;
    else if (t === 'rejected') unassistedRejected++;
    else unassistedUnknown++;
  }
  const total = matchups.length;
  const eligibleRate = unassistedEligible / total;
  const rejectedRate = unassistedRejected / total;

  // Average inflation gap (proxy for "how much fake edge is in this lineup")
  const inflationGaps = matchups
    .map(m => {
      const adj = parseFloat(m.adjustedMaxXwoba);
      const reg = parseFloat(m.regressedMaxXwoba);
      return Number.isFinite(adj) && Number.isFinite(reg) ? Math.max(0, adj - reg) : null;
    })
    .filter(v => v !== null);
  const avgInflationGap = inflationGaps.length > 0
    ? inflationGaps.reduce((s, v) => s + v, 0) / inflationGaps.length
    : 0;

  // Average context multiplier — is the engine over-confident broadly?
  const ctxMults = matchups
    .map(m => parseFloat(m.contextMultiplier))
    .filter(Number.isFinite);
  const avgCtxMult = ctxMults.length > 0
    ? ctxMults.reduce((s, v) => s + v, 0) / ctxMults.length
    : 1.0;

  return {
    count: total,
    avgFragility,
    eligibleRate,
    rejectedRate,
    cautionCount: unassistedCaution,
    avgInflationGap,
    avgCtxMult,
    label
  };
}


// ============================================================
// CONSUMER 1: YRFI TOP-OF-ORDER BOOST
// ============================================================

/**
 * Convert aggregated top-of-order signals into a YRFI multiplier.
 *
 * Inputs to consider for first-inning scoring (top 5 hitters specifically):
 *   - High eligibility rate (≥ 60%) → these hitters are real threats
 *   - Low fragility (avg < 20) → they have multiple scoring paths
 *   - High rejection rate (≥ 40%) → multiple fake-edge hitters; suppress
 *
 * Output bounds: [0.85, 1.20]
 *   - Allow upside larger than downside because top-of-order strength is
 *     a meaningful and underweighted YRFI signal
 *   - Cap downside at -15% to avoid stacking with existing pitcher
 *     suppression (which already handles "good pitcher" cases)
 *
 * @param {Object} aggregated - output of aggregateLineupSignals
 * @returns {Object} { multiplier, reasoning, audit }
 */
export function computeYrfiTopOfOrderBoost(aggregated) {
  if (!LINEUP_SIGNAL_AGGREGATION_ENABLED || !aggregated) {
    return { multiplier: 1.0, reasoning: [], audit: { skipped: true } };
  }

  const top = aggregated.topOfOrder;
  if (!top || top.count === 0) {
    return { multiplier: 1.0, reasoning: [], audit: { skipped: true, reason: 'no_top_of_order_data' } };
  }

  let multiplier = 1.0;
  const reasoning = [];

  // === Signal 1: Eligibility concentration ===
  // When 60%+ of top-5 hitters are unassisted-eligible, the lineup has real
  // threat depth in the first inning. Boost YRFI proportionally.
  if (top.eligibleRate >= 0.60) {
    const boost = 1.0 + ((top.eligibleRate - 0.60) * 0.30);  // 0.60 → 1.0, 1.0 → 1.12
    multiplier *= boost;
    reasoning.push(`Top-of-order strength: ${(top.eligibleRate * 100).toFixed(0)}% eligible (×${boost.toFixed(3)})`);
  }

  // === Signal 2: Rejection concentration (suppression) ===
  // When 40%+ of top-5 hitters are rejected by the unassisted engine,
  // multiple hitters have fake-edge tags. Suppress YRFI.
  if (top.rejectedRate >= 0.40) {
    const suppress = 1.0 - ((top.rejectedRate - 0.40) * 0.25);  // 0.40 → 1.0, 0.80 → 0.90
    multiplier *= suppress;
    reasoning.push(`Top-of-order weakness: ${(top.rejectedRate * 100).toFixed(0)}% rejected (×${suppress.toFixed(3)})`);
  }

  // === Signal 3: Lineup-wide fragility ===
  // High avg fragility in top of order means multiple scoring-path failures
  // are likely. Used as a tiebreaker — small effect.
  if (top.avgFragility >= 35) {
    const suppress = 1.0 - Math.min(0.05, (top.avgFragility - 35) / 200);  // gentle
    multiplier *= suppress;
    reasoning.push(`Top-of-order fragility avg ${top.avgFragility.toFixed(0)} (×${suppress.toFixed(3)})`);
  }

  // Clamp to safe range
  const clamped = Math.max(0.85, Math.min(1.20, multiplier));

  return {
    multiplier: clamped,
    rawMultiplier: multiplier,
    reasoning,
    audit: {
      eligibleRate: top.eligibleRate,
      rejectedRate: top.rejectedRate,
      avgFragility: top.avgFragility,
      avgInflationGap: top.avgInflationGap,
      avgCtxMult: top.avgCtxMult,
      hitterCount: top.count
    }
  };
}


// ============================================================
// CONSUMER 2: GAME TOTAL LINEUP ADJUSTMENT
// ============================================================

/**
 * Compute a side-specific game-total multiplier from full-lineup signals.
 *
 * Game total is more sensitive than YRFI to lineup-wide signals because runs
 * accrue across 9 innings. The full lineup matters, not just the top 5.
 *
 * Output bounds: [0.90, 1.10]
 *   - Tighter than YRFI because game-total compounds across many ABs and the
 *     existing engine already captures most of the signal via lineup tier.
 *   - The aggregator's job is to nudge based on hitter-level analysis the
 *     legacy tier missed.
 *
 * @returns {Object} { multiplier, reasoning, audit }
 */
export function computeGameTotalLineupAdjustment(aggregated) {
  if (!LINEUP_SIGNAL_AGGREGATION_ENABLED || !aggregated) {
    return { multiplier: 1.0, reasoning: [], audit: { skipped: true } };
  }

  const full = aggregated.fullLineup;
  if (!full || full.count < 5) {
    return { multiplier: 1.0, reasoning: [], audit: { skipped: true, reason: 'insufficient_lineup_data' } };
  }

  let multiplier = 1.0;
  const reasoning = [];

  // === Signal 1: Lineup-wide fragility ===
  // High avg fragility across full lineup = lineup as a whole is fragile.
  // The existing tier label doesn't capture pathway-diversity failures.
  if (full.avgFragility >= 30) {
    const suppress = 1.0 - Math.min(0.08, (full.avgFragility - 30) / 150);
    multiplier *= suppress;
    reasoning.push(`Lineup avg fragility ${full.avgFragility.toFixed(0)} (×${suppress.toFixed(3)})`);
  } else if (full.avgFragility <= 15) {
    const boost = 1.0 + ((15 - full.avgFragility) / 100);  // tiny boost for very robust lineups
    multiplier *= boost;
    reasoning.push(`Lineup robust (avg fragility ${full.avgFragility.toFixed(0)}) (×${boost.toFixed(3)})`);
  }

  // === Signal 2: Inflation gap concentration ===
  // When the lineup's avg adj-vs-regressed gap is wide (>0.12), the engine
  // is broadly over-confident on this side. Modest suppression.
  if (full.avgInflationGap > 0.12) {
    const suppress = 1.0 - Math.min(0.06, (full.avgInflationGap - 0.12) * 0.3);
    multiplier *= suppress;
    reasoning.push(`Lineup avg inflation gap ${full.avgInflationGap.toFixed(3)} (×${suppress.toFixed(3)})`);
  }

  // === Signal 3: Rejection rate ===
  // High rejection rate = the unassisted engine doesn't trust most of this
  // lineup. Already partly captured by fragility, but worth a small extra
  // suppression for confirmed rejections.
  if (full.rejectedRate >= 0.35) {
    const suppress = 1.0 - ((full.rejectedRate - 0.35) * 0.10);  // 0.35 → 1.0, 0.85 → 0.95
    multiplier *= suppress;
    reasoning.push(`${(full.rejectedRate * 100).toFixed(0)}% lineup rejected (×${suppress.toFixed(3)})`);
  }

  // Clamp to tighter bounds (game total is sensitive)
  const clamped = Math.max(0.90, Math.min(1.10, multiplier));

  return {
    multiplier: clamped,
    rawMultiplier: multiplier,
    reasoning,
    audit: {
      lineupSize: full.count,
      avgFragility: full.avgFragility,
      avgInflationGap: full.avgInflationGap,
      avgCtxMult: full.avgCtxMult,
      eligibleRate: full.eligibleRate,
      rejectedRate: full.rejectedRate
    }
  };
}


// ============================================================
// CONSUMER 3: ARSENAL VULNERABILITY
// ============================================================

/**
 * Compute a pitcher arsenal vulnerability multiplier.
 *
 * This is a different angle than the weighted average pitcherXwAgainst.
 * Weighted average smooths everything; this signal asks: "How many hitters
 * in the lineup have specific arsenal advantages?"
 *
 * A pitcher might have weighted xwOBA-against of 0.310 (average) but face
 * a lineup where 6 of 9 hitters specifically demolish his slider. The
 * weighted average wouldn't catch that; this signal does.
 *
 * Output bounds: [0.92, 1.10]
 *   - Asymmetric: positive boost larger than negative because arsenal
 *     advantages compound. Negative direction (lineup has no edge against
 *     this arsenal) is already captured by pitcherXwAgainst suppression.
 *
 * @param {Array} matchups - per-hitter matchups
 * @param {number} pitcherXwAgainst - the legacy weighted xwOBA against
 * @returns {Object} { multiplier, reasoning, audit }
 */
export function computeArsenalVulnerability(matchups, pitcherXwAgainst) {
  if (!LINEUP_SIGNAL_AGGREGATION_ENABLED || !Array.isArray(matchups) || matchups.length === 0) {
    return { multiplier: 1.0, reasoning: [], audit: { skipped: true } };
  }

  // Count hitters with regressed xwOBA in the "real advantage" zone (>0.55).
  // The regressed value is the key — adj alone is inflated. A hitter with
  // regressed 0.55+ has a genuine edge that survives sample regression.
  const realAdvantageHitters = matchups.filter(m => {
    const reg = parseFloat(m.regressedMaxXwoba);
    return Number.isFinite(reg) && reg >= 0.55;
  }).length;

  // Hitters with regressed in the sweet-spot 0.50-0.60 (where historical
  // data shows 60.9% win rate). These are the "money plays" against this arsenal.
  const sweetSpotHitters = matchups.filter(m => {
    const reg = parseFloat(m.regressedMaxXwoba);
    return Number.isFinite(reg) && reg >= 0.50 && reg <= 0.60;
  }).length;

  const total = matchups.length;
  const advantageRate = realAdvantageHitters / total;
  const sweetRate = sweetSpotHitters / total;

  let multiplier = 1.0;
  const reasoning = [];

  // When ≥ 40% of the lineup has genuine arsenal advantages, the pitcher
  // is in trouble in a way the weighted-average xwOBA doesn't fully capture.
  // (Weighted avg pulls toward the mean; this metric reflects concentration.)
  if (advantageRate >= 0.40) {
    const boost = 1.0 + ((advantageRate - 0.40) * 0.20);  // 0.40 → 1.0, 0.80 → 1.08
    multiplier *= boost;
    reasoning.push(`${realAdvantageHitters}/${total} hitters with real advantage vs arsenal (×${boost.toFixed(3)})`);
  }

  // Sweet-spot concentration is a slightly different signal — these hitters
  // have the empirically best matchup profile.
  if (sweetRate >= 0.35) {
    const boost = 1.0 + ((sweetRate - 0.35) * 0.10);
    multiplier *= boost;
    reasoning.push(`${sweetSpotHitters}/${total} sweet-spot hitters (×${boost.toFixed(3)})`);
  }

  // Suppression case: if the pitcher already has a strong weighted xwOBA
  // (<0.290), don't add additional boost — that pitcher is dominant and the
  // arsenal-advantage signal is likely noise.
  if (pitcherXwAgainst && pitcherXwAgainst < 0.290 && multiplier > 1.0) {
    multiplier = 1.0 + ((multiplier - 1.0) * 0.5);  // halve any boost vs elite pitcher
    reasoning.push(`Halved boost — pitcher already elite (xwOBA ${pitcherXwAgainst.toFixed(3)})`);
  }

  const clamped = Math.max(0.92, Math.min(1.10, multiplier));

  return {
    multiplier: clamped,
    rawMultiplier: multiplier,
    reasoning,
    audit: {
      realAdvantageHitters,
      sweetSpotHitters,
      total,
      advantageRate,
      sweetRate
    }
  };
}


// ============================================================
// HELPERS
// ============================================================

function neutralAggregation() {
  return {
    topOfOrder: { count: 0, ...neutralSignals() },
    fullLineup: { count: 0, ...neutralSignals() },
    audit: { source: 'neutral', sampleHitters: [] }
  };
}

function neutralSignals() {
  return {
    avgFragility: 50,
    eligibleRate: 0,
    rejectedRate: 0,
    cautionCount: 0,
    avgInflationGap: 0,
    avgCtxMult: 1.0
  };
}


// ============================================================
// TESTING EXPORTS
// ============================================================

export const _testing = { aggregateGroup, neutralAggregation, neutralSignals };
