// tennisFeatureBuilder.js — melted rows → per-player, per-surface serve/return profiles.
//
// Rates are computed on their natural denominators (per service game / per service point),
// then SHRUNK toward a prior so thin surface samples don't produce wild projections:
//   surface rate  →shrink→  player's all-surface rate  →shrink→  rank-cohort baseline.
// Shrinkage is on the denominator (empirical-Bayes style), k = pseudo-observations of prior.
//
// Emits tennis_serve_index.json:
//   { meta, cohorts, players: { [id]: { name, lastDate, surfaces: { ALL, Hard, Clay, Grass, Carpet } } } }
// Each surface profile carries the shrunk rates AND the raw sample (n matches, svGms) so the
// classifier can gate on sample size and never trust a 6-match clay profile like a 200-match one.
//
// ESM. Import buildIndex(rows[, opts]) or run as a CLI over ./data/tennis/*.csv.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRowsFromCsv } from './tennisFeed.js';

const SURFACES = ['Hard', 'Clay', 'Grass', 'Carpet'];
const K_TO_ALL = 40;     // service games of pull from surface → player-all
const K_TO_COHORT = 80;  // service games of pull from player-all → cohort baseline
const K_RET = 30;        // return-games pull

// Rank buckets for the cohort baseline (shrinkage target of last resort).
function rankBucket(r) {
  if (r == null) return 'unranked';
  if (r <= 10) return 'top10';
  if (r <= 30) return 'top30';
  if (r <= 75) return 'top75';
  if (r <= 150) return 'top150';
  return 'beyond150';
}

// Accumulator of raw serve/return counters.
function newAcc() {
  return {
    n: 0, wins: 0, retApp: 0, // matches, wins, retirements appeared in
    // serve
    ace: 0, df: 0, svpt: 0, firstIn: 0, firstWon: 0, secondWon: 0, svGms: 0, bpSaved: 0, bpFaced: 0,
    // return-side (derived from opponent serve line)
    retSvpt: 0, retPtsWon: 0, acesFaced: 0, retGms: 0, breaksMade: 0,
    lastDate: '',
  };
}

function add(acc, row) {
  acc.n++;
  if (row.won) acc.wins++;
  if (row.retired) acc.retApp++;
  if (row.date > acc.lastDate) acc.lastDate = row.date;
  if (!row.hasStats) return; // form counted, serve rates skipped
  const s = row;
  if (s.svGms != null) {
    acc.ace += s.ace || 0; acc.df += s.df || 0; acc.svpt += s.svpt || 0;
    acc.firstIn += s.firstIn || 0; acc.firstWon += s.firstWon || 0; acc.secondWon += s.secondWon || 0;
    acc.svGms += s.svGms || 0; acc.bpSaved += s.bpSaved || 0; acc.bpFaced += s.bpFaced || 0;
  }
  if (s.oppSvGms != null && s.oppSvpt != null) {
    const oppServePtsWon = (s.oppFirstWon || 0) + (s.oppSecondWon || 0);
    acc.retSvpt += s.oppSvpt || 0;
    acc.retPtsWon += (s.oppSvpt || 0) - oppServePtsWon; // return points THIS player won
    acc.acesFaced += s.oppAce || 0;
    acc.retGms += s.oppSvGms || 0;
    acc.breaksMade += Math.max(0, (s.oppBpFaced || 0) - (s.oppBpSaved || 0)); // break POINTS converted
  }
}

// Raw rates from an accumulator (null where denominator absent).
function rawRates(a) {
  const svpt = a.svpt || 0, svGms = a.svGms || 0, retGms = a.retGms || 0, retSvpt = a.retSvpt || 0;
  const firstIn = a.firstIn || 0;
  return {
    n: a.n, svGms, retGms, winPct: a.n ? a.wins / a.n : null,
    acePerSvGm: svGms ? a.ace / svGms : null,
    dfPerSvGm: svGms ? a.df / svGms : null,
    firstInPct: svpt ? firstIn / svpt : null,
    firstWonPct: firstIn ? a.firstWon / firstIn : null,
    secondWonPct: (svpt - firstIn) > 0 ? a.secondWon / (svpt - firstIn) : null,
    servePtsWonPct: svpt ? (a.firstWon + a.secondWon) / svpt : null,
    retPtsWonPct: retSvpt ? a.retPtsWon / retSvpt : null,
    acesFacedPerRetGm: retGms ? a.acesFaced / retGms : null,
  };
}

// Empirical-Bayes shrink of `rate` (with `denom` observations) toward `prior`, strength k.
function shrink(rate, denom, prior, k) {
  if (rate == null) return prior;
  if (prior == null) return rate;
  const d = denom || 0;
  return (d * rate + k * prior) / (d + k);
}

