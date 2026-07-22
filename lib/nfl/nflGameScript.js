// nflGameScript.js
// Lyrid NFL engine — game-script risk (the Russell Wilson filter).
//
// The biggest visible loss pattern was passing-yards OVERs in games that turned
// into blowouts (Russell Wilson 226.5 in a 29-10 PIT loss to 14-1 KC). Blowouts
// hurt a trailing QB more often than garbage time helps. But a big spread means
// OPPOSITE things for different archetypes:
//   - trailing-team passing OVER  -> RISK (efficiency craters, may get benched)
//   - favored-team RB rushing OVER -> HELP (clock-killing carries)
//   - underdog RB rushing OVER     -> RISK (run gets abandoned)  [Jonathan Taylor]
//   - low game total               -> suppresses ALL yardage overs
// So the flag is archetype- and side-aware, never a blanket spread filter.
//
// Inputs:
//   spread: signed for THIS player's team (negative = favored, positive = underdog)
//   gameTotal: Vegas total
//   propFamily, archetype (from volumeSecurity)
//   pick: 'higher' | 'lower' (risk is direction-dependent)
// Output: risk score 0-1 (higher = more script risk to THIS pick) + a boolean flag.

const BLOWOUT_SPREAD = 9;     // |spread| >= 9 starts meaningful blowout probability
const HEAVY_SPREAD = 13;      // >= 13 is strong
const LOW_TOTAL = 40;         // totals below this depress yardage overs

// crude blowout probability from spread magnitude (calibrate on backtest later)
function blowoutProb(absSpread) {
  if (absSpread <= 4) return 0.10;
  if (absSpread <= 7) return 0.22;
  if (absSpread <= 10) return 0.40;
  if (absSpread <= 13) return 0.58;
  return 0.72;
}

export function gameScriptRisk({ spread, gameTotal, propFamily, archetype, pick }) {
  const absSpread = Math.abs(spread ?? 0);
  const favored = (spread ?? 0) < 0;      // negative spread = favored
  const underdog = (spread ?? 0) > 0;
  const bp = blowoutProb(absSpread);
  let risk = 0;
  const reasons = [];

  // Direction matters: script risk mainly threatens HIGHER (over) picks.
  const isOver = pick === 'higher';

  if (propFamily === 'passing_yards' || propFamily === 'receiving_yards') {
    // Trailing-team passers: garbage-time volume up but efficiency down; net risk to OVER.
    if (underdog && isOver && absSpread >= BLOWOUT_SPREAD) {
      risk += bp * 0.8;
      reasons.push(`underdog passing OVER in blowout-risk game (spread +${absSpread})`);
    }
    // Favored blowout: winning team may sit starters late -> mild risk to passing OVER.
    if (favored && isOver && absSpread >= HEAVY_SPREAD) {
      risk += bp * 0.4;
      reasons.push(`favored passing OVER, starters may rest late (spread -${absSpread})`);
    }
    // Low total suppresses passing overs regardless of side.
    if (isOver && gameTotal != null && gameTotal < LOW_TOTAL) {
      risk += 0.20;
      reasons.push(`low total (${gameTotal}) suppresses passing volume`);
    }
  }

  if (propFamily === 'rushing_yards') {
    // Underdog RB rushing OVER: run gets abandoned when trailing -> the Jonathan Taylor loss.
    if (underdog && isOver && absSpread >= BLOWOUT_SPREAD) {
      risk += bp * 0.9;
      reasons.push(`underdog RB rushing OVER — run abandonment risk (spread +${absSpread})`);
    }
    // Committee back amplifies abandonment risk.
    if (underdog && isOver && archetype === 'committee') {
      risk += 0.15;
      reasons.push('committee back magnifies abandonment risk');
    }
    // Favored bellcow rushing OVER actually gets game-script HELP -> negative risk (cap at 0).
    if (favored && isOver && archetype === 'bellcow' && absSpread >= BLOWOUT_SPREAD) {
      risk -= bp * 0.5;
      reasons.push('favored bellcow gets clock-killing carries (script tailwind)');
    }
  }

  if (propFamily === 'rush_rec_yards') {
    // Pass-catching backs are game-script HEDGED (gain receptions when trailing).
    if (archetype === 'pass_catching_back') {
      risk += bp * 0.2; // low
      reasons.push('pass-catching back is script-hedged');
    } else if (underdog && isOver && absSpread >= BLOWOUT_SPREAD) {
      risk += bp * 0.6;
      reasons.push(`underdog RB combo OVER in blowout-risk game`);
    }
  }

  risk = Math.max(0, Math.min(1, +risk.toFixed(3)));
  return {
    risk,
    // PROVISIONAL threshold 0.30 — set so the documented Russell Wilson loss (0.32)
    // trips the flag. MUST be recalibrated on the DK backtest before tier labels ship
    // (per Lyrid rule: no untuned calibrations in production). Ranking is trustworthy;
    // the absolute cutoff is a placeholder.
    flag: risk >= 0.30,
    blowoutProb: +bp.toFixed(2),
    side: favored ? 'favored' : (underdog ? 'underdog' : 'pickem'),
    reasons,
  };
}

export { BLOWOUT_SPREAD, HEAVY_SPREAD, LOW_TOTAL };
