// api/_lib/damageArchetype.js
//
// DAMAGE QUALITY PHASE 2 — ARCHETYPE CLASSIFIER
//
// Classify hitters and pitchers by batted-ball profile, then apply tier-shift
// modifiers based on the matchup matrix from DAMAGE_QUALITY_DESIGN.md.
//
// Phase 1 (already shipped) populates the input data: hitter seasonStats now
// includes gb_percent, fb_percent, ld_percent, popup_percent, sweet_spot_percent,
// pull_percent. This module consumes those fields.
//
// Use the FEATURE FLAG `DAMAGE_QUALITY_ENABLED` in analyze.js to gate this
// module's output. Initial deploy should run in shadow mode (compute archetypes,
// log them, but don't apply tier shifts) for 3-5 slates before flipping live.
//
// VALIDATION CASE (Josh Jung, 2026-05-09):
//   Stats: GB% 45.9, FB% 18.3, LD% 31.2, PU% 4.6, Pull% 34.9, Barrel% 4.6
//   → LINE_DRIVE archetype (LD ≥ 24, FB < 45)
//   → vs Cabrera (BARREL_SUSCEPTIBLE if allowed Barrel% ≥ 9): +1 tier shift
//   Outcome that day: 3-for-4, HR — confirms archetype-aware analysis correct
//   his profile (line-drive hitter, decent power pathway when matchup permits).

// =============================================================
// LEAGUE BASELINES (2024-25 MLB averages)
// =============================================================
const LEAGUE = {
  GB_PCT: 44.0,
  FB_PCT: 36.0,
  LD_PCT: 20.0,
  PU_PCT: 4.0,
  BARREL_PCT: 7.5,
  HARD_HIT_PCT: 38.0,
  SWEET_SPOT_PCT: 33.0,
  PULL_PCT: 39.0
};

// Sample-size regression prior for batted-ball %s.
// Mirrors the 120-PA prior in hrEmpirical.js — pulls small-sample observed
// values toward league average until the underlying sample stabilizes.
const PRIOR_BBE = 100;

// Minimum batted-ball events for any archetype call.
// Below this, return INSUFFICIENT — don't classify, don't tier-shift.
const MIN_BBE_FOR_CLASSIFY = 30;

// =============================================================
// HITTER ARCHETYPE CLASSIFICATION
// =============================================================

/**
 * Classify a hitter into one of five archetypes based on batted-ball profile.
 *
 * @param {Object} stats - hitter's seasonStats with batted-ball %s populated
 * @returns {{ archetype: string, displayLabel: string, color: string,
 *             gbPct: number, fbPct: number, ldPct: number,
 *             regressed: boolean }} or INSUFFICIENT/null
 */
export function classifyHitter(stats) {
  if (!stats) return null;

  // Get BBE count — needed for sample-size regression
  const bbe = stats.batted_balls || stats.bbe || stats.batted_ball_events || 0;

  if (bbe < MIN_BBE_FOR_CLASSIFY) {
    return {
      archetype: 'INSUFFICIENT',
      displayLabel: 'INSUFFICIENT',
      color: 'gray',
      gbPct: null,
      fbPct: null,
      ldPct: null,
      regressed: false
    };
  }

  // Sample-size regression: blend observed with league prior
  const reg = (observed, leagueVal) => {
    if (observed == null || isNaN(observed)) return leagueVal;
    return (observed * bbe + leagueVal * PRIOR_BBE) / (bbe + PRIOR_BBE);
  };

  const gb = reg(parseFloat(stats.gb_percent || 0), LEAGUE.GB_PCT);
  const fb = reg(parseFloat(stats.fb_percent || 0), LEAGUE.FB_PCT);
  const ld = reg(parseFloat(stats.ld_percent || 0), LEAGUE.LD_PCT);
  const barrel = parseFloat(stats.barrel_batted_rate || 0);
  const kPct = parseFloat(stats.k_percent || 22);

  const regressed = bbe < 200;  // flag whether we leaned heavily on prior

  // Classification order matters: most specific first
  // (a hitter with both ELITE_POWER and ALL_OR_NOTHING traits → ELITE_POWER)

  // ELITE POWER: high FB% + high Barrel% (Judge, Ohtani, Schwarber)
  if (fb >= 45 && barrel >= 12) {
    return {
      archetype: 'ELITE_POWER',
      displayLabel: 'ELITE POWER',
      color: 'blue',
      gbPct: +gb.toFixed(1),
      fbPct: +fb.toFixed(1),
      ldPct: +ld.toFixed(1),
      regressed
    };
  }

  // ALL-OR-NOTHING: high FB% + high K% (Gallo, Zunino types)
  if (fb >= 45 && kPct >= 25) {
    return {
      archetype: 'ALL_OR_NOTHING',
      displayLabel: 'ALL-OR-NOTHING',
      color: 'red',
      gbPct: +gb.toFixed(1),
      fbPct: +fb.toFixed(1),
      ldPct: +ld.toFixed(1),
      regressed
    };
  }

  // LINE-DRIVE: high LD% + moderate FB% (Arraez, Kwan, Freeman, Jung)
  if (ld >= 24 && fb < 45) {
    return {
      archetype: 'LINE_DRIVE',
      displayLabel: 'LINE-DRIVE',
      color: 'green',
      gbPct: +gb.toFixed(1),
      fbPct: +fb.toFixed(1),
      ldPct: +ld.toFixed(1),
      regressed
    };
  }

  // GB CONTACT: high GB% + low K% (Bichette types, contact-first speedsters)
  if (gb >= 50 && kPct < 20) {
    return {
      archetype: 'GB_CONTACT',
      displayLabel: 'GB CONTACT',
      color: 'orange',
      gbPct: +gb.toFixed(1),
      fbPct: +fb.toFixed(1),
      ldPct: +ld.toFixed(1),
      regressed
    };
  }

  // BALANCED: no clear lean (most hitters)
  return {
    archetype: 'BALANCED',
    displayLabel: 'BALANCED',
    color: 'gray',
    gbPct: +gb.toFixed(1),
    fbPct: +fb.toFixed(1),
    ldPct: +ld.toFixed(1),
    regressed
  };
}

