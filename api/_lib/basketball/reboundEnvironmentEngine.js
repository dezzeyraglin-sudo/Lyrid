// api/_lib/basketball/reboundEnvironmentEngine.js
//
// REBOUND ENVIRONMENT ENGINE (June 1, 2026)
//
// Philosophy (per spec): "Rebounds are dictated more by shot geography and floor
// spacing than by season averages." A center facing a spread, high-3PA offense
// can LOSE rebound equity even in high minutes, because misses fly long to
// guards/wings. A guard facing a downhill paint-attacking team can rack up
// "free" rebounds. Raw RPG misses this entirely.
//
// DYNAMIC, DAILY: the engine reads the OPPONENT team's OWN shot profile from
// their live bbref shooting table (re-derived each slate, cached 1h). The shots
// your player rebounds are the opponent's missed shots, so the opponent's own
// shot diet — rim/paint/midrange/three/corner share, avg distance, FT rate — is
// exactly the right signal, and it updates as a team's style shifts over the
// season. (Limitation: bbref team stats are cumulative season averages, so a
// very recent style change is reflected gradually, not instantly.)
//
// WHAT'S REAL vs NEUTRAL (honest):
//   REAL (live bbref): opponent shot-distance diet, corner-3 share, avg shot
//     distance, FT rate, make-rate-by-zone (miss volume), pace, player archetype,
//     player rebound rate & minutes, spread (blowout risk).
//   NEUTRAL (no WNBA feed): live contest location, weak-side crash tendency,
//     real-time floor balance, dunker-spot usage. These are structural layers,
//     wired but inactive (factor 1.0) until a tracking source exists.
//
// CONTRACT: analyzeReboundProp(input, league='WNBA') -> {
//   projection, edge, probOver, probUnder, recommendation, confidence, tier,
//   environment: { oppType, missProfile, longShare, shortShare, ... },
//   equity: { archetype, equityMultiplier, benefits, ... },
//   trap: { isTrap, reason }, variance: { grade, score },
//   scores: { ... }, dataCompleteness: {...}, floor, ceiling, _audit }
//
// input shape (same as the points engine):
//   player:  { name, position, seasonAvg (REB), minutesAvg, expectedMinutes,
//              last5Avg, minutesCv, _raw, reboundRate? }
//   opponent: a team object from wnbaTeamData (carries .shotProfile, pace, _raw)
//   team:     player's own team object
//   market: 'rebounds', line, game: { spread, total }

import { getLeagueConfig } from './leagueConfig.js';

const clamp = (x, [lo, hi]) => Math.max(lo, Math.min(hi, x));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// ============================================================
// 1. OPPONENT SHOT-PROFILE CLASSIFIER (dynamic, per team)
// ============================================================
// Reads the opponent's OWN shot diet and types them. Everything here is REAL
// when shotProfile.available; otherwise we fall back to the coarse 2P/3P split
// from _raw and flag it.

