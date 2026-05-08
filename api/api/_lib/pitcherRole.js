// api/_lib/pitcherRole.js
// Detects opener / bulk reliever / traditional starter role from recent game log.
//
// Role classifications:
//   'traditional'    — standard starter (6.0+ avg IP, all GS=1)
//   'short-starter'  — starter going 4-5 IP consistently (not opener, but limited)
//   'opener'         — recent starts avg < 3.5 IP, planned early exit
//   'bulk'           — used as relief after an opener (GS=0 but 3+ IP)
//   'shifted'        — traditional SP who recently moved to relief role
//   'unknown'        — insufficient data

const roleCache = new Map();  // mlbam → { timestamp, role }
const CACHE_TTL = 4 * 60 * 60 * 1000;  // 4 hours (role can change meeting-to-meeting)

/**
 * Detect the pitcher's current role based on recent outings.
 * @param {number} mlbam
 * @returns {Promise<Object>} { role, confidence, recentApps, avgIpRecent, avgIpSeason, reasons, warning }
 */
export async function detectPitcherRole(mlbam) {
  if (!mlbam) return null;
  const cached = roleCache.get(mlbam);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) return cached.data;

  const currentYear = new Date().getFullYear();
  let currentLog = [];
  let priorLog = [];

  try {
    const [cur, prior] = await Promise.all([
      fetchGameLog(mlbam, currentYear),
      fetchGameLog(mlbam, currentYear - 1)
    ]);
    currentLog = cur || [];
    priorLog = prior || [];
  } catch (err) {
    console.warn(`Role fetch failed ${mlbam}:`, err.message);
    return null;
  }

  if (currentLog.length === 0 && priorLog.length === 0) return null;

  const result = classifyRole(currentLog, priorLog);
  roleCache.set(mlbam, { timestamp: Date.now(), data: result });
  return result;
}

