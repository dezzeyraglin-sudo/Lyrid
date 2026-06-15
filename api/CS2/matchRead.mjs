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
  AWP_HS_MAX: 42,        // HS% at/below this + real frag volume => AWP-leaning (absolute fallback)
  AWP_HS_SANITY: 46,     // relative mode: lowest-HS player is AWP only if below this
  ENTRY_FK_PER_MAP: 2.8, // first kills/map at/above => entry profile
  STAR_KPR: 0.74,        // KPR at/above => star carry
  SUPPORT_KPR: 0.60,     // KPR below this => support/IGL (KAST-gated if present)
  SUPPORT_KAST: 68,
  RECENT_N: 8,           // maps counted as "recent form"
  MIN_MAPS: 6,           // below this we won't profile a player
  THIN_N: 10,            // reads below this flagged as thin sample
  MIN_ROUNDS: 13,        // drop forfeits/incompletes below a full regulation map
  MAX_ROUNDS: 40,        // drop anomalies above a plausible double-OT map
  LEAGUE_ROUNDS: 22,     // fallback expected rounds
};

const args = parseArgs(process.argv.slice(2));
const CACHE = args.cache ?? ".cache/cs2";
const JSON_OUT = !!args.json;                 // emit a slate JSON for the Lyrid app instead of console text
const OUT_PATH = args.out ?? "cs2_reads.json"; // upsert this match into the file (one file = a slate)

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
    if (rounds < CFG.MIN_ROUNDS || rounds > CFG.MAX_ROUNDS) continue; // forfeits/anomalies
    for (const r of mapStats.get(mm.id) ?? []) {
      const pid = r.player?.id ?? r.player_id;
      if (pid == null) continue;
      pm.push({
        ts, playerId: pid, nick: r.player?.nickname ?? String(pid), map: canonMap(mm.map_name),
        kills: r.kills ?? 0, rounds, kpr: (r.kills ?? 0) / rounds,
        deaths: r.deaths ?? 0, adr: r.adr ?? null, clutch: r.clutches_won ?? 0,
        hs: r.headshot_percentage ?? null, fk: r.first_kills ?? 0, fd: r.first_deaths ?? 0,
        kast: r.kast ?? null, rating: r.rating ?? null,
        t1: match.team1?.id ?? null, t2: match.team2?.id ?? null,
      });
    }
  }
}

// Player -> match participations, for resolving which team a player is on (no team
// field on the row, but a player's true team recurs across all their matches while
// opponents vary, so it's the argmax of team appearances).
const playerMatches = new Map();
for (const [matchId, byNum] of mapsByMatch) {
  const m = matchById.get(matchId);
  if (!m?.start_time) continue;
  const ts = Date.parse(m.start_time);
  const seen = new Set();
  for (const n of [1, 2]) {
    const mm = byNum[n]; if (!mm) continue;
    for (const r of mapStats.get(mm.id) ?? []) {
      const pid = r.player?.id ?? r.player_id;
      if (pid == null || seen.has(pid)) continue;
      seen.add(pid);
      if (!playerMatches.has(pid)) playerMatches.set(pid, []);
      playerMatches.get(pid).push({ ts, t1: m.team1?.id ?? null, t2: m.team2?.id ?? null });
    }
  }
}

// ---- optional meta: rankings / official rosters / map pools (from pullMeta.mjs) ----
const META_DIR = path.join(CACHE, "meta");
const rankingByTeam = new Map();   // teamId -> { rank, points }
const rosterByTeam = new Map();    // teamId -> [{id,nickname}]
const mapPoolByTeam = new Map();   // teamId -> [{map, win_rate, played, permaban}]
for (const r of (readJsonSafe(path.join(META_DIR, "rankings.json")) ?? [])) if (r.team?.id != null) rankingByTeam.set(r.team.id, { rank: r.rank, points: r.points });
{ const ro = readJsonSafe(path.join(META_DIR, "rosters.json")); if (ro) for (const [tid, arr] of Object.entries(ro)) rosterByTeam.set(Number(tid), arr); }
{ const mp = readJsonSafe(path.join(META_DIR, "map_pool.json")); if (mp) for (const [tid, arr] of Object.entries(mp)) mapPoolByTeam.set(Number(tid), (arr || []).map((x) => ({ map: canonMap(x.map_name), win_rate: x.win_rate, played: x.matches_played, permaban: x.is_permaban }))); }
const roundsByTeam = new Map();    // teamId -> { pistolWin, ctWin, tWin, ... }
const sideByMap = new Map();       // mapCanon -> { ctWin, n }
{ const tr = readJsonSafe(path.join(META_DIR, "team_rounds.json")); if (tr) for (const [tid, v] of Object.entries(tr)) roundsByTeam.set(Number(tid), v); }
{ const sm = readJsonSafe(path.join(META_DIR, "map_sides.json")); if (sm) for (const [m, v] of Object.entries(sm)) sideByMap.set(m, v); }

