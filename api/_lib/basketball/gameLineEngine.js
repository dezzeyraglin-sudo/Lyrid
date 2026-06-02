// api/_lib/basketball/gameLineEngine.js
//
// GAME LINE ENGINE (June 2, 2026)
//
// Projects team totals, game total, spread, moneyline, and win probability from
// team efficiency + pace, the way the MLB side projects runs. Mirrors that
// "OUR MODEL vs MARKET" presentation: the engine produces its own number, and
// the book line (from oddsLines.js, when present) sits beside it as the edge.
//
// MINOR DEFENSIVE FACTORS (the part the user specifically asked for) — each is
// REAL from bbref and nudges the opponent's projected total:
//   forced turnovers (opp_tov_per_g)  → empty possessions, suppress points
//   steals / ball pressure (stl_per_g)→ transition-prone, possession theft
//   blocks / rim deterrence (blk_per_g)→ lowers opponent rim efficiency
//   offensive boards allowed (opp_orb) → concedes second-chance points
// DEFENSIVE SCHEME (switch/drop/zone/blitz/help structure) — NOT published by
// bbref, so it is a NEUTRAL structural layer (factor 1.0) until a scheme feed or
// manual tags populate team.defScheme. Wired so it moves the number the moment
// data exists, exactly like coaching coverage in the points engine.
//
// CONTRACT: analyzeGameLine({ home, away, bookLine? }, league='WNBA') -> {
//   projectedTotal, homeTotal, awayTotal, spread (home perspective),
//   moneyline: { homeWinProb, awayWinProb, homeAmerican, awayAmerican },
//   winner, edges: { total, spread } (vs book when provided),
//   factors: { home: {...}, away: {...} }, dataCompleteness, _audit }
//
// home/away are team objects from wnbaTeamData (carry pace, offRating, defRating,
// stealsPerG, blocksPerG, forcedTovPerG, offRebAllowedPerG, ptsPerG, oppPtsPerG,
// optional defScheme).

import { getLeagueConfig } from './leagueConfig.js';

const clamp = (x, [lo, hi]) => Math.max(lo, Math.min(hi, x));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Logistic: convert a projected margin (home - away) to home win probability.
// WNBA points ~ one possession; scale tuned so ~ +3.5 margin ≈ 60% win.
function marginToWinProb(margin, scale) {
  return 1 / (1 + Math.exp(-margin / scale));
}

// Win prob → American odds (no vig added; this is a fair line).
function probToAmerican(p) {
  if (p <= 0 || p >= 1) return null;
  if (p >= 0.5) return Math.round(-100 * p / (1 - p));   // favorite
  return Math.round(100 * (1 - p) / p);                  // underdog
}

// ============================================================
// MINOR DEFENSIVE FACTOR STACK (each REAL, each clamped + reported)
// ============================================================
// Returns a multiplier on the OPPONENT's projected points (defense suppresses
// or concedes), plus a per-factor breakdown for transparency.

function defensiveFactors(defTeam, lgAvg, cfg) {
  const w = cfg.gameLine;
  const factors = {};
  let mult = 1;

  // Forced turnovers: more than league avg => suppress opponent points.
  const ftov = num(defTeam.forcedTovPerG);
  if (ftov != null && lgAvg.forcedTov) {
    const f = 1 - ((ftov - lgAvg.forcedTov) / lgAvg.forcedTov) * w.forcedTovSensitivity;
    factors.forcedTurnovers = round3(f);
    mult *= clamp(f, cfg.clamps.gameLineFactor);
  }
  // Steals / ball pressure: independent transition-theft signal.
  const stl = num(defTeam.stealsPerG);
  if (stl != null && lgAvg.steals) {
    const f = 1 - ((stl - lgAvg.steals) / lgAvg.steals) * w.stealSensitivity;
    factors.ballPressure = round3(f);
    mult *= clamp(f, cfg.clamps.gameLineFactor);
  }
  // Blocks / rim deterrence: lowers opponent interior efficiency.
  const blk = num(defTeam.blocksPerG);
  if (blk != null && lgAvg.blocks) {
    const f = 1 - ((blk - lgAvg.blocks) / lgAvg.blocks) * w.blockSensitivity;
    factors.rimDeterrence = round3(f);
    mult *= clamp(f, cfg.clamps.gameLineFactor);
  }
  // Offensive boards allowed: concedes second-chance points (raises opp total).
  const orbA = num(defTeam.offRebAllowedPerG);
  if (orbA != null && lgAvg.offRebAllowed) {
    const f = 1 + ((orbA - lgAvg.offRebAllowed) / lgAvg.offRebAllowed) * w.offRebAllowedSensitivity;
    factors.secondChance = round3(f);
    mult *= clamp(f, cfg.clamps.gameLineFactor);
  }

  // DEFENSIVE SCHEME — NEUTRAL until fed.
  let schemeActive = false;
  const scheme = defTeam.defScheme || null;
  if (scheme && num(scheme.multiplier) != null) {
    const f = 1 + (num(scheme.multiplier) - 1) * w.schemeSensitivity;
    factors.scheme = round3(clamp(f, cfg.clamps.gameLineFactor));
    mult *= factors.scheme;
    schemeActive = true;
  } else {
    factors.scheme = 1;
  }

  const realCount = ['forcedTurnovers', 'ballPressure', 'rimDeterrence', 'secondChance']
    .filter(k => factors[k] != null && factors[k] !== 1).length;

  return {
    mult: clamp(mult, cfg.clamps.gameLineCombined),
    factors, schemeActive,
    factorsReal: realCount,
  };
}