// =============================================================
// PITCHER ARCHETYPE CLASSIFICATION
// =============================================================

/**
 * Classify a pitcher by induced batted-ball profile, weighted by pitch usage.
 *
 * @param {Array} pitcherArsenal - array of {type, pitches, gb_percent, fb_percent, barrel_batted_rate, ...}
 * @returns {{ archetype: string, displayLabel: string, color: string,
 *             gbInduced: number, fbInduced: number, barrelAllowed: number }} or null
 */
export function classifyPitcher(pitcherArsenal) {
  if (!pitcherArsenal || !Array.isArray(pitcherArsenal) || pitcherArsenal.length === 0) {
    return null;
  }

  const totalPitches = pitcherArsenal.reduce((s, p) => s + (parseInt(p.pitches) || 0), 0);

  // Need a meaningful sample of pitches before classifying
  if (totalPitches < 100) {
    return {
      archetype: 'INSUFFICIENT',
      displayLabel: 'INSUFFICIENT',
      color: 'gray',
      gbInduced: null,
      fbInduced: null,
      barrelAllowed: null
    };
  }

  // Weighted aggregate across pitch types (by usage)
  const weighted = (field) => {
    const sum = pitcherArsenal.reduce((s, p) => {
      const val = parseFloat(p[field]);
      const pitches = parseInt(p.pitches) || 0;
      if (isNaN(val)) return s;
      return s + (val * pitches);
    }, 0);
    return sum / totalPitches;
  };

  const gbInduced = weighted('gb_percent') || 0;
  const fbInduced = weighted('fb_percent') || 0;
  const barrelAllowed = weighted('barrel_batted_rate') || 0;

  // Order: GB_ARTIST > FB_PRONE > BARREL_SUSCEPTIBLE > STANDARD
  // GB_ARTIST is most specific (high GB% always wins over secondary signals)

  if (gbInduced >= 50) {
    return {
      archetype: 'GB_ARTIST',
      displayLabel: 'GB ARTIST',
      color: 'green',
      gbInduced: +gbInduced.toFixed(1),
      fbInduced: +fbInduced.toFixed(1),
      barrelAllowed: +barrelAllowed.toFixed(1)
    };
  }

  if (fbInduced >= 40) {
    return {
      archetype: 'FB_PRONE',
      displayLabel: 'FB PRONE',
      color: 'orange',
      gbInduced: +gbInduced.toFixed(1),
      fbInduced: +fbInduced.toFixed(1),
      barrelAllowed: +barrelAllowed.toFixed(1)
    };
  }

  if (barrelAllowed >= 9) {
    return {
      archetype: 'BARREL_SUSCEPTIBLE',
      displayLabel: 'BARREL SUSCEPTIBLE',
      color: 'red',
      gbInduced: +gbInduced.toFixed(1),
      fbInduced: +fbInduced.toFixed(1),
      barrelAllowed: +barrelAllowed.toFixed(1)
    };
  }

  return {
    archetype: 'STANDARD',
    displayLabel: 'STANDARD',
    color: 'gray',
    gbInduced: +gbInduced.toFixed(1),
    fbInduced: +fbInduced.toFixed(1),
    barrelAllowed: +barrelAllowed.toFixed(1)
  };
}

