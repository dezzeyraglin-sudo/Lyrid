// matchRead.mjs
// CS2 match-read engine — operationalizes the data-backed parts of the 20-point
// checklist. It is deliberately HONEST about coverage: every field is tagged
// powered / inferred / unpowered, and the pick score EXCLUDES inputs the data
// can't see (opponent style, line value) instead of inventing them. A score built
// on fake inputs is exactly the "fake edge" the checklist warns against.
//
// Run on a historical match in your cache to see the full read (rosters + actual
// maps are known). For a past match it builds each player's profile from maps that
// finished BEFORE that match — a realistic pre-match read, no leakage. The live
// endpoint will use all history-to-date plus veto prediction + the logged line.
//
// Usage:
//   node matchRead.mjs --cache .cache/cs2 --match <match_id>
//   node matchRead.mjs --cache .cache/cs2 --list        (show recent match ids)
//
// CALIBRATE: the role thresholds below are reasonable defaults, not gospel. Upload
// your cache and we'll tune them to your actual player population.

import fs from "node:fs";
import path from "node:path";
import { mean, std, pct, round1, round2 } from "./stats.mjs";

const CFG = {
  AWP_HS_MAX: 42,      // HS% at/below this + real frag volume => AWP-leaning
  ENTRY_FK_PER_MAP: 4, // first kills/map at/above => entry profile
  STAR_KPR: 0.78,      // KPR at/above => star carry
  SUPPORT_KPR: 0.62,   // KPR below this + high KAST => support/IGL
  SUPPORT_KAST: 70,
  RECENT_N: 8,         // maps counted as "recent form"
  MIN_MAPS: 6,         // below this we won't profile a player
  LEAGUE_ROUNDS: 22,   // fallback expected rounds
};

const args = parseArgs(process.argv.slice(2));
const CACHE = args.cache ?? ".cache/cs2";

const matches = readJson(path.join(CACHE, "matches.json"));
const maps = readJson(path.join(CACHE, "match_maps.json"));
const matchById = new Map(matches.map((m) => [m.id, m]));
const statsDir = path.join(CACHE, "map_stats");
const mapStats = new Map();
if (fs.existsSync(statsDir)) {
  for (const f of fs.readdirSync(statsDir)) {
    if (f.endsWith(".json")) {
      const o = readJson(path.join(statsDir, f));
      mapStats.set(o.match_map_id, o.rows);
    }
  }
}

const mapsByMatch = new Map();
for (const mm of maps) {
  if (!mapsByMatch.has(mm.match_id)) mapsByMatch.set(mm.match_id, {});
  mapsByMatch.get(mm.match_id)[mm.map_number] = mm;
}

// Flat table of every player-map we have, with timestamp, for profile building.
const pm = []; // { ts, playerId, nick, map, kills, rounds, kpr, hs, fk, fd, kast, rating }
for (const [matchId, byNum] of mapsByMatch) {
  const match = matchById.get(matchId);
  if (!match?.start_time) continue;
  const ts = Date.parse(match.start_time);
  for (const n of [1, 2]) {
    const mm = byNum[n];
    if (!mm) continue;
    const rounds = (mm.team1_score ?? 0) + (mm.team2_score ?? 0);
    if (rounds <= 0) continue;
    for (const r of mapStats.get(mm.id) ?? []) {
      const pid = r.player?.id ?? r.player_id;
      if (pid == null) continue;
      pm.push({
        ts, playerId: pid, nick: r.player?.nickname ?? String(pid), map: mm.map_name,
        kills: r.kills ?? 0, rounds, kpr: (r.kills ?? 0) / rounds,
        hs: r.headshot_percentage ?? null, fk: r.first_kills ?? 0, fd: r.first_deaths ?? 0,
        kast: r.kast ?? null, rating: r.rating ?? null,
      });
    }
  }
}

if (args.list) {
  const recent = [...matches].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)).slice(0, 25);
  console.log("recent matches:");
  for (const m of recent) {
    console.log(`  ${m.id}  ${m.start_time?.slice(0, 10)}  ${m.team1?.name ?? "?"} vs ${m.team2?.name ?? "?"}  Bo${m.best_of}`);
  }
  process.exit(0);
}

const MATCH_ID = num(args.match);
if (MATCH_ID == null) { console.error("Pass --match <id>  (or --list to find one)"); process.exit(1); }
const target = matchById.get(MATCH_ID);
const tmaps = mapsByMatch.get(MATCH_ID);
if (!target || !tmaps?.[1] || !tmaps?.[2]) { console.error("Match not found / missing maps 1&2 in cache."); process.exit(1); }
const tts = Date.parse(target.start_time);
const expMaps = [tmaps[1].map_name, tmaps[2].map_name];

