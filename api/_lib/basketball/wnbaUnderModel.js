/**
 * wnbaUnderModel.js
 *
 * Unified WNBA bet classifier grounded in 264 graded real-line picks (Jun 2026).
 * Replaces the patchwork of empTier filter rules with a single function that
 * encodes everything the data actually proved.
 *
 * ─────────────────────────────────────────────────────────────────
 * THE THREE VALIDATED EDGES (from audit):
 *
 * TIER 1 — GUARANTEED  assists/PRA-under, |edge| ≥ 4.0
 *   16-0  100%  (n=16)
 *   Mechanism: book sets inflated combo/PRA line the player hasn't sniffed
 *   all season. Tool proj is ~3-7; line is 15-28. The gap alone makes it
 *   near-certain. Play every time it fires.
 *
 * TIER 2 — PLATINUM    assists-under, line 4-8, edge 1-4, role ≥ 80
 *   27-1  96.4%  (n=28, Wilson floor 80.4%)
 *   Mechanism: primary creator cold in a locked rotation role. Book has
 *   their assists priced as a real playmaker — when the engine sees cold
 *   form at this line level, the under is almost certain.
 *
 * TIER 3 — GOLD        rebounds-under, proj 3.0–5.0, role ≥ 55
 *   23-4  85.2%  (n=27, Wilson floor 69%)
 *   Mechanism: guard/wing positional rebound ceiling. Not rebounders by
 *   design — they get boards by proximity. The line is set above their
 *   natural rate and they rarely reach it.
 *
 * BANNED (everything else): 58%, no edge.
 *   - assists line < 4.0  (coin flip at 50%)
 *   - assists edge < 1.0  (not enough cushion)
 *   - rebounds proj < 3.0 (too noisy — 47.4%)
 *   - rebounds proj ≥ 5.0 (primary rebounders — 54%)
 *   - rebounds role < 55  (floating role = unpredictable)
 *   - points any direction (44%, +2.84 biased)
 *   - any OVER direction   (47%, no validated edge)
 *
 * PLAYER BANS (graded evidence):
 *   Marina Mabrey rebounds-under: 0-4. Crashes harder than stats show.
 *
 * PLAYER WATCHES (small sample, do NOT bet yet — track only):
 *   Rhyne Howard points-over:    3-0  (n=3) — tool under-projects scoring
 *   Shakira Austin rebounds-over: 4-5  (n=5) — tool under-projects boards
 *
 * OPPONENT MODIFIER:
 *   CHI allows stats — suppress rebounds-under vs Chicago
 *   (33% hit rate on rebound unders vs CHI in graded history)
 *
 * PRA DETECTION:
 *   When an "assists" line > 8.0, the feed has mislabeled a PRA/combo
 *   line. Reclassify as "pra" and apply the GUARANTEED tier if edge ≥ 4.
 * ─────────────────────────────────────────────────────────────────
 */

// Wilson score 95% lower confidence bound — honest small-sample flooring.
function wilsonLo(wins, n, z = 1.96) {
  if (!n) return 0;
  const p = wins / n;
  const d = 1 + z * z / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
}

// Validated cohorts — update counts as picks grade.
const COHORTS = {
  GUARANTEED: { wins: 16, n: 16 },   // assists/PRA under, |edge| ≥ 4
  PLATINUM:   { wins: 27, n: 28 },   // assists under, line 4-8, edge 1-4, role ≥ 80
  GOLD:       { wins: 23, n: 27 },   // rebounds under, proj 3-5, role ≥ 55, not Mabrey
};

// Player-level bans (rebounds-under only — evidence-based).
const PLAYER_BANS_REB_UNDER = new Set(['marina mabrey']);

// Player-level watches — small sample, for display only (not bet signals yet).
const PLAYER_WATCHES = {
  'rhyne howard':   { market: 'points', side: 'OVER', wins: 3, n: 3,
                      note: 'Tool consistently under-projects her scoring (+5.4 PRA avg). WATCH — n=3.' },
  'shakira austin': { market: 'rebounds', side: 'OVER', wins: 4, n: 5,
                      note: 'Tool under-projects board rate for her role. WATCH — n=5.' },
};

