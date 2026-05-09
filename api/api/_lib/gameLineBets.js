// api/_lib/gameLineBets.js
// Recommends ML / Spread / Total bets based on projection vs market divergence.
// Calibrated to require real edge over break-even thresholds at -110 juice (52.4%)
// and plus-money underdog dynamics.

/**
 * Given a projection and market odds, produce game-line bet recommendations.
 *
 * @param {Object} projection  { projAwayRuns, projHomeRuns, projTotal, homeWinProb, awayWinProb }
 * @param {Object} odds        ESPN odds shape: { total, spread, favorite, favoriteML, homeTeam, awayTeam }
 * @param {Object} teams       { awayTeam, homeTeam }
 * @returns {Object} { total, spread, moneyline, overallBest }
 */
export function buildGameLineRecommendations({ projection, odds, teams }) {
  const result = {
    total: null,
    spread: null,
    moneyline: null,
    overallBest: null,
    hasMarket: !!(odds?.hasOdds)
  };

  if (!projection || !odds?.hasOdds) return result;

  const homeAbbr = teams?.homeTeam?.abbreviation;
  const awayAbbr = teams?.awayTeam?.abbreviation;

  // ==================== TOTAL ====================
  if (odds.total != null && projection.projTotal != null) {
    const marketTotal = Number(odds.total);
    const projTotal = Number(projection.projTotal);
    const delta = projTotal - marketTotal;
    const absDelta = Math.abs(delta);

    let tier = null;
    let side = null;
    if (absDelta >= 1.5) tier = 'STRONG';
    else if (absDelta >= 0.75) tier = 'MODERATE';
    else if (absDelta >= 0.40) tier = 'SLIGHT';
    else tier = 'PASS';

    if (tier !== 'PASS') side = delta > 0 ? 'OVER' : 'UNDER';

    result.total = {
      marketLine: marketTotal,
      projectedTotal: +projTotal.toFixed(2),
      delta: +delta.toFixed(2),
      tier,
      side,
      pick: side ? `${side} ${marketTotal}` : null,
      reasoning: buildTotalReasoning(tier, side, delta, marketTotal, projTotal, projection)
    };
  }

  // ==================== MONEYLINE ====================
  if (odds.favoriteML != null && odds.favorite && projection.homeWinProb != null) {
    // projection.homeWinProb is stored as a percentage string ("62.5"), divide by 100 for decimal
    const modelHomeWP = Number(projection.homeWinProb) / 100;
    const modelAwayWP = 1 - modelHomeWP;
    // Derive underdog ML from favorite ML (assume dime line: +((|fav| - 10) sign-flipped))
    // This is an approximation — actual dog price varies by book
    const favML = odds.favoriteML;
    const absFav = Math.abs(favML);
    const dogML = absFav >= 100 ? +(absFav - 20) : +120;

    const favImplied = americanToImpliedProb(favML);
    const dogImplied = americanToImpliedProb(dogML);
    const sumImplied = favImplied + dogImplied;
    const noVigFavWP = favImplied / sumImplied;
    const noVigDogWP = dogImplied / sumImplied;

    // Which team is favored?
    const favoriteIsHome = odds.favorite === homeAbbr;
    const noVigHomeWP = favoriteIsHome ? noVigFavWP : noVigDogWP;
    const noVigAwayWP = 1 - noVigHomeWP;
    const homePrice = favoriteIsHome ? favML : dogML;
    const awayPrice = favoriteIsHome ? dogML : favML;

    const homeEdge = modelHomeWP - noVigHomeWP;
    const awayEdge = modelAwayWP - noVigAwayWP;
    const maxEdge = Math.max(Math.abs(homeEdge), Math.abs(awayEdge));

    let tier = null;
    let side = null;
    if (maxEdge >= 0.05) tier = 'STRONG';
    else if (maxEdge >= 0.03) tier = 'MODERATE';
    else if (maxEdge >= 0.015) tier = 'SLIGHT';
    else tier = 'PASS';

    if (tier !== 'PASS') {
      side = homeEdge > awayEdge ? 'HOME' : 'AWAY';
    }

    const pickTeam = side === 'HOME' ? homeAbbr : side === 'AWAY' ? awayAbbr : null;
    const pickPrice = side === 'HOME' ? homePrice : side === 'AWAY' ? awayPrice : null;

    result.moneyline = {
      modelHomeWP: +modelHomeWP.toFixed(3),
      modelAwayWP: +modelAwayWP.toFixed(3),
      marketHomeWP: +noVigHomeWP.toFixed(3),
      marketAwayWP: +noVigAwayWP.toFixed(3),
      homeEdge: +homeEdge.toFixed(3),
      awayEdge: +awayEdge.toFixed(3),
      tier,
      side,
      pick: pickTeam ? `${pickTeam} ML` : null,
      price: pickPrice,
      pickTeam,
      reasoning: buildMoneylineReasoning(tier, side, side === 'HOME' ? homeEdge : awayEdge, pickTeam, pickPrice, modelHomeWP, noVigHomeWP, awayAbbr, homeAbbr)
    };
  }

  // ==================== SPREAD / RUN LINE ====================
  if (odds.spread != null && projection.projAwayRuns != null && projection.projHomeRuns != null) {
    // ESPN spread: negative means home is favored by that amount
    const spreadNum = Math.abs(Number(odds.spread));
    const favored = Number(odds.spread) < 0 ? 'home' : 'away';
    const runLine = 1.5;  // MLB always uses 1.5
    const runMargin = Number(projection.projHomeRuns) - Number(projection.projAwayRuns);

    let tier = 'PASS';
    let side = null;
    let coverDelta = 0;

    if (favored === 'home') {
      coverDelta = runMargin - (runLine + 0.5);  // projected cover margin
      if (coverDelta >= 1.5) { tier = 'STRONG'; side = `HOME_-${runLine}`; }
      else if (coverDelta >= 0.75) { tier = 'MODERATE'; side = `HOME_-${runLine}`; }
      else if (coverDelta >= 0.3) { tier = 'SLIGHT'; side = `HOME_-${runLine}`; }
      else if (coverDelta <= -1.5) { tier = 'STRONG'; side = `AWAY_+${runLine}`; }
      else if (coverDelta <= -0.75) { tier = 'MODERATE'; side = `AWAY_+${runLine}`; }
      else if (coverDelta <= -0.3) { tier = 'SLIGHT'; side = `AWAY_+${runLine}`; }
    } else {
      coverDelta = -runMargin - (runLine + 0.5);
      if (coverDelta >= 1.5) { tier = 'STRONG'; side = `AWAY_-${runLine}`; }
      else if (coverDelta >= 0.75) { tier = 'MODERATE'; side = `AWAY_-${runLine}`; }
      else if (coverDelta >= 0.3) { tier = 'SLIGHT'; side = `AWAY_-${runLine}`; }
      else if (coverDelta <= -1.5) { tier = 'STRONG'; side = `HOME_+${runLine}`; }
      else if (coverDelta <= -0.75) { tier = 'MODERATE'; side = `HOME_+${runLine}`; }
      else if (coverDelta <= -0.3) { tier = 'SLIGHT'; side = `HOME_+${runLine}`; }
    }

    let pickLabel = null;
    let pickTeam = null;
    if (side?.startsWith('HOME_')) {
      pickTeam = homeAbbr;
      pickLabel = `${pickTeam} ${side.split('_')[1]}`;
    } else if (side?.startsWith('AWAY_')) {
      pickTeam = awayAbbr;
      pickLabel = `${pickTeam} ${side.split('_')[1]}`;
    }

    result.spread = {
      marketLine: runLine,
      favored,
      projectedMargin: +runMargin.toFixed(2),
      coverDelta: +coverDelta.toFixed(2),
      tier,
      side,
      pick: pickLabel,
      pickTeam,
      reasoning: buildSpreadReasoning(tier, side, coverDelta, runLine, runMargin, favored, pickTeam)
    };
  }

  // ==================== OVERALL BEST ====================
  const candidates = [result.total, result.moneyline, result.spread].filter(x => x && x.tier && x.tier !== 'PASS');
  if (candidates.length > 0) {
    const tierRank = { STRONG: 3, MODERATE: 2, SLIGHT: 1 };
    const typePriority = { total: 3, moneyline: 2, spread: 1 };
    candidates.sort((a, b) => {
      const tA = (tierRank[a.tier] || 0) * 10 + (typePriority[betType(a, result)] || 0);
      const tB = (tierRank[b.tier] || 0) * 10 + (typePriority[betType(b, result)] || 0);
      return tB - tA;
    });
    const best = candidates[0];
    result.overallBest = {
      type: betType(best, result),
      tier: best.tier,
      pick: best.pick,
      price: best.price || null,
      units: unitsForTier(best.tier),
      reasoning: best.reasoning
    };
  }

  // Add unit sizes to each bet rec
  if (result.total) result.total.units = unitsForTier(result.total.tier);
  if (result.moneyline) result.moneyline.units = unitsForTier(result.moneyline.tier);
  if (result.spread) result.spread.units = unitsForTier(result.spread.tier);

  return result;
}

