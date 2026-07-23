// nflMatchupNarrative.js
// Lyrid NFL engine — the "why" layer.
// Produces, for any yardage prop:
//   1. coverageContext  — what scheme the WR/TE is likely to face, in plain language
//   2. probableCoverage — WHICH defender most likely covers him (alignment-derived)
//   3. drivers          — ranked reasons the model leans OVER or UNDER
//
// DATA HONESTY — read this before trusting the CB matchup:
//   True CB "shadow" assignments (does CB X travel with WR Y?) are PAID charting
//   data (PFF / SIS). nflverse gives us coverage SCHEME (man/zone/shell rates) and
//   PERSONNEL (who's on the field), not who covered whom. So probableCoverage is an
//   ALIGNMENT-BASED INFERENCE: slot receivers draw the slot corner, outside
//   receivers draw the boundary corners by side. It is labeled `confidence` and
//   should never be presented as a confirmed assignment.
//   A team's known shadow tendency can be supplied via defScheme.shadow_cb to
//   upgrade confidence — that flag is manual/scraped, not derived.

const LG_MAN = 0.48; // league-average man rate (2024-derived)

function pct(x) { return x == null ? null : Math.round(x * 100); }

// ---------------------------------------------------------------------------
// 1. COVERAGE CONTEXT — what scheme is he walking into
// ---------------------------------------------------------------------------
export function coverageContext({ defScheme, oppName }) {
  if (!defScheme) return { text: 'Coverage scheme unavailable (prior-season data not loaded).', tags: [] };
  const man = defScheme.man_rate, zone = defScheme.zone_rate, blitz = defScheme.blitz_rate;
  const tags = [];
  let lean = 'balanced';
  if (man != null) {
    if (man - LG_MAN >= 0.06) { lean = 'man-heavy'; tags.push('man-heavy'); }
    else if (LG_MAN - man >= 0.06) { lean = 'zone-heavy'; tags.push('zone-heavy'); }
  }
  if (blitz != null && blitz >= 0.18) tags.push('blitz-heavy');

  // dominant coverage shell
  const shells = [
    ['Cover 1', defScheme.cover1_share], ['Cover 2', defScheme.cover2_share],
    ['Cover 3', defScheme.cover3_share], ['Cover 4', defScheme.cover4_share],
  ].filter(s => s[1] != null).sort((a, b) => b[1] - a[1]);
  const top = shells[0];

  const parts = [];
  parts.push(`${oppName || 'Opponent'} plays ${pct(man)}% man / ${pct(zone)}% zone (league ~${pct(LG_MAN)}% man) — ${lean}.`);
  if (top) parts.push(`Most common shell: ${top[0]} (${pct(top[1])}% of snaps).`);
  if (blitz != null) parts.push(`Blitz rate ${pct(blitz)}%.`);

  return { text: parts.join(' '), lean, tags, topShell: top ? top[0] : null };
}

// ---------------------------------------------------------------------------
// 2. PROBABLE COVERAGE — alignment-derived, NOT a confirmed shadow assignment
// ---------------------------------------------------------------------------
// receiver: { name, slotRate }  (slotRate = share of snaps in the slot, 0-1)
// cbDepth:  { outside: [{name, rank}], slot: [{name}] }  from depth chart
// defScheme.shadow_cb: optional manual flag — a CB known to travel with WR1
export function probableCoverage({ receiver, cbDepth, defScheme }) {
  if (!cbDepth || (!cbDepth.outside?.length && !cbDepth.slot?.length)) {
    return { defender: null, confidence: 'unknown', basis: 'no depth-chart data', note: null };
  }
  const slotRate = receiver?.slotRate;

  // team has a known travelling corner AND this is the clear WR1
  if (defScheme?.shadow_cb && receiver?.isWR1) {
    return {
      defender: defScheme.shadow_cb,
      confidence: 'likely',
      basis: 'team shadows WR1 with this corner (manual tendency flag)',
      note: 'Shadow tendency is a supplied flag, not charted per-play data.',
    };
  }

  if (slotRate == null) {
    return {
      defender: cbDepth.outside?.[0]?.name || null,
      confidence: 'low',
      basis: 'no alignment data — defaulting to CB1',
      note: 'Alignment-based guess only.',
    };
  }

  if (slotRate >= 0.6) {
    return {
      defender: cbDepth.slot?.[0]?.name || null,
      confidence: 'moderate',
      basis: `aligns in the slot on ${pct(slotRate)}% of snaps → draws the slot corner`,
      note: 'Alignment-derived, not a confirmed shadow assignment.',
    };
  }
  if (slotRate <= 0.3) {
    return {
      defender: cbDepth.outside?.[0]?.name || null,
      confidence: 'moderate',
      basis: `primarily outside (${pct(1 - slotRate)}% wide) → draws a boundary corner`,
      note: 'Which boundary corner depends on side; not a confirmed shadow.',
    };
  }
  return {
    defender: null,
    confidence: 'low',
    basis: `moves around (${pct(slotRate)}% slot) — no single primary defender`,
    note: 'Alignment is split; expect multiple coverage defenders.',
  };
}

// ---------------------------------------------------------------------------
// 3. DRIVERS — ranked reasons for the OVER/UNDER lean (the "why")
// ---------------------------------------------------------------------------
// Accepts the already-computed feature signals and turns them into a ranked,
// human-readable list. Weights are the actual z-nudges the model used, so the
// explanation IS the model, not a story bolted on afterward.
export function leanDrivers({ comp, volume, script, suppression, scheme, env, playerVsOpp, coverage }) {
  const d = [];
  const push = (f, w) => { if (w != null && Math.abs(w) >= 0.03) d.push({ f, dir: w > 0 ? '+' : '-', w: +w.toFixed(2) }); };

  if (comp?.lineSoftness != null && comp.median != null) {
    const soft = comp.lineSoftness;
    push(`model median ${comp.median} vs line (${soft > 0 ? '+' : ''}${soft})`, soft / 20);
  }
  if (volume?.volume_floor_score != null) {
    push(`${volume.archetype?.replace(/_/g, ' ') || 'role'} — volume floor ${volume.volume_floor_score}`,
      (volume.volume_floor_score - 0.6) * 0.8);
  }
  if (suppression?.nudge) push(suppression.reason || 'opponent suppression', suppression.nudge);
  if (scheme?.nudge) push(scheme.reason || 'scheme matchup', scheme.nudge);
  if (coverage?.lean === 'man-heavy') push('faces man-heavy coverage', 0.05);
  if (coverage?.lean === 'zone-heavy') push('faces zone-heavy coverage', -0.04);
  if (env?.total) push(env.total < 0 ? 'adverse weather/environment' : 'favorable environment', env.total);
  if (script?.risk) push(script.reasons?.[0] || 'game-script risk', -script.risk * 0.5);
  if (playerVsOpp?.nudge) push(playerVsOpp.reason || 'history vs this opponent', playerVsOpp.nudge);

  d.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  const net = d.reduce((s, x) => s + x.w, 0);
  return {
    drivers: d.slice(0, 6),
    net: +net.toFixed(2),
    lean: net > 0.08 ? 'over' : (net < -0.08 ? 'under' : 'neutral'),
  };
}

// Convenience: assemble the full narrative block for a card.
export function buildNarrative(args) {
  const cov = coverageContext(args);
  const pc = args.receiver ? probableCoverage(args) : null;
  const ld = leanDrivers({ ...args, coverage: cov });
  return { coverage: cov, probableCoverage: pc, ...ld };
}
