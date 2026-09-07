// api/_lib/nba/opponentAdjust.js
//
// Modest, capped opponent-defense adjustment applied to a player's shot profile
// BEFORE projection. Team-level defense is a blunt instrument (it can't see who guards
// whom — that's walled tracking), and the WNBA finding was that the opponent effect is
// real but mechanism-less, so it's SOFTENED to a mild prior here, never a big swing:
//   efficiency  (2P%/3P%)  <- opponent FG% allowed vs league   (FT% untouched — uncontested)
//   volume      (attempts) <- opponent pace vs league          (faster game = more shots)
//   rebound env (reb/min)  <- opponent 3PA rate vs league       (more 3s = more long misses)
// All multipliers are capped; all constants are TUNE placeholders in leagueConfig.opponent.

export function adjustProfile(profile, matchup, cfg) {
  if (!profile || !matchup || !cfg?.opponent) return profile;
  const o = cfg.opponent;
  const capMult = (x, cap) => Math.max(1 - cap, Math.min(1 + cap, x));

  let effMult = 1, volMult = 1, rebMult = 1, blockMult = 1, stealMult = 1;
  if (matchup.oppFgPct != null) effMult = capMult(1 + o.effCoef * (matchup.oppFgPct - o.leagueOppFgPct), o.effCap);
  if (matchup.pace != null) volMult = capMult(1 + o.paceCoef * ((matchup.pace - o.leaguePace) / o.leaguePace), o.paceCap);
  if (matchup.oppFg3aRate != null) rebMult = capMult(1 + o.rebEnvCoef * (matchup.oppFg3aRate - o.leagueOppFg3aRate), o.rebEnvCap);
  // defensive activity: more blocks -> lower rim scoring; more steals -> fewer assists
  if (matchup.blocksPerG != null) blockMult = capMult(1 - o.blockCoef * ((matchup.blocksPerG - o.leagueBlocksPerG) / o.leagueBlocksPerG), o.blockCap);
  if (matchup.stealsPerG != null) stealMult = capMult(1 - o.stealCoef * ((matchup.stealsPerG - o.leagueStealsPerG) / o.leagueStealsPerG), o.stealCap);

  const mul = (v, m) => (v != null ? v * m : v);
  return {
    ...profile,
    twoPaPerMin: mul(profile.twoPaPerMin, volMult),
    threePaPerMin: mul(profile.threePaPerMin, volMult),
    ftaPerMin: mul(profile.ftaPerMin, volMult),
    twoPct: profile.twoPct != null ? Math.min(0.99, profile.twoPct * effMult * blockMult) : profile.twoPct,
    threePct: profile.threePct != null ? Math.min(0.99, profile.threePct * effMult) : profile.threePct,
    // ftPct unchanged — free throws are uncontested by defense
    rebPerMin: mul(profile.rebPerMin, rebMult),
    astPerMin: mul(profile.astPerMin, stealMult),   // ball pressure disrupts playmaking
    _oppAdj: { effMult: +effMult.toFixed(3), volMult: +volMult.toFixed(3), rebMult: +rebMult.toFixed(3), blockMult: +blockMult.toFixed(3), stealMult: +stealMult.toFixed(3) },
  };
}

export default { adjustProfile };
