// nflEfficiencyFactors.js
// Lyrid NFL engine — yardage leakage factors (Layer 5f).
//
// Three ways yards that "should" happen don't — all invisible to volume metrics:
//   1. DROPS        — receiver gets the target, doesn't convert it
//   2. QB ACCURACY  — uncatchable balls; the target is wasted before it arrives
//   3. PENALTIES    — the catch happens, then gets erased (no_play)
//
// All three erase realized yardage while leaving target/volume data looking healthy,
// which is exactly how a "volume-secure" read can still miss. They belong as
// additive z-nudges alongside volume and matchup.
//
// Data (all free, nflverse):
//   pfr_advstats advstats_week_rec  -> receiving_drop, receiving_drop_pct
//   pfr_advstats advstats_week_pass -> passing_bad_throw_pct, passing_drop_pct
//   pbp play_type=='no_play' + offensive penalty -> nullification rate
//
// Validated on real 2024 data (see thresholds below).

const LG = {
  drop_pct: 0.055,        // ~5.5% league-average receiver drop rate
  bad_throw_pct: 0.185,   // ~18.5% league-average QB bad-throw rate
  nullify_pct: 0.024,     // ~2.4% of pass plays wiped by own penalty (2024 mean)
  target_rate: 0.19,      // targets / team pass attempts, WR1-ish baseline
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------------------------------------------------------------------------
// 1. RECEIVER QUALITY — target rate (opportunity) + drop rate (conversion)
// ---------------------------------------------------------------------------
// receiver: { targets, teamPassAttempts, receiving_drop, receiving_drop_pct, games }
export function receiverQuality(receiver) {
  if (!receiver) return { nudge: 0, tag: 'unknown', detail: {} };
  const targetRate = receiver.teamPassAttempts
    ? receiver.targets / receiver.teamPassAttempts
    : null;
  const dropPct = receiver.receiving_drop_pct != null
    ? receiver.receiving_drop_pct
    : (receiver.targets ? (receiver.receiving_drop || 0) / receiver.targets : null);

  let nudge = 0;
  const reasons = [];

  // opportunity: higher target rate lifts the projection
  if (targetRate != null) {
    const z = (targetRate - LG.target_rate) / 0.07;
    nudge += clamp(z * 0.18, -0.30, 0.30);
    if (z > 0.8) reasons.push(`elite target rate (${Math.round(targetRate * 100)}% of team attempts)`);
    if (z < -0.8) reasons.push(`low target rate (${Math.round(targetRate * 100)}%)`);
  }

  // conversion: drops erase yardage the volume implies
  if (dropPct != null) {
    const z = (dropPct - LG.drop_pct) / 0.035;
    nudge -= clamp(z * 0.14, -0.25, 0.25);   // more drops => negative
    if (z > 1.0) reasons.push(`high drop rate (${(dropPct * 100).toFixed(1)}% vs ~${(LG.drop_pct * 100).toFixed(1)}% league) — erases realized yards`);
    if (z < -1.0) reasons.push(`reliable hands (${(dropPct * 100).toFixed(1)}% drops)`);
  }

  nudge = +clamp(nudge, -0.4, 0.4).toFixed(4);
  return {
    nudge,
    tag: nudge > 0.12 ? 'efficient_target' : (nudge < -0.12 ? 'leaky' : 'neutral'),
    detail: { targetRate: targetRate != null ? +targetRate.toFixed(3) : null, dropPct },
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 2. QB ACCURACY — separates "throws bad balls" from "receivers drop good balls"
// ---------------------------------------------------------------------------
// qb: { passing_bad_throw_pct, passing_drop_pct, cpoe }
// Applies to the QB's own passing prop AND (as a smaller nudge) to his receivers':
// an inaccurate QB depresses every pass-catcher on the roster.
export function qbAccuracy(qb, { appliesTo = 'qb' } = {}) {
  if (!qb) return { nudge: 0, tag: 'unknown', reasons: [] };
  const reasons = [];
  let nudge = 0;

  if (qb.passing_bad_throw_pct != null) {
    const z = (qb.passing_bad_throw_pct - LG.bad_throw_pct) / 0.05;
    const w = appliesTo === 'qb' ? 0.20 : 0.12;   // smaller effect on a receiver's line
    nudge -= clamp(z * w, -0.35, 0.35);
    if (z > 0.9) reasons.push(`inaccurate passer (${(qb.passing_bad_throw_pct * 100).toFixed(1)}% bad throws vs ~${(LG.bad_throw_pct * 100).toFixed(1)}% league) — catchable-ball rate suppresses receiver yardage`);
    if (z < -0.9) reasons.push(`accurate passer (${(qb.passing_bad_throw_pct * 100).toFixed(1)}% bad throws)`);
  }
  // CPOE is complementary (completion above expectation)
  if (qb.cpoe != null) {
    nudge += clamp(qb.cpoe / 30, -0.15, 0.15);
  }
  // if his receivers drop a lot, that's THEIR problem, not his — don't double-penalize
  // the QB, but DO flag it when evaluating a receiver on this offense.
  if (appliesTo === 'receiver' && qb.passing_drop_pct != null && qb.passing_drop_pct > 0.07) {
    reasons.push(`offense drops ${(qb.passing_drop_pct * 100).toFixed(1)}% of targets`);
  }

  nudge = +clamp(nudge, -0.4, 0.4).toFixed(4);
  return {
    nudge,
    tag: nudge < -0.12 ? 'accuracy_drag' : (nudge > 0.12 ? 'accuracy_boost' : 'neutral'),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 3. PENALTY DRAG — receptions that happen and then get erased
// ---------------------------------------------------------------------------
// A completed pass wiped by offensive holding / OPI / ineligible downfield never
// counts. 2024 spread was real: NE erased 4.1% of its pass plays, LA only 1.34% —
// roughly a 3x difference in how often a receiver's catch gets taken back.
// team: { nullify_pct }  (share of team pass plays wiped by own penalty)
export function penaltyDrag(team) {
  if (!team || team.nullify_pct == null) {
    return { nudge: 0, tag: 'unknown', reasons: ['no penalty data'] };
  }
  const z = (team.nullify_pct - LG.nullify_pct) / 0.008;
  let nudge = -clamp(z * 0.10, -0.22, 0.22);   // more nullifications => negative
  const reasons = [];
  if (z > 1.0) reasons.push(`penalty-prone offense — ${(team.nullify_pct * 100).toFixed(1)}% of pass plays wiped by its own flag (league ~${(LG.nullify_pct * 100).toFixed(1)}%), erasing completed catches`);
  if (z < -1.0) reasons.push(`disciplined offense — few plays erased by penalty`);
  nudge = +nudge.toFixed(4);
  return { nudge, tag: nudge < -0.08 ? 'penalty_drag' : 'neutral', reasons };
}


// ---------------------------------------------------------------------------
// 4. RECEIVER RESILIENCE — "catches bad balls"
// ---------------------------------------------------------------------------
// Receiver CPOE = actual catch rate minus the mean completion probability of his
// targets. Positive = he converts throws he statistically shouldn't. Computed free
// from pbp (`cp` per pass). Validated 2024: Kittle +18.2, M.Andrews +17.7,
// Thielen +16.4; drop-prone types land at -11 to -14. League mean ~+1.8, sd ~6.0.
//
// WHY THIS MATTERS: it is the SHIELD against the qbAccuracy penalty. A resilient
// receiver is far less damaged by an inaccurate QB — penalizing him the same as a
// brittle one (which the first version of this module did) is simply wrong.
//
// NOTE ON POSITION: TEs dominate the top of raw receiver-CPOE (shorter, more
// contested targets). Pass `position` to normalize so WRs aren't unfairly ranked
// against TE-friendly target profiles.
const REC_CPOE_LG = { ALL: 1.8, WR: 0.9, TE: 6.0, RB: 2.5 };
const REC_CPOE_SD = 6.0;

export function receiverResilience({ recCpoe, position, targets }) {
  if (recCpoe == null) return { z: 0, tag: 'unknown', shield: 0, reasons: [] };
  if (targets != null && targets < 30) {
    return { z: 0, tag: 'insufficient_sample', shield: 0,
             reasons: [`only ${targets} targets — resilience unproven`] };
  }
  const base = REC_CPOE_LG[position] ?? REC_CPOE_LG.ALL;
  const z = +((recCpoe - base) / REC_CPOE_SD).toFixed(3);
  const reasons = [];
  if (z >= 0.9) reasons.push(`catches contested/off-target balls (rec CPOE ${recCpoe > 0 ? '+' : ''}${recCpoe}, ${z.toFixed(1)}sd above ${position || 'position'} norm)`);
  if (z <= -0.9) reasons.push(`converts poorly on catchable targets (rec CPOE ${recCpoe})`);

  // shield: 0..1 — how much of an inaccurate-QB penalty this receiver absorbs
  const shield = +clamp(z / 2.2, 0, 0.75).toFixed(3);
  return {
    z,
    tag: z >= 0.9 ? 'bad_ball_catcher' : (z <= -0.9 ? 'brittle_hands' : 'neutral'),
    shield,
    nudge: +clamp(z * 0.12, -0.25, 0.25).toFixed(4),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 5. SNAP SECURITY — is he actually on the field for everything?
// ---------------------------------------------------------------------------
// snap: { offense_pct_mean, offense_pct_sd, games }
// Validated 2024: Garrett Wilson .963 mean / .044 sd (every-down); rotational
// types run .35-.65 with sd .30+ (Olave injury-split, D.Johnson traded).
// High MEAN with LOW SD is the winning profile; a high mean with high sd is a
// player whose role is changing — treat the baseline as stale.
export function snapSecurity(snap) {
  if (!snap || snap.offense_pct_mean == null) {
    return { score: null, tag: 'unknown', nudge: 0, reasons: ['no snap data'] };
  }
  const m = snap.offense_pct_mean;
  const sd = snap.offense_pct_sd ?? 0;
  const reasons = [];

  const level = clamp(m / 0.92, 0, 1);            // .92+ ~ every-down
  const stability = clamp(1 - sd * 3.2, 0, 1);    // sd .10 -> .68, sd .30 -> .04
  const score = +(0.6 * level + 0.4 * stability).toFixed(3);

  if (m >= 0.88 && sd <= 0.08) reasons.push(`every-down role (${Math.round(m * 100)}% of snaps, stable)`);
  else if (m >= 0.88 && sd > 0.15) reasons.push(`high but VOLATILE snap share (${Math.round(m * 100)}%, sd ${sd.toFixed(2)}) — role changing, baseline may be stale`);
  else if (m < 0.6) reasons.push(`rotational (${Math.round(m * 100)}% of snaps) — capped opportunity`);
  if (sd > 0.25) reasons.push('snap share swinging game to game (injury/role churn)');

  return {
    score,
    tag: score >= 0.75 ? 'every_down' : (score >= 0.5 ? 'starter' : 'rotational'),
    nudge: +clamp((score - 0.6) * 0.45, -0.25, 0.25).toFixed(4),
    reasons,
  };
}

// Convenience: combined leakage nudge for a receiving prop.
export function leakageNudge({ receiver, qb, team, resilience, snap }) {
  const r = receiverQuality(receiver);
  const a = qbAccuracy(qb, { appliesTo: 'receiver' });
  const p = penaltyDrag(team);
  const res = receiverResilience(resilience || {});
  const sn = snapSecurity(snap);

  // THE SHIELD: a receiver who catches bad balls absorbs part of the inaccurate-QB
  // penalty. Only shields a NEGATIVE accuracy nudge — it never inflates a good QB.
  let accAdj = a.nudge;
  const shieldReasons = [];
  if (accAdj < 0 && res.shield > 0) {
    const recovered = +(Math.abs(accAdj) * res.shield).toFixed(4);
    accAdj = +(accAdj + recovered).toFixed(4);
    shieldReasons.push(`resilience offsets ${Math.round(res.shield * 100)}% of the QB-accuracy drag (catches off-target throws)`);
  }

  const total = +(r.nudge + accAdj + p.nudge + res.nudge + sn.nudge).toFixed(4);
  return {
    total: clamp(total, -0.7, 0.7),
    parts: { receiver: r, qbAccuracy: { ...a, nudgeAdjusted: accAdj }, penalty: p, resilience: res, snap: sn },
    reasons: [...r.reasons, ...a.reasons, ...shieldReasons, ...res.reasons, ...sn.reasons, ...p.reasons],
  };
}

export { LG as LEAGUE_EFFICIENCY_BASELINES };
