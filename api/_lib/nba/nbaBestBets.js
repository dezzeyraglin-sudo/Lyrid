// api/_lib/nba/nbaBestBets.js
// Hardened so playerCards always receive projection/floor/ceiling/cashRate.

import { decide } from './nbaVerdict.js';
import { lookupLine } from './prizepicks.js';

function provisionalTier(edge) {
  return edge >= 0.15 ? 'STRONG' : edge >= 0.08 ? 'LEAN' : 'PASS';
}

function minutesReasons(mp) {
  const r = [];
  const mf = (mp.minutes && mp.minutes.flags) || {};
  if (mf.reducedMinutes) r.push('projected minutes cut (under zone)');
  if (mf.designation && mf.designation !== 'available') r.push(`injury designation: ${mf.designation}`);
  if (mf.b2b) r.push('back-to-back minutes cut');
  if (mf.blowoutRisk >= 0.5) r.push('blowout starter-pull risk');
  if (mf.blowoutGarbageTime) r.push('bench garbage-time minutes');
  if (mf.teammatesOut) r.push('teammate out — usage funnel');
  if (mp.flags?.roleUncertain) r.push('role uncertain (team change)');
  return r;
}

function rowFromVerdict(mp, market, ln, v) {
  const tier = provisionalTier(v.edge);
  const isBet = v.lean !== 'pass' && tier !== 'PASS';
  const why = [...new Set([...minutesReasons(mp), ...(v.reasons || [])])];
  const dist = v.distribution || {};

  return {
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

    // Fields buildPlayerCards expects
    projection: dist.mean ?? null,
    floor: dist.floor ?? null,
    ceiling: dist.ceiling ?? null,
    cashRate: v.prob ?? null,
    proj: dist.mean ?? null,

    // High-floor / scheme surface
    schemeFlags: v.schemeFlags || {},
    schemeScore: v.schemeScore ?? 50,
    schemeUnderFactors: v.schemeUnderFactors || 0,
    preferredProfile: v.preferredProfile || false,
    highFloorGlassScore: v.highFloorGlassScore ?? v.schemeScore ?? 50,
    weakestStat: v.weakestStat || market,
    riskExplanation: v.riskExplanation || '',
    injuryFlag: v.injuryFlag || null,
    lean: v.lean,
  };
}

export function evaluateSlate(mergedPlayers, byPlayerMarket, opts = {}) {
  const {
    league = 'NBA',
    markets = ['points', 'rebounds', 'assists', 'pra', 'pts_rebs', 'pts_asts', 'rebs_asts'],
    gradedHistory = [],
    trace = null,
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
        league,
        gradedHistory,
        cadenceShares: mp.cadenceShares,
        gameScript: mp.gameScript,
        shotZone: mp.shotZone,
        date: mp.date,
      });

      if (!v.ok) { skip('decide:' + (v.reason || v.error || 'ok:false')); continue; }

      rows.push(rowFromVerdict(mp, market, ln, v));
    }
  }
  return rows;
}

export function rankBestBets(mergedPlayers, byPlayerMarket, opts = {}) {
  const {
    league = 'NBA',
    minEdge = null,
    markets = ['points', 'rebounds', 'assists', 'pra', 'pts_rebs', 'pts_asts', 'rebs_asts'],
    gradedHistory = [],
  } = opts;

  const ranked = [];
  for (const mp of mergedPlayers || []) {
    for (const market of markets) {
      const ln = byPlayerMarket
        ? (mp.ppKey ? byPlayerMarket[mp.ppKey + '|' + market] : lookupLine(byPlayerMarket, mp.name, market))
        : (mp.line && mp.line.market === market ? mp.line : null);

      if (!ln || ln.isStandard === false || ln.line == null) continue;

      const v = decide(mp, market, ln.line, {
        league,
        gradedHistory,
        cadenceShares: mp.cadenceShares,
        gameScript: mp.gameScript,
        shotZone: mp.shotZone,
        date: mp.date,
      });

      if (!v.ok || v.lean === 'pass') continue;
      if (minEdge != null && v.edge < minEdge) continue;

      const tier = provisionalTier(v.edge);
      if (tier === 'PASS') continue;

      ranked.push(rowFromVerdict(mp, market, ln, v));
    }
  }

  ranked.sort((a, b) => b.edge - a.edge);
  return ranked;
}

export function buildKeyReads(rows, opts = {}) {
  const { maxItems = 12 } = opts;

  const rebounds = (rows || []).filter(r => {
    const m = (r.market || '').toLowerCase();
    return m === 'rebounds' || m === 'reb' || m.includes('reb');
  });

  const favorable = rebounds
    .filter(r => r.side === 'over' || (r.proj != null && r.proj > r.line))
    .sort((a, b) => {
      const edgeA = (a.proj ?? a.line) - a.line;
      const edgeB = (b.proj ?? b.line) - b.line;
      if (edgeB !== edgeA) return edgeB - edgeA;
      return (b.schemeScore ?? 0) - (a.schemeScore ?? 0);
    })
    .slice(0, maxItems);

  const short = rebounds
    .filter(r => r.side === 'under' || (r.proj != null && r.proj < r.line))
    .sort((a, b) => {
      const shortA = a.line - (a.proj ?? a.line);
      const shortB = b.line - (b.proj ?? b.line);
      if (shortB !== shortA) return shortB - shortA;
      return (a.schemeScore ?? 50) - (b.schemeScore ?? 50);
    })
    .slice(0, maxItems);

  return {
    favorable,
    short,
    all: [...favorable, ...short],
  };
}

export function toCandidates(ranked, data = {}) {
  return (ranked || []).map((r) => ({
    player: r.player,
    playerId: r.playerId,
    team: r.team,
    opponent: r.opponent,
    gameId: r.gameId,
    date: r.date,
    market: r.market,
    side: r.side,
    line: r.line,
    prob: r.prob,
    edge: r.edge,
    tier: r.tier,
    isBet: r.isBet,
    why: r.why,
    // keep card fields
    projection: r.projection,
    floor: r.floor,
    ceiling: r.ceiling,
    cashRate: r.cashRate,
    proj: r.proj,
    preferredProfile: r.preferredProfile,
    schemeScore: r.schemeScore,
    schemeFlags: r.schemeFlags,
    schemeUnderFactors: r.schemeUnderFactors,
    riskExplanation: r.riskExplanation,
    injuryFlag: r.injuryFlag,
    lean: r.lean,
    ...data,
  }));
}

export default {
  evaluateSlate,
  rankBestBets,
  buildKeyReads,
  toCandidates,
};
