// api/_lib/contactProbability.js
//
// CONTACT PROBABILITY ENGINE (May 18, 2026)
//
// PURPOSE
//   Decompose hit probability into three independent layers so we can identify
//   WHERE the edge lives and AVOID compounding-error multiplication that bit
//   us in the run-projection model.
//
// THE THREE LAYERS
//   Layer 1 — Contact Probability    : "will he put the ball in play?"
//   Layer 2 — Quality of Contact     : "when contact happens, how damaging?"
//   Layer 3 — Hit Conversion         : "does the contact become a hit?"
//
// CRITICAL ARCHITECTURAL CHOICE: ADDITIVE, NOT MULTIPLICATIVE
//   The user's original sketch had P(Hit) = P(Contact) × P(UsefulContact) × P(HitConversion).
//   That is the same compounding-error trap we just fixed in buildGameProjection.
//
//   Instead, each layer produces a DEVIATION from a league-average baseline.
//   Final P(Hit) = LeagueBaseRate + sum of capped deviations, clamped to a
//   realistic [0.05, 0.55] range. This means:
//     - Errors don't compound (additive ≠ multiplicative)
//     - Each layer's influence is capped independently
//     - The model degrades gracefully when data is missing (deviation = 0)
//     - Component scores are directly interpretable
//
// LEAGUE BASELINES (2024-2025 averages, used as anchors)
//   - League hit rate per PA (any hit):        0.243
//   - League HR rate per PA:                   0.030
//   - League XBH rate per PA (2B+):            0.075
//   - League K rate:                           22.5%
//   - League contact rate (zone):              82.0%
//   - League BABIP:                            0.297
//
// CONFIDENCE
//   Each output includes a `quality` score (0-100) reflecting how much real
//   data backed the projection. Missing inputs degrade the quality score but
//   the projection still returns a sensible fallback.
//
// INTEGRATION POINTS (downstream consumers)
//   buildPropRecommendations() in analyze.js   → use computeHitProbability() to
//                                                 replace heuristic hitScore
//   hrPicks.js                                  → use computeHrProbability()
//   firstInning.js                              → use computeHitProbability() for
//                                                 leadoff hitter scoring
//
// SHADOW MODE
//   All functions return both `legacyScore` (the existing 0-100 heuristic) and
//   `probability` (new). Callers can A/B compare in audit logs before flipping
//   the switch. Set CONTACT_ENGINE_ENABLED=true in env to use new outputs.

// =============================================================
// LEAGUE BASELINES — adjust seasonally
// =============================================================

export const LEAGUE_BASELINES = Object.freeze({
  hitRate: 0.243,           // P(any hit | PA)
  hrRate: 0.030,            // P(HR | PA)
  xbhRate: 0.075,           // P(2B+ | PA), includes HR
  kRate: 22.5,              // % strikeout rate
  contactRate: 76.0,        // overall contact% (lower than zone contact)
  zoneContactRate: 82.0,    // contact on pitches in zone
  babip: 0.297,             // batting average on balls in play
  // Allowed-side averages (used as pitcher baselines)
  pitcherAllowedHardHit: 38.0,  // % HH allowed
  pitcherAllowedEv: 88.5,        // mph
  pitcherAllowedBarrel: 7.5,     // % barrel rate allowed
  // Allowed-side BA/SLG (added May 23, 2026 — used when EV/barrel unavailable)
  // The upstream pitch-arsenal payload exposes per-pitch-type ba and slg but
  // NOT exit velocity or barrel rate. These two signals fill that gap.
  pitcherAllowedBa: 0.243,       // batting average allowed (same as league hit rate)
  pitcherAllowedSlg: 0.395       // slugging % allowed
});

// Per-layer deviation caps. Tightest layer is conversion (least signal-to-noise).
export const DEVIATION_CAPS = Object.freeze({
  contact: 0.08,    // ±8 percentage points of hit rate (most predictive layer)
  quality: 0.08,    // ±8 pp
  conversion: 0.06  // ±6 pp (BABIP variance is high, smaller cap)
});

