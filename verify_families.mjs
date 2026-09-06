#!/usr/bin/env node
// verify_families.mjs — coverage guard for Lyrid NFL prop families.
//
// Every filter layer must handle ALL prop families. New families (the pass_rush /
// rush_rec combos) have repeatedly slipped past filters written for the original
// three, shipping bad tiers (a QB combo with volume_floor 0, or skipping the
// blowout-script flag). This asserts each filter gives a NON-DEGENERATE answer for
// every family, so a coverage gap fails CI instead of a live board.
//
// Run: node verify_families.mjs   (exit 1 on any gap)

import { volumeSecurity } from './lib/nfl/nflVolumeSecurity.js';
import { gameScriptRisk } from './lib/nfl/nflGameScript.js';

const FAMILIES = ['passing_yards', 'rushing_yards', 'receiving_yards', 'pass_rush_yards', 'rush_rec_yards'];

// a healthy, full-time starter in EVERY dimension — should score secure in whichever
// family applies to it; the point is that no family returns the "unhandled" default.
const HEALTHY = Array.from({ length: 6 }, () => ({
  pass_attempts: 34, rush_attempts: 16, targets: 7, receptions: 5,
  target_share: 0.25, air_yards_share: 0.30, routes: 31, team_pass_plays: 34,
  snap_share: 0.9, was_garbage_time: false,
}));

let fails = 0;
const bad = (m) => { console.log('  *** ' + m); fails++; };

console.log('=== volumeSecurity: a healthy starter must score SECURE in every family ===');
for (const fam of FAMILIES) {
  const r = volumeSecurity({ games: HEALTHY, propFamily: fam });
  const ok = r && r.volume_floor_score >= 0.6 && r.archetype && r.archetype !== 'unknown';
  console.log(`  ${fam.padEnd(16)} floor=${r.volume_floor_score}  archetype=${r.archetype}  ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) bad(`${fam} not handled by volumeSecurity (unhandled family -> 0 / 'unknown')`);
}

console.log('=== gameScriptRisk: every family must be recognized in an underdog blowout ===');
for (const fam of FAMILIES) {
  const r = gameScriptRisk({ spread: 11, gameTotal: 45, propFamily: fam, archetype: 'committee', pick: 'higher' });
  const ok = r && (r.reasons.length > 0 || r.risk > 0);   // a +11 underdog OVER must register SOME risk
  console.log(`  ${fam.padEnd(16)} risk=${r.risk}  reasons=${r.reasons.length}  ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) bad(`${fam} not handled by gameScriptRisk (skips blowout suppression)`);
}

console.log(fails ? `\nFAILED — ${fails} family/filter coverage gap(s)` : '\nPASS — all families handled by all filters');
process.exit(fails ? 1 : 0);
