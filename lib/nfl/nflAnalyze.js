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
import { injuryImpact } from './nflInjuryImpact.js';
import { explosiveTail } from './nflExplosiveness.js';

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
    spread, gameTotal, projectedTotal: ctx.projectedTotal, propFamily, archetype: volume?.archetype, pick,
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

  // ---- 8b. INJURY IMPACT — quantified for the offense, flagged for the defense ----
  const injury = (ctx.absentTeammates?.length || ctx.absentDefenders?.length)
    ? injuryImpact({
        player: ctx.injuryPlayerProfile || { position: ctx.position },
        absentTeammates: ctx.absentTeammates,
        absentDefenders: ctx.absentDefenders,
        propFamily,
      })
    : null;

  // ---- 9. comp projection FIRST (the explosive tail needs its median + line-softness) ----
  const comp = compPool
    ? compProject({ target: { position: ctx.position, propFamily, features: ctx.features || {} }, pool: compPool, line })
    : null;
  note(compPool, 'comp pool (P(over) / line softness)');

  // ---- COVERAGE-QUALITY PROJECTION ADJUSTMENT (per-defender, depth-chart matched) ----
  // A receiver's yards shift with the corner he actually draws. Real when-targeted coverage
  // quality (shadow_score 0..1; ~0.85 = lockdown, ~0.15 = exploitable) scales the comp median +
  // quantiles + P(over) so the TIER reflects the adjusted number. This replaces the old binary
  // shadow-DROP with a sized, honest projection change: an elite corner shaves the projection,
  // an exploitable one lifts it, and a WR1 vs an elite corner can still surface at a soft line.
  // K provisional — graded record tunes it.
  let coverageAdj = null;
  if (comp && comp.median != null && (propFamily === 'receiving_yards' || propFamily === 'rush_rec_yards') && ctx.oppCoverage && ctx.oppCoverage.shadow_score != null) {
    const s = Number(ctx.oppCoverage.shadow_score);
    const K = propFamily === 'rush_rec_yards' ? 0.18 : 0.35;   // rush_rec: only the receiving half is coverage-sensitive
    const factor = Math.max(0.80, Math.min(1.20, 1 - (s - 0.5) * K));
    if (Math.abs(factor - 1) >= 0.02) {
      const before = comp.median;
      comp.median = +(comp.median * factor).toFixed(1);
      if (comp.mean != null) comp.mean = +(comp.mean * factor).toFixed(1);
      if (comp.p25 != null) comp.p25 = Math.round(comp.p25 * factor);
      if (comp.p75 != null) comp.p75 = Math.round(comp.p75 * factor);
      comp.lineSoftness = +(comp.median - line).toFixed(1);
      // recompute P(over) consistently from the shifted quantiles (logistic-normal approx)
      if (comp.p25 != null && comp.p75 != null && comp.p75 > comp.p25) {
        const sd = (comp.p75 - comp.p25) / 1.349;
        const z = (line - comp.median) / (sd || 1);
        comp.pOver = +(1 / (1 + Math.exp(1.702 * z))).toFixed(4);
      }
      coverageAdj = { corner: ctx.oppCoverage.name, shadow_score: +s.toFixed(2), factor: +factor.toFixed(3), from: before, to: comp.median };
      comp.coverageAdj = coverageAdj;   // travels with comp so it surfaces on the pick (audit/grading)
    }
  }

  // ---- 9b. explosive / chunk-play tail (skew-aware: lifts P(over) at a stiff line for a
  // boom profile, fades it at a soft line; discounts a throws-deep-but-misses QB) ----
  const explosive = (ctx.receiverExpl || ctx.qbDeep || ctx.oppExplAllowed)
    ? explosiveTail({ receiver: ctx.receiverExpl, qb: ctx.qbDeep, oppAllowed: ctx.oppExplAllowed, comp, propFamily })
    : null;

  // ---- DEFENSIVE-INJURY MATCHUP NUDGE (the afflicted-props effect) ----
  // The opposing defense, weakened by injuries BY TYPE, lifts the matching prop: missing
  // pass-rush/coverage -> passing & receiving overs; missing run defenders -> rushing overs.
  // Impact-weighted (a DPOY out moves it, a backup doesn't), additive, capped.
  let defInjuryNudge = 0; let defInjuryNote = null;
  const _w = ctx.oppDefWeakness;
  if (_w) {
    const K = 0.03;
    if (propFamily === 'passing_yards' || propFamily === 'pass_rush_yards') defInjuryNudge = Math.min(0.20, (_w.pass_rush * 0.6 + _w.coverage * 0.5) * K);
    else if (propFamily === 'receiving_yards') defInjuryNudge = Math.min(0.20, (_w.coverage * 0.7 + _w.pass_rush * 0.3) * K);
    else if (propFamily === 'rush_rec_yards') defInjuryNudge = Math.min(0.15, (_w.coverage * 0.3 + _w.run * 0.4) * K);
    else if (propFamily === 'rushing_yards') defInjuryNudge = Math.min(0.20, (_w.run * 0.8) * K);
    defInjuryNudge = +defInjuryNudge.toFixed(4);
    if (defInjuryNudge >= 0.008 && Array.isArray(_w.out) && _w.out.length) defInjuryNote = `opponent D weakened — ${_w.out.slice(0, 2).join(', ')} out`;
  }

  // ---- 10. ADDITIVE combination (never multiplicative) ----
  // ---- DEFENSE-ARCHETYPE MATCHUP ADJUSTMENT (the Brissett-vs-SEA fix) ----
  // How this player does vs the KIND of defense he faces (large-sample archetype split, not a
  // 3-game team-name coincidence). Brissett projected 262 / went 95 vs stingy SEA pass D — the
  // model projected him as if the matchup were neutral. Shave the projection toward his archetype
  // history, CAPPED and conservative (a fraction of the delta, hard-capped), gated on >=4 games.
  // Also flag a strong fade so the tier can't reach GUARANTEED into a defense he historically dies to.
  let matchupAdj = null, matchupFade = false;
  const _md = ctx.matchupDelta;
  if (comp && comp.median != null && _md && _md.delta != null && (propFamily === 'passing_yards' || propFamily === 'receiving_yards' || propFamily === 'rushing_yards')) {
    const capYd = propFamily === 'passing_yards' ? 35 : (propFamily === 'receiving_yards' ? 18 : 20);
    const shave = Math.max(-capYd, Math.min(capYd, _md.delta * 0.45));   // 45% of the historical delta, capped
    if (Math.abs(shave) >= 2) {
      const before = comp.median;
      comp.median = +(comp.median + shave).toFixed(1);
      if (comp.mean != null) comp.mean = +(comp.mean + shave).toFixed(1);
      if (comp.p25 != null) comp.p25 = Math.round(comp.p25 + shave);
      if (comp.p75 != null) comp.p75 = Math.round(comp.p75 + shave);
      comp.lineSoftness = +(comp.median - line).toFixed(1);
      if (comp.p25 != null && comp.p75 != null && comp.p75 > comp.p25) {
        const sd = (comp.p75 - comp.p25) / 1.349, z = (line - comp.median) / (sd || 1);
        comp.pOver = +(1 / (1 + Math.exp(1.702 * z))).toFixed(4);
      }
      matchupAdj = { bucket: _md.bucket, games: _md.games, delta: _md.delta, shave: +shave.toFixed(1), from: before, to: comp.median };
      // strong fade into a tough archetype -> cap the tier later (can't be GUARANTEED/PLATINUM)
      if (shave <= -8) matchupFade = true;
    }
  }

  // ---- CAPPED-OPPORTUNITY DISCOUNT (from the Etienne loss) ----
  // A committee back has a LOW FLOOR, so his OVER is less live than his median implies. The card
  // SHOWED the flag ("committee", "capped opportunity") but never PRICED it — pOver read 73% on a
  // 60%-snap committee back that went under. This is a CONFIDENCE cap, not a matchup nudge, so it
  // discounts pOver DIRECTLY (the nudge system's 0.5x multiplier only moves ~1pt — too weak). The
  // median (central estimate) is untouched; we're pricing the downside floor risk into P(clear).
  // pass_catching_back is NOT discounted — its receiving floor IS the stabilizer, not a cap.
  let cappedWhy = null;
  if (comp && comp.pOver != null && volume) {
    const arch = volume.archetype, d = volume.detail || {};
    let pen = 0, label = null;
    // RB committee — low carry floor (the Etienne case)
    if ((propFamily === 'rushing_yards' || propFamily === 'rush_rec_yards') && arch === 'committee') {
      pen = propFamily === 'rush_rec_yards' ? 0.05 : 0.07;             // rush+rec has a mild receiving cushion
      if (d.carryMean != null && d.carryMean < 13) pen += 0.03;
      label = 'committee floor' + (d.carryMean != null ? ` (${d.carryMean.toFixed(0)} car/g)` : '');
    }
    // WR rotational — the receiver equivalent of a committee back: low route/target participation
    // caps the floor exactly the same way limited snaps cap a rotational RB.
    else if (propFamily === 'receiving_yards' && arch === 'rotational') {
      pen = 0.07;
      if (d.tsMean != null && d.tsMean < 0.15) pen += 0.03;            // thin target share caps it further
      label = 'rotational receiver' + (d.tsMean != null ? ` (${(d.tsMean*100).toFixed(0)}% tgt share)` : '');
    }
    // WR boom-bust field-stretcher — bimodal output (deep bomb or a quiet game). The median
    // OVERSTATES P(clear) because the distribution is split; floor risk is worst on possession-
    // style (lower) lines where the deep game may simply not connect.
    else if (propFamily === 'receiving_yards' && arch === 'boom_bust_field_stretcher') {
      pen = 0.06;
      if (line != null && comp.median != null && line < comp.median * 0.85) pen += 0.03;  // low line -> bimodal floor bites
      label = 'boom-bust field-stretcher — bimodal floor';
    }
    if (pen > 0) {
      comp.pOver = +Math.max(0.05, comp.pOver - pen).toFixed(4);
      cappedWhy = 'capped/volatile role — ' + label + `, over confidence \u2212${(pen*100).toFixed(0)}pts`;
    }
  }

  const extraNudges = +[
    scheme?.nudge, suppression?.nudge, coverageNudge, env?.total,
    leakage?.total, pressure?.total, pvo?.nudge, injury?.nudge, explosive?.nudge,
    script?.scriptNudge, defInjuryNudge,
  ].reduce((s, x) => s + (x || 0), 0).toFixed(4);

  const verdict = comp
    ? classifyProp({ comp, volume, script, line, structure, extraNudges, pick })
    : { pick, line, tier_candidate: 'none', filters: { softLine: false, volumeSecure: false, scriptClear: false },
        pOver: null, pOverAdjusted: null, edge: null, reasons: [],
        blocked: ['baseline pending — comp pool not loaded'], provisional: true };

  // ---- MATCHUP-FADE + CONFIDENCE-INVERSION TIER CAPS (the pass-prop over-confidence fix) ----
  // (a) A player who historically FADES into this defense archetype can't wear the top tiers —
  //     Brissett into stingy SEA pass D should never be GUARANTEED/PLATINUM.
  // (b) A HUGE projected edge on a pass-game prop is model error far more often than a real lock
  //     (a sharp market rarely misprices by 30+ pass yards). So a big pass edge LOWERS confidence
  //     instead of raising it — the graded record showed the top tiers are inverted on pass props.
  if (verdict && verdict.tier_candidate && verdict.tier_candidate !== 'none') {
    const capTo = (t) => (t === 'GUARANTEED' || t === 'PLATINUM') ? 'GOLD' : t;
    if (matchupFade) {
      verdict.tier_candidate = capTo(verdict.tier_candidate);
      (verdict.reasons ||= []).push('tier capped — historically fades vs ' + (matchupAdj ? matchupAdj.bucket : 'this defense type'));
    }
    const soft = comp && comp.lineSoftness;
    const bigEdge = (propFamily === 'passing_yards' && soft > 30) || (propFamily === 'receiving_yards' && soft > 20) || (propFamily === 'pass_rush_yards' && soft > 34);
    if (bigEdge) {
      verdict.tier_candidate = capTo(verdict.tier_candidate);
      (verdict.reasons ||= []).push('tier capped — implausibly large edge (' + soft + ') vs a sharp market, likely over-projection');
    }
  }

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

  // Defensive injuries widen uncertainty: direction is known, magnitude isn't, so a
  // top tier can't stand on a matchup read that just went stale.
  if (injury?.uncertainty >= 0.15 && verdict.tier_candidate === 'GUARANTEED') {
    verdict.tier_candidate = 'PLATINUM';
    verdict.blocked = [`opponent injury makes the matchup read stale (unquantified magnitude) — confidence reduced`,
      ...(verdict.blocked || [])];
  }

  // ---- 15. former-team context (informational; league-wide effect tested ~0) ----
  const revenge = ctx.teamHistory
    ? revengeFlag({ teamHistory: ctx.teamHistory, game: { opponent: ctx.opponent, season: ctx.season },
        priorMeetingsVsOpp: priorMeetings, baseline })
    : null;

  const result = {
    player, propFamily, line, comp,
    verdict, routing, narrative, outlook, revenge, injury,
    archetype, availability: gate,
    signals: { volume, script, scheme, suppression, coverageNudge, env, leakage, pressure, playerVsOpp: pvo, injury, explosive },
    extraNudges,
    missing,
    dataCompleteness: +(1 - missing.length / 8).toFixed(2),
  };

  // ---- 16. human layer: plain-language summary + data-backed bullets ----
  result.ceiling = explosive?.ceiling || null;
  if (explosive && explosive.ceiling) {
    (result.narrative.drivers ||= []).unshift({
      f: explosive.tag === 'field_stretcher' ? 'explosive ceiling' : 'deep-shot ceiling',
      dir: explosive.nudge >= 0 ? '+' : '-', w: Math.abs(explosive.nudge) || 0.05,
    });
  }
  if (defInjuryNote) (result.narrative.drivers ||= []).unshift({ f: defInjuryNote, dir: '+', w: Math.max(0.05, defInjuryNudge) });
  if (cappedWhy) { result.cappedOpportunity = { why: cappedWhy }; (result.narrative.drivers ||= []).unshift({ f: cappedWhy, dir: '-', w: 0.12 }); }
  if (matchupAdj) { comp.matchupAdj = matchupAdj; result.matchupAdj = matchupAdj;
    const dir = matchupAdj.shave < 0 ? '-' : '+', verb = matchupAdj.shave < 0 ? 'fades' : 'thrives';
    (result.narrative.drivers ||= []).unshift({ f: `matchup: ${verb} vs ${matchupAdj.bucket} (${matchupAdj.games}g, ${matchupAdj.delta>0?'+':''}${matchupAdj.delta} career) \u2192 proj ${matchupAdj.from}\u2192${matchupAdj.to}`, dir, w: Math.min(0.2, Math.abs(matchupAdj.shave)/40) }); }
  if (coverageAdj) {
    result.coverageAdj = coverageAdj;
    const dir = coverageAdj.to < coverageAdj.from ? '-' : '+';
    const verb = dir === '-' ? 'shaved' : 'lifted';
    (result.narrative.drivers ||= []).unshift({ f: `coverage: ${coverageAdj.corner} (${coverageAdj.shadow_score}) ${verb} proj ${coverageAdj.from}\u2192${coverageAdj.to}`, dir, w: Math.abs(coverageAdj.factor - 1) });
  }
  result.defInjury = defInjuryNudge ? { nudge: defInjuryNudge, note: defInjuryNote } : null;
  result.card = buildCard(result);
  return result;
}

export { BLITZ_HEAVY, TE_LEAN_MIN };
