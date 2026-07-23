// nflPressureDynamics.js
// Lyrid NFL engine — pressure layer (Layer 5h).
//
// Answers three questions the volume/matchup layers can't:
//   1. WHO AVOIDS THE SACK — pressure ≠ sack. Some QBs get pressured constantly and
//      still get the ball out; others fold. Measured as sacks-per-pressure.
//   2. WHERE THE BALL GOES UNDER PRESSURE — some QBs dump to the TE, some still
//      push it downfield. This REDISTRIBUTES yardage between a team's pass-catchers,
//      so it's a per-receiver signal, not just a QB one.
//   3. WHO WINS THE TRENCH BATTLE — the offense's protection vs the defense's rush,
//      which decides whether the QB's props or the DEFENSE's suppression wins out.
//
// Data (all free, nflverse):
//   pfr_advstats advstats_week_pass -> times_sacked, times_pressured(_pct),
//                                      times_blitzed, times_hurried, times_hit
//   pbp_participation was_pressure  -> joined to pbp for receiver position + air yards
//   NGS passing                     -> avg_time_to_throw
//
// VALIDATED 2024 (throwaways excluded — they're only 0.4% of pressured attempts,
// so they do NOT explain the effect):
//   TE-checkdown lean under pressure: B.Young +3.6pp, D.Jones +3.5pp, Herbert +2.9pp
//   Holds downfield under pressure:   J.Allen +7.1 aDOT, D.Watson +6.4, C.Williams +3.5
//   Collapses to checkdowns:          J.Winston -1.3, B.Purdy -1.2, S.Darnold -1.1
//
// INTERPRETATION NOTE: a POSITIVE aDOT-under-pressure means the quick game is gone
// and what remains are deeper throws — usually escapability (scramble drill). It is
// a real trait, but it raises VARIANCE as well as ceiling: good for a deep WR's
// upside, bad for a possession receiver's floor.

