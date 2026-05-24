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
    // TEAM ECOSYSTEM (May 23, 2026) — phases out fragile-offense false positives
    //
    // If provided, these adjust:
    //   - expectedPa (lineupContinuationFactor)
    //   - rPerOnBase (team's actual scoring conversion rate)
    //   - fragility score (low-OBP/low-RPG teams penalize compound props)
    //
    // Pass null/undefined for backward compatibility — engine falls back to
    // league averages when ecosystem is missing.
    teamEcosystem,            // { obp, runsPerGame, lobPerGame, risp, ops, ... }
    opposingPitcherKPct,      // for PA modeling (high-K pitcher kills lineup turnover)
    gameTotal,                // market total runs (proxy for overall offensive env)
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

  // Resolve conditional rates. Team ecosystem (if provided) overrides league
  // fallback on rPerOnBase — the hitter's actual scoring rate after reaching
  // base depends on his teammates, not the league.
  const effectiveRPerOnBase = num(rPerOnBase,
    teamEcosystem ? teamRunConversionFromEcosystem(teamEcosystem) : LEAGUE.rPerOnBase
  );

  const hitterRates = {
    rPerOnBase: effectiveRPerOnBase,
    rbiPerHit:  num(rbiPerHit, LEAGUE.rbiPerHit),
    rbiPerHr:   num(rbiPerHr, LEAGUE.rbiPerHr),
    sbPerPa:    num(sbPerPa, LEAGUE.pSB)
  };

  // Dynamic expectedPa: adjust the lineup-slot default based on ecosystem.
  // A leadoff hitter on a 0.260-OBP team doesn't actually get 4.4 PA — they
  // get more like 3.7. A leadoff on a 0.350-OBP team gets 4.6-4.8.
  //
  // Inputs that modify expectedPa:
  //   - lineupContinuation (team OBP) — extends/cuts innings
  //   - opp pitcher K rate — high-K pitcher kills lineup turnover
  //   - game total — proxy for overall scoring environment
  let ePaAdjusted = num(expectedPa, 4.0);
  let paAdjustmentAudit = { base: ePaAdjusted, factors: {} };
  if (teamEcosystem) {
    const lineupFactor = lineupContinuationFromEcosystem(teamEcosystem);
    ePaAdjusted *= lineupFactor;
    paAdjustmentAudit.factors.lineupContinuation = round3(lineupFactor);
  }
  if (Number.isFinite(opposingPitcherKPct)) {
    // High-K pitcher kills lineup turnover. League avg K rate ~22.5%; a 30%
    // K pitcher costs ~0.1 PA per game; a 35% K pitcher ~0.2 PA.
    const kFactor = 1 - Math.max(0, (opposingPitcherKPct - 22.5) / 100) * 0.6;
    ePaAdjusted *= kFactor;
    paAdjustmentAudit.factors.pitcherKDrag = round3(kFactor);
  }
  if (Number.isFinite(gameTotal)) {
    // Game total proxy. League avg total ~8.5; 7.5 total games run ~5% shorter
    // (fewer offensive opportunities), 10+ total games run longer.
    const totalFactor = Math.pow(gameTotal / 8.5, 0.18);
    ePaAdjusted *= totalFactor;
    paAdjustmentAudit.factors.gameTotal = round3(totalFactor);
  }
  paAdjustmentAudit.final = round3(ePaAdjusted);

  const ePa = clamp(ePaAdjusted, 1, 8);
  const rng = makeRng(seed != null ? seed : Date.now());

  // Run trials — and track WHICH PATHWAY cleared HRR each trial.
  // Pathway categories (mutually exclusive — assigned by checking in order):
  //   HR_PATH       : at least 1 HR in the trial (HR alone produces HRR=3)
  //   MULTI_HIT_PATH: 2+ hits without a HR (multi-hit drives compound)
  //   RBI_PATH      : 1 hit + ≥2 RBI (XBH-driven, no HR)
  //   WALK_RUN_PATH : reached via BB/HBP + scored
  //   SINGLE_EVENT  : everything else that cleared (fragile — depends on 1 thing)
  //   DID_NOT_CLEAR : trial didn't hit HRR ≥ 2
  const hrrCounts = [];
  const ppFsValues = [];
  const udFsValues = [];
  const pathwayCounts = {
    HR_PATH: 0,
    MULTI_HIT_PATH: 0,
    RBI_PATH: 0,
    WALK_RUN_PATH: 0,
    SINGLE_EVENT: 0,
    DID_NOT_CLEAR: 0
  };

  for (let t = 0; t < nTrials; t++) {
    const stats = simulateOneGame(cumDist, ePa, hitterRates, rng);
    const hrr = stats.H + stats.R + stats.RBI;
    hrrCounts.push(hrr);
    ppFsValues.push(calcFs(stats, PP_WEIGHTS));
    udFsValues.push(calcFs(stats, UD_WEIGHTS));

    // Classify pathway for THIS trial (against the HRR 1.5 line specifically)
    if (hrr < 2) {
      pathwayCounts.DID_NOT_CLEAR++;
    } else if (stats.HR >= 1) {
      pathwayCounts.HR_PATH++;
    } else if (stats.H >= 2) {
      pathwayCounts.MULTI_HIT_PATH++;
    } else if (stats.RBI >= 2) {
      pathwayCounts.RBI_PATH++;
    } else if ((stats.BB + stats.hbp) >= 1 && stats.R >= 1) {
      pathwayCounts.WALK_RUN_PATH++;
    } else {
      // Cleared via 1 hit + 1 R or 1 hit + 1 RBI (single pathway dependency)
      pathwayCounts.SINGLE_EVENT++;
    }
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

  // PATHWAY DIVERSITY (entropy of clearing pathways)
  //
  // Compute Shannon entropy across the 5 clearing pathways (excluding
  // DID_NOT_CLEAR). Maximum entropy = ln(5) ≈ 1.609. Normalize to [0,1].
  //
  // A prop that clears 80% of the time but EVERY clear is the same pathway
  // (e.g. 100% HR_PATH) has diversity 0. A prop that clears via roughly
  // equal proportions of HR/multi-hit/RBI/walk-run/single-event has diversity
  // near 1.0 — much more robust.
  const clearingPathways = ['HR_PATH', 'MULTI_HIT_PATH', 'RBI_PATH', 'WALK_RUN_PATH', 'SINGLE_EVENT'];
  const totalCleared = nTrials - pathwayCounts.DID_NOT_CLEAR;
  let pathwayDiversity = 0;
  const pathwayShares = {};
  if (totalCleared > 0) {
    let entropy = 0;
    for (const path of clearingPathways) {
      const share = pathwayCounts[path] / totalCleared;
      pathwayShares[path] = round3(share);
      if (share > 0) {
        entropy -= share * Math.log(share);
      }
    }
    pathwayDiversity = entropy / Math.log(clearingPathways.length);
  }

  // FRAGILITY SCORE (May 23, 2026)
  //
  // 0-100 score. Higher = more fragile = more likely to bust despite a
  // headline probability that looks fine. Computed from:
  //
  //   - Low pathway diversity (depends on one outcome firing)         30 pts
  //   - Weak team ecosystem (lineup doesn't extend/convert)            25 pts
  //   - Low expected PA (compounds all probabilities downward)         15 pts
  //   - HR-pathway-only with low actual HR floor                       10 pts
  //   - Heavy single-event dependency                                  10 pts
  //   - High K-cluster risk (matched K% in punch-out territory)        10 pts
  //
  // Capped at 100. Elimination rule applied downstream (selection logic
  // refuses to mark `isBest=true` on props with fragility > 60).
  let fragility = 0;
  const fragilityComponents = {};

  // Component 1: pathway diversity
  const pathwayPenalty = Math.max(0, (1 - pathwayDiversity)) * 30;
  fragility += pathwayPenalty;
  fragilityComponents.pathwayDiversity = round2(pathwayPenalty);

  // Component 2: ecosystem weakness
  //
  // Calibration target: a Sheets/Langeliers-class dead-offense ecosystem
  // (OBP ~0.265, RPG ~3.3) should land near the 15-18 pt range here. That,
  // combined with pathway/PA penalties, lifts the prop into the caution tier.
  // Coefficient bumped from 50 → 75 to make ecosystem weakness the dominant
  // fragility predictor, since it's the single strongest signal for false
  // positives.
  if (teamEcosystem) {
    const obpRatio = (teamEcosystem.obp || 0.318) / 0.318;
    const rpgRatio = (teamEcosystem.runsPerGame || 4.45) / 4.45;
    const ecosystemHealth = (obpRatio + rpgRatio) / 2;  // 1.0 = league avg
    const ecosystemPenalty = Math.max(0, (1 - ecosystemHealth)) * 75;
    fragility += Math.min(25, ecosystemPenalty);
    fragilityComponents.ecosystemWeakness = round2(Math.min(25, ecosystemPenalty));
  } else {
    // No ecosystem data — apply a moderate uncertainty penalty
    fragility += 8;
    fragilityComponents.ecosystemWeakness = 8;
  }

  // Component 3: low expected PA
  const paShortfall = Math.max(0, 4.0 - ePa);
  const paPenalty = paShortfall * 10;  // ~3pp PA shortfall = 10 pts
  fragility += Math.min(15, paPenalty);
  fragilityComponents.lowExpectedPa = round2(Math.min(15, paPenalty));

  // Component 4: HR-dependency penalty (when the prop clears MOSTLY via HR)
  const hrPathDominance = totalCleared > 0 ? pathwayCounts.HR_PATH / totalCleared : 0;
  if (hrPathDominance > 0.5) {
    // Penalty scales with how dominant the HR path is
    const hrDepPenalty = (hrPathDominance - 0.5) * 20;
    fragility += Math.min(10, hrDepPenalty);
    fragilityComponents.hrDependency = round2(Math.min(10, hrDepPenalty));
  } else {
    fragilityComponents.hrDependency = 0;
  }

  // Component 5: single-event dependency
  const singleEventShare = totalCleared > 0 ? pathwayCounts.SINGLE_EVENT / totalCleared : 0;
  const singleEvPenalty = singleEventShare * 25;  // ~40% single-event = 10 pts
  fragility += Math.min(10, singleEvPenalty);
  fragilityComponents.singleEventDependency = round2(Math.min(10, singleEvPenalty));

  // Component 6: K-cluster risk (high matched K% punch-out hitters)
  const matchedK = num(hitterKPct, 22.5);
  let kPenalty = 0;
  if (matchedK > 28) kPenalty = Math.min(10, (matchedK - 28) * 1.0);
  fragility += kPenalty;
  fragilityComponents.kClusterRisk = round2(kPenalty);

  // Cap at 100
  fragility = Math.min(100, fragility);

  return {
    hrr: {
      p15: round3(pAtLeast(hrrCounts, 2)),    // ≥ 2 (over 1.5)
      p25: round3(pAtLeast(hrrCounts, 3)),    // ≥ 3 (over 2.5)
      expected: round2(mean(hrrCounts)),
      p50: percentile(hrrCounts, 0.5),
      p90: percentile(hrrCounts, 0.9)
    },
    ppFs: {
      p6: round3(pAtLeast(ppFsValues, 6.5)),
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
    // NEW: pathway decomposition and fragility (May 23, 2026)
    pathways: {
      shares: pathwayShares,
      diversity: round3(pathwayDiversity),
      hrPathDominance: round3(hrPathDominance)
    },
    fragility: {
      score: round2(fragility),
      components: fragilityComponents,
      // Tier thresholds calibrated against archetypal profiles (May 23, 2026):
      //   Trout/Marte class (good hitter + elite ecosystem): scores 5-15
      //   League-avg ecosystem, average hitter: scores 15-25
      //   Sheets/Langeliers class (dead ecosystem, fragile profile): scores 25-45
      //   Worst case (dead eco + low PA + high K + HR-dep): scores 45-70+
      // Thresholds set so Sheets-class lands in caution and worst-case lands
      // in eliminated, while normal mid-pack hitters stay eligible.
      eliminationTier: fragility > 45 ? 'eliminated'
                     : fragility > 25 ? 'caution'
                     : 'eligible'
    },
    audit: {
      perPaEvents,
      cumDist: cumDist.map(c => ({ event: c.event, cumProb: round3(c.cumProb) })),
      expectedPa: ePa,
      expectedPaAdjustment: paAdjustmentAudit,
      hitterRates,
      teamEcosystem: teamEcosystem ? {
        obp: teamEcosystem.obp,
        runsPerGame: teamEcosystem.runsPerGame,
        rPerOnBaseUsed: effectiveRPerOnBase
      } : null,
      nTrials,
      // Sanity: sum should be ~1.0
      distSum: round3(sum),
      pathwayCounts
    }
  };
}

// Helper: derive scoring conversion rate from ecosystem (avoiding circular import)
function teamRunConversionFromEcosystem(eco) {
  if (!eco || !Number.isFinite(eco.runsPerGame) || !Number.isFinite(eco.lobPerGame)) {
    return LEAGUE.rPerOnBase;
  }
  const total = eco.runsPerGame + eco.lobPerGame;
  if (total <= 0) return LEAGUE.rPerOnBase;
  return Math.max(0.20, Math.min(0.42, eco.runsPerGame / total));
}

// Helper: derive lineup-continuation factor from ecosystem
function lineupContinuationFromEcosystem(eco) {
  if (!eco || !Number.isFinite(eco.obp)) return 1.0;
  return Math.pow(eco.obp / 0.318, 0.7);
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
