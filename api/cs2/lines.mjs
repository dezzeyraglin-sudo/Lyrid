// Vercel serverless proxy — live CS2 prop lines from Underdog + PrizePicks.
// Deploy to: api/cs2/lines.mjs   (route: GET /api/cs2/lines)
//
// The browser can't hit these feeds directly (CORS), so the tab calls THIS same-
// origin function and gets clean, CS2-filtered, standard-only lines keyed by
// normalized player name. Mirrors the tennis /api/…/prizepicks pattern.
//
// FAIL-OPEN BY DESIGN: any failure returns { ok:false, reason } and the tab keeps
// its manual "type the Underdog line" path. A miss must never auto-fill a wrong line.
//
// Honest constraints (unchanged from lineLogger): these are undocumented public
// endpoints and automation is against both sites' ToS — fine for low-volume
// personal use, not a load-bearing public feature. PrizePicks may be region-limited.

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", Accept: "application/json" };
const KILLS_RE = /kill/i;
const HS_RE = /head\s*shot|\bhs\b/i;
const MAPS12_RE = /maps?\s*1\s*\+?\s*2|maps?\s*1-2/i;

function norm(n) {
  if (!n) return "";
  return String(n).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}
// CS2 props are usually the nick (single token). Key on that.
function keyName(n) { const s = norm(n); return s.includes(" ") ? s.split(" ").pop() : s; }

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) { const e = new Error(`${url.split("/")[2]} ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

// merge a (source, name, stat, line, oddsType) row into the players map
function add(players, name, stat, line, source, oddsType) {
  if (name == null || !Number.isFinite(line)) return;
  const k = keyName(name);
  if (!k) return;
  const rec = players[k] || (players[k] = { name, kills: null, hs: null });
  const slot = stat === "hs" ? "hs" : "kills";
  // prefer standard over alt; prefer first-seen otherwise
  if (!rec[slot] || (oddsType === "standard" && rec[slot].oddsType !== "standard")) {
    rec[slot] = { line, source, oddsType: oddsType || "standard" };
  }
}

async function underdog(players) {
  const j = await getJson("https://api.underdogfantasy.com/beta/v3/over_under_lines");
  const nameById = {};
  for (const p of j.players || []) nameById[p.id] = [p.first_name, p.last_name].filter(Boolean).join(" ");
  const appearName = {};
  for (const a of j.appearances || []) appearName[a.id] = nameById[a.player_id] || null;
  let kept = 0;
  for (const l of j.over_under_lines || []) {
    const ou = l.over_under || {};
    const title = ou.title || "";
    if (!MAPS12_RE.test(title)) continue;
    const stat = HS_RE.test(title) ? "hs" : KILLS_RE.test(title) ? "kills" : null;
    if (!stat) continue;
    const player = appearName[ou.appearance_stat?.appearance_id] || title.split(" ")[0];
    add(players, player, stat, Number(l.stat_value), "underdog", "standard");
    kept++;
  }
  return kept;
}

async function prizepicks(players) {
  // partner-api returns 200 from datacenter IPs where api.prizepicks.com hard-403s
  // (this is exactly how the working /api/pp-lines beats the block). One call, all
  // leagues in `included`, filter to CS2 by league name.
  const j = await getJson("https://partner-api.prizepicks.com/projections?per_page=1000");
  const names = {}, leagues = {};
  for (const inc of j.included || []) {
    if (inc.type === "new_player") names[inc.id] = inc.attributes?.display_name || inc.attributes?.name;
    else if (inc.type === "league") leagues[inc.id] = inc.attributes?.name;
  }
  let kept = 0;
  for (const d of j.data || []) {
    const a = d.attributes || {};
    const lgId = d.relationships?.league?.data?.id;
    if (!/(cs2?|counter)/i.test(leagues[lgId] || "")) continue;
    const st = `${a.stat_type || ""}`;
    if (!MAPS12_RE.test(st) && !MAPS12_RE.test(a.description || "")) continue;
    const stat = HS_RE.test(st) ? "hs" : KILLS_RE.test(st) ? "kills" : null;
    if (!stat) continue;
    const pid = d.relationships?.new_player?.data?.id;
    add(players, names[pid] || null, stat, Number(a.line_score), "prizepicks", a.odds_type || "standard");
    kept++;
  }
  return kept;
}

let CACHE = null, CACHE_AT = 0;

export default async function handler(req, res) {
  // 2-min warm cache so a slate of card-opens doesn't spam the feeds
  if (CACHE && Date.now() - CACHE_AT < 120 * 1000) {
    res.setHeader("Cache-Control", "s-maxage=120");
    return res.status(200).json({ ...CACHE, cached: true });
  }
  const players = {};
  const sources = {};
  for (const [name, fn] of [["underdog", underdog], ["prizepicks", prizepicks]]) {
    try { sources[name] = { ok: true, kept: await fn(players) }; }
    catch (e) { sources[name] = { ok: false, reason: String(e.message || e).slice(0, 120) }; }
  }
  const count = Object.keys(players).length;
  const ok = count > 0;
  const out = { ok, reason: ok ? null : "no CS2 lines found on either feed", fetchedAt: new Date().toISOString(), count, sources, players };
  if (ok) { CACHE = out; CACHE_AT = Date.now(); }
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
  return res.status(200).json(out);
}
