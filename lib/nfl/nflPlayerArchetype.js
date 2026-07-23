// nflPlayerArchetype.js
// Lyrid NFL engine — prop-family routing (which prop fits this player).
//
// The insight: some players' value lives in a COMBO prop, not a single-stat one.
//   * Receiving backs (Kamara, Ekeler, McCaffrey, Achane) — rush+rec captures their
//     real role; pure rushing yards understates them and is game-script fragile.
//   * Hybrid QBs (Lamar, Hurts, Jayden Daniels, Richardson, Fields) — pass+rush
//     captures their floor; pure passing yards misses ~40-55 rushing yards a game.
//
// Two INDEPENDENT dimensions, deliberately not collapsed:
//   archetype   — what KIND of player he is (stable, role-based)
//   availability — can we trust the volume (injury/sample risk)
// McCaffrey 2024 is the case that proves it: a textbook receiving back (42% receiving
// share, 4.8 tgt/g) who played 4 games. Archetype = strong. Availability = poor.
// Excluding him entirely would lose a real edge; ignoring the injury risk would
// repeat the volume-insecure losses. So we surface BOTH and let the classifier gate.

// ---- thresholds (validated against real 2024 nflverse data) ----
const RB = {
  MIN_YPG: 45,            // meaningful workload
  REC_SHARE_HI: 0.28,     // receiving is a real part of his yardage
  TGT_PER_G_HI: 4.0,      // consistent passing-game usage
  REC_SHARE_ELITE: 0.38,  // true receiving back (Ekeler/Achane territory)
};
const QB = {
  RUSH_SHARE_HI: 0.08,    // rushing is a meaningful share of total yards
  RUSH_YPG_HI: 25,        // ~25+ rushing yards/game is a real floor add
  RUSH_SHARE_ELITE: 0.17, // true dual-threat (Lamar/Hurts/Daniels/Richardson)
};
const MIN_GAMES_STABLE = 6; // below this, archetype is provisional (small sample)

function safeDiv(a, b) { return b ? a / b : 0; }

// season: { position, games, rushing_yards, receiving_yards, passing_yards, targets, carries }
export function classifyArchetype(season) {
  const pos = season?.position;
  const g = season?.games || 0;
  const rush = season?.rushing_yards || 0;
  const rec = season?.receiving_yards || 0;
  const pass = season?.passing_yards || 0;
  const tgt = season?.targets || 0;

  const out = {
    archetype: 'standard',
    bestPropFamily: null,
    altPropFamilies: [],
    availability: g >= MIN_GAMES_STABLE ? 'stable' : (g >= 3 ? 'limited_sample' : 'insufficient'),
    sampleGames: g,
    metrics: {},
    note: null,
  };

  // ---------------- RUNNING BACKS ----------------
  if (pos === 'RB') {
    const total = rush + rec;
    const recShare = +safeDiv(rec, total).toFixed(3);
    const tgtPerG = +safeDiv(tgt, g).toFixed(1);
    const ypg = +safeDiv(total, g).toFixed(1);
    out.metrics = { recShare, tgtPerG, ypg };

    const isReceiving = ypg >= RB.MIN_YPG && (recShare >= RB.REC_SHARE_HI || tgtPerG >= RB.TGT_PER_G_HI);
    if (isReceiving) {
      out.archetype = recShare >= RB.REC_SHARE_ELITE ? 'elite_receiving_back' : 'receiving_back';
      out.bestPropFamily = 'rush_rec_yards';
      out.altPropFamilies = ['receiving_yards', 'rushing_yards'];
      out.note = `${Math.round(recShare * 100)}% of yardage through the air, ${tgtPerG} tgt/g — rush+rec captures the real role and is game-script hedged.`;
    } else if (ypg >= RB.MIN_YPG) {
      out.archetype = 'early_down_back';
      out.bestPropFamily = 'rushing_yards';
      out.altPropFamilies = ['rush_rec_yards'];
      out.note = 'Ground-usage back — rushing yards is the cleaner read, but game-script fragile when trailing.';
    } else {
      out.archetype = 'committee_back';
      out.bestPropFamily = 'rush_rec_yards';
      out.note = 'Low/split workload — volume floor is the binding risk regardless of prop.';
    }
  }

  // ---------------- QUARTERBACKS ----------------
  else if (pos === 'QB') {
    const total = pass + rush;
    const rushShare = +safeDiv(rush, total).toFixed(3);
    const rushYpg = +safeDiv(rush, g).toFixed(1);
    out.metrics = { rushShare, rushYpg, passYpg: +safeDiv(pass, g).toFixed(1) };

    if (rushShare >= QB.RUSH_SHARE_HI || rushYpg >= QB.RUSH_YPG_HI) {
      out.archetype = rushShare >= QB.RUSH_SHARE_ELITE ? 'elite_dual_threat_qb' : 'mobile_qb';
      out.bestPropFamily = 'pass_rush_yards';
      out.altPropFamilies = ['passing_yards', 'rushing_yards'];
      out.note = `${rushYpg} rush yds/g (${Math.round(rushShare * 100)}% of total) — pass+rush captures the floor that pure passing yards misses.`;
    } else {
      out.archetype = 'pocket_qb';
      out.bestPropFamily = 'passing_yards';
      out.note = 'Pocket passer — passing yards is the primary market.';
    }
  }

  // ---------------- RECEIVERS / TIGHT ENDS ----------------
  else if (pos === 'WR' || pos === 'TE') {
    out.bestPropFamily = 'receiving_yards';
    out.archetype = pos === 'TE' ? 'tight_end' : 'receiver';
  }

  // availability caveat — archetype can be strong while volume is untrustworthy
  if (out.availability !== 'stable' && out.archetype !== 'standard') {
    out.note = (out.note ? out.note + ' ' : '') +
      `ARCHETYPE CONFIRMED but only ${g} game(s) of sample — treat volume floor as unproven (injury/role risk).`;
  }

  return out;
}

// Batch helper: find all players matching an archetype across a season table.
// Returns them sorted by how strongly they fit, INCLUDING low-sample players
// (flagged, not dropped) so injury-limited types like McCaffrey still surface.
export function findArchetype(seasons, archetypeName, { includeLowSample = true } = {}) {
  const rows = (seasons || []).map(s => ({ ...s, _cls: classifyArchetype(s) }));
  return rows
    .filter(r => r._cls.archetype === archetypeName)
    .filter(r => includeLowSample || r._cls.availability === 'stable')
    .sort((a, b) => {
      const key = c => c.metrics.recShare ?? c.metrics.rushShare ?? 0;
      return key(b._cls) - key(a._cls);
    });
}

export { RB as RB_THRESHOLDS, QB as QB_THRESHOLDS };
