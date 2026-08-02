#!/usr/bin/env node
// backtest.mjs — Lyrid NFL engine validation + tier calibration.
//
// Answers three questions at once:
//   1. IS THE MODEL ACCURATE?  — does the projected median track real outcomes, or
//      is the pool skewed (e.g. systematically low, which is what the current
//      under-lean on every receiver would suggest)?
//   2. ARE THE PROBABILITIES CALIBRATED? — when the model says 60% over, does it hit
//      ~60%? (reliability curve)
//   3. WHAT SHOULD THE TIER CUTOFFS BE? — replaces the PROVISIONAL GOLD/PLAT/GUAR
//      thresholds with values backed by real hit-rates + Wilson lower bounds.
//
// METHOD (walk-forward, leakage-safe):
//   For each test season, for each player-game:
//     * build the comp POOL from PRIOR seasons only (never the test game)
//     * project P(over) at the ACTUAL DraftKings/PP line for that game
//     * record whether the real result went over
//   Then bucket by predicted P(over) and compare to actual hit-rate.
//
// INPUTS (all local files you already have):
//   --vectors  path to a JSON dump of nfl_feature_vectors (export once from Supabase)
//   --lines    path to historical lines (DraftKings via The Odds API, or PP tracker)
//              [{player_key, season, week, prop_type, line, actual_yards}]
//   If --lines is omitted, it self-grades against the vectors' own outcomes using a
//   synthetic line at the pool median ± noise, which still exposes pool skew and
//   calibration (but NOT real-line edge — for that you need the DK pull).
//
// USAGE:
//   node data/nfl/backtest.mjs --vectors vectors.json --lines dk_lines.json --test 2024 2025
//   node data/nfl/backtest.mjs --vectors vectors.json --test 2024 2025   (self-grade mode)

import fs from 'node:fs';
import { compProject } from '../../lib/nfl/nflCompEngine.js';
import { classifyProp, wilsonLower } from '../../lib/nfl/nflClassify.js';

// ---- args ----
const args = process.argv.slice(2);
const getArg = (name, n = 1) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return n === 1 ? args[i + 1] : args.slice(i + 1, i + 1 + n).filter(x => !x.startsWith('--'));
};
const vectorsPath = getArg('--vectors');
const linesPath = getArg('--lines');
const testSeasons = (getArg('--test', 9) || ['2024', '2025']).map(Number);
if (!vectorsPath) { console.error('need --vectors path/to/nfl_feature_vectors.json'); process.exit(1); }

const FAM_TO_POS = { passing_yards: 'QB', rushing_yards: 'RB', receiving_yards: 'WR' };

// ---- load the feature-vector dump ----
// expected row shape (matches the table): {player_key, season, week, prop_type,
//   volume_floor_score, feature_json:{recent_form, outcome_yards, trailing_yards}}
const rows = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
console.log(`loaded ${rows.length} vectors`);