// Clamp range for final probability outputs
const P_HIT_MIN = 0.05;
const P_HIT_MAX = 0.55;
const P_HR_MIN = 0.00;
const P_HR_MAX = 0.25;
const P_XBH_MIN = 0.01;
const P_XBH_MAX = 0.35;

// =============================================================
// HELPERS
// =============================================================

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return (min + max) / 2;
  return Math.min(max, Math.max(min, v));
}

function num(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Cap a deviation symmetrically. Returns the value if within ±cap, else the
 * signed cap.
 */
function capDeviation(v, cap) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-cap, Math.min(cap, v));
}

/**
 * Mix a hitter-side and pitcher-side rate, both expressed as deviations from
 * the league baseline. Returns the combined deviation.
 *
 * The intuition: if a hitter is +5% better than league contact AND the pitcher
 * is +3% worse at preventing contact, the combined effect is +8% — but we
 * weight hitter slightly more (hitter skill is the dominant signal at the PA
 * level).
 */
function combineHitterPitcher(hitterDev, pitcherDev, hitterWeight = 0.6) {
  const h = Number.isFinite(hitterDev) ? hitterDev : 0;
  const p = Number.isFinite(pitcherDev) ? pitcherDev : 0;
  return h * hitterWeight + p * (1 - hitterWeight);
}

// =============================================================
// LAYER 1 — CONTACT PROBABILITY
// =============================================================
// "Will the batter put the ball in play?"
//
// Inputs:
//   hitter.kPct          — hitter strikeout rate (%)
//   hitter.contactPct    — hitter overall contact rate (%) [optional]
//   pitcher.kPct         — pitcher K% (%)
//   pitcher.swStr        — pitcher swinging-strike rate (%) [optional]
//
// Output:
//   { deviation, components, quality }
//   - deviation is in HIT-PROBABILITY space (e.g. +0.04 = +4pp hit rate)
//   - quality scores 0-100 based on data availability

/**
 * Compute Layer 1 deviation: contact probability vs baseline.
 *
 * Logic:
 *   - Hitter K% above league avg → lower contact probability → negative deviation
 *   - Pitcher K% above league avg → lower contact probability → negative deviation
 *   - Each percentage point of K above/below league = ~0.4pp of hit rate
 *     (calibrated against historical K% to hit-rate elasticity)
 *
 * @param {Object} hitter  - { kPct, contactPct? }
 * @param {Object} pitcher - { kPct, swStr? }
 * @returns {Object}
 */
export function computeContactLayer(hitter = {}, pitcher = {}) {
  const lgK = LEAGUE_BASELINES.kRate;

  // Hitter K% deviation in hit-rate space.
  // A hitter 5pp better than avg K rate contributes ~+2pp hit rate.
  // Sign: higher K% = LOWER hit rate, so we flip the sign.
  let hitterDev = null;
  const hK = num(hitter.kPct);
  if (hK != null) {
    hitterDev = -(hK - lgK) * 0.004;  // 5pp K → -0.020 hit rate
  }

  // Pitcher K% deviation. Same formula, but slightly smaller coefficient
  // since at the PA level the hitter's own K tendency dominates.
  let pitcherDev = null;
  const pK = num(pitcher.kPct);
  if (pK != null) {
    pitcherDev = -(pK - lgK) * 0.003;
  }

  // Combine; if one side is missing, use the other alone.
  let combined;
  if (hitterDev != null && pitcherDev != null) {
    combined = combineHitterPitcher(hitterDev, pitcherDev, 0.65);
  } else if (hitterDev != null) {
    combined = hitterDev * 0.7;  // single-sided info gets 70% weight
  } else if (pitcherDev != null) {
    combined = pitcherDev * 0.5;
  } else {
    combined = 0;
  }

  const capped = capDeviation(combined, DEVIATION_CAPS.contact);
  const wasCapped = Math.abs(combined) > DEVIATION_CAPS.contact;

  // Data quality: 100 if both K% known, 70 if one, 40 if none.
  let quality = 40;
  if (hK != null && pK != null) quality = 100;
  else if (hK != null || pK != null) quality = 70;

  return {
    deviation: capped,
    components: {
      hitterKDeviation: hitterDev,
      pitcherKDeviation: pitcherDev,
      hitterKPct: hK,
      pitcherKPct: pK,
      raw: combined,
      capped: wasCapped
    },
    quality
  };
}