function classifyShotProfile(opponent, leagueAvg) {
  const sp = opponent?.shotProfile || null;

  // Primary path: full shot-distance diet.
  if (sp && sp.available) {
    const rim = sp.rimShare ?? 0;
    const paint = sp.paintShare ?? 0;
    const shortMid = sp.shortMidShare ?? 0;
    const longMid = sp.longMidShare ?? 0;
    const three = sp.threeShare ?? 0;
    const corner3 = sp.corner3Share ?? 0;
    const ftRate = sp.ftRate ?? leagueAvg.ftRate;
    const avgDist = sp.avgDist ?? leagueAvg.avgDist;

    // Interior pressure = shots at/near the rim + FT rate (downhill driving).
    const interiorShare = rim + paint;
    const downhillSignal = (ftRate != null && leagueAvg.ftRate)
      ? ftRate / leagueAvg.ftRate : 1;

    // Type the team dynamically from its actual diet vs league average.
    let oppType, longBias;
    const threeVsLg = leagueAvg.threeShare ? three / leagueAvg.threeShare : 1;
    if (three >= leagueAvg.threeShare * 1.12 && interiorShare <= leagueAvg.interiorShare * 0.95) {
      oppType = 'PERIMETER';          // spread, 3-heavy → long misses
      longBias = 0.62 + 0.10 * (threeVsLg - 1);
    } else if (interiorShare >= leagueAvg.interiorShare * 1.08 && downhillSignal >= 1.05) {
      oppType = 'DOWNHILL_PAINT';     // drives, attacks rim → short misses
      longBias = 0.32;
    } else if ((shortMid + longMid) >= leagueAvg.midShare * 1.15) {
      oppType = 'PULLUP_MIDRANGE';    // pull-up heavy → medium misses
      longBias = 0.47;
    } else {
      oppType = 'BALANCED';
      longBias = 0.50;
    }
    longBias = clamp(longBias, [0.25, 0.75]);

    return {
      source: 'REAL', oppType,
      longBias,                                   // share of misses that travel long
      shortBias: Number((1 - longBias).toFixed(3)),
      rim, paint, shortMid, longMid, three, corner3, avgDist, ftRate,
      interiorShare: Number(interiorShare.toFixed(3)),
      detail: `${oppType} (rim+paint ${(interiorShare*100).toFixed(0)}%, 3PA ${(three*100).toFixed(0)}%, avgDist ${avgDist?.toFixed?.(1) ?? '—'})`,
    };
  }

  // Fallback path: coarse 2P/3P split from the summary table.
  const raw = opponent?._raw || {};
  const fg3a = num(raw.opp_fg3_per_g);      // not ideal, but a directional proxy
  const oppType = 'UNKNOWN_COARSE';
  return {
    source: 'INFERRED', oppType,
    longBias: 0.50, shortBias: 0.50,
    detail: 'shot-distance table unavailable; neutral geometry',
  };
}

// ============================================================
// 2. MISS-GEOGRAPHY FORECAST
// ============================================================
// Convert the shot diet + make-rate-by-zone into expected miss volume by
// distance band. More attempts in a zone and a lower make rate => more misses
// land in that zone's rebound geography.

function forecastMissGeography(profile, opponent, cfg) {
  if (profile.source !== 'REAL') {
    return { long: 0.5, medium: 0.2, short: 0.3, totalMissRate: null, source: 'INFERRED' };
  }
  const mk = opponent.shotProfile.makeRate || {};
  // Miss weight by zone = attempt share * (1 - make rate). Long = 3PA + long mid.
  const wRim   = (profile.rim)      * (1 - (num(mk.rim)   ?? 0.52));
  const wPaint = (profile.paint)    * (1 - (num(mk.paint) ?? 0.44));
  const wSMid  = (profile.shortMid) * (1 - (num(mk.shortMid) ?? 0.40));
  const wLMid  = (profile.longMid)  * (1 - (num(mk.longMid)  ?? 0.40));
  const wThree = (profile.three)    * (1 - (num(mk.three) ?? 0.33));
  const total = wRim + wPaint + wSMid + wLMid + wThree || 1;

  // Rebound geography: rim/paint misses → short; short-mid → medium;
  // long-mid + threes → long.
  const shortShare  = (wRim + wPaint) / total;
  const mediumShare = (wSMid) / total;
  const longShare   = (wLMid + wThree) / total;

  return {
    long: Number(longShare.toFixed(3)),
    medium: Number(mediumShare.toFixed(3)),
    short: Number(shortShare.toFixed(3)),
    source: 'REAL',
  };
}

// ============================================================
// 3. ARCHETYPE REBOUND-EQUITY REDISTRIBUTION
// ============================================================
// The core of the model: who actually gets the rebound given the geography.
// Centers win short misses (rim zone); guards/wings win long misses (perimeter).

function archetypeFromPosition(pos) {
  if (!pos) return 'WING';
  const p = String(pos).toUpperCase();
  if (p.includes('C')) return 'CENTER';
  if (p.includes('G')) return 'GUARD';
  return 'WING';
}

