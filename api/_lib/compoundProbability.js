// api/_lib/compoundProbability.js
//
// COMPOUND PROBABILITY ENGINE (May 23, 2026)
//
// PURPOSE
//   Compute per-game probabilities for COMPOUND prop lines that depend on
//   multiple stat categories at once:
//     - H+R+RBI ≥ 1.5 (and ≥ 2.5)
//     - PrizePicks Fantasy Score ≥ 6, ≥ 8
//     - Underdog Fantasy Score ≥ 5, ≥ 7
//
//   The contact engine in contactProbability.js handles single-stat per-PA
//   probabilities (P(hit), P(HR), P(XBH)). For compound props we need the
//   joint distribution of all hitter outcomes in a game — which is
//   intractable analytically because the components are correlated (a HR
//   contributes 1 H + 1 R + 1+ RBI in one event).
//
// METHOD: PER-PA EVENT MONTE CARLO
//   Each plate appearance produces exactly one of these events:
//     - K (strikeout)
//     - BB (walk)
//     - HBP (hit by pitch)
//     - SINGLE
//     - DOUBLE
//     - TRIPLE
//     - HR
//     - OUT (anything else: groundout, flyout, lineout)
//
//   Per-PA event probabilities are derived from contact engine outputs:
//     pK   ← matched K% (or season fallback)
//     pBB  ← season BB% (added to engine inputs as bb_percent)
//     pHbp ← small constant (~0.012 league avg)
//     pHR  ← contact engine pHr (per-PA, capped)
//     pTRIPLE ← small constant modulated by sprint speed
//     pXBH = pHR + pTRIPLE + pDOUBLE  (we know pXBH from engine)
//     pDOUBLE = pXBH - pHR - pTRIPLE
//     pHIT = pSINGLE + pDOUBLE + pTRIPLE + pHR  (we know pHIT from engine)
//     pSINGLE = pHIT - pDOUBLE - pTRIPLE - pHR
//     pOUT = 1 - (pK + pBB + pHbp + pHIT)
//
//   Each PA samples one event from this multinomial. Runs and RBIs are
//   sampled GIVEN the event, using the hitter's empirical conditional rates
//   (R/PA and RBI/PA from Statcast). This implicitly handles lineup context:
//   a cleanup hitter's RBI/PA already reflects that he bats with runners on.
//
//   The simulation runs N_TRIALS times. Per trial we accumulate H, R, RBI,
//   BB, HR, doubles, triples, K, SB. After all trials we compute:
//     - P(H + R + RBI ≥ threshold) by counting trials
//     - Fantasy Score per trial = Σ weights[event] × count[event]
//     - P(FS ≥ line) by counting trials
//
// CALIBRATION ANCHORS (sanity checks the engine should pass)
//   - League average hitter, 4 PA: P(HRR ≥ 1.5) ≈ 55-65%
//   - League average hitter, 4 PA: PP FS expected ≈ 5.5-6.5 → P(FS≥6) ≈ 45-55%
//   - Power hitter (15% HR/PA): P(HR ≥ 1) ≈ 50%, PP FS ≥ 8 ≈ 30-45%
//   - Punch-out artist (35% K rate): P(HRR ≥ 1.5) ≈ 35-45%
//
// PERFORMANCE
//   N_TRIALS = 5000 default. Each trial = ~5 PAs × ~12 ops = ~60 ops.
//   Per hitter: 5000 × 60 = 300K ops. ~3-5ms on modern Node.
//   Per game (18 hitters × 2 sides): ~120ms. Well under the 800ms ceiling.
//   If trial count needs to drop for perf, see N_TRIALS_LOW = 2000.
//
// EXPORTED API
//   computeCompoundProbabilities(input) → {
//     hrr: { p15, p25 },                       // H+R+RBI ≥ 1.5, ≥ 2.5
//     ppFs: { p6, p7, p8, expected, p50, p90 }, // PrizePicks
//     udFs: { p5, p6, p7, expected, p50, p90 }, // Underdog
//     distribution: { ... },                    // raw histograms for diagnostics
//     audit: { perPaEvents, nTrials, ... }
//   }

// =============================================================
// SCORING WEIGHTS (confirmed from PrizePicks/Underdog scoring tables)
// =============================================================
//
// Sources: PrizePicks scoring page (prizepicks.com), Underdog scoring guide.
// Confirmed by user May 23, 2026.

export const PP_WEIGHTS = Object.freeze({
  single: 3,
  double: 5,
  triple: 8,
  hr: 10,
  run: 2,
  rbi: 2,
  walk: 2,
  hbp: 2,
  sb: 5
});

