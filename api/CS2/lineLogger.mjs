// lineLogger.mjs — log real prop lines from Underdog + PrizePicks public feeds.
// Usage:  node lineLogger.mjs [--out lines.jsonl] [--all]
//   default: keeps CS2-looking lines only (kills / headshots / maps). --all keeps every line.
//
// Why: the engine's edge is only provable against REAL lines. This appends one JSON
// row per (source, player, stat, line) so the grader can join results later.
//
// Behavior notes (deliberate):
//  - One request per feed per run. Run it on a schedule (launchd every 30 min during
//    slates) — do NOT loop it hot.
//  - If a feed returns 401/403/429, we print the status and stop. That's the site
//    saying no; we respect it rather than trying to sneak around it.

import fs from "node:fs";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : "lines.jsonl";
const ALL = args.includes("--all");
const CS2_RE = /(map\s*1|maps\s*1\s*\+\s*2|kill|headshot|\bHS\b)/i;
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", Accept: "application/json" };

// dedupe against what's already on disk
const seen = new Set();
if (fs.existsSync(OUT)) {
  for (const ln of fs.readFileSync(OUT, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try { const r = JSON.parse(ln); seen.add(r.key); } catch {}
  }
}
const rows = [];
function push(source, player, stat, line, extra = {}) {
  const key = `${source}|${player}|${stat}|${line}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({ key, source, player, stat, line, loggedAt: new Date().toISOString(), ...extra });
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url.split("/")[2]} responded ${r.status} — stopping (respect it, don't hammer)`);
  return r.json();
}

async function underdog() {
  // public lines feed (no auth). Titles look like "Kills on Maps 1+2".
  const j = await getJson("https://api.underdogfantasy.com/beta/v3/over_under_lines");
  const lines = j.over_under_lines || [];
  // v3 ships appearances/players alongside; build id -> name when present
  const players = {};
  for (const p of j.players || []) players[p.id] = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const appearances = {};
  for (const a of j.appearances || []) appearances[a.id] = players[a.player_id] || null;
  let kept = 0;
  for (const l of lines) {
    const ou = l.over_under || {};
    const title = ou.title || "";
    const stat = ou.appearance_stat?.display_stat || ou.appearance_stat?.stat || "";
    if (!ALL && !CS2_RE.test(title + " " + stat)) continue;
    const player = appearances[ou.appearance_stat?.appearance_id] || (title.split(" ")[0] || "?");
    push("underdog", player, stat || title, Number(l.stat_value), { title });
    kept++;
  }
  return { total: lines.length, kept };
}

async function prizepicks() {
  // resolve CS-ish league ids first, then pull those projections only
  const lg = await getJson("https://api.prizepicks.com/leagues");
  const csIds = (lg.data || [])
    .filter((x) => /(^|\W)(cs2?|counter)/i.test(x.attributes?.name || ""))
    .map((x) => x.id);
  let total = 0, kept = 0;
  const targets = ALL && !csIds.length ? [null] : csIds;
  for (const id of targets) {
    const url = id
      ? `https://api.prizepicks.com/projections?league_id=${id}&per_page=500&single_stat=true`
      : `https://api.prizepicks.com/projections?per_page=500&single_stat=true`;
    const j = await getJson(url);
    const names = {};
    for (const inc of j.included || []) if (inc.type === "new_player") names[inc.id] = inc.attributes?.display_name || inc.attributes?.name;
    for (const d of j.data || []) {
      total++;
      const a = d.attributes || {};
      if (!ALL && !CS2_RE.test(`${a.stat_type || ""}`)) continue;
      const pid = d.relationships?.new_player?.data?.id;
      push("prizepicks", names[pid] || "?", a.stat_type || "?", Number(a.line_score), {
        startTime: a.start_time || null, desc: a.description || null,
      });
      kept++;
    }
  }
  return { total, kept };
}

const summary = { underdog: null, prizepicks: null };
for (const [name, fn] of [["underdog", underdog], ["prizepicks", prizepicks]]) {
  try { summary[name] = await fn(); }
  catch (e) { summary[name] = { error: String(e.message || e) }; }
}
if (rows.length) fs.appendFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(JSON.stringify({ newLines: rows.length, out: OUT, ...summary }, null, 1));