function equityMultiplier(archetype, miss, cfg) {
  if (miss.source !== 'REAL') return { mult: 1, active: false, detail: 'neutral geometry' };
  const longShare = miss.long, shortShare = miss.short;
  const w = cfg.rebound;

  let mult = 1, note;
  if (archetype === 'CENTER') {
    // Centers gain on short misses, lose on long misses (pulled from rim).
    mult = 1 + (shortShare - 0.50) * w.centerShortSensitivity
             - (longShare - 0.50) * w.centerLongPenalty;
    note = 'center: short-miss dependent';
  } else if (archetype === 'GUARD') {
    // Guards gain on long misses (free perimeter boards), small on short.
    mult = 1 + (longShare - 0.50) * w.guardLongSensitivity;
    note = 'guard: long-miss beneficiary';
  } else { // WING
    mult = 1 + (longShare - 0.50) * w.wingLongSensitivity;
    note = 'wing: moderate long-miss beneficiary';
  }
  return { mult: clamp(mult, cfg.clamps.reboundEquity), active: true, detail: note };
}

// ============================================================
// 4. TRAP DETECTION
// ============================================================
// The "fake rebound matchup": public sees high opponent miss volume and a
// center who's been rebounding well, but the misses are LONG and redistribute
// to guards/wings — the center's equity quietly collapses.

function detectTrap(archetype, profile, miss, player) {
  if (profile.source !== 'REAL' || miss.source !== 'REAL') {
    return { isTrap: false, reason: null };
  }
  const recentHot = num(player.last5Avg) != null && num(player.seasonAvg) != null
    && player.last5Avg > player.seasonAvg * 1.10;

  // Center vs a long-miss environment = classic trap, especially if public is
  // anchored on a hot recent stretch.
  if (archetype === 'CENTER' && miss.long >= 0.58) {
    return {
      isTrap: true,
      reason: `Center vs ${profile.oppType}: ${(miss.long*100).toFixed(0)}% long misses redistribute boards to perimeter`
        + (recentHot ? ' — and recent RPG overstates true equity' : ''),
    };
  }
  // Guard with an inflated line vs a downhill paint team (short misses → center).
  if (archetype === 'GUARD' && miss.short >= 0.60 && recentHot) {
    return {
      isTrap: true,
      reason: `Guard vs ${profile.oppType}: ${(miss.short*100).toFixed(0)}% short misses go to bigs; recent RPG is a mirage`,
    };
  }
  return { isTrap: false, reason: null };
}

// ============================================================
// 5. MAIN
// ============================================================

