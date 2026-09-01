// api/_lib/nba/nbaBestBets.js
//
// Turns the single-verdict pipeline into History-tab best bets, mirroring the other
// sports' <sport>ToCandidates. Entries enter the shared parlay_log as PENDING and are
// graded from the user's uploads. Only LEAN-or-better (edge >= 0.08) is logged.

import { decide } from './nbaVerdict.js';
import { lookupLine } from './prizepicks.js';

function provisionalTier(edge) { return edge >= 0.15 ? 'STRONG' : edge >= 0.08 ? 'LEAN' : 'PASS'; }

// Machine-readable signal tags for attribution logging — which signals fired on this
// pick, so once it grades we can measure each signal's real hit rate (NBA opening night
// forward). Mirrors the WNBA signalsFired.
function signalTags(mp, v) {
  const t = []; const mf = (mp.minutes && mp.minutes.flags) || {};
  if (mf.reducedMinutes) t.push('reduced_minutes');
  if (mf.designation && mf.designation !== 'available') t.push('designation_' + String(mf.designation).toLowerCase().replace(/\s+/g, '_'));
  if (mf.b2b) t.push('b2b');
  if (mf.blowoutRisk >= 0.5) t.push('blowout_starter_pull');
  if (mf.blowoutGarbageTime) t.push('blowout_garbage');
  if (mf.teammatesOut) t.push('teammate_out');
  if (mp.flags && mp.flags.roleUncertain) t.push('role_uncertain');
  if (v && v.engine && v.engine.flags && v.engine.flags.confidentOverFaded) t.push('anti_calibrated');
  return t;
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

// mergedPlayers: normalizeMerge output (ideally with projMinutes/minutesCV/minutes.flags
// from the minutes model, and optionally .cadenceShares + .gameScript for the cadence stage).
// Evaluate EVERY player x market that has a standard line -> rows tagged with isBet.
// This is the informational slate the board renders; bets are just the isBet===true
// subset. decide() computes the projection/distribution for all of them, so non-bet
// rows still carry projection/floor/ceiling for the recency gauge.
export function evaluateSlate(mergedPlayers, byPlayerMarket, opts = {}) {
  const { league = 'NBA', markets = ['points', 'rebounds', 'assists'], gradedHistory = [] } = opts;
  const rows = [];
  for (const mp of mergedPlayers || []) {
    for (const market of markets) {
      const ln = byPlayerMarket ? lookupLine(byPlayerMarket, mp.name, market)
        : (mp.line && mp.line.market === market ? mp.line : null);
      if (!ln || ln.isStandard === false || ln.line == null) continue;

      const v = decide(mp, market, ln.line, {
        league, gradedHistory, cadenceShares: mp.cadenceShares, gameScript: mp.gameScript,
      });
      if (!v.ok) continue;                       // couldn't evaluate (no projection) -> skip entirely
      const isBet = v.lean !== 'pass' && v.edge >= 0.08;
      const tier = isBet ? provisionalTier(v.edge) : 'PASS';

      const why = [...new Set([...minutesReasons(mp), ...v.reasons])];
      rows.push({
        player: mp.name, playerId: mp.id, team: mp.currentTeam, opponent: mp.opponent,
        gameId: mp.gameId || '', date: mp.date || null,
        market, side: v.side, line: ln.line, prob: v.prob, edge: v.edge, tier, isBet,
        lineStatus: ln.lineStatus || 'standard', started: mp.starter ?? null, why, _v: v,
        // --- logging inputs (captured at slate time, graded later) ---
        signalsFired: signalTags(mp, v),
        designation: (mp.minutes && mp.minutes.flags && mp.minutes.flags.designation) || 'available',
        totalLine: mp.gameTotal ?? null, spread: mp.spread ?? null,
      });
    }
  }
  return rows;
}

// Best bets = the LEAN-or-better subset of the evaluated slate, ranked by edge.
export function rankBestBets(mergedPlayers, byPlayerMarket, opts = {}) {
  const { minEdge = null } = opts;
  const ranked = evaluateSlate(mergedPlayers, byPlayerMarket, opts)
    .filter((r) => r.isBet && !(minEdge != null && r.edge < minEdge));
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
    isBet: r.isBet !== false,
    signalsFired: r.signalsFired || [],
    designation: r.designation || 'available',
    totalLine: r.totalLine ?? null, spread: r.spread ?? null,
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

export default { evaluateSlate, rankBestBets, toCandidates };
