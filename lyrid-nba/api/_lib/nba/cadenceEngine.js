// api/_lib/nba/cadenceEngine.js
//
// Production cadence — WHEN in a game a player produces, from play-by-play. The
// richest validated find, and MARKET-SPECIFIC (a blended number is mush):
//   assists back-loaded  -> TRAP: late playmakers catch up; do NOT bet the under
//   rebounds back-loaded -> SUPPORTS the under
//   points  back-loaded  -> mild trap if competitive, mild under support if blowout
// Gate: needs 5+ games of cadence before it fires, and keys on the actual game
// script (spread), not an alpha-adjusted flag. Shadow; thresholds are TUNE.

const CFG = {
  minGames: 5,
  backThreshold: 0.56,   // 2nd-half share above this = back-loaded — TUNE
  frontThreshold: 0.44,  // below this = front-loaded
  assistTrapSoften: 0.55, // multiply an assist-under edge by this when back-loaded (veto-ish)
  rebSupportBoost: 1.10,  // nudge a rebound-under edge when back-loaded
};

// per-game 2nd-half share for a market -> aggregate class over recent games.
export function classifyCadence(secondHalfShares, cfg = CFG) {
  const s = (secondHalfShares || []).filter((x) => x != null);
  if (s.length < cfg.minGames) return { class: 'insufficient', n: s.length, share: null };
  const share = s.reduce((a, b) => a + b, 0) / s.length;
  const cls = share >= cfg.backThreshold ? 'back' : share <= cfg.frontThreshold ? 'front' : 'neutral';
  return { class: cls, n: s.length, share: +share.toFixed(3) };
}

// adjust a recommendation from the base engine using cadence + game script.
export function applyCadence(rec, market, cadence, gameScript, cfg = CFG) {
  if (!cadence || cadence.class === 'insufficient' || cadence.class === 'neutral') return { ...rec, cadence: cadence?.class ?? null };
  const isBlowout = gameScript?.blowout === true;
  let side = rec.side, edge = rec.edge, note = null;

  if (market === 'assists' && cadence.class === 'back') {
    if (side === 'under') { edge *= cfg.assistTrapSoften; note = 'assist back-loaded TRAP — late dishes'; } // fade the under
  } else if (market === 'rebounds' && cadence.class === 'back') {
    if (side === 'under') { edge *= cfg.rebSupportBoost; note = 'rebound back-loaded supports under'; }
  } else if (market === 'points') {
    if (cadence.class === 'back' && !isBlowout && side === 'under') { edge *= 0.7; note = 'points back-loaded + competitive = mild trap'; }
    if (cadence.class === 'back' && isBlowout && side === 'under') { edge *= 1.05; note = 'points back-loaded + blowout supports under'; }
  }
  const prob = Math.min(0.99, 0.5 + Math.sign(rec.prob - 0.5 || 1) * Math.abs(edge));
  return { ...rec, edge: +Math.abs(edge).toFixed(3), prob: +prob.toFixed(3), side, cadence: cadence.class, cadenceNote: note };
}

// helper: 2nd-half share of POINTS and ASSISTS for a player from one game's ESPN plays.
// (points = scorer participant; assists = participants[1] on scoring plays. Rebounds
//  need a fuller rebound-event parse — provide those splits upstream when available.)
export function pointsAssistShareFromPlays(plays, playerId) {
  let ptsH1 = 0, ptsH2 = 0, astH1 = 0, astH2 = 0;
  for (const p of plays || []) {
    if (!p.shootingPlay || !p.scoringPlay) continue;
    const per = typeof p.period === 'object' ? p.period?.number : p.period;
    const half2 = per >= 3;
    const scorer = p.participants?.[0]?.athlete?.id;
    const assister = p.participants?.[1]?.athlete?.id;
    const val = Number(p.scoreValue) || 0;
    if (String(scorer) === String(playerId)) { if (half2) ptsH2 += val; else ptsH1 += val; }
    if (assister && String(assister) === String(playerId)) { if (half2) astH2 += 1; else astH1 += 1; }
  }
  const share = (h1, h2) => (h1 + h2 > 0 ? h2 / (h1 + h2) : null);
  return { points: share(ptsH1, ptsH2), assists: share(astH1, astH2) };
}

export default { classifyCadence, applyCadence, pointsAssistShareFromPlays };