export const UD_WEIGHTS = Object.freeze({
  single: 3,
  double: 6,    // UD pays more for doubles (PP pays 5)
  triple: 8,
  hr: 10,
  run: 2,
  rbi: 2,
  walk: 3,      // UD pays more for walks (PP pays 2)
  hbp: 3,       // UD pays more for HBP (PP pays 2)
  sb: 4         // UD pays less for SB (PP pays 5)
});

// =============================================================
// LEAGUE BASELINES (2024-2025)
// =============================================================

const LEAGUE = Object.freeze({
  pK: 0.225,           // 22.5% league K rate
  pBB: 0.085,          // 8.5% league BB rate
  pHbp: 0.012,         // 1.2% league HBP rate
  pHit: 0.243,         // .243 league batting average ≈ per-PA hit rate after accounting for outs
  pHR: 0.030,          // 3.0% per-PA HR rate
  pTriple: 0.005,      // 0.5% per-PA triple rate
  pXBH: 0.075,         // 7.5% per-PA XBH rate (HR + 3B + 2B)
  pSB: 0.012,          // SB attempts per PA (league avg)
  // Conditional rates (given the event happened)
  rPerOnBase: 0.31,    // P(score | got on base, any way) — league avg
  rbiPerHit: 0.30,     // avg RBIs per hit (heavy on HRs, light on singles)
  rbiPerHr: 1.55       // avg RBIs per HR (1 self + ~0.55 runners on)
});

// =============================================================
// SIMULATION CONSTANTS
// =============================================================

const N_TRIALS_DEFAULT = 5000;
const N_TRIALS_LOW = 2000;       // fallback when perf-constrained

// Per-PA event tags
const EVENT = Object.freeze({
  K:      'K',
  BB:     'BB',
  HBP:    'HBP',
  SINGLE: 'SINGLE',
  DOUBLE: 'DOUBLE',
  TRIPLE: 'TRIPLE',
  HR:     'HR',
  OUT:    'OUT'
});

// =============================================================
// HELPERS
// =============================================================

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, v));
}

function num(v, fallback = null) {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Simple deterministic RNG (xorshift) so tests can pin a seed.
// In production we want randomness, so default seed uses Date.now().
function makeRng(seed) {
  let s = (seed | 0) || 0x12345678;
  return function rng() {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // Convert to [0, 1)
    return ((s >>> 0) / 0xFFFFFFFF);
  };
}

// =============================================================
// PER-PA EVENT DISTRIBUTION BUILDER
// =============================================================
//
// Given the contact engine outputs and hitter season stats, build a
// multinomial distribution over the 8 events: {K, BB, HBP, SINGLE, DOUBLE,
// TRIPLE, HR, OUT}. The distribution must sum to 1.
//
// Strategy:
//   1. Take pK from matched K% (or season fallback)
//   2. Take pBB and pHbp from season rates (modulated by pitcher tendency
//      if available)
//   3. Take pHR from contact engine pHr (capped to realistic range)
//   4. pXBH from contact engine pXbh, then split into double/triple/HR
//   5. pHit from contact engine pHit; subtract XBH components to get singles
//   6. pOut absorbs whatever's left

function buildPerPaEvents(input) {
  const {
    pHitEngine,          // contact engine per-PA hit rate
    pHrEngine,           // contact engine per-PA HR rate
    pXbhEngine,          // contact engine per-PA XBH rate
    hitterKPct,          // matched K% (or season fallback) as percent (0-100)
    hitterBBPct,         // season BB% as percent (0-100)
    hitterHbpPct,        // season HBP% as percent (optional, fallback to league)
    sprintSpeed          // for triple modulation (optional)
  } = input;

  // Step 1: K rate
  let pK = clamp(num(hitterKPct, 22.5) / 100, 0.05, 0.55);

  // Step 2: BB and HBP
  let pBB = clamp(num(hitterBBPct, 8.5) / 100, 0.02, 0.25);
  let pHbp = clamp(num(hitterHbpPct, 1.2) / 100, 0.0, 0.05);

  // Step 3: HR — take from engine, fall back to league if missing
  let pHR = clamp(num(pHrEngine, LEAGUE.pHR), 0.0, 0.20);

  // Step 4: XBH — engine gives total XBH rate. Split into triple, double, HR.
  // Triple rate modulated by sprint speed (28 league avg, faster = more triples)
  const speed = num(sprintSpeed, 27);
  const speedFactor = clamp((speed - 26) / 4, 0.5, 1.8);
  let pTriple = clamp(LEAGUE.pTriple * speedFactor, 0.001, 0.02);

  // XBH = HR + triple + double. We know XBH and HR; solve for double.
  let pXBH = clamp(num(pXbhEngine, LEAGUE.pXBH), 0.0, 0.30);
  // Ensure XBH ≥ HR (engine could produce inconsistent outputs)
  pXBH = Math.max(pXBH, pHR + pTriple + 0.005);
  let pDouble = Math.max(0, pXBH - pHR - pTriple);

  // Step 5: pHit = single + double + triple + HR
  let pHit = clamp(num(pHitEngine, LEAGUE.pHit), 0.0, 0.55);
  pHit = Math.max(pHit, pXBH + 0.01);  // hits must be at least XBH
  let pSingle = Math.max(0, pHit - pDouble - pTriple - pHR);

  // Step 6: Out absorbs the rest
  const onBase = pBB + pHbp + pHit;
  let pOut = 1.0 - pK - onBase;

  // Normalize if rounding pushed us outside [0,1]
  // This can happen when engine probabilities sum > 1; we proportionally
  // shrink the non-K, non-out events.
  if (pOut < 0) {
    const overage = -pOut;
    // Shrink hit components proportionally to recover
    const hitTotal = pSingle + pDouble + pTriple + pHR;
    if (hitTotal > 0) {
      const scale = Math.max(0, (hitTotal - overage) / hitTotal);
      pSingle *= scale;
      pDouble *= scale;
      pTriple *= scale;
      pHR *= scale;
    }
    pOut = 0;
  }

  const dist = {
    K:      pK,
    BB:     pBB,
    HBP:    pHbp,
    SINGLE: pSingle,
    DOUBLE: pDouble,
    TRIPLE: pTriple,
    HR:     pHR,
    OUT:    pOut
  };

  // Final normalization (should be very close to 1 already)
  const sum = Object.values(dist).reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - 1) > 0.001) {
    Object.keys(dist).forEach(k => { dist[k] /= sum; });
  }

  return dist;
}