// players who played both maps 1&2 in the target match
const k1 = new Set((mapStats.get(tmaps[1].id) ?? []).map((r) => r.player?.id ?? r.player_id));
const k2 = new Set((mapStats.get(tmaps[2].id) ?? []).map((r) => r.player?.id ?? r.player_id));
const roster = [...k1].filter((p) => k2.has(p));

// round-volume read for the series (honestly weak; flagged)
const vol = roundVolume(target, tts);

console.log("=".repeat(70));
console.log(`MATCH READ — ${target.team1?.name ?? "?"} vs ${target.team2?.name ?? "?"}   ${target.start_time?.slice(0, 10)}`);
console.log(`format Bo${target.best_of} · tier ${target.tournament?.tier ?? "?"} · ${target.tournament?.is_online ? "ONLINE (higher variance)" : "LAN"}`);
console.log(`expected maps 1&2: ${expMaps.join(" + ")}`);
console.log(`round volume [LOW CONFIDENCE]: E[rounds/map] ${vol.erounds}  blowout ${pct(vol.blowout)}  OT ${pct(vol.otRate)}`);
console.log("=".repeat(70));

for (const pid of roster) {
  const prof = profile(pid, tts, expMaps);
  if (!prof) continue;
  printRead(prof, vol);
}

console.log("\nUNPOWERED (not in this read — needs demo-level data): opponent site/pace");
console.log("tendencies, CT/T side splits, positional fit, economy discipline, stand-in status.");
console.log("Pick score excludes opponent-style (15%) and line-value (10%) weights — see below.");
console.log("=".repeat(70));

// ---------- core ----------
function profile(pid, beforeTs, expectedMaps) {
  const hist = pm.filter((x) => x.playerId === pid && x.ts < beforeTs);
  if (hist.length < CFG.MIN_MAPS) return null;
  const nick = hist[hist.length - 1].nick;
  const kills = hist.map((x) => x.kills);
  const kprs = hist.map((x) => x.kpr);
  const hsVals = hist.map((x) => x.hs).filter((v) => v != null);
  const kastVals = hist.map((x) => x.kast).filter((v) => v != null);
  const fkPerMap = mean(hist.map((x) => x.fk));
  const kpr = mean(kprs);
  const hs = hsVals.length ? mean(hsVals) : null;
  const kast = kastVals.length ? mean(kastVals) : null;

  const recent = hist.slice(-CFG.RECENT_N);
  const recentKpr = mean(recent.map((x) => x.kpr));
  const formDelta = recentKpr - kpr; // + = heating up

  // role inference (INFERRED — no labels in data)
  const role = inferRole({ hs, kpr, kast, fkPerMap });

  // map fit (POWERED): kills on the expected maps vs overall
  const onExpected = hist.filter((x) => expectedMaps.includes(x.map)).map((x) => x.kills);
  const mapFitRatio = onExpected.length >= 3 ? mean(onExpected) / mean(kills) : null;

  // floor/median/ceiling for the Map1&2 TOTAL (POWERED) — use per-map kill
  // percentiles ×2 as a simple combined estimate (compression makes this slightly
  // conservative, which is the safe direction).
  const sorted = [...kills].sort((a, b) => a - b);
  const fl = 2 * pctl(sorted, 0.2), md = 2 * pctl(sorted, 0.5), ce = 2 * pctl(sorted, 0.85);

  return {
    pid, nick, n: hist.length, kpr, hs, kast, fkPerMap, role,
    recentKpr, formDelta, mapFitRatio, expectedMaps,
    floor: Math.round(fl), median: Math.round(md), ceiling: Math.round(ce),
    propType: propTypeFor(role, hs),
  };
}

function inferRole({ hs, kpr, kast, fkPerMap }) {
  if (hs != null && hs <= CFG.AWP_HS_MAX && kpr >= 0.6) return "AWPer";
  if (fkPerMap >= CFG.ENTRY_FK_PER_MAP && kpr >= 0.6) return "Entry";
  if (kpr >= CFG.STAR_KPR) return "Star rifler";
  if (kpr < CFG.SUPPORT_KPR && kast != null && kast >= CFG.SUPPORT_KAST) return "Support/IGL";
  return "Rotator/secondary";
}
function propTypeFor(role, hs) {
  if (role === "AWPer") return "kills or fantasy (NOT headshots — AWP kills aren't HS)";
  if (hs != null && hs >= 50 && role !== "Support/IGL") return "kills or headshots (rifle-heavy)";
  if (role === "Support/IGL") return "fantasy score (kills unreliable)";
  return "kills";
}
function leanFromRole(role) {
  if (role === "Support/IGL") return "UNDER-friendly";
  if (role === "Star rifler" || role === "AWPer" || role === "Entry") return "OVER-friendly";
  return "neutral";
}