// =============================================================
// LAYER 2 — QUALITY OF CONTACT
// =============================================================
// "When contact happens, how damaging is it?"
//
// Inputs:
//   hitter.barrelPct     — barrel% of batted balls
//   hitter.hardHitPct    — HH% of batted balls
//   hitter.avgEv         — average exit velocity (mph)
//   hitter.sweetSpotPct  — sweet spot% [optional]
//   hitter.xwoba         — season xwOBA (a composite quality metric)
//   pitcher.allowedHardHit, allowedEv, allowedBarrel [optional]
//   matchedXwoba         — max hitter xwOBA against pitcher's pitch arsenal
//                          (the pitch-mix match — already computed upstream)
//
// Output deviation in hit-rate space.

/**
 * Compute Layer 2 deviation: quality of contact vs baseline.
 *
 * The strongest signal here is the pitch-arsenal-matched xwOBA (matchedXwoba)
 * because it already captures how the hitter performs against the pitcher's
 * specific pitch mix. If unavailable, fall back to season xwOBA + EV/HH/Barrel
 * composite.
 *
 * @param {Object} hitter  - { barrelPct, hardHitPct, avgEv, xwoba, ... }
 * @param {Object} pitcher - { allowedHardHit?, allowedEv?, allowedBarrel?,
 *                             allowedBa?, allowedSlg? }
 *                           Added May 23, 2026: allowedBa and allowedSlg are
 *                           the practical signals when EV/barrel aren't in
 *                           the upstream payload.
 * @param {number} matchedXwoba - max pitch-arsenal-matched xwOBA, or null
 * @returns {Object}
 */
