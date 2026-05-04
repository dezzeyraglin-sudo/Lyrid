// api/_lib/prop-formulas.js
// PrizePicks/Underdog prop-context layer for Mismatch Finder.
// Pure helpers only: no network calls, no dependencies, safe for Vercel serverless.

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
const num = (value, fallback = 0) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

export function calculateRunPowerIndex({
  teamHrIndex = 100,
  xbhIndex = 100,
  parkHrFactor = 100,
  weatherHrFactor = 100,
  pitcherHrWeakness = 100,
} = {}) {
  return (
    0.35 * teamHrIndex +
    0.25 * xbhIndex +
    0.20 * parkHrFactor +
    0.10 * weatherHrFactor +
    0.10 * pitcherHrWeakness
  );
}

export function calculateRunContactIndex({
  contactRateIndex = 100,
  obpIndex = 100,
  kSuppressionIndex = 100,
  bullpenXwobaIndex = 100,
  babipRunProfile = 100,
} = {}) {
  return (
    0.30 * contactRateIndex +
    0.20 * obpIndex +
    0.20 * kSuppressionIndex +
    0.15 * bullpenXwobaIndex +
    0.15 * babipRunProfile
  );
}

export function classifyGameType(rpi, rci) {
  const delta = rpi - rci;
  if (rpi >= 110 && delta >= 8) return 'power_scoring';
  if (rci >= 110 && delta <= -8) return 'contact_sequencing';
  if (rpi >= 105 && rci >= 105) return 'full_offensive_environment';
  if (rpi < 95 && rci < 95) return 'suppressed_game';
  return 'mixed';
}

export function calculatePropEdge(projection, line, side = 'over') {
  const p = num(projection, null);
  const l = num(line, null);
  if (p == null || l == null || l <= 0) return { edge: null, edgePercent: null };
  const edge = side === 'under' ? l - p : p - l;
  return { edge, edgePercent: edge / l };
}

export function getMinimumEdgeThreshold(propType) {
  const key = String(propType || '').toLowerCase();
  if (key === 'fantasy' || key === 'fs') return 0.12;
  if (key === 'hrr' || key === 'h+r+rbi') return 0.10;
  if (key === 'hits' || key === 'h') return 0.08;
  if (key === 'ks' || key === 'strikeouts') return 0.10;
  if (key === 'walks_allowed' || key === 'earned_runs' || key === 'hits_allowed') return 0.15;
  return 0.10;
}

export function detectLineEfficiency({ projection = null, line = null, side = 'over', propType = 'fantasy' } = {}) {
  const { edge, edgePercent } = calculatePropEdge(projection, line, side);
  const threshold = getMinimumEdgeThreshold(propType);
  if (edge == null || edgePercent == null) {
    return {
      available: false,
      edge: null,
      edgePercent: null,
      threshold,
      tag: 'no_line',
      note: 'No live prop line/projection pair available; using model-only proxy.'
    };
  }
  const tag = edgePercent >= threshold + 0.05 ? 'strong_edge'
    : edgePercent >= threshold ? 'playable_edge'
    : edgePercent >= 0 ? 'thin_edge'
    : 'negative_edge';
  return {
    available: true,
    edge: Number(edge.toFixed(3)),
    edgePercent: Number(edgePercent.toFixed(3)),
    threshold,
    tag,
    passes: edgePercent >= threshold,
    note: edgePercent >= threshold
      ? `Projection clears the ${Math.round(threshold * 100)}% minimum edge threshold.`
      : `Projection does not clear the ${Math.round(threshold * 100)}% minimum edge threshold.`
  };
}

export function calculateLateInningEquity({
  starterShortness = 100,
  bullpenWeakness = 100,
  bullpenFatigue = 100,
  lineupLateScoring = 100,
} = {}) {
  const score = (
    0.35 * starterShortness +
    0.30 * bullpenWeakness +
    0.20 * bullpenFatigue +
    0.15 * lineupLateScoring
  );
  const clipped = clamp(score, 50, 160);
  return {
    score: Number(clipped.toFixed(1)),
    tag: clipped >= 115 ? 'strong_late_boost' : clipped >= 100 ? 'moderate_late_boost' : 'neutral',
    note: clipped >= 115
      ? 'Late innings improve hitter/run conversion because of starter shortness and/or bullpen weakness.'
      : clipped >= 100
        ? 'Late innings provide a moderate conversion boost.'
        : 'No meaningful late-inning boost detected.'
  };
}

