// nflClassify.js
// Lyrid NFL engine — the classifier (Layer 6b) — SHARPENED 2026-10-22
//
// CHANGES (from graded history + chat research):
//   * Promotion floor raised: edge ≥ 0.25 (the only historical bucket that hit ~59%).
//   * Multi-signal requirement: ≥ 2 independent positive signals required for PROMOTE.
//   * Decision vocabulary expanded: PROMOTE | LEAN | DEMOTE | KILL.
//   * Soft-line + volume + script remain, but are now inputs to a signal counter
//     instead of a rigid three-filter AND that produced too many weak "GOLD" labels.
//   * GUARANTEED tier remains disabled (it graded as the worst tier).
//
// CRITICAL DISCIPLINE (still enforced):
//   * Tiers are NFL-recalibrated. Labels are CANDIDATES until Wilson lower-bound
//     clears breakeven on real out-of-sample n.
//   * Additive nudges only (logit space). Never multiplicative.

export const BREAKEVEN = {
  standard_2: 0.535,
  standard_3: 0.550,
  standard_4: 0.562,
  standard_5: 0.574,
};

// Raised floors based on 702 graded props (edge ≥ 0.25 → 59.1% hit rate).
const TIER_PROVISIONAL = {
  GOLD:       { minP: 0.58, minEdge: 0.15 },   // was 0.57 / 0.035
  PLATINUM:   { minP: 0.65, minEdge: 0.25 },   // was 0.62 / 0.06  — now requires real edge
  GUARANTEED: { minP: 0.72, minEdge: 0.30 },   // still disabled in assignment
};

const VOLUME_MIN = 0.60;
const SOFTNESS_MIN = 3.0;

// New promotion constants (backtested)
const MIN_EDGE_PROMOTE = 0.25;
const MIN_EDGE_STRICT  = 0.28;
const MIN_PROB         = 0.65;   // directional probability
const MIN_SIGNALS      = 2;

export function wilsonLower(wins, n, z = 1.96) {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return +((centre - margin) / denom).toFixed(4);
}

/**
 * Count independent positive signals.
 * Each signal is a distinct reason the prop has a real edge.
 * Designed so scheme/suppression/OL-DL/role volatility (the chat-derived factors)
 * are first-class.
 */
export function countPositiveSignals({
  volume = {},
  script = {},
  schemeNudge = 0,
  suppressionScore = 0.5,   // lower = more suppressed
  olDlDiff = 0,
  secondaryInjuryBoost = false,
  gameScriptScore = 0.5,
  recentFormMult = 1.0,
  recentFormLabel = 'NEUTRAL',
  projectedCarries = 0,
  routeShare = 0,
  snapShare = 0,
  isCommittee = false,
  isCapped = false,
}) {
  let signals = 0;
  const details = [];

  // 1. Volume / role stability
  if (volume.volume_floor_score != null && volume.volume_floor_score >= VOLUME_MIN) {
    signals += 1;
    details.push(`volume-secure (${volume.volume_floor_score.toFixed(2)})`);
  }
  if (projectedCarries >= 15 || routeShare >= 0.70 || snapShare >= 0.70) {
    signals += 1;
    details.push('high role share');
  }

  // 2. Scheme / coverage fit (chat research)
  if (schemeNudge >= 0.04) {
    signals += 1;
    details.push(`scheme fit (+${schemeNudge.toFixed(3)})`);
  }
  if (suppressionScore <= 0.35) {
    signals += 1;
    details.push(`low suppression (${suppressionScore.toFixed(2)})`);
  }

  // 3. OL/DL or secondary mismatch
  if (olDlDiff >= 0.08) {
    signals += 1;
    details.push(`OL/DL edge (+${olDlDiff.toFixed(3)})`);
  }
  if (secondaryInjuryBoost) {
    signals += 1;
    details.push('secondary injury boost');
  }

  // 4. Game script
  if (!script.flag && gameScriptScore >= 0.55) {
    signals += 1;
    details.push('clear / positive script');
  }

  // 5. Recent form
  if (recentFormMult >= 1.05 || recentFormLabel === 'HOT') {
    signals += 1;
    details.push(`form ${recentFormLabel}`);
  }

  // Hard negatives that subtract or block
  if (isCommittee || isCapped) {
    // Overs on capped/committee roles are killed later; here we just note
    details.push(isCommittee ? 'committee' : 'capped');
  }

  return { signals, details };
}

/**
 * Core decision function.
 * Returns one of: PROMOTE | LEAN | DEMOTE | KILL
 */
export function promoteDecision({
  edge,
  directionalProb,
  signals,
  isCapped = false,
  isCommittee = false,
  lean = 'OVER',
}) {
  // Hard kills first
  if ((isCapped || isCommittee) && lean === 'OVER') return 'KILL';
  if (edge < 0.05) return 'KILL';

  // Primary promotion gate (backtested on 702 props)
  if (edge >= MIN_EDGE_PROMOTE && directionalProb >= MIN_PROB && signals >= MIN_SIGNALS) {
    return edge >= MIN_EDGE_STRICT ? 'PROMOTE' : 'PROMOTE';
  }

  // Secondary lean zone
  if (edge >= 0.15 && directionalProb >= 0.58 && signals >= 1) return 'LEAN';

  // Soft positive but not bettable
  if (edge >= 0.10 && directionalProb >= 0.52) return 'DEMOTE';

  return 'KILL';
}