// Opponents that suppress stat accumulation (strong under environment).
const OPP_SUPPRESS  = new Set(['SEA', 'LVA', 'GSV', 'MIN']);  // ≥ 80% under hit vs these
// Opponents that allow stats (weaken rebounds-under confidence).
const OPP_ALLOWS    = new Set(['CHI', 'TOR']);                 // 33-50% — caution on rebounds

/**
 * Detect mislabeled PRA lines.
 * PrizePicks posts PRA as a market but the sportsbook feed sometimes tags it
 * as "assists" with an anomalously high line (>8). Reclassify those.
 */
export function detectPRA(market, line) {
  const m = String(market || '').toLowerCase();
  const l = Number(line);
  return (m === 'assists' && Number.isFinite(l) && l > 8.0);
}

/**
 * Compute a synthetic PRA projection from its three components.
 * @param {number} ptsProj
 * @param {number} rebProj
 * @param {number} astProj
 * @returns {number}
 */
export function computePRAProjection(ptsProj, rebProj, astProj) {
  return (Number(ptsProj) || 0) + (Number(rebProj) || 0) + (Number(astProj) || 0);
}

/**
 * Classify a WNBA prop into a bet tier.
 *
 * @param {Object} opts
 *   market     {string}  'assists' | 'rebounds' | 'points' | 'pra' | ...
 *   lean       {string}  'OVER' | 'UNDER'
 *   line       {number}  book line
 *   projection {number}  tool projection
 *   role       {number}  0-100 role stability score (optional)
 *   player     {string}  player name (for bans/watches)
 *   opponent   {string}  opponent team abbr (for opp modifier)
 *
 * @returns {Object}
 *   tier    {string}  GUARANTEED | PLATINUM | GOLD | WATCH | PASS | AVOID | BANNED | UNGRADED
 *   bet     {boolean} whether this is a validated bet signal
 *   wr      {number}  cohort win rate (0-1)
 *   n       {number}  cohort sample size
 *   wilsonLo{number}  95% Wilson lower bound
 *   reason  {string}  plain-English reason
 *   watch   {Object|null} watch-flag data if applicable
 *   oppFlag {string|null} 'SUPPRESSES' | 'ALLOWS' | null
 */