if (args.list) {
  const recent = [...matches].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)).slice(0, 25);
  console.log("recent matches:");
  for (const m of recent) {
    console.log(`  ${m.id}  ${m.start_time?.slice(0, 10)}  ${m.team1?.name ?? "?"} vs ${m.team2?.name ?? "?"}  Bo${m.best_of}`);
  }
  process.exit(0);
}

// FORWARD SLATE: pull today's (or a given date's) scheduled games from BDL with
// start times, resolve each team's roster from history, and project every player.
// Writes the whole slate to one file. Needs BDL_API_KEY (uses bdlClient). Usage:
//   node matchRead.mjs --today --cache .cache/cs2 --out cs2_reads.json
//   node matchRead.mjs --today 2026-06-15 --cache .cache/cs2 --out cs2_reads.json
if (args.today) {
  const date = (args.today === true) ? new Date().toISOString().slice(0, 10) : String(args.today);
  await runToday(date);
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

if (!JSON_OUT) {
  console.log("=".repeat(70));
  console.log(`MATCH READ — ${target.team1?.name ?? "?"} vs ${target.team2?.name ?? "?"}   ${target.start_time?.slice(0, 10)}`);
  console.log(`format Bo${target.best_of} · tier ${target.tournament?.tier ?? "?"} · ${target.tournament?.is_online ? "ONLINE (higher variance)" : "LAN"}`);
  console.log(`expected maps 1&2: ${expMaps.join(" + ")}`);
  console.log(`round volume [LOW CONFIDENCE]: E[rounds/map] ${vol.erounds}  blowout ${pct(vol.blowout)}  OT ${pct(vol.otRate)}`);
  console.log("=".repeat(70));
}

const profiles = roster.map((pid) => profile(pid, tts, expMaps)).filter(Boolean);

// resolve each player to one of the two match teams, then assign roles relatively
const t1id = target.team1?.id, t2id = target.team2?.id;
const byTeam = new Map([[t1id, []], [t2id, []]]);
const unresolved = [];
for (const p of profiles) {
  const team = resolveTeam(p.pid, tts, t1id, t2id);
  if (team != null && byTeam.has(team)) byTeam.get(team).push(p);
  else unresolved.push(p);
}
for (const [, team] of byTeam) assignRolesRelative(team);
for (const p of unresolved) p.role = inferRole(p); // fallback for unresolved players

// collect every player (team-resolved first, then fallback) with their team name
const playersOut = [];
for (const [teamId, team] of byTeam) {
  const tname = teamId === t1id ? target.team1?.name : target.team2?.name;
  const oppId = teamId === t1id ? t2id : t1id;
  const oppRank = rankingByTeam.get(oppId)?.rank ?? null;
  for (const p of team) playersOut.push({ team: tname ?? null, ...computeRead(p, vol, { oppRank, oppId }) });
}
for (const p of unresolved) playersOut.push({ team: null, ...computeRead(p, vol) });

if (JSON_OUT) {
  // Upsert this match into a slate file the Lyrid CS2 tab fetches. One file = one slate.
  const matchObj = {
    matchId: MATCH_ID,
    date: target.start_time?.slice(0, 10) ?? null,
    startTime: target.start_time ?? null,
    teamA: target.team1?.name ?? null,
    teamB: target.team2?.name ?? null,
    format: `Bo${target.best_of}`,
    tier: target.tournament?.tier ?? null,
    lan: !target.tournament?.is_online,
    maps: expMaps,
    roundVolume: { erounds: vol.erounds, blowout: vol.blowout, ot: vol.otRate, confidence: "LOW" },
    roundRead: roundRead(target, expMaps, vol),
    players: playersOut,
  };
  let file = {
    ok: true, generatedAt: null, validated: false,
    source: "BDL CS2 + matchRead — PARTIAL pick score, NOT yet validated vs Underdog price",
    matches: [],
  };
  if (fs.existsSync(OUT_PATH)) { try { file = JSON.parse(fs.readFileSync(OUT_PATH, "utf8")); } catch { /* start fresh */ } }
  file.matches = (file.matches || []).filter((m) => m.matchId !== MATCH_ID); // replace if re-run
  file.matches.push(matchObj);
  file.matches.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  file.ok = true; file.validated = false; file.generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_PATH, JSON.stringify(file, null, 2));
  console.error(`✓ ${matchObj.teamA} vs ${matchObj.teamB} → ${OUT_PATH}  (${file.matches.length} match${file.matches.length === 1 ? "" : "es"} in slate)`);
  process.exit(0);
}

