/**
 * teammateRedistribution.js
 *
 * When a player is OUT, their minutes don't vanish -- they get redistributed to teammates.
 * This is the sharpest edge in basketball props: the books are slow to adjust to scratches
 * announced inside an hour of tip, and the *secondary* effect (backup's usage spike) is
 * even slower to price in.
 *
 * Algorithm (from spec):
 *
 *   For each OUT player:
 *     1. vacatedMinutes = player.projMinutes * 0.85
 *        (15% absorbed by garbage time / fewer rotations rather than going to a teammate)
 *     2. Find same-position teammates, sorted by season MPG descending
 *     3. Distribute vacatedMinutes with weights [0.50, 0.30, 0.20] to top 3 teammates
 *     4. Boost each teammate's usage proportionally (capped)
 *     5. Cap each teammate at POSITION_CAP_MINUTES (38)
 *
 * Position-compatibility for backfill:
 *   PG <-> SG <-> SF <-> PF <-> C  (chain, no skipping)
 *   So a missing PG is backfilled by SGs (and other PGs), not by PFs/Cs.
 *   WNBA rosters are small (12), so when same-position is thin we extend to adjacent positions
 *   with reduced weights.
 *
 * The function takes roster projections AFTER computeProjMinutes has run, and mutates them.
 * It returns an audit log of what was redistributed where.
 */

const POSITION_CAP_MINUTES = 38;
const VACATED_MINUTES_RETENTION = 0.85; // 85% goes to teammates, 15% to garbage time
const REDISTRIBUTION_WEIGHTS = [0.50, 0.30, 0.20];
const USAGE_BOOST_CAP = 1.30; // backup's usage can rise by at most 30%

// Position adjacency: maps each position to ordered list of acceptable backfill positions.
// First entry is same-position (full weight). Later entries are adjacent (reduced weight).
const POSITION_BACKFILL_CHAIN = {
  'PG': ['PG', 'SG'],
  'SG': ['SG', 'PG', 'SF'],
  'SF': ['SF', 'SG', 'PF'],
  'PF': ['PF', 'SF', 'C'],
  'C':  ['C', 'PF'],
  // ESPN sometimes uses just G/F/C (no PG/SG split)
  'G':  ['G', 'F'],
  'F':  ['F', 'G', 'C'],
};

// Weight multiplier by adjacency distance: same-pos=1.0, adjacent=0.6
const ADJACENCY_WEIGHT = [1.0, 0.6, 0.3];

/**
 * @param {Object[]} roster - array of player projection objects from computeProjMinutes
 *   Each must have: { playerId, playerName, position, projMinutes, season_mpg, status, usage? }
 * @returns {Object} { roster: modified roster, audit: redistribution log }
 *
 * Note: this MUTATES the roster array (and the objects in it). Callers who need
 * an unmodified copy should deep-clone before passing in. We mutate intentionally because
 * cloning every roster every game is wasteful and the slate orchestrator owns the roster anyway.
 */
