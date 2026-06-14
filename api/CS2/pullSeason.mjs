// scripts/cs2/pullSeason.mjs
// One-time / offline season pull. Run this LOCALLY during your 48h GOAT trial —
// it can take a while at 5 req/min, which is longer than any Vercel function will
// live, so it is deliberately a node script, not a serverless endpoint. The
// bdlClient it uses is the same one your live endpoints will import later.
//
// It is resumable: per-map stats are cached one file per match_map_id, so a 429,
// a Ctrl-C, or a laptop sleep just means you re-run and it skips what's done.
//
// Usage:
//   BDL_API_KEY=xxx node scripts/cs2/pullSeason.mjs \
//     --from 2026-03-01 --to 2026-06-10 --tiers S,A --bestOf 3 --cache .cache/cs2
//
// Then run scripts/cs2/backtestMap12.mjs against the same --cache.

import fs from "node:fs";
import path from "node:path";
import { BdlCs2Client, dateRange, chunked } from "./bdlClient.mjs";

const args = parseArgs(process.argv.slice(2));
const FROM = args.from ?? required("--from");
const TO = args.to ?? required("--to");
const TIERS = new Set((args.tiers ?? "S,A").split(",").map((s) => s.trim().toUpperCase()));
const MIN_BEST_OF = Number(args.bestOf ?? 3); // Bo3+ so Map 1 AND Map 2 always exist
const CACHE = args.cache ?? ".cache/cs2";
const MAP_NUMBERS = new Set([1, 2]); // we only need maps 1 & 2 for this backtest

const dirs = {
  root: CACHE,
  mapStats: path.join(CACHE, "map_stats"),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

const client = new BdlCs2Client({ onLog: (m) => console.error("  · " + m) });

function isFinished(status) {
  if (!status) return false;
  return /finish|complete|closed|ended/i.test(status);
}

async function main() {
  const t0 = Date.now();

  // 1) Matches across the date range, filtered to tier + best_of + finished.
  console.error(`Pulling matches ${FROM}..${TO} (tiers ${[...TIERS].join("/")}, Bo>=${MIN_BEST_OF})`);
  const dates = dateRange(FROM, TO);
  const matches = [];
  for (const dchunk of chunked(dates, 25)) {
    for await (const m of client.matchesOnDates(dchunk)) {
      const tier = (m.tournament?.tier ?? "").toUpperCase();
      if (TIERS.size && !TIERS.has(tier)) continue;
      if ((m.best_of ?? 0) < MIN_BEST_OF) continue;
      if (!isFinished(m.status)) continue;
      matches.push(m);
    }
    console.error(`  matches so far: ${matches.length}`);
  }
  writeJson(path.join(dirs.root, "matches.json"), matches);
  console.error(`Kept ${matches.length} matches.`);

  if (!matches.length) {
    console.error("No matches matched the filters. Widen the date range or tiers.");
    return;
  }

  // 2) Maps for those matches; keep only map_number 1 & 2.
  const matchIds = matches.map((m) => m.id);
  console.error(`Pulling maps for ${matchIds.length} matches...`);
  const allMaps = await client.matchMaps(matchIds);
  const maps = allMaps.filter((mm) => MAP_NUMBERS.has(mm.map_number));
  writeJson(path.join(dirs.root, "match_maps.json"), maps);
  console.error(`Kept ${maps.length} maps (1 & 2) across ${matchIds.length} matches.`);

  // 3) Per-map player stats. This is the expensive loop — one request per map.
  const todo = maps.filter((mm) => !fs.existsSync(mapStatsPath(mm.id)));
  const done = maps.length - todo.length;
  const etaMin = Math.ceil((todo.length * client.limiter.minIntervalMs) / 60000);
  console.error(
    `Per-map stats: ${done} cached, ${todo.length} to fetch ` +
      `(~${etaMin} min at current rate limit). Resumable — safe to Ctrl-C.`
  );

  let i = 0;
  for (const mm of todo) {
    const rows = await client.playerMatchMapStats(mm.id);
    writeJson(mapStatsPath(mm.id), { match_map_id: mm.id, match_id: mm.match_id, rows });
    i++;
    if (i % 10 === 0 || i === todo.length) {
      console.error(`  fetched ${i}/${todo.length} maps  (total reqs: ${client.reqCount})`);
    }
  }

  console.error(
    `Done in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${client.reqCount} requests. ` +
      `Cache at ${CACHE}. Next: node scripts/cs2/backtestMap12.mjs --cache ${CACHE}`
  );
}

function mapStatsPath(id) {
  return path.join(dirs.mapStats, `${id}.json`);
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
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
function required(flag) {
  console.error(`Missing required ${flag}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
