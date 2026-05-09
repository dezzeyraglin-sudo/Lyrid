// api/_data/umpireFactors.js
// K/BB/Runs boost factors for active MLB home plate umpires.
// Factor > 1.00 = that stat is inflated when this ump is behind the plate
// Factor < 1.00 = that stat is suppressed
//
// ====== ABS CHALLENGE SYSTEM ADJUSTMENT (2026) ======
// MLB implemented ABS challenges starting 2026 season. Each team has 2 challenges
// per game (batter/pitcher/catcher can call). Overturn rate league-wide is ~54%,
// effectively correcting the most extreme ball/strike calls.
//
// EFFECT ON THIS DATA:
//   - Historical tendencies still predictive at the margin but EXTREMES ARE COMPRESSED
//   - Umpires with high overturn rates get their effective factors dampened further
//   - League-wide walk rate is up ~8-10% in 2026 due to batters challenging borderline strikes
//
// We apply a universal dampening coefficient (0.65) to raw K/BB deltas, plus extra
// dampening for high-overturn-rate umps. Runs factor less affected since missed calls
// tend to average out across a full game.

export const ABS_COEFFICIENT = 0.65;           // Universal dampener for K/BB deltas
export const ABS_LEAGUE_WALK_INFLATION = 1.08; // League-wide walk rate up ~8%

// Umpires with high overturn rates (>55%) through early 2026. Their zones get
// corrected most often, so historical factors should be dampened further.
// Source: Baseball Savant ABS leaderboard + The Athletic tracker. Update as season progresses.
export const HIGH_OVERTURN_UMPS = new Set([
  "C.B. Bucknor",
  "Chad Whitson",
  "Adrian Johnson",
  "Alfonso Marquez",
  "Ángel Hernández",
  "Laz Diaz",
  "Doug Eddings",
  "Ron Kulpa"
]);

export const UMPIRE_FACTORS = {
  // Hitter-friendly / small zone umps (BB+, K-)
  "Ángel Hernández":     { k: 0.94, bb: 1.12, runs: 1.04, notes: "Inconsistent zone, batter-friendly" },
  "Laz Diaz":            { k: 0.92, bb: 1.15, runs: 1.06, notes: "Small zone, hitter-friendly" },
  "Pat Hoberg":          { k: 1.08, bb: 0.88, runs: 0.96, notes: "Elite accuracy, pitcher-friendly zone" },
  "John Tumpane":        { k: 1.04, bb: 0.96, runs: 0.98, notes: "Consistent, slight pitcher lean" },
  "Adam Hamari":         { k: 1.06, bb: 0.94, runs: 0.97, notes: "Wide zone, K-friendly" },
  "Ramon De Jesus":      { k: 1.05, bb: 0.95, runs: 0.98, notes: "Pitcher lean" },
  "Nick Mahrley":        { k: 1.03, bb: 0.97, runs: 0.99, notes: "Slight K boost" },
  "Todd Tichenor":       { k: 1.04, bb: 0.95, runs: 0.98, notes: "Wider zone" },
  "Dan Iassogna":        { k: 1.06, bb: 0.92, runs: 0.96, notes: "Very pitcher-friendly" },
  "Bill Miller":         { k: 1.05, bb: 0.94, runs: 0.97, notes: "K-friendly" },

  // Small/tight zone (hitters eat, K props UNDER lean)
  "Ron Kulpa":           { k: 0.95, bb: 1.08, runs: 1.03, notes: "Tight zone, more walks" },
  "Alfonso Marquez":     { k: 0.93, bb: 1.10, runs: 1.04, notes: "Tight, hitter-friendly" },
  "Doug Eddings":        { k: 0.96, bb: 1.06, runs: 1.02, notes: "Tight zone" },
  "Jerry Meals":         { k: 0.95, bb: 1.07, runs: 1.03, notes: "Hitter-friendly" },
  "Jansen Visconti":     { k: 0.94, bb: 1.08, runs: 1.04, notes: "Tight zone, K prop UNDER lean" },
  "Mark Wegner":         { k: 0.96, bb: 1.05, runs: 1.02, notes: "Slightly tight" },

  // Extreme K boost (K prop OVER lean)
  "Hunter Wendelstedt":  { k: 1.10, bb: 0.88, runs: 0.95, notes: "Wide zone, heavy K boost" },
  "Chris Segal":         { k: 1.08, bb: 0.90, runs: 0.96, notes: "K prop OVER target" },
  "Paul Emmel":          { k: 1.07, bb: 0.92, runs: 0.97, notes: "K-friendly wide zone" },
  "Dan Bellino":         { k: 1.06, bb: 0.93, runs: 0.97, notes: "Pitcher lean" },
  "Jeremie Rehak":       { k: 1.05, bb: 0.94, runs: 0.98, notes: "Slight K boost" },
  "Cory Blaser":         { k: 1.04, bb: 0.96, runs: 0.98, notes: "Mild pitcher lean" },

  // Extreme run-friendly (offense stacks)
  "Edwin Moscoso":       { k: 0.94, bb: 1.09, runs: 1.05, notes: "Offense-friendly" },
  "Malachi Moore":       { k: 0.95, bb: 1.07, runs: 1.03, notes: "Slight offense lean" },
  "Junior Valentine":    { k: 0.96, bb: 1.06, runs: 1.02, notes: "Small zone" },
  "Carlos Torres":       { k: 0.97, bb: 1.05, runs: 1.02, notes: "Hitter-friendly" },

  // Notable veterans
  "Joe West":            { k: 1.02, bb: 1.00, runs: 1.00, notes: "Near-neutral" },
  "Ted Barrett":         { k: 1.03, bb: 0.98, runs: 0.99, notes: "Slight K lean" },
  "Larry Vanover":       { k: 1.04, bb: 0.96, runs: 0.98, notes: "K-friendly" },
  "Marvin Hudson":       { k: 1.03, bb: 0.97, runs: 0.99, notes: "Slight pitcher lean" },

  // 2026 high-overturn umps (supplemental)
  "C.B. Bucknor":        { k: 0.92, bb: 1.12, runs: 1.04, notes: "High overturn rate — zone variable" },
  "Chad Whitson":        { k: 1.03, bb: 1.02, runs: 1.01, notes: "High overturn rate early 2026" },
  "Adrian Johnson":      { k: 1.04, bb: 0.97, runs: 0.99, notes: "Mild K lean, high ABS overturn rate" }
};

