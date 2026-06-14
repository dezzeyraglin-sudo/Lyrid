// backtestKPR.mjs
// Map 1&2 kills backtest, rebuilt around the right decomposition:
//
//     map kills  =  KPR (kills per round)  ×  rounds played
//
// KPR is the stable, skill/role component; rounds is the volatile, matchup-driven
// component (a 13-3 blowout is 16 rounds, a 13-11 grind is 24, overtime is 30+).
// Projecting them separately is the whole point — a raw kills mean blends a steady
// rate with a noisy volume and gets the worst of both.
//
// It runs a 3-model MAE ladder so you can see where accuracy actually comes from:
//   M0 raw      — trailing mean of prior Map1&2 totals (the old approach)
//   M1 kpr×Rbar — KPR × a constant league-average round count (isolates the value
//                 of the rate decomposition alone)
//   M2 kpr×E[R] — KPR × rounds predicted from the matchup (isolates the added
//                 value of predicting volume). Fully walk-forward: the rounds~gap
//                 fit uses only maps that finished before the match being graded.
//
// Then an OT / round-count diagnostic block that quantifies your overtime point:
// how much of kill variance is just rounds, and how hard OT inflates a map.
//
// Uses ONLY data already in your cache (round counts come from match_maps scores +
// overtime_rounds). No new API requests. Team strength is built endogenously from
// prior round margins — no /rankings call and no look-ahead from a current snapshot.
//
// Usage: node backtestKPR.mjs --cache .cache/cs2 [--minPrior 6]

import fs from "node:fs";
import path from "node:path";
import { wilson, mean, std, cv, pearson, mae, bias, round1, round2, pct } from "./stats.mjs";

const args = parseArgs(process.argv.slice(2));
const CACHE = args.cache ?? ".cache/cs2";
const MIN_PRIOR = Number(args.minPrior ?? 6); // min prior maps before a player is graded

// ---- load cache ----
const matches = readJson(path.join(CACHE, "matches.json"));
const maps = readJson(path.join(CACHE, "match_maps.json"));
const matchById = new Map(matches.map((m) => [m.id, m]));

const statsDir = path.join(CACHE, "map_stats");
const mapStats = new Map(); // match_map_id -> rows
if (fs.existsSync(statsDir)) {
  for (const f of fs.readdirSync(statsDir)) {
    if (f.endsWith(".json")) {
      const o = readJson(path.join(statsDir, f));
      mapStats.set(o.match_map_id, o.rows);
    }
  }
}

// rounds played + OT come straight from the match_maps scores
function roundsOf(mm) {
  const r = (mm.team1_score ?? 0) + (mm.team2_score ?? 0);
  return r > 0 ? r : null;
}
const otOf = (mm) => mm.overtime_rounds ?? 0;

// ---- assemble per-match map1/map2 with rounds + per-player kills ----
const mapsByMatch = new Map();
for (const mm of maps) {
  if (!mapsByMatch.has(mm.match_id)) mapsByMatch.set(mm.match_id, {});
  mapsByMatch.get(mm.match_id)[mm.map_number] = mm;
}

// match-level series records (keeps player rows inside, so we can do team strength
// once per match and player projections per player)
const series = [];
for (const [matchId, byNum] of mapsByMatch) {
  const mm1 = byNum[1], mm2 = byNum[2];
  if (!mm1 || !mm2) continue;
  const r1 = roundsOf(mm1), r2 = roundsOf(mm2);
  if (r1 == null || r2 == null) continue;
  const s1 = mapStats.get(mm1.id), s2 = mapStats.get(mm2.id);
  if (!s1 || !s2) continue;
  const match = matchById.get(matchId);
  if (!match?.start_time) continue;

  const k1 = killsByPlayer(s1), k2 = killsByPlayer(s2);
  const players = [];
  for (const [pid, a] of k1) {
    const b = k2.get(pid);
    if (!b) continue; // must play both maps
    players.push({
      playerId: pid,
      nickname: a.nickname || b.nickname || String(pid),
      m1: { name: mm1.map_name, kills: a.kills, rounds: r1, ot: otOf(mm1) },
      m2: { name: mm2.map_name, kills: b.kills, rounds: r2, ot: otOf(mm2) },
      total: a.kills + b.kills,
    });
  }
  if (!players.length) continue;
  series.push({
    ts: Date.parse(match.start_time),
    matchId,
    team1: match.team1?.id ?? null,
    team2: match.team2?.id ?? null,
    m1: { rounds: r1, ot: otOf(mm1), t1s: mm1.team1_score ?? 0, t2s: mm1.team2_score ?? 0 },
    m2: { rounds: r2, ot: otOf(mm2), t1s: mm2.team1_score ?? 0, t2s: mm2.team2_score ?? 0 },
    players,
  });
}
series.sort((a, b) => a.ts - b.ts);

const allPlayerMaps = series.flatMap((s) => s.players.flatMap((p) => [p.m1, p.m2]));