async function fetchGameLog(mlbam, season) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=gameLog&group=pitching&season=${season}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    const splits = data?.stats?.[0]?.splits || [];
    return splits.map(s => ({
      date: s.date,
      ip: parseFloat(s.stat?.inningsPitched) || 0,
      gs: s.stat?.gamesStarted === 1 ? 1 : 0,
      pitches: parseInt(s.stat?.numberOfPitches) || 0,
      k: parseInt(s.stat?.strikeOuts) || 0,
      batters: parseInt(s.stat?.battersFaced) || 0
    }));
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function classifyRole(currentLog, priorLog) {
  const reasons = [];
  let role = 'unknown';
  let confidence = 0;
  let warning = null;

  // Latest 5 appearances (most recent = last entry; game logs are ascending date)
  const recent = currentLog.slice(-5);
  const recentCount = recent.length;

  if (recentCount === 0) {
    // Fall back on prior year
    if (priorLog.length >= 10) {
      const priorStarts = priorLog.filter(a => a.gs === 1);
      const priorReliefs = priorLog.filter(a => a.gs === 0);
      const avgStartIp = priorStarts.length > 0
        ? priorStarts.reduce((s, a) => s + a.ip, 0) / priorStarts.length
        : 0;
      if (priorStarts.length >= 15 && avgStartIp >= 5.5) {
        return { role: 'traditional', confidence: 0.5, recentApps: 0, avgIpRecent: null, avgIpSeason: avgStartIp, reasons: ['Based on prior year: traditional starter'], warning: null, priorOnly: true };
      }
      if (priorReliefs.length > priorStarts.length * 2) {
        return { role: 'bulk', confidence: 0.5, recentApps: 0, avgIpRecent: null, avgIpSeason: null, reasons: ['Prior year: primarily relief usage'], warning: 'No current-season starts yet — prior-year bulk reliever', priorOnly: true };
      }
    }
    return { role: 'unknown', confidence: 0, recentApps: 0, avgIpRecent: null, avgIpSeason: null, reasons: ['Not enough data'], warning: null };
  }

  // Season-long stats
  const seasonStarts = currentLog.filter(a => a.gs === 1);
  const seasonReliefs = currentLog.filter(a => a.gs === 0);
  const avgStartIpSeason = seasonStarts.length > 0
    ? seasonStarts.reduce((s, a) => s + a.ip, 0) / seasonStarts.length
    : 0;
  const recentStarts = recent.filter(a => a.gs === 1);
  const recentReliefs = recent.filter(a => a.gs === 0);
  const avgIpRecent = recent.reduce((s, a) => s + a.ip, 0) / recentCount;
  const avgStartIpRecent = recentStarts.length > 0
    ? recentStarts.reduce((s, a) => s + a.ip, 0) / recentStarts.length
    : 0;

  // DETECTION LOGIC (ordered by priority)

  // 1. SHIFTED — was traditional SP, now in relief role (last 2+ apps GS=0)
  const last2 = currentLog.slice(-2);
  const last2AllRelief = last2.length === 2 && last2.every(a => a.gs === 0);
  const earlierSeasonStarts = currentLog.slice(0, -2).filter(a => a.gs === 1);
  if (last2AllRelief && earlierSeasonStarts.length >= 3) {
    role = 'shifted';
    confidence = 0.9;
    reasons.push(`Role shift: last 2 appearances in relief after ${earlierSeasonStarts.length} starts`);
    reasons.push(`Recent relief IP: ${last2.map(a => a.ip.toFixed(1)).join(', ')}`);
    warning = 'Previously a starter — now being used in relief. K-prop lines may be stale.';
    return finalize(role, confidence, recentCount, avgIpRecent, avgStartIpSeason, reasons, warning);
  }

  // 2. OPENER — recent starts are very short (avg < 3.5 IP, needs 2+ starts)
  if (recentStarts.length >= 2 && avgStartIpRecent < 3.5) {
    role = 'opener';
    confidence = recentStarts.length >= 3 ? 0.9 : 0.7;
    reasons.push(`Last ${recentStarts.length} starts average ${avgStartIpRecent.toFixed(1)} IP (opener-range)`);
    reasons.push(`Recent start IPs: ${recentStarts.map(a => a.ip.toFixed(1)).join(', ')}`);
    warning = 'Opener role — typically exits after 1-3 IP. K-prop lines will be low but overs are unlikely.';
    return finalize(role, confidence, recentCount, avgIpRecent, avgStartIpSeason, reasons, warning);
  }

  // 3. SHORT STARTER — avg 3.5-5.0 IP, injury/velocity concern or limited workload
  if (recentStarts.length >= 3 && avgStartIpRecent >= 3.5 && avgStartIpRecent < 5.0) {
    role = 'short-starter';
    confidence = 0.75;
    reasons.push(`Last ${recentStarts.length} starts average ${avgStartIpRecent.toFixed(1)} IP`);
    reasons.push('Limited-workload starter (injury return, pitch count cap, or ineffectiveness)');
    warning = 'Short-start pattern — tempered K-prop ceiling. Consider going under on K props if line reflects traditional workload.';
    return finalize(role, confidence, recentCount, avgIpRecent, avgStartIpSeason, reasons, warning);
  }

  // 4. BULK reliever — primarily relief role currently
  if (recentReliefs.length >= 3 && recentStarts.length === 0) {
    role = 'bulk';
    confidence = 0.85;
    reasons.push(`Last ${recentReliefs.length} appearances all in relief`);
    reasons.push(`Avg relief IP: ${(recentReliefs.reduce((s, a) => s + a.ip, 0) / recentReliefs.length).toFixed(1)}`);
    warning = 'Bulk reliever — should not be treated as a starter for prop purposes.';
    return finalize(role, confidence, recentCount, avgIpRecent, avgStartIpSeason, reasons, warning);
  }

  // 5. TRADITIONAL starter — avg 5.5+ IP across recent starts
  if (recentStarts.length >= 3 && avgStartIpRecent >= 5.5) {
    role = 'traditional';
    confidence = 0.9;
    reasons.push(`Last ${recentStarts.length} starts average ${avgStartIpRecent.toFixed(1)} IP — standard workload`);
    return finalize(role, confidence, recentCount, avgIpRecent, avgStartIpSeason, reasons, null);
  }

  // 6. TRADITIONAL with smaller sample
  if (recentStarts.length >= 1 && avgStartIpRecent >= 5.0) {
    role = 'traditional';
    confidence = 0.6;
    reasons.push(`${recentStarts.length} recent start(s) averaging ${avgStartIpRecent.toFixed(1)} IP`);
    return finalize(role, confidence, recentCount, avgIpRecent, avgStartIpSeason, reasons, null);
  }

  // Fallback: unable to classify cleanly
  return finalize('unknown', 0.3, recentCount, avgIpRecent, avgStartIpSeason, ['Mixed usage pattern — inspect game log manually'], 'Role pattern unclear — verify starting assignment and expected workload.');
}

function finalize(role, confidence, recentApps, avgIpRecent, avgIpSeason, reasons, warning) {
  return {
    role,
    confidence,
    recentApps,
    avgIpRecent: avgIpRecent != null ? avgIpRecent.toFixed(2) : null,
    avgIpSeason: avgIpSeason != null ? avgIpSeason.toFixed(2) : null,
    reasons,
    warning,
    isOpener: role === 'opener' || role === 'bulk',
    suppressKProps: role === 'opener' || role === 'bulk' || role === 'shifted',
    temperKProps: role === 'short-starter'
  };
}
