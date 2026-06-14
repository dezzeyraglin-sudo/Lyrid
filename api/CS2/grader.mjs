// grader.mjs
// The edge test. Joins your logged Underdog lines (underdog_lines.jsonl) to actual
// BDL results, projects each player walk-forward, and reports realized ROI against
// the REAL posted price — the first honest answer to "do we beat Underdog."
//
// Join key is the normalized nickname (xantares -> xantares), not team names: far
// more robust across the two id systems. For each logged line we find that player's
// BDL match nearest the log timestamp and grade the actual Maps 1+2 result.
//
// Two stats supported:
//   kills_on_maps_1_2      actual = map1 kills + map2 kills           (native)
//   headshots_on_maps_1_2  actual = round(k1*hs1%) + round(k2*hs2%)   (RECONSTRUCTED —
//                          BDL has no raw HS count, so this is an estimate; treat
//                          headshot grades as lower-confidence until spot-checked.)
//
// EV uses model P(over) from a walk-forward normal approx (player's prior Maps 1+2
// mean & sd) vs the price's implied probability. Bet only where edge >= threshold.
//
// Usage:
//   node grader.mjs --lines underdog_lines.jsonl --cache .cache/cs2 [--edge 0.04] [--minPrior 5]
//
// REALITY: this is empty until the logger has run for a few slates AND those matches
// have been re-pulled into the cache (results lag the lines). Early n will be tiny;
// it only means something after a couple weeks of slates.

import fs from "node:fs";
import path from "node:path";
import { wilson, mean, std, pct, round2 } from "./stats.mjs";

const args = parseArgs(process.argv.slice(2));
const LINES = args.lines ?? "./underdog_lines.jsonl";
const CACHE = args.cache ?? ".cache/cs2";
const EDGE = Number(args.edge ?? 0.04);     // min model-vs-implied edge to place a bet
const MIN_PRIOR = Number(args.minPrior ?? 5);
const MAX_DAY_GAP = 3;                        // days between log ts and the BDL match

