// api/_lib/recentForm.js
//
// RECENT FORM WEIGHTING — Wave 4 (May 15, 2026)
//
// Hot/cold hitter detection over last 10 games. Produces a multiplier on
// HR projection to capture form-driven variance the season-stat-only model
// misses.
//
// USAGE:
//   const record = await getRecentForm(hitterId, hitterName, seasonStats, hrAuditEntries);
//   // record.formMultiplier is in [0.75, 1.15]
//   // record.formLabel is one of: SCORCHING / HOT / NEUTRAL / COLD / INJURY_RISK / INSUFFICIENT
//
// SHADOW MODE:
//   This module always computes the multiplier. Whether to APPLY it in scoring
//   is controlled by RECENT_FORM_ENABLED in analyze.js. Always compute, log,
//   and surface for audit. Apply only when flag is on.
//
// DESIGN PRINCIPLES:
//   1. Aggressive thresholds — require multiple corroborating signals before
//      flagging HOT or COLD. Single hot game doesn't count.
//   2. Discrete tiers, not continuous — 1.02x is noise. 1.10x is signal.
//   3. INJURY_RISK is the harshest flag because the downside of picking a
//      hurt player vastly exceeds the upside of catching a "due" cold streak.
//   4. Defensive on bad data — return INSUFFICIENT rather than crash.

// =============================================================
// CONSTANTS
// =============================================================

const RECENT_WINDOW_GAMES = 10;       // last N games to aggregate
const MIN_GAMES_FOR_CLASSIFY = 5;     // below this → INSUFFICIENT
const MIN_PA_FOR_CLASSIFY = 15;       // sample size floor for confident flagging

// Multiplier tiers — discrete, auditable
const MULTIPLIER = {
  SCORCHING:    1.15,
  HOT:          1.10,
  NEUTRAL:      1.00,
  COLD:         0.90,
  INJURY_RISK:  0.75,
  INSUFFICIENT: 1.00   // no adjustment when we don't have data
};

// =============================================================
// MAIN ENTRY POINT
// =============================================================

/**
 * Compute recent form for a hitter.
 *
 * @param {Object} ctx
 * @param {number} ctx.hitterId - MLB player ID
 * @param {string} ctx.hitterName - display name (for logging/debug)
 * @param {Object} ctx.seasonStats - hitter's season-long stats (from analyze.js scope)
 *   Required: avg, hr, ab, pa, bb, k, doubles, triples, hbp (or rate-form equivalents)
 * @param {Array} ctx.hrAuditEntries - state.hrAudit.entries from caller (for cache-first lookup)
 * @param {Function} ctx.fetchGameLog - optional async fetcher for MLB API fallback
 * @returns {Promise<RecentFormRecord>}
 */
export async function getRecentForm(ctx) {
  const { hitterId, hitterName, seasonStats, hrAuditEntries = [], fetchGameLog = null } = ctx;

  // Defensive: bail cleanly if no hitter identity
  if (!hitterId || !hitterName) {
    return insufficientRecord(hitterId, hitterName, 'no-identity');
  }

  // STEP 1: Try to build from hrAudit cache first
  const auditGames = pullFromAudit(hitterId, hrAuditEntries);

  let games = auditGames;
  let source = 'hrAudit';

  // STEP 2: If audit doesn't have enough, try MLB API fallback
  if (games.length < RECENT_WINDOW_GAMES && fetchGameLog) {
    try {
      const apiGames = await fetchGameLog(hitterId);
      games = mergeGameLogs(auditGames, apiGames);
      source = auditGames.length > 0 ? 'hybrid' : 'mlbApi';
    } catch (err) {
      // API failed — fall through with whatever audit gave us
      // Don't throw; we'd rather return INSUFFICIENT than fail the slate
      console.warn(`[recentForm] API fetch failed for ${hitterName}:`, err.message);
    }
  }

  // STEP 3: Aggregate
  if (games.length < MIN_GAMES_FOR_CLASSIFY) {
    return insufficientRecord(hitterId, hitterName, 'too-few-games', { gamesFound: games.length });
  }

  // Use last N games (most recent first if sorted descending, last N if ascending)
  // We sort ascending by date and slice from the end
  const sorted = [...games].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const window = sorted.slice(-RECENT_WINDOW_GAMES);

  return aggregateRecord({
    hitterId,
    hitterName,
    games: window,
    seasonStats,
    source
  });
}