function roundVolume(match, beforeTs) {
  // strength gap from prior round margins (the backtest showed this is WEAK —
  // R^2~0.01 — so it's reported low-confidence until rankings/map-pace are added)
  const s1 = teamStrength(match.team1?.id, beforeTs);
  const s2 = teamStrength(match.team2?.id, beforeTs);
  const gap = Math.abs(s1 - s2);
  const erounds = Math.max(16, Math.min(26, CFG.LEAGUE_ROUNDS - 0.4 * gap));
  // base rates from the cache
  const allRounds = pm.map((x) => x.rounds);
  const otRate = pm.filter((x) => x.rounds > 24).length / Math.max(1, pm.length);
  const blowout = pm.filter((x) => x.rounds <= 18).length / Math.max(1, pm.length);
  void allRounds;
  return { erounds: round1(erounds), gap: round1(gap), otRate, blowout };
}
function teamStrength(teamId, beforeTs) {
  if (teamId == null) return 0;
  const rows = [];
  for (const [matchId, byNum] of mapsByMatch) {
    const m = matchById.get(matchId);
    if (!m?.start_time || Date.parse(m.start_time) >= beforeTs) continue;
    for (const n of [1, 2]) {
      const mm = byNum[n]; if (!mm) continue;
      if (m.team1?.id === teamId) rows.push((mm.team1_score ?? 0) - (mm.team2_score ?? 0));
      else if (m.team2?.id === teamId) rows.push((mm.team2_score ?? 0) - (mm.team1_score ?? 0));
    }
  }
  return rows.length ? mean(rows) : 0;
}

function printRead(p, vol) {
  // PARTIAL pick score: powered weights only, re-normalized; missing weights shown.
  const w = { roleStability: 0.15, mapFit: 0.20, roundVolume: 0.20, recentForm: 0.10, blowout: 0.10 };
  const active = Object.values(w).reduce((a, b) => a + b, 0); // 0.75 (oppStyle .15 + line .10 absent)
  const sRole = 1 - Math.min(1, Math.abs(p.formDelta) / 0.25);           // stable form -> 1
  const sMapFit = p.mapFitRatio == null ? 0.5 : Math.max(0, Math.min(1, p.mapFitRatio));
  const sVol = Math.max(0, Math.min(1, (vol.erounds - 16) / 10));         // more rounds -> over-friendly
  const sForm = Math.max(0, Math.min(1, 0.5 + p.formDelta * 2));
  const sBlow = 1 - vol.blowout;
  const score = Math.round(100 * (w.roleStability * sRole + w.mapFit * sMapFit + w.roundVolume * sVol + w.recentForm * sForm + w.blowout * sBlow) / active);
  const band = score >= 80 ? "STRONG" : score >= 70 ? "LEAN" : "PASS";

  // contradiction flags (only the data-checkable ones)
  const flags = [];
  if (leanFromRole(p.role) === "OVER-friendly" && vol.blowout > 0.33) flags.push("over-friendly role but elevated blowout risk → ceiling capped");
  if (p.role === "Support/IGL") flags.push("support/IGL role → kill props fragile, prefer fantasy");
  if (p.mapFitRatio != null && p.mapFitRatio < 0.85) flags.push(`weak on expected maps (${pct(p.mapFitRatio - 1)} vs avg)`);
  if (Math.abs(p.formDelta) > 0.12) flags.push(`recent role/form shift (KPR ${p.formDelta > 0 ? "+" : ""}${round2(p.formDelta)}) — season avg may mislead`);

  console.log(`\n${p.nick}   [${p.role}, ${leanFromRole(p.role)}]   n=${p.n} maps`);
  console.log(`  KPR ${round2(p.kpr)} (recent ${round2(p.recentKpr)})  HS ${p.hs == null ? "?" : Math.round(p.hs) + "%"}  KAST ${p.kast == null ? "?" : Math.round(p.kast) + "%"}  FK/map ${round1(p.fkPerMap)}`);
  console.log(`  Map1&2 kills  floor ${p.floor} · median ${p.median} · ceiling ${p.ceiling}   map-fit ${p.mapFitRatio == null ? "n/a" : (p.mapFitRatio >= 1 ? "+" : "") + pct(p.mapFitRatio - 1)}`);
  console.log(`  prop type: ${p.propType}`);
  console.log(`  pick score ${score}/100 → ${band}   [PARTIAL: excludes opponent-style 15% + line-value 10%]`);
  if (flags.length) for (const f of flags) console.log(`   ⚠ ${f}`);
}

// ---------- utils ----------
function pctl(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const i = (sortedAsc.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}
function readJson(p) {
  if (!fs.existsSync(p)) { console.error(`Missing ${p}. Run pullSeason.mjs first.`); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return out;
}