// Blend a surface profile toward all-surface, then toward cohort baseline.
function shrinkProfile(surfRaw, allRaw, cohort) {
  const svD = surfRaw.svGms, retD = surfRaw.retGms;
  const step = (key, denom, k1, k2) => {
    const toAll = shrink(surfRaw[key], denom, allRaw ? allRaw[key] : null, k1);
    return shrink(toAll, denom, cohort ? cohort[key] : null, k2);
  };
  return {
    n: surfRaw.n, svGms: surfRaw.svGms, retGms: surfRaw.retGms, winPct: surfRaw.winPct,
    acePerSvGm: step('acePerSvGm', svD, K_TO_ALL, K_TO_COHORT),
    dfPerSvGm: step('dfPerSvGm', svD, K_TO_ALL, K_TO_COHORT),
    firstInPct: step('firstInPct', svD, K_TO_ALL, K_TO_COHORT),
    servePtsWonPct: step('servePtsWonPct', svD, K_TO_ALL, K_TO_COHORT),
    retPtsWonPct: step('retPtsWonPct', retD, K_RET, K_RET * 2),
    acesFacedPerRetGm: step('acesFacedPerRetGm', retD, K_RET, K_RET * 2),
    raw: surfRaw, // keep raw for transparency / sample gating
  };
}

export function buildIndex(rows, opts = {}) {
  // players[id] = { name, byKey: { 'ALL'|surface : acc }, latestRank }
  const players = new Map();
  const cohortAcc = new Map(); // `${bucket}|${surface}` and `${bucket}|ALL`

  for (const r of rows) {
    if (!r.playerId) continue;
    let P = players.get(r.playerId);
    if (!P) { P = { name: r.playerName, latestRank: r.playerRank, latestDate: r.date, byKey: new Map() }; players.set(r.playerId, P); }
    if (r.date >= P.latestDate) { P.latestDate = r.date; if (r.playerRank != null) P.latestRank = r.playerRank; }
    const surf = SURFACES.includes(r.surface) ? r.surface : 'Hard';
    for (const key of ['ALL', surf]) {
      if (!P.byKey.has(key)) P.byKey.set(key, newAcc());
      add(P.byKey.get(key), r);
    }
    const bucket = rankBucket(r.playerRank);
    for (const key of [`${bucket}|ALL`, `${bucket}|${surf}`]) {
      if (!cohortAcc.has(key)) cohortAcc.set(key, newAcc());
      add(cohortAcc.get(key), r);
    }
  }

  const cohorts = {};
  for (const [k, a] of cohortAcc) cohorts[k] = rawRates(a);

  const out = { meta: { built: new Date().toISOString(), players: players.size,
    kToAll: K_TO_ALL, kToCohort: K_TO_COHORT, note: opts.note || 'v1 — thresholds unvalidated' },
    cohorts, players: {} };

  for (const [id, P] of players) {
    const allRaw = P.byKey.has('ALL') ? rawRates(P.byKey.get('ALL')) : null;
    const bucket = rankBucket(P.latestRank);
    const surfaces = {};
    if (allRaw) surfaces.ALL = shrinkProfile(allRaw, allRaw, cohorts[`${bucket}|ALL`]);
    for (const s of SURFACES) {
      if (!P.byKey.has(s)) continue;
      surfaces[s] = shrinkProfile(rawRates(P.byKey.get(s)), allRaw, cohorts[`${bucket}|${s}`]);
    }
    out.players[id] = { name: P.name, rank: P.latestRank, lastDate: P.latestDate, bucket, surfaces };
  }
  return out;
}

// CLI: node tennisFeatureBuilder.js [dataDir] [outFile]
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || './data/tennis';
  const outFile = process.argv[3] || './tennis/tennis_serve_index.json';
  const files = readdirSync(dir).filter((f) => /_matches_.*\.csv$/i.test(f));
  if (!files.length) { console.error(`No *_matches_*.csv in ${dir}`); process.exit(1); }
  let rows = [];
  for (const f of files) {
    const txt = readFileSync(join(dir, f), 'utf8');
    const r = buildRowsFromCsv(txt);
    rows = rows.concat(r);
    console.error(`  ${f}: ${r.length / 2 | 0} matches → ${r.length} player-rows`);
  }
  const index = buildIndex(rows, { note: `built from ${files.length} files` });
  writeFileSync(outFile, JSON.stringify(index));
  console.error(`✓ ${index.meta.players} players → ${outFile}`);
}

export default { buildIndex };
