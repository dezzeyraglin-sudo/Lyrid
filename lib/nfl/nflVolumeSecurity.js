// nflVolumeSecurity.js
// Lyrid NFL engine — volume-security scoring.
//
// This is the filter that separated the winning slips (Lamar, Amon-Ra, Garrett
// Wilson — stable high-volume roles) from the losses (Jonathan Taylor committee
// game, Mike Williams 0 catches). "Volume-secure" = the player's opportunity is
// structurally stable across game scripts, so a yardage OVER has a real floor.
//
// Core idea: score the INVERSE of volatility, weighted by the LEVEL, over a
// trailing window of COMPETITIVE games (garbage-time games excluded so we measure
// role stability, not game-script noise).
//
// Outputs a 0-1 volume_floor_score per prop family plus the archetype tag.

// ---- helpers ----
function mean(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function std(a){
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1));
}
function cv(a){ const m = mean(a); return m > 0 ? std(a)/m : 1; } // coefficient of variation

// Map a trailing window of competitive games -> volume-security score for a family.
// games: [{ targets, target_share, air_yards_share, rush_attempts, pass_attempts,
//           routes, team_pass_plays, snap_share, was_garbage_time }]
// propFamily: passing_yards | rushing_yards | receiving_yards | rush_rec_yards
export function volumeSecurity({ games, propFamily }) {
  const competitive = (games || []).filter(g => !g.was_garbage_time);
  const n = competitive.length;
  const out = {
    n,
    volume_floor_score: 0,
    archetype: 'unknown',
    detail: {},
  };
  if (n < 3) { out.detail.reason = `thin sample (${n}<3)`; return out; }

  if (propFamily === 'passing_yards' || propFamily === 'pass_rush_yards') {
    // pass_rush_yards (QB combo) is driven by the SAME passing volume — route it through
    // here instead of letting it fall to 0, which silently killed every QB combo prop.
    const att = competitive.map(g => g.pass_attempts).filter(v => v != null);
    const attMean = mean(att), attCv = cv(att);
    // QB volume floor is LEVEL-dominant: a starter accumulates passing yards even when his
    // attempt count swings with game script, so attempt VARIANCE must not sink a real
    // starter the way it (correctly) sinks a committee back. Level-weighted, gentle CV.
    const level = Math.min(1, attMean / 34);            // ~34 att = a clear full-time starter
    const stability = Math.max(0, 1 - attCv * 1.6);     // CV 0.25 -> 0.60 (game-script swings tolerated)
    out.volume_floor_score = +(0.65 * level + 0.35 * stability).toFixed(3);
    out.archetype = attMean >= 33 ? 'high_volume_passer' : (attMean >= 24 ? 'mid_volume_passer' : 'low_volume_passer');
    out.detail = { attMean: +attMean.toFixed(1), attCv: +attCv.toFixed(3) };
    return out;
  }

  if (propFamily === 'receiving_yards') {
    const ts = competitive.map(g => g.target_share).filter(v => v != null);
    const ays = competitive.map(g => g.air_yards_share).filter(v => v != null);
    const routes = competitive.map(g => (g.routes!=null && g.team_pass_plays) ? g.routes/g.team_pass_plays : null).filter(v => v != null);
    const tsMean = mean(ts), tsCv = cv(ts);
    const routeMean = routes.length ? mean(routes) : null;
    // WR/TE floor: high & stable target share + high route participation.
    const level = Math.min(1, tsMean / 0.26);           // 26% target share ~ ceiling
    const stability = Math.max(0, 1 - tsCv * 1.8);
    const routeBonus = routeMean != null ? Math.min(0.15, (routeMean - 0.75) * 0.6) : 0; // 90% routes -> +0.09
    let score = 0.5 * level + 0.4 * stability + Math.max(0, routeBonus);
    score = Math.min(1, score);
    out.volume_floor_score = +score.toFixed(3);
    // archetype: possession (high TS, low aDOT proxy) vs field-stretcher (high air-yards share, lower TS)
    const aysMean = mean(ays);
    if (tsMean >= 0.20 && (routeMean == null || routeMean >= 0.8)) out.archetype = 'volume_possession';
    else if (aysMean >= 0.30 && tsMean < 0.18) out.archetype = 'boom_bust_field_stretcher';
    else out.archetype = 'rotational';
    out.detail = { tsMean:+tsMean.toFixed(3), tsCv:+tsCv.toFixed(3), routeMean: routeMean!=null?+routeMean.toFixed(3):null };
    return out;
  }

  if (propFamily === 'rushing_yards' || propFamily === 'rush_rec_yards') {
    const carries = competitive.map(g => g.rush_attempts).filter(v => v != null);
    const tgts = competitive.map(g => g.targets).filter(v => v != null);
    const carryMean = mean(carries), carryCv = cv(carries);
    const level = Math.min(1, carryMean / 18);          // 18 carries ~ bellcow ceiling
    const stability = Math.max(0, 1 - carryCv * 1.6);
    // pass-catching involvement stabilizes rush_rec_yards across game scripts
    const passCatch = mean(tgts);
    const pcBonus = propFamily === 'rush_rec_yards' ? Math.min(0.15, passCatch * 0.03) : 0;
    let score = 0.5 * level + 0.4 * stability + pcBonus;
    score = Math.min(1, score);
    out.volume_floor_score = +score.toFixed(3);
    // archetype: bellcow vs committee vs pass-catching back
    if (carryMean >= 15 && carryCv < 0.35) out.archetype = 'bellcow';
    else if (passCatch >= 4) out.archetype = 'pass_catching_back';
    else out.archetype = 'committee';
    out.detail = { carryMean:+carryMean.toFixed(1), carryCv:+carryCv.toFixed(3), tgtMean:+passCatch.toFixed(1) };
    return out;
  }

  out.detail.reason = 'unknown prop family';
  return out;
}