export function analyzeReboundProp(input, league = 'WNBA') {
  const cfg = getLeagueConfig(league);
  const player = input.player || {};
  const opponent = input.opponent || {};
  const line = num(input.line);
  const leagueAvg = cfg.reboundLeagueAvg;

  // Base rebound rate per minute, blended with recent form.
  const seasonReb = num(player.seasonAvg) ?? 0;
  const minutesAvg = num(player.minutesAvg) || cfg.starterMinutes;
  const projMinutes = num(player.expectedMinutes) ?? minutesAvg;
  const last5 = num(player.last5Avg);
  const w = cfg.weights.recentFormBlend;
  const blendedReb = last5 != null ? (1 - w) * seasonReb + w * last5 : seasonReb;
  const minutesRatio = minutesAvg > 0 ? clamp(projMinutes / minutesAvg, cfg.clamps.recentRate) : 1;
  let baseProjection = blendedReb * minutesRatio;

  // 1-2. Environment + miss geography
  const profile = classifyShotProfile(opponent, leagueAvg);
  const miss = forecastMissGeography(profile, opponent, cfg);

  // 3. Archetype equity
  const archetype = archetypeFromPosition(player.position || player._raw?.POS);
  const equity = equityMultiplier(archetype, miss, cfg);

  // Pace: more possessions => more total rebound chances. REAL from team pace.
  const pace = num(opponent.pace) ?? num(input.team?.pace) ?? cfg.leagueAvgPace;
  const paceMult = clamp(1 + ((pace - cfg.leagueAvgPace) / cfg.leagueAvgPace) * cfg.weights.paceSensitivity,
    cfg.clamps.pace);

  // Opponent miss VOLUME: a leaky-shooting opponent creates more rebound chances.
  // REAL from opp_fg_pct (lower opp FG% on offense = more of their misses to grab).
  const oppFgPct = num(opponent.shotProfile?.makeRate?.rim) != null
    ? null  // handled inside geography; avoid double count
    : null;
  // Use the opponent's overall miss rate from _raw if present (their own FG%).
  const oppOwnFgPct = num(opponent._raw?.pts_per_g) != null ? num(opponent._raw?.opp_fg_pct) : null;
  // (left neutral here to avoid double-counting with geography make-rates)

  // Blowout risk: large spread trims late-game rebound minutes/opportunity.
  const spread = Math.abs(num(input.game?.spread) ?? 0);
  let blowoutMult = 1;
  if (spread >= cfg.weights.blowoutThresholdSpread) {
    blowoutMult = 1 - cfg.weights.blowoutMinutesHaircut * 0.5; // boards lost late
  }

  // NEUTRAL structural layers (no WNBA feed): floor balance, weak-side crash,
  // contest location. Wired, inactive at 1.0 until a tracking source exists.
  const floorBalanceMult = 1;   // NEUTRAL
  const crashMult = 1;          // NEUTRAL

  const combinedMult = clamp(
    equity.mult * paceMult * blowoutMult * floorBalanceMult * crashMult,
    cfg.clamps.combined
  );

  let projection = baseProjection * combinedMult;
  if (seasonReb > 0 && projection > seasonReb * 2.0) projection = seasonReb * 2.0;
  projection = Math.max(0, Number(projection.toFixed(2)));

  // 4. Trap detection
  const trap = detectTrap(archetype, profile, miss, player);

  // Variance: rebounds are noisier than points; widen for high-variance geometry
  // (balanced/uncertain) and minutes volatility.
  const baseCv = cfg.variance.baseReboundCv ?? (cfg.variance.baseScoringCv * 1.3);
  const minutesCv = num(player.minutesCv) ?? 0;
  const geoUncertainty = profile.source === 'REAL' ? Math.abs(miss.long - 0.5) : 0; // far from 50/50 = more certain
  const effectiveCv = baseCv * (1 + minutesCv * cfg.variance.minutesCvInflation) * (1 - 0.3 * geoUncertainty);
  const sd = projection * effectiveCv;
  const floor = Math.max(0, Number((projection - sd).toFixed(1)));
  const ceiling = Number((projection + sd).toFixed(1));

  let probOver = null, probUnder = null;
  if (line != null && sd > 0) {
    const z = (projection - line) / sd;
    probOver = Number(normalCdf(z).toFixed(3));
    probUnder = Number((1 - probOver).toFixed(3));
  }
  const edge = line != null ? Number((projection - line).toFixed(2)) : null;

  // Variance grade
  let varianceGrade;
  if (trap.isTrap) varianceGrade = 'TRAP ENVIRONMENT';
  else if (effectiveCv >= baseCv * 1.2) varianceGrade = 'HIGH VARIANCE';
  else if (effectiveCv >= baseCv * 1.05) varianceGrade = 'MODERATE VARIANCE';
  else varianceGrade = 'STABLE';

  // 0-100 sub-scores for the card
  const scores = {
    roleStability: clampScore(50 + (minutesRatio - 1) * 100),
    usageFunnel: 50,
    environment: clampScore(profile.source === 'REAL' ? 50 + (miss.short - 0.5) * 100 * sign(archetype) : 50),
    matchup: clampScore(equity.active ? 50 + (equity.mult - 1) * 250 : 50),
    coverage: 50,
    variance: clampScore(100 - effectiveCv * 130),
    finalEdge: null,
  };
  scores.finalEdge = computeFinalEdge(scores, edge, line);

  const dataCompleteness = {
    shotProfile: profile.source,                     // REAL or INFERRED
    missGeography: miss.source,
    archetypeEquity: equity.active ? 'REAL' : 'NEUTRAL',
    pace: num(opponent.pace) != null ? 'REAL' : 'NEUTRAL',
    floorBalance: 'NEUTRAL (no tracking feed)',
    contestLocation: 'NEUTRAL (no tracking feed)',
    recentFormAvailable: last5 != null,
  };

  const confidence = computeConfidence(dataCompleteness, player, cfg, trap);
  const tier = edgeTierLabel(scores.finalEdge);
  const recommendation = recommend(edge, probOver, dataCompleteness, trap);

  return {
    market: 'rebounds', line, projection, edge, probOver, probUnder,
    recommendation, confidence, tier,
    environment: {
      oppType: profile.oppType, oppProfileSource: profile.source,
      longShare: miss.long, mediumShare: miss.medium, shortShare: miss.short,
      detail: profile.detail,
    },
    equity: {
      archetype, equityMultiplier: round3(equity.mult), benefits: equity.detail,
    },
    trap,
    variance: { grade: varianceGrade, cv: Number(effectiveCv.toFixed(3)) },
    multipliers: {
      archetypeEquity: round3(equity.mult), pace: round3(paceMult),
      blowout: round3(blowoutMult), combined: round3(combinedMult),
      floorBalance: 1, weakSideCrash: 1,
    },
    scores, floor, ceiling, dataCompleteness,
    _audit: { league, baseProjection: Number(baseProjection.toFixed(2)), archetype },
  };
}

