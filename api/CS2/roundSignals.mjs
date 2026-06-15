// roundSignals.mjs
// Aggregates the cached round-by-round data into the signals matchRead consumes:
//   meta/team_rounds.json  per team: pistol win rate, CT-side & T-side round win rate
//   meta/map_sides.json    per map:  leaguewide CT win rate (how CT- or T-sided it is)
//
//   node roundSignals.mjs --cache .cache/cs2
//
// No API key needed — pure aggregation of what pullRounds.mjs already fetched.

import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const CACHE = args.cache ?? ".cache/cs2";
const ROUNDS = path.join(CACHE, "rounds");
const META = path.join(CACHE, "meta");
fs.mkdirSync(META, { recursive: true });

if (!fs.existsSync(ROUNDS)) { console.error("No rounds/ cache. Run pullRounds.mjs first."); process.exit(1); }

const team = new Map();   // teamId -> { pistolW, pistolN, ctW, ctN, tW, tN, name }
const mapSide = new Map(); // mapCanon -> { ctW, n }
const bump = (m, id, init) => { if (!m.has(id)) m.set(id, init()); return m.get(id); };

let files = 0, rounds = 0;
for (const f of fs.readdirSync(ROUNDS)) {
  if (!f.endsWith(".json")) continue;
  let o; try { o = JSON.parse(fs.readFileSync(path.join(ROUNDS, f), "utf8")); } catch { continue; }
  if (!o || !Array.isArray(o.rounds)) continue;
  files++;
  const mc = canonMap(o.map_name);
  for (const r of o.rounds) {
    rounds++;
    // map side balance
    if (r.winner_side === "CT" || r.winner_side === "T") {
      const ms = bump(mapSide, mc, () => ({ ctW: 0, n: 0 }));
      ms.n++; if (r.winner_side === "CT") ms.ctW++;
    }
    // per-team pistol + side
    for (const ts of r.team_stats ?? []) {
      const id = ts.team?.id; if (id == null) continue;
      const t = bump(team, id, () => ({ pistolW: 0, pistolN: 0, ctW: 0, ctN: 0, tW: 0, tN: 0, name: ts.team?.name ?? null }));
      if (ts.is_pistol_round) { t.pistolN++; if (ts.won) t.pistolW++; }
      if (ts.team_side === "CT") { t.ctN++; if (ts.won) t.ctW++; }
      else if (ts.team_side === "T") { t.tN++; if (ts.won) t.tW++; }
    }
  }
}

const teamOut = {};
for (const [id, t] of team) {
  teamOut[id] = {
    name: t.name,
    pistolWin: t.pistolN ? round3(t.pistolW / t.pistolN) : null, pistolN: t.pistolN,
    ctWin: t.ctN ? round3(t.ctW / t.ctN) : null, ctN: t.ctN,
    tWin: t.tN ? round3(t.tW / t.tN) : null, tN: t.tN,
  };
}
const mapOut = {};
for (const [m, s] of mapSide) mapOut[m] = { ctWin: round3(s.ctW / s.n), n: s.n };

fs.writeFileSync(path.join(META, "team_rounds.json"), JSON.stringify(teamOut, null, 2));
fs.writeFileSync(path.join(META, "map_sides.json"), JSON.stringify(mapOut, null, 2));

console.log(`aggregated ${files} maps, ${rounds} rounds`);
console.log(`  teams: ${Object.keys(teamOut).length}  → meta/team_rounds.json`);
console.log(`  maps:  ${Object.keys(mapOut).length}  → meta/map_sides.json`);
const sample = Object.entries(mapOut).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
for (const [m, s] of sample) console.log(`    ${m.padEnd(10)} CT win ${(s.ctWin * 100).toFixed(0)}%  (n=${s.n})`);

function canonMap(name) { return String(name || "").toLowerCase().replace(/^de_/, "").trim(); }
function round3(x) { return Math.round(x * 1000) / 1000; }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
  return out;
}
