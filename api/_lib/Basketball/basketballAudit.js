// api/_lib/basketball/basketballAudit.js
//
// BASKETBALL PROP AUDIT LOGGER (May 16, 2026)
//
// Parallel to MLB Lyrid's bestBetHistory and hrAudit.entries pattern.
// Records every analyzed prop with enough detail to score against
// actual outcomes later. This is the foundation that lets us calibrate
// the model empirically once games start finalizing.
//
// USAGE:
//   import { buildAuditEntry } from './basketballAudit.js';
//   const entry = buildAuditEntry(input, result, { gameDate: '2026-05-16', league: 'WNBA' });
//   // entry is a plain object ready to persist (to Vercel KV, Supabase, or client state)
//
// WHY THIS MATTERS:
//   The MLB tool reached its current calibration accuracy because we had
//   1,167 audited HR picks to validate against actual outcomes. Without
//   that audit trail, every threshold is a guess. This module ensures
//   WNBA props have the same auditability from day one — so when the
//   season produces 200 graded picks, we can calibrate empirically rather
//   than tuning by feel.

/**
 * Build an audit entry from an analysis result. The entry shape matches what
 * MLB Lyrid stores in bestBetHistory, so the validation tooling we already
 * have can be extended to basketball with minimal new code.
 *
 * @param {Object} input - the original input that was analyzed
 * @param {Object} result - the analyzeBasketballProp() return value
 * @param {Object} meta - { gameDate, league, gameId?, source? }
 * @returns {Object} audit entry suitable for persistence
 */
export function buildAuditEntry(input, result, meta = {}) {
  const player = input?.player ?? input ?? {};
  const opponent = input?.opponent ?? {};
  const game = input?.game ?? {};
  const team = input?.team ?? {};

  const gameDate = meta.gameDate || new Date().toISOString().split('T')[0];
  const league = meta.league || result?.league || 'NBA';
  const playerId = player.id || player.playerId || hashPlayerName(player.name, player.team);

  // Unique entry ID following the MLB pattern: date_gameId_playerId_market_line
  // Lets us dedupe if same prop is analyzed multiple times in a day.
  const gameId = meta.gameId || `${gameDate}_${team.abbr || '?'}_${opponent.abbr || '?'}`;
  const market = result?.market || 'points';
  const line = result?.line ?? null;
  const id = `${gameDate}_${gameId}_${playerId}_${market}_${line ?? 'nil'}`;

  return {
    id,
    league,
    date: gameDate,
    gameId,
    playerId,
    playerName: player.name || 'Unknown',
    team: player.team || team.abbr || null,
    opponent: opponent.abbr || null,
    market,
    line,

    // Recommendation snapshot
    recommendation: result?.recommendation || null,
    confidence: result?.confidence || null,
    label: result?.label || null,
    projection: result?.projection ?? null,
    edge: result?.edge ?? null,
    hitRate: result?.hitRate ?? null,

    // Score snapshot — these are what we'll validate against actual outcomes.
    // Each score's contribution to picks-that-hit can be measured separately.
    scores: result?.scores ? { ...result.scores } : null,

    // Input snapshot — minimal fields needed to reproduce the recommendation.
    // We don't store the full input to keep storage costs sane; just what matters.
    inputs: {
      minutesAvg: player.minutesAvg ?? null,
      usageRate: player.usageRate ?? null,
      starter: player.starter ?? null,
      closingRole: player.closingRole ?? null,
      injuryTag: player.injuryTag || player.status || null,
      seasonAvg: player.seasonAvg ?? null,
      last5Avg: player.last5Avg ?? null,
      teamPace: team.pace ?? null,
      teamImpliedTotal: team.impliedTotal ?? null,
      opponentPace: opponent.pace ?? null,
      opponentDefRating: opponent.defRating ?? null,
      spread: game.spread ?? null,
      total: game.total ?? null,
      restDays: game.restDays ?? null,
      backToBack: game.backToBack ?? null,
      home: game.home ?? null
    },

    // Chips and flags for diagnostic recall
    chips: result?.chips || [],
    hardFlags: result?.details?.hardFlags || [],

    // Outcome — populated AFTER game finalizes by a separate gradeEntry()
    // call. Until then, graded=false and actual=null.
    graded: false,
    actual: null,        // actual stat result (e.g. 23.5 points)
    hit: null,           // did the recommended side cover? boolean | null
    gradingError: null,  // any issue while grading

    // Timestamps
    loggedAt: Date.now(),
    gradedAt: null,
    source: meta.source || 'manual'
  };
}

