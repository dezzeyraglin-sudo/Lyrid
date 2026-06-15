// pullRounds.mjs
// Pulls round-by-round data (the match_map_stats endpoint) for maps 1 & 2 of every
// cached match. This is the layer that unlocks pistol-round win rate, CT/T side
// splits, economy/eco-conversion, and trade discipline — the stuff we'd marked
// "UNPOWERED, needs demo-level data." It's one call per map and resumable.
//
//   node --env-file=.env pullRounds.mjs --cache .cache/cs2
//
// Writes .cache/cs2/rounds/<match_map_id>.json. Then run roundSignals.mjs to
// aggregate these into meta/team_rounds.json + meta/map_sides.json.

import fs from "node:fs";
import path from "node:path";
import { BdlCs2Client } from "./bdlClient.mjs";

const args = parseArgs(process.argv.slice(2));
const CACHE = args.cache ?? ".cache/cs2";
const ROUNDS = path.join(CACHE, "rounds");
fs.mkdirSync(ROUNDS, { recursive: true });
const client = new BdlCs2Client();

const maps = JSON.parse(fs.readFileSync(path.join(CACHE, "match_maps.json"), "utf8"));
const target = maps.filter((mm) => mm.map_number === 1 || mm.map_number === 2);

let cached = 0, fetched = 0, failed = 0;
for (const mm of target) {
  const out = path.join(ROUNDS, mm.id + ".json");
  if (fs.existsSync(out)) { cached++; continue; }
  try {
    const r = await client.request("/cs/v1/match_map_stats", { match_map_id: mm.id });
    fs.writeFileSync(out, JSON.stringify(r.data ?? {}, null, 2));
    fetched++;
    if (fetched % 20 === 0) console.log(`  fetched ${fetched} (cached ${cached})`);
  } catch (e) {
    failed++;
    if (failed <= 3) console.error(`  ${mm.id} failed: ${e.message}`);
  }
}
console.log(`done. ${fetched} fetched, ${cached} already cached, ${failed} failed → ${ROUNDS}`);
console.log("next: node roundSignals.mjs --cache " + CACHE);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
  return out;
}
