// api/_lib/nba/schemeRisk.js
//
// High-floor checklist / scheme-risk guard — enhanced for the "worked props" profile.
// Runs after form-floor + cadence inside nbaVerdict.decide().
//
// Goals:
//   1. Prefer high-volume + low foul-trouble plays (the style that cashed)
//   2. Force PASS or flip to UNDER on props that fail the high-floor stress tests
//   3. Identify which component is most likely to underperform (for combos)
//   4. Attach clear human-readable risk explanations for every candidate
//   5. Stricter PTS path (return risk, H2H cushion, compound risk) so PTS is not
//      treated as interchangeable with high-floor REB until it clears hard filters
//
// Thresholds are tunable via leagueConfig.NBA.schemeRisk (or defaults below).

const DEFAULTS = {
  // Foul trouble
  foulRateHigh: 3.8,
  foulRateVeryHigh: 4.6,
  foulPenalty: 14,
  foulVeryHighPenalty: 22,

  // Minutes / volume floor
  minProjMinutes: 28,
  minutesHaircutThreshold: 0.88,
  minutesRiskPenalty: 18,
  roleUncertainPenalty: 12,

  // High-volume preference (boosts)
  highUsgThreshold: 26,
  highRebRateThreshold: 12,
  volumeBoost: 10,

  // Secondary competition (rebounds)
  secondaryCompetitionPenalty: 12,

  // Pure points protection
  purePointsHostilePenalty: 12,
  lowPaceTotal: 218,
  blowoutSpread: 9.5,

  // Decision thresholds
  forcedPassScore: 28,
  underAdviseScore: 35,
  highFloorScore: 68,

  // ----- PTS-specific hard filters (post 2026-11-27 lessons) -----
  // Return-from-absence: miss this many games → require N fully active games back
  returnMissGames: 3,
  returnActiveGamesRequired: 2,
  returnRiskPenalty: 20,

  // H2H cushion: career (or sample) PPG must clear line by this amount for highFloorPts
  h2hCushionPts: 1.5,
  h2hThinPenalty: 14,
  h2hSampleMin: 5,

  // Compound risk: how many stacked PTS risk flags before we refuse highFloorPts
  ptsCompoundHardLimit: 2,

  // Elite defense proxy (opp points allowed rank or adjustment)
  eliteDefPtsAdj: -1.5,
  eliteDefPenalty: 10,
};

function getCfg(ctx = {}) {
  const fromLeague = (ctx.leagueConfig && ctx.leagueConfig.schemeRisk) || {};
  return { ...DEFAULTS, ...fromLeague };
}

function getFoulRate(mp) {
  const recent = mp.recentForm?.pf ?? mp.recent?.pf ?? null;
  if (recent != null && !Number.isNaN(recent)) return recent;

  const season = mp.profile?.pf ?? mp.advanced?.pf ?? mp.stats?.pf ?? null;
  if (season != null) return season;

  const pf36 = mp.profile?.pfPer36 ?? mp.advanced?.pfPer36 ?? null;
  const min = mp.projMinutes ?? mp.minutes?.mean ?? 30;
  if (pf36 != null) return (pf36 / 36) * min;

  return null;
}

function getUsg(mp) {
  return mp.advanced?.usg ?? mp.profile?.usg ?? mp.usg ?? mp.usage ?? null;
}

function getRebRate(mp) {
  return mp.advanced?.trbPct ?? mp.advanced?.rebPct ?? mp.profile?.trbPct ??
    mp.rebRate ?? null;
}

/**
 * Detect return-from-absence risk.
 * Looks at injury history / gamesMissed / consecutiveActive if present on mp.
 */