// =============================================================
// EVENT SAMPLER
// =============================================================
//
// Given a per-PA distribution and a [0,1] random number, return the sampled
// event. We construct cumulative probabilities once and reuse across trials.

function buildCumulativeDist(perPaEvents) {
  // Order matters — keep consistent across trials
  const events = [
    EVENT.K,
    EVENT.BB,
    EVENT.HBP,
    EVENT.SINGLE,
    EVENT.DOUBLE,
    EVENT.TRIPLE,
    EVENT.HR,
    EVENT.OUT
  ];
  const cum = [];
  let total = 0;
  for (const e of events) {
    total += perPaEvents[e] || 0;
    cum.push({ event: e, cumProb: total });
  }
  return cum;
}

function sampleEvent(cumDist, r) {
  for (let i = 0; i < cumDist.length; i++) {
    if (r < cumDist[i].cumProb) return cumDist[i].event;
  }
  return EVENT.OUT;  // shouldn't happen but safe
}

// =============================================================
// RBI / RUN SAMPLING (CONDITIONAL ON EVENT)
// =============================================================
//
// Once we know the PA's outcome, we sample runs scored and RBIs driven in.
// These use the hitter's empirical R/PA and RBI/PA from Statcast, which
// implicitly capture lineup context (cleanup hitters have higher RBI/PA;
// leadoff hitters have higher R/PA).
//
// We bucket the contributions by event type because a HR always scores the
// hitter (probability 1) while a walk only scores if subsequent hitters
// drive him in.
//
// rbiOnHr: distribution over {1, 2, 3, 4} RBIs depending on baserunners.
//   League avg = 1.55 RBIs per HR. We approximate as:
//     65% solo (1 RBI), 25% 2-run (2 RBIs), 8% 3-run (3 RBIs), 2% grand slam (4 RBIs)