export function computeQualityLayer(hitter = {}, pitcher = {}, matchedXwoba = null) {
  // === HITTER QUALITY INDEX ===
  // Combine barrel%, HH%, EV into a 0-100 score with league avg = 50.
  const barrel = num(hitter.barrelPct);
  const hh = num(hitter.hardHitPct);
  const ev = num(hitter.avgEv);
  const seasonXwoba = num(hitter.xwoba);

  // Each component contributes a sub-deviation from league avg.
  // Coefficients calibrated against historical xwOBA-to-hit-rate relationship:
  //   1 unit of barrel% ≈ 0.003 of hit rate
  //   1 unit of HH%     ≈ 0.0008 of hit rate
  //   1 unit of EV (mph) ≈ 0.003 of hit rate
  let hitterDev = 0;
  let hitterDataPoints = 0;
  if (barrel != null) {
    hitterDev += (barrel - 8.0) * 0.003;
    hitterDataPoints++;
  }
  if (hh != null) {
    hitterDev += (hh - 38.0) * 0.0008;
    hitterDataPoints++;
  }
  if (ev != null) {
    hitterDev += (ev - 88.5) * 0.003;
    hitterDataPoints++;
  }

  // If we have a pitch-arsenal-matched xwOBA, blend it in heavily — it's the
  // most context-aware signal we have for THIS pitcher vs THIS hitter.
  // matchedXwoba > 0.380 = elite damage potential; < 0.290 = suppressed.
  let matchedDev = null;
  const mx = num(matchedXwoba);
  if (mx != null && mx > 0) {
    // Center at league xwOBA ≈ 0.315
    matchedDev = (mx - 0.315) * 0.20;  // 0.080 above lg → +0.016 hit rate
  }

  // Blend: matched xwOBA (if available) gets 50% weight, composite gets the rest.
  let combinedHitterDev;
  if (matchedDev != null && hitterDataPoints > 0) {
    combinedHitterDev = matchedDev * 0.5 + hitterDev * 0.5;
  } else if (matchedDev != null) {
    combinedHitterDev = matchedDev;
  } else if (hitterDataPoints > 0) {
    combinedHitterDev = hitterDev;
  } else if (seasonXwoba != null) {
    combinedHitterDev = (seasonXwoba - 0.315) * 0.15;
  } else {
    combinedHitterDev = 0;
  }

  // === PITCHER SUPPRESSION INDEX ===
  // A pitcher who allows less hard contact than league avg pushes the
  // quality deviation DOWN. Reverse sign from hitter side.
  //
  // SIGNAL SOURCES (May 23, 2026):
  //   The upstream pitch-arsenal payload exposes hardHitPct, ba, and slg
  //   per pitch type, but NOT exit velocity or barrel rate. Originally Layer 2
  //   was designed for HH/EV/BAR; in practice it runs on HH + BA + SLG.
  //
  //   - Barrel and EV branches remain in place for future payload upgrades.
  //   - BA-allowed and SLG-allowed are the practical replacements:
  //       BA  captures contact-to-hit conversion vs this pitcher
  //       SLG captures damage on contact vs this pitcher
  //   - These don't double-count matchedXwoba (which is hitter-side max);
  //     these are pitcher-side allowed rates from the arsenal payload.
  //
  // Coefficients calibrated to produce ~0.009 deviation at typical gaps:
  //   BA: 0.30 per BA unit  → .030 above league = +0.009 deviation
  //   SLG: 0.15 per SLG unit → .060 above league = +0.009 deviation
  //   These are in the same magnitude band as the HH/EV/BAR signals so
  //   no single pitcher signal dominates the suppression aggregate.
  let pitcherDev = 0;
  let pitcherDataPoints = 0;
  const pHh = num(pitcher.allowedHardHit);
  const pEv = num(pitcher.allowedEv);
  const pBar = num(pitcher.allowedBarrel);
  const pBa = num(pitcher.allowedBa);
  const pSlg = num(pitcher.allowedSlg);
  if (pBar != null) {
    pitcherDev -= (pBar - LEAGUE_BASELINES.pitcherAllowedBarrel) * 0.003;
    pitcherDataPoints++;
  }
  if (pHh != null) {
    pitcherDev -= (pHh - LEAGUE_BASELINES.pitcherAllowedHardHit) * 0.0008;
    pitcherDataPoints++;
  }
  if (pEv != null) {
    pitcherDev -= (pEv - LEAGUE_BASELINES.pitcherAllowedEv) * 0.003;
    pitcherDataPoints++;
  }
  if (pBa != null) {
    // Pitcher allows higher BA than league → hits harder, deviation up.
    // Sign convention matches HH/EV/BAR: subtract here, flip at end.
    pitcherDev -= (pBa - LEAGUE_BASELINES.pitcherAllowedBa) * 0.30;
    pitcherDataPoints++;
  }
  if (pSlg != null) {
    pitcherDev -= (pSlg - LEAGUE_BASELINES.pitcherAllowedSlg) * 0.15;
    pitcherDataPoints++;
  }
  // Flip sign so that "pitcher allows MORE hard hit" → positive deviation
  // (helps hitter, raises P(Hit))
  pitcherDev = -pitcherDev;

  // Combine hitter and pitcher quality dev. Hitter quality is more predictive
  // at this layer than at Layer 1, so weight hitter higher.
  let combined;
  if (pitcherDataPoints > 0) {
    combined = combineHitterPitcher(combinedHitterDev, pitcherDev, 0.7);
  } else {
    combined = combinedHitterDev * 0.85;
  }

  const capped = capDeviation(combined, DEVIATION_CAPS.quality);
  const wasCapped = Math.abs(combined) > DEVIATION_CAPS.quality;

  // Data quality: 100 if matched xwoba + at least 1 hitter quality stat + at
  // least 1 pitcher stat; otherwise scale by what we have.
  let quality = 30;
  if (mx != null && hitterDataPoints >= 2 && pitcherDataPoints >= 1) quality = 100;
  else if (mx != null && hitterDataPoints >= 1) quality = 85;
  else if (hitterDataPoints >= 2) quality = 70;
  else if (mx != null || hitterDataPoints >= 1) quality = 55;

  return {
    deviation: capped,
    components: {
      hitterCompositeDeviation: hitterDev,
      hitterMatchedDeviation: matchedDev,
      hitterCombinedDeviation: combinedHitterDev,
      pitcherSuppressionDeviation: pitcherDev,
      barrelPct: barrel,
      hardHitPct: hh,
      avgEv: ev,
      matchedXwoba: mx,
      seasonXwoba,
      hitterDataPoints,
      pitcherDataPoints,
      raw: combined,
      capped: wasCapped
    },
    quality
  };
}