console.log("=".repeat(66));
console.log("CS2 Map 1&2 kills — KPR × rounds backtest");
console.log("=".repeat(66));
console.log(`matches: ${matches.length}   series: ${series.length}   player-map rows: ${allPlayerMaps.length}`);

// ---------------------------------------------------------------------------
// OT / ROUND-COUNT DIAGNOSTIC  (full sample — descriptive)
// ---------------------------------------------------------------------------
const roundsArr = allPlayerMaps.map((m) => m.rounds);
const killsArr = allPlayerMaps.map((m) => m.kills);
const kprArr = allPlayerMaps.map((m) => m.kills / m.rounds);
const otRows = allPlayerMaps.filter((m) => m.ot > 0);
const nonOtRows = allPlayerMaps.filter((m) => m.ot === 0);

const rndKillFit = linreg(roundsArr, killsArr); // kills ~ rounds
const otShare = otRows.length / allPlayerMaps.length;

console.log("\n[OT / ROUNDS] — is volume the driver?");
console.log(`  rounds/map ............. mean ${round1(mean(roundsArr))}  sd ${round1(std(roundsArr))}  range ${Math.min(...roundsArr)}-${Math.max(...roundsArr)}`);
console.log(`  maps to overtime ....... ${pct(otShare)}  (${otRows.length}/${allPlayerMaps.length} player-map rows)`);
console.log(`  kills ~ rounds ......... r=${round2(pearson(roundsArr, killsArr))}  R²=${round2(rndKillFit.r2)}  ← share of kill variance explained by round count alone`);
console.log(`  slope .................. ${round2(rndKillFit.slope)} kills per extra round`);
if (otRows.length && nonOtRows.length) {
  const otK = mean(otRows.map((m) => m.kills));
  const regK = mean(nonOtRows.map((m) => m.kills));
  console.log(`  mean kills, OT map ..... ${round1(otK)}   vs non-OT ${round1(regK)}   = +${pct((otK - regK) / regK)} on an OT map`);
}
// KPR stability: coefficient of variation of KPR vs of raw kills (lower = steadier)
console.log(`  CV of KPR .............. ${round2(cv(kprArr))}   vs CV of raw kills ${round2(cv(killsArr))}   ← KPR is the stable half`);

// combined-market OT exposure
const seriesTotals = series.flatMap((s) => s.players.map((p) => ({ total: p.total, anyOt: p.m1.ot > 0 || p.m2.ot > 0 })));
const otTouched = seriesTotals.filter((x) => x.anyOt);
if (otTouched.length && otTouched.length < seriesTotals.length) {
  const a = mean(otTouched.map((x) => x.total));
  const b = mean(seriesTotals.filter((x) => !x.anyOt).map((x) => x.total));
  console.log(`  Map1&2 total, OT-touched ${round1(a)}  vs clean ${round1(b)}   (${pct(otTouched.length / seriesTotals.length)} of series touch OT)`);
}

// ---------------------------------------------------------------------------
// WALK-FORWARD MAE LADDER
// ---------------------------------------------------------------------------
const phist = new Map();   // playerId -> { kills:[], kpr:[], maps:int }
const tstrength = new Map(); // teamId -> { margins:[] }
const gapRoundPairs = [];   // [gap, rounds] from PRIOR maps (walk-forward training for E[rounds])
let roundsSum = 0, roundsN = 0; // global running mean rounds (Rbar)

const M0 = [], M1 = [], M2 = []; // [proj, actual] pairs
let winM1overM0 = 0, winM2overM1 = 0, graded = 0;

for (const s of series) {
  const Rbar = roundsN ? roundsSum / roundsN : 22; // league-avg rounds prior; 22 seed
  const gap = strengthGap(s.team1, s.team2);
  const Erounds = predictRounds(gap, Rbar);

  for (const p of s.players) {
    const h = phist.get(p.playerId);
    if (!h || h.maps < MIN_PRIOR) continue;
    const kpr = mean(h.kpr);                 // walk-forward trailing KPR
    const rawTotal = mean(h.totals);         // walk-forward trailing combined total

    const projM0 = rawTotal;                 // raw mean
    const projM1 = 2 * kpr * Rbar;           // KPR × constant rounds
    const projM2 = 2 * kpr * Erounds;        // KPR × matchup-predicted rounds

    M0.push([projM0, p.total]);
    M1.push([projM1, p.total]);
    M2.push([projM2, p.total]);
    if (Math.abs(projM1 - p.total) < Math.abs(projM0 - p.total)) winM1overM0++;
    if (Math.abs(projM2 - p.total) < Math.abs(projM1 - p.total)) winM2overM1++;
    graded++;
  }

  // ---- update histories AFTER grading (walk-forward) ----
  for (const p of s.players) {
    let h = phist.get(p.playerId);
    if (!h) { h = { kills: [], kpr: [], totals: [], maps: 0 }; phist.set(p.playerId, h); }
    h.kpr.push(p.m1.kills / p.m1.rounds, p.m2.kills / p.m2.rounds);
    h.totals.push(p.total);
    h.maps += 2;
  }
  // team strength: round margin per map. team1_score/team2_score are the match's
  // team1/team2. team1's margin = its rounds won - lost; team2's is the negation.
  const marg1 = (s.m1.t1s - s.m1.t2s) + (s.m2.t1s - s.m2.t2s); // team1 across both maps
  pushMargins(s.team1, [s.m1.t1s - s.m1.t2s, s.m2.t1s - s.m2.t2s]);
  pushMargins(s.team2, [s.m1.t2s - s.m1.t1s, s.m2.t2s - s.m2.t1s]);
  void marg1;
  // training pairs for E[rounds]: gap known at this match vs realized rounds
  gapRoundPairs.push([gap, s.m1.rounds], [gap, s.m2.rounds]);
  roundsSum += s.m1.rounds + s.m2.rounds; roundsN += 2;
}

