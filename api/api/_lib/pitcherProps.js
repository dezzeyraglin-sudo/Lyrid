// api/_lib/pitcherProps.js
// Pitcher prop recommendations (DK / FD focused):
//   Strikeouts O/U, Pitching Outs O/U, Walks O/U, Earned Runs O/U, Hits Allowed O/U, To Record a Win Y/N
//
// Design: reuses data already fetched for role detection + inning splits + arsenal.
// Computes baseline per-start rates, applies matchup/context modifiers, returns:
//   { projection, recommendations: [...] }
//
// Recommendations include tier + units + probability, mirroring the hitter prop system.
//
// DEEP MODE: when opposingLineup is passed in, the K projection uses a per-batter
// per-pitch-type rollup (see pitcherKProjection.js) which is structurally sharper
// than a flat K% × PAs model.

import { projectPitcherKsFromLineup } from './pitcherKProjection.js';

// ================== LEAGUE BASELINES ==================
// MLB 2024-25 averages for STARTING pitchers (not relievers)
const LEAGUE_AVG = {
  ipPerStart: 5.3,     // innings per start
  outsPerStart: 15.9,  // outs per start (IP × 3)
  kPerStart: 5.2,
  bbPerStart: 1.75,
  erPerStart: 2.4,
  hitsPerStart: 4.9,
  hrPerStart: 0.7,
  winProb: 0.40        // % of starts that earn the W (many are ND or L)
};

// Standard deviations for per-start outcomes — used for probability computation
const STDDEV = {
  ks: 2.2,        // empirical K stddev per start
  outs: 3.5,      // outs stddev (~1.2 IP)
  walks: 1.3,
  er: 1.8,
  hits: 2.2
};

/**
 * Build pitcher prop recommendations.
 *
 * @param {Object} pitcher             { id, name, hand }
 * @param {Object} opts
 *   @param {Object} opts.role         pitcherRole result from detectPitcherRole()
 *   @param {Object} opts.inningSplits blended inning splits result
 *   @param {Array}  opts.arsenal      pitcher arsenal with K% per pitch
 *   @param {Object} opts.lineupTier   opposing lineup tier
 *   @param {Object} opts.parkFactor
 *   @param {Object} opts.weatherImpact
 *   @param {Object} opts.umpire
 *   @param {Object} opts.gameLog      recent game log entries (last 5)
 * @returns {Object} projection + recommendations
 */