// ---- load logged lines, keep the latest snapshot per line (the closing line) ----
if (!fs.existsSync(LINES)) { console.error(`No ${LINES} yet — run the logger over a few slates first.`); process.exit(1); }
const raw = fs.readFileSync(LINES, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const closing = new Map(); // key -> latest line
for (const r of raw) {
  const key = r.line_id || `${r.norm}|${r.stat}|${r.match_id}`;
  const prev = closing.get(key);
  if (!prev || Date.parse(r.ts) > Date.parse(prev.ts)) closing.set(key, r);
}
const lines = [...closing.values()];

// ---- build BDL results + history from cache ----
const matches = readJson(path.join(CACHE, "matches.json"));
const maps = readJson(path.join(CACHE, "match_maps.json"));
const matchById = new Map(matches.map((m) => [m.id, m]));
const statsDir = path.join(CACHE, "map_stats");
const mapStats = new Map();
if (fs.existsSync(statsDir)) for (const f of fs.readdirSync(statsDir)) if (f.endsWith(".json")) {
  const o = readJson(path.join(statsDir, f)); mapStats.set(o.match_map_id, o.rows);
}
const mapsByMatch = new Map();
for (const mm of maps) { if (!mapsByMatch.has(mm.match_id)) mapsByMatch.set(mm.match_id, {}); mapsByMatch.get(mm.match_id)[mm.map_number] = mm; }

// per player: chronological list of match results (maps 1+2) + the norm nick map
const byPlayer = new Map(); // pid -> [{ts, matchId, kills12, hs12}]
const normToPid = new Map(); // normNick -> pid (most recent wins)
for (const [matchId, byNum] of mapsByMatch) {
  const m = matchById.get(matchId); if (!m?.start_time) continue;
  const mm1 = byNum[1], mm2 = byNum[2]; if (!mm1 || !mm2) continue;
  const r1 = mapStats.get(mm1.id), r2 = mapStats.get(mm2.id); if (!r1 || !r2) continue;
  const idx1 = indexRows(r1), idx2 = indexRows(r2);
  for (const [pid, a] of idx1) {
    const b = idx2.get(pid); if (!b) continue;
    const kills12 = a.kills + b.kills;
    const hs12 = Math.round(a.kills * (a.hs ?? 0) / 100) + Math.round(b.kills * (b.hs ?? 0) / 100);
    if (!byPlayer.has(pid)) byPlayer.set(pid, []);
    byPlayer.get(pid).push({ ts: Date.parse(m.start_time), matchId, kills12, hs12 });
    const nick = a.nick || b.nick; if (nick) normToPid.set(normNick(nick), pid);
  }
}
for (const arr of byPlayer.values()) arr.sort((x, y) => x.ts - y.ts);

// ---- grade ----
const bets = [];      // {stat, side, won, roi, edge}
const resolved = [];  // {stat, modelSideWon}  (directional signal, ignores threshold)
let nJoined = 0, nNoPlayer = 0, nNoMatch = 0, nNoPrior = 0;

for (const ln of lines) {
  const stat = ln.stat;
  if (stat !== "kills_on_maps_1_2" && stat !== "headshots_on_maps_1_2") continue;
  const pid = normToPid.get(ln.norm);
  if (pid == null) { nNoPlayer++; continue; }
  const hist = byPlayer.get(pid) ?? [];
  const lnTs = Date.parse(ln.ts);
  // the graded match: player's result nearest the log ts within the window
  const cand = hist
    .map((h) => ({ h, dd: Math.abs(h.ts - lnTs) }))
    .filter((x) => x.dd <= MAX_DAY_GAP * 86400000)
    .sort((a, b) => a.dd - b.dd)[0];
  if (!cand) { nNoMatch++; continue; }
  const matchTs = cand.h.ts;
  const actual = stat === "kills_on_maps_1_2" ? cand.h.kills12 : cand.h.hs12;
  nJoined++;

  // walk-forward projection from prior matches only
  const prior = hist.filter((h) => h.ts < matchTs).map((h) => stat === "kills_on_maps_1_2" ? h.kills12 : h.hs12);
  if (prior.length < MIN_PRIOR) { nNoPrior++; continue; }
  const mu = mean(prior), sd = std(prior);
  if (!(sd > 0)) { nNoPrior++; continue; }

  const line = ln.value;
  const pOverModel = 1 - ncdf((line - mu) / sd);
  const pOverImpl = impliedProb(ln.higher_price);
  const pUnderImpl = impliedProb(ln.lower_price);

  // directional signal (no threshold): which side does the model favor, did it win?
  const modelOver = pOverModel >= 0.5;
  const modelSideWon = modelOver ? actual > line : actual < line;
  resolved.push({ stat, modelSideWon });

  // EV-based bet: take the side with positive edge vs its implied price
  const overEdge = (pOverImpl != null) ? pOverModel - pOverImpl : -1;
  const underEdge = (pUnderImpl != null) ? (1 - pOverModel) - pUnderImpl : -1;
  let side = null, price = null, edge = 0;
  if (overEdge >= underEdge && overEdge >= EDGE) { side = "over"; price = ln.higher_price; edge = overEdge; }
  else if (underEdge >= EDGE) { side = "under"; price = ln.lower_price; edge = underEdge; }
  if (!side) continue;
  if (actual === line) continue; // push

  const won = side === "over" ? actual > line : actual < line;
  const roi = won ? roiIfWin(price) : -1;
  bets.push({ stat, side, won, roi, edge });
}

// ---- report ----
console.log("=".repeat(64));
console.log("CS2 grader — projections vs real Underdog lines");
console.log("=".repeat(64));
console.log(`logged lines (closing): ${lines.length}`);
console.log(`joined to a result ....: ${nJoined}   (no player match ${nNoPlayer}, no BDL match ${nNoMatch}, thin prior ${nNoPrior})`);

if (resolved.length) {
  const w = wilson(resolved.filter((r) => r.modelSideWon).length, resolved.length);
  console.log(`\n[DIRECTIONAL] model's favored side won (no edge filter)`);
  console.log(`  ${resolved.filter((r) => r.modelSideWon).length}/${resolved.length} = ${pct(w.p)}  [${pct(w.lo)}, ${pct(w.hi)}]   (>50% = projection has signal vs the line)`);
}

console.log(`\n[EV BETS]  edge >= ${pct(EDGE)} vs posted price`);
report("all", bets);
report("kills_on_maps_1_2", bets.filter((b) => b.stat === "kills_on_maps_1_2"));
report("headshots_on_maps_1_2", bets.filter((b) => b.stat === "headshots_on_maps_1_2"));

console.log("\nNOTES");
console.log("  • ROI is per 1u stake at the actual American price. Positive ROI with a");
console.log("    defensible n is the only real 'edge' signal — hit rate alone isn't, since");
console.log("    prices vary.");
console.log("  • headshot grades are reconstructed (kills × HS%); spot-check vs HLTV before trusting.");
console.log("  • tiny n early is expected — let the logger bank more slates.");
console.log("=".repeat(64));

function report(label, arr) {
  if (!arr.length) { console.log(`  ${label.padEnd(22)} no bets`); return; }
  const wins = arr.filter((b) => b.won).length;
  const w = wilson(wins, arr.length);
  const roi = mean(arr.map((b) => b.roi));
  console.log(`  ${label.padEnd(22)} ${wins}/${arr.length} = ${pct(w.p)} [${pct(w.lo)},${pct(w.hi)}]   ROI ${(roi >= 0 ? "+" : "")}${(roi * 100).toFixed(1)}%/bet`);
}

// ---- helpers ----
function indexRows(rows) {
  const m = new Map();
  for (const r of rows) {
    const pid = r.player?.id ?? r.player_id; if (pid == null) continue;
    m.set(pid, { kills: r.kills ?? 0, hs: r.headshot_percentage, nick: r.player?.nickname });
  }
  return m;
}
function normNick(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function impliedProb(american) {
  const a = Number(american); if (!Number.isFinite(a)) return null;
  return a < 0 ? -a / (-a + 100) : 100 / (a + 100);
}
function roiIfWin(american) {
  const a = Number(american); if (!Number.isFinite(a)) return 0;
  return a > 0 ? a / 100 : 100 / -a;
}
function ncdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function readJson(p) { if (!fs.existsSync(p)) { console.error(`Missing ${p}`); process.exit(1); } return JSON.parse(fs.readFileSync(p, "utf8")); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
  return out;
}