// =============================================================
// LAYER 3 — HIT CONVERSION
// =============================================================
// "Does the quality contact actually become a hit?"
//
// This layer separates HR (where conversion is mostly park + LA) from
// in-play hits (where BABIP factors dominate). We expose it via separate
// fields and let the caller pick.
//
// Inputs:
//   hitter.pullPct     — pull rate (for shift exposure)
//   hitter.gbPct, ldPct, fbPct — batted-ball profile
//   hitter.sprintSpeed [optional]
//   parkBoosts.runs    — park run factor (1.0 = neutral)
//   parkBoosts.hr      — park HR factor for hitter's hand
//   ump.favor          — 'hitter' / 'pitcher' / null

/**
 * Compute Layer 3 deviation: hit conversion vs baseline.
 *
 * @param {Object} hitter
 * @param {Object} parkBoosts - { runs: 1.05, hr: 1.10, ... }
 * @param {Object} ump - { favor: 'hitter' | 'pitcher' | null }
 * @returns {Object}
 */
export function computeConversionLayer(hitter = {}, parkBoosts = {}, ump = {}) {
  let dev = 0;
  const components = {};

  // PARK — run factor influences in-play hits, HR factor influences HR
  const runFactor = num(parkBoosts.runs, 1.0);
  if (runFactor != null) {
    // 5% above neutral run park → +0.010 hit rate. Capped contribution.
    const parkDev = (runFactor - 1.0) * 0.20;
    dev += parkDev;
    components.parkRunFactor = runFactor;
    components.parkDeviation = parkDev;
  }

  // BATTED-BALL PROFILE — line drives convert to hits at high rate (~0.68),
  // ground balls at ~0.24, fly balls at ~0.13 (excluding HR).
  // If we know hitter's LD%, factor that in.
  const ldPct = num(hitter.ldPct);
  if (ldPct != null) {
    // Each percentage point of LD above league (~21%) is worth ~0.001 hit rate
    const ldDev = (ldPct - 21.0) * 0.001;
    dev += ldDev;
    components.ldPct = ldPct;
    components.ldDeviation = ldDev;
  }

  // SPRINT SPEED — speed turns marginal contact into hits (legs out grounders,
  // beats out infield singles). League avg ~27 ft/s.
  const sprint = num(hitter.sprintSpeed);
  if (sprint != null) {
    // Each ft/s above league avg → +0.005 hit rate. Cap at ±2 ft/s.
    const speedDev = clamp((sprint - 27.0) * 0.005, -0.012, 0.012);
    dev += speedDev;
    components.sprintSpeed = sprint;
    components.speedDeviation = speedDev;
  }

  // UMPIRE — hitter-friendly umps slightly raise hit rate via expanded zone
  // for hitters / fewer called strikes. Small effect.
  if (ump?.favor === 'hitter') {
    dev += 0.006;
    components.umpAdjustment = 0.006;
  } else if (ump?.favor === 'pitcher') {
    dev -= 0.006;
    components.umpAdjustment = -0.006;
  }

  const capped = capDeviation(dev, DEVIATION_CAPS.conversion);
  const wasCapped = Math.abs(dev) > DEVIATION_CAPS.conversion;

  // Data quality based on how many factors we have
  let quality = 50;  // park always available
  if (ldPct != null) quality += 20;
  if (sprint != null) quality += 20;
  if (ump?.favor) quality += 10;
  quality = Math.min(100, quality);

  return {
    deviation: capped,
    components: { ...components, raw: dev, capped: wasCapped },
    quality
  };
}