export function buildPitcherProps(pitcher, opts = {}) {
  if (!pitcher) return null;
  const {
    role,
    inningSplits,
    arsenal = [],
    lineupTier,
    parkFactor,
    weatherImpact,
    umpire,
    gameLog = [],
    opposingLineup = null  // DEEP MODE: lineup with deepPitchTypes for sharp K projection
  } = opts;

  // ======= ROLE GATE =======
  // Opener / bulk / shifted = suppress most props since IP will be 1-3
  const isOpener = role?.isOpener || role?.role === 'opener' || role?.role === 'bulk' || role?.role === 'shifted';
  const suppress = isOpener || role?.suppressKProps;

  // ======= PROJECTIONS =======
  const projection = {
    ks: null,
    outs: null,
    walks: null,
    er: null,
    hits: null,
    ip: null,
    winProb: null,
    reasoning: []
  };

  // ----- IP / OUTS projection -----
  // Start from role-aware baseline
  let projIp;
  if (role?.role === 'opener') projIp = 1.5;
  else if (role?.role === 'bulk') projIp = 2.5;
  else if (role?.role === 'shifted') projIp = parseFloat(role.avgIpRecent) || 3.0;
  else if (role?.role === 'short-starter') projIp = parseFloat(role.avgIpRecent) || 4.5;
  else if (role?.avgIpRecent) projIp = parseFloat(role.avgIpRecent);
  else projIp = LEAGUE_AVG.ipPerStart;

  // Umpire K-factor modestly increases IP (faster innings for elite-K pitchers)
  if (umpire?.factors?.k && umpire.factors.k > 1.02) projIp *= 1.02;

  // Weather: rain risk reduces IP significantly
  if (weatherImpact?.conditions && /Rain|Thunderstorm|Showers/i.test(weatherImpact.conditions)) {
    projIp *= 0.92;
    projection.reasoning.push('Rain risk — IP reduced');
  }

  // Lineup quality: tougher lineup means more pitches per inning, earlier hook
  if (lineupTier?.label === 'EXPLOITABLE' || lineupTier?.label === 'HIGHLY_EXPLOITABLE') {
    projIp *= 0.95;
    projection.reasoning.push('Strong lineup may shorten outing');
  } else if (lineupTier?.label === 'SUPPRESSED' || lineupTier?.label === 'LOCKED_DOWN') {
    projIp *= 1.04;
    projection.reasoning.push('Weak lineup supports longer outing');
  }

  // Pitch efficiency: P/IP determines how many outs achievable before ~95-110 pitch limit
  if (inningSplits?.season_stats?.pitchesPerInning != null) {
    const ppi = parseFloat(inningSplits.season_stats.pitchesPerInning);
    if (ppi < 14) {
      projIp *= 1.03;
      projection.reasoning.push(`Efficient (~${ppi.toFixed(1)} P/IP) supports longer outing`);
    } else if (ppi > 18) {
      projIp *= 0.96;
      projection.reasoning.push(`Inefficient (~${ppi.toFixed(1)} P/IP) — pitch limit comes early`);
    }
  }

  // Hot weather increases pitch counts (fatigue)
  if (weatherImpact?.tempF != null && weatherImpact.tempF > 88) {
    projIp *= 0.97;
    projection.reasoning.push(`Hot weather (${weatherImpact.tempF}°F) shortens outing`);
  }

  projection.ip = +projIp.toFixed(2);
  projection.outs = +(projIp * 3).toFixed(1);

  // ----- K projection -----
  // Pitcher's own K-rate from inning splits (most reliable) or arsenal (fallback)
  let kRate;  // Ks per PA
  if (inningSplits?.season_stats?.kPct != null) {
    kRate = inningSplits.season_stats.kPct;
  } else if (inningSplits?.current?.kPct != null) {
    kRate = inningSplits.current.kPct;
  } else if (inningSplits?.prior?.kPct != null) {
    kRate = inningSplits.prior.kPct;
  } else if (arsenal.length > 0) {
    // Weight pitch-level K rates by usage
    let weighted = 0, totalUsage = 0;
    for (const p of arsenal) {
      const k = parseFloat(p.pitcherK);
      const usage = parseFloat(p.pitcherUsage) || 0;
      if (!isNaN(k) && usage > 0) {
        weighted += (k / 100) * usage;
        totalUsage += usage;
      }
    }
    kRate = totalUsage > 0 ? weighted / totalUsage : 0.23;  // league avg ~23%
  } else {
    kRate = 0.23;
  }

  // PAs per start (~4.3 PAs per inning for average pitcher)
  const pasPerStart = projIp * 4.3;
  let projKs = pasPerStart * kRate;

  // ===== SHARP K PROJECTION (DEEP MODE) =====
  // When opposing lineup data with per-pitch-type K rates is available, replace the
  // flat K% × PAs baseline with a per-batter weighted projection. This catches lineup-
  // specific arsenal vulnerabilities that the lineupTier label flattens.
  let sharpKResult = null;
  if (opposingLineup && opposingLineup.length > 0 && arsenal.length > 0) {
    sharpKResult = projectPitcherKsFromLineup({
      lineup: opposingLineup,
      pitcherArsenal: arsenal,
      baselineKRate: kRate,
      projectedPAs: pasPerStart
    });
    if (sharpKResult.projectedKs != null && sharpKResult.sharpProjection) {
      projKs = sharpKResult.projectedKs;
      if (Math.abs(sharpKResult.matchupEdge) >= 5) {
        projection.reasoning.push(sharpKResult.detail);
      }
      projection.kSharp = {
        baselineKs: sharpKResult.baselineKs,
        sharpKs: sharpKResult.sharpProjectedKs,
        matchupEdge: sharpKResult.matchupEdge,
        confidence: sharpKResult.confidence,
        detail: sharpKResult.detail,
        // Per-batter contribution breakdown — surfaced in UI as audit trail.
        // Each entry: { hitterId, name, battingOrder, kRatePerPA, byPitch }
        batterBreakdown: sharpKResult.batterBreakdown || []
      };
    }
  }

  // Lineup K-vulnerability adjustment — only apply if sharp projection wasn't used
  // (the sharp projection already incorporates lineup quality at the per-batter level)
  if (!sharpKResult || !sharpKResult.sharpProjection) {
    if (lineupTier?.label === 'EXPLOITABLE' || lineupTier?.label === 'HIGHLY_EXPLOITABLE') {
      projKs *= 0.93;  // strong lineup reduces Ks
      projection.reasoning.push('Strong opposing lineup reduces K ceiling');
    } else if (lineupTier?.label === 'SUPPRESSED' || lineupTier?.label === 'LOCKED_DOWN') {
      projKs *= 1.07;
      projection.reasoning.push('Weak opposing lineup boosts K projection');
    }
  }

  // Umpire K-factor (applies regardless of sharp/baseline path)
  if (umpire?.factors?.k) projKs *= umpire.factors.k;

  projection.ks = +projKs.toFixed(2);

  // ----- BB projection -----
  let bbRate;
  if (inningSplits?.season_stats?.bbPct != null) bbRate = inningSplits.season_stats.bbPct;
  else if (inningSplits?.current?.bbPct != null) bbRate = inningSplits.current.bbPct;
  else if (inningSplits?.prior?.bbPct != null) bbRate = inningSplits.prior.bbPct;
  else bbRate = 0.081;  // league avg ~8.1%

  let projBb = pasPerStart * bbRate;
  if (umpire?.factors?.bb) projBb *= umpire.factors.bb;

  projection.walks = +projBb.toFixed(2);

  // ----- ER projection -----
  // Base from xwOBA-against: elite pitcher (.260 xwOBA) → ~2.0 ER, average (.320) → ~2.7, bad (.360) → ~3.3
  const xwAg = inningSplits?.season_stats?.xwobaAgainst || 0.320;
  let projEr = (projIp / 9) * (4.3 + (xwAg - 0.320) * 15);
  // Park and weather HR factors
  if (parkFactor?.hr) projEr *= (0.85 + 0.15 * (parkFactor.hr / 100));
  if (weatherImpact && !weatherImpact.isDome) {
    const hand = pitcher.hand || 'R';
    // Average the two HR mults — pitcher faces both L and R hitters
    const wMult = (weatherImpact.hrMultLHH + weatherImpact.hrMultRHH) / 2;
    projEr *= (0.85 + 0.15 * wMult);
  }
  projection.er = +projEr.toFixed(2);

  // ----- Hits projection -----
  let hitRate;
  if (inningSplits?.season_stats?.pa > 50) {
    const hp = (inningSplits.season_stats.pa - (inningSplits.season_stats.kPct || 0) * inningSplits.season_stats.pa - (inningSplits.season_stats.bbPct || 0) * inningSplits.season_stats.pa) / inningSplits.season_stats.pa;
    hitRate = hp * (xwAg / 0.320) * 0.295;  // ~29.5% of balls in play become hits
  } else {
    hitRate = 0.215;  // league avg hits per PA
  }
  const projHits = pasPerStart * hitRate;
  projection.hits = +projHits.toFixed(2);

  // ----- Win probability -----
  // Quality starts correlate with wins: if pitcher is expected to go 6+ IP with <3 ER, win prob is boosted
  let projWinProb = LEAGUE_AVG.winProb;
  if (projIp >= 6 && projEr <= 2.5) projWinProb = 0.50;
  if (projIp >= 6.5 && projEr <= 2.0) projWinProb = 0.56;
  if (projIp < 5 || projEr >= 4) projWinProb = 0.28;
  if (isOpener) projWinProb = 0.10;  // openers rarely get the W
  projection.winProb = +projWinProb.toFixed(2);

  // Role-based suppression note
  if (suppress) {
    projection.reasoning.push(`${role.role} role — props capped`);
  }

  // ======= TIER / UNIT RECOMMENDATION LOGIC =======
  // Given a projection and a market line, recommend OVER / UNDER at a tier.
  // Tiers based on delta from projection.
  const recs = [];

  recs.push({
    type: 'strikeouts',
    label: 'STRIKEOUTS',
    projection: projection.ks,
    stddev: STDDEV.ks,
    unit: 'K',
    suppressed: suppress,
    description: buildKDescription(projection.ks, kRate, lineupTier, umpire, inningSplits, role)
  });
  recs.push({
    type: 'outs',
    label: 'PITCHING OUTS',
    projection: projection.outs,
    stddev: STDDEV.outs,
    unit: 'outs',
    suppressed: suppress && role?.role !== 'short-starter',
    description: buildOutsDescription(projection.outs, role, weatherImpact)
  });
  recs.push({
    type: 'walks',
    label: 'WALKS',
    projection: projection.walks,
    stddev: STDDEV.walks,
    unit: 'BB',
    suppressed: suppress,
    description: buildBbDescription(projection.walks, inningSplits, umpire)
  });
  recs.push({
    type: 'earned_runs',
    label: 'EARNED RUNS',
    projection: projection.er,
    stddev: STDDEV.er,
    unit: 'ER',
    suppressed: false,
    description: buildErDescription(projection.er, xwAg, parkFactor, weatherImpact)
  });
  recs.push({
    type: 'hits_allowed',
    label: 'HITS ALLOWED',
    projection: projection.hits,
    stddev: STDDEV.hits,
    unit: 'H',
    suppressed: false,
    description: buildHitsDescription(projection.hits, xwAg, lineupTier)
  });
  recs.push({
    type: 'record_win',
    label: 'TO RECORD A WIN',
    projection: projection.winProb,
    isBoolean: true,
    suppressed: suppress,
    description: buildWinDescription(projection.winProb, projection.ip, projection.er, role)
  });

  return {
    pitcher: pitcher.name,
    pitcherId: pitcher.id,
    hand: pitcher.hand,
    role: role?.role || 'unknown',
    suppressed: suppress,
    projection,
    recommendations: recs
  };
}