// ---- helpers ----
function clampScore(x) { return Math.round(clamp(x, [0, 100])); }
function sign(arch) { return arch === 'CENTER' ? 1 : -1; }
function round3(x) { return Number(Number(x).toFixed(3)); }

function computeFinalEdge(scores, edge, line) {
  const analytic = (scores.roleStability + scores.environment + scores.matchup + scores.variance) / 4;
  let edgePart = 50;
  if (edge != null && line) edgePart = clamp(50 + (edge / line) * 250, [0, 100]);
  return Math.round(0.55 * edgePart + 0.45 * analytic);
}

function computeConfidence(dc, player, cfg, trap) {
  let c = 100;
  if (dc.shotProfile !== 'REAL') c -= 25;        // geometry is the whole model
  if (dc.pace !== 'REAL') c -= 8;
  if (!dc.recentFormAvailable) c -= 8;
  const gp = num(player.gamesPlayed);
  if (gp != null && gp < 5) c -= 12;
  const minutesCv = num(player.minutesCv) ?? 0;
  if (minutesCv > 0.30) c -= 10;
  if (trap.isTrap) c -= 6;                        // trap = lower confidence in the public line, not ours
  return Math.max(0, Math.min(100, Math.round(c)));
}

function edgeTierLabel(fe) {
  if (fe >= 68) return 'STRONG';
  if (fe >= 56) return 'SOLID';
  if (fe >= 46) return 'NEUTRAL';
  return 'WEAK';
}

function recommend(edge, probOver, dc, trap) {
  if (edge == null || probOver == null) return 'PASS';
  if (dc.shotProfile !== 'REAL') return 'PASS';   // don't bet a rebound line on neutral geometry
  if (trap.isTrap) {
    // Trap means lean AGAINST the public side — usually the under on an inflated line.
    if (edge <= -0.5) return 'UNDER';
  }
  if (edge >= 0.6 && probOver >= 0.57) return 'OVER';
  if (edge <= -0.6 && probOver <= 0.43) return 'UNDER';
  return 'PASS';
}

export const _testing = {
  classifyShotProfile, forecastMissGeography, archetypeFromPosition,
  equityMultiplier, detectTrap, normalCdf,
};
