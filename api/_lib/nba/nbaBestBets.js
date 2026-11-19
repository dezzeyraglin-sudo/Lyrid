// api/_lib/nba/nbaBestBets.js
//
// Turns the single-verdict pipeline into History-tab best bets.
// Enhanced: ranks by edge × schemeScore (high-floor preference) and surfaces
// the preferred-profile / risk-explanation fields from schemeRisk.

import { decide } from './nbaVerdict.js';
import { lookupLine } from './prizepicks.js';

function provisionalTier(edge, schemeScore = 50) {
  // Prefer high-floor plays: a strong schemeScore can elevate a modest edge
  const adjusted = edge + (schemeScore >= 68 ? 0.025 : schemeScore >= 55 ? 0.01 : schemeScore < 35 ? -0.03 : 0);
  if (adjusted >= 0.15) return 'STRONG';
  if (adjusted >= 0.08) return 'LEAN';
  return 'PASS';
}

function minutesReasons(mp) {
  const r = []; const mf = (mp.minutes && mp.minutes.flags) || {};
  if (mf.reducedMinutes) r.push('projected minutes cut (under zone)');
  if (mf.designation && mf.designation !== 'available') r.push(`injury designation: ${mf.designation}`);
  if (mf.b2b) r.push('back-to-back minutes cut');
  if (mf.blowoutRisk >= 0.5) r.push('blowout starter-pull risk');
  if (mf.blowoutGarbageTime) r.push('bench garbage-time minutes');
  if (mf.teammatesOut) r.push('teammate out — usage funnel');
  if (mp.flags?.roleUncertain) r.push('role uncertain (team change)');
  return r;
}

// Composite sort key: prefer high schemeScore (high-floor) then edge
function sortKey(row) {
  const floorBonus = (row.schemeScore || 50) >= 68 ? 0.04 : (row.schemeScore || 50) >= 55 ? 0.015 : 0;
  const riskPenalty = (row.schemeFlags?.forcedPass || row.schemeFlags?.adviseUnder) ? -0.08 : 0;
  return (row.edge || 0) + floorBonus + riskPenalty;
}

/**
 * Evaluate every player × market. Tags isBet and attaches full scheme surface.
 */
export function evaluateSlate(mergedPlayers, byPlayerMarket, opts = {}) {
  const {
    league = 'NBA',
    markets = ['points', 'rebounds', 'assists', 'pra', 'pts_rebs', 'pts_asts', 'rebs_asts'],
    gradedHistory = [],
    trace = null,
    preferHighFloor = true,
  } = opts;

  const rows = [];
  const skip = (k) => { if (trace) trace[k] = (trace[k] || 0) + 1; };

  for (const mp of mergedPlayers || []) {
    for (const market of markets) {
      const ln = byPlayerMarket
        ? (mp.ppKey ? byPlayerMarket[mp.ppKey + '|' + market] : lookupLine(byPlayerMarket, mp.name, market))
        : (mp.line && mp.line.market === market ? mp.line : null);

      if (!ln) { skip('noLine'); continue; }
      if (ln.isStandard === false) { skip('nonStandardLine'); continue; }
      if (ln.line == null) { skip('nullLine'); continue; }

      const v = decide(mp, market, ln.line, {
        league, gradedHistory,
        cadenceShares: mp.cadenceShares,
        gameScript: mp.gameScript,
        shotZone: mp.shotZone,
        date: mp.date,
      });

      if (!v.ok) { skip('decide:' + (v.reason || v.error || 'ok:false')); continue; }

      const schemeScore = v.schemeScore ?? 50;
      const tier = provisionalTier(v.edge, schemeScore);
      const isBet = v.lean !== 'pass' && tier !== 'PASS' && !v.schemeFlags?.forcedPass;

      const why = [...new Set([...minutesReasons(mp), ...(v.reasons || [])])];

      rows.push({
        player: mp.name,
        playerId: mp.id,
        team: mp.currentTeam,
        opponent: mp.opponent,
        gameId: mp.gameId || '',
        date: mp.date || null,
        market,
        side: v.side,
        line: ln.line,
        prob: v.prob,
        edge: v.edge,
        tier,
        isBet,
        lineStatus: ln.lineStatus || 'standard',
        started: mp.starter ?? null,
        why,
        _v: v,
        // Full scheme surface
        schemeFlags: v.schemeFlags || {},
        schemeScore,
        schemeUnderFactors: v.schemeUnderFactors || 0,
        preferredProfile: v.preferredProfile || null,
        weakestStat: v.weakestStat || market,
        riskExplanation: v.riskExplanation || '',
      });
    }
  }

  // Optional: sort the full board by the high-floor-aware key
  if (preferHighFloor) {
    rows.sort((a, b) => sortKey(b) - sortKey(a));
  }

  return rows;
}

/**
 * Rank only actionable (non-pass) candidates, high-floor first.
 */