/**
 * Classify ONE prop — main entry point.
 * Extra optional context fields enable the new multi-signal logic.
 * Old callers that only pass {comp, volume, script, line, ...} still work;
 * they simply receive fewer signals and therefore stricter promotion.
 */
export function classifyProp({
  comp,
  volume,
  script,
  line,
  structure = 'standard_3',
  extraNudges = 0,
  pick = 'higher',
  // new optional context for signal counting
  schemeNudge = 0,
  suppressionScore = 0.5,
  olDlDiff = 0,
  secondaryInjuryBoost = false,
  gameScriptScore = 0.5,
  recentFormMult = 1.0,
  recentFormLabel = 'NEUTRAL',
  projectedCarries = 0,
  routeShare = 0,
  snapShare = 0,
  isCommittee = false,
  isCapped = false,
}) {
  const out = {
    pick,
    line,
    tier_candidate: 'none',
    decision: 'KILL',          // new primary output
    filters: { softLine: false, volumeSecure: false, scriptClear: false },
    pOver: comp?.pOver ?? null,
    pOverAdjusted: null,
    edge: null,
    directionalProb: null,
    signals: 0,
    signalDetails: [],
    reasons: [],
    blocked: [],
    provisional: true,
  };

  if (!comp || comp.pOver == null) {
    out.blocked.push('no comp projection');
    return out;
  }

  // Additive nudges in logit space
  const logit = p => Math.log(p / (1 - p));
  const invlogit = x => 1 / (1 + Math.exp(-x));
  const pAdj = +invlogit(
    logit(Math.min(0.999, Math.max(0.001, comp.pOver))) + extraNudges * 0.5
  ).toFixed(4);
  out.pOverAdjusted = pAdj;

  const breakeven = BREAKEVEN[structure] ?? 0.55;
  out.edge = +(pAdj - breakeven).toFixed(4);

  // Directional probability (handles UNDER correctly)
  const lean = (pick || 'higher').toLowerCase() === 'lower' ? 'UNDER' : 'OVER';
  out.directionalProb = lean === 'OVER' ? pAdj : +(1 - pAdj).toFixed(4);

  // ---- Classic three filters (kept for compatibility & reasons) ----
  if (comp.lineSoftness != null && comp.lineSoftness >= SOFTNESS_MIN && out.edge >= 0.04) {
    out.filters.softLine = true;
    out.reasons.push(`soft line (median ${comp.median} vs line ${line}, +${comp.lineSoftness})`);
  } else {
    out.blocked.push(`line not soft enough (softness ${comp.lineSoftness}, edge ${out.edge})`);
  }

  if (volume && volume.volume_floor_score != null && volume.volume_floor_score >= VOLUME_MIN) {
    out.filters.volumeSecure = true;
    out.reasons.push(
      `volume-secure (floor ${Number(volume.volume_floor_score).toFixed(2)}${
        volume.archetype ? `, ${volume.archetype}` : ''
      })`
    );
  } else {
    out.blocked.push(`volume floor too low (${volume?.volume_floor_score})`);
  }

  if (!script || !script.flag) {
    out.filters.scriptClear = true;
  } else {
    out.blocked.push(`game-script risk flag: ${script.reasons?.[0] || 'blowout/abandon risk'}`);
  }

  // ---- New multi-signal count ----
  const { signals, details } = countPositiveSignals({
    volume,
    script,
    schemeNudge,
    suppressionScore,
    olDlDiff,
    secondaryInjuryBoost,
    gameScriptScore,
    recentFormMult,
    recentFormLabel,
    projectedCarries,
    routeShare,
    snapShare,
    isCommittee,
    isCapped,
  });
  out.signals = signals;
  out.signalDetails = details;

  // ---- Decision ----
  out.decision = promoteDecision({
    edge: out.edge,
    directionalProb: out.directionalProb,
    signals,
    isCapped,
    isCommittee,
    lean,
  });

  // Map decision → tier_candidate for downstream compatibility
  if (out.decision === 'PROMOTE') {
    if (out.edge >= MIN_EDGE_STRICT && out.directionalProb >= 0.65) {
      out.tier_candidate = 'PLATINUM';
    } else {
      out.tier_candidate = 'GOLD';
    }
  } else if (out.decision === 'LEAN') {
    out.tier_candidate = 'GOLD'; // lean still surfaces, but lower rank
  } else {
    out.tier_candidate = 'none';
  }

  // Final hard block notes
  if (out.decision === 'KILL' && (isCapped || isCommittee) && lean === 'OVER') {
    out.blocked.push(isCommittee ? 'committee role — OVER killed' : 'capped role — OVER killed');
  }

  return out;
}

export { TIER_PROVISIONAL, VOLUME_MIN, SOFTNESS_MIN, MIN_EDGE_PROMOTE, MIN_EDGE_STRICT, MIN_PROB, MIN_SIGNALS };
