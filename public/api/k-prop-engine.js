// api/_lib/k-prop-engine.js
// Pitcher strikeout prop helper layer for Mismatch Finder.
// Pure functions only: no network calls, safe fallbacks, Vercel-friendly.

const LEAGUE_K_RATE = 0.22;
const LEAGUE_WHIFF_RATE = 0.25;
const DEFAULT_AVG_IP = 5.0;
const BATTERS_PER_INNING = 3.9;

function num(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 100) {
  const n = num(value, min);
  return Math.max(min, Math.min(max, n));
}

function pctToRate(value, fallback = 0) {
  const n = num(value, fallback);
  if (!Number.isFinite(n)) return fallback;
  return n > 1 ? n / 100 : n;
}

function weightedAverage(items, valueKeys, weightKeys) {
  let weighted = 0;
  let totalWeight = 0;

  for (const item of items || []) {
    const value = firstNumber(item, valueKeys, null);
    if (value == null) continue;

    const rawWeight = firstNumber(item, weightKeys, 1);
    const weight = Math.max(0, rawWeight > 1 ? rawWeight / 100 : rawWeight);

    weighted += value * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weighted / totalWeight : null;
}

function firstNumber(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      const n = Number.parseFloat(obj[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

export function summarizePitcherArsenalForKModel(pitches = []) {
  const whiffRaw = weightedAverage(
    pitches,
    ['whiff', 'whiffPct', 'whiff_percent', 'whiffRate', 'whiff_rate', 'whiff%'],
    ['usage', 'usagePct', 'pitch_percent', 'pitchPercent', 'pct', 'percentage']
  );

  const cswRaw = weightedAverage(
    pitches,
    ['csw', 'cswPct', 'csw_percent', 'cswRate', 'calledStrikesWhiffs'],
    ['usage', 'usagePct', 'pitch_percent', 'pitchPercent', 'pct', 'percentage']
  );

  const avgUsage = weightedAverage(
    pitches,
    ['usage', 'usagePct', 'pitch_percent', 'pitchPercent', 'pct', 'percentage'],
    ['usage', 'usagePct', 'pitch_percent', 'pitchPercent', 'pct', 'percentage']
  );

  return {
    pitchCount: Array.isArray(pitches) ? pitches.length : 0,
    whiffRate: pctToRate(whiffRaw, LEAGUE_WHIFF_RATE),
    cswRate: pctToRate(cswRaw, 0.28),
    avgUsage: pctToRate(avgUsage, 0.25),
  };
}

export function calculateExpectedKs({
  pitcherKRate = LEAGUE_K_RATE,
  opponentKRate = LEAGUE_K_RATE,
  whiffRate = LEAGUE_WHIFF_RATE,
  avgIP = DEFAULT_AVG_IP,
  expectedBatters = null,
} = {}) {
  const pK = pctToRate(pitcherKRate, LEAGUE_K_RATE);
  const oK = pctToRate(opponentKRate, LEAGUE_K_RATE);
  const whiff = pctToRate(whiffRate, LEAGUE_WHIFF_RATE);
  const innings = Math.max(1, num(avgIP, DEFAULT_AVG_IP));

  // Opponent K% below league suppresses pitcher Ks; above league boosts them.
  const opponentAdjustment = oK / LEAGUE_K_RATE;

  // Whiff quality controls whether K rate is sticky or fragile.
  const whiffAdjustment = 1 + ((whiff - LEAGUE_WHIFF_RATE) * 0.9);

  const adjustedKRate = Math.max(0.05, pK * opponentAdjustment * whiffAdjustment);
  const batters = expectedBatters != null ? num(expectedBatters, innings * BATTERS_PER_INNING) : innings * BATTERS_PER_INNING;

  return adjustedKRate * batters;
}

export function calculateKSuppressionIndex({
  opponentKRate = LEAGUE_K_RATE,
  opponentContactRate = 0.76,
  avgIP = DEFAULT_AVG_IP,
  recentKsPerStart = null,
  seasonKsPerStart = null,
} = {}) {
  const oK = pctToRate(opponentKRate, LEAGUE_K_RATE);
  const contact = pctToRate(opponentContactRate, 0.76);
  const innings = Math.max(1, num(avgIP, DEFAULT_AVG_IP));

  const lineupResistance = (LEAGUE_K_RATE / Math.max(0.12, oK)) * 100;
  const contactVsArsenal = (contact / 0.76) * 100;
  const leashRisk = (5.0 / innings) * 100;

  let recentDowntrend = 100;
  if (recentKsPerStart != null && seasonKsPerStart != null) {
    recentDowntrend = (num(seasonKsPerStart, 4) / Math.max(1, num(recentKsPerStart, 4))) * 100;
  }

  return (
    0.35 * lineupResistance +
    0.25 * contactVsArsenal +
    0.20 * leashRisk +
    0.20 * recentDowntrend
  );
}

export function gradePitcherKUnder({
  expectedKs,
  line = null,
  ksi = 100,
  volatility = 35,
} = {}) {
  const projection = num(expectedKs, null);
  const propLine = line == null ? null : num(line, null);
  const kSuppression = num(ksi, 100);

  // Without a real PrizePicks line, grade model context but avoid fake edge labels.
  if (projection == null || propLine == null || propLine <= 0) {
    const contextScore = clamp(0.55 * kSuppression + 0.45 * (100 - volatility));
    return {
      side: 'under',
      line: null,
      edge: null,
      edgePercent: null,
      score: Number(contextScore.toFixed(1)),
      label: contextScore >= 80 ? 'STRONG_CONTEXT' : contextScore >= 65 ? 'STANDARD_CONTEXT' : 'PASS_CONTEXT',
      note: 'Add a real prop line to convert context into a bet grade.',
    };
  }

  const edge = propLine - projection;
  const edgePercent = edge / propLine;
  const edgeScore = clamp((edgePercent / 0.20) * 100);
  const varianceSafety = 100 - volatility;

  let score = 0.45 * edgeScore + 0.30 * kSuppression + 0.25 * varianceSafety;
  score = clamp(score);

  let label = 'PASS';
  if (score >= 85 && edge > 0) label = 'NUKE';
  else if (score >= 75 && edge > 0) label = 'STRONG';
  else if (score >= 65 && edge > 0) label = 'STANDARD';

  if (kSuppression >= 115 && edgePercent >= 0.12) label = 'NUKE';
  if (edgePercent < 0.08) label = 'PASS';

  return {
    side: 'under',
    line: propLine,
    edge: Number(edge.toFixed(2)),
    edgePercent: Number(edgePercent.toFixed(3)),
    score: Number(score.toFixed(1)),
    label,
  };
}

export function buildPitcherKPropModel({
  pitches = [],
  pitcher = {},
  opponent = {},
  line = null,
} = {}) {
  const arsenalSummary = summarizePitcherArsenalForKModel(pitches);

  const pitcherKRate = pitcher.kRate ?? pitcher.k_percent ?? pitcher.kPercent ?? LEAGUE_K_RATE;
  const opponentKRate = opponent.kRate ?? opponent.k_percent ?? opponent.kPercent ?? LEAGUE_K_RATE;
  const opponentContactRate = opponent.contactRate ?? opponent.contact_percent ?? opponent.contactPercent ?? 0.76;
  const avgIP = pitcher.avgIP ?? pitcher.avgIp ?? pitcher.recentAvgIP ?? DEFAULT_AVG_IP;

  const expectedKs = calculateExpectedKs({
    pitcherKRate,
    opponentKRate,
    whiffRate: pitcher.whiffRate ?? arsenalSummary.whiffRate,
    avgIP,
    expectedBatters: pitcher.expectedBatters,
  });

  const ksi = calculateKSuppressionIndex({
    opponentKRate,
    opponentContactRate,
    avgIP,
    recentKsPerStart: pitcher.recentKsPerStart,
    seasonKsPerStart: pitcher.seasonKsPerStart,
  });

  const underGrade = gradePitcherKUnder({ expectedKs, line, ksi });

  return {
    expectedKs: Number(expectedKs.toFixed(2)),
    ksi: Number(ksi.toFixed(1)),
    arsenalSummary: {
      pitchCount: arsenalSummary.pitchCount,
      whiffRate: Number(arsenalSummary.whiffRate.toFixed(3)),
      cswRate: Number(arsenalSummary.cswRate.toFixed(3)),
    },
    under: underGrade,
    warnings: buildKWarnings({ expectedKs, ksi, line }),
  };
}

function buildKWarnings({ expectedKs, ksi, line }) {
  const warnings = [];
  if (ksi >= 115) warnings.push('K suppression profile: opponent/contact/leash supports unders.');
  if (line != null && expectedKs >= line) warnings.push('Projection is not below the line; do not force an under.');
  if (line == null) warnings.push('No real prop line supplied yet; use this as context only.');
  return warnings;
}
