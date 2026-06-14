// _synthKPR.mjs  (TEST ONLY) — fake cache where kills are genuinely kpr × rounds,
// rounds depend on matchup closeness, and close maps can hit overtime.
import fs from "node:fs";
import path from "node:path";

const CACHE = process.argv[2] ?? ".cache/synthkpr";
const statsDir = path.join(CACHE, "map_stats");
fs.mkdirSync(statsDir, { recursive: true });
function randn() { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) / Math.sqrt(0.5); }

const MAPS = ["Mirage", "Inferno", "Nuke", "Ancient", "Dust2", "Anubis", "Train"];
// 12 teams with hidden strength; 5 players each with a stable KPR.
const teams = [];
for (let t = 1; t <= 12; t++) {
  const strength = randn() * 2; // team quality
  const players = [];
  for (let p = 0; p < 5; p++) players.push({ id: t * 100 + p, nickname: `t${t}p${p}`, kpr: 0.55 + Math.random() * 0.4 });
  teams.push({ id: t, name: `T${t}`, strength, players });
}

function genMap(a, b) {
  const gap = Math.abs(a.strength - b.strength);
  let loser = Math.round(11 - 0.9 * gap + randn() * 2.2);
  loser = Math.max(0, Math.min(13, loser));
  const aStronger = a.strength > b.strength;
  const aWins = Math.random() < (aStronger ? 0.8 : 0.2); // upsets happen
  if (loser >= 12) {
    return aWins ? { t1s: 16, t2s: 14, rounds: 30, ot: 6 }
                 : { t1s: 14, t2s: 16, rounds: 30, ot: 6 };
  }
  return aWins ? { t1s: 13, t2s: loser, rounds: 13 + loser, ot: 0 }
               : { t1s: loser, t2s: 13, rounds: 13 + loser, ot: 0 };
}

const matches = [], matchMaps = [];
let matchId = 1, mapId = 1;
const start = Date.parse("2026-03-01T00:00:00Z");

for (let d = 0; d < 140; d++) {
  for (let g = 0; g < 3; g++) {
    const a = teams[Math.floor(Math.random() * teams.length)];
    let b = teams[Math.floor(Math.random() * teams.length)];
    while (b === a) b = teams[Math.floor(Math.random() * teams.length)];
    const gap = Math.abs(a.strength - b.strength);
    const ts = new Date(start + d * 86400000 + g * 3600000).toISOString();
    const id = matchId++;
    matches.push({
      id, best_of: 3, status: "finished", start_time: ts,
      tournament: { tier: "S", name: "Synth" },
      team1: { id: a.id, name: a.name }, team2: { id: b.id, name: b.name },
    });
    for (let mn = 1; mn <= 2; mn++) {
      const mp = genMap(a, b);
      const mm = {
        id: mapId++, match_id: id, map_name: MAPS[Math.floor(Math.random() * MAPS.length)],
        map_number: mn, team1_score: mp.t1s, team2_score: mp.t2s, overtime_rounds: mp.ot,
      };
      matchMaps.push(mm);
      const rounds = mp.rounds;
      const rows = [...a.players, ...b.players].map((pl) => ({
        player: { id: pl.id, nickname: pl.nickname },
        match_map_id: mm.id,
        kills: Math.max(0, Math.round(pl.kpr * rounds + randn() * 1.6)),
        deaths: 15, headshot_percentage: 50,
      }));
      fs.writeFileSync(path.join(statsDir, `${mm.id}.json`),
        JSON.stringify({ match_map_id: mm.id, match_id: id, rows }, null, 2));
    }
  }
}
fs.writeFileSync(path.join(CACHE, "matches.json"), JSON.stringify(matches, null, 2));
fs.writeFileSync(path.join(CACHE, "match_maps.json"), JSON.stringify(matchMaps, null, 2));
console.error(`synthKPR: ${matches.length} matches -> ${CACHE}`);