function sampleRunsRbis(event, hitterRates, rng) {
  let runs = 0;
  let rbis = 0;

  // RUNS: probability the hitter himself scores given he reached base
  // We use the hitter's empirical R/(times on base) ratio. Fallback to 0.31.
  const pScoreGivenOnBase = hitterRates.rPerOnBase;

  // RBIs: bucket per event
  switch (event) {
    case EVENT.HR: {
      // Hitter always scores on his own HR
      runs = 1;
      // Sample RBI count
      const r = rng();
      if (r < 0.65) rbis = 1;
      else if (r < 0.90) rbis = 2;
      else if (r < 0.98) rbis = 3;
      else rbis = 4;
      // Tune by hitter's RBI/HR ratio if known (rbiPerHr)
      const expectedRbi = hitterRates.rbiPerHr || LEAGUE.rbiPerHr;
      const tuning = expectedRbi / LEAGUE.rbiPerHr;
      rbis = Math.max(1, Math.round(rbis * tuning));
      break;
    }
    case EVENT.TRIPLE:
    case EVENT.DOUBLE:
    case EVENT.SINGLE: {
      // Hitter MIGHT score (depends on whether subsequent hitters drive him in)
      if (rng() < pScoreGivenOnBase) runs = 1;
      // RBI on hit: per-event rates (XBH drive in more)
      const baseRbiRate = event === EVENT.TRIPLE ? 0.55
                       : event === EVENT.DOUBLE ? 0.40
                       : 0.20;
      // Tune by hitter's overall RBI/hit ratio
      const rbiPerHit = hitterRates.rbiPerHit || LEAGUE.rbiPerHit;
      const tuned = baseRbiRate * (rbiPerHit / LEAGUE.rbiPerHit);
      // Sample 0/1/2 RBIs
      const r2 = rng();
      if (r2 < tuned * 0.7) rbis = 1;
      else if (r2 < tuned) rbis = 2;
      break;
    }
    case EVENT.BB:
    case EVENT.HBP: {
      // Walks/HBP can score if subsequent hitters drive him in
      // Slightly lower than hit-based score rate
      if (rng() < pScoreGivenOnBase * 0.85) runs = 1;
      // Walks rarely drive in runs (only with bases loaded)
      if (rng() < 0.035) rbis = 1;
      break;
    }
    case EVENT.K:
    case EVENT.OUT: {
      // Outs can produce sacrifice RBIs (sac fly, productive ground ball)
      // Very rare, ~3% of outs in run-scoring situations
      if (rng() < 0.025) rbis = 1;
      break;
    }
  }

  return { runs, rbis };
}

// =============================================================
// PA COUNT SAMPLING
// =============================================================
//
// expectedPa is a non-integer (e.g. 4.2). We sample the actual PA count
// stochastically — 80% chance of 4, 20% chance of 5 for an expectedPa of 4.2.

function samplePaCount(expectedPa, rng) {
  const floor = Math.floor(expectedPa);
  const frac = expectedPa - floor;
  return rng() < frac ? floor + 1 : floor;
}

// =============================================================
// SINGLE-GAME SIMULATION
// =============================================================
//
// One trial = one simulated game for one hitter.
// Returns { H, R, RBI, BB, HR, double, triple, K, SB, hbp }

function simulateOneGame(cumDist, expectedPa, hitterRates, rng) {
  const pa = samplePaCount(expectedPa, rng);
  const stats = { H: 0, R: 0, RBI: 0, BB: 0, HR: 0, double: 0, triple: 0, single: 0, K: 0, hbp: 0, SB: 0 };

  for (let i = 0; i < pa; i++) {
    const event = sampleEvent(cumDist, rng());
    switch (event) {
      case EVENT.HR: stats.H++; stats.HR++; break;
      case EVENT.TRIPLE: stats.H++; stats.triple++; break;
      case EVENT.DOUBLE: stats.H++; stats.double++; break;
      case EVENT.SINGLE: stats.H++; stats.single++; break;
      case EVENT.BB: stats.BB++; break;
      case EVENT.HBP: stats.hbp++; break;
      case EVENT.K: stats.K++; break;
      case EVENT.OUT: break;
    }
    const { runs, rbis } = sampleRunsRbis(event, hitterRates, rng);
    stats.R += runs;
    stats.RBI += rbis;
  }

  // Stolen bases: light heuristic — rate per time on base
  const timesOnBase = stats.H + stats.BB + stats.hbp;
  const sbRate = hitterRates.sbPerPa || 0.02;
  const sbExpected = timesOnBase * sbRate * 5;  // multiply because per-PA SB → per-onbase ~5x
  for (let i = 0; i < Math.ceil(sbExpected); i++) {
    if (rng() < (sbExpected % 1 === 0 ? 1 : sbExpected - Math.floor(sbExpected))) {
      stats.SB++;
    }
  }

  return stats;
}

// =============================================================
// FANTASY SCORE CALCULATION
// =============================================================

function calcFs(stats, weights) {
  return stats.single * weights.single
       + stats.double * weights.double
       + stats.triple * weights.triple
       + stats.HR * weights.hr
       + stats.R * weights.run
       + stats.RBI * weights.rbi
       + stats.BB * weights.walk
       + stats.hbp * weights.hbp
       + stats.SB * weights.sb;
}