// =============================================================
// AGGREGATION
// =============================================================

/**
 * Aggregate game-by-game lines into a RecentFormRecord with classification.
 */
function aggregateRecord({ hitterId, hitterName, games, seasonStats, source }) {
  const recent = sumGameLines(games);

  // If PA too low even with N games, INSUFFICIENT
  if (recent.pa < MIN_PA_FOR_CLASSIFY) {
    return insufficientRecord(hitterId, hitterName, 'too-few-pa', {
      gamesUsed: games.length,
      paUsed: recent.pa
    });
  }

  // Derive rate stats
  const ab = recent.pa - recent.bb - (recent.hbp || 0);
  recent.avg = ab > 0 ? recent.h / ab : 0;
  recent.iso = ab > 0 ? (recent.tb - recent.h) / ab : 0;
  recent.kRate = recent.pa > 0 ? recent.k / recent.pa : 0;
  recent.bbRate = recent.pa > 0 ? recent.bb / recent.pa : 0;
  recent.hrRate = recent.pa > 0 ? recent.hr / recent.pa : 0;

  // Build season baseline
  const season = normalizeSeasonStats(seasonStats);

  // Deltas
  const deltas = {
    avgDelta: recent.avg - season.avg,
    isoDelta: recent.iso - season.iso,
    kRateDelta: recent.kRate - season.kRate,
    hrRateDelta: recent.hrRate - season.hrRate
  };

  // Classify
  const { formLabel, formMultiplier, flags } = classifyForm({ recent, season });

  return {
    hitterId,
    hitterName,
    source,
    gamesUsed: games.length,
    paUsed: recent.pa,
    asOfDate: new Date().toISOString().split('T')[0],
    recent,
    season,
    deltas,
    flags,
    formLabel,
    formMultiplier
  };
}

/**
 * Sum game-by-game line objects into a single aggregate.
 * Handles missing fields defensively (treats as 0).
 */
function sumGameLines(games) {
  const fields = ['pa', 'ab', 'h', 'hr', 'tb', 'bb', 'k', 'hbp', 'doubles', 'triples'];
  const sum = {};
  for (const f of fields) sum[f] = 0;

  for (const g of games) {
    const line = g.line || g;  // accept either {date, line: {...}} or flat {...}
    for (const f of fields) {
      // gameLog API uses both 'PA' and 'pa', also 'strikeOuts' for K
      const v = line[f] ?? line[f.toUpperCase()] ?? line[fieldAlias(f)] ?? 0;
      sum[f] += +v || 0;
    }
  }

  return sum;
}

// Handle MLB API field name variants
function fieldAlias(f) {
  return {
    pa: 'plateAppearances',
    ab: 'atBats',
    h: 'hits',
    hr: 'homeRuns',
    tb: 'totalBases',
    bb: 'baseOnBalls',
    k: 'strikeOuts',
    hbp: 'hitByPitch',
    doubles: 'doubles',
    triples: 'triples'
  }[f];
}

/**
 * Normalize season stats to consistent shape for delta comparison.
 * Accepts whatever the caller has — converts to rate stats.
 */
function normalizeSeasonStats(stats) {
  if (!stats) return { avg: 0.250, iso: 0.150, kRate: 0.230, bbRate: 0.085, hrRate: 0.030 };

  // If already in rate form
  if (typeof stats.avg === 'number' && typeof stats.kRate === 'number') {
    return {
      avg: stats.avg,
      iso: stats.iso ?? 0.150,
      kRate: stats.kRate,
      bbRate: stats.bbRate ?? 0.085,
      hrRate: stats.hrRate ?? 0.030
    };
  }

  // From counting stats — convert to rates
  const pa = +stats.pa || +stats.plateAppearances || 0;
  const ab = +stats.ab || +stats.atBats || (pa - (+stats.bb || 0));
  const h = +stats.h || +stats.hits || 0;
  const hr = +stats.hr || +stats.homeRuns || 0;
  const tb = +stats.tb || +stats.totalBases || 0;
  const k = +stats.k || +stats.strikeOuts || 0;
  const bb = +stats.bb || +stats.baseOnBalls || 0;

  if (pa < 30) {
    // Tiny season sample — use league-average prior
    return { avg: 0.250, iso: 0.150, kRate: 0.230, bbRate: 0.085, hrRate: 0.030 };
  }

  return {
    avg: ab > 0 ? h / ab : 0.250,
    iso: ab > 0 ? (tb - h) / ab : 0.150,
    kRate: pa > 0 ? k / pa : 0.230,
    bbRate: pa > 0 ? bb / pa : 0.085,
    hrRate: pa > 0 ? hr / pa : 0.030
  };
}

