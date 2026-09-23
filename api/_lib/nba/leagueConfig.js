// api/_lib/nba/leagueConfig.js
//
// NBA preset. The engine (pointsEngine.js) reads everything tunable from here so
// NBA is a config swap, not a rewrite. EVERY discipline constant below is a
// WNBA-derived PLACEHOLDER — re-fit on NBA graded data before trusting it.

export const NBA = {
  league: 'NBA',
  gameMinutes: 48,

  // minutes: until the dedicated minutes model plugs into `projMinutes`, the engine
  // integrates over a minutes distribution using recent mean + CV.
  minutes: {
    floor: 6,             // don't project a rotation player below this
    cap: 42,              // realistic single-game ceiling
    scenarioNodes: 5,     // equal-probability strata to integrate minutes uncertainty
    teamChangeCVMult: 1.6, // fallback widen when minutes model doesn't supply cv — TUNE
  },

  // minutes MODEL — the NBA's biggest lever and where the projection bias lives.
  // All magnitudes are placeholders. TUNE on NBA graded minutes.
  minutesModel: {
    recentN: 10,            // recent games for the baseline
    recencyL10: 0.45,       // baseline = 0.45*mean(L10) + 0.55*mean(L5) — validated
    recencyL5: 0.55,
    b2bPenalty: 2.5,        // minutes off on a back-to-back (NBA signal; null in WNBA)
    b2bVeteranAge: 32,      // older players lose more on B2Bs (load management)
    b2bVeteranExtra: 2.0,
    blowoutSpread: 12,      // |spread| where starter-pull risk starts
    blowoutMaxPenalty: 4.0, // max minutes off in a rout (applied BY ROLE, never blanket)
    blowoutAlphaExemption: 0.6, // alphas keep more minutes in blowouts: penalty *= (1 - 0.6*alpha)
    alphaUsgLo: 20, alphaUsgHi: 30, // usg%% range that maps to the alpha role factor
    benchMinutes: 18,       // below this baseline, a blowout ADDS garbage-time minutes
    garbageTimeBump: 3.0,
    teammateOutBump: 2.0,   // per key rotation player OUT (usage funnel / benefitsFrom)
    teammateOutMaxBump: 5.0,
    // player's OWN injury designation haircut on the minutes center (reasoned, TUNE):
    designationHaircut: { out: 0, doubtful: 0.50, questionable: 0.88, gtd: 0.88, 'day-to-day': 0.92, probable: 0.98, available: 1.0 },
    reducedMinutesRatio: 0.75, // proj < 75% of baseline = the ~87%-under zone (strongest finding)
    lowSecurityCVFloor: 0.28, // widen cv when role is insecure (risk flag, symmetric)
    roleUncertainCVMult: 1.5, // extra widen after a trade / role change
    adjustmentCap: 8.0,     // cap the total additive minutes deviation (no runaway)
    securityStarterWeight: 0.6,
  },

  // distribution readouts
  dist: { floorPctile: 0.15, ceilingPctile: 0.85 },

  // DISCIPLINES — all WNBA-scale placeholders. TUNE on NBA graded outcomes.
  calibration: {
    // fade-the-confident-over: raw probOver is anti-calibrated on the over side.
    fadeOverThreshold: 0.60, // at/above this raw pOver ≈ coinflip in WNBA data
    fadeOverWeight: 0.35,    // compression factor applied to (pRaw-0.5) above threshold
    mildOverWeight: 0.70,    // gentler compression for pOver in (0.5, threshold)
    // under side was well-calibrated (≤0.35 → ~67%) — keep it.
  },

  lineAboveCeiling: { enabled: true }, // line above realistic ceiling -> strong under tier

  // counting-stat markets (rebounds/assists): minutes x per-min rate -> negative
  // binomial. `k` is the dispersion size (higher = tighter/stickier, lower = noisier).
  // Rebounds are sticky, assists noisy — audit finding. All TUNE placeholders.
  markets: {
    rebounds: { k: 12, minEdge: 0.06 },
    assists:  { k: 6,  minEdge: 0.06 },
  },

  // combo markets (P+R, P+A, R+A, PRA): convolution over shared minutes; slightly
  // higher min edge + thin-gap auto-pass to respect residual correlation risk. TUNE.
  combo: { minEdge: 0.07, thinGap: 1.5, corrInflation: 0.12 }, // residual same-game correlation per extra component (v4). TUNE

  // role-change over/under guard: when role is unconfirmed AND the market line disagrees
  // strongly with our (stale) projection, neutralize the lean — the projection can't be
  // trusted through a role change. gapPct = |proj-line|/line that triggers it. TUNE.
  roleGuard: { gapPct: 0.18 },

  // opponent-defense adjustment (modest, capped). League baselines + coefficients are
  // TUNE placeholders. effCoef*ΔoppFG% -> make-rate mult; paceCoef*Δpace% -> volume mult.
  opponent: {
    shadow: true,   // v4: opponent context correlates ~r0.05 with player props — LOG the
                    // factors on the card, do NOT move the projection until NBA grades earn it
    leagueOppFgPct: 0.470, leaguePace: 99.5, leagueOppFg3aRate: 0.420,
    effCoef: 0.6, effCap: 0.04,     // make rates: max ±4%
    paceCoef: 0.5, paceCap: 0.04,   // shot volume: max ±4%
    rebEnvCoef: 0.4, rebEnvCap: 0.05,
    // defensive activity (ESPN/bbref): blocks -> rim scoring, steals -> assists
    leagueBlocksPerG: 5.0, leagueStealsPerG: 7.8,
    blockCoef: 0.4, blockCap: 0.03,  // 2P% suppression: max ±3%
    stealCoef: 0.4, stealCap: 0.04,  // assist suppression: max ±4%
  },

  // team + game totals (separate game-level model). NO blowout suppression on the total.
  totals: {
    leagueRtg: 113,                 // league avg points per 100 possessions
    leaguePace: 99.5, leagueFtr: 0.26,
    injuryCoef: 0.12, injuryCap: 0.10,  // out usage -> team-total haircut, capped
    injurySeverity: { out: 1.0, doubtful: 0.5, questionable: 0.2, gtd: 0.2, dtd: 0.1, probable: 0.05, available: 0 },
    ftCoef: 0.3, ftCap: 0.02,       // FT matchup nudge: max ±2%
    sigma: 10,                      // maps projected point gap -> P(over)
    minEdgePts: 3.0,                // need 3+ pts vs the line to lean
    gameMinEdge: 0.04, teamMinEdge: 0.05,
  },

  // self-calibration guardrail (v4 §3). Tiers/badges come from LIVE graded rates, never a
  // frozen streak. Nothing is promoted under minSample; anything below breakeven is demoted.
  // breakeven 0.577 = PrizePicks 2-pick power (sqrt(1/3)) — the real bar to clear. TUNE.
  calibration: { minSample: 20, breakeven: 0.577, strongRate: 0.62, eliteRate: 0.67 },

  // regime tagging (v4 §1) — disrupted windows down-weighted, never pooled into the baseline.
  regime: { openingDays: 14, deadlineFrom: 1, deadlineTo: 12, disrupted: ['opening', 'playoffs', 'deadline', 'b2b', 'tanking'] },

  edge: { minEdge: 0.04 }, // min |p-0.5| to surface a lean (NBA points lines are large)

  posture: 'shadow', // shadow-then-launch: emit probabilities, NOT conviction tiers,
                     // until confidence buckets are graded live.
};

export const CONFIGS = { NBA };
export default NBA;
