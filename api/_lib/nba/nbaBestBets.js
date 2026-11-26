// api/_lib/nba/nbaBestBets.js
//
// Turns the single-verdict pipeline into History-tab best bets + Key Reads.
// High-floor primary glass is now the preferred profile for Key Reads.

import { decide } from './nbaVerdict.js';
import { lookupLine } from './prizepicks.js';

function provisionalTier(edge) {
  return edge >= 0.15 ? 'STRONG' : edge >= 0.08 ? 'LEAN' : 'PASS';
}

function minutesReasons(mp) {
  const r = [];
  const mf = (mp.minutes && mp.minutes.flags) || {};
  if (mf. basereducedMinutes) r.push('projected minutes cut (under zone)');
  if (mf.designation && mf.designation !== 'available') r.push(`injury designation: ${mf.designation}`);
  if (mf.b2b) r.push('back-to-back minutes cut');
  if (mf.blowoutRisk >= 0.5) r.push('blowout starter-pull risk');
  if (mf.blowoutGarbageTime) r.push('bench garbage-time minutes');
  if (mf.teammatesOut) r.push('teammate out — usage funnel');
  if (mp.flags?.roleUncertain) r.push('role uncertain (team change)');
  return r;
}

function isHighFloorGlass(row) {
  // True high-floor primary glass profile
  if (row.preferredProfile === true) return true;
  const score = row.highFloorGlassScore ?? row.schemeScore ?? 0;
  if (score >= 72) return true;
  return false;
}

function hasHeavyRisk(row) {
  if (row.injuryFlag === 'OUT' || row.injuryFlag === 'DOUBTFUL') return true;
  const flags = row.schemeFlags || {};
  if (flags.lowMinutes || flags.foulTroubleHigh || flags.roleUncertain) return true;
  return false;
}

/**
 * Evaluate every player × market on the slate.
 */
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

      const tier = provisionalTier(v.edge);
      const isBet = v.lean !== 'pass' && tier !== 'PASS';
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

        // High-floor surface
        schemeFlags: v.schemeFlags || {},
        schemeScore: v.schemeScore ?? 50,
        schemeUnderFactors: v.schemeUnderFactors || 0,
        preferredProfile: v.preferredProfile || false,
        highFloorGlassScore: v.highFloorGlassScore ?? v.schemeScore ?? 50,
        weakestStat: v.weakestStat || market,
        riskExplanation: v.riskExplanation || '',
        injuryFlag: v.injuryFlag || null,
        proj: v.distribution?.mean ?? null,
      });
    }
  }
  return rows;
}

/**
 * Classic ranked best bets (edge-sorted).
 */
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
        schemeScore: v.schemeScore ?? 50,
        schemeUnderFactors: v.schemeUnderFactors || 0,
        preferredProfile: v.preferredProfile || false,
        highFloorGlassScore: v.highFloorGlassScore ?? v.schemeScore ?? 50,
        weakestStat: v.weakestStat || market,
        riskExplanation: v.riskExplanation || '',
        injuryFlag: v.injuryFlag || null,
        proj: v.distribution?.mean ?? null,
      });
    }
  }

  ranked.sort((a, b) => b.edge - a.edge);
  return ranked;
}

/**
 * KEY READS – High-floor primary glass only (the profile we trust).
 * Returns two lists: favorable (overs) and short (unders / risk).
 */
export function buildKeyReads(rows, opts = {}) {
  const {
    minGlassScore = 68,
    preferPreferredOnly = false,
    maxItems = 12,
  } = opts;

  const rebounds = (rows || []).filter(r => {
    const m = (r.market || '').toLowerCase();
    return m === 'rebounds' || m === 'reb' || m.includes('reb');
  });

  const candidates = rebounds.filter(r => {
    if (hasHeavyRisk(r)) return false;
    if (preferPreferredOnly) return r.preferredProfile === true;
    return isHighFloorGlass(r) || (r.highFloorGlassScore ?? r.schemeScore ?? 0) >= minGlassScore;
  });

  // Favorable = projected over (or strong preferred over)
  const favorable = candidates
    .filter(r => {
      if (r.side === 'over') return true;
      // also allow strong preferred profiles even if model is closer
      return r.preferredProfile && (r.proj == null || r.proj >= r.line);
    })
    .sort((a, b) => {
      // preferred first
      if (a.preferredProfile !== b.preferredProfile) {
        return (b.preferredProfile ? 1 : 0) - (a.preferredProfile ? 1 : 0);
      }
      const scoreDiff = (b.highFloorGlassScore ?? b.schemeScore ?? 0) - (a.highFloorGlassScore ?? a.schemeScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      // then by projection edge
      const edgeA = (a.proj ?? a.line) - a.line;
      const edgeB = (b.proj ?? b.line) - b.line;
      return edgeB - edgeA;
    })
    .slice(0, maxItems);

  // Short = projected under or heavy risk that still made it through
  const short = rebounds
    .filter(r => {
      if (r.side === 'under') return true;
      if (hasHeavyRisk(r)) return true;
      if (r.proj != null && r.proj < r.line - 0.4) return true;
      return false;
    })
    .sort((a, b) => {
      // heaviest risk / biggest short first
      const riskA = hasHeavyRisk(a) ? 1 : 0;
      const riskB = hasHeavyRisk(b) ? 1 : 0;
      if (riskB !== riskA) return riskB - riskA;
      const shortA = a.line - (a.proj ?? a.line);
      const shortB = b.line - (b.proj ?? b.line);
      return shortB - shortA;
    })
    .slice(0, maxItems);

  return {
    favorable,
    short,
    // convenience flat list for older UI
    all: [...favorable, ...short],
  };
}

/**
 * Map ranked picks -> shared History candidate record.
 */
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
    why: r.why,
    preferredProfile: r.preferredProfile,
    schemeScore: r.schemeScore,
    riskExplanation: r.riskExplanation,
    ...data,
  }));
}

export default {
  evaluateSlate,
  rankBestBets,
  buildKeyReads,
  toCandidates,
};