// =============================================================
// CLASSIFICATION
// =============================================================

/**
 * Classify a hitter's form based on recent vs season stats.
 *
 * Rule order matters: INJURY_RISK > COLD > SCORCHING > HOT > NEUTRAL.
 * The first rule that matches wins.
 */
function classifyForm({ recent, season }) {
  const flags = {
    coldStreak: false,
    injuryRisk: false,
    insufficient: false,
    hot: false,
    scorching: false,
    cold: false
  };

  // INJURY_RISK: severely degraded contact suggesting player is hurt/benched
  // Two signals:
  //   (a) 0 hits + ≤1 BB over 15+ PA  → no contact, no patience (extreme)
  //   (b) AVG ≤ 0.075 AND ISO ≤ 0.075 over 20+ PA → ghost-of-self performance
  // The OR captures cases like Seager (2H/39PA, 0HR, AVG 0.059, ISO 0.059)
  // where the hitter is making token contact but materially broken.
  const extremeNoContact = recent.pa >= 15 && recent.h === 0 && recent.bb <= 1;
  const ghostPerformance = recent.pa >= 20 && recent.avg <= 0.075 && recent.iso <= 0.075;
  if (extremeNoContact || ghostPerformance) {
    flags.injuryRisk = true;
    return { formLabel: 'INJURY_RISK', formMultiplier: MULTIPLIER.INJURY_RISK, flags };
  }

  // COLD: very few hits OR materially worse contact than season
  // The OR is important — a hitter making contact but no HRs is different
  // from a hitter making no contact. Both deserve down-weight.
  const veryFewHits = recent.h <= 2 && recent.pa >= 15;
  const muchWorseContact = recent.hrRate < (season.hrRate * 0.5) && recent.iso < (season.iso - 0.050);
  if (veryFewHits || muchWorseContact) {
    flags.cold = true;
    return { formLabel: 'COLD', formMultiplier: MULTIPLIER.COLD, flags };
  }

  // SCORCHING: extreme heater — 2x HR rate AND ISO+0.100 AND 7+ hits
  // The triple-corroboration is the aggressive regression. We don't trust
  // any single signal — only the convergence of multiple hot indicators.
  const scorchingHrRate = recent.hrRate > (season.hrRate * 2.0);
  const scorchingIso = recent.iso > (season.iso + 0.100);
  const scorchingHits = recent.h >= 7;
  if (scorchingHrRate && scorchingIso && scorchingHits) {
    flags.scorching = true;
    flags.hot = true;
    return { formLabel: 'SCORCHING', formMultiplier: MULTIPLIER.SCORCHING, flags };
  }

  // HOT: 1.5x HR rate AND iso above season AND 5+ hits
  const hotHrRate = recent.hrRate > (season.hrRate * 1.5);
  const hotIso = recent.iso > season.iso;
  const hotHits = recent.h >= 5;
  if (hotHrRate && hotIso && hotHits) {
    flags.hot = true;
    return { formLabel: 'HOT', formMultiplier: MULTIPLIER.HOT, flags };
  }

  return { formLabel: 'NEUTRAL', formMultiplier: MULTIPLIER.NEUTRAL, flags };
}

// =============================================================
// HISTORICAL CACHE (state.hrAudit.entries lookup)
// =============================================================

/**
 * Pull recent game lines from hrAudit entries.
 * Returns games sorted ascending by date.
 */
function pullFromAudit(hitterId, hrAuditEntries) {
  if (!hrAuditEntries || !Array.isArray(hrAuditEntries)) return [];

  const matches = hrAuditEntries.filter(e =>
    e &&
    e.hitterId === hitterId &&
    e.graded &&
    e.line &&
    typeof e.line === 'object'
  );

  // Map to a consistent shape: { date, line: {pa, h, hr, ...} }
  return matches.map(e => ({
    date: e.date,
    line: {
      pa: +e.line.PA || 0,
      ab: +e.line.AB || 0,
      h: +e.line.H || 0,
      hr: +e.line.HR || 0,
      tb: +e.line.TB || 0,
      bb: +e.line.BB || 0,
      k: +e.line.K || 0,
      hbp: +e.line.HBP || 0,
      doubles: +e.line.doubles || 0,
      triples: +e.line.triples || 0
    }
  }));
}