// Standard unit sizing — 1 unit = 1% of bankroll
// STRONG (5%+ ML edge / 1.5+ run total) → 2u
// MODERATE (3-5% / 0.75-1.5 runs) → 1u
// SLIGHT (1.5-3% / 0.4-0.75 runs) → 0.5u
function unitsForTier(tier) {
  if (tier === 'STRONG') return 2;
  if (tier === 'MODERATE') return 1;
  if (tier === 'SLIGHT') return 0.5;
  return 0;
}

function betType(rec, result) {
  if (rec === result.total) return 'total';
  if (rec === result.moneyline) return 'moneyline';
  if (rec === result.spread) return 'spread';
  return 'unknown';
}

function americanToImpliedProb(price) {
  if (price == null) return 0.5;
  if (price > 0) return 100 / (price + 100);
  return -price / (-price + 100);
}

function buildTotalReasoning(tier, side, delta, marketTotal, projTotal, projection) {
  if (tier === 'PASS') return [`Model ${projTotal.toFixed(1)} vs market ${marketTotal} — too close (${delta >= 0 ? '+' : ''}${delta.toFixed(2)}). No play.`];
  const reasons = [
    `Model projects ${projTotal.toFixed(1)} runs vs market total ${marketTotal} — ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} run edge toward ${side}`
  ];
  if (projection?.narrative?.projectionReasons) {
    // Pull the strongest 2-3 supporting bullets
    const supporting = projection.narrative.projectionReasons.slice(0, 3);
    supporting.forEach(r => reasons.push(r));
  }
  return reasons;
}