/**
 * Given a prop projection + market line, compute recommendation (OVER/UNDER, tier, units, probability)
 * This is called from analyze.js once we have market lines (if available).
 *
 * @param {Object} propRec  One of the recommendation objects from buildPitcherProps
 * @param {number} line     Market line (e.g. 5.5 for Ks)
 * @returns {Object} { side, tier, units, probability, delta }
 */
export function evaluatePitcherProp(propRec, line) {
  if (!propRec || line == null || propRec.suppressed) return null;
  const proj = propRec.projection;
  if (proj == null) return null;

  // For boolean props (win), use direct probability comparison
  if (propRec.isBoolean) {
    const winProb = proj;
    if (winProb >= 0.55) return { side: 'YES', tier: winProb >= 0.60 ? 'STRONG' : 'MODERATE', units: winProb >= 0.60 ? 2 : 1, probability: winProb };
    if (winProb <= 0.30) return { side: 'NO', tier: winProb <= 0.22 ? 'STRONG' : 'MODERATE', units: winProb <= 0.22 ? 2 : 1, probability: 1 - winProb };
    return { side: null, tier: 'PASS', units: 0, probability: winProb };
  }

  const delta = proj - line;
  const stddev = propRec.stddev || 1.0;
  const z = delta / stddev;
  const probability = normalCDF(Math.abs(z));  // probability that outcome exceeds line in the projected direction
  const side = delta > 0 ? 'OVER' : 'UNDER';

  // Tier based on delta (calibrated per prop type)
  const absDelta = Math.abs(delta);
  let tier = 'PASS';
  let units = 0;

  // Thresholds per prop type
  switch (propRec.type) {
    case 'strikeouts':
      if (absDelta >= 1.5) { tier = 'STRONG'; units = 2; }
      else if (absDelta >= 0.8) { tier = 'MODERATE'; units = 1; }
      else if (absDelta >= 0.4) { tier = 'SLIGHT'; units = 0.5; }
      break;
    case 'outs':
      if (absDelta >= 3.0) { tier = 'STRONG'; units = 2; }
      else if (absDelta >= 1.5) { tier = 'MODERATE'; units = 1; }
      else if (absDelta >= 0.75) { tier = 'SLIGHT'; units = 0.5; }
      break;
    case 'walks':
      if (absDelta >= 0.75) { tier = 'STRONG'; units = 2; }
      else if (absDelta >= 0.4) { tier = 'MODERATE'; units = 1; }
      else if (absDelta >= 0.25) { tier = 'SLIGHT'; units = 0.5; }
      break;
    case 'earned_runs':
      if (absDelta >= 1.0) { tier = 'STRONG'; units = 2; }
      else if (absDelta >= 0.5) { tier = 'MODERATE'; units = 1; }
      else if (absDelta >= 0.25) { tier = 'SLIGHT'; units = 0.5; }
      break;
    case 'hits_allowed':
      if (absDelta >= 1.2) { tier = 'STRONG'; units = 2; }
      else if (absDelta >= 0.6) { tier = 'MODERATE'; units = 1; }
      else if (absDelta >= 0.3) { tier = 'SLIGHT'; units = 0.5; }
      break;
  }

  return {
    side,
    tier,
    units,
    probability: Math.max(0.05, Math.min(0.95, probability)),
    delta: +delta.toFixed(2),
    line
  };
}