export function rankBestBets(mergedPlayers, byPlayerMarket, opts = {}) {
  const {
    league = 'NBA',
    minEdge = null,
    markets = ['points', 'rebounds', 'assists', 'pra', 'pts_rebs', 'pts_asts', 'rebs_asts'],
    gradedHistory = [],
    preferHighFloor = true,
  } = opts;

  const ranked = [];

  for (const mp of mergedPlayers || []) {
    for (const market of markets) {
      const ln = byPlayerMarket
        ? (mp.ppKey ? byPlayerMarket[mp.ppKey + '|' + market] : lookupLine(byPlayerMarket, mp.name, market))
        : (mp.line && mp.line.market === market ? mp.line : null);

      if (!ln || ln.isStandard === false || ln.line == null) continue;

      const v = decide(mp, market, ln.line, {
        league, gradedHistory,
        cadenceShares: mp.cadenceShares,
        gameScript: mp.gameScript,
        shotZone: mp.shotZone,
        date: mp.date,
      });

      if (!v.ok || v.lean === 'pass') continue;
      if (v.schemeFlags?.forcedPass) continue;
      if (minEdge != null && v.edge < minEdge) continue;

      const schemeScore = v.schemeScore ?? 50;
      const tier = provisionalTier(v.edge, schemeScore);
      if (tier === 'PASS') continue;

      const why = [...new Set([...minutesReasons(mp), ...(v.reasons || [])])];

      ranked.push({
        player: mp.name,
        playerId: mp.id,
        team: mp.currentTeam,
        opponent: mp.opponent,
        gameId: mp.gameId || '',
        date: mp.date || null,
        market,
        side: v.side,
        line: ln.line,
        prob: v.prob,
        edge: v.edge,
        tier,
        lineStatus: ln.lineStatus || 'standard',
        started: mp.starter ?? null,
        why,
        _v: v,
        schemeFlags: v.schemeFlags || {},
        schemeScore,
        schemeUnderFactors: v.schemeUnderFactors || 0,
        preferredProfile: v.preferredProfile || null,
        weakestStat: v.weakestStat || market,
        riskExplanation: v.riskExplanation || '',
      });
    }
  }

  // High-floor aware sort
  ranked.sort((a, b) => {
    if (preferHighFloor) return sortKey(b) - sortKey(a);
    return (b.edge || 0) - (a.edge || 0);
  });

  return ranked;
}

/**
 * Convenience: return only the high-floor preferred profiles (the style that worked).
 */
export function rankHighFloorBets(mergedPlayers, byPlayerMarket, opts = {}) {
  const all = rankBestBets(mergedPlayers, byPlayerMarket, { ...opts, preferHighFloor: true });
  return all.filter(r =>
    (r.schemeScore || 0) >= 60 &&
    !r.schemeFlags?.foulTrouble &&
    !r.schemeFlags?.forcedPass &&
    !r.schemeFlags?.adviseUnder &&
    (r.preferredProfile || r.schemeScore >= 68)
  );
}

/**
 * Map ranked picks → shared History candidate record.
 */
export function toCandidates(ranked, data = {}) {
  const date = data.date || (ranked[0] && ranked[0].date) || new Date().toISOString().slice(0, 10);
  return (ranked || []).map((r) => ({
    id: ['nba', date, r.gameId || '', r.player || '', r.market, r.side].join(':'),
    sport: 'nba',
    date,
    gameId: String(r.gameId || ''),
    team: r.team,
    opponent: r.opponent,
    player: r.player,
    playerId: r.playerId || null,
    market: r.market,
    side: r.side,
    line: r.line,
    tier: r.tier,
    cashRate: r.prob,
    edgeType: 'nba-' + r.market,
    sampleN: null,
    isBet: r.isBet != null ? !!r.isBet : (r.tier !== 'PASS'),
    edge: r.edge,
    probOver: r.side === 'over' ? r.prob : +(1 - r.prob).toFixed(3),
    lean: r.side,
    recommendation: r.side,
    lineSource: 'prizepicks',
    projection: r._v?.distribution?.mean ?? null,
    floor: r._v?.distribution?.floor ?? null,
    ceiling: r._v?.distribution?.ceiling ?? null,
    form: 'neutral',
    matchupContext: r.why || [],
    why: (r.why || []).join(' · ') || 'model edge',
    provisional: true,
    graded: false,
    flags: {
      antiCalibrated: !!(r._v?.engine?.flags?.confidentOverFaded),
      highScoringGame: false,
      started: r.started ?? false,
      bookProhibited: false,
      lineStatus: r.lineStatus || 'standard',
      purePointsRisk: !!(r.schemeFlags && r.schemeFlags.purePointsRisk),
      schemeHostile: !!(r.schemeFlags && r.schemeFlags.schemeHostile),
      minutesRisk: !!(r.schemeFlags && r.schemeFlags.minutesRisk),
      foulTrouble: !!(r.schemeFlags && r.schemeFlags.foulTrouble),
      forcedPass: !!(r.schemeFlags && r.schemeFlags.forcedPass),
      compoundingUnder: !!(r.schemeFlags && r.schemeFlags.compoundingUnder),
      adviseUnder: !!(r.schemeFlags && r.schemeFlags.adviseUnder),
      secondaryCompetition: !!(r.schemeFlags && r.schemeFlags.secondaryCompetition),
      highVolumePreferred: !!(r.schemeFlags && r.schemeFlags.highVolumePreferred),
    },
    schemeScore: r.schemeScore ?? 50,
    schemeUnderFactors: r.schemeUnderFactors || 0,
    schemeFlags: r.schemeFlags || {},
    preferredProfile: r.preferredProfile || null,
    weakestStat: r.weakestStat || r.market,
    riskExplanation: r.riskExplanation || '',
  }));
}

export default { evaluateSlate, rankBestBets, rankHighFloorBets, toCandidates };
