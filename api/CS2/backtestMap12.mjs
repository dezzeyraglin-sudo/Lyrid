// scripts/cs2/backtestMap12.mjs
// Walk-forward backtest for the Map 1&2 combined-kills market.
//
// This first pass answers three questions, in order of importance:
//   1) SIGNAL:      does a map-conditioned projection predict actual Map 1&2
//                   kills better (lower MAE) than a naive season-average baseline?
//                   If not, there's no point building the live engine.
//   2) COMPRESSION: is the Map 1&2 total distribution tighter (lower CV) than two
//                   single maps would be, and how correlated are map1<->map2 kills?
//                   This is the variance-edge thesis, measured on YOUR data.
//   3) LINE CHECK:  a hit-rate vs a PLACEHOLDER line (trailing mean). This is a
//                   plumbing/calibration check ONLY — it is NOT edge. Real edge
//                   requires Underdog's actual posted lines (see lineFor() TODO).
//
// Everything chronological is strictly walk-forward: a projection for a match on
// date D is built only from maps that finished before D. No look-ahead.
//
// Usage: node scripts/cs2/backtestMap12.mjs --cache .cache/cs2 [--minPrior 6] [--mapMin 3]

import fs from "node:fs";
import path from "node:path";
import {
  wilson, mean, std, cv, pearson, mae, bias, round1, round2, pct,
} from "./stats.mjs";

const args = parseArgs(process.argv.slice(2));
const CACHE = args.cache ?? ".cache/cs2";
const MIN_PRIOR = Number(args.minPrior ?? 6);   // min prior maps before we project a player
const MAP_MIN = Number(args.mapMin ?? 3);       // min same-map samples to use map conditioning

// ---- load cache ----
const matches = readJson(path.join(CACHE, "matches.json"));
const maps = readJson(path.join(CACHE, "match_maps.json"));
const matchById = new Map(matches.map((m) => [m.id, m]));

// map_stats: one file per match_map_id -> { match_map_id, match_id, rows:[playerStat] }
const statsDir = path.join(CACHE, "map_stats");
const mapStats = new Map(); // match_map_id -> rows
if (fs.existsSync(statsDir)) {
  for (const f of fs.readdirSync(statsDir)) {
    if (!f.endsWith(".json")) continue;
    const obj = readJson(path.join(statsDir, f));
    mapStats.set(obj.match_map_id, obj.rows);
  }
}

// ---- assemble per-(match, player) series records ----
// For each match: find its map_number 1 and 2, and the set of players who played
// BOTH (Underdog's "must play all maps stated" rule). Record kills per map.
const mapsByMatch = new Map();
for (const mm of maps) {
  if (!mapsByMatch.has(mm.match_id)) mapsByMatch.set(mm.match_id, {});
  mapsByMatch.get(mm.match_id)[mm.map_number] = mm;
}

const records = [];
for (const [matchId, byNum] of mapsByMatch) {
  const m1 = byNum[1];
  const m2 = byNum[2];
  if (!m1 || !m2) continue;
  const r1 = mapStats.get(m1.id);
  const r2 = mapStats.get(m2.id);
  if (!r1 || !r2) continue;

  const k1 = playerKills(r1); // player_id -> { kills, nickname }
  const k2 = playerKills(r2);
  const match = matchById.get(matchId);
  const date = match?.start_time ?? null;
  if (!date) continue;

  for (const [pid, a] of k1) {
    const b = k2.get(pid);
    if (!b) continue; // didn't play both maps -> not an active Map1&2 projection
    records.push({
      date,
      ts: Date.parse(date),
      matchId,
      playerId: pid,
      nickname: a.nickname || b.nickname || String(pid),
      m1: { name: m1.map_name, kills: a.kills },
      m2: { name: m2.map_name, kills: b.kills },
      total: a.kills + b.kills,
    });
  }
}
records.sort((x, y) => x.ts - y.ts);

console.log("=".repeat(64));
console.log("CS2 Map 1&2 kills — walk-forward backtest");
console.log("=".repeat(64));
console.log(`matches: ${matches.length}   maps(1&2): ${maps.length}   series-player records: ${records.length}`);
if (records.length < 50) {
  console.log("\n⚠  Thin sample. Treat everything below as directional only.");
}

// ---------------------------------------------------------------------------
// (2) Variance compression + map1<->map2 correlation (computed on full sample;
//     this is a descriptive property of the market, not a predictive claim).
// ---------------------------------------------------------------------------
const singleMapKills = [];
const combinedTotals = [];
const m1series = [];
const m2series = [];
for (const r of records) {
  singleMapKills.push(r.m1.kills, r.m2.kills);
  combinedTotals.push(r.total);
  m1series.push(r.m1.kills);
  m2series.push(r.m2.kills);
}
const cvSingle = cv(singleMapKills);
const cvCombined = cv(combinedTotals);
const rho = pearson(m1series, m2series);
// If maps were independent, CV(total) would be CV(single)/sqrt(2). Positive
// correlation erodes that. Show the theoretical floor vs what we actually see.
const cvIndepFloor = cvSingle / Math.sqrt(2);

console.log("\n[2] VARIANCE COMPRESSION (the thesis)");
console.log(`  CV single map .......... ${round2(cvSingle)}`);
console.log(`  CV combined (M1+M2) .... ${round2(cvCombined)}   (vs ${round2(cvSingle)} single)`);
console.log(`  CV indep. floor ........ ${round2(cvIndepFloor)}   (what you'd get if maps were uncorrelated)`);
console.log(`  map1<->map2 corr (rho).. ${round2(rho)}   ${rho > 0.25 ? "↑ correlation eats some compression" : "low — compression mostly intact"}`);
const compression = 1 - cvCombined / cvSingle;
console.log(`  realized compression ... ${pct(compression)} tighter than a single map`);

