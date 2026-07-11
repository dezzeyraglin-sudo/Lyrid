// tennisProjector.js — matchup → projections + EMPIRICAL over/under probabilities.
//
// Design: one Monte-Carlo match model drives everything (win prob, total games, aces, DFs,
// fantasy). Simulating from hold probabilities gives a real distribution to read tails off —
// no normal-CDF overconfidence (the CS2 lesson: parametric tails ran 9-17 pts hot).
//
// Factor combination obeys the additive-and-cap rule: adjustments are blended additively and
// clamped, never chained multiplicatively. All coefficients marked UNVALIDATED are priors to be
// replaced by walk-forward grades before any tier is trusted.

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Serve point-win prob → probability the server holds the game (deuce-aware closed form).
export function holdProb(p) {
  p = clamp(p, 0.01, 0.99); const q = 1 - p;
  const base = p ** 4 + 4 * p ** 4 * q + 10 * p ** 4 * q ** 2;
  const deuce = 20 * p ** 3 * q ** 3 * (p ** 2 / (p ** 2 + q ** 2));
  return clamp(base + deuce, 0, 1);
}

// Pick a surface profile, falling back to ALL, then to a neutral default.
function profile(player, surface) {
  const s = player?.surfaces || {};
  const NEUT = { acePerSvGm: 0.55, dfPerSvGm: 0.28, servePtsWonPct: 0.635,
    retPtsWonPct: 0.365, acesFacedPerRetGm: 0.55, winPct: 0.5, n: 0, svGms: 0, retGms: 0 };
  return { ...NEUT, ...(s.ALL || {}), ...(s[surface] || {}) };
}

// --- tiny RNG helpers (Math.random; swap in a seeded PRNG for reproducible backtests) ---
function poisson(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}
// Negative-binomial via Gamma-Poisson mixture → over-dispersed counts (aces/DFs cluster).
function negBinom(mean, dispersion) {
  if (mean <= 0) return 0;
  const shape = dispersion, scale = mean / dispersion;
  // Marsaglia-Tsang gamma
  let g;
  if (shape < 1) { g = gammaMT(shape + 1, scale) * Math.pow(Math.random(), 1 / shape); }
  else g = gammaMT(shape, scale);
  return poisson(g);
}
function gammaMT(shape, scale) {
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = gaussian(); v = 1 + c * x; } while (v <= 0);
    v = v ** 3; const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v * scale;
    if (Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}
function gaussian() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// Simulate one set game-by-game from hold probs; returns {gamesA, gamesB, svGmsA, svGmsB, winA}.
function simSet(holdA, holdB, serveA) {
  let a = 0, b = 0, svA = 0, svB = 0, aServes = serveA;
  for (;;) {
    if (aServes) { svA++; (Math.random() < holdA ? a++ : b++); }
    else { svB++; (Math.random() < holdB ? b++ : a++); }
    aServes = !aServes;
    if ((a >= 6 || b >= 6) && Math.abs(a - b) >= 2) break;
    if (a === 7 || b === 7) break; // 7-6 tiebreak set
  }
  return { gamesA: a, gamesB: b, svGmsA: svA, svGmsB: svB, winA: a > b };
}

// Simulate a full match; returns per-match totals for tails.
function simMatch(holdA, holdB, bestOf, aRates, bRates) {
  const setsToWin = bestOf === 5 ? 3 : 2;
  let setsA = 0, setsB = 0, gA = 0, gB = 0, svA = 0, svB = 0, serveA = Math.random() < 0.5;
  while (setsA < setsToWin && setsB < setsToWin) {
    const s = simSet(holdA, holdB, serveA);
    gA += s.gamesA; gB += s.gamesB; svA += s.svGmsA; svB += s.svGmsB;
    if (s.winA) setsA++; else setsB++;
    serveA = !serveA; // rough alternation of who serves first next set
  }
  // aces/DFs per player: over-dispersed draw off this match's actual service games
  const acesA = negBinom(aRates.aceAdj * svA, 6);
  const dfA = negBinom(aRates.df * svA, 8);
  const acesB = negBinom(bRates.aceAdj * svB, 6);
  const dfB = negBinom(bRates.df * svB, 8);
  return { winA: setsA > setsB, gamesA: gA, gamesB: gB, total: gA + gB,
    svGmsA: svA, svGmsB: svB, acesA, dfA, acesB, dfB };
}

const TOUR_ACES_FACED = 0.55; // neutral aces-faced-per-return-game baseline (UNVALIDATED)

