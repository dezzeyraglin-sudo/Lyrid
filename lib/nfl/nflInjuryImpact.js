// nflInjuryImpact.js
// Lyrid NFL engine — quantifying an injured lineup (Layer 11).
//
// nflInactives.js DETECTS who's out. This module says HOW MUCH IT MOVES THE NEEDLE.
//
// ── OFFENSIVE SIDE: measured, real, significant ──────────────────────────────
// Tested on nflverse 2024 (51 teammate observations where a team's top target
// missed games he otherwise played):
//     mean target share:  +4.2pp
//     mean receiving yds: +6.2   (median +4.4)
//     teammates who gained: 60.8%
//     t=2.39, p=0.021  -> REAL effect (contrast: revenge game p=0.54, nothing)
// The effect is HETEROGENEOUS — the mean is +6.2 but individual absorbers ran far
// higher (Slayton 10.7%->33.0% target share, 28->89 yds when NYG's WR1 sat). So we
// scale by ROLE PROXIMITY: the teammate closest in role to the absent player
// absorbs most of the vacated share, not everyone equally.
//
// ── DEFENSIVE SIDE: detected, NOT quantified ────────────────────────────────
// Same test on defenses missing their top CB: only 6 teams had a usable split,
// mean -0.4 yds, p=0.97. That is NOT evidence that CB injuries don't matter — it's
// too small a sample, and team-total WR yards is too crude to isolate an individual
// matchup. So the defensive side FLAGS and widens uncertainty; it does not invent a
// magnitude. Upgrade only if a bigger sample or per-matchup data proves one.

