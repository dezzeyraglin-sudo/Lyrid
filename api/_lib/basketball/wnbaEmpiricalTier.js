/**
 * wnbaEmpiricalTier.js
 *
 * Empirical, direction-aware tier for WNBA props — grounded in REAL graded
 * outcomes, not the engine's internal scores.
 *
 * WHY THIS EXISTS
 * The old tier came from finalEdgeScore, which rewarded projection-vs-line gap
 * and OVER direction. Both were inflated by the broken points projection, so the
 * labels inverted: across 134 graded real-line picks (Jun 1–8, 2026) the "strong"
 * tier hit 47% (it was 42 points-OVERs) while the "weak" tier hit 71% (it was the
 * rebounds/assists UNDERs). This module throws that out and tiers purely on the
 * thing that actually predicts: MARKET × DIRECTION, with a Wilson 95% lower bound
 * so small samples can't masquerade as locks.
 *
 * VALIDATED COHORTS (real book lines only, n = 134):
 *   assists  UNDER   21-3   87.5%  (n=24)  Wilson lo ~69%   → PLATINUM
 *   rebounds UNDER   25-13  65.8%  (n=38)  Wilson lo ~50%   → GOLD
 *   any      OVER    ~31-35 ~47%   (n~66)                   → PASS (no edge)
 *   points   any     24-30  44.4%  (n=54)  proj +2.9 biased → AVOID (under review)
 *
 * Pace/environment is the only sub-driver with real lift (+19pp: 69% when it
 * flags strong vs 50% weak). It can't create an edge on a PASS/AVOID cohort, but
 * it's surfaced as a flag and can firm up a borderline GOLD.
 *
 * As more picks grade, update the COHORTS counts — the tiers recompute from them.
 */

// Wilson score interval lower bound (95% by default). Honest small-sample flooring.
function wilsonLower(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return centre - half;
}

// Validated win/loss by market × direction (real book lines, Jun 1–8 2026 backtest).
// Keyed `${market}|${OVER|UNDER}`. Update counts as new picks grade.
const COHORTS = {
  'assists|UNDER':  { wins: 21, n: 24, base: 'PLATINUM' },
  'rebounds|UNDER': { wins: 25, n: 38, base: 'GOLD' },
  'assists|OVER':   { wins: 5,  n: 11, base: 'PASS' },
  'rebounds|OVER':  { wins: 4,  n: 7,  base: 'PASS' },
  'points|UNDER':   { wins: 2,  n: 6,  base: 'AVOID' },
  'points|OVER':    { wins: 22, n: 48, base: 'AVOID' },
};

// PrizePicks / DraftKings standard-line break-even ballpark. A cohort whose
// Wilson floor sits under this isn't a confident bet even if its point estimate
// looks good.
const BREAKEVEN = 0.54;

const TIER_RANK = { PLATINUM: 4, GOLD: 3, LEAN: 2, PASS: 1, AVOID: 0, UNGRADED: 1 };

/**
 * Classify a live WNBA prop into an empirical tier.
 *
 * @param {Object} p
 *   market    - 'points' | 'rebounds' | 'assists' | ...
 *   lean      - 'OVER' | 'UNDER' (derive from projection vs line if absent)
 *   projection, line - used to derive lean if lean not passed
 *   paceScore - environment sub-score 0–100 (optional; >=55 = favorable pace)
 * @returns {Object} { tier, recommend, wr, n, wilsonLo, paceFavorable, label, note }
 */
export function classifyWnbaEmpiricalTier(p = {}) {
  const market = String(p.market || '').toLowerCase();
  let lean = p.lean ? String(p.lean).toUpperCase() : null;
  if (!lean && p.projection != null && p.line != null) {
    lean = Number(p.projection) >= Number(p.line) ? 'OVER' : 'UNDER';
  }
  const paceFavorable = typeof p.paceScore === 'number' && p.paceScore >= 55;

  const key = `${market}|${lean}`;
  const c = COHORTS[key];

  if (!c) {
    return {
      tier: 'UNGRADED', recommend: false, wr: null, n: 0, wilsonLo: null,
      paceFavorable,
      label: `${market || 'prop'} ${lean || ''} — no validated sample`.trim(),
      note: 'No graded backtest cohort yet — not a tool-backed bet. Use your own read.',
    };
  }

  const wr = c.wins / c.n;
  const lo = wilsonLower(c.wins, c.n);
  let tier = c.base;

  // Pace lift can firm a strong GOLD toward PLATINUM (rebounds-under with a high
  // floor + favorable pace). It can't rescue a break-even-floor cohort.
  if (tier === 'GOLD' && paceFavorable && lo >= 0.60) tier = 'PLATINUM';
  // Guard the top badge: PLATINUM needs real volume AND a floor clearly above
  // break-even, so a lucky small sample can't wear it.
  if (tier === 'PLATINUM' && (c.n < 15 || lo < 0.62)) tier = 'GOLD';

  // Bettable = a positive cohort with adequate volume. The Wilson floor is shown
  // as honest risk context (and sizing guidance), not used to veto a real edge.
  const recommend = (tier === 'PLATINUM' || tier === 'GOLD');

  const pct = (x) => `${Math.round(x * 100)}%`;
  let label, note;
  if (tier === 'AVOID') {
    label = `${market.toUpperCase()} — AVOID (${pct(wr)}, n=${c.n})`;
    note = market === 'points'
      ? 'Points ran +2.9 over-projected pre-fix and graded 44%. Off the board until the new projection re-validates on fresh grades.'
      : `Negative cohort (${c.wins}-${c.n - c.wins}). Skip.`;
  } else if (tier === 'PASS') {
    label = `${market} ${lean} — no edge (${pct(wr)}, n=${c.n})`;
    note = 'OVER direction shows no validated edge in the backtest. Skip.';
  } else {
    label = `${market.toUpperCase()} ${lean} · ${pct(wr)} hit (${c.wins}-${c.n - c.wins}, n=${c.n}) · floor ${pct(lo)}${paceFavorable ? ' · pace+' : ''}`;
    note = recommend
      ? `Tool-backed bet. ${tier === 'PLATINUM' ? 'Strongest cohort.' : 'Solid cohort.'} 95% floor ${pct(lo)} vs ~${pct(BREAKEVEN)} break-even.`
      : `Edge present but floor (${pct(lo)}) is near break-even — size down.`;
  }

  return { tier, recommend, wr, n: c.n, wilsonLo: lo, paceFavorable, label, note };
}

export { wilsonLower, COHORTS, BREAKEVEN, TIER_RANK };