// ============================================================
// TEAM TOTAL
// ============================================================
// Base = blend of the team's own scoring (ptsPerG) and an efficiency estimate
// (offRating scaled to the game's projected pace), then apply the opponent's
// defensive strength (defRating vs league) and the minor-factor multiplier.

function projectTeamTotal(offTeam, defTeam, projectedPace, lgAvg, cfg) {
  const w = cfg.gameLine;
  const offRtg = num(offTeam.offRating) ?? lgAvg.defRating;   // points per 100 poss
  const defRtg = num(defTeam.defRating) ?? lgAvg.defRating;   // points allowed per 100 poss

  // Matchup efficiency: offense rating meets defense rating. Ratings already
  // encode each team's scoring strength per possession, so this single blend is
  // the whole offense-vs-defense story — do NOT also add raw PPG (that would
  // double-count team strength and explode the margin).
  const matchupRtg = (offRtg + defRtg) / 2;
  let base = (matchupRtg / 100) * projectedPace;

  // Light stabilizer: pull a few % toward the league mean total to damp
  // small-sample rating noise early in the season. Not a strength signal.
  const leagueMeanTotal = (lgAvg.defRating / 100) * projectedPace;
  base = w.ppgBlend * base + (1 - w.ppgBlend) * leagueMeanTotal;

  // Minor defensive factors (forced TO, steals, blocks, OREB allowed, scheme)
  // — the fine-grained nudges on top of the rating matchup.
  const def = defensiveFactors(defTeam, lgAvg, cfg);
  const total = base * def.mult;

  return {
    total: Number(total.toFixed(1)),
    base: Number(base.toFixed(1)),
    matchupRtg: round3(matchupRtg),
    defenseMult: round3(def.mult),
    factors: def.factors,
    schemeActive: def.schemeActive,
    factorsReal: def.factorsReal,
  };
}

// ============================================================
// MAIN
// ============================================================

