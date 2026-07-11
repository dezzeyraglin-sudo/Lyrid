// tennisMatchRead.js — assembles the judgment-filtered "match read" for a matchup.
//
// This is the answer to "does all the ATP-page info get incorporated?": the read pulls the
// PREDICTIVE fields (serve/return rates by surface, rank, H2H, recent form) into projections and
// drivers, and deliberately ignores decorative fields (prize money, career titles, weight,
// turned-pro) that add noise without signal — same judgment-strip philosophy as the other sports.

import { projectMatch } from './tennisProjector.js';
import { tennisClassify } from './tennisClassify.js';

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
const r2 = (x) => (x == null ? '—' : Number(x).toFixed(2));

function surfProf(pl, surface) {
  const s = pl?.surfaces || {};
  return { ...(s.ALL || {}), ...(s[surface] || {}), _n: (s[surface]?.n ?? s.ALL?.n ?? 0) };
}

// Build the driver bullets for a given prop, in plain language, from the actual rates used.
function aceDrivers(A, B, surface, proj) {
  return [
    `${A.name}: ${r2(A.p.acePerSvGm)} aces/service game on ${surface} (${A.p._n} matches)`,
    `${B.name} concedes ${r2(B.p.acesFacedPerRetGm)} aces/return game — ${B.p.acesFacedPerRetGm > 0.55 ? 'aceable' : 'hard to ace'}`,
    `adjusted ace rate ${r2(proj.acesA.adjRate)}/svc gm → proj ${proj.acesA.mean.toFixed(1)} aces`,
  ];
}

export function buildMatchRead({
  playerA, playerB, surface = 'Hard', bestOf = 3,
  rankA = null, rankB = null, h2h = null, recentFormA = null, recentFormB = null,
  recentRetirementA = false, recentRetirementB = false,
  lines = {}, sims = 4000,
} = {}) {
  const proj = projectMatch({ playerA, playerB, surface, bestOf, sims });
  const A = { name: playerA?.name || 'A', p: surfProf(playerA, surface) };
  const B = { name: playerB?.name || 'B', p: surfProf(playerB, surface) };
  const rankGap = (rankA != null && rankB != null) ? Math.abs(rankA - rankB) : null;

  // Helper to classify one over/under prop off the projection's empirical distribution.
  const doProp = (market, arrProj, line, forcedLean, surfaceN, retire) => {
    if (line == null) return null;
    const ou = arrProj(line);
    const lean = forcedLean || (ou.under >= ou.over ? 'UNDER' : 'OVER');
    const prob = Math.min(0.72, lean === 'UNDER' ? ou.under : ou.over); // CS2 display cap
    const verdict = tennisClassify({ market, lean, line, prob, mean: ou.mean,
      surfaceN, rankGap, recentRetirement: retire });
    return { market, lean, line, prob, mean: ou.mean, verdict };
  };

  const props = {
    acesA: doProp('aces', proj.acesA.prob, lines.acesA, null, A.p._n, recentRetirementA),
    acesB: doProp('aces', proj.acesB.prob, lines.acesB, null, B.p._n, recentRetirementB),
    dfA: doProp('doubleFaults', proj.dfA.prob, lines.dfA, null, A.p._n, recentRetirementA),
    totalGames: doProp('totalGames', proj.totalGames.prob, lines.totalGames, null,
      Math.min(A.p._n, B.p._n), recentRetirementA || recentRetirementB),
    fantasyA: doProp('fantasy', proj.fantasyA.prob, lines.fantasyA, null, A.p._n, recentRetirementA),
    fantasyB: doProp('fantasy', proj.fantasyB.prob, lines.fantasyB, null, B.p._n, recentRetirementB),
  };

  // Projected means — always present, so the fantasy score (and the rest) shows even with no line.
  const projected = {
    [A.name]: { aces: proj.acesA.mean, doubleFaults: proj.dfA.mean,
      gamesWon: proj.gamesWonA.mean, fantasy: proj.fantasyA.mean },
    [B.name]: { aces: proj.acesB.mean, doubleFaults: proj.dfB.mean,
      gamesWon: proj.gamesWonB.mean, fantasy: proj.fantasyB.mean },
    totalGames: proj.totalGames.mean,
    fantasyNote: 'PrizePicks scoring confirmed: match +10, game ±1, set ±3, ace +0.5, DF −0.5',
  };

  // Match-outcome context (used by fantasy + as a gate, not sold as a standalone bet by default).
  const favored = proj.winProbA >= 0.5 ? A.name : B.name;
  const winEdge = Math.abs(proj.winProbA - 0.5);

  const drivers = {
    aces: props.acesA ? aceDrivers(A, B, surface, proj) : [],
    totalGames: [
      `${A.name} hold ${pct(proj.holdA)} vs ${B.name} hold ${pct(proj.holdB)} on ${surface}`,
      rankGap != null ? `rank gap ${rankGap}${rankGap >= 60 ? ' → rout risk (UNDER context)' : ''}` : 'ranks unknown',
      h2h ? `H2H ${h2h}` : 'no H2H supplied',
      `projected total ${proj.totalGames.mean.toFixed(1)} games`,
    ],
  };

  // What the read INTENTIONALLY ignores (documented so it's a choice, not an omission).
  const ignored = ['prize money', 'career titles', 'weight', 'turned-pro year', 'doubles record'];

  return {
    matchup: `${A.name} vs ${B.name}`, surface, bestOf,
    winProb: { [A.name]: proj.winProbA, [B.name]: proj.winProbB, favored, edge: winEdge },
    holds: { [A.name]: proj.holdA, [B.name]: proj.holdB },
    props, drivers, projected,
    gates: {
      thinSampleA: A.p._n < 20, thinSampleB: B.p._n < 20,
      retirementA: recentRetirementA, retirementB: recentRetirementB,
      blowout: rankGap != null && rankGap >= 60,
    },
    usesFields: ['serve rates by surface', 'return rates by surface', 'aces-faced', 'rank', 'H2H', 'recent form/retirement'],
    ignoresFields: ignored,
    note: 'All props return bet:false — priors only until a real slate is graded.',
  };
}

export default { buildMatchRead };
