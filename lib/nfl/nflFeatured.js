// lib/nfl/nflFeatured.js
// -----------------------------------------------------------------------------
// Featured gate for Tonight's Card — CORRECTED per the graded record.
//
// The prior version removed the position/family holds ("a high-volume TE becomes
// featured"). The graded data does NOT support that: TE receiving busted (Loveland
// 0 targets behind a raw QB), and the rush_rec / pass_rush COMBO families run ~40%.
// So the holds are DELIBERATE and data-backed, not taste — they stay. What this
// rework keeps from the prior module is the good part: honest reason strings
// (describeExclusion) and the qualified-but-below-cap split, so nothing that
// actually qualified gets dumped in the reject pile as "below the bar".
//
// It also fixes the "no RB ever features" issue: RB rushing pOver structurally
// runs lower than QB/WR passing pOver (rushing is lower-variance), so RBs qualify
// but lose the rankScore race and fall past the cap. `minPerPosition` (opt-in)
// guarantees a qualifying RB a card slot so a real bellcow rush isn't shut out.
//
// Operates on the /api/nfl/slate pick shape:
//   pick.position 'QB'|'RB'|'WR'|'TE'  · pick.propType 'passing_yards'|...
//   pick.team, pick.opponent
//   pick.verdict.{ tier_candidate, filters{softLine,volumeSecure,scriptClear},
//                  blocked[], pOverAdjusted, edge, provisional }
//   pick.featured.{ ok, why }   (server gate: QB form, committee, shadow, etc.)
// -----------------------------------------------------------------------------

const TIER_WEIGHT = { GUARANTEED: 3, PLATINUM: 2, GOLD: 1, none: 0 };

// Families with enough Wilson-LB-gated graded history to badge at FULL confidence.
// POPULATE FROM THE AUDIT (TIER PROOF slice) once the feed accumulates — the ONLY
// knob that should be data-driven. Until data exists this conservative default is
// CORRECT, not a placeholder (single-stat overs are the only validated slice).
const DEFAULT_PROVEN_FAMILIES = new Set([
  'WR:receiving_yards',
  'RB:rushing_yards',
  'QB:passing_yards',
]);

// HELD families — explicit, labeled, overridable. These are the data-backed
// exclusions, not blanket position bans:
//   TE:receiving_yards  — target-fragile; busted on the board, held pending proof.
//   *:rush_rec / pass_rush — combo comp pools thin/missing; families graded ~40%.
const DEFAULT_HOLD_FAMILIES = new Map([
  ['TE:receiving_yards', 'TE receiving — target-fragile (held pending graded proof)'],
  ['QB:pass_rush_yards', 'pass+rush combo — comp pool unvalidated (~40% graded)'],
  ['RB:rush_rec_yards',  'rush+rec combo — comp pool unvalidated (~40% graded)'],
  ['WR:rush_rec_yards',  'rush+rec combo — comp pool unvalidated (~40% graded)'],
]);

const familyKey = (p) => `${p.position}:${p.propType}`;
const gameKey = (p) => [p.team, p.opponent].sort().join('@');

// Returns { ok, provisional, provenFamily, why, display, rankScore, position }.
function evaluateFeatured(pick, opts = {}) {
  const proven = opts.provenFamilies || DEFAULT_PROVEN_FAMILIES;
  const hold   = opts.holdFamilies   || DEFAULT_HOLD_FAMILIES;
  const minEdge = opts.minEdge ?? 0.04;
  const v = (pick && pick.verdict) || {};
  const f = v.filters || {};
  const key = familyKey(pick);
  const pos = pick && pick.position;

  // 0) Server featured gate (QB form, committee, current-role, coverage) wins first,
  //    carrying its own honest reason. This is where "QB risk — poor recent form",
  //    "not the lead back", etc. come from — the server already decided.
  if (pick && pick.featured && pick.featured.ok === false) {
    return excl('server-gate', pick.featured.why || 'not featured');
  }
  // 1) Must earn a tier.
  if (!v.tier_candidate || v.tier_candidate === 'none') {
    return excl('no-tier', 'No tier — line too short or no edge');
  }
  // 2) Hard vetoes carry their own reason verbatim (stale role, blowout, etc.).
  if (Array.isArray(v.blocked) && v.blocked.length) {
    return excl('blocked', v.blocked[0]);
  }
  // 3) Held family — explicit, labeled reason (NOT a generic "below the bar").
  if (hold.has(key)) {
    return excl('family-held', hold.get(key));
  }
  // 4) Three-filter bar — name the filter that failed.
  const failed = [];
  if (!f.softLine)     failed.push('line not soft enough');
  if (!f.volumeSecure) failed.push('volume floor too low');
  if (!f.scriptClear)  failed.push('game-script risk');
  if (failed.length) return excl('filters', failed.join(' \u00b7 '));

  // 5) Real edge, not just a short/soft line.
  if ((v.edge ?? 0) < minEdge) {
    return excl('thin-edge', `no real edge (${(v.edge ?? 0).toFixed(2)})`);
  }

  const isProven = proven.has(key);
  const rankScore =
      (v.pOverAdjusted ?? 0) +
      0.05 * (TIER_WEIGHT[v.tier_candidate] || 0) +
      0.25 * (v.edge ?? 0);

  return {
    ok: true,
    provisional: !isProven || v.provisional === true,
    provenFamily: isProven,
    why: null,
    display: null,
    rankScore,
    position: pos,
  };

  function excl(why, display) {
    return { ok: false, provisional: false, provenFamily: false, why, display, rankScore: 0, position: pos };
  }
}