// UNVALIDATED placeholder PrizePicks fantasy weights. UE is not in Sackmann → its effect is
// absorbed into `intercept`. CALIBRATE this whole vector against real graded PP scores.
export const FANTASY_WEIGHTS = {
  win: 6, ace: 0.6, df: -1.0, gameWon: 1.0, breakWon: 0.0,
  svcPtWon: 0.05, retPtWon: 0.10, intercept: 0, _unvalidated: true,
};

export function projectMatch({ playerA, playerB, surface = 'Hard', bestOf = 3, sims = 4000 } = {}) {
  const A = profile(playerA, surface), B = profile(playerB, surface);

  // Point-win probs: additive blend of server's serve-pts-won and (1 - returner's ret-pts-won).
  // Two factors, averaged and clamped — no multiplicative chaining.
  const pA = clamp(0.5 * A.servePtsWonPct + 0.5 * (1 - B.retPtsWonPct), 0.5, 0.86);
  const pB = clamp(0.5 * B.servePtsWonPct + 0.5 * (1 - A.retPtsWonPct), 0.5, 0.86);
  const holdA = holdProb(pA), holdB = holdProb(pB);

  // Ace rate adjusted for opponent's aces-faced tendency: additive deviation from baseline, capped.
  const aceAdjA = clamp(A.acePerSvGm + 0.4 * ((B.acesFacedPerRetGm ?? TOUR_ACES_FACED) - TOUR_ACES_FACED), 0.02, 2.2);
  const aceAdjB = clamp(B.acePerSvGm + 0.4 * ((A.acesFacedPerRetGm ?? TOUR_ACES_FACED) - TOUR_ACES_FACED), 0.02, 2.2);
  const aRates = { aceAdj: aceAdjA, df: A.dfPerSvGm };
  const bRates = { aceAdj: aceAdjB, df: B.dfPerSvGm };

  // Monte Carlo
  const tot = [], acA = [], acB = [], dfA = [], dfB = [], gwA = [], gwB = [];
  let winA = 0;
  for (let i = 0; i < sims; i++) {
    const m = simMatch(holdA, holdB, bestOf, aRates, bRates);
    if (m.winA) winA++;
    tot.push(m.total); acA.push(m.acesA); acB.push(m.acesB);
    dfA.push(m.dfA); dfB.push(m.dfB); gwA.push(m.gamesA); gwB.push(m.gamesB);
  }
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const overP = (x, line) => x.filter((v) => v > line).length / x.length;
  const underP = (x, line) => x.filter((v) => v < line).length / x.length;

  const fantasy = (winShare, aces, df, games, svpts, retpts) => {
    const w = FANTASY_WEIGHTS;
    return w.intercept + w.win * winShare + w.ace * aces + w.df * df +
      w.gameWon * games + w.svcPtWon * svpts + w.retPtWon * retpts;
  };
  const meanGamesA = mean(gwA), meanGamesB = mean(gwB);
  const winShareA = winA / sims;
  const fantA = fantasy(winShareA, mean(acA), mean(dfA), meanGamesA,
    A.servePtsWonPct * meanGamesA * 6, A.retPtsWonPct * meanGamesB * 6);
  const fantB = fantasy(1 - winShareA, mean(acB), mean(dfB), meanGamesB,
    B.servePtsWonPct * meanGamesB * 6, B.retPtsWonPct * meanGamesA * 6);

  const overUnder = (arr) => (line) => ({ line, over: overP(arr, line), under: underP(arr, line),
    mean: mean(arr), samples: arr });

  return {
    surface, bestOf, sims,
    winProbA: winShareA, winProbB: 1 - winShareA,
    holdA, holdB, pA, pB,
    totalGames: { mean: mean(tot), prob: overUnder(tot) },
    acesA: { mean: mean(acA), adjRate: aceAdjA, prob: overUnder(acA) },
    acesB: { mean: mean(acB), adjRate: aceAdjB, prob: overUnder(acB) },
    dfA: { mean: mean(dfA), prob: overUnder(dfA) },
    dfB: { mean: mean(dfB), prob: overUnder(dfB) },
    gamesWonA: { mean: meanGamesA, prob: overUnder(gwA) },
    gamesWonB: { mean: meanGamesB, prob: overUnder(gwB) },
    fantasyA: fantA, fantasyB: fantB,
    sampleWarning: (A.n < 20 || B.n < 20) ? 'thin surface sample' : null,
    _fantasyUnvalidated: true,
  };
}

export default { projectMatch, holdProb, FANTASY_WEIGHTS };