export function getBaseVolatility(propType) {
  const key = String(propType || '').toLowerCase();
  const table = {
    ks: 35,
    strikeouts: 35,
    hits: 45,
    h: 45,
    hrr: 55,
    'h+r+rbi': 55,
    fantasy: 65,
    fs: 65,
    runs: 70,
    r: 70,
    rbi: 75,
    hr: 95,
    walks_allowed: 80,
    earned_runs: 85,
    hits_allowed: 75,
  };
  return table[key] ?? 60;
}

export function calculateRoleStability({ battingOrder, projectedPA, startsLast10, pinchHitRisk = 'low' } = {}) {
  const bo = Number(battingOrder);
  let lineupSpotStability = 25;
  if (bo >= 1 && bo <= 4) lineupSpotStability = 100;
  else if (bo >= 5 && bo <= 6) lineupSpotStability = 80;
  else if (bo >= 7 && bo <= 9) lineupSpotStability = 55;

  const paIndex = projectedPA ? clamp((projectedPA / 4.2) * 100, 0, 120) : lineupSpotStability;
  const startRate = startsLast10 != null ? clamp((startsLast10 / 10) * 100) : 80;
  const pinchSafetyMap = { low: 100, medium: 70, high: 40 };
  const pinchSafety = pinchSafetyMap[String(pinchHitRisk).toLowerCase()] ?? 80;

  const score = (
    0.35 * lineupSpotStability +
    0.30 * paIndex +
    0.20 * startRate +
    0.15 * pinchSafety
  );

  return {
    score: clamp(score),
    tag: score >= 80 ? 'stable' : score >= 60 ? 'medium' : 'volatile',
  };
}

export function calculateTrapScore({ popularityIndex = 0, lineInflationIndex = 100, edgePercent = null, volatility = 60, demonGoblin = false } = {}) {
  const lowEdgeFlag = edgePercent == null ? 0 : edgePercent < 0.10 ? 100 : 0;
  const highVolatilityFlag = volatility >= 65 ? 100 : 0;
  const demonGoblinFlag = demonGoblin ? 100 : 0;

  const score = (
    0.30 * popularityIndex +
    0.25 * Math.max(0, lineInflationIndex - 100) +
    0.20 * lowEdgeFlag +
    0.15 * highVolatilityFlag +
    0.10 * demonGoblinFlag
  );

  return {
    score: clamp(score),
    tag: score >= 75 ? 'trap' : score >= 60 ? 'caution' : 'clean',
  };
}

export function calculateFinalPickScore({ edgePercent = 0, roleStability = 80, matchupScore = 70, environmentFit = 70, volatility = 60, trapScore = 0 } = {}) {
  const edgeScore = clamp((Math.max(0, edgePercent) / 0.20) * 100);
  const varianceSafety = clamp(100 - volatility);
  const trapPenalty = trapScore >= 75 ? 20 : trapScore >= 60 ? 10 : 0;
  const score = (
    0.30 * edgeScore +
    0.20 * roleStability +
    0.20 * matchupScore +
    0.15 * environmentFit +
    0.15 * varianceSafety -
    trapPenalty
  );
  const final = clamp(score);
  return {
    score: Number(final.toFixed(1)),
    label: final >= 85 ? 'NUKE' : final >= 75 ? 'STRONG' : final >= 65 ? 'STANDARD' : 'PASS',
    useCase: final >= 85 ? 'flex_or_power' : final >= 75 ? 'flex_preferred' : final >= 65 ? 'flex_only' : 'avoid',
  };
}

export function applyPropTranslation({ gameType, propKey, baseScore = 0 }) {
  const key = String(propKey || '').toUpperCase();
  const isFantasy = key.includes('FS');
  const isHRR = key === 'HRR';
  const isHR = key === 'HR';
  let adjustment = 0;
  let note = 'Neutral environment fit';

  if (gameType === 'power_scoring') {
    if (isFantasy) { adjustment += 8; note = 'Power game boosts fantasy-score overs'; }
    else if (isHRR) { adjustment += 5; note = 'Power game modestly boosts HRR'; }
    else if (isHR) { adjustment += 8; note = 'Power game boosts HR path'; }
  } else if (gameType === 'contact_sequencing') {
    if (isHRR) { adjustment += 5; note = 'Contact/sequencing game fits HRR better than FS'; }
    else if (isFantasy) { adjustment -= 8; note = 'Contact game downgrades fantasy-score ceiling'; }
    else if (isHR) { adjustment -= 10; note = 'Contact game suppresses HR path'; }
  } else if (gameType === 'suppressed_game') {
    if (isFantasy || isHRR || isHR) { adjustment -= 8; note = 'Suppressed game downgrades hitter overs'; }
  } else if (gameType === 'full_offensive_environment') {
    if (isFantasy || isHRR) { adjustment += 4; note = 'Full offensive environment supports hitter props'; }
  }

  return {
    score: baseScore + adjustment,
    adjustment,
    note,
  };
}