/**
 * Grade a previously-logged audit entry against a final stat outcome.
 *
 * @param {Object} entry - audit entry from buildAuditEntry
 * @param {number} actual - the actual stat value (e.g. 26 for 26 points scored)
 * @returns {Object} updated entry with graded=true, hit=true|false, actual=N
 */
export function gradeEntry(entry, actual) {
  if (!entry) return null;
  if (!Number.isFinite(Number(actual))) {
    return { ...entry, graded: false, gradingError: 'actual is not a finite number' };
  }

  const actualNum = Number(actual);
  const line = Number(entry.line);

  if (!Number.isFinite(line)) {
    return { ...entry, graded: false, gradingError: 'line not present on entry' };
  }

  // PASS recommendations don't have a "hit" outcome — they're informational.
  // We still grade them so we can measure whether the PASS was correct
  // (i.e. would have lost) which is its own useful signal.
  let hit = null;
  const wouldHaveCovered = actualNum > line;  // strict greater for OVER props
  if (entry.recommendation === 'OVER') {
    hit = wouldHaveCovered;
  } else if (entry.recommendation === 'UNDER') {
    hit = !wouldHaveCovered && actualNum !== line;  // push = false
  } else if (entry.recommendation === 'PASS') {
    // For PASS, we record what the projection's preferred side would have been
    // and whether it would have hit. Lets us measure if PASSes were "correct
    // refusals" or "missed edges."
    hit = null;  // pass entries don't count as hits/misses
  }

  // Push detection (exact match to line)
  const isPush = actualNum === line;

  return {
    ...entry,
    graded: true,
    actual: actualNum,
    hit,
    isPush,
    gradedAt: Date.now(),
    gradingError: null
  };
}

/**
 * Hash a player name + team to produce a stable string ID when no real
 * player ID is available. Not cryptographic — just deterministic.
 */
function hashPlayerName(name, team) {
  const s = String(name || '').toLowerCase() + '_' + String(team || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;  // force int32
  }
  return Math.abs(h).toString(36);
}

/**
 * Roll up an array of graded entries into a calibration summary.
 * Useful for the eventual validation tooling.
 *
 * @param {Array<Object>} entries - graded audit entries
 * @returns {Object} summary with hit rate, ROI proxy, breakdowns
 */
export function summarizeAuditEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { n: 0, message: 'no entries' };
  }

  const graded = entries.filter(e => e.graded && e.hit !== null);
  const passed = entries.filter(e => e.recommendation === 'PASS');
  const hits = graded.filter(e => e.hit === true).length;
  const losses = graded.filter(e => e.hit === false).length;
  const pushes = entries.filter(e => e.isPush).length;

  // Breakdown by confidence tier
  const byConfidence = {};
  for (const e of graded) {
    const k = e.confidence || 'unknown';
    if (!byConfidence[k]) byConfidence[k] = { n: 0, hits: 0 };
    byConfidence[k].n += 1;
    if (e.hit) byConfidence[k].hits += 1;
  }
  for (const k of Object.keys(byConfidence)) {
    byConfidence[k].rate = byConfidence[k].n > 0
      ? Number((byConfidence[k].hits / byConfidence[k].n * 100).toFixed(1))
      : 0;
  }

  // Breakdown by market
  const byMarket = {};
  for (const e of graded) {
    const k = e.market || 'unknown';
    if (!byMarket[k]) byMarket[k] = { n: 0, hits: 0 };
    byMarket[k].n += 1;
    if (e.hit) byMarket[k].hits += 1;
  }
  for (const k of Object.keys(byMarket)) {
    byMarket[k].rate = byMarket[k].n > 0
      ? Number((byMarket[k].hits / byMarket[k].n * 100).toFixed(1))
      : 0;
  }

  return {
    n: entries.length,
    graded: graded.length,
    passed: passed.length,
    hits,
    losses,
    pushes,
    hitRate: graded.length > 0 ? Number((hits / graded.length * 100).toFixed(1)) : 0,
    byConfidence,
    byMarket
  };
}