// Ranked, capped selection with an optional per-position floor.
//   opts.cap            total card size (default 5)
//   opts.maxPerGame     avoid one game dominating (default 2)
//   opts.minPerPosition e.g. { RB: 1 } — guarantee a qualifying RB a slot even if
//                       it ranks past the cap (fixes the rushing-pOver squeeze).
//                       Opt-in: default {} preserves pure rank so we can first SEE
//                       (via belowCap) whether RBs are squeezed before forcing them.
function selectFeatured(picks, opts = {}) {
  const cap = opts.cap ?? 5;
  const maxPerGame = opts.maxPerGame ?? 2;
  const minPerPosition = opts.minPerPosition || {};
  const evaluated = picks.map((p) => ({ pick: p, f: evaluateFeatured(p, opts) }));
  const qualifying = evaluated.filter((e) => e.f.ok)
                              .sort((a, b) => b.f.rankScore - a.f.rankScore);

  const card = [];
  const belowCap = [];
  const perGame = {};
  const posCount = {};
  const take = (e) => {
    const g = gameKey(e.pick);
    card.push(e);
    perGame[g] = (perGame[g] || 0) + 1;
    posCount[e.f.position] = (posCount[e.f.position] || 0) + 1;
  };

  for (const e of qualifying) {
    const g = gameKey(e.pick);
    if (card.length < cap && (perGame[g] || 0) < maxPerGame) take(e);
    else belowCap.push(e);
  }

  // per-position floor: if a required position is under its minimum, pull its best
  // below-cap qualifier onto the card (displacing the weakest non-required pick).
  for (const [posName, need] of Object.entries(minPerPosition)) {
    while ((posCount[posName] || 0) < need) {
      const idx = belowCap.findIndex((e) => e.f.position === posName &&
                    (perGame[gameKey(e.pick)] || 0) < maxPerGame);
      if (idx < 0) break;                       // none qualified — nothing to force
      const promote = belowCap.splice(idx, 1)[0];
      // drop the lowest-ranked card pick that isn't itself protecting a floor
      let dropAt = -1, dropScore = Infinity;
      for (let i = 0; i < card.length; i++) {
        const c = card[i];
        const protects = (minPerPosition[c.f.position] || 0) >= (posCount[c.f.position] || 0);
        if (!protects && c.f.rankScore < dropScore) { dropScore = c.f.rankScore; dropAt = i; }
      }
      if (dropAt >= 0) {
        const dropped = card.splice(dropAt, 1)[0];
        perGame[gameKey(dropped.pick)]--; posCount[dropped.f.position]--;
        belowCap.push(dropped);
      }
      take(promote);
    }
  }

  card.sort((a, b) => b.f.rankScore - a.f.rankScore);
  return { card, belowCap, evaluated };
}

// One honest sentence for any non-featured pick — feed to the flagged/secondary list.
function describeExclusion(pick, opts = {}) {
  const r = evaluateFeatured(pick, opts);
  return r.ok ? null : r.display;
}

export {
  evaluateFeatured,
  selectFeatured,
  describeExclusion,
  DEFAULT_PROVEN_FAMILIES,
  DEFAULT_HOLD_FAMILIES,
};