// Main integration helper for analyze.js. Uses data that already exists in the engine.
export function evaluateHitterPropContext({
  hitter,
  overall = {},
  matchedPitches = [],
  maxXwoba = 0,
  adjustedMaxXwoba = 0,
  adjustedEdgeScore = 0,
  parkFactor = null,
  weatherImpact = null,
  bullpenMaxXwoba = 0,
  bullpenTier = null,
  battingOrder = null,
  propRecs = [],
  tier = null,
  inningSplits = null,
  bullpenProfile = null,
  pitcherRole = null,
} = {}) {
  const barrel = num(overall.barrel_batted_rate?.value, 0);
  const hardHit = num(overall.hard_hit_percent?.value, 0);
  const kPct = num(overall.k_percent?.value, 22);
  const bbPct = num(overall.bb_percent?.value, 8);
  const seasonXwoba = num(overall.xwoba?.value, 0.320);
  const maxX = num(adjustedMaxXwoba || maxXwoba, 0.320);
  const bpX = num(bullpenMaxXwoba, 0.300);

  const batHand = hitter?.hand === 'L' ? 'L' : 'R';
  const parkHr = parkFactor ? (batHand === 'L' ? (parkFactor.lhbHr || parkFactor.hr || 100) : (parkFactor.rhbHr || parkFactor.hr || 100)) : 100;
  const parkRuns = parkFactor ? (parkFactor.runs || 100) : 100;

  const weatherHrFactor = weatherImpact?.hrFactor ? weatherImpact.hrFactor * 100
    : weatherImpact?.homeRunFactor ? weatherImpact.homeRunFactor * 100
    : weatherImpact?.powerFactor ? weatherImpact.powerFactor * 100
    : 100;

  // Convert available hitter/matchup signals onto 0-100 index scale.
  const teamHrIndex = clamp((barrel / 8.5) * 100, 60, 150);      // 8.5% barrel as rough league baseline
  const xbhIndex = clamp((hardHit / 38) * 100, 60, 150);         // 38% hard-hit as rough baseline
  const pitcherHrWeakness = clamp((maxX / 0.320) * 100, 70, 150);
  const contactRateIndex = clamp(((100 - kPct) / 78) * 100, 60, 135);
  const obpIndex = clamp((seasonXwoba / 0.320) * 100, 60, 140);
  const kSuppressionIndex = clamp((22 / Math.max(8, kPct)) * 100, 60, 150);
  const bullpenXwobaIndex = clamp((bpX / 0.320) * 100, 70, 150);
  const babipRunProfile = clamp(((hardHit * 0.60 + bbPct * 1.5) / 30) * 100, 60, 140);

  const rpi = calculateRunPowerIndex({
    teamHrIndex,
    xbhIndex,
    parkHrFactor: parkHr,
    weatherHrFactor,
    pitcherHrWeakness,
  });
  const rci = calculateRunContactIndex({
    contactRateIndex,
    obpIndex,
    kSuppressionIndex,
    bullpenXwobaIndex,
    babipRunProfile,
  });
  const gameType = classifyGameType(rpi, rci);
  const role = calculateRoleStability({ battingOrder: battingOrder || hitter?.battingOrder });

  const recentIp = pitcherRole?.avgIP || pitcherRole?.projectedIP || inningSplits?.avgIP || 5.2;
  const starterShortness = clamp((5.4 / Math.max(3.0, num(recentIp, 5.2))) * 100, 70, 150);
  const bullpenWeaknessForLate = bullpenXwobaIndex;
  const bullpenFatigue = bullpenProfile?.fatigueIndex || bullpenProfile?.recentUsageIndex || 100;
  const lineupLateScoring = inningSplits?.lineupLateScoringIndex || 100;
  const lateInningEquity = calculateLateInningEquity({
    starterShortness,
    bullpenWeakness: bullpenWeaknessForLate,
    bullpenFatigue,
    lineupLateScoring,
  });

  const matchupScore = clamp((maxX / 0.420) * 100, 0, 100);
  const environmentFitBase = gameType === 'power_scoring' ? 78
    : gameType === 'contact_sequencing' ? 72
    : gameType === 'full_offensive_environment' ? 82
    : gameType === 'suppressed_game' ? 45
    : 65;

  const enhancedPropRecs = (propRecs || []).map((p) => {
    const key = p.key || p.type || '';
    const propType = key.includes('FS') ? 'fantasy' : key === 'HRR' ? 'hrr' : key === 'HR' ? 'hr' : key === 'H' ? 'hits' : String(key).toLowerCase();
    const volatility = getBaseVolatility(propType);
    const translated = applyPropTranslation({ gameType, propKey: key, baseScore: num(p.score, 0) });
    const side = String(p.side || p.recommendation || p.direction || 'over').toLowerCase().includes('under') || String(p.side || '').toLowerCase().includes('less') ? 'under' : 'over';
    const projection = p.projection ?? p.projected ?? p.proj ?? null;
    const line = p.line ?? p.marketLine ?? p.prizePicksLine ?? p.underdogLine ?? null;
    const lineEfficiency = detectLineEfficiency({ projection, line, side, propType });

    // Existing prop score is a heuristic, not a book-line edge. Convert it into a conservative edge proxy
    // until live PrizePicks/Underdog lines are added. If a real line exists, use the real edge.
    const edgePercentProxy = lineEfficiency.available
      ? lineEfficiency.edgePercent
      : clamp((translated.score - 60) / 200, -0.10, 0.25);
    const trap = calculateTrapScore({ edgePercent: edgePercentProxy, volatility });
    const final = calculateFinalPickScore({
      edgePercent: edgePercentProxy,
      roleStability: role.score,
      matchupScore,
      environmentFit: environmentFitBase + translated.adjustment + (lateInningEquity.score >= 115 && (propType === 'hrr' || propType === 'fantasy') ? 4 : 0),
      volatility,
      trapScore: trap.score,
    });

    return {
      ...p,
      score: Number(translated.score.toFixed(1)),
      propLayer: {
        baseVolatility: volatility,
        varianceTag: volatility >= 75 ? 'extreme' : volatility >= 60 ? 'high' : volatility >= 40 ? 'medium' : 'low',
        environmentAdjustment: translated.adjustment,
        environmentNote: translated.note,
        edgePercentProxy: Number(edgePercentProxy.toFixed(3)),
        lineEfficiency,
        lateInningEquity,
        trap,
        final,
      },
    };
  }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  enhancedPropRecs.forEach((p, i) => {
    p.rank = i;
    p.isBest = i === 0;
  });

  const warnings = [];
  if (gameType === 'contact_sequencing') warnings.push('Contact/sequencing profile: avoid blindly stacking fantasy-score overs. Prefer HRR/low lines or pitcher K unders.');
  if (gameType === 'suppressed_game') warnings.push('Suppressed environment: hitter overs need large line cushion.');
  if (role.tag === 'volatile') warnings.push('Role volatility: bottom-order or uncertain PA profile.');
  if (lateInningEquity.tag === 'strong_late_boost') warnings.push('Strong late-inning equity: bullpen/starter-shortness improves late run conversion paths.');
  if (barrel < 8 && enhancedPropRecs.some(p => String(p.key).includes('FS'))) warnings.push('Low barrel profile: fantasy score overs need multi-event path.');

  return {
    version: 'prop-context-v1',
    environment: {
      rpi: Number(rpi.toFixed(1)),
      rci: Number(rci.toFixed(1)),
      delta: Number((rpi - rci).toFixed(1)),
      gameType,
      tags: {
        power: rpi >= 115 ? 'power_game' : rpi >= 95 ? 'mixed_power' : 'power_suppressed',
        contact: rci >= 110 ? 'contact_run_game' : rci >= 95 ? 'mixed_contact' : 'contact_suppressed',
      },
    },
    roleStability: role,
    lateInningEquity,
    matchupScore: Number(matchupScore.toFixed(1)),
    bestPropType: gameType === 'power_scoring' ? 'Fantasy Score / HR / TB overs'
      : gameType === 'contact_sequencing' ? 'H+R+RBI, hits, or pitcher K unders'
      : gameType === 'suppressed_game' ? 'Hitter unders / pass overs'
      : 'Selective props only',
    warnings,
    propRecs: enhancedPropRecs,
  };
}

export function shouldPassDemonGoblin({ desiredSide, allowedSide, finalScore, edgePercent, trapScore }) {
  if (!desiredSide || !allowedSide || desiredSide === allowedSide) return false;
  const allowException = finalScore >= 85 && edgePercent >= 0.18 && trapScore < 60;
  return !allowException;
}