// =============================================================
// TIER-SHIFT MATRIX
// From DAMAGE_QUALITY_DESIGN.md Section "The damage matchup matrix"
// =============================================================

const TIER_MATRIX = {
  ELITE_POWER:    { GB_ARTIST: -2, FB_PRONE: +2, BARREL_SUSCEPTIBLE: +1, STANDARD: 0 },
  LINE_DRIVE:     { GB_ARTIST: -1, FB_PRONE: +1, BARREL_SUSCEPTIBLE: +1, STANDARD: 0 },
  GB_CONTACT:     { GB_ARTIST: -2, FB_PRONE:  0, BARREL_SUSCEPTIBLE:  0, STANDARD: 0 },
  ALL_OR_NOTHING: { GB_ARTIST: -1, FB_PRONE: +2, BARREL_SUSCEPTIBLE: +1, STANDARD: 0 },
  BALANCED:       { GB_ARTIST: -1, FB_PRONE: +1, BARREL_SUSCEPTIBLE:  0, STANDARD: 0 }
};

/**
 * Get tier shift for a hitter-pitcher archetype matchup.
 * Returns 0 (no shift) if either side is INSUFFICIENT or unknown.
 *
 * @param {Object} hitterArchetype - result of classifyHitter()
 * @param {Object} pitcherArchetype - result of classifyPitcher()
 * @returns {number} tier shift: -2 (double demote) to +2 (double promote)
 */
export function getTierShift(hitterArchetype, pitcherArchetype) {
  if (!hitterArchetype || !pitcherArchetype) return 0;
  if (hitterArchetype.archetype === 'INSUFFICIENT') return 0;
  if (pitcherArchetype.archetype === 'INSUFFICIENT') return 0;
  return TIER_MATRIX[hitterArchetype.archetype]?.[pitcherArchetype.archetype] || 0;
}

/**
 * Apply a tier shift to a current tier label.
 * Tiers map to indices: solid=0, strong=1, elite=2.
 * Result is clamped to [solid, elite] — can't go below solid or above elite.
 *
 * @param {string} currentTier - 'solid', 'strong', or 'elite'
 * @param {number} shift - integer shift (-2, -1, 0, +1, +2)
 * @returns {string} new tier label
 */
export function applyTierShift(currentTier, shift) {
  const tiers = ['solid', 'strong', 'elite'];
  const idx = tiers.indexOf(currentTier);
  if (idx < 0) return currentTier;  // unknown tier, leave unchanged
  const newIdx = Math.max(0, Math.min(tiers.length - 1, idx + shift));
  return tiers[newIdx];
}

/**
 * Build a human-readable note describing the archetype matchup.
 * Used for the "Damage profile" line in hitter cards (per design doc Section
 * "In-app explanations").
 *
 * @param {Object} hitterArch - classifyHitter() result
 * @param {Object} pitcherArch - classifyPitcher() result
 * @param {number} shift - tier shift applied
 * @returns {string|null}
 */
export function buildDamageNote(hitterArch, pitcherArch, shift) {
  if (!hitterArch || !pitcherArch) return null;
  if (hitterArch.archetype === 'INSUFFICIENT' || pitcherArch.archetype === 'INSUFFICIENT') return null;

  const baseText = `${hitterArch.displayLabel} vs ${pitcherArch.displayLabel}`;

  if (shift === 0) {
    return `${baseText} — no archetype edge`;
  }

  // Tagline based on the tier matrix entry
  const taglines = {
    'ELITE_POWER:GB_ARTIST': 'HR fade — power neutralized by groundball arsenal',
    'ELITE_POWER:FB_PRONE': 'HR target — power meets flyball pitcher',
    'ELITE_POWER:BARREL_SUSCEPTIBLE': 'damage upside vs hittable arsenal',
    'LINE_DRIVE:GB_ARTIST': 'tougher matchup — drives turn into rollovers',
    'LINE_DRIVE:FB_PRONE': 'hits/HRR boost — line drives carry',
    'LINE_DRIVE:BARREL_SUSCEPTIBLE': 'hits/HRR boost — solid contact rewarded',
    'GB_CONTACT:GB_ARTIST': 'DOUBLE FADE — DPs and rollovers compound',
    'ALL_OR_NOTHING:GB_ARTIST': 'tougher — boom-or-bust against grounders',
    'ALL_OR_NOTHING:FB_PRONE': 'HR target — leverage prop',
    'ALL_OR_NOTHING:BARREL_SUSCEPTIBLE': 'damage trigger',
    'BALANCED:GB_ARTIST': 'modest fade',
    'BALANCED:FB_PRONE': 'modest boost'
  };

  const key = `${hitterArch.archetype}:${pitcherArch.archetype}`;
  const tagline = taglines[key];
  const shiftLabel = shift > 0 ? `+${shift}` : `${shift}`;

  return tagline
    ? `${baseText} — ${tagline} (${shiftLabel} tier)`
    : `${baseText} (${shiftLabel} tier)`;
}