function buildMoneylineReasoning(tier, side, edge, pickTeam, pickPrice, modelHomeWP, noVigHomeWP, awayAbbr, homeAbbr) {
  if (tier === 'PASS') return [`Model and market agree on win probability — no ML edge`];
  const pct = (Math.abs(edge) * 100).toFixed(1);
  const modelWPForPick = side === 'HOME' ? modelHomeWP : 1 - modelHomeWP;
  const marketWPForPick = side === 'HOME' ? noVigHomeWP : 1 - noVigHomeWP;
  const reasons = [
    `Model gives ${pickTeam} ${(modelWPForPick * 100).toFixed(1)}% win prob vs market ${(marketWPForPick * 100).toFixed(1)}% — +${pct}% edge`
  ];
  if (pickPrice != null && pickPrice > 0) {
    reasons.push(`Plus-money payout (+${pickPrice}) — break-even at ${(100/(pickPrice+100)*100).toFixed(1)}%, model above that`);
  } else if (pickPrice != null) {
    reasons.push(`Priced at ${pickPrice}, break-even at ${(-pickPrice/(-pickPrice+100)*100).toFixed(1)}%`);
  }
  return reasons;
}

function buildSpreadReasoning(tier, side, margin, runLine, runMargin, favored, pickTeam) {
  if (tier === 'PASS') return [`Model projects ${Math.abs(runMargin).toFixed(1)}-run margin — run-line-cover threshold is too close`];
  const reasons = [];
  if (side?.includes('_-')) {
    reasons.push(`Model projects ${pickTeam} wins by ${Math.abs(runMargin).toFixed(1)} runs — comfortable cover of ${runLine}`);
  } else {
    reasons.push(`Model projects tight game (${Math.abs(runMargin).toFixed(1)}-run margin) — ${pickTeam} +${runLine} likely cashes`);
  }
  return reasons;
}
