// pullMeta.mjs
// Pulls the cheap, slate-wide CS2 data that the per-match pull doesn't cover:
//   • rankings        official Valve World Rankings (rank + points per team)
//   • rosters         current ACTIVE lineup per team (kills the churn inference)
//   • map pools       per-team per-map win_rate + is_permaban (real veto modeling)
// These are small and change slowly, so run this daily (or before a slate), not per match.
//
//   node --env-file=.env pullMeta.mjs --cache .cache/cs2
//
// Writes .cache/cs2/meta/{rankings.json, rosters.json, map_pool.json}. matchRead picks
// them up automatically if present and falls back to inference if they're missing.

import fs from "node:fs";
import path from "node:path";
import { BdlCs2Client } from "./bdlClient.mjs";

const args = parseArgs(process.argv.slice(2));
const CACHE = args.cache ?? ".cache/cs2";
const META = path.join(CACHE, "meta");
fs.mkdirSync(META, { recursive: true });
const client = new BdlCs2Client();

console.log("CS2 meta pull → " + META);

// 1) Rankings — single call (ALL-STAR tier or higher; GOAT covers it).
let rankings = [];
try {
  const r = await client.request("/cs/v1/rankings", {});
  rankings = r.data ?? [];
  fs.writeFileSync(path.join(META, "rankings.json"), JSON.stringify(rankings, null, 2));
  console.log(`  rankings ......... ${rankings.length} teams`);
} catch (e) {
  console.error(`  rankings FAILED (${e.message}) — tier may not include rankings; skipping`);
}

// 2) Active players → rosters by team.
let players = [];
try {
  let cursor = null;
  do {
    const params = { active: true, per_page: 100 };
    if (cursor) params.cursor = cursor;
    const p = await client.request("/cs/v1/players", params);
    players.push(...(p.data ?? []));
    cursor = p.meta?.next_cursor ?? null;
  } while (cursor);
  const rosters = {};
  for (const pl of players) {
    if (pl.is_active === false) continue;
    const tid = pl.team?.id;
    if (tid == null) continue;
    (rosters[tid] = rosters[tid] || []).push({ id: pl.id, nickname: pl.nickname, full_name: pl.full_name ?? null });
  }
  fs.writeFileSync(path.join(META, "rosters.json"), JSON.stringify(rosters, null, 2));
  console.log(`  rosters .......... ${Object.keys(rosters).length} teams, ${players.length} active players`);
} catch (e) {
  console.error(`  rosters FAILED (${e.message}); skipping`);
}

// 3) Map pool per team — bound to ranked teams (the ones that show up on slates).
const teamIds = new Set();
for (const r of rankings) if (r.team?.id != null) teamIds.add(r.team.id);
if (!teamIds.size) for (const pl of players) if (pl.team?.id != null) teamIds.add(pl.team.id);
const mapPool = {};
let done = 0;
for (const tid of teamIds) {
  try {
    const mp = await client.request("/cs/v1/team_map_pool", { team_id: tid });
    mapPool[tid] = mp.data ?? [];
  } catch (e) {
    if (done === 0) console.error(`  team_map_pool note: ${e.message} (needs ALL-STAR+; skipping pools)`);
    break;
  }
  if (++done % 10 === 0) console.log(`  map pools ........ ${done}/${teamIds.size}`);
}
if (done) {
  fs.writeFileSync(path.join(META, "map_pool.json"), JSON.stringify(mapPool, null, 2));
  console.log(`  map pools ........ ${Object.keys(mapPool).length} teams`);
}

console.log("done.");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
  return out;
}
