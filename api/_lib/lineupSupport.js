// api/_lib/lineupSupport.js
//
// PER-HITTER LINEUP SUPPORT FACTOR (Phase 2 — May 29, 2026)
//
// PURPOSE
//   For HRR-type compound props (H+R+RBI), the hitter needs his teammates
//   to either:
//     - get on base ahead of him (so he can drive them in for an RBI)
//     - drive him in after he reaches base (so he scores an R)
//
//   Without accounting for this, the model overweights elite hitters in dead
//   offenses. May 29, 2026 audit (n=143 graded HRR picks): 15% of losses
//   were "orphaned hits" — the hitter did his job, the lineup didn't.
//
// INPUTS (all already in matchup/side data — no new fetches needed)
//   matchup.battingOrder              — lineup slot 1-9
//   sideContext.teamEcosystem.obp     — from teamEcosystem.js
//   sideContext.teamEcosystem.runsPerGame
//   sideContext.allHitters[]          — other matchups on same side
//     (used to read OBP / xwoba of slots ±3 around this hitter)
//
// OUTPUT
//   { factor, components, audit } where factor ∈ [0.65, 1.35]
//
// This factor MULTIPLIES the COMPOUND prop probability (HRR especially).
// It is NOT applied to per-PA contact probability (hits are independent
// of lineup conversion). See applyLineupSupportToProb for prop-specific
// weighting.
//
// LIMITS
//   ±35% total. Even the worst lineup support can't kill a great hitter
//   pick, and even the best can't save a structurally weak one.

import { LEAGUE_ECOSYSTEM } from './teamEcosystem.js';

const LEAGUE_AVG_RPG = LEAGUE_ECOSYSTEM.runsPerGame;  // 4.45
const LEAGUE_AVG_OBP = LEAGUE_ECOSYSTEM.obp;          // 0.318

// Batting order RBI-opportunity weights, empirically derived.
// Slots 2-5 see the most RBI ops (men on base ahead of them).
// Slot 3 anchored at 1.18 (cleanup-adjacent peak).
const SLOT_RBI_WEIGHT = {
  1: 0.78, 2: 1.05, 3: 1.18, 4: 1.15, 5: 1.05,
  6: 0.92, 7: 0.82, 8: 0.72, 9: 0.65
};

// Batting order RUN-opportunity weights. Top of order scores most
// (they get extra PAs AND lead off innings with the lineup behind them).
const SLOT_RUN_WEIGHT = {
  1: 1.22, 2: 1.18, 3: 1.10, 4: 1.02, 5: 0.94,
  6: 0.86, 7: 0.80, 8: 0.74, 9: 0.70
};

/**
 * Compute lineup support factor for a hitter in a given game context.
 *
 * @param {Object} matchup - this hitter's matchup object
 * @param {Object} sideContext - { teamEcosystem, allHitters }
 * @returns {Object} { factor, components, audit }
 */
