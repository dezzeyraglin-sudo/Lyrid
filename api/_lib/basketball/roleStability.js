// api/_lib/basketball/roleStability.js
//
// ROLE STABILITY (rewritten June 2, 2026)
//
// Scores how SECURE a player's role is — the floor under their minutes and
// touches — on a 0–100 scale. The unified engine reads `score` off the return
// (pick(role, ['score','stability'], 50)) and uses it as the ROLE sub-score and
// to widen/narrow the projection band.
//
// WHY THIS WAS REWRITTEN: the prior version floored the score to ~1 for players
// with a small games-played sample. Early in a season (e.g. 4 games in), a
// locked starter logging 29–30 stable minutes was being scored as "fragile,"
// which is backwards — a small sample is not an unstable role. This version
// derives stability from the signals that actually indicate role security:
//   1. MINUTES LOAD     — heavy minutes ⇒ secure role (starters play 28–34)
//   2. MINUTES CONSISTENCY (cv) — low game-to-game variance ⇒ locked role;
//                          high cv ⇒ genuinely volatile usage (the real risk)
//   3. STARTER / CLOSING ROLE — explicit role signals when present
// A small games sample only REDUCES CONFIDENCE (dataQuality), it does NOT floor
// the score.
//
// INPUT: the engine passes the whole `input`; we read `input.player`.
//   player.expectedMinutes | minutesAvg   (recent MPG, REAL from game log)
//   player.minutesCv                       (0 = perfectly stable, ~0.4 = volatile)
//   player.gamesPlayed                     (sample size — confidence only)
//   player.starter | closingRole           (role flags when available)
//   player.usageRate                       (high usage corroborates a real role)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export function calculateRoleStability(input) {
  const player = (input && input.player) ? input.player : (input || {});

  const minutes = num(player.expectedMinutes) ?? num(player.minutesAvg) ?? num(player.minutesLast5);
  const cv = num(player.minutesCv);
  const gp = num(player.gamesPlayed) ?? 0;
  const usage = (() => {
    let u = num(player.usageRate);
    if (u == null) return null;
    return u > 1 ? u / 100 : u;   // accept 28.6 or 0.286
  })();
  const isStarter = player.starter === true || player.starter === 1
    || /start|close/i.test(String(player.closingRole || ''));

  // If we have no minutes signal at all, return a true neutral (not a floor).
  if (minutes == null && cv == null && !isStarter) {
    return { score: 50, stability: 50, detail: 'no role data — neutral', dataQuality: 'NONE' };
  }

  // --- 1) Minutes-load component (0–100) ---
  // 30+ MPG = locked heavy role; 24 = solid rotation; 16 = bench; <10 = fringe.
  let minutesScore = 50;
  if (minutes != null) {
    // Map 8→20 MPG onto 30→55, 20→34 MPG onto 55→95, smoothly.
    if (minutes >= 20) minutesScore = clamp(55 + (minutes - 20) * (40 / 14), 55, 95);
    else minutesScore = clamp(20 + (minutes - 8) * (35 / 12), 15, 55);
  }

  // --- 2) Minutes-consistency component from cv (0–100) ---
  // cv 0.10 = rock-solid (95), 0.25 = normal (70), 0.40 = shaky (45), 0.60+ = volatile (20).
  let consistencyScore = 65;   // neutral-ish when cv unknown
  if (cv != null) {
    consistencyScore = clamp(100 - cv * 200, 10, 98);
  }

  // --- 3) Role-flag bonus ---
  const starterBonus = isStarter ? 8 : 0;
  // High usage corroborates a featured role (a 25%+ usage player isn't a fringe piece).
  const usageBonus = (usage != null && usage >= 0.24) ? 5 : 0;

  // Blend: minutes load and consistency are the two pillars; flags nudge.
  // Weight load a bit more — a heavy-minutes player is secure even if cv is moderate.
  let score = 0.55 * minutesScore + 0.45 * consistencyScore + starterBonus + usageBonus;
  score = clamp(score, 0, 100);

  // --- Confidence (NOT the score) reflects sample size. A 4-game sample is
  // trustworthy enough to score, but we flag it so downstream can widen bands. ---
  let dataQuality = 'REAL';
  if (gp > 0 && gp < 3) dataQuality = 'THIN (small sample)';
  else if (gp >= 3 && gp < 6) dataQuality = 'OK (early season)';

  const detail = minutes != null
    ? `${minutes.toFixed(0)} MPG${cv != null ? `, cv ${cv.toFixed(2)}` : ''}${isStarter ? ', starter' : ''}`
    : 'role from flags';

  return {
    score: Math.round(score),
    stability: Math.round(score),
    detail,
    dataQuality,
    components: {
      minutesScore: Math.round(minutesScore),
      consistencyScore: Math.round(consistencyScore),
      starterBonus, usageBonus,
    },
  };
}

export default calculateRoleStability;
