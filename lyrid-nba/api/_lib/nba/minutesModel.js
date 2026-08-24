// api/_lib/nba/minutesModel.js
//
// Minutes projection — the master variable. Validated finding: a player who plays
// under 75% of their average minutes hits the under ~87% of the time. The whole job
// is predicting reduced minutes BEFORE tip, from hard down-signals (injury
// designation, benching, blowout-by-role, a fill-in absorbing minutes). Tendencies
// (volatility) only widen the band; they never move the center.
//
// Output is a minutes DISTRIBUTION (mean + cv). Additive role adjustments are capped;
// the injury designation is a multiplier on the center. All magnitudes are TUNE
// placeholders — re-fit on NBA graded minutes (designation haircuts especially, which
// are reasoned, not yet backtested — log designations at slate time to calibrate).

import NBA, { CONFIGS } from './leagueConfig.js';

const DAY = 86400000;
function daysBetween(a, b) {
  const t1 = Date.parse(a), t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Math.round(Math.abs(t1 - t2) / DAY);
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function std(a, m) { return a.length ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) : 0; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ESPN status strings -> designation keys used by the haircut table
function normalizeDesignation(s) {
  if (!s) return 'available';
  const t = String(s).toLowerCase();
  if (t.includes('out')) return 'out';
  if (t.includes('doubtful')) return 'doubtful';
  if (t.includes('question') || t.includes('game time') || t.includes('gtd')) return 'questionable';
  if (t.includes('day-to-day') || t.includes('day to day')) return 'day-to-day';
  if (t.includes('probable')) return 'probable';
  return 'available';
}

function minutesSecurity(gsRatio, cv, cfg) {
  const starter = gsRatio == null ? 0.5 : clamp(gsRatio, 0, 1);
  const stability = 1 - clamp((cv ?? 0.2) / 0.4, 0, 1);
  return cfg.securityStarterWeight * starter + (1 - cfg.securityStarterWeight) * stability;
}

export function projectMinutes(ctx, league = 'NBA') {
  const root = CONFIGS[league] || NBA;
  const cfg = root.minutesModel;
  const {
    gameLog = [], spread = null, gameDate = null,
    age = null, gsRatio = null, teammatesOut = 0, roleUncertain = false,
    designation = null, usgPct = null,
  } = ctx;

  const played = gameLog.filter(r => r && r.min > 0).slice(0, cfg.recentN);
  if (!played.length) return { ok: false, reason: 'no recent minutes' };

  const mins = played.map(r => r.min);
  // validated recency weighting: lean on the last 5, since a flat 10 lags role changes
  const mL10 = mean(mins.slice(0, 10));
  const mL5 = mean(mins.slice(0, 5));
  const baseMean = mins.length >= 5 ? cfg.recencyL10 * mL10 + cfg.recencyL5 * mL5 : mL10;
  const baseCV = baseMean > 0 ? std(mins, mean(mins)) / baseMean : 0.2;

  let restDays = null, isB2B = false;
  if (gameDate && played[0]?.date) {
    restDays = daysBetween(gameDate, played[0].date);
    isB2B = restDays != null && restDays <= 1;
  }

  const flags = { restDays };
  let adj = 0;

  // back-to-back (NBA signal; heavier for veterans)
  if (isB2B) {
    let pen = cfg.b2bPenalty;
    if (age != null && age >= cfg.b2bVeteranAge) pen += cfg.b2bVeteranExtra;
    adj -= pen; flags.b2b = true;
  }

  // blowout — BY ROLE, never blanket
  let blowoutRisk = 0;
  if (spread != null) {
    const ab = Math.abs(spread);
    if (ab >= cfg.blowoutSpread) {
      blowoutRisk = clamp((ab - cfg.blowoutSpread) / cfg.blowoutSpread, 0, 1);
      if (baseMean < cfg.benchMinutes) {
        adj += blowoutRisk * cfg.garbageTimeBump;         // deep bench: garbage-time minutes UP
        flags.blowoutGarbageTime = true;
      } else {
        const alpha = usgPct == null ? 0 : clamp((usgPct - cfg.alphaUsgLo) / (cfg.alphaUsgHi - cfg.alphaUsgLo), 0, 1);
        const roleFactor = 1 - cfg.blowoutAlphaExemption * alpha; // alphas play through more
        adj -= blowoutRisk * cfg.blowoutMaxPenalty * roleFactor;
      }
    }
  }
  flags.blowoutRisk = +blowoutRisk.toFixed(2);

  // teammate(s) out -> minutes bump (usage funnel / benefitsFrom)
  if (teammatesOut > 0) {
    adj += Math.min(cfg.teammateOutMaxBump, teammatesOut * cfg.teammateOutBump);
    flags.teammatesOut = teammatesOut;
  }

  adj = clamp(adj, -cfg.adjustmentCap, cfg.adjustmentCap);

  // injury designation haircut on the center (multiplier)
  const desig = normalizeDesignation(designation);
  const hair = cfg.designationHaircut[desig] ?? 1.0;
  if (desig !== 'available') { flags.designation = desig; flags.designationHaircut = hair; }

  const projMean = clamp((baseMean + adj) * hair, root.minutes.floor, root.minutes.cap);

  // cv widened for insecure role / post-trade uncertainty (risk flags, symmetric)
  let cv = baseCV;
  const security = minutesSecurity(gsRatio, baseCV, cfg);
  if (security < 0.5) cv = Math.max(cv, cfg.lowSecurityCVFloor);
  if (roleUncertain) cv *= cfg.roleUncertainCVMult;
  flags.minutesSecurity = +security.toFixed(2);
  flags.roleUncertain = !!roleUncertain;

  // the ~87%-under zone: projection cut below 75% of the player's own baseline
  flags.reducedMinutes = baseMean > 0 && projMean < cfg.reducedMinutesRatio * baseMean;

  const sd = projMean * cv;
  return {
    ok: true,
    projMinutes: +projMean.toFixed(1),
    cv: +cv.toFixed(3),
    baseMean: +baseMean.toFixed(1),
    adjustment: +adj.toFixed(1),
    designationHaircut: hair,
    floor: +clamp(projMean - 1.04 * sd, root.minutes.floor, root.minutes.cap).toFixed(1),
    ceiling: +clamp(projMean + 1.04 * sd, root.minutes.floor, root.minutes.cap).toFixed(1),
    flags,
    notes: ['shadow — grade before trusting', 'all magnitudes are TUNE placeholders'],
  };
}

export default { projectMinutes };