export function analyzeGameLine(input, league = 'WNBA') {
  const cfg = getLeagueConfig(league);
  const lgAvg = cfg.gameLineLeagueAvg;
  const home = input.home || {};
  const away = input.away || {};

  // Projected pace = average of the two teams' paces (both REAL).
  const homePace = num(home.pace) ?? cfg.leagueAvgPace;
  const awayPace = num(away.pace) ?? cfg.leagueAvgPace;
  const projectedPace = (homePace + awayPace) / 2;

  // Each team's total: its offense vs the other's defense.
  const homeProj = projectTeamTotal(home, away, projectedPace, lgAvg, cfg);
  const awayProj = projectTeamTotal(away, home, projectedPace, lgAvg, cfg);

  // Home-court adjustment (REAL, league-typical).
  const hca = cfg.gameLine.homeCourtPoints;
  const homeTotal = Number((homeProj.total + hca / 2).toFixed(1));
  const awayTotal = Number((awayProj.total - hca / 2).toFixed(1));

  const projectedTotal = Number((homeTotal + awayTotal).toFixed(1));
  const margin = Number((homeTotal - awayTotal).toFixed(1));   // + = home favored
  const spread = Number((-margin).toFixed(1));                 // home-perspective spread

  const homeWinProb = Number(marginToWinProb(margin, cfg.gameLine.winProbScale).toFixed(3));
  const awayWinProb = Number((1 - homeWinProb).toFixed(3));

  // Book comparison (when oddsLines provided a real total/spread).
  const book = input.bookLine || null;
  const edges = { total: null, spread: null };
  if (book) {
    if (num(book.total) != null) edges.total = Number((projectedTotal - num(book.total)).toFixed(1));
    if (num(book.spread) != null) edges.spread = Number((spread - num(book.spread)).toFixed(1));
  }

  const schemeActive = homeProj.schemeActive || awayProj.schemeActive;
  const dataCompleteness = {
    pace: (num(home.pace) != null && num(away.pace) != null) ? 'REAL' : 'PARTIAL',
    efficiency: (num(home.offRating) != null && num(away.offRating) != null) ? 'REAL' : 'PARTIAL',
    minorDefensiveFactors: `${homeProj.factorsReal + awayProj.factorsReal} REAL (forced TO, steals, blocks, OREB allowed)`,
    defensiveScheme: schemeActive ? 'REAL' : 'NEUTRAL (no scheme feed)',
    bookLine: book ? 'PRESENT' : 'ABSENT (projection-only)',
  };

  // Confidence: high when efficiency + minor factors are real; trimmed when thin.
  let confidence = 100;
  if (dataCompleteness.efficiency !== 'REAL') confidence -= 25;
  if (dataCompleteness.pace !== 'REAL') confidence -= 10;
  if (homeProj.factorsReal + awayProj.factorsReal < 4) confidence -= 10;
  if (!schemeActive) confidence -= 4;
  confidence = Math.max(0, Math.min(100, confidence));

  // --- WHY this team has the edge: the real drivers behind the projection ---
  // Built from the same REAL inputs the projection uses, so the explanation is
  // honest. Compares the favored team's offense/defense/pace/minor-factors to
  // the opponent's. The card narrates this.
  const favorsHome = margin >= 0;
  const favTeam = favorsHome ? home : away;
  const dogTeam = favorsHome ? away : home;
  const favProj = favorsHome ? homeProj : awayProj;
  const dogProj = favorsHome ? awayProj : homeProj;
  const whyTeam = { favorite: favTeam.abbr || (favorsHome ? 'HOME' : 'AWAY'), drivers: [] };
  const offGap = (num(favTeam.offRating) ?? 100) - (num(dogTeam.offRating) ?? 100);
  const defGap = (num(dogTeam.defRating) ?? 100) - (num(favTeam.defRating) ?? 100); // + = favorite defends better
  const paceGap = (num(favTeam.pace) ?? 80) - (num(dogTeam.pace) ?? 80);
  if (offGap >= 2) whyTeam.drivers.push({ k: 'offense', mag: offGap, text: `scores more efficiently (${(num(favTeam.offRating)).toFixed(0)} vs ${(num(dogTeam.offRating)).toFixed(0)} off rating)` });
  if (defGap >= 2) whyTeam.drivers.push({ k: 'defense', mag: defGap, text: `defends better (${(num(favTeam.defRating)).toFixed(0)} vs ${(num(dogTeam.defRating)).toFixed(0)} def rating)` });
  // Minor factors: which real defensive edges suppress the opponent most.
  const favSupp = dogProj.defenseMult;   // favorite's defense acting on the dog
  if (favSupp != null && favSupp < 0.985) {
    const b = favProj.factors || {};
    const pieces = [];
    if (b.forcedTurnovers != null && b.forcedTurnovers < 0.99) pieces.push('forces turnovers');
    if (b.ballPressure != null && b.ballPressure < 0.99) pieces.push('pressures the ball');
    if (b.rimDeterrence != null && b.rimDeterrence < 0.99) pieces.push('protects the rim');
    if (b.secondChance != null && b.secondChance < 1.0) pieces.push('limits second-chance points');
    if (pieces.length) whyTeam.drivers.push({ k: 'minor', mag: (1 - favSupp) * 100, text: pieces.slice(0, 2).join(' and ') });
  }
  if (Math.abs(paceGap) >= 3) whyTeam.drivers.push({ k: 'pace', mag: Math.abs(paceGap), text: paceGap > 0 ? 'plays at a faster pace' : 'controls a slower pace' });
  whyTeam.drivers.sort((a, b) => b.mag - a.mag);

  return {
    matchup: `${away.abbr || away.name || 'AWAY'}@${home.abbr || home.name || 'HOME'}`,
    projectedTotal, homeTotal, awayTotal, spread, margin,
    winner: margin >= 0 ? (home.abbr || 'HOME') : (away.abbr || 'AWAY'),
    whyTeam,
    moneyline: {
      homeWinProb, awayWinProb,
      homeAmerican: probToAmerican(homeWinProb),
      awayAmerican: probToAmerican(awayWinProb),
    },
    book: book ? { total: num(book.total), spread: num(book.spread), source: book.bookUsed || book.source || 'book' } : null,
    edges,
    factors: {
      home: { total: homeProj.total, defenseSuppression: homeProj.defenseMult, breakdown: homeProj.factors },
      away: { total: awayProj.total, defenseSuppression: awayProj.defenseMult, breakdown: awayProj.factors },
    },
    projectedPace: Number(projectedPace.toFixed(1)),
    confidence, dataCompleteness,
    _audit: { league, hca, homeBase: homeProj.base, awayBase: awayProj.base },
  };
}

function round3(x) { return Number(Number(x).toFixed(3)); }

export const _testing = { defensiveFactors, projectTeamTotal, marginToWinProb, probToAmerican };