// =============================================================
// HITTER PROP TYPE PREFERENCES BY ARCHETYPE
// (Used downstream by buildPropRecommendations to scope prop selection)
// =============================================================

/**
 * Per-archetype preferred prop types. Returned in priority order.
 * The prop recommendation logic should weight these higher when generating
 * "BEST" prop selection.
 *
 * Useful for: when multiple props on a hitter card all qualify by probability,
 * use this to break ties toward the prop type the archetype is built for.
 *
 * @param {string} archetype - hitter archetype key
 * @returns {Array<string>} ordered preferred prop keys
 */
export function getPreferredProps(archetype) {
  const map = {
    ELITE_POWER:    ['HR', 'TB', 'HRR'],         // power props first
    LINE_DRIVE:     ['HITS', 'HRR'],              // contact-driven
    GB_CONTACT:     ['HITS'],                     // hits only — fade HR/TB
    ALL_OR_NOTHING: ['HR', 'TB'],                 // power yes, hits no
    BALANCED:       ['HRR', 'HITS', 'HR']         // default ordering
  };
  return map[archetype] || ['HRR', 'HITS'];
}

/**
 * Should this prop type even be generated for this hitter archetype?
 * Used to filter out props that are systematically -EV for the archetype.
 *
 * @param {string} archetype - hitter archetype key
 * @param {string} propKey - 'HR', 'TB', 'HITS', 'HRR'
 * @returns {boolean}
 */
export function shouldOfferProp(archetype, propKey) {
  // GB CONTACT hitters don't generate HR or TB recs (rare for them to clear lines)
  if (archetype === 'GB_CONTACT' && (propKey === 'HR' || propKey === 'TB')) return false;
  // ALL-OR-NOTHING hitters don't generate HRR (no floor — boom or bust)
  if (archetype === 'ALL_OR_NOTHING' && propKey === 'HRR') return false;
  return true;
}

// =============================================================
// DEMON TRAP DETECTION
// (The unique-value feature from the design doc)
// =============================================================

/**
 * Detect when a hitter looks like a chalk pick on PP/UD but the damage matchup
 * says fade. Returns null if no trap, or a warning object if detected.
 *
 * @param {Object} ctx
 *   @param {Object} hitterArch - classifyHitter() result
 *   @param {Object} pitcherArch - classifyPitcher() result
 *   @param {string} propKey - 'HITS', 'HRR', 'TB', 'HR'
 *   @param {number} marketImpliedProb - market's implied probability (e.g. 0.85 for 85%)
 * @returns {{ severity: string, message: string }|null}
 */
export function detectDemonTrap({ hitterArch, pitcherArch, propKey, marketImpliedProb }) {
  if (!hitterArch || !pitcherArch || marketImpliedProb == null) return null;
  if (hitterArch.archetype === 'INSUFFICIENT' || pitcherArch.archetype === 'INSUFFICIENT') return null;

  // Only worry about traps when the market is highly confident
  if (marketImpliedProb < 0.75) return null;

  const shift = getTierShift(hitterArch, pitcherArch);

  // Big negative shift = matchup says fade despite market confidence
  if (shift <= -2) {
    return {
      severity: 'HIGH',
      message: `DEMON TRAP — ${propKey} line at ${(marketImpliedProb * 100).toFixed(0)}% implied, but ${hitterArch.displayLabel} vs ${pitcherArch.displayLabel} (${shift} tier). Strong fade signal.`
    };
  }

  if (shift <= -1) {
    return {
      severity: 'MODERATE',
      message: `Possible trap — ${propKey} at ${(marketImpliedProb * 100).toFixed(0)}% but matchup is ${shift} tier (${hitterArch.displayLabel} vs ${pitcherArch.displayLabel}).`
    };
  }

  return null;
}
