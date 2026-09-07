// api/_lib/nba/nbaBestBets.js
//
// Turns the single-verdict pipeline into History-tab best bets, mirroring the other
// sports' <sport>ToCandidates. Entries enter the shared parlay_log as PENDING and are
// graded from the user's uploads. Only LEAN-or-better (edge >= 0.08) is logged.

import { decide } from './nbaVerdict.js';
import { lookupLine } from './prizepicks.js';

function provisionalTier(edge) { return edge >= 0.15 ? 'STRONG' : edge >= 0.08 ? 'LEAN' : 'PASS'; }

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

// mergedPlayers: normalizeMerge output (ideally with projMinutes/minutesCV/minutes.flags
// from the minutes model, and optionally .cadenceShares + .gameScript for the cadence stage).
// Evaluate EVERY player x market on the slate, tagging each row with isBet. The board
// shows all rows; logging uses the ones where isBet is true. Same shape rankBestBets
// produces, so toCandidates works on either.
export function evaluateSlate(mergedPlayers, byPlayerMarket, opts = {}) {
  const { league = 'NBA', markets = ['points', 'rebounds', 'assists', 'pra', 'pts_rebs', 'pts_asts', 'rebs_asts'], gradedHistory = [] } = opts;
  const rows = [];
  for (const mp of mergedPlayers || []) {
    for (const market of markets) {
      const ln = byPlayerMarket ? lookupLine(byPlayerMarket, mp.name, market)
        : (mp.line && mp.line.market === market ? mp.line : null);
      if (!ln || ln.isStandard === false || ln.line == null) continue;
      const v = decide(mp, market, ln.line, {
        league, gradedHistory, cadenceShares: mp.cadenceShares, gameScript: mp.gameScript, shotZone: mp.shotZone,
      });
      if (!v.ok) continue;
      const tier = provisionalTier(v.edge);
      const isBet = v.lean !== 'pass' && tier !== 'PASS';
      const why = [...new Set([...minutesReasons(mp), ...v.reasons])];
      rows.push({
        player: mp.name, playerId: mp.id, team: mp.currentTeam, opponent: mp.opponent,
        gameId: mp.gameId || '', date: mp.date || null,
        market, side: v.side, line: ln.line, prob: v.prob, edge: v.edge, tier, isBet,
        lineStatus: ln.lineStatus || 'standard', started: mp.starter ?? null, why, _v: v,
      });
    }
  }
  return rows;
}

export function rankBestBets(mergedPlayers, byPlayerMarket, opts = {}) {
  const { league = 'NBA', minEdge = null, markets = ['points', 'rebounds', 'assists', 'pra', 'pts_rebs', 'pts_asts', 'rebs_asts'], gradedHistory = [] } = opts;
  const ranked = [];
  for (const mp of mergedPlayers || []) {
    for (const market of markets) {
      const ln = byPlayerMarket ? lookupLine(byPlayerMarket, mp.name, market)
        : (mp.line && mp.line.market === market ? mp.line : null);
      if (!ln || ln.isStandard === false || ln.line == null) continue;

      const v = decide(mp, market, ln.line, {
        league, gradedHistory, cadenceShares: mp.cadenceShares, gameScript: mp.gameScript, shotZone: mp.shotZone,
      });
      if (!v.ok || v.lean === 'pass') continue;
      if (minEdge != null && v.edge < minEdge) continue;
      const tier = provisionalTier(v.edge);
      if (tier === 'PASS') continue;

      const why = [...new Set([...minutesReasons(mp), ...v.reasons])];
      ranked.push({
        player: mp.name, playerId: mp.id, team: mp.currentTeam, opponent: mp.opponent,
        gameId: mp.gameId || '', date: mp.date || null,
        market, side: v.side, line: ln.line, prob: v.prob, edge: v.edge, tier,
        lineStatus: ln.lineStatus || 'standard', started: mp.starter ?? null, why, _v: v,
      });
    }
  }
  ranked.sort((a, b) => b.edge - a.edge);
  return ranked;
}

// Map ranked picks -> the shared History candidate record (mirrors wnbaToCandidates).
export function toCandidates(ranked, data = {}) {
  const date = data.date || (ranked[0] && ranked[0].date) || new Date().toISOString().slice(0, 10);
  return (ranked || []).map((r) => ({
    id: ['nba', date, r.gameId || '', r.player || '', r.market, r.side].join(':'),
    sport: 'nba', date, gameId: String(r.gameId || ''),
    team: r.team, opponent: r.opponent, player: r.player, playerId: r.playerId || null,
    market: r.market, side: r.side, line: r.line,
    tier: r.tier, cashRate: r.prob, edgeType: 'nba-' + r.market, sampleN: null,
    // fields the History (nbaPropHistory) entry needs — mirrors wnbaPropHistory shape:
    edge: r.edge, probOver: r.side === 'over' ? r.prob : +(1 - r.prob).toFixed(3),
    lean: r.side, recommendation: r.side, lineSource: 'prizepicks',
    projection: r._v?.distribution?.mean ?? null,
    floor: r._v?.distribution?.floor ?? null, ceiling: r._v?.distribution?.ceiling ?? null,
    form: 'neutral', matchupContext: r.why || [], why: (r.why || []).join(' · ') || 'model edge',
    provisional: true, graded: false,
    flags: {
      antiCalibrated: !!(r._v?.engine?.flags?.confidentOverFaded),
      highScoringGame: false, started: r.started ?? false, bookProhibited: false,
      lineStatus: r.lineStatus || 'standard',
    },
  }));
}

export default { rankBestBets, toCandidates };