// ==================== DESCRIPTION BUILDERS ====================

function buildKDescription(projKs, kRate, lineupTier, umpire, inningSplits, role) {
  const bits = [];
  if (kRate >= 0.29) bits.push(`High-K arsenal (${(kRate*100).toFixed(1)}% K-rate)`);
  else if (kRate <= 0.18) bits.push(`Contact pitcher (${(kRate*100).toFixed(1)}% K-rate)`);
  if (lineupTier?.label === 'EXPLOITABLE') bits.push('strong lineup reduces Ks');
  if (lineupTier?.label === 'LOCKED_DOWN' || lineupTier?.label === 'SUPPRESSED') bits.push('weak lineup boosts Ks');
  if (umpire?.factors?.k > 1.03) bits.push(`K-friendly ump (${((umpire.factors.k-1)*100).toFixed(0)}%+)`);
  if (umpire?.factors?.k < 0.97) bits.push('tight ump zone hurts Ks');
  if (role?.role === 'short-starter') bits.push('limited IP caps Ks');
  return bits.join(' · ') || 'Standard K projection';
}

function buildOutsDescription(projOuts, role, weatherImpact) {
  const bits = [];
  if (role?.role === 'traditional') bits.push('full-workload starter');
  if (role?.role === 'short-starter') bits.push(`short-start pattern (~${(projOuts/3).toFixed(1)} IP)`);
  if (role?.role === 'opener') bits.push('OPENER — 1-2 IP expected');
  if (role?.role === 'bulk' || role?.role === 'shifted') bits.push('role shift — reduced IP');
  if (weatherImpact?.conditions && /Rain|Thunderstorm/i.test(weatherImpact.conditions)) bits.push('rain delay risk');
  return bits.join(' · ') || 'Standard outs projection';
}