function getReturnRisk(mp, cfg) {
  const gamesMissed =
    mp.gamesMissedRecent ??
    mp.injury?.gamesMissed ??
    mp.availability?.gamesMissed ??
    mp.flags?.gamesMissed ??
    null;

  const consecutiveActive =
    mp.consecutiveActive ??
    mp.availability?.consecutiveActive ??
    mp.flags?.consecutiveActive ??
    null;

  // Explicit "just returned" flag from upstream
  if (mp.flags?.justReturned || mp.availability?.justReturned) {
    return {
      atRisk: true,
      gamesMissed: gamesMissed ?? cfg.returnMissGames,
      consecutiveActive: consecutiveActive ?? 0,
      reason: 'just returned from absence — minutes/role may be managed',
    };
  }

  if (gamesMissed != null && gamesMissed >= cfg.returnMissGames) {
    const active = consecutiveActive ?? 0;
    if (active < cfg.returnActiveGamesRequired) {
      return {
        atRisk: true,
        gamesMissed,
        consecutiveActive: active,
        reason: `return risk — missed ${gamesMissed} games, only ${active} fully active since`,
      };
    }
  }

  // Soft signal: injuryStatus was recently non-null and player is listed available
  const status = (mp.injuryStatus || mp.injury?.status || '').toLowerCase();
  if (status && !['out', 'doubtful', 'questionable'].includes(status) && mp.flags?.recentlyInjured) {
    return {
      atRisk: true,
      gamesMissed: gamesMissed ?? cfg.returnMissGames,
      consecutiveActive: consecutiveActive ?? 0,
      reason: 'recently injured / load-management risk on return',
    };
  }

  return { atRisk: false, gamesMissed: gamesMissed ?? 0, consecutiveActive: consecutiveActive ?? 99, reason: null };
}

/**
 * H2H cushion vs the posted line (points only).
 * Expects mp.h2h or mp.vsOpponent with { ppg, games } or similar.
 */
function getH2hCushion(mp, line, cfg) {
  const h2h = mp.h2h || mp.vsOpponent || mp.careerVsOpp || null;
  if (!h2h) return { available: false, ppg: null, games: 0, cushion: null, thin: false };

  const ppg = h2h.ppg ?? h2h.pts ?? h2h.points ?? null;
  const games = h2h.games ?? h2h.gp ?? h2h.g ?? 0;

  if (ppg == null || games < cfg.h2hSampleMin) {
    return { available: false, ppg, games, cushion: null, thin: false };
  }

  const cushion = ppg - line;
  const thin = cushion < cfg.h2hCushionPts;
  return { available: true, ppg, games, cushion, thin };
}

function hasSecondaryCompetition(mp, market) {
  if (market !== 'rebounds' && market !== 'pts_rebs' && market !== 'pra' && market !== 'rebs_asts') return false;
  if (mp.flags?.secondaryRebCompetition || mp.rebCompetition) return true;

  const teammates = mp.teammates || mp.rosterMates || [];
  const highRebTeammates = teammates.filter(t => (t.rpg >= 6 || t.trbPct >= 10) && t.id !== mp.id);
  if (highRebTeammates.length >= 1 && (getRebRate(mp) == null || getRebRate(mp) < 14)) return true;

  return false;
}

function weakestComponent(mp, market, flags) {
  if (!['pra', 'pts_rebs', 'pts_asts', 'rebs_asts'].includes(market)) {
    return market;
  }

  const risks = [];
  if (flags.minutesRisk || flags.foulTrouble) risks.push({ stat: 'minutes-driven counting stats', weight: 3 });
  if (flags.returnRisk) risks.push({ stat: 'points (return / minutes management)', weight: 3 });
  if (flags.h2hThin) risks.push({ stat: 'points (H2H at/under line)', weight: 2 });
  if (flags.schemeHostile && (market.includes('pts') || market === 'pra')) risks.push({ stat: 'points', weight: 2 });
  if (flags.secondaryCompetition || (flags.schemeHostile && market.includes('reb'))) risks.push({ stat: 'rebounds', weight: 2 });
  if (flags.scriptDependent) risks.push({ stat: 'points', weight: 1 });

  const usg = getUsg(mp);
  const ts = mp.advanced?.ts ?? mp.profile?.ts ?? null;
  if (usg != null && usg < 22 && (market.includes('pts') || market === 'pra')) {
    risks.push({ stat: 'points (low usage)', weight: 2 });
  }
  if (ts != null && ts < 0.54 && (market.includes('pts') || market === 'pra')) {
    risks.push({ stat: 'points (efficiency)', weight: 1 });
  }

  if (risks.length === 0) return 'overall volume';
  risks.sort((a, b) => b.weight - a.weight);
  return risks[0].stat;
}