/**
 * Get ABS-adjusted umpire factors. Dampens historical tendencies for ABS era.
 * If ump is not in our list, returns league-average baseline with walk inflation.
 *
 * @param {string} umpName
 * @returns {Object} { k, bb, runs, notes, absAdjusted, highOverturn, rawK, rawBb, rawRuns }
 */
export function getAbsAdjustedFactors(umpName) {
  const raw = UMPIRE_FACTORS[umpName];
  if (!raw) {
    return {
      k: 1.00,
      bb: ABS_LEAGUE_WALK_INFLATION,
      runs: 1.01,
      notes: "No historical data · ABS 2026 baseline",
      absAdjusted: true,
      highOverturn: false
    };
  }

  const highOverturn = HIGH_OVERTURN_UMPS.has(umpName);
  const coef = highOverturn ? 0.45 : ABS_COEFFICIENT;

  const k = 1.0 + (raw.k - 1.0) * coef;
  const bbDampened = 1.0 + (raw.bb - 1.0) * coef;
  const bb = bbDampened * ABS_LEAGUE_WALK_INFLATION;
  const runs = 1.0 + (raw.runs - 1.0) * Math.min(0.80, coef + 0.15);

  return {
    k: +k.toFixed(3),
    bb: +bb.toFixed(3),
    runs: +runs.toFixed(3),
    notes: raw.notes + (highOverturn ? ' · ABS high-overturn' : ' · ABS-adjusted'),
    absAdjusted: true,
    highOverturn,
    rawK: raw.k,
    rawBb: raw.bb,
    rawRuns: raw.runs
  };
}

// Classify ump lean — uses ABS-adjusted factors so classification matches 2026 reality
export function classifyUmp(factors) {
  if (!factors) return { lean: 'neutral', strength: 'weak' };

  const k = factors.k || 1.0;
  const bb = factors.bb || 1.0;
  const kDelta = Math.abs(k - 1.0);
  const bbDelta = Math.abs(bb - 1.0);

  // Note: walk factor now includes ABS league inflation of 1.08, so threshold shifted
  let lean = 'neutral';
  let strength = 'weak';

  if (k >= 1.04 && bb <= 1.04) {
    lean = 'pitcher-friendly';
    strength = k >= 1.06 ? 'strong' : 'moderate';
  } else if (k <= 0.96 && bb >= 1.12) {
    lean = 'hitter-friendly';
    strength = k <= 0.94 ? 'strong' : 'moderate';
  } else if (kDelta >= 0.02 || bbDelta >= 0.05) {
    lean = k > 1.0 ? 'pitcher-leaning' : 'hitter-leaning';
    strength = 'mild';
  }

  return { lean, strength };
}
