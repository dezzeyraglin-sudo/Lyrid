// nflSchemeMatchup.js
// Lyrid NFL engine — archetype-vs-scheme matchup edge (Layer 5c-ii).
//
// This is the REAL "player has an advantage vs this team" signal — structural and
// repeatable — as opposed to the noisy raw player-vs-opponent history (which is
// separately capped low in nflPlayerVsOpponent.js).
//
// The research basis:
//   - Beating MAN coverage is a more STABLE player skill (r~0.72 yoy) than beating
//     zone (r~0.42). So a WR with a strong vs-man separation profile facing a
//     man-heavy defense is a durable edge.
//   - Man-heavy defenses blitz far more; mobile QBs gain rushing room vs man/blitz.
//   - Heavy-box defenses suppress rushing yards (league avg ~3.5-3.7 YPC vs 8+ box).
//   - Zone-heavy defenses give up more underneath volume to possession/slot WRs.
//
// Inputs:
//   defScheme: { man_rate, zone_rate, blitz_rate, heavy_box_rate, pressure_rate } (opponent, prior season)
//   playerProfile: {
//     archetype,                 // from volumeSecurity
//     vsMan: { sepAdvantage },   // player's separation vs man relative to baseline (nullable)
//     vsZone:{ sepAdvantage },
//     isMobileQB,                // for passing/rushing QB props
//   }
//   propFamily
// Output: additive z-nudge (scheme edge), capped, with reason.

const CAP = 0.35;

function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }

// League baselines for comparing an opponent's scheme rate (so "man-heavy" is
// relative to league, not absolute). Tunable; derived from 2024 aggregates.
const LG = { man_rate: 0.48, zone_rate: 0.52, blitz_rate: 0.14, heavy_box_rate: 0.06, pressure_rate: 0.16 };

export function schemeMatchupNudge({ defScheme, playerProfile, propFamily }) {
  if (!defScheme) return { nudge: 0, reason: 'no scheme data (prior-season prior unavailable)' };
  const p = playerProfile || {};
  const reasons = [];
  let nudge = 0;

  const manLean = (defScheme.man_rate ?? LG.man_rate) - LG.man_rate;   // >0 = more man than league
  const zoneLean = -manLean;
  const boxLean = (defScheme.heavy_box_rate ?? LG.heavy_box_rate) - LG.heavy_box_rate;
  const blitzLean = (defScheme.blitz_rate ?? LG.blitz_rate) - LG.blitz_rate;

  if (propFamily === 'receiving_yards') {
    // WR who separates vs man, facing man-heavy D -> edge (and vice versa)
    const vsManAdv = p.vsMan?.sepAdvantage ?? 0;   // >0 = separates better than own baseline vs man
    const vsZoneAdv = p.vsZone?.sepAdvantage ?? 0;
    // weight vs-man edge by how man-heavy the opponent is (and it's the more stable skill)
    nudge += vsManAdv * manLean * 3.0;             // both z-ish; scaled
    nudge += vsZoneAdv * zoneLean * 1.6;           // zone edge less stable -> lower weight
    if (Math.abs(manLean) > 0.05 && vsManAdv !== 0)
      reasons.push(`vs-man sep edge (${vsManAdv.toFixed(2)}) x opp man-lean (${manLean.toFixed(2)})`);
    // possession/slot WRs feast on zone-heavy defenses (underneath volume)
    if (p.archetype === 'volume_possession' && zoneLean > 0.05) {
      nudge += 0.10;
      reasons.push('possession WR vs zone-heavy defense (underneath volume)');
    }
  }

  if (propFamily === 'passing_yards') {
    // vs blitz-heavy D: more risk but mobile/quick-game QBs can exploit; keep modest
    if (blitzLean > 0.03) {
      nudge -= 0.08; // blitz pressure slightly suppresses passing yards on average
      reasons.push('opponent blitzes above league rate (mild passing suppression)');
    }
  }

  if (propFamily === 'rushing_yards') {
    // heavy-box D suppresses RB rushing; light-box inflates
    nudge -= boxLean * 4.0;  // box rates are small numbers; scale up
    if (Math.abs(boxLean) > 0.01)
      reasons.push(`opponent heavy-box lean (${boxLean.toFixed(3)}) ${boxLean>0?'suppresses':'aids'} rushing`);
    // mobile QB rushing gains vs man/blitz
    if (p.isMobileQB && (manLean > 0.05 || blitzLean > 0.03)) {
      nudge += 0.15;
      reasons.push('mobile QB rushing vs man/blitz-heavy defense');
    }
  }

  if (propFamily === 'rush_rec_yards') {
    // blend: half rushing box effect, plus pass-catching backs beat blitz (checkdowns)
    nudge -= boxLean * 2.0;
    if (p.archetype === 'pass_catching_back' && blitzLean > 0.03) {
      nudge += 0.10;
      reasons.push('pass-catching back exploits blitz (checkdown volume)');
    }
  }

  nudge = +clamp(nudge, -CAP, CAP).toFixed(4);
  return { nudge, reason: reasons.join('; ') || 'neutral scheme matchup' };
}

export { CAP as SCHEME_CAP, LG as LEAGUE_SCHEME_BASELINES };