const OFF = {
  MEAN_TS_GAIN: 0.042,     // +4.2pp target share, league mean
  MEAN_YDS_GAIN: 6.2,      // +6.2 receiving yards, league mean
  GAIN_RATE: 0.608,        // 60.8% of teammates gained
  P: 0.021,
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Role proximity 0..1 — how much of the absent player's role this player absorbs.
// Same position + similar alignment + next man on the depth chart = high.
function roleProximity({ player, absent }) {
  if (!player || !absent) return 0.4;                     // unknown -> league-average share
  let p = 0;
  if (player.position === absent.position) p += 0.5;
  else if (['WR', 'TE'].includes(player.position) && ['WR', 'TE'].includes(absent.position)) p += 0.25;
  // alignment overlap (slot vs outside)
  if (player.slotRate != null && absent.slotRate != null) {
    p += 0.3 * (1 - Math.abs(player.slotRate - absent.slotRate));
  } else p += 0.15;
  // depth-chart adjacency
  if (player.depth != null && absent.depth != null && Math.abs(player.depth - absent.depth) === 1) p += 0.2;
  return clamp(p, 0, 1);
}

// ---------------------------------------------------------------------------
// OFFENSIVE: teammate(s) out -> quantified boost for THIS player
// ---------------------------------------------------------------------------
// player:   { position, slotRate, depth, baselineTargetShare, baselineYards }
// absentTeammates: [{ name, position, slotRate, depth, targetShare }]
export function offensiveRedistribution({ player, absentTeammates }) {
  const out = { nudge: 0, projectedYardsDelta: 0, projectedTsDelta: 0, absorbers: [], reasons: [] };
  const outs = (absentTeammates || []).filter(Boolean);
  if (!outs.length) return out;

  let tsDelta = 0, ydsDelta = 0;
  for (const a of outs) {
    const prox = roleProximity({ player, absent: a });
    // vacated share: use the absent player's actual target share when known,
    // else fall back to the measured league-average redistribution.
    const vacated = a.targetShare != null ? a.targetShare : OFF.MEAN_TS_GAIN / 0.6;
    // CALIBRATION: the measured +4.2pp is the mean across ALL teammates, most of whom
    // absorb little. The nearest-role absorber should land above that mean but well
    // short of the extreme tail (Slayton's +22pp). 0.30 puts a direct same-role
    // replacement near +7-8pp and a distant-role teammate near +2pp, which brackets
    // the observed distribution. Tune on backtest before tier labels ship.
    const absorbedTs = vacated * prox * 0.30;
    tsDelta += absorbedTs;
    // yards scale with the player's own efficiency if we have it, else league rate
    const perTs = player?.baselineYards && player?.baselineTargetShare
      ? player.baselineYards / player.baselineTargetShare
      : (OFF.MEAN_YDS_GAIN / OFF.MEAN_TS_GAIN);
    ydsDelta += absorbedTs * perTs;
    out.absorbers.push({ absent: a.name, proximity: +prox.toFixed(2), absorbedTargetShare: +absorbedTs.toFixed(3) });
  }

  out.projectedTsDelta = +tsDelta.toFixed(3);
  out.projectedYardsDelta = +ydsDelta.toFixed(1);
  // convert to a z-nudge (typical WR game sd ~ 30 yards)
  // cap at 0.30 so the nudge still DISCRIMINATES between a direct replacement and a
  // distant-role teammate instead of railing for both.
  out.nudge = +clamp(ydsDelta / 45, -0.15, 0.30).toFixed(4);

  const names = outs.map(a => a.name).filter(Boolean).join(', ');
  out.reasons.push(
    `${names || 'A teammate'} out — projected +${out.projectedYardsDelta} yds ` +
    `(+${(out.projectedTsDelta * 100).toFixed(1)}pp target share) absorbed by role proximity. ` +
    `League baseline when a top target sits: +${(OFF.MEAN_TS_GAIN * 100).toFixed(1)}pp / +${OFF.MEAN_YDS_GAIN} yds, ` +
    `${Math.round(OFF.GAIN_RATE * 100)}% of teammates gain (p=${OFF.P}).`
  );
  return out;
}

// ---------------------------------------------------------------------------
// DEFENSIVE: opponent injuries -> flag + widened uncertainty, NO fake magnitude
// ---------------------------------------------------------------------------
// absentDefenders: [{ name, position, role }]  role e.g. 'CB1','slot CB','EDGE1'
export function defensiveInjuryImpact({ absentDefenders, propFamily }) {
  const outs = (absentDefenders || []).filter(Boolean);
  const out = { nudge: 0, uncertainty: 0, flags: [], reasons: [], quantified: false };
  if (!outs.length) return out;

  for (const d of outs) {
    const pos = String(d.position || '').toUpperCase();
    const role = String(d.role || '').toLowerCase();
    const isCoverage = pos === 'CB' || pos === 'S' || role.includes('cb') || role.includes('slot');
    const isRush = pos === 'EDGE' || pos === 'DE' || pos === 'DT' || role.includes('edge');

    if (isCoverage && (propFamily === 'receiving_yards' || propFamily === 'passing_yards')) {
      out.flags.push({ key: 'coverage_out', severity: 'moderate',
        text: `${d.name || 'A coverage defender'} (${d.role || pos}) is out — the coverage read this projection assumed no longer holds.` });
      out.reasons.push(`${d.name || 'Coverage defender'} out: matchup read is stale. Direction favors the offense, but the magnitude is NOT quantified — a league-level test (n=6 defenses, p=0.97) was too small to establish one.`);
      out.uncertainty += 0.15;
    }
    if (isRush && (propFamily === 'passing_yards' || propFamily === 'pass_rush_yards')) {
      out.flags.push({ key: 'pass_rush_out', severity: 'moderate',
        text: `${d.name || 'A pass rusher'} out — expect less pressure, cleaner pocket.` });
      out.reasons.push(`${d.name || 'Pass rusher'} out: pressure-based suppression in this projection is likely overstated.`);
      out.uncertainty += 0.12;
    }
  }
  out.uncertainty = +clamp(out.uncertainty, 0, 0.4).toFixed(3);
  // deliberately NO nudge — direction is known, magnitude is not.
  return out;
}

// Combined helper for the orchestrator.
export function injuryImpact({ player, absentTeammates, absentDefenders, propFamily }) {
  const off = offensiveRedistribution({ player, absentTeammates });
  const def = defensiveInjuryImpact({ absentDefenders, propFamily });
  return {
    nudge: +(off.nudge).toFixed(4),          // only the MEASURED side moves the number
    uncertainty: def.uncertainty,            // the unmeasured side widens the band
    offense: off, defense: def,
    reasons: [...off.reasons, ...def.reasons],
    flags: def.flags,
  };
}

export { OFF as OFFENSIVE_REDISTRIBUTION_FINDING };
