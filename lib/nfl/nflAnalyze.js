// nflAnalyze.js
// Lyrid NFL engine — the orchestrator (Layer 9).
// Runs EVERY feature module for one player-prop and returns a single verdict,
// a ranked "why", and — new here — a PROP ROUTING recommendation.
//
// WHY ROUTING MATTERS (the blitz × checkdown case):
//   If the opponent is blitz-heavy AND the QB has a TE dump-off tendency, the WR1's
//   line is the WRONG side of that offense to be on. The yardage doesn't disappear —
//   it MOVES to the tight end and to the QB's short-completion total. So the engine
//   shouldn't just shave the WR1 projection; it should say "don't take WR1 here —
//   take the TE or the QB passing yards instead." That is a different, and more
//   useful, output than a nudge.
//
// Inputs are all optional. Anything missing is skipped (never faked), and its
// absence is reported in `missing` so a thin read is visibly thin.

import { volumeSecurity } from './nflVolumeSecurity.js';
import { gameScriptRisk } from './nflGameScript.js';
import { schemeMatchupNudge } from './nflSchemeMatchup.js';
import { suppressionScore, qbOutlook, shootoutProbability } from './nflMatchupAnalysis.js';
import { buildEnvironmentNudges } from './nflEnvironment.js';
import { playerVsOpponentNudge } from './nflPlayerVsOpponent.js';
import { leakageNudge } from './nflEfficiencyFactors.js';
import { pressureRead, checkdownProfile } from './nflPressureDynamics.js';
import { classifyArchetype } from './nflPlayerArchetype.js';
import { buildNarrative } from './nflMatchupNarrative.js';
import { compProject } from './nflCompEngine.js';
import { classifyProp } from './nflClassify.js';
import { gateProp } from './nflInactives.js';
import { revengeFlag } from './nflRevengeGame.js';
import { buildCard } from './nflCardSummary.js';

const BLITZ_HEAVY = 0.18;   // opponent blitz rate above this = blitz-heavy
const TE_LEAN_MIN = 0.02;   // +2pp TE target share under pressure = real tendency

// ---------------------------------------------------------------------------
// PROP ROUTING — which prop on this offense is the right one to be on
// ---------------------------------------------------------------------------
// Returns { avoid: [...], prefer: [...], flags: [...] } — actionable, not just a score.
export function routeProps({ defScheme, qbPressure, teamPressure, offense, receiverType, archetype }) {
  const flags = [];
  const avoid = [];
  const prefer = [];

  const blitzRate = defScheme?.blitz_rate;
  const cd = qbPressure ? checkdownProfile(qbPressure) : null;
  const teLean = cd?.teLean;
  const adotHold = cd?.adotHold;

  // ---- THE BLITZ × CHECKDOWN FLAG ----
  const blitzHeavy = blitzRate != null && blitzRate >= BLITZ_HEAVY;
  const teDumper = teLean != null && teLean >= TE_LEAN_MIN;

  if (blitzHeavy && teDumper) {
    flags.push({
      key: 'blitz_checkdown',
      severity: 'high',
      text: `Opponent blitzes ${Math.round(blitzRate * 100)}% (heavy) and this QB leans +${(teLean * 100).toFixed(1)}pp to the TE under pressure. Expect the ball out quick and underneath.`,
    });
    avoid.push({ prop: 'receiving_yards', who: 'WR1 / deep WR',
      why: 'blitz forces quick throws; this QB\'s answer is the TE, not the outside WR — the WR1 line is the wrong side of this offense' });
    prefer.push({ prop: 'receiving_yards', who: 'TE',
      why: 'the dump-off target absorbs the redirected volume' });
    prefer.push({ prop: 'passing_yards', who: 'QB',
      why: 'short completions still accumulate passing yards even when the WR1 line dies' });
  } else if (blitzHeavy && adotHold != null && adotHold <= -0.8) {
    // blitz + aDOT collapse (checkdown merchant, not specifically TE)
    flags.push({
      key: 'blitz_checkdown_generic',
      severity: 'moderate',
      text: `Opponent blitzes ${Math.round(blitzRate * 100)}% and this QB's aDOT collapses ${adotHold} under pressure — expect underneath volume.`,
    });
    avoid.push({ prop: 'receiving_yards', who: 'deep WR', why: 'deep shots get cut off by the blitz; this QB checks down' });
    prefer.push({ prop: 'receiving_yards', who: 'possession WR / RB', why: 'underneath targets absorb the volume' });
  } else if (blitzHeavy && adotHold != null && adotHold >= 2.0) {
    // blitz + QB who beats it deep — the opposite read
    flags.push({
      key: 'blitz_beaten_deep',
      severity: 'moderate',
      text: `Opponent blitzes ${Math.round(blitzRate * 100)}% but this QB pushes it DOWNFIELD under pressure (aDOT +${adotHold}) — blitz creates one-on-ones behind it.`,
    });
    prefer.push({ prop: 'receiving_yards', who: 'deep WR', why: 'blitz leaves single coverage; this QB attacks it (higher ceiling, higher variance)' });
  }

  // ---- protection collapse: fade the whole passing game ----
  if (teamPressure?.pressure_rate != null && offense?.sack_pct_allowed != null) {
    if (teamPressure.pressure_rate >= 0.40 && offense.sack_pct_allowed >= 0.09) {
      flags.push({ key: 'protection_collapse', severity: 'high',
        text: 'Elite rush vs leaky protection — drives stall before yardage accumulates.' });
      avoid.push({ prop: 'passing_yards', who: 'QB', why: 'sacks kill drives and subtract attempts' });
    }
  }

  // ---- archetype routing (receiving backs / hybrid QBs) ----
  if (archetype?.bestPropFamily) {
    prefer.push({ prop: archetype.bestPropFamily, who: archetype.archetype?.replace(/_/g, ' '),
      why: archetype.note || 'archetype fit' });
  }

  return { flags, avoid, prefer };
}