function redistributeOutMinutes(roster) {
  if (!Array.isArray(roster)) throw new Error('redistributeOutMinutes: roster must be array');

  const audit = [];
  const outPlayers = roster.filter(p => p.status === 'OUT' && (p.projMinutes === 0 || p.projMinutes === undefined));

  // For each OUT player, we need a "what would they have played" baseline.
  // If the caller has already zeroed their projMinutes (because OUT short-circuits),
  // we use their season_mpg as the proxy for vacated minutes. This is the right move
  // because we want to redistribute the role, not the (now zero) projection.
  for (const out of outPlayers) {
    const baseline = typeof out.season_mpg === 'number' && out.season_mpg > 0
      ? out.season_mpg
      : 0;
    if (baseline === 0) {
      audit.push({
        outPlayer: out.playerName || out.playerId,
        outPosition: out.position,
        vacatedMinutes: 0,
        recipients: [],
        note: 'no season_mpg baseline for OUT player -- nothing to redistribute',
      });
      continue;
    }

    const vacatedMinutes = baseline * VACATED_MINUTES_RETENTION;
    const recipients = findBackfillRecipients(roster, out);

    if (recipients.length === 0) {
      audit.push({
        outPlayer: out.playerName || out.playerId,
        outPosition: out.position,
        vacatedMinutes: round1(vacatedMinutes),
        recipients: [],
        note: 'no eligible same-position or adjacent-position teammates found',
      });
      continue;
    }

    // Apply redistribution.
    const distributed = [];
    let remainingMinutes = vacatedMinutes;
    for (let i = 0; i < recipients.length && i < REDISTRIBUTION_WEIGHTS.length; i++) {
      const recipient = recipients[i].player;
      const adjDistance = recipients[i].adjacencyDistance;
      const baseWeight = REDISTRIBUTION_WEIGHTS[i];
      const adjMultiplier = ADJACENCY_WEIGHT[adjDistance] || 0.3;
      const allocation = vacatedMinutes * baseWeight * adjMultiplier;

      const newMinutes = Math.min(POSITION_CAP_MINUTES, recipient.projMinutes + allocation);
      const actualAllocation = newMinutes - recipient.projMinutes;

      recipient.projMinutes = round1(newMinutes);
      remainingMinutes -= actualAllocation;

      // Boost usage proportionally to the minutes increase.
      // If a player went from 20 to 28 minutes (40% increase), boost usage by up to 40% (capped at 30%).
      if (typeof recipient.usage === 'number' && actualAllocation > 0) {
        const minutesRatio = newMinutes / Math.max(recipient.projMinutes - actualAllocation, 1);
        const usageMultiplier = Math.min(USAGE_BOOST_CAP, minutesRatio);
        recipient.usage = round3(recipient.usage * usageMultiplier);
      }

      // Annotate audit trail on the recipient itself for downstream debugging.
      if (!recipient._engineAudit) recipient._engineAudit = {};
      if (!recipient._engineAudit.absorbedMinutes) recipient._engineAudit.absorbedMinutes = [];
      recipient._engineAudit.absorbedMinutes.push({
        fromPlayer: out.playerName || out.playerId,
        fromPosition: out.position,
        adjacencyDistance: adjDistance,
        allocatedMinutes: round1(actualAllocation),
      });

      distributed.push({
        toPlayer: recipient.playerName || recipient.playerId,
        toPosition: recipient.position,
        adjacencyDistance: adjDistance,
        allocatedMinutes: round1(actualAllocation),
        newProjMinutes: recipient.projMinutes,
      });

      if (remainingMinutes <= 0) break;
    }

    audit.push({
      outPlayer: out.playerName || out.playerId,
      outPosition: out.position,
      vacatedMinutes: round1(vacatedMinutes),
      recipients: distributed,
      unallocatedMinutes: round1(Math.max(0, remainingMinutes)),
    });
  }

  return { roster, audit };
}

/**
 * Find eligible backfill recipients for an OUT player, sorted by priority.
 * Returns [{ player, adjacencyDistance }, ...] -- adjacencyDistance 0 = same position.
 */
function findBackfillRecipients(roster, outPlayer) {
  const chain = POSITION_BACKFILL_CHAIN[outPlayer.position] || [outPlayer.position];
  const candidates = [];

  for (let dist = 0; dist < chain.length; dist++) {
    const targetPos = chain[dist];
    const matches = roster.filter(p =>
      p !== outPlayer
      && p.status !== 'OUT'
      && p.position === targetPos
      && typeof p.season_mpg === 'number'
    );
    // Sort same-position candidates by season MPG (highest first -- they're the backups in line)
    matches.sort((a, b) => (b.season_mpg || 0) - (a.season_mpg || 0));
    for (const m of matches) {
      candidates.push({ player: m, adjacencyDistance: dist });
    }
  }

  return candidates;
}

function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }

module.exports = {
  redistributeOutMinutes,
  findBackfillRecipients,
  // exported for tuning
  VACATED_MINUTES_RETENTION,
  REDISTRIBUTION_WEIGHTS,
  POSITION_BACKFILL_CHAIN,
};