console.log("\n[MAE LADDER] — walk-forward, lower is better");
console.log(`  graded projections ..... ${graded}  (players with >=${MIN_PRIOR} prior maps)`);
report("M0 raw mean", M0);
report("M1 kpr × const rounds", M1);
report("M2 kpr × E[rounds]", M2);
if (M0.length) {
  const i10 = (mae(M0) - mae(M1)) / mae(M0);
  const i21 = (mae(M1) - mae(M2)) / mae(M1);
  console.log(`  decomposition gain (M1 vs M0) .. ${signed(i10)}  ${i10 > 0 ? "✓ rate split helps" : "✗ no gain from rate split"}`);
  console.log(`  volume gain     (M2 vs M1) .. ${signed(i21)}  ${i21 > 0 ? "✓ predicting rounds helps" : "✗ matchup rounds add nothing"}`);
  const w1 = wilson(winM1overM0, graded), w2 = wilson(winM2overM1, graded);
  console.log(`  M1 closer than M0 .......... ${pct(w1.p)} [${pct(w1.lo)}, ${pct(w1.hi)}]`);
  console.log(`  M2 closer than M1 .......... ${pct(w2.p)} [${pct(w2.lo)}, ${pct(w2.hi)}]`);
}

// how predictable were rounds from the matchup gap, in-sample?
const gfit = linreg(gapRoundPairs.map((x) => x[0]), gapRoundPairs.map((x) => x[1]));
console.log("\n[E[rounds] MODEL] — how learnable is volume from matchup strength?");
console.log(`  rounds ~ |strength gap| .. R²=${round2(gfit.r2)}  slope ${round2(gfit.slope)}`);
console.log(`  ${gfit.r2 < 0.05
  ? "weak — endogenous strength barely predicts rounds; try /rankings + team_map_pool, or accept rounds as irreducible variance"
  : "there's signal — a proper rounds model (rankings, map win-rates, veto) is worth building"}`);

console.log("\nREAD");
console.log("  • If M1 beats M0, the KPR decomposition is real and you should project");
console.log("    rate × rounds, not raw kills — this also tends to fix the high bias.");
console.log("  • The OT block is your overtime thesis quantified: a high kills~rounds R²");
console.log("    means the market is mostly a round-count bet, and OT is the fat right tail.");
console.log("=".repeat(66));

// ---- model helpers ----
function strength(teamId) {
  const t = tstrength.get(teamId);
  return t && t.margins.length ? mean(t.margins) : 0;
}
function strengthGap(a, b) {
  return Math.abs(strength(a) - strength(b));
}
function pushMargins(teamId, margins) {
  if (teamId == null) return;
  let t = tstrength.get(teamId);
  if (!t) { t = { margins: [] }; tstrength.set(teamId, t); }
  for (const m of margins) t.margins.push(m);
}
function predictRounds(gap, Rbar) {
  if (gapRoundPairs.length < 20) return Rbar;
  const f = linreg(gapRoundPairs.map((x) => x[0]), gapRoundPairs.map((x) => x[1]));
  if (!isFinite(f.slope)) return Rbar;
  const pred = f.intercept + f.slope * gap;
  return Math.min(30, Math.max(13, pred)); // clamp to plausible map length
}

function report(label, pairs) {
  console.log(`  ${label.padEnd(24)} MAE ${round2(mae(pairs))}  bias ${signed2(bias(pairs))}`);
}
function signed(x) { return (x >= 0 ? "+" : "") + pct(x); }
function signed2(x) { return (x >= 0 ? "+" : "") + round2(x); }

function killsByPlayer(rows) {
  const m = new Map();
  for (const r of rows) {
    const pid = r.player?.id ?? r.player_id;
    if (pid == null) continue;
    m.set(pid, { kills: r.kills ?? 0, nickname: r.player?.nickname });
  }
  return m;
}
function linreg(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: my - slope * mx, r2 };
}
function readJson(p) {
  if (!fs.existsSync(p)) { console.error(`Missing cache file: ${p}. Run pullSeason.mjs first.`); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}
