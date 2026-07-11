// tennisClassify.js — mirrors wnbaClassify's contract: { tier, bet, wr, n, lo, reason, ... }.
//
// CRITICAL DISCIPLINE (same as WNBA/CS2): no tier badge without real graded n and a Wilson
// lower bound above 52.4%. There is ZERO graded tennis history yet, so EVERY prop returns
// bet:false. The scaffold below assigns a PRIOR-LEAN label from model probability so you can
// see what *would* tier, but wr/n stay null and bet stays false until you grade a real slate.
// When you have graded cohorts, replace the PRIOR blocks the way wnbaClassify encodes 16-0 etc.

export function _tennisWilsonLo(w, n, z = 1.96) {
  if (!n) return 0;
  const p = w / n, d = 1 + z * z / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
}

// Gate thresholds (UNVALIDATED priors).
const MIN_SURFACE_N = 20;   // matches on surface below which serve rates are untrustworthy
const BLOWOUT_RANK_GAP = 60; // rank gap that flags a likely rout → total-games UNDER context

// Map model probability → a prior-lean label. NOT a graded tier. Betting stays OFF.
function priorLean(prob) {
  if (prob == null) return 'UNGRADED';
  if (prob >= 0.68) return 'PRIOR-GUARANTEED?';
  if (prob >= 0.62) return 'PRIOR-PLATINUM?';
  if (prob >= 0.57) return 'PRIOR-GOLD?';
  return 'PRIOR-LEAN?';
}

/**
 * @param {object} p
 * @param {'aces'|'doubleFaults'|'totalGames'|'gamesWon'|'fantasy'} p.market
 * @param {'OVER'|'UNDER'} p.lean
 * @param {number} p.line
 * @param {number} p.prob     model P(lean hits), already capped
 * @param {number} p.mean     projected mean
 * @param {number} [p.surfaceN]  player's matches on this surface
 * @param {number} [p.rankGap]   |rankA - rankB|
 * @param {boolean} [p.recentRetirement]  player retired in a recent match
 * @param {boolean} [p.fantasyUnvalidated] fantasy composite not yet calibrated
 */
export function tennisClassify(p = {}) {
  const market = String(p.market || '');
  const dir = String(p.lean || '').toUpperCase();
  const prob = Number(p.prob);
  const mean = Number(p.mean);
  const line = Number(p.line);
  const surfaceN = p.surfaceN ?? null;
  const gap = p.rankGap ?? null;

  const V = (tier, extra = {}) => ({ tier, bet: false, wr: null, n: 0, lo: 0,
    prob: Number.isFinite(prob) ? prob : null, mean: Number.isFinite(mean) ? mean : null,
    line: Number.isFinite(line) ? line : null, ...extra });

  // --- HARD GATES (these DO fire even pre-grading; they only ever REMOVE plays) ---
  if (p.recentRetirement && (market === 'totalGames' || market === 'fantasy' || market === 'gamesWon'))
    return V('BANNED', { reason: 'Player retired in a recent match — total-games / fantasy props carry live walkover risk. Off the board until healthy.' });

  if (market === 'fantasy' && p.recentRetirement)
    return V('BANNED', { reason: 'Player retired in a recent match — fantasy carries live walkover risk. Off the board until healthy.' });

  if (surfaceN != null && surfaceN < MIN_SURFACE_N)
    return V('UNGRADED', { reason: `Only ${surfaceN} matches on this surface (< ${MIN_SURFACE_N}). Serve rates too thin — track, don't bet.`, sampleGate: true });

  if (!Number.isFinite(prob))
    return V('UNGRADED', { reason: 'No model probability produced. Track and grade before betting.' });

  // --- CONTEXT FLAGS (annotate, don't authorize) ---
  const blowout = gap != null && gap >= BLOWOUT_RANK_GAP;
  const blowoutNote = blowout
    ? (dir === 'UNDER' && (market === 'totalGames')
        ? ' Rank gap suggests a likely rout — supports the total-games UNDER context, but the cohort is still ungraded.'
        : ' Large rank gap present (rout risk) — factor into sizing once graded.')
    : '';

  // --- PRIOR-LEAN scaffold (bet stays FALSE) ---
  const lean = priorLean(prob);
  const marketLabel = { aces: 'Aces', doubleFaults: 'Double Faults', totalGames: 'Total Games',
    gamesWon: 'Games Won', fantasy: 'Fantasy' }[market] || market;

  return V(lean, {
    reason: `${marketLabel} ${dir} ${Number.isFinite(line) ? line : ''} — model ${(prob * 100).toFixed(0)}% `
      + `(proj ${Number.isFinite(mean) ? mean.toFixed(1) : '—'}).${blowoutNote} `
      + `PRIOR ONLY: no graded tennis cohort yet, so this is not a bet. Log it, grade it, then promote.`,
    blowout,
  });
}

export default { tennisClassify, _tennisWilsonLo };
