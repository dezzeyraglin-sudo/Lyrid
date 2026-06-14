// scripts/cs2/_synth.mjs  (TEST ONLY — generates a fake cache to validate logic)
import fs from "node:fs";
import path from "node:path";

const CACHE = process.argv[2] ?? ".cache/synth";
const statsDir = path.join(CACHE, "map_stats");
fs.mkdirSync(statsDir, { recursive: true });

// Gaussian-ish via sum of uniforms, then Poisson-ish rounding to non-negative ints.
function randn() { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) / Math.sqrt(0.5); }
function killsFrom(mean, sd) { return Math.max(0, Math.round(mean + sd * randn())); }

const MAPS = ["Mirage", "Inferno", "Nuke", "Ancient", "Dust2", "Anubis", "Train"];
// 8 players, each with a base per-map kill mean and STRONG map-specific offsets,
// so a map-conditioned projection SHOULD beat a flat average.
const players = [];
for (let p = 1; p <= 8; p++) {
  const base = 14 + Math.random() * 6; // 14-20 avg kills/map
  const mapOffset = {};
  for (const mp of MAPS) mapOffset[mp] = (Math.random() - 0.5) * 8; // +-4 kills by map
  players.push({ id: 1000 + p, nickname: `p${p}`, base, mapOffset, sd: 3.5 });
}

const matches = [];
const matchMaps = [];
let matchId = 1, mapId = 1;
const start = Date.parse("2026-03-01T00:00:00Z");

for (let d = 0; d < 120; d++) {            // 120 match-days
  for (let g = 0; g < 3; g++) {            // 3 matches/day
    const ts = new Date(start + (d * 86400000) + g * 3600000).toISOString();
    const id = matchId++;
    matches.push({
      id, best_of: 3, status: "finished",
      start_time: ts,
      tournament: { tier: "S", name: "Synth Cup" },
      team1: { id: 1, name: "A" }, team2: { id: 2, name: "B" },
    });
    // pick map1 & map2 names
    const m1name = MAPS[Math.floor(Math.random() * MAPS.length)];
    let m2name = MAPS[Math.floor(Math.random() * MAPS.length)];
    if (m2name === m1name) m2name = MAPS[(MAPS.indexOf(m2name) + 1) % MAPS.length];

    const m1 = { id: mapId++, match_id: id, map_name: m1name, map_number: 1 };
    const m2 = { id: mapId++, match_id: id, map_name: m2name, map_number: 2 };
    matchMaps.push(m1, m2);

    // a "series form" shock shared across both maps -> induces map1<->map2 correlation
    for (const [mm, mname] of [[m1, m1name], [m2, m2name]]) {
      const rows = players.map((pl) => {
        const seriesShock = (mm === m1 ? (pl._shock = randn() * 2) : pl._shock); // shared shock
        const mu = pl.base + pl.mapOffset[mname] + seriesShock * 0.6;
        return {
          player: { id: pl.id, nickname: pl.nickname },
          match_map_id: mm.id,
          kills: killsFrom(mu, pl.sd),
          deaths: 15, assists: 4, adr: 80, kast: 70, rating: 1.1,
          headshot_percentage: 50, first_kills: 3, first_deaths: 2,
        };
      });
      fs.writeFileSync(path.join(statsDir, `${mm.id}.json`),
        JSON.stringify({ match_map_id: mm.id, match_id: id, rows }, null, 2));
    }
  }
}

fs.writeFileSync(path.join(CACHE, "matches.json"), JSON.stringify(matches, null, 2));
fs.writeFileSync(path.join(CACHE, "match_maps.json"), JSON.stringify(matchMaps, null, 2));
console.error(`synth: ${matches.length} matches, ${matchMaps.length} maps -> ${CACHE}`);