function buildBbDescription(projBb, inningSplits, umpire) {
  const bits = [];
  if (inningSplits?.controlTier === 'elite') bits.push('elite control (rarely walks batters)');
  if (inningSplits?.controlTier === 'wild') bits.push('WILD pitcher — walks inflate');
  if (inningSplits?.controlTier === 'below-average') bits.push('below-avg control');
  if (umpire?.factors?.bb > 1.04) bits.push('tight-zone ump inflates walks');
  if (umpire?.factors?.bb < 0.96) bits.push('wide-zone ump reduces walks');
  return bits.join(' · ') || 'Standard walk projection';
}

function buildErDescription(projEr, xwAg, parkFactor, weatherImpact) {
  const bits = [];
  if (xwAg <= 0.285) bits.push(`elite xwOBA-against (${xwAg.toFixed(3)})`);
  else if (xwAg >= 0.350) bits.push(`weak xwOBA-against (${xwAg.toFixed(3)})`);
  if (parkFactor?.hr >= 115) bits.push(`HR-friendly park (+${parkFactor.hr - 100}% HR)`);
  if (parkFactor?.hr <= 85) bits.push('pitcher-friendly park');
  if (weatherImpact?.windRelative?.category?.startsWith('OUT_TO') && weatherImpact.windSpeedMph >= 10) {
    bits.push('wind blowing out inflates ER');
  }
  return bits.join(' · ') || 'Standard ER projection';
}

function buildHitsDescription(projHits, xwAg, lineupTier) {
  const bits = [];
  if (lineupTier?.label === 'EXPLOITABLE' || lineupTier?.label === 'HIGHLY_EXPLOITABLE') bits.push('strong lineup inflates hits');
  if (lineupTier?.label === 'SUPPRESSED' || lineupTier?.label === 'LOCKED_DOWN') bits.push('weak lineup suppresses hits');
  return bits.join(' · ') || 'Standard hits projection';
}

function buildWinDescription(winProb, projIp, projEr, role) {
  const bits = [];
  if (projIp >= 6 && projEr <= 2.5) bits.push('quality-start pace');
  else if (projIp < 5) bits.push('short outing — low W probability');
  if (role?.role === 'opener') bits.push('openers rarely get W');
  return bits.join(' · ') || `${(winProb*100).toFixed(0)}% win probability`;
}

// Standard normal CDF via Abramowitz-Stegun
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
