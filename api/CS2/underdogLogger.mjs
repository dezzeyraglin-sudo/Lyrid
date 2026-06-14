// underdogLogger.mjs
// Snapshots Underdog CS2 player-prop lines (Kills/Headshots on Maps 1+2, etc.) and
// appends them to a local JSONL so you accumulate real closing-line history to grade
// projections against. No historical backfill exists for these — value starts the
// day you start logging — so run it on every active slate.
//
// AUTH: Underdog requires a bearer token + a set of geo/location headers, and they
// expire. Rather than ever pasting them into a chat, you capture them yourself:
//   1. Underdog CS2 board → DevTools → Network → find the `lines` request
//   2. Right-click it → Copy as cURL  →  paste into ./underdog.curl
//   3. (optional, for full-slate discovery) do the same for the
//      `scaffolds/matches` request → ./underdog_scaffolds.curl
// Both files hold your session token, so KEEP THEM GITIGNORED. When the logger
// starts failing with 401, recapture a fresh cURL — that's the whole maintenance loop.
//
// Usage:  node underdogLogger.mjs            (logs to ./underdog_lines.jsonl)
//         node underdogLogger.mjs --once     (one pass; default)
//         node underdogLogger.mjs --stats kills_on_maps_1_2,headshots_on_maps_1_2
//
// This is YOUR session replayed for personal logging — keep it low-frequency and
// polite; automated access lives under Underdog's ToS and they will rotate tokens.

import fs from "node:fs";

const args = parseArgs(process.argv.slice(2));
const OUT = args.out ?? "./underdog_lines.jsonl";
const CURL = args.curl ?? "./underdog.curl";
const SCAFFOLD_CURL = args.scaffold ?? "./underdog_scaffolds.curl";
const WANT = new Set((args.stats ?? "").split(",").map((s) => s.trim()).filter(Boolean)); // empty = all

const runTs = new Date().toISOString();