// =============================================================
// TOP-LEVEL: COMPUTE COMPOUND PROBABILITIES
// =============================================================

export function computeCompoundProbabilities(input) {
  const {
    // Contact engine outputs (per-PA rates)
    pHit, pHr, pXbh,
    // Hitter season rates
    hitterKPct, hitterBBPct, hitterHbpPct,
    sprintSpeed,
    // Hitter empirical conditional rates (handle lineup context)
    rPerOnBase, rbiPerHit, rbiPerHr, sbPerPa,
    // Game context
    expectedPa,
    // Performance
    nTrials = N_TRIALS_DEFAULT,
    seed = null
  } = input || {};

  // Build per-PA distribution
  const perPaEvents = buildPerPaEvents({
    pHitEngine: pHit,
    pHrEngine: pHr,
    pXbhEngine: pXbh,
    hitterKPct,
    hitterBBPct,
    hitterHbpPct,
    sprintSpeed
  });

  // Validate distribution
  const sum = Object.values(perPaEvents).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.01) {
    return null;  // bad inputs — degrade gracefully
  }

  const cumDist = buildCumulativeDist(perPaEvents);

  const hitterRates = {
    rPerOnBase: num(rPerOnBase, LEAGUE.rPerOnBase),
    rbiPerHit:  num(rbiPerHit, LEAGUE.rbiPerHit),
    rbiPerHr:   num(rbiPerHr, LEAGUE.rbiPerHr),
    sbPerPa:    num(sbPerPa, LEAGUE.pSB)
  };

  const ePa = clamp(num(expectedPa, 4.0), 1, 8);
  const rng = makeRng(seed != null ? seed : Date.now());

  // Run trials
  const hrrCounts = [];  // H+R+RBI per trial
  const ppFsValues = [];
  const udFsValues = [];

  for (let t = 0; t < nTrials; t++) {
    const stats = simulateOneGame(cumDist, ePa, hitterRates, rng);
    const hrr = stats.H + stats.R + stats.RBI;
    hrrCounts.push(hrr);
    ppFsValues.push(calcFs(stats, PP_WEIGHTS));
    udFsValues.push(calcFs(stats, UD_WEIGHTS));
  }

  // Extract probabilities
  function pAtLeast(arr, threshold) {
    let count = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] >= threshold) count++;
    return count / arr.length;
  }
  function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
  }
  function mean(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  return {
    hrr: {
      p15: round3(pAtLeast(hrrCounts, 2)),    // ≥ 2 (over 1.5)
      p25: round3(pAtLeast(hrrCounts, 3)),    // ≥ 3 (over 2.5)
      expected: round2(mean(hrrCounts)),
      p50: percentile(hrrCounts, 0.5),
      p90: percentile(hrrCounts, 0.9)
    },
    ppFs: {
      p6: round3(pAtLeast(ppFsValues, 6.5)),  // over 6 → ≥ 6.5 (PP FS lines are integer)
      p7: round3(pAtLeast(ppFsValues, 7.5)),
      p8: round3(pAtLeast(ppFsValues, 8.5)),
      expected: round2(mean(ppFsValues)),
      p50: round2(percentile(ppFsValues, 0.5)),
      p90: round2(percentile(ppFsValues, 0.9))
    },
    udFs: {
      p5: round3(pAtLeast(udFsValues, 5.5)),
      p6: round3(pAtLeast(udFsValues, 6.5)),
      p7: round3(pAtLeast(udFsValues, 7.5)),
      expected: round2(mean(udFsValues)),
      p50: round2(percentile(udFsValues, 0.5)),
      p90: round2(percentile(udFsValues, 0.9))
    },
    audit: {
      perPaEvents,
      cumDist: cumDist.map(c => ({ event: c.event, cumProb: round3(c.cumProb) })),
      expectedPa: ePa,
      hitterRates,
      nTrials,
      // Sanity: sum should be ~1.0
      distSum: round3(sum)
    }
  };
}

function round2(x) { return Math.round(x * 100) / 100; }
function round3(x) { return Math.round(x * 1000) / 1000; }

// Exported for tests + tuning
export const _testing = {
  buildPerPaEvents,
  buildCumulativeDist,
  sampleEvent,
  sampleRunsRbis,
  simulateOneGame,
  calcFs,
  makeRng,
  LEAGUE,
  N_TRIALS_DEFAULT,
  N_TRIALS_LOW
};