const LG = {
  sack_per_pressure: 0.16,   // ~16% of pressures become sacks
  pressure_pct: 0.34,        // ~34% of dropbacks pressured
  time_to_throw: 2.75,       // seconds
  te_share: 0.155,           // TE share of targets
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------------------------------------------------------------------------
// 1. SACK AVOIDANCE — pressure survived, not pressure avoided
// ---------------------------------------------------------------------------
// qb: { times_sacked, times_pressured, dropbacks, avg_time_to_throw }
export function sackAvoidance(qb) {
  if (!qb || !qb.times_pressured) return { z: 0, tag: 'unknown', nudge: 0, reasons: [] };
  const spp = qb.times_sacked / qb.times_pressured;
  const pressureRate = qb.dropbacks ? qb.times_pressured / qb.dropbacks : null;
  const reasons = [];

  // LOWER sacks-per-pressure is better -> invert
  const z = +((LG.sack_per_pressure - spp) / 0.06).toFixed(3);
  if (z >= 0.9) reasons.push(`escapes pressure (${(spp * 100).toFixed(0)}% of pressures become sacks vs ~${(LG.sack_per_pressure * 100).toFixed(0)}% league)`);
  if (z <= -0.9) reasons.push(`holds the ball — ${(spp * 100).toFixed(0)}% of pressures become sacks; drive-killing`);

  // quick release partially neutralizes a strong rush
  let quick = 0;
  if (qb.avg_time_to_throw != null) {
    quick = (LG.time_to_throw - qb.avg_time_to_throw) / 0.25;
    if (quick >= 1) reasons.push(`quick release (${qb.avg_time_to_throw.toFixed(2)}s) blunts the rush`);
    if (quick <= -1) reasons.push(`slow to release (${qb.avg_time_to_throw.toFixed(2)}s) — exposed to the rush`);
  }

  const nudge = +clamp(z * 0.10 + clamp(quick, -2, 2) * 0.04, -0.28, 0.28).toFixed(4);
  return {
    z, sackPerPressure: +spp.toFixed(3), pressureRate,
    tag: z >= 0.9 ? 'escapes_pressure' : (z <= -0.9 ? 'sack_prone' : 'neutral'),
    nudge, reasons,
  };
}

// ---------------------------------------------------------------------------
// 2. CHECKDOWN PROFILE — where the ball goes when he's in trouble
// ---------------------------------------------------------------------------
// qb: { te_share_clean, te_share_pressured, adot_clean, adot_pressured }
// Returns per-receiver-type nudges, because this REDISTRIBUTES the same yardage.
export function checkdownProfile(qb) {
  if (!qb || qb.te_share_pressured == null) {
    return { tag: 'unknown', nudges: {}, reasons: [] };
  }
  const teLean = qb.te_share_pressured - (qb.te_share_clean ?? LG.te_share);
  const adotHold = (qb.adot_pressured ?? 0) - (qb.adot_clean ?? 0);
  const reasons = [];
  const nudges = { TE: 0, deep_WR: 0, possession_WR: 0, RB: 0 };

  // TE dump-off tendency
  if (teLean >= 0.02) {
    nudges.TE += clamp(teLean * 6, 0, 0.25);
    nudges.deep_WR -= clamp(teLean * 3, 0, 0.12);
    reasons.push(`dumps to the TE under pressure (+${(teLean * 100).toFixed(1)}pp TE target share when pressured) — lifts TE floor, trims deep-WR volume`);
  } else if (teLean <= -0.02) {
    nudges.TE -= clamp(Math.abs(teLean) * 5, 0, 0.18);
    reasons.push(`does NOT check down to the TE under pressure`);
  }

  // downfield willingness under pressure
  if (adotHold >= 2.0) {
    nudges.deep_WR += clamp(adotHold * 0.03, 0, 0.22);
    nudges.possession_WR -= 0.06;
    reasons.push(`still pushes it downfield when pressured (aDOT +${adotHold.toFixed(1)} vs clean pocket) — raises deep-WR ceiling AND variance`);
  } else if (adotHold <= -0.8) {
    nudges.possession_WR += clamp(Math.abs(adotHold) * 0.10, 0, 0.15);
    nudges.deep_WR -= clamp(Math.abs(adotHold) * 0.12, 0, 0.20);
    nudges.RB += 0.05;
    reasons.push(`aDOT collapses under pressure (${adotHold.toFixed(1)}) — checkdown merchant; helps underneath, caps deep shots`);
  }

  return {
    tag: teLean >= 0.02 ? 'te_dumper' : (adotHold >= 2 ? 'downfield_under_duress' : (adotHold <= -0.8 ? 'checkdown_merchant' : 'neutral')),
    teLean: +teLean.toFixed(3), adotHold: +adotHold.toFixed(2),
    nudges, reasons,
  };
}

// ---------------------------------------------------------------------------
// 3. PRESSURE BATTLE — offense protection vs defense rush: who benefits?
// ---------------------------------------------------------------------------
// offense: { pressure_pct_allowed, sack_pct_allowed }
// defense: { pressure_rate, sack_rate }
// Returns which side is favored and what it implies for the props.
export function pressureBattle({ offense, defense, qb }) {
  if (!offense || !defense) return { edge: 'unknown', margin: 0, nudge: 0, reasons: [] };
  const reasons = [];

  // z of each side vs league; positive margin = OFFENSE wins the trench battle
  const offZ = (LG.pressure_pct - (offense.pressure_pct_allowed ?? LG.pressure_pct)) / 0.06;
  const defZ = ((defense.pressure_rate ?? LG.pressure_pct) - LG.pressure_pct) / 0.06;
  let margin = offZ - defZ;

  // an escapable QB shifts the battle toward the offense even behind a bad line
  if (qb) {
    const sa = sackAvoidance(qb);
    margin += sa.z * 0.4;
    if (Math.abs(sa.z) >= 0.9) reasons.push(sa.reasons[0]);
  }
  margin = +margin.toFixed(2);

  const edge = margin >= 0.8 ? 'offense' : (margin <= -0.8 ? 'defense' : 'even');
  if (edge === 'offense') reasons.push('protection wins — QB should get clean looks; favors the passing game and a normal handoff script');
  if (edge === 'defense') reasons.push('pass rush wins — expect hurried throws, shorter aDOT and disrupted handoffs; favors the DEFENSE suppressing yardage');

  // nudge applies to the offense's passing props (positive = good for them)
  const nudge = +clamp(margin * 0.12, -0.30, 0.30).toFixed(4);
  return { edge, margin, nudge, reasons };
}

// Convenience: full pressure read for one prop.
// receiverType in { 'TE','deep_WR','possession_WR','RB' } (null for a QB prop)
export function pressureRead({ qb, offense, defense, receiverType }) {
  const sa = sackAvoidance(qb || {});
  const cd = checkdownProfile(qb || {});
  const battle = pressureBattle({ offense, defense, qb });
  const recNudge = receiverType && cd.nudges ? (cd.nudges[receiverType] || 0) : 0;
  const total = +clamp(
    (receiverType ? 0 : sa.nudge) + battle.nudge + recNudge, -0.5, 0.5
  ).toFixed(4);
  return {
    total,
    parts: { sackAvoidance: sa, checkdown: cd, battle },
    reasons: [...sa.reasons, ...cd.reasons, ...battle.reasons],
  };
}

export { LG as PRESSURE_BASELINES };