async function main() {
  if (!fs.existsSync(CURL)) {
    console.error(`Missing ${CURL}. Copy the Underdog 'lines' request as cURL into it (see header).`);
    process.exit(1);
  }
  const linesReq = parseCurl(fs.readFileSync(CURL, "utf8"));
  if (!linesReq.url || !/lobbies\/content\/lines/.test(linesReq.url)) {
    console.error("The cURL in underdog.curl doesn't look like the /lobbies/content/lines request.");
    process.exit(1);
  }

  // 1) collect match ids: the one in the cURL, plus any from scaffold discovery
  const matchIds = new Set();
  const own = matchIdFrom(linesReq.url);
  if (own) matchIds.add(own);

  for (const id of await discoverMatchIds()) matchIds.add(id);
  console.error(`matches to pull: ${matchIds.size}  [${[...matchIds].join(", ")}]`);

  // 2) pull + parse lines per match
  const rows = [];
  for (const mid of matchIds) {
    const url = setMatchId(linesReq.url, mid);
    let json;
    try {
      json = await fetchJson(url, linesReq.headers);
    } catch (err) {
      console.error(`  match ${mid}: ${err.message}`);
      continue;
    }
    const r = parseLines(json, runTs).filter((x) => WANT.size === 0 || WANT.has(x.stat));
    rows.push(...r);
    console.error(`  match ${mid}: ${r.length} lines`);
    await sleep(600 + Math.random() * 400); // be polite
  }

  // 3) append snapshot
  if (rows.length) {
    fs.appendFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  // summary
  const byStat = {};
  for (const r of rows) byStat[r.stat] = (byStat[r.stat] || 0) + 1;
  console.error(`\nlogged ${rows.length} lines @ ${runTs} -> ${OUT}`);
  for (const [s, n] of Object.entries(byStat).sort((a, b) => b[1] - a[1])) console.error(`  ${s}: ${n}`);
  if (rows.length) {
    console.error("\nsample:");
    for (const r of rows.slice(0, 6)) {
      console.error(`  ${r.player.padEnd(14)} ${r.display.padEnd(22)} ${r.value}   (H ${r.higher_price ?? "?"} / L ${r.lower_price ?? "?"})`);
    }
  }
}

// ---- discovery ----
async function discoverMatchIds() {
  if (!fs.existsSync(SCAFFOLD_CURL)) return [];
  try {
    const req = parseCurl(fs.readFileSync(SCAFFOLD_CURL, "utf8"));
    const json = await fetchJson(req.url, req.headers);
    const ids = new Set();
    for (const sec of json.sections ?? []) {
      const p = sec?.data_source?.path ?? "";
      const m = p.match(/match_id=(\d+)/);
      if (m) ids.add(m[1]);
    }
    return [...ids];
  } catch (err) {
    console.error(`scaffold discovery skipped: ${err.message}`);
    return [];
  }
}

// ---- the parser (pure; tested against real captured JSON) ----
export function parseLines(d, ts) {
  const appearances = d.appearances ?? {};
  const players = d.players ?? {};
  const teams = d.teams ?? {};
  const games = d.games ?? {};
  const out = [];
  for (const o of Object.values(d.over_under_lines ?? {})) {
    const ou = o.over_under ?? {};
    const astat = ou.appearance_stat ?? {};
    const appId = astat.appearance_id;
    const app = appId ? appearances[appId] : null;
    const player = app ? players[app.player_id] : null;
    const team = app ? teams[app.team_id] : null;
    const game = app ? games[String(app.match_id)] : null;

    const nick = player ? (player.last_name || `${player.first_name} ${player.last_name}`).trim() : "?";
    const opts = o.options ?? [];
    const hi = opts.find((x) => x.choice === "higher");
    const lo = opts.find((x) => x.choice === "lower");

    out.push({
      ts,
      book: "underdog",
      match_id: app?.match_id ?? matchIdFrom("") ?? null,
      game: game?.abbreviated_title ?? null,
      player: nick,
      norm: normNick(nick),
      team: team?.abbr ?? null,
      stat: astat.stat ?? null,                 // e.g. kills_on_maps_1_2
      display: astat.display_stat ?? null,      // e.g. "Kills on Maps 1+2"
      value: numOrNull(o.stat_value),           // the line
      higher_price: hi?.american_price ?? null,
      lower_price: lo?.american_price ?? null,
      higher_payout: hi?.payout_multiplier ?? null,
      lower_payout: lo?.payout_multiplier ?? null,
      has_alternates: !!ou.has_alternates,
      line_id: o.id ?? null,
      status: o.status ?? null,
    });
  }
  return out;
}

// strip accents/punctuation, lowercase — to join Underdog nicks to BDL ids
export function normNick(s) {
  return (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---- http + curl ----
async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} (token expired? recapture the cURL)`);
  return res.json();
}

function parseCurl(text) {
  // handles Safari/Chrome "Copy as cURL": curl 'URL' -X GET -H 'K: V' --header 'K: V' ...
  const headers = {};
  // URL: first single- or double-quoted token after `curl`
  const urlMatch = text.match(/curl\s+(?:--[\w-]+\s+)*['"]([^'"]+)['"]/) || text.match(/curl\s+([^\s'"]+)/);
  const url = urlMatch ? urlMatch[1] : null;
  const re = /(?:-H|--header)\s+(['"])([^]*?)\1/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = m[2].indexOf(":");
    if (idx > 0) {
      const k = m[2].slice(0, idx).trim();
      const v = m[2].slice(idx + 1).trim();
      if (k && !/^content-length$/i.test(k)) headers[k] = v;
    }
  }
  return { url, headers };
}

function setMatchId(url, mid) { return url.replace(/match_id=\d+/, `match_id=${mid}`); }
function matchIdFrom(url) { const m = (url || "").match(/match_id=(\d+)/); return m ? m[1] : null; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
  }
  return out;
}

// run unless imported for testing
if (process.argv[1] && process.argv[1].endsWith("underdogLogger.mjs")) {
  main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
}