for (const [teamId, team] of byTeam) {
  if (!team.length) continue;
  const tname = teamId === t1id ? target.team1?.name : target.team2?.name;
  console.log(`\n──── ${tname ?? "team"} ────`);
  const oppId = teamId === t1id ? t2id : t1id;
  const oppRank = rankingByTeam.get(oppId)?.rank ?? null;
  for (const p of team) printRead(p, vol, { oppRank, oppId });
}
if (unresolved.length) {
  console.log(`\n──── (team unresolved — absolute role fallback) ────`);
  for (const p of unresolved) printRead(p, vol);
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

  // opponent-quality split (research: performance vs top teams is the discriminator)
  const ownTeam = argmaxTeam(pid, beforeTs);
  const strongKprs = [], weakKprs = [];
  for (const x of hist) {
    const opp = ownTeam === x.t1 ? x.t2 : x.t1;
    const oppRank = opp == null ? null : (rankingByTeam.get(opp)?.rank ?? null);
    if (oppRank != null && oppRank <= 10) strongKprs.push(x.kpr); else weakKprs.push(x.kpr);
  }
  const kprStrong = strongKprs.length ? mean(strongKprs) : null;
  const kprWeak = weakKprs.length ? mean(weakKprs) : null;

  // survival (deaths = price of output), ADR (purest frag signal), opening duels
  const dpr = mean(hist.map((x) => x.deaths / x.rounds));
  const survival = 1 - dpr;
  const adrVals = hist.map((x) => x.adr).filter((v) => v != null);
  const adr = adrVals.length ? mean(adrVals) : null;
  const clutchPerMap = mean(hist.map((x) => x.clutch || 0));   // clutch ability -> fat right tail
  const fkSum = hist.reduce((a, x) => a + x.fk, 0), fdSum = hist.reduce((a, x) => a + x.fd, 0);
  const openingWin = (fkSum + fdSum) > 0 ? fkSum / (fkSum + fdSum) : null;
  const openingShare = mean(hist.map((x) => (x.fk + x.fd) / x.rounds));

  // role inference (INFERRED — no labels in data)
  const role = inferRole({ hs, kpr, kast, fkPerMap });

  // map fit (POWERED): kills on the expected maps vs overall
  const onExpected = hist.filter((x) => expectedMaps.includes(x.map)).map((x) => x.kills);
  const mapFitRatio = onExpected.length >= 3 ? mean(onExpected) / mean(kills) : null;

  // KPR-anchored distribution (POWERED): percentiles of the player's kills-per-round,
  // scaled by expected series rounds in printRead. Ties floor/median/ceiling to the
  // validated rate model instead of noisy raw-kill percentiles.
  const kprSorted = [...kprs].sort((a, b) => a - b);
  const kprP = { p20: pctl(kprSorted, 0.2), p50: pctl(kprSorted, 0.5), p85: pctl(kprSorted, 0.85) };

  return {
    pid, nick, n: hist.length, kpr, hs, kast, fkPerMap, role,
    recentKpr, formDelta, mapFitRatio, expectedMaps, kprP,
    kprStrong, kprStrongN: strongKprs.length, kprWeak,
    dpr, survival, adr, clutchPerMap, openingWin, openingShare,
    propType: propTypeFor(role, hs),
  };
}

function inferRole({ hs, kpr, kast, fkPerMap }) {
  if (hs != null && hs <= CFG.AWP_HS_MAX && kpr >= 0.58) return "AWPer";
  if (kpr >= CFG.STAR_KPR) return "Star rifler";
  if (fkPerMap >= CFG.ENTRY_FK_PER_MAP && kpr >= 0.58) return "Entry";
  if (kpr < CFG.SUPPORT_KPR && (kast == null || kast >= CFG.SUPPORT_KAST)) return "Support/IGL";
  return "Rifler";
}

// Resolve which of the two match teams a player belongs to, from prior matches.
function resolveTeam(pid, beforeTs, teamA, teamB) {
  const hist = (playerMatches.get(pid) ?? []).filter((x) => x.ts < beforeTs);
  let a = 0, b = 0;
  for (const h of hist) {
    if (h.t1 === teamA || h.t2 === teamA) a++;
    if (h.t1 === teamB || h.t2 === teamB) b++;
  }
  if (a === 0 && b === 0) return null;
  return a >= b ? teamA : teamB;
}