// ---------------------------------------------------------------------------
// (1) Walk-forward SIGNAL test: map-conditioned projection vs naive baseline.
// (3) plus a placeholder-line hit rate (NOT edge).
// ---------------------------------------------------------------------------
const hist = new Map(); // playerId -> { maps:[{name,kills}], totals:[Number] }

const condPairs = []; // [proj, actual] map-conditioned
const basePairs = []; // [proj, actual] baseline (2x overall per-map mean)
let lineWins = 0, lineN = 0;          // proxy-line hit rate (calibration only)
let condBeatsBaseGraded = 0;

for (const r of records) {
  const h = hist.get(r.playerId);
  const priorMaps = h?.maps ?? [];
  const priorTotals = h?.totals ?? [];

  if (priorMaps.length >= MIN_PRIOR) {
    const overallPerMap = mean(priorMaps.map((x) => x.kills));

    // map-conditioned expectation per map, with fallback to overall mean
    const e1 = condExpect(priorMaps, r.m1.name, overallPerMap);
    const e2 = condExpect(priorMaps, r.m2.name, overallPerMap);
    const projCond = e1 + e2;
    const projBase = 2 * overallPerMap;

    condPairs.push([projCond, r.total]);
    basePairs.push([projBase, r.total]);
    if (Math.abs(projCond - r.total) < Math.abs(projBase - r.total)) condBeatsBaseGraded++;

    // (3) placeholder line — trailing mean of prior totals. NOT a real line.
    const line = lineFor(r, priorTotals);
    if (line != null && r.total !== line) {
      const pickOver = projCond > line;
      const wentOver = r.total > line;
      if (pickOver === wentOver) lineWins++;
      lineN++;
    }
  }

  // update history AFTER grading (walk-forward)
  if (!h) hist.set(r.playerId, { maps: [], totals: [] });
  const hh = hist.get(r.playerId);
  hh.maps.push({ name: r.m1.name, kills: r.m1.kills }, { name: r.m2.name, kills: r.m2.kills });
  hh.totals.push(r.total);
}

const maeCond = mae(condPairs);
const maeBase = mae(basePairs);
const graded = condPairs.length;

console.log("\n[1] SIGNAL — map-conditioned vs naive baseline (walk-forward)");
console.log(`  graded projections ..... ${graded}  (players with >=${MIN_PRIOR} prior maps)`);
console.log(`  MAE baseline (2x avg) .. ${round2(maeBase)} kills`);
console.log(`  MAE map-conditioned .... ${round2(maeCond)} kills`);
const improve = (maeBase - maeCond) / maeBase;
console.log(`  improvement ............ ${pct(improve)} ${improve > 0 ? "✓ conditioning helps" : "✗ no gain from conditioning"}`);
console.log(`  bias (cond, proj-act) .. ${round2(bias(condPairs))}  ${Math.abs(bias(condPairs)) < 0.5 ? "(well-centered)" : "(skewed — recalibrate)"}`);
const cbb = wilson(condBeatsBaseGraded, graded);
console.log(`  cond beats base ........ ${condBeatsBaseGraded}/${graded} = ${pct(cbb.p)}  [${pct(cbb.lo)}, ${pct(cbb.hi)}]`);

console.log("\n[3] PLACEHOLDER-LINE HIT RATE  (calibration check — NOT edge)");
if (lineN > 0) {
  const w = wilson(lineWins, lineN);
  console.log(`  ${lineWins}/${lineN} = ${pct(w.p)}   95% CI [${pct(w.lo)}, ${pct(w.hi)}]`);
  console.log(`  ⚠  Line = trailing mean, not Underdog's number. This only tells you`);
  console.log(`     the projection picks a consistent side, not that it's profitable.`);
  console.log(`     Wire real Underdog lines in lineFor() to measure true edge vs break-even.`);
} else {
  console.log("  not enough graded picks");
}

console.log("\nNEXT");
console.log("  • If [1] shows conditioning helps and [2] shows real compression, build the");
console.log("    live projection endpoint + an Underdog line scraper, then re-run [3] for edge.");
console.log("  • Break-even reference (Underdog standard): ~57.7% (2-pick), ~55% (3/5-pick).");
console.log("=".repeat(64));

// ---- helpers ----

function condExpect(priorMaps, mapName, fallback) {
  const same = priorMaps.filter((x) => x.name === mapName).map((x) => x.kills);
  if (same.length >= MAP_MIN) return mean(same);
  return fallback;
}

/**
 * PLACEHOLDER line. Returns a number to bet over/under, or null to skip.
 * Currently the player's trailing mean of Map1&2 totals — a stand-in only.
 *
 * TODO(real edge): replace with the actual Underdog posted Map1&2 line for this
 * player+match, e.g. lookupUnderdogLine(r.playerId, r.matchId). Until then, the
 * hit rate in section [3] is a calibration check, not a profitability claim.
 */
function lineFor(r, priorTotals) {
  if (priorTotals.length < 3) return null;
  // round to nearest 0.5 to mimic how a book would post it
  return Math.round(mean(priorTotals) * 2) / 2;
}

function playerKills(rows) {
  const m = new Map();
  for (const row of rows) {
    const pid = row.player?.id ?? row.player_id;
    if (pid == null) continue;
    m.set(pid, { kills: row.kills ?? 0, nickname: row.player?.nickname });
  }
  return m;
}

function readJson(p) {
  if (!fs.existsSync(p)) {
    console.error(`Missing cache file: ${p}. Run pullSeason.mjs first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}
