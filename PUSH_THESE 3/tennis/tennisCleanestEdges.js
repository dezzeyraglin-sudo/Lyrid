// ===== TENNIS CLEANEST EDGES =====
// Slate-wide "best plays" board, mirroring MLB's gatherCleanestEdges. Sweeps every analyzed match,
// ranks each match's best prop into VALIDATION BANDS, and renders the ranked board. The single
// principle, same as MLB: VALIDATED beats MODELED. A play with a real graded hit rate always
// outranks a model-only edge. Tennis has no graded cohorts yet (like NFL at launch), so every play
// currently lands in the MODEL band with a "provisional" chip — until tennisPriorsLog grades a bucket
// past its Wilson floor, at which point that cohort graduates into a VERIFIED band above MODEL.

(function () {
  'use strict';

  // Validation bands — rank scores mirror MLB's hierarchy. VERIFIED/tiered cohorts sit above MODEL.
  // Tennis fills these once buckets grade out; today only MODEL is populated.
  const BANDS = {
    VERIFIED: 100,   // graded hit rate + sample past Wilson floor (e.g. fantasy once n>=50 & LB>52.4%)
    STRONG:    84,   // a tier that has graded to "strong" but not full verified
    LEAN:      70,   // graded "lean" cohort
    MODEL:     50,   // model projection, unvalidated — the provisional band (can't leap validated)
  };

  // Market reliability priors (pre-validation ordering WITHIN the model band). These are NOT hit
  // rates — they're how much we trust the market type until grading says otherwise. Fantasy has been
  // the strongest market in live testing, so it sorts to the top of the MODEL band.
  const MARKET_PRIOR = {
    'Fantasy Score': 1.00, 'Total Games Won': 0.70, 'Total Games': 0.55,
    'Break Points Won': 0.55, 'Aces': 0.50, 'Double Faults': 0.45, 'Total Tie Breaks': 0.45,
  };

  // Map an engine prop key → display market name
  const MARKET_NAME = {
    fantasyA: 'Fantasy Score', fantasyB: 'Fantasy Score',
    totalGames: 'Total Games', gamesWonA: 'Total Games Won', gamesWonB: 'Total Games Won',
    breakPointsWonA: 'Break Points Won', breakPointsWonB: 'Break Points Won',
    totalTieBreaks: 'Total Tie Breaks', acesA: 'Aces', acesB: 'Aces', dfA: 'Double Faults',
  };

  // Score one match's props → the single best play, banded. `read` is the analyze read object.
  function bestPlayForMatch(read, match) {
    if (!read || !read.props) return null;
    const players = (read.matchup || '').split(' vs ');
    let best = null;
    for (const [key, pr] of Object.entries(read.props)) {
      if (!pr || pr.line == null || pr.prob == null) continue;
      const market = MARKET_NAME[key] || key;
      const prior = MARKET_PRIOR[market] || 0.4;
      // tier from the prop's own variance classification (strong/lean/coinflip)
      const tierMul = pr.tier === 'strong' ? 1.0 : pr.tier === 'lean' ? 0.6 : 0.25;
      const edge = pr.edgeSds != null ? Math.min(1, pr.edgeSds) : 0.3;
      const score = prior * tierMul * (0.5 + edge);
      // whose prop is it (A/B suffix → player name)
      const who = /B$/.test(key) ? (players[1] || '') : (players[0] || '');
      if (!best || score > best.score) {
        best = { key, market, prop: pr, score, who,
          lean: pr.lean, line: pr.line, prob: pr.prob, mean: pr.mean,
          tier: pr.tier, edgeSds: pr.edgeSds };
      }
    }
    return best;
  }

  // Assign a validation band. Today everything is MODEL (no graded cohorts). When a gradeStatus shows
  // a shipped cohort for this market+tier, promote it above MODEL — the graduation path.
  function band(best, gradeStatus) {
    // gradeStatus.shipped === true means this bucket cleared the Wilson floor → VERIFIED
    if (gradeStatus && gradeStatus.shipped && gradeStatus.hitRate) {
      return { name: 'VERIFIED', rank: BANDS.VERIFIED, wr: Math.round(gradeStatus.hitRate * 100),
        provisional: false, n: gradeStatus.n };
    }
    // otherwise MODEL band, ordered within-band by the winnability score + market prior
    const withinBand = Math.round(best.score * 30);   // 0..~30 spread inside the MODEL band
    return { name: 'MODEL', rank: BANDS.MODEL + withinBand, wr: Math.round(best.prob * 100),
      provisional: true, n: 0 };
  }

  // Sweep a set of {match, read, gradeStatus} → ranked board rows.
  function gather(analyzed) {
    const rows = [];
    for (const a of (analyzed || [])) {
      const best = bestPlayForMatch(a.read, a.match);
      if (!best) continue;
      // skip coin-flips with no edge — they aren't plays (mirror MLB excluding "watch" notes)
      if (best.tier === 'coinflip' && (best.edgeSds == null || best.edgeSds < 0.3)) continue;
      const b = band(best, a.gradeStatus);
      const dir = best.lean === 'OVER' ? 'more' : 'less';
      const verb = best.lean === 'OVER' ? 'Bet More' : 'Bet Less';
      const plain = best.provisional
        ? `Model projects ${best.mean != null ? best.mean.toFixed(1) : ''} — take the ${best.lean} ${best.line} on ${best.market.toLowerCase()}. Provisional: modeled, not yet a validated rate.`
        : `Validated ${best.market.toLowerCase()} edge — ${b.wr}% over ${b.n} graded. Take the ${best.lean} ${best.line}.`;
      const ctxChips = [];
      if (best.tier === 'strong') ctxChips.push('STRONG — line outside the noise');
      else if (best.tier === 'lean') ctxChips.push('LEAN');
      else ctxChips.push('COIN-FLIP');
      if (best.market === 'Fantasy Score') ctxChips.push('★ strongest market');
      if (b.provisional) ctxChips.push('PROVISIONAL — calibrating');
      rows.push({
        match: a.match.playerA + ' vs ' + a.match.playerB,
        who: best.who, market: best.market, lean: best.lean, line: best.line,
        tier: b.name, wr: b.wr, rank: b.rank, dir, verb, plain, provisional: b.provisional,
        ctxChips, surface: a.match.surface,
        evidence: [
          ['Projection', best.mean != null ? best.mean.toFixed(1) : '—'],
          [b.provisional ? 'Model P' : 'Hit rate', b.wr + '%' + (b.provisional ? ' · modeled' : ' · ' + b.n + ' graded')],
          ['Variance', best.edgeSds != null ? best.edgeSds + ' SD from line' : '—'],
        ],
      });
    }
    rows.sort((x, y) => y.rank - x.rank || (y.wr || 0) - (x.wr || 0));
    return rows.slice(0, 40);
  }

  window.LyridTennisCleanestEdges = { gather, bestPlayForMatch, band, BANDS, MARKET_PRIOR };
})();