// Assign roles RELATIVELY within a team's five: at most one AWPer (the lowest-HS
// player, and only if genuinely low), one support, one star, one entry; rest Rifler.
// This is how real lineups work and it stops the absolute HS cutoff from tagging
// three AWPers across two teams.
function assignRolesRelative(team) {
  if (team.length < 3) { for (const p of team) p.role = inferRole(p); return; }
  const avail = new Set(team);
  const pickFrom = (set, sel, cond) => {
    const arr = [...set];
    if (!arr.length) return;
    const chosen = arr.reduce(sel);
    if (cond(chosen)) return chosen;
    return null;
  };
  const withHs = [...avail].filter((p) => p.hs != null);
  if (withHs.length) {
    const awp = withHs.reduce((lo, p) => (p.hs < lo.hs ? p : lo));
    if (awp.hs <= CFG.AWP_HS_SANITY) { awp.role = "AWPer"; avail.delete(awp); }
  }
  const sup = pickFrom(avail, (lo, p) => (p.kpr < lo.kpr ? p : lo), (c) => c.kpr < CFG.SUPPORT_KPR + 0.04);
  if (sup) { sup.role = "Support/IGL"; avail.delete(sup); }
  const star = pickFrom(avail, (hi, p) => (p.kpr > hi.kpr ? p : hi), (c) => c.kpr >= 0.66);
  if (star) { star.role = "Star rifler"; avail.delete(star); }
  const entry = pickFrom(avail, (hi, p) => (p.fkPerMap > hi.fkPerMap ? p : hi), (c) => c.fkPerMap >= 2.4);
  if (entry) { entry.role = "Entry"; avail.delete(entry); }
  for (const p of avail) p.role = "Rifler";
}
function propTypeFor(role, hs) {
  if (role === "AWPer") return "kills or fantasy (NOT headshots — AWP kills aren't HS)";
  if (hs != null && hs >= 50 && role !== "Support/IGL") return "kills or headshots (rifle-heavy)";
  if (role === "Support/IGL") return "fantasy score (kills unreliable)";
  return "kills";
}
function leanFromRole(role) {
  if (role === "Support/IGL") return "UNDER-friendly";
  if (role === "Star rifler" || role === "AWPer" || role === "Entry" || role === "Rifler") return "OVER-friendly";
  return "neutral";
}

// Team discipline -> map shape. Opening-duel control + refrag discipline are the
// snowball seed; the trailing team's eco resilience decides if they can break it.
// Strong control vs weak resilience -> blowout (fewer rounds). Even + both resilient
// -> grind/OT (more rounds). Bounded; experimental, labeled, not price-validated.
function disciplineTilt(a, b) {
  const none = { delta: 0, blowoutRisk: null, otLean: null, controlEdge: null, controlBy: null };
  if (!a || !b || a.openingWin == null || b.openingWin == null) return none;
  const openingEdge = a.openingWin - b.openingWin;
  const tradeEdge = (a.tradePerRound != null && b.tradePerRound != null) ? clamp(a.tradePerRound - b.tradePerRound, -0.3, 0.3) : 0;
  const controlEdge = round2(openingEdge + 0.5 * tradeEdge);
  const controlBy = controlEdge >= 0 ? "A" : "B";
  const lead = Math.abs(controlEdge);
  let delta = 0, blowoutRisk = null, otLean = null;
  if (lead >= 0.10) {
    const underdogEco = controlEdge > 0 ? b.ecoWin : a.ecoWin;
    const resil = underdogEco == null ? 0.2 : underdogEco;     // weak eco -> snowball can't be broken
    const frac = 1 - clamp(resil / 0.35, 0, 1);
    delta = -clamp(lead, 0, 0.25) * 4 * frac;                  // up to ~ -1 round
    blowoutRisk = (frac >= 0.5 && lead >= 0.14) ? "HIGH" : "MED";
  } else if (lead < 0.05) {
    const bothEco = (a.ecoWin != null && b.ecoWin != null) ? (a.ecoWin + b.ecoWin) / 2 : null;
    if (bothEco != null && bothEco >= 0.25) { delta = 0.8; otLean = "YES"; }
  }
  return { delta: round1(delta), blowoutRisk, otLean, controlEdge, controlBy };
}
function roundVolume(match, beforeTs) {
  // Prefer official Valve World Ranking gap (a real strength signal) over the weak
  // inferred round-margin gap (R^2~0.01). Bigger gap -> more lopsided -> fewer rounds.
  const rk1 = rankingByTeam.get(match.team1?.id)?.rank;
  const rk2 = rankingByTeam.get(match.team2?.id)?.rank;
  const pt1 = rankingByTeam.get(match.team1?.id)?.points;
  const pt2 = rankingByTeam.get(match.team2?.id)?.points;
  let erounds, gap, ranked = false;
  if (rk1 != null && rk2 != null) {
    ranked = true;
    // continuous strength gap from Valve points (finer than integer rank); ~28 pts ≈ 1 rank step
    gap = (pt1 != null && pt2 != null) ? Math.abs(pt1 - pt2) / 28 : Math.abs(rk1 - rk2);
    erounds = Math.max(16, Math.min(26, CFG.LEAGUE_ROUNDS - 0.22 * Math.min(24, gap)));
  } else {
    const s1 = teamStrength(match.team1?.id, beforeTs);
    const s2 = teamStrength(match.team2?.id, beforeTs);
    gap = Math.abs(s1 - s2);
    erounds = Math.max(16, Math.min(26, CFG.LEAGUE_ROUNDS - 0.4 * gap));
  }
  // a large pistol-win-rate gap snowballs into shorter, more lopsided maps.
  const pa = roundsByTeam.get(match.team1?.id)?.pistolWin, pb = roundsByTeam.get(match.team2?.id)?.pistolWin;
  if (pa != null && pb != null) erounds = Math.max(15, erounds - 1.5 * Math.abs(pa - pb));
  // discipline / snowball tilt — trade discipline, opening-duel control and eco
  // resilience decide whether a map snowballs (blowout, fewer rounds) or grinds out
  // (resilient teams trade rounds -> OT, more rounds). This moves erounds, which
  // scales EVERY player's kills. Bounded + only fires with round data present.
  const dt = disciplineTilt(roundsByTeam.get(match.team1?.id), roundsByTeam.get(match.team2?.id));
  if (dt.delta) erounds = Math.max(15, Math.min(26, erounds + dt.delta));
  const otRate = pm.filter((x) => x.rounds > 24).length / Math.max(1, pm.length);
  const blowout = pm.filter((x) => x.rounds <= 17).length / Math.max(1, pm.length);
  // kill density — elimination-heavy teams produce more kills/round than defuse/time-expiry teams
  const ea = roundsByTeam.get(match.team1?.id)?.elimRate, eb = roundsByTeam.get(match.team2?.id)?.elimRate;
  const killDensity = (ea != null && eb != null) ? clamp(1 + 0.3 * ((ea + eb) / 2 - 0.55), 0.95, 1.06) : 1;
  return { erounds: round1(erounds), gap: round1(gap), otRate, blowout, ranked, killDensity: round2(killDensity),
    blowoutRisk: dt.blowoutRisk, otLean: dt.otLean, controlEdge: dt.controlEdge, controlBy: dt.controlBy };
}

