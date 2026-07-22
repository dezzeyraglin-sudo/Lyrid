// nflClassify.js
// Lyrid NFL engine — the classifier (Layer 6b).
// Ties the three-filter decision rule into a tier:
//   1. SOFT LINE      — P(over) edge over breakeven AND line below modeled median
//   2. VOLUME-SECURE   — volume_floor_score above threshold
//   3. SCRIPT-CLEAR     — game-script risk flag not tripped
// A pick qualifies only when all three align. Tiers reflect margin of edge.
//
// CRITICAL DISCIPLINE (Lyrid rules, enforced here):
//   * Tiers are NFL-recalibrated: GOLD ~57%, PLATINUM ~62%, GUARANTEED ~68% —
//     NOT the 85-100% bands from other sports.
//   * No tier LABEL ships to production until backtest gives real n per tier AND
//     the Wilson lower-bound floor clears breakeven. This module EMITS tier
//     CANDIDATES; a separate calibration gate (backtest) authorizes labels.
//   * additive-not-multiplicative; provisional thresholds flagged.

// Breakeven per Underdog structure (per-leg). From research report.
export const BREAKEVEN = {
  standard_2: 0.535,
  standard_3: 0.550,
  standard_4: 0.562,
  standard_5: 0.574,
};

// PROVISIONAL tier thresholds on modeled P(over). MUST be replaced by empirical
// out-of-sample hit rates once backtest has >=100 qualifying picks per tier.
const TIER_PROVISIONAL = {
  GOLD:       { minP: 0.57, minEdge: 0.035 },
  PLATINUM:   { minP: 0.62, minEdge: 0.06 },
  GUARANTEED: { minP: 0.68, minEdge: 0.10 },
};

const VOLUME_MIN = 0.6;          // volume_floor_score gate (winning-style anchor)
const SOFTNESS_MIN = 3.0;        // modeled median must beat line by >=3 yards for OVER

// Wilson score lower bound (95%) — gate for authorizing a LABEL from backtest counts.
export function wilsonLower(wins, n, z = 1.96) {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return +((centre - margin) / denom).toFixed(4);
}

// Classify ONE prop.
// inputs:
//   comp: { pOver, median, lineSoftness }  (from nflCompEngine)
//   volume: { volume_floor_score, archetype }
//   script: { risk, flag, reasons }
//   line, structure ('standard_2'..), pick ('higher' default)
//   extraNudges: sum of scheme + suppression + env + player_vs_opp nudges (z-space),
//                folded into an ADJUSTED pOver additively via a small logit shift.
export function classifyProp({ comp, volume, script, line, structure = 'standard_3', extraNudges = 0, pick = 'higher' }) {
  const out = {
    pick, line,
    tier_candidate: 'none',
    filters: { softLine: false, volumeSecure: false, scriptClear: false },
    pOver: comp?.pOver ?? null,
    pOverAdjusted: null,
    edge: null,
    reasons: [],
    blocked: [],
  };

  if (!comp || comp.pOver == null) { out.blocked.push('no comp projection'); return out; }

  // fold extra additive nudges into pOver via a bounded logit shift (keeps 0-1, additive in logit space)
  const logit = p => Math.log(p / (1 - p));
  const invlogit = x => 1 / (1 + Math.exp(-x));
  const pAdj = +invlogit(logit(Math.min(0.999, Math.max(0.001, comp.pOver))) + extraNudges * 0.5).toFixed(4);
  out.pOverAdjusted = pAdj;

  const breakeven = BREAKEVEN[structure] ?? 0.55;
  out.edge = +(pAdj - breakeven).toFixed(4);

  // ---- Filter 1: SOFT LINE ----
  if (comp.lineSoftness != null && comp.lineSoftness >= SOFTNESS_MIN && out.edge >= TIER_PROVISIONAL.GOLD.minEdge) {
    out.filters.softLine = true;
    out.reasons.push(`soft line (median ${comp.median} vs line ${line}, +${comp.lineSoftness})`);
  } else {
    out.blocked.push(`line not soft enough (softness ${comp.lineSoftness}, edge ${out.edge})`);
  }

  // ---- Filter 2: VOLUME-SECURE ----
  if (volume && volume.volume_floor_score != null && volume.volume_floor_score >= VOLUME_MIN) {
    out.filters.volumeSecure = true;
    out.reasons.push(`volume-secure (${volume.volume_floor_score}, ${volume.archetype})`);
  } else {
    out.blocked.push(`volume floor too low (${volume?.volume_floor_score})`);
  }

  // ---- Filter 3: SCRIPT-CLEAR ----
  if (!script || !script.flag) {
    out.filters.scriptClear = true;
  } else {
    out.blocked.push(`game-script risk flag: ${script.reasons?.[0] || 'blowout/abandon risk'}`);
  }

  // ---- Tier assignment: ALL THREE must pass ----
  const allPass = out.filters.softLine && out.filters.volumeSecure && out.filters.scriptClear;
  if (allPass) {
    if (pAdj >= TIER_PROVISIONAL.GUARANTEED.minP && out.edge >= TIER_PROVISIONAL.GUARANTEED.minEdge) out.tier_candidate = 'GUARANTEED';
    else if (pAdj >= TIER_PROVISIONAL.PLATINUM.minP && out.edge >= TIER_PROVISIONAL.PLATINUM.minEdge) out.tier_candidate = 'PLATINUM';
    else if (pAdj >= TIER_PROVISIONAL.GOLD.minP) out.tier_candidate = 'GOLD';
  }
  // NOTE: tier_candidate is a CANDIDATE only — a label ships only after backtest
  // confirms the tier's empirical Wilson-lower-bound > breakeven (see wilsonLower).
  out.provisional = true;
  return out;
}

export { TIER_PROVISIONAL, VOLUME_MIN, SOFTNESS_MIN };