/**
 * Merge audit games with API games. API is canonical for older games,
 * audit may have fresher data for very recent games (last 1-2 days)
 * before MLB Stats API updates.
 *
 * Strategy: dedupe by date, prefer API where dates conflict (audit is logged
 * at pick time which may be before final stat correction).
 */
function mergeGameLogs(auditGames, apiGames) {
  const byDate = new Map();

  // API first (lower priority — gets overwritten by audit if same date)
  for (const g of apiGames || []) {
    if (g.date) byDate.set(g.date, g);
  }

  // Audit second — but only OVERWRITE if no API entry for this date
  // (API is canonical for stat accuracy; audit is fallback)
  for (const g of auditGames || []) {
    if (g.date && !byDate.has(g.date)) byDate.set(g.date, g);
  }

  return Array.from(byDate.values());
}

// =============================================================
// EMPTY/INSUFFICIENT RECORD HELPER
// =============================================================

function insufficientRecord(hitterId, hitterName, reason, extras = {}) {
  return {
    hitterId,
    hitterName,
    source: 'insufficient',
    gamesUsed: extras.gamesUsed || 0,
    paUsed: extras.paUsed || 0,
    asOfDate: new Date().toISOString().split('T')[0],
    recent: null,
    season: null,
    deltas: null,
    flags: {
      coldStreak: false,
      injuryRisk: false,
      insufficient: true,
      hot: false,
      scorching: false,
      cold: false
    },
    formLabel: 'INSUFFICIENT',
    formMultiplier: MULTIPLIER.INSUFFICIENT,
    insufficientReason: reason
  };
}

// =============================================================
// MLB STATS API FETCHER
// =============================================================

/**
 * Default MLB Stats API gameLog fetcher.
 *
 * Used as the fetchGameLog callback when caller doesn't provide its own.
 * Returns an array of { date, line: {pa, h, hr, tb, bb, k, hbp, doubles, triples} }
 * for the current season.
 */
export async function fetchHitterGameLog(hitterId, season = null) {
  if (!hitterId) throw new Error('hitterId required');

  const yr = season || new Date().getFullYear();
  const url = `https://statsapi.mlb.com/api/v1/people/${hitterId}/stats` +
              `?stats=gameLog&season=${yr}&group=hitting&sportId=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${url}`);
  const data = await res.json();

  // Response structure:
  //   { stats: [ { splits: [ { date, stat: {...} }, ... ] } ] }
  const splits = data?.stats?.[0]?.splits || [];

  return splits.map(s => ({
    date: s.date,
    line: {
      pa: +s.stat.plateAppearances || 0,
      ab: +s.stat.atBats || 0,
      h: +s.stat.hits || 0,
      hr: +s.stat.homeRuns || 0,
      tb: +s.stat.totalBases || 0,
      bb: +s.stat.baseOnBalls || 0,
      k: +s.stat.strikeOuts || 0,
      hbp: +s.stat.hitByPitch || 0,
      doubles: +s.stat.doubles || 0,
      triples: +s.stat.triples || 0
    }
  }));
}

// =============================================================
// IN-MEMORY CACHE (for use inside a single serverless invocation)
// =============================================================

const _formCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;  // 30 min

/**
 * Cached wrapper around getRecentForm.
 *
 * Within a single Vercel function invocation, repeated calls for the same
 * hitter return the cached record. TTL is 30min which is irrelevant within
 * a single request but provides headroom if state were ever shared.
 */
export async function getRecentFormCached(ctx) {
  const { hitterId } = ctx;
  if (!hitterId) return getRecentForm(ctx);

  const cached = _formCache.get(hitterId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.record;
  }

  const record = await getRecentForm(ctx);
  _formCache.set(hitterId, { record, ts: Date.now() });
  return record;
}

/**
 * Reset the in-memory cache. Mostly useful for testing.
 */
export function _resetCache() {
  _formCache.clear();
}

// =============================================================
// EXPORTS FOR TESTING / INTROSPECTION
// =============================================================

export const _testing = {
  classifyForm,
  sumGameLines,
  normalizeSeasonStats,
  pullFromAudit,
  mergeGameLogs,
  MULTIPLIER,
  RECENT_WINDOW_GAMES,
  MIN_GAMES_FOR_CLASSIFY,
  MIN_PA_FOR_CLASSIFY
};