// Round-by-round read (RESEARCH): pistol-round edge, CT/T side splits, and a totals
// lean. Pistol + ranking convergence -> snowball -> UNDER rounds; even pistols + close
// teams -> OVER. Unvalidated vs price — surfaced as a lean, not a pick.
function pct1(x) { return x == null ? null : Math.round(x * 100); }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function signedPct(x) { const v = Math.round(x * 100); return (v >= 0 ? "+" : "") + v + "%"; }
function roundRead(match, expMaps, vol) {
  const a = roundsByTeam.get(match.team1?.id);
  const b = roundsByTeam.get(match.team2?.id);
  const cts = (expMaps || []).map((m) => sideByMap.get(m)?.ctWin).filter((x) => x != null);
  const avgCt = cts.length ? mean(cts) : null;
  let pistolEdge = null, favPistol = null;
  if (a?.pistolWin != null && b?.pistolWin != null) {
    pistolEdge = round2(a.pistolWin - b.pistolWin);
    favPistol = pistolEdge >= 0 ? (match.team1?.name ?? "team A") : (match.team2?.name ?? "team B");
  }
  let totalsLean = "NEUTRAL", reason = "balanced pistols / strength";
  const gap = vol.gap ?? null;
  if (pistolEdge != null && Math.abs(pistolEdge) >= 0.12 && vol.ranked && gap != null && gap >= 4) {
    totalsLean = "UNDER"; reason = `pistol + ranking edge to ${favPistol} -> snowball / blowout risk`;
  } else if (pistolEdge != null && Math.abs(pistolEdge) < 0.06 && vol.ranked && gap != null && gap <= 2) {
    totalsLean = "OVER"; reason = "even pistols, close teams -> longer halves, more rounds";
  }
  // discipline / snowball can independently set the lean when it reads strongly
  const ctrlName = vol.controlBy === "A" ? (match.team1?.name ?? "team A") : (match.team2?.name ?? "team B");
  if (vol.blowoutRisk === "HIGH") { totalsLean = "UNDER"; reason = `${ctrlName} controls openings + trades vs weak eco resilience -> blowout risk, fewer rounds`; }
  else if (vol.otLean === "YES") { totalsLean = "OVER"; reason = "both teams trade well + eco-resilient -> rounds grind out, OT live"; }
  const splits = (t) => t ? { pistol: pct1(t.pistolWin), ct: pct1(t.ctWin), t: pct1(t.tWin),
    openingWin: t.openingWin == null ? null : Math.round(t.openingWin * 100),
    tradeRatio: t.tradeRatio ?? null,
    ecoWin: t.ecoWin == null ? null : Math.round(t.ecoWin * 100),
    snowball: t.snowball ?? null } : null;
  return { teamA: splits(a), teamB: splits(b), pistolEdge, favPistol, mapCtLean: avgCt == null ? null : Math.round(avgCt * 100),
    totalsLean, reason, blowoutRisk: vol.blowoutRisk, otLean: vol.otLean, controlEdge: vol.controlEdge, controlBy: vol.controlBy };
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

// ---------- forward slate (today's games) ----------
// A player's own team is in every one of their matches; opponents vary. So the
// team that appears most across their participations is their own team.
// Current team = argmax of appearances over the player's most RECENT matches only
// (short window), so a transfer/new org shows up fast instead of being outvoted by
// a long history with a former team. CS2 rosters churn constantly — this keeps up.
function argmaxTeam(pid, beforeTs, windowN = 6) {
  const hist = (playerMatches.get(pid) ?? []).filter((x) => x.ts < beforeTs)
    .sort((a, b) => b.ts - a.ts).slice(0, windowN);
  const cnt = new Map();
  for (const h of hist) for (const t of [h.t1, h.t2]) if (t != null) cnt.set(t, (cnt.get(t) || 0) + 1);
  let best = null, bc = -1;
  for (const [t, c] of cnt) if (c > bc) { bc = c; best = t; }
  return best;
}

// A team's last known lineup + churn signals: the 5 from their most recent match,
// which of them were NOT in the match before that (debut/transfer/stand-in), and
// how fresh the lineup is. CS2 lineups change often, so we surface all of it.
function lineupInfo(teamId, beforeTs) {
  const tmatches = [];
  for (const [mid, byNum] of mapsByMatch) {
    const m = matchById.get(mid); if (!m?.start_time) continue;
    const ts = Date.parse(m.start_time); if (ts >= beforeTs) continue;
    if (m.team1?.id === teamId || m.team2?.id === teamId) tmatches.push({ ts, byNum });
  }
  tmatches.sort((a, b) => b.ts - a.ts);
  if (!tmatches.length) return { pids: [], asOf: null, newPids: new Set() };
  const rosterOf = (byNum) => {
    const s = new Set();
    for (const n of [1, 2]) { const mm = byNum[n]; if (!mm) continue; for (const r of (mapStats.get(mm.id) ?? [])) { const pid = r.player?.id ?? r.player_id; if (pid != null && argmaxTeam(pid, beforeTs) === teamId) s.add(pid); } }
    return s;
  };
  const latest = rosterOf(tmatches[0].byNum);
  const prior = tmatches[1] ? rosterOf(tmatches[1].byNum) : new Set();
  const newPids = new Set([...latest].filter((p) => prior.size && !prior.has(p)));
  return { pids: [...latest], asOf: tmatches[0].ts, newPids };
}

// Prefer the official active roster; fall back to inferred last lineup.
function forwardRoster(teamId, beforeTs) {
  const official = rosterByTeam.get(teamId);
  if (official && official.length >= 4) return { pids: official.map((p) => p.id), source: "official", asOf: null, newPids: new Set() };
  return { ...lineupInfo(teamId, beforeTs), source: "inferred" };
}

// Expected Maps 1+2 from both teams' map pools: most-played maps neither permabans.
function expectedMapsForTeams(t1, t2, fallbackPids, beforeTs) {
  const p1 = mapPoolByTeam.get(t1), p2 = mapPoolByTeam.get(t2);
  if (p1 && p2) {
    const ban = new Set([...p1, ...p2].filter((x) => x.permaban).map((x) => x.map));
    const sc = new Map();
    for (const arr of [p1, p2]) for (const x of arr) { if (ban.has(x.map)) continue; sc.set(x.map, (sc.get(x.map) || 0) + (x.played || 0)); }
    const ranked = [...sc.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    if (ranked.length >= 2) return ranked.slice(0, 2);
  }
  return expectedMapsFor(fallbackPids, beforeTs);
}

// Pre-veto map estimate: the two maps these rosters have played most recently.
function expectedMapsFor(pids, beforeTs) {
  const set = new Set(pids), freq = new Map();
  for (const x of pm) { if (x.ts >= beforeTs || !set.has(x.playerId) || !x.map) continue; freq.set(x.map, (freq.get(x.map) || 0) + 1); }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([m]) => m);
}

async function runToday(date) {
  const { BdlCs2Client } = await import("./bdlClient.mjs");
  const client = new BdlCs2Client();
  const nowTs = Date.now();

  let cursor = null; const todays = [];
  do {
    const params = { dates: [date], per_page: 100 };
    if (cursor) params.cursor = cursor;
    const page = await client.request("/cs/v1/matches", params);
    todays.push(...(page.data ?? []));
    cursor = page.meta?.next_cursor ?? null;
  } while (cursor);

  const games = todays.filter((m) => (m.best_of ?? 0) >= 3); // Maps 1+2 markets are Bo3+
  const out = {
    ok: true, generatedAt: new Date().toISOString(), validated: false,
    source: "BDL CS2 today's slate + matchRead forward projection — PARTIAL, NOT validated vs price",
    matches: [],
  };

  for (const m of games) {
    const ro1 = m.team1?.id != null ? forwardRoster(m.team1.id, nowTs) : { pids: [], source: "none", asOf: null, newPids: new Set() };
    const ro2 = m.team2?.id != null ? forwardRoster(m.team2.id, nowTs) : { pids: [], source: "none", asOf: null, newPids: new Set() };
    const expMaps = expectedMapsForTeams(m.team1?.id, m.team2?.id, [...ro1.pids, ...ro2.pids], nowTs);
    const vol = roundVolume(m, nowTs);
    const build = (ro, teamName, oppId) => {
      const oppRank = rankingByTeam.get(oppId)?.rank ?? null;
      const profs = ro.pids.map((pid) => profile(pid, nowTs, expMaps)).filter(Boolean);
      assignRolesRelative(profs);
      return profs.map((p) => {
        const r = { team: teamName ?? null, ...computeRead(p, vol, { oppRank, oppId }) };
        if (ro.newPids.has(p.pid)) r.flags = [...(r.flags || []), "new to the lineup since their prior series — confirm they're starting (CS2 rosters churn: transfer/stand-in/bench)"];
        return r;
      });
    };
    const asOfTs = Math.max(ro1.asOf || 0, ro2.asOf || 0) || null;
    const rk = (tid) => rankingByTeam.get(tid)?.rank ?? null;
    out.matches.push({
      matchId: m.id,
      date: m.start_time?.slice(0, 10) ?? date,
      startTime: m.start_time ?? null,
      teamA: m.team1?.name ?? null,
      teamB: m.team2?.name ?? null,
      rankA: rk(m.team1?.id),
      rankB: rk(m.team2?.id),
      format: `Bo${m.best_of}`,
      tier: m.tournament?.tier ?? null,
      lan: !m.tournament?.is_online,
      stage: m.stage?.name ?? null,
      doOrDie: m.stage?.stage_type === "bracket",
      tournament: m.tournament?.name ?? null,
      maps: expMaps,
      rosterSource: (ro1.source === "official" && ro2.source === "official") ? "official" : ((ro1.source === "inferred" || ro2.source === "inferred") ? "inferred" : "mixed"),
      lineupAsOf: asOfTs ? new Date(asOfTs).toISOString().slice(0, 10) : null,
      rosterChanged: (ro1.newPids.size + ro2.newPids.size) > 0,
      roundVolume: { erounds: vol.erounds, blowout: vol.blowout, ot: vol.otRate, gap: vol.gap, killDensity: vol.killDensity, confidence: vol.ranked ? "MED · ranked" : "LOW" },
      roundRead: roundRead(m, expMaps, vol),
      players: [...build(ro1, m.team1?.name, m.team2?.id), ...build(ro2, m.team2?.name, m.team1?.id)],
    });
  }
  out.matches.sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.error(`✓ ${out.matches.length} game(s) for ${date} → ${OUT_PATH}`);
  for (const mm of out.matches) {
    const t = mm.startTime ? new Date(mm.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--";
    console.error(`   ${t}  ${mm.teamA} vs ${mm.teamB}  (${mm.players.length} players${mm.players.length ? "" : " — roster not in cache, pull more history"})`);
  }
}

function computeRead(p, vol, opp = {}) {
  const Etot = 2 * vol.erounds;                       // expected combined rounds
  let floor = Math.round(p.kprP.p20 * Etot);
  let median = Math.round(p.kprP.p50 * Etot);
  let ceiling = Math.round(p.kprP.p85 * Etot);

  // OPPONENT-STRENGTH ADJUSTMENT — research: opponent quality is the discriminator.
  // vs a top-10 side with a real elite sample, use the player's OWN elite-opp rate;
  // otherwise a bounded generic adjustment by opponent rank.
  let oppFactor = 1, oppNote = null;
  const oppRank = opp.oppRank;
  if (oppRank != null) {
    if (oppRank <= 10 && p.kprStrongN >= 3 && p.kpr > 0 && p.kprStrong != null) {
      oppFactor = clamp(p.kprStrong / p.kpr, 0.8, 1.2);
      oppNote = `vs top-${oppRank}: own elite-opp form (${signedPct(oppFactor - 1)})`;
    } else {
      oppFactor = clamp(1 - 0.006 * (15 - oppRank), 0.88, 1.12);
      oppNote = `vs #${oppRank}: ${signedPct(oppFactor - 1)}`;
    }
    floor = Math.round(floor * oppFactor);
    median = Math.round(median * oppFactor);
    ceiling = Math.round(ceiling * oppFactor);
  }
  // opening-duel ceiling shaping — winning openings -> survive to multi-frag.
  if (p.openingWin != null) ceiling = Math.round(ceiling * clamp(0.94 + 0.12 * p.openingWin, 0.94, 1.06));
  // clutch ability fattens the right tail (clutches are multi-kill situations)
  if (p.clutchPerMap) ceiling = Math.round(ceiling * clamp(1 + 0.05 * p.clutchPerMap, 1, 1.10));
  // kill density — elimination-heavy matchups produce more kills/round than defuse/time-expiry
  const kd = vol.killDensity ?? 1;
  if (kd !== 1) { floor = Math.round(floor * kd); median = Math.round(median * kd); ceiling = Math.round(ceiling * kd); }
  // keep the band coherent after all multiplicative shaping (floor <= median <= ceiling)
  floor = Math.min(floor, median); ceiling = Math.max(ceiling, median);

  // headshots Maps 1+2 = (adjusted) kills projection x the player's headshot share.
  const hsFrac = p.hs == null ? null : Math.max(0, Math.min(1, p.hs / 100));
  const hsFloor = hsFrac == null ? null : Math.round(floor * hsFrac);
  const hsMedian = hsFrac == null ? null : Math.round(median * hsFrac);
  const hsCeiling = hsFrac == null ? null : Math.round(ceiling * hsFrac);
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
  if (p.adr != null && p.adr >= 80 && p.kpr < 0.62) flags.push(`high ADR (${Math.round(p.adr)}) on modest KPR — impact > raw kills, kills can spike`);
  if (p.adr != null && p.adr < 70 && p.kpr >= 0.70) flags.push(`kills outrun ADR (${Math.round(p.adr)}) — cleanup-dependent, more volatile`);
  if (p.openingWin != null && p.openingShare > 0.12 && p.openingWin >= 0.55) flags.push(`wins openings ${Math.round(p.openingWin * 100)}% — survives to multi-frag`);
  if (p.openingWin != null && p.openingShare > 0.12 && p.openingWin <= 0.45) flags.push(`loses openings ${Math.round(p.openingWin * 100)}% — dies early, ceiling capped`);
  if (p.clutchPerMap != null && p.clutchPerMap >= 0.6) flags.push(`clutch threat (${round2(p.clutchPerMap)}/map) — fat right tail, ceiling live`);
  if (oppNote) flags.push(`opponent-adjusted ${oppNote}`);

  return {
    nick: p.nick,
    role: p.role,
    lean: leanFromRole(p.role),
    n: p.n,
    thin: p.n < CFG.THIN_N,
    kpr: round2(p.kpr),
    recentKpr: round2(p.recentKpr),
    hs: p.hs == null ? null : Math.round(p.hs),
    kast: p.kast == null ? null : Math.round(p.kast),
    fkPerMap: round1(p.fkPerMap),
    floor, median, ceiling,
    hsFloor, hsMedian, hsCeiling,
    adr: p.adr == null ? null : Math.round(p.adr),
    survival: p.survival == null ? null : Math.round(p.survival * 100),
    clutchPerMap: p.clutchPerMap == null ? null : round2(p.clutchPerMap),
    openingWin: p.openingWin == null ? null : Math.round(p.openingWin * 100),
    deathsPerMap: round1(p.dpr * vol.erounds),
    oppFactor: oppFactor === 1 ? null : round2(oppFactor),
    kprStrong: p.kprStrong == null ? null : round2(p.kprStrong),
    kprWeak: p.kprWeak == null ? null : round2(p.kprWeak),
    mapFitPct: p.mapFitRatio == null ? null : Math.round((p.mapFitRatio - 1) * 100),
    propType: propTypeFor(p.role, p.hs),
    score, band,
    partial: true, // score excludes opponent-style (15%) + line-value (10%)
    flags,
  };
}

function printRead(p, vol, opp) {
  const r = computeRead(p, vol, opp);
  const thin = r.thin ? "  ⚠THIN" : "";
  console.log(`\n${r.nick}   [${r.role}, ${r.lean}]   n=${r.n} maps${thin}`);
  console.log(`  KPR ${r.kpr} (recent ${r.recentKpr})  HS ${r.hs == null ? "?" : r.hs + "%"}  KAST ${r.kast == null ? "?" : r.kast + "%"}  FK/map ${r.fkPerMap}`);
  console.log(`  ADR ${r.adr ?? "?"}  survival ${r.survival == null ? "?" : r.survival + "%"}  opening-win ${r.openingWin == null ? "?" : r.openingWin + "%"}`);
  console.log(`  Map1&2 kills  floor ${r.floor} · median ${r.median} · ceiling ${r.ceiling}   map-fit ${r.mapFitPct == null ? "n/a" : (r.mapFitPct >= 0 ? "+" : "") + r.mapFitPct + "%"}${r.oppFactor ? "  opp×" + r.oppFactor : ""}`);
  console.log(`  Map1&2 HS  floor ${r.hsFloor ?? "?"} · median ${r.hsMedian ?? "?"} · ceiling ${r.hsCeiling ?? "?"}`);
  console.log(`  prop type: ${r.propType}`);
  console.log(`  pick score ${r.score}/100 → ${r.band}   [PARTIAL: excludes opponent-style 15% + line-value 10%]`);
  if (r.flags.length) for (const f of r.flags) console.log(`   ⚠ ${f}`);
}

// ---------- utils ----------
function pctl(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const i = (sortedAsc.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}
function canonMap(name) { return String(name || "").toLowerCase().replace(/^de_/, "").trim(); }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
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
