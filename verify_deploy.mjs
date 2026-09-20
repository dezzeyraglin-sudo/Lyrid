#!/usr/bin/env node
// verify_deploy.mjs — anti-drift guard. Run BEFORE every push (npm prepush / CI).
//
// The recurring wound this session: nflProjectionAudit + the logging/grading feed
// drifted OUT of the deployed index more than once, silently, so nothing was being
// recorded and every calibration claim was theoretical. This asserts the
// load-bearing pieces are present in index.html and fails the build if any are
// missing — the same discipline as verify_families.mjs, applied to the feed.
//
// Usage:  node verify_deploy.mjs [path/to/index.html]
// Exit 0 = all present. Exit 1 = a required capability is missing (names it).

import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'index.html';
let src;
try { src = readFileSync(path, 'utf8'); }
catch (e) { console.error(`verify_deploy: cannot read ${path} — ${e.message}`); process.exit(1); }

// Each check: a human name + a substring (or regex) that MUST appear in the build.
// Keep these tied to the actual function/handle names so a rename is caught too.
const REQUIRED = [
  // ---- the validation feed (this is the projection audit: logNflBets logs EVERY pick,
  //      isBet flags the actionable ones — nflPropHistory IS the audit store) ----
  ['prop logging (all picks)', 'window.logNflBets ='],
  ['logs every pick (audit)',  /isBet: tier !== 'none'/],   // guards the "log everything" behavior
  ['prop grading',             'window.gradeNflProps ='],
  ['client box scores',        'async function fetchNflBoxScores'],
  ['audit store',              /state\.nflPropHistory/],
  ['totals logging',           'window.logNflTotals ='],
  ['totals grading',           'window.gradeNflTotals ='],
  ['totals report',            'window.nflTotalsReport ='],
  // ---- the calibration readout (the honesty layer) ----
  ['calibration compute',      'computeNflPropStats'],
  ['tier-proof slice',         'BY MODEL TIER'],
  ['under-watch slice',        'UNDER WATCH'],
  // ---- the live context gates that must reach the card ----
  ['live QB gate',        'function nflQbOut'],
  ['featured gate read',  'function isBettable'],
];

const missing = [];
for (const [name, needle] of REQUIRED) {
  const present = needle instanceof RegExp ? needle.test(src) : src.includes(needle);
  if (!present) missing.push(name);
}

if (missing.length) {
  console.error('\n\u2717 verify_deploy FAILED — the deployed index is missing:');
  for (const m of missing) console.error('    \u2022 ' + m);
  console.error('\nThese are load-bearing (the audit feed / grading / gates). Do NOT push a build');
  console.error('that dropped them — that is how the feed goes silent and calibration becomes fiction.\n');
  process.exit(1);
}
console.log(`\u2713 verify_deploy: all ${REQUIRED.length} required capabilities present in ${path}`);
process.exit(0);