export function computeLineupSupportFactor(matchup, sideContext = {}) {
  const slot = parseInt(matchup?.battingOrder) || null;
  const eco = sideContext.teamEcosystem || LEAGUE_ECOSYSTEM;
  const allHitters = sideContext.allHitters || [];

  // === COMPONENT 1: SLOT EXPECTATION ===
  // Blend RBI-opp and run-opp weights since HRR cares about both.
  const rbiWeight = slot ? (SLOT_RBI_WEIGHT[slot] || 1.0) : 1.0;
  const runWeight = slot ? (SLOT_RUN_WEIGHT[slot] || 1.0) : 1.0;
  const slotFactor = (rbiWeight + runWeight) / 2;  // ~0.70 to ~1.15

  // === COMPONENT 2: TEAM OFFENSIVE STRENGTH ===
  // Sublinear so even bad offenses generate SOME runs.
  const rpgRatio = (eco.runsPerGame || LEAGUE_AVG_RPG) / LEAGUE_AVG_RPG;
  const offenseFactor = Math.pow(rpgRatio, 0.6);  // 0.83 to 1.12 typical

  // === COMPONENT 3: ON-BASE-AHEAD (drives RBI opportunity) ===
  // Look at the 2-3 hitters ahead in the order. High-OBP runners ahead
  // = more RBI opps for this hitter. Only meaningful for slots 3-7.
  let obpAheadFactor = 1.0;
  if (slot && slot >= 3 && slot <= 7 && allHitters.length > 0) {
    const aheadSlots = [slot - 1, slot - 2, slot - 3].filter(s => s >= 1);
    const aheadHitters = aheadSlots
      .map(s => allHitters.find(h => parseInt(h?.battingOrder) === s))
      .filter(Boolean);

    if (aheadHitters.length > 0) {
      // Try season OBP first, fall back to inferred from xwoba.
      const aheadObps = aheadHitters.map(h => {
        const obp = parseFloat(h?.seasonStats?.obp || h?.seasonStats?.overall?.obp);
        if (Number.isFinite(obp) && obp > 0) return obp;
        // Rough fallback: xwoba ~ 0.7×OBP + 0.3×SLG → OBP ~ xwoba × 0.7
        const xw = parseFloat(h?.adjustedMaxXwoba || h?.regressedMaxXwoba);
        if (Number.isFinite(xw) && xw > 0) {
          return Math.max(0.250, Math.min(0.420, xw * 0.7));
        }
        return LEAGUE_AVG_OBP;
      });
      const meanObpAhead = aheadObps.reduce((a, b) => a + b, 0) / aheadObps.length;
      obpAheadFactor = 0.75 + 0.5 * (meanObpAhead / LEAGUE_AVG_OBP);  // ~0.85 to ~1.20
      obpAheadFactor = Math.max(0.80, Math.min(1.25, obpAheadFactor));
    }
  }

  // === COMPONENT 4: ON-BASE-BEHIND (drives RUN scoring) ===
  // After this hitter reaches base, can the hitters behind drive him in?
  // Most meaningful for slots 1-5.
  let obpBehindFactor = 1.0;
  if (slot && slot <= 5 && allHitters.length > 0) {
    const behindSlots = [slot + 1, slot + 2, slot + 3].filter(s => s <= 9);
    const behindHitters = behindSlots
      .map(s => allHitters.find(h => parseInt(h?.battingOrder) === s))
      .filter(Boolean);

    if (behindHitters.length > 0) {
      const behindXws = behindHitters
        .map(h => parseFloat(h?.adjustedMaxXwoba || h?.regressedMaxXwoba))
        .filter(v => Number.isFinite(v) && v > 0);
      if (behindXws.length > 0) {
        const meanXwBehind = behindXws.reduce((a, b) => a + b, 0) / behindXws.length;
        // 0.40 xwoba behind = strong protection (~1.10)
        // 0.30 xwoba behind = weak (~0.90)
        obpBehindFactor = 0.80 + 0.75 * Math.max(0, (meanXwBehind - 0.30) / 0.20);
        obpBehindFactor = Math.max(0.85, Math.min(1.20, obpBehindFactor));
      }
    }
  }

  // === COMBINE ===
  // Components stack multiplicatively. Clamp final to [0.65, 1.35] — ±35%.
  const rawFactor = slotFactor * offenseFactor * obpAheadFactor * obpBehindFactor;
  const factor = Math.max(0.65, Math.min(1.35, rawFactor));

  return {
    factor: Number(factor.toFixed(3)),
    components: {
      slot,
      slotFactor: Number(slotFactor.toFixed(3)),
      offenseFactor: Number(offenseFactor.toFixed(3)),
      obpAheadFactor: Number(obpAheadFactor.toFixed(3)),
      obpBehindFactor: Number(obpBehindFactor.toFixed(3)),
    },
    audit: {
      teamRpg: eco.runsPerGame || null,
      teamObp: eco.obp || null,
      slotsAhead: slot ? [slot - 1, slot - 2, slot - 3].filter(s => s >= 1) : [],
      slotsBehind: slot ? [slot + 1, slot + 2, slot + 3].filter(s => s <= 9) : [],
    }
  };
}

/**
 * Apply the support factor to a compound probability, prop-specifically.
 *
 *   H        — no-op (hits independent of lineup conversion)
 *   HR / TB  — minimal effect (HR is solo by definition)
 *   RBI      — driven primarily by runners ahead
 *   R        — driven primarily by protection behind
 *   HRR      — full factor (combines all dependencies)
 *
 * @param {number} probability — baseline probability 0-1
 * @param {Object} supportFactor — output from computeLineupSupportFactor
 * @param {string} propKey — H | HR | TB | RBI | R | HRR
 * @returns {number} adjusted probability, clamped to [0.02, 0.95]
 */
export function applyLineupSupportToProb(probability, supportFactor, propKey) {
  if (!Number.isFinite(probability) || !supportFactor || !propKey) return probability;
  const f = supportFactor.factor;
  const c = supportFactor.components;

  let applied;
  switch ((propKey || '').toUpperCase()) {
    case 'H':
      applied = 1.0;  // hits are independent of lineup
      break;
    case 'HR':
    case 'TB':
      // Tiny effect through slot opportunity only (extra PAs matter slightly)
      applied = 0.5 + 0.5 * c.slotFactor;
      applied = Math.max(0.90, Math.min(1.10, applied));
      break;
    case 'RBI':
      // RBI = primarily runners-ahead
      applied = (c.slotFactor * 0.30) + (c.offenseFactor * 0.25) + (c.obpAheadFactor * 0.45);
      break;
    case 'R':
      // R = primarily what's behind you
      applied = (c.slotFactor * 0.30) + (c.offenseFactor * 0.25) + (c.obpBehindFactor * 0.45);
      break;
    case 'HRR':
    case 'H+R+RBI':
      applied = f;
      break;
    default:
      applied = 1.0;
  }

  const adjusted = probability * applied;
  return Math.max(0.02, Math.min(0.95, adjusted));
}