/**
 * @param {object} mp
 * @param {string} market
 * @param {number} line
 * @param {object} rec
 * @param {object} ctx
 * @returns {object}
 */
export function applySchemeRisk(mp, market, line, rec, ctx = {}) {
  const cfg = getCfg(ctx);
  const flags = {
    purePointsRisk: false,
    schemeHostile: false,
    minutesRisk: false,
    foulTrouble: false,
    scriptDependent: false,
    compoundingUnder: false,
    openingNightDiscount: false,
    forcedPass: false,
    underBoosted: false,
    secondaryCompetition: false,
    highVolumePreferred: false,
    adviseUnder: false,
    // new PTS-specific
    returnRisk: false,
    h2hThin: false,
    eliteDefense: false,
    highFloorPtsBlocked: false,
  };
  const reasons = [];
  let score = 50;
  let newRec = { ...rec };

  const isPurePoints = market === 'points';
  const isCombo = ['pra', 'pts_rebs', 'pts_asts', 'rebs_asts'].includes(market);
  const isCounting = market === 'rebounds' || market === 'assists';
  const isRebMarket = market === 'rebounds' || market === 'pts_rebs' || market === 'pra' || market === 'rebs_asts';

  // 1. Minutes / foul / role risk
  const mf = mp.minutes?.flags || {};
  const projMin = mp.projMinutes ?? mp.minutes?.mean ?? null;
  const profileMin = mp.shotProfile?.minutes?.mean ?? mp.profile?.minutes?.mean ?? null;
  const minutesHaircut = (projMin != null && profileMin != null && profileMin > 0)
    ? (projMin / profileMin) : 1;

  if (mf.reducedMinutes || mf.designation || mf.b2b || minutesHaircut < cfg.minutesHaircutThreshold) {
    flags.minutesRisk = true;
    score -= cfg.minutesRiskPenalty;
    reasons.push('minutes risk (foul / designation / B2B / projected cut)');
  }
  if (projMin != null && projMin < cfg.minProjMinutes && (mp.starter || projMin > 18)) {
    flags.minutesRisk = true;
    score -= 10;
    reasons.push(`projected minutes floor low (${typeof projMin === 'number' ? projMin.toFixed(1) : projMin})`);
  }
  if (mf.roleUncertain || mp.flags?.roleUncertain) {
    flags.minutesRisk = true;
    score -= cfg.roleUncertainPenalty;
    reasons.push('role uncertain');
  }

  const foulRate = getFoulRate(mp);
  if (foulRate != null) {
    if (foulRate >= cfg.foulRateVeryHigh) {
      flags.foulTrouble = true;
      flags.minutesRisk = true;
      score -= cfg.foulVeryHighPenalty;
      reasons.push(`elevated foul rate (${foulRate.toFixed(1)} PF) — early exit / minutes risk`);
    } else if (foulRate >= cfg.foulRateHigh) {
      flags.foulTrouble = true;
      score -= cfg.foulPenalty;
      reasons.push(`above-average foul rate (${foulRate.toFixed(1)} PF) — foul trouble watch`);
    }
  }

  // 1b. Return-from-absence (PTS hard filter)
  const returnInfo = getReturnRisk(mp, cfg);
  if (returnInfo.atRisk) {
    flags.returnRisk = true;
    flags.minutesRisk = true;
    score -= cfg.returnRiskPenalty;
    reasons.push(returnInfo.reason);
  }

  // 2. Scheme / matchup hostility
  const oppAdj = mp.oppAdj || ctx.oppAdj || {};
  const archetype = mp.archetype || {};

  const oppPenalty = (oppAdj.pointsAdj ?? oppAdj.pts ?? 0);
  if (isPurePoints && oppPenalty < -1.2) {
    flags.schemeHostile = true;
    score -= 15;
    reasons.push('opponent defensive adjustment hostile to scoring');
  }
  if (isPurePoints && oppPenalty <= cfg.eliteDefPtsAdj) {
    flags.eliteDefense = true;
    score -= cfg.eliteDefPenalty;
    reasons.push('elite defense vs scoring (heavy points suppression)');
  }
  if ((market === 'assists' || market === 'pts_asts') && (oppAdj.astAdj ?? 0) < -0.6) {
    flags.schemeHostile = true;
    score -= 12;
    reasons.push('opponent limits assist opportunities');
  }
  if (isRebMarket && (oppAdj.rebAdj ?? 0) < -0.8) {
    flags.schemeHostile = true;
    score -= 10;
    reasons.push('opponent rebounding environment tough');
  }

  if (archetype.signalHint && /switch|pack|paint|length|physical/i.test(archetype.signalHint)) {
    flags.schemeHostile = true;
    score -= 8;
    reasons.push('matchup archetype: ' + archetype.signalHint);
  }

  // 2b. H2H cushion (PTS)
  if (isPurePoints && line != null) {
    const h2h = getH2hCushion(mp, line, cfg);
    if (h2h.available && h2h.thin) {
      flags.h2hThin = true;
      score -= cfg.h2hThinPenalty;
      reasons.push(
        `H2H thin vs line (career ~${h2h.ppg.toFixed(1)} PPG in ${h2h.games}g vs ${line} — cushion ${h2h.cushion.toFixed(1)})`
      );
    }
  }

  // 3. Secondary rebound competition
  if (hasSecondaryCompetition(mp, market)) {
    flags.secondaryCompetition = true;
    score -= cfg.secondaryCompetitionPenalty;
    reasons.push('secondary big competition — rebound share risk');
  }

  // 4. Game-script dependency
  const script = ctx.gameScript || {};
  const totalLine = script.total ?? mp.totalLine ?? null;
  const spread = script.spread ?? mp.spread ?? null;
  const isLowPace = totalLine != null && totalLine < cfg.lowPaceTotal;
  const isBlowoutRisk = spread != null && Math.abs(spread) >= cfg.blowoutSpread;
  const isRoad = mp.isHome === false || mp.home === false || (mp.location || '').toLowerCase() === 'away';

  if (isPurePoints && isLowPace) {
    flags.scriptDependent = true;
    score -= 14;
    reasons.push('low total / slow pace environment');
  }
  if ((isPurePoints || isCombo) && isBlowoutRisk) {
    flags.scriptDependent = true;
    score -= 10;
    reasons.push('blowout risk (minutes / garbage time uncertainty)');
  }

  if (isPurePoints && (flags.schemeHostile || flags.scriptDependent)) {
    flags.purePointsRisk = true;
    score -= cfg.purePointsHostilePenalty;
    reasons.push('pure points over in hostile or script-sensitive spot');
  }

  // 4b. PTS compound risk count (return + elite D + road + H2H thin + minutes)
  let ptsRiskFlags = 0;
  if (isPurePoints) {
    if (flags.returnRisk) ptsRiskFlags++;
    if (flags.eliteDefense || flags.schemeHostile) ptsRiskFlags++;
    if (isRoad) ptsRiskFlags++;
    if (flags.h2hThin) ptsRiskFlags++;
    if (flags.minutesRisk && !flags.returnRisk) ptsRiskFlags++; // avoid double-count with return
  }

  // 5. High-volume preference (stricter for PTS)
  const usg = getUsg(mp);
  const rebRate = getRebRate(mp);
  let preferredProfile = null;

  // PTS: only award high-volume preferred if hard filters clear
  const ptsHardClear =
    !flags.returnRisk &&
    !flags.h2hThin &&
    ptsRiskFlags < cfg.ptsCompoundHardLimit &&
    !flags.foulTrouble;

  if (isPurePoints && usg != null && usg >= cfg.highUsgThreshold && !flags.minutesRisk && ptsHardClear) {
    flags.highVolumePreferred = true;
    score += cfg.volumeBoost;
    preferredProfile = 'primary_creator_pts';
    reasons.push(`high-usage primary creator (USG ${typeof usg === 'number' ? usg.toFixed(1) : usg}%) — preferred volume profile`);
  } else if (isPurePoints && usg != null && usg >= cfg.highUsgThreshold && !ptsHardClear) {
    flags.highFloorPtsBlocked = true;
    reasons.push('usage is high but PTS hard filters (return / H2H / compound risk) blocked high-floor label');
  }

  if (isRebMarket && rebRate != null && rebRate >= cfg.highRebRateThreshold && !flags.minutesRisk && !flags.foulTrouble && !flags.secondaryCompetition) {
    flags.highVolumePreferred = true;
    score += cfg.volumeBoost;
    preferredProfile = preferredProfile || 'high_volume_reb';
    reasons.push(`strong rebound rate (${typeof rebRate === 'number' ? rebRate.toFixed(1) : rebRate}) + secure minutes — preferred high-floor rebound profile`);
  }
  if (isCounting && market === 'assists' && usg != null && usg >= 24 && !flags.minutesRisk) {
    flags.highVolumePreferred = true;
    score += 6;
    preferredProfile = preferredProfile || 'primary_creator_ast';
  }

  // 6. Early-season volatility
  const dateStr = ctx.date || mp.date || '';
  const isVeryEarly = /2026-10-(2[0-5])/.test(dateStr);
  if (isVeryEarly && isPurePoints) {
    flags.openingNightDiscount = true;
    score -= 8;
    reasons.push('early-season / opening-week volatility discount');
  }

  // 7. Compounding UNDER factors
  let underFactors = 0;
  if (isLowPace) underFactors++;
  if (flags.schemeHostile) underFactors++;
  if (flags.minutesRisk || flags.foulTrouble) underFactors++;
  if (isPurePoints || market === 'pts_asts') underFactors++;
  if (isBlowoutRisk) underFactors++;
  if (flags.secondaryCompetition) underFactors++;
  if (flags.returnRisk) underFactors++;
  if (flags.h2hThin) underFactors++;

  if (underFactors >= 3 && (newRec.side === 'under' || newRec.lean === 'under' || newRec.edge < 0)) {
    flags.compoundingUnder = true;
    flags.underBoosted = true;
    score += 18;
    if (newRec.side === 'under' || newRec.lean === 'under') {
      newRec.edge = Math.min(0.28, (newRec.edge || 0) + 0.045);
      newRec.prob = Math.min(0.72, (newRec.prob || 0.5) + 0.04);
    }
    reasons.push(`compounding under factors (${underFactors})`);
  }

  // 8. Force PASS or advise UNDER on high-risk overs
  const weakestStat = weakestComponent(mp, market, flags);

  // Extra PTS gate: return risk or H2H thin on an over → strong push to pass / under
  if (isPurePoints && newRec.side === 'over' && newRec.lean !== 'pass') {
    if (flags.returnRisk) {
      // Hard filter: do not allow "safe" overs on recent returnees
      newRec = {
        ...newRec,
        side: 'over',
        lean: 'pass',
        edge: 0,
        prob: 0.5,
        formKill: true,
      };
      flags.forcedPass = true;
      flags.highFloorPtsBlocked = true;
      reasons.push(`FORCED PASS — return-from-absence risk (weakest: ${weakestStat})`);
      score = Math.min(score, 20);
    } else if (flags.h2hThin && ptsRiskFlags >= cfg.ptsCompoundHardLimit) {
      flags.adviseUnder = true;
      if ((newRec.edge || 0) < 0.14) {
        newRec = {
          ...newRec,
          side: 'under',
          lean: 'under',
          edge: Math.max(0.06, 0.10 - (newRec.edge || 0)),
          prob: Math.min(0.66, 0.54 + (0.10 - (newRec.edge || 0))),
        };
        reasons.push(`ADVISE UNDER — H2H at/under line + compound PTS risk (most vulnerable: ${weakestStat})`);
        score = Math.min(score, 30);
      } else {
        newRec.edge = Math.max(0, (newRec.edge || 0) - 0.06);
        newRec.lean = (newRec.edge < 0.07) ? 'pass' : newRec.lean;
        reasons.push(`over edge reduced — H2H thin vs line + stacked risk on ${weakestStat}`);
      }
    }
  }

  if ((isPurePoints || isCombo || isRebMarket) && newRec.side === 'over' && newRec.lean !== 'pass' && !flags.forcedPass) {
    const veryHighRisk = (score <= cfg.forcedPassScore) || (flags.purePointsRisk && underFactors >= 3) || (flags.foulTrouble && flags.minutesRisk);
    const highRisk = score <= cfg.underAdviseScore || (flags.purePointsRisk && (flags.schemeHostile || flags.scriptDependent || flags.minutesRisk));

    if (veryHighRisk) {
      newRec = {
        ...newRec,
        side: 'over',
        lean: 'pass',
        edge: 0,
        prob: 0.5,
        formKill: true,
      };
      flags.forcedPass = true;
      reasons.push(`FORCED PASS — failed high-floor / no-foul-trouble stress test (weakest: ${weakestStat})`);
      score = Math.min(score, 22);
    } else if (highRisk) {
      flags.adviseUnder = true;
      if ((newRec.edge || 0) < 0.12) {
        newRec = {
          ...newRec,
          side: 'under',
          lean: 'under',
          edge: Math.max(0.06, 0.11 - (newRec.edge || 0)),
          prob: Math.min(0.68, 0.55 + (0.12 - (newRec.edge || 0))),
        };
        reasons.push(`ADVISE UNDER — risk profile makes the over likely to underperform (most vulnerable: ${weakestStat})`);
        score = Math.min(score, 32);
      } else {
        newRec.edge = Math.max(0, (newRec.edge || 0) - 0.05);
        newRec.lean = (newRec.edge < 0.07) ? 'pass' : newRec.lean;
        reasons.push(`over edge reduced — elevated underperform risk on ${weakestStat}`);
      }
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // High-floor label is stricter for PTS
  if (score >= cfg.highFloorScore && flags.highVolumePreferred && !flags.highFloorPtsBlocked) {
    preferredProfile = preferredProfile || (isPurePoints ? 'high_floor_pts' : 'high_floor');
  } else if (score >= cfg.highFloorScore && !isPurePoints) {
    preferredProfile = preferredProfile || 'stable_floor';
  } else if (isPurePoints && flags.highFloorPtsBlocked) {
    preferredProfile = preferredProfile || 'volume_pts_only';
  }

  let riskExplanation = '';
  if (flags.forcedPass) {
    riskExplanation = `High risk of underperformance. Primary concern: ${weakestStat}. Failed the high-volume + no-foul-trouble checklist.`;
  } else if (flags.adviseUnder) {
    riskExplanation = `Over carries elevated risk of underperforming. Most likely weak link: ${weakestStat}. Prefer the under or pass.`;
  } else if (flags.highVolumePreferred && score >= cfg.highFloorScore && !flags.highFloorPtsBlocked) {
    riskExplanation = `Clears the high-volume / low-foul-trouble bar. Preferred profile${preferredProfile ? ` (${preferredProfile})` : ''}.`;
  } else if (flags.highFloorPtsBlocked) {
    riskExplanation = `Usage/volume present but PTS hard filters blocked high-floor label (return / H2H / compound risk). Treat as volume test only.`;
  } else if (score < 45) {
    riskExplanation = `Below preferred floor. Watch: ${reasons.slice(0, 2).join('; ') || 'general variance'}.`;
  } else {
    riskExplanation = `Acceptable risk profile. Key notes: ${reasons.slice(0, 2).join('; ') || 'none'}.`;
  }

  return {
    rec: newRec,
    flags,
    reasons,
    score,
    underFactors,
    preferredProfile,
    weakestStat,
    riskExplanation,
    // diagnostics for logging / Key Reads
    ptsRiskFlags: isPurePoints ? ptsRiskFlags : 0,
    returnInfo: isPurePoints ? returnInfo : null,
  };
}

export default { applySchemeRisk };