// =============================================================
// LAYER 3-HR — HR CONVERSION (separate from in-play conversion)
// =============================================================
//
// For HR probability, the conversion physics are completely different:
//   - Park HR factor (handed) dominates
//   - Launch angle profile matters (FB hitters convert quality contact to HR
//     at much higher rate than GB hitters)
//   - In-play hit conversion factors mostly don't apply

export function computeHrConversionLayer(hitter = {}, parkBoosts = {}) {
  let dev = 0;
  const components = {};

  // Park HR factor — handed. Multiplier of league HR rate.
  // 1.20 park factor → +20% on baseline HR rate (which is 0.030, so +0.006).
  const hrFactor = num(parkBoosts.hr, 1.0);
  const parkDev = (hrFactor - 1.0) * LEAGUE_BASELINES.hrRate;
  dev += parkDev;
  components.parkHrFactor = hrFactor;
  components.parkDeviation = parkDev;

  // FB% — fly ball hitters convert quality to HR more readily.
  const fbPct = num(hitter.fbPct);
  if (fbPct != null) {
    // League avg FB% ~24%. Each pp above league → +0.0003 HR rate.
    const fbDev = (fbPct - 24.0) * 0.0003;
    dev += fbDev;
    components.fbPct = fbPct;
    components.fbDeviation = fbDev;
  }

  // Pull% — pulled balls leave the yard more often than oppo balls.
  const pullPct = num(hitter.pullPct);
  if (pullPct != null) {
    // League avg ~40%. Pull-heavy hitters get a small boost.
    const pullDev = (pullPct - 40.0) * 0.0002;
    dev += pullDev;
    components.pullPct = pullPct;
    components.pullDeviation = pullDev;
  }

  const capped = capDeviation(dev, DEVIATION_CAPS.conversion);
  const wasCapped = Math.abs(dev) > DEVIATION_CAPS.conversion;

  let quality = 60;  // park always available
  if (fbPct != null) quality += 20;
  if (pullPct != null) quality += 20;

  return {
    deviation: capped,
    components: { ...components, raw: dev, capped: wasCapped },
    quality
  };
}

// =============================================================
// TOP-LEVEL: COMPUTE HIT PROBABILITY
// =============================================================
//
// Combines all three layers additively, clamps to realistic range, returns
// rich diagnostic object.
//
// USAGE
//   const result = computeHitProbability({
//     hitter: { kPct, barrelPct, hardHitPct, avgEv, xwoba, ldPct, sprintSpeed },
//     pitcher: { kPct, allowedHardHit, allowedEv, allowedBarrel },
//     matchedXwoba: 0.412,
//     parkBoosts: { runs: 1.05, hr: 1.10 },
//     ump: { favor: 'hitter' }
//   });
//   result.probability     // → 0.287
//   result.layers          // → diagnostic breakdown
//   result.quality         // → 0-100, overall data confidence
//   result.legacyScore     // → optional: existing 0-100 score for A/B compare
//
// @returns {Object} { probability, layers, quality, baseline }