function poolFor(fam, beforeSeason) {
  // leakage guard: only games from seasons STRICTLY BEFORE the test season
  const pos = FAM_TO_POS[fam];
  const out = [];
  for (const r of rows) {
    if (r.prop_type !== fam) continue;
    if (r.season >= beforeSeason) continue;
    const fj = r.feature_json || {};
    const outcome = Number(fj.outcome_yards ?? fj.trailing_yards);
    if (!Number.isFinite(outcome)) continue;
    out.push({ position: pos, features: {
      volume_floor: num(r.volume_floor_score), recent_form: num(fj.recent_form),
    }, outcome });
  }
  return out;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ---- build the test set ----
let testSet;
if (linesPath) {
  testSet = JSON.parse(fs.readFileSync(linesPath, 'utf8'))
    .filter(l => testSeasons.includes(Number(l.season)));
  console.log(`graded against ${testSet.length} real historical lines`);
} else {
  // self-grade: each test-season vector becomes a case, line = its own trailing
  // form (a realistic proxy for where a book would set it), graded vs real outcome.
  testSet = rows.filter(r => testSeasons.includes(r.season)).map(r => {
    const fj = r.feature_json || {};
    return {
      player_key: r.player_key, season: r.season, week: r.week, prop_type: r.prop_type,
      line: Number(fj.trailing_yards),                 // proxy line = pre-game form
      actual_yards: Number(fj.outcome_yards ?? fj.trailing_yards),
      _features: { volume_floor: num(r.volume_floor_score), recent_form: num(fj.recent_form) },
    };
  }).filter(t => Number.isFinite(t.line) && Number.isFinite(t.actual_yards) && t.line > 0);
  console.log(`self-grading ${testSet.length} cases (proxy lines) — exposes skew + calibration, not real-line edge`);
}

// ---- run projections ----
const buckets = new Map();  // predP bucket -> {n, wins}
const skew = { sumMedianMinusActual: 0, n: 0 };
const tierRows = { GOLD: [], PLATINUM: [], GUARANTEED: [], none: [] };
let graded = 0;

for (const t of testSet) {
  const pool = poolFor(t.prop_type, t.season);
  if (pool.length < 40) continue;  // need a real pool
  const feats = t._features || {};
  const comp = compProject({ target: { position: FAM_TO_POS[t.prop_type], propFamily: t.prop_type, features: feats }, pool, line: t.line });
  if (comp.pOver == null || comp.median == null) continue;

  const wentOver = t.actual_yards > t.line;
  graded++;

  // calibration bucket (10% wide)
  const b = Math.min(9, Math.floor(comp.pOver * 10));
  const cur = buckets.get(b) || { n: 0, wins: 0, sumP: 0 };
  cur.n++; cur.wins += wentOver ? 1 : 0; cur.sumP += comp.pOver;
  buckets.set(b, cur);

  // skew: is the projected median systematically above/below actual?
  skew.sumMedianMinusActual += (comp.median - t.actual_yards);
  skew.n++;

  // tier grading (using current provisional cutoffs)
  const verdict = classifyProp({ comp, volume: { volume_floor_score: feats.volume_floor }, script: { risk: 0, flag: false, reasons: [] }, line: t.line, extraNudges: 0, pick: 'higher' });
  const tier = verdict.tier_candidate || 'none';
  const pickWon = (verdict.pick === 'higher') ? wentOver : !wentOver;
  (tierRows[tier] || tierRows.none).push(pickWon ? 1 : 0);
}

// ---- report ----
console.log(`\n=== graded ${graded} projections ===\n`);

// 1) POOL SKEW — the thing you asked about
const meanSkew = skew.sumMedianMinusActual / skew.n;
console.log('POOL SKEW (projected median minus actual result):');
console.log(`  mean = ${meanSkew.toFixed(2)} yards`);
if (meanSkew < -3) console.log('  -> model projects LOW (pool skewed under). The under-lean is a calibration artifact, not signal.');
else if (meanSkew > 3) console.log('  -> model projects HIGH (pool skewed over).');
else console.log('  -> projections are roughly unbiased. An under-lean on a given slate is signal, not skew.');

// 2) CALIBRATION CURVE
console.log('\nCALIBRATION (predicted P(over) vs actual hit-rate):');
console.log('  bucket  n     predicted  actual   gap');
for (let b = 0; b <= 9; b++) {
  const c = buckets.get(b); if (!c || !c.n) continue;
  const pred = c.sumP / c.n, act = c.wins / c.n;
  const flag = Math.abs(pred - act) > 0.08 ? '  <-- off' : '';
  console.log(`  ${(b*10).toString().padStart(2)}-${b*10+10}%  ${String(c.n).padStart(4)}   ${(pred*100).toFixed(1).padStart(6)}%   ${(act*100).toFixed(1).padStart(5)}%  ${((act-pred)*100).toFixed(1).padStart(5)}%${flag}`);
}

// 3) TIER HIT-RATES with Wilson lower bound -> calibrated cutoffs
console.log('\nTIER HIT-RATES (provisional cutoffs) + Wilson 95% lower bound:');
console.log('  tier         picks   raw%    wilson-lower');
for (const tier of ['GUARANTEED', 'PLATINUM', 'GOLD', 'none']) {
  const arr = tierRows[tier]; if (!arr.length) { console.log(`  ${tier.padEnd(11)}  (none)`); continue; }
  const wins = arr.reduce((a, b) => a + b, 0), n = arr.length;
  const raw = wins / n, wl = wilsonLower(wins, n);
  console.log(`  ${tier.padEnd(11)}  ${String(n).padStart(5)}   ${(raw*100).toFixed(1)}%   ${(wl*100).toFixed(1)}%`);
}
console.log('\nCALIBRATION RULE: a tier LABEL is only safe to ship if its Wilson-lower');
console.log('bound clears the target (GOLD 57 / PLAT 62 / GUAR 68) on 100+ picks.');
console.log('If a tier\'s wilson-lower is below its target, RAISE that cutoff until it clears.');