// ---------------------------------------------------------------------------
// MAIN — full analysis for one prop
// ---------------------------------------------------------------------------
export function analyzeProp(ctx) {
  const {
    player, propFamily, line, structure = 'standard_3', pick = 'higher',
    // feature inputs (all optional)
    trailingGames, seasonTotals, receiverType,
    defScheme, defSuppression, defCoverageByPos, teamTendency, oppName,
    qbPressure, teamPressure, offense, qb, receiverEff, teamPenalty, resilience, snap,
    spread, gameTotal, homeTeam, weather, roofStatus,
    compPool, priorMeetings, baseline, cbDepth, availability,
  } = ctx;

  const missing = [];
  const note = (cond, name) => { if (!cond) missing.push(name); };

  // ---- 1. archetype (prop routing) ----
  const archetype = seasonTotals ? classifyArchetype(seasonTotals) : null;
  note(seasonTotals, 'season totals (archetype)');

  // ---- 2. volume ----
  const volume = trailingGames ? volumeSecurity({ games: trailingGames, propFamily }) : null;
  note(trailingGames, 'trailing games (volume floor)');

  // ---- 3. game script ----
  const script = gameScriptRisk({
    spread, gameTotal, propFamily, archetype: volume?.archetype, pick,
  });

  // ---- 4. matchup: scheme + suppression + per-position coverage ----
  const scheme = schemeMatchupNudge({ defScheme, playerProfile: { archetype: volume?.archetype }, propFamily });
  const suppression = suppressionScore({ defSuppression, propFamily });
  note(defScheme, 'opponent scheme'); note(defSuppression, 'opponent suppression');

  // per-position coverage (RBs covered by LB/S — separate path)
  let coverageNudge = 0;
  if (defCoverageByPos && receiverType) {
    const grp = receiverType === 'RB' ? 'RB' : (receiverType === 'TE' ? 'TE' : 'WR');
    const row = defCoverageByPos[grp];
    if (row?.yards_per_target != null) {
      const lgYpt = { RB: 5.9, TE: 7.2, WR: 8.0 }[grp];
      coverageNudge = +(((row.yards_per_target - lgYpt) / 1.2) * 0.12).toFixed(4);
    }
  }

  // ---- 5. environment ----
  const env = buildEnvironmentNudges({ homeTeam, propFamily, weather, roofStatus,
    isDeepThreat: receiverType === 'deep_WR' });

  // ---- 6. efficiency leakage (drops / QB accuracy / penalties / resilience / snaps) ----
  const leakage = (receiverEff || qb || teamPenalty || resilience || snap)
    ? leakageNudge({ receiver: receiverEff, qb, team: teamPenalty, resilience, snap })
    : null;
  note(receiverEff, 'receiver efficiency'); note(snap, 'snap share');

  // ---- 7. pressure dynamics ----
  const pressure = (qbPressure || teamPressure)
    ? pressureRead({ qb: qbPressure, offense, defense: teamPressure, receiverType })
    : null;
  note(qbPressure, 'QB pressure profile');

  // ---- 8. history vs opponent (low weight) ----
  const pvo = priorMeetings
    ? playerVsOpponentNudge({ games: priorMeetings, propFamily,
        baselineMean: baseline?.mean, baselineStd: baseline?.std })
    : null;

  // ---- 9. ADDITIVE combination (never multiplicative) ----
  const extraNudges = +[
    scheme?.nudge, suppression?.nudge, coverageNudge, env?.total,
    leakage?.total, pressure?.total, pvo?.nudge,
  ].reduce((s, x) => s + (x || 0), 0).toFixed(4);

  // ---- 10. comp projection + classification ----
  const comp = compPool
    ? compProject({ target: { position: ctx.position, propFamily, features: ctx.features || {} }, pool: compPool, line })
    : null;
  note(compPool, 'comp pool (P(over) / line softness)');

  const verdict = comp
    ? classifyProp({ comp, volume, script, line, structure, extraNudges, pick })
    : { pick, line, tier_candidate: 'none', filters: { softLine: false, volumeSecure: false, scriptClear: false },
        pOver: null, pOverAdjusted: null, edge: null, reasons: [],
        blocked: ['baseline pending — comp pool not loaded'], provisional: true };

  // ---- 11. day-of availability gate (can KILL the pick) ----
  const gate = availability
    ? gateProp({ availability, prop: { player, propType: propFamily },
        context: { keyDefender: ctx.keyDefender, teammates: ctx.teammates } })
    : { decision: 'flag', reasons: ['day-of availability not checked'] };
  if (gate.decision === 'kill') {
    verdict.tier_candidate = 'none';
    verdict.blocked = [gate.reasons[0], ...(verdict.blocked || [])];
  }

  // ---- 12. prop routing (the blitz × checkdown flag) ----
  const routing = routeProps({ defScheme, qbPressure, teamPressure, offense, receiverType, archetype });

  // ROUTING OVERRIDE — if the router says AVOID this exact prop, the tier must not
  // stand. A card reading GUARANTEED while the routing says "don't take this one"
  // is the engine contradicting itself; the routing read is the more specific
  // (matchup-level) signal, so it demotes the tier rather than sitting beside it.
  const avoidsThis = (routing.avoid || []).some(a => {
    if (a.prop !== propFamily) return false;
    if (!receiverType) return true;
    const who = String(a.who || '').toLowerCase();
    if (receiverType === 'deep_WR') return who.includes('wr') || who.includes('deep');
    if (receiverType === 'TE') return who.includes('te');
    if (receiverType === 'possession_WR') return who.includes('possession') || who.includes('wr1');
    return false;
  });
  if (avoidsThis && verdict.tier_candidate !== 'none') {
    const hi = (routing.flags || []).find(f => f.severity === 'high');
    verdict.routingOverride = {
      demotedFrom: verdict.tier_candidate,
      reason: hi ? hi.text : 'matchup routing advises against this prop',
    };
    // high-severity => no play; moderate => demote one step
    if (hi) {
      verdict.tier_candidate = 'none';
    } else {
      verdict.tier_candidate = verdict.tier_candidate === 'GUARANTEED' ? 'PLATINUM'
        : (verdict.tier_candidate === 'PLATINUM' ? 'GOLD' : 'none');
    }
    verdict.blocked = [
      `routing: ${verdict.routingOverride.reason}`,
      ...(verdict.blocked || []),
    ];
  }

  // ---- 13. narrative ----
  const narrative = buildNarrative({
    defScheme, oppName, receiver: ctx.receiver, cbDepth,
    comp, volume, script, suppression, scheme, env, playerVsOpp: pvo,
  });

  // ---- 14. QB-specific outlook ----
  const outlook = (propFamily === 'passing_yards' || propFamily === 'pass_rush_yards')
    ? qbOutlook({ qb: { volumeFloor: volume?.volume_floor_score, cpoeBaseline: qb?.cpoe, isMobile: archetype?.archetype?.includes('dual') },
        oppSuppression: defSuppression, teamTendency, gameScript: script, envNudge: env?.total })
    : null;

  // ---- 15. former-team context (informational; league-wide effect tested ~0) ----
  const revenge = ctx.teamHistory
    ? revengeFlag({ teamHistory: ctx.teamHistory, game: { opponent: ctx.opponent, season: ctx.season },
        priorMeetingsVsOpp: priorMeetings, baseline })
    : null;

  const result = {
    player, propFamily, line, comp,
    verdict, routing, narrative, outlook, revenge,
    archetype, availability: gate,
    signals: { volume, script, scheme, suppression, coverageNudge, env, leakage, pressure, playerVsOpp: pvo },
    extraNudges,
    missing,
    dataCompleteness: +(1 - missing.length / 8).toFixed(2),
  };

  // ---- 16. human layer: plain-language summary + data-backed bullets ----
  result.card = buildCard(result);
  return result;
}

export { BLITZ_HEAVY, TE_LEAN_MIN };