export function classifyWnbaPlay({ market, lean, line, projection, role, player, opponent } = {}) {
  const m   = String(market || '').toLowerCase();
  const dir = String(lean   || '').toUpperCase();
  const l   = Number(line);
  const p   = Number(projection);
  const r   = Number(role ?? 50);
  const pl  = String(player || '').toLowerCase();
  const opp = String(opponent || '').toUpperCase();
  const edge = Math.abs(l - p);

  // Opponent modifier
  const oppFlag = OPP_SUPPRESS.has(opp) ? 'SUPPRESSES'
                : OPP_ALLOWS.has(opp)   ? 'ALLOWS'
                : null;

  // Player watch flag (surfaced on card regardless of tier)
  const watchKey = Object.keys(PLAYER_WATCHES).find(k => pl.includes(k));
  const watch = watchKey ? PLAYER_WATCHES[watchKey] : null;

  // Reclassify mislabeled PRA
  const effectiveMarket = detectPRA(m, l) ? 'pra' : m;

  // ── TIER 1: GUARANTEED ───────────────────────────────────────────
  // assists or PRA under, edge ≥ 4 (book inflated far above player range)
  if (dir === 'UNDER' && (effectiveMarket === 'assists' || effectiveMarket === 'pra') && edge >= 4.0) {
    const c = COHORTS.GUARANTEED;
    const lo = wilsonLo(c.wins, c.n);
    return {
      tier: 'GUARANTEED', bet: true, wr: c.wins / c.n, n: c.n, wilsonLo: lo,
      reason: `Book line ${l} is far above what this player can reach (proj ${p.toFixed(1)}, gap ${edge.toFixed(1)}). These inflated lines are 16-0 in graded history.`,
      watch, oppFlag,
    };
  }

  // ── TIER 2: PLATINUM ─────────────────────────────────────────────
  // assists under, line 4-8, edge 1-4, role ≥ 80
  if (dir === 'UNDER' && effectiveMarket === 'assists' && l >= 4.0 && l < 8.0 && edge >= 1.0 && edge < 4.0) {
    if (r < 80) {
      return {
        tier: 'BANNED', bet: false, wr: null, n: 0, wilsonLo: 0,
        reason: `Role score ${r} < 80 — floating role means assist count is unpredictable. Banned.`,
        watch, oppFlag,
      };
    }
    const c = COHORTS.PLATINUM;
    const lo = wilsonLo(c.wins, c.n);
    return {
      tier: 'PLATINUM', bet: true, wr: c.wins / c.n, n: c.n, wilsonLo: lo,
      reason: `Primary creator cold in locked role (role ${r}). Line ${l} assists vs proj ${p.toFixed(1)} — ${edge.toFixed(1)} gap. 96% historically.`,
      watch, oppFlag,
    };
  }

  // ── TIER 3: GOLD ─────────────────────────────────────────────────
  // rebounds under, proj 3-5, role ≥ 55, not Mabrey
  if (dir === 'UNDER' && effectiveMarket === 'rebounds') {
    if (PLAYER_BANS_REB_UNDER.has(pl)) {
      return {
        tier: 'BANNED', bet: false, wr: 0, n: 4, wilsonLo: 0,
        reason: `Marina Mabrey rebounds-under: 0-4 in graded history. Crashes harder than stats show. Permanent ban.`,
        watch, oppFlag,
      };
    }
    if (!Number.isFinite(p) || p < 3.0 || p >= 5.0) {
      const why = p < 3.0
        ? `Proj ${p.toFixed(1)} < 3.0 — too noisy (47% hit rate). Banned.`
        : `Proj ${p.toFixed(1)} ≥ 5.0 — primary rebounder. These crash hard regardless of line (7-7 in backtest). Banned.`;
      return { tier: 'BANNED', bet: false, wr: null, n: 0, wilsonLo: 0, reason: why, watch, oppFlag };
    }
    if (r < 55) {
      return {
        tier: 'BANNED', bet: false, wr: null, n: 0, wilsonLo: 0,
        reason: `Role score ${r} < 55 — situational player, board total is unpredictable. Banned.`,
        watch, oppFlag,
      };
    }
    // Opponent allows stats — downgrade to LEAN
    if (oppFlag === 'ALLOWS') {
      return {
        tier: 'LEAN', bet: false, wr: 0.60, n: 5, wilsonLo: 0.30,
        reason: `${opp} allows stat accumulation (33% rebounds-under hit rate vs CHI/TOR). Signal exists but opponent weakens it — size down or skip.`,
        watch, oppFlag,
      };
    }
    const c = COHORTS.GOLD;
    const lo = wilsonLo(c.wins, c.n);
    return {
      tier: 'GOLD', bet: true, wr: c.wins / c.n, n: c.n, wilsonLo: lo,
      reason: `Wing/guard rebound ceiling — proj ${p.toFixed(1)}, line ${l}, ${(l - p).toFixed(1)} gap. Positional role prevents reaching the line. 85% historically.`,
      watch, oppFlag,
    };
  }

  // ── POINTS: AVOID ────────────────────────────────────────────────
  if (effectiveMarket === 'points') {
    return {
      tier: 'AVOID', bet: false, wr: null, n: 94, wilsonLo: 0,
      reason: 'Points market: 44% overall, +2.84 projection bias. Off the board pending re-validation with de-biased engine.',
      watch: watch || null, oppFlag,
    };
  }

  // ── ALL OVERS (except GUARANTEED) ────────────────────────────────
  if (dir === 'OVER') {
    return {
      tier: 'PASS', bet: false, wr: 0.47, n: 28,
      wilsonLo: wilsonLo(13, 28),
      reason: 'OVER direction: 47% overall in graded history. No validated structural edge.',
      watch, oppFlag,
    };
  }

  // ── UNGRADED ─────────────────────────────────────────────────────
  return {
    tier: 'UNGRADED', bet: false, wr: null, n: 0, wilsonLo: 0,
    reason: `No validated cohort for ${effectiveMarket} ${dir}. Track and grade before betting.`,
    watch, oppFlag,
  };
}

export { wilsonLo, COHORTS, PLAYER_BANS_REB_UNDER, PLAYER_WATCHES };