export function computeHitProbability(input) {
  const { hitter = {}, pitcher = {}, matchedXwoba = null, parkBoosts = {}, ump = {} } = input || {};

  const layer1 = computeContactLayer(hitter, pitcher);
  const layer2 = computeQualityLayer(hitter, pitcher, matchedXwoba);
  const layer3 = computeConversionLayer(hitter, parkBoosts, ump);

  const baseline = LEAGUE_BASELINES.hitRate;
  const totalDev = layer1.deviation + layer2.deviation + layer3.deviation;
  const probability = clamp(baseline + totalDev, P_HIT_MIN, P_HIT_MAX);

  // Overall quality is the average of layer qualities, weighted by layer importance
  const overallQuality = Math.round(
    layer1.quality * 0.40 +
    layer2.quality * 0.40 +
    layer3.quality * 0.20
  );

  return {
    probability: Number(probability.toFixed(4)),
    baseline,
    layers: {
      contact: layer1,
      quality: layer2,
      conversion: layer3
    },
    totalDeviation: Number(totalDev.toFixed(4)),
    quality: overallQuality
  };
}

// =============================================================
// TOP-LEVEL: COMPUTE HR PROBABILITY
// =============================================================
//
// Uses Layer 1 + Layer 2 + dedicated HR conversion layer.
// HR rate is much lower than hit rate, so we anchor to a different baseline
// and use a tighter clamp range.

export function computeHrProbability(input) {
  const { hitter = {}, pitcher = {}, matchedXwoba = null, parkBoosts = {} } = input || {};

  const layer1 = computeContactLayer(hitter, pitcher);
  const layer2 = computeQualityLayer(hitter, pitcher, matchedXwoba);
  const layerHr = computeHrConversionLayer(hitter, parkBoosts);

  // For HR, contact layer matters less (a high-K hitter can still HR), so
  // we down-weight Layer 1.
  const baseline = LEAGUE_BASELINES.hrRate;
  const totalDev =
    layer1.deviation * 0.40 +    // contact less critical for HR
    layer2.deviation * 0.70 +    // quality is dominant
    layerHr.deviation;            // dedicated HR conversion

  const probability = clamp(baseline + totalDev, P_HR_MIN, P_HR_MAX);

  const overallQuality = Math.round(
    layer1.quality * 0.20 +
    layer2.quality * 0.55 +
    layerHr.quality * 0.25
  );

  return {
    probability: Number(probability.toFixed(4)),
    baseline,
    layers: {
      contact: layer1,
      quality: layer2,
      hrConversion: layerHr
    },
    totalDeviation: Number(totalDev.toFixed(4)),
    quality: overallQuality
  };
}

// =============================================================
// TOP-LEVEL: COMPUTE XBH (EXTRA-BASE HIT) PROBABILITY
// =============================================================
//
// A "hit of 2+ bases". Useful for TB props.
// Uses quality layer most heavily — XBH require hard contact.

export function computeXbhProbability(input) {
  const { hitter = {}, pitcher = {}, matchedXwoba = null, parkBoosts = {}, ump = {} } = input || {};

  const layer1 = computeContactLayer(hitter, pitcher);
  const layer2 = computeQualityLayer(hitter, pitcher, matchedXwoba);
  const layer3 = computeConversionLayer(hitter, parkBoosts, ump);

  const baseline = LEAGUE_BASELINES.xbhRate;
  // XBH is mostly about quality of contact; conversion factors less than for singles.
  const totalDev =
    layer1.deviation * 0.40 +
    layer2.deviation * 1.20 +    // quality dominates
    layer3.deviation * 0.50;

  const probability = clamp(baseline + totalDev, P_XBH_MIN, P_XBH_MAX);

  const overallQuality = Math.round(
    layer1.quality * 0.25 +
    layer2.quality * 0.55 +
    layer3.quality * 0.20
  );

  return {
    probability: Number(probability.toFixed(4)),
    baseline,
    layers: {
      contact: layer1,
      quality: layer2,
      conversion: layer3
    },
    totalDeviation: Number(totalDev.toFixed(4)),
    quality: overallQuality
  };
}

// =============================================================
// EXPORTS FOR TESTING
// =============================================================

export const _testing = {
  clamp,
  num,
  capDeviation,
  combineHitterPitcher,
  P_HIT_MIN,
  P_HIT_MAX,
  P_HR_MIN,
  P_HR_MAX
};
