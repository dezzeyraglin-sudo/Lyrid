// Vercel serverless function — live click-to-analyze for a CS2 matchup.
// Deploy to: api/cs2/analyze.mjs   (route: GET /api/cs2/analyze?teamAId=&teamBId=&bestOf=)
//
// Given two team IDs (the frontend already has them from /api/cs2/schedule), this
// looks both teams up in the precomputed profile index (public/cs2_kpr_index.json,
// built by `matchRead.mjs --index`) and runs the SAME computeRead engine as the
// offline slate, returning a match object the CS2 tab renders with its normal cards.
//
// The engine functions below are copied verbatim from matchRead.mjs so a live read
// equals an offline one. The only intentional simplification: mapFitRatio comes from
// each team's own recent maps (the index can't know the opponent's veto), so the
// pick SCORE can differ slightly from a full pre-veto read — the floor/median/ceiling
// kill numbers (what you bet) are identical.

const LEAGUE_ROUNDS = 23.5; // keep in sync with matchRead CFG.LEAGUE_ROUNDS
const THIN_N = 10;

// ---- math helpers (from stats.mjs / matchRead.mjs) ----
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function pctl(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const i = (sortedAsc.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}

function leanFromRole(role) {
  if (role === "Support/IGL") return "UNDER-friendly";
  if (role === "Star rifler" || role === "AWPer" || role === "Entry" || role === "Rifler") return "OVER-friendly";
  return "neutral";
}
function propTypeFor(role, hs) {
  if (role === "AWPer") return "kills or fantasy (NOT headshots — AWP kills aren't HS)";
  if (hs != null && hs >= 50 && role !== "Support/IGL") return "kills or headshots (rifle-heavy)";
  if (role === "Support/IGL") return "fantasy score (kills unreliable)";
  return "kills";
}

// discipline -> map-shape tilt (copied verbatim from matchRead.mjs)
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
    const resil = underdogEco == null ? 0.2 : underdogEco;
    const frac = 1 - clamp(resil / 0.35, 0, 1);
    delta = -clamp(lead, 0, 0.25) * 4 * frac;
    blowoutRisk = (frac >= 0.5 && lead >= 0.14) ? "HIGH" : "MED";
  } else if (lead < 0.05) {
    const bothEco = (a.ecoWin != null && b.ecoWin != null) ? (a.ecoWin + b.ecoWin) / 2 : null;
    if (bothEco != null && bothEco >= 0.25) { delta = 0.8; otLean = "YES"; }
  }
  return { delta: round1(delta), blowoutRisk, otLean, controlEdge, controlBy };
}

// round volume from the two teams' stored strength inputs (mirrors roundVolume)
function volFromTeams(a, b, otRate, blowout) {
  let erounds, gap, ranked = false;
  if (a.rank != null && b.rank != null) {
    ranked = true;
    gap = (a.points != null && b.points != null) ? Math.abs(a.points - b.points) / 28 : Math.abs(a.rank - b.rank);
    erounds = Math.max(16, Math.min(26, LEAGUE_ROUNDS - 0.22 * Math.min(24, gap)));
  } else {
    gap = 0; // no inferred-strength fallback available server-side; assume competitive
    erounds = LEAGUE_ROUNDS;
  }
  if (a.pistolWin != null && b.pistolWin != null) erounds = Math.max(15, erounds - 1.5 * Math.abs(a.pistolWin - b.pistolWin));
  const dt = disciplineTilt(a, b);
  if (dt.delta) erounds = Math.max(15, Math.min(26, erounds + dt.delta));
  return { erounds: round1(erounds), gap: round1(gap), otRate, blowout, ranked, killDensity: 1,
    blowoutRisk: dt.blowoutRisk, otLean: dt.otLean, controlEdge: dt.controlEdge, controlBy: dt.controlBy };
}

// computeRead — copied verbatim from matchRead.mjs (the projection + band + flags)
function computeRead(p, vol, opp = {}, nMaps = 2) {
  const Etot = nMaps * vol.erounds;
  const [loP, hiP] = nMaps === 1 ? [0.08, 0.92] : [0.15, 0.88];
  let floor = Math.round(pctl(p.kprSorted, loP) * Etot);
  let median = Math.round(p.kprP.p50 * Etot);
  let ceiling = Math.round(pctl(p.kprSorted, hiP) * Etot);
  if (p.openingWin != null) ceiling = Math.round(ceiling * clamp(0.94 + 0.12 * p.openingWin, 0.94, 1.06));
  if (p.clutchPerMap) ceiling = Math.round(ceiling * clamp(1 + 0.05 * p.clutchPerMap, 1, 1.10));
  const kd = vol.killDensity ?? 1;
  if (kd !== 1) { floor = Math.round(floor * kd); median = Math.round(median * kd); ceiling = Math.round(ceiling * kd); }
  floor = Math.min(floor, median); ceiling = Math.max(ceiling, median);

  const hsFrac = p.hs == null ? null : Math.max(0, Math.min(1, p.hs / 100));
  const hsFloor = hsFrac == null ? null : Math.round(floor * hsFrac);
  const hsMedian = hsFrac == null ? null : Math.round(median * hsFrac);
  const hsCeiling = hsFrac == null ? null : Math.round(ceiling * hsFrac);

  const w = { roleStability: 0.15, mapFit: 0.20, roundVolume: 0.20, recentForm: 0.10, blowout: 0.10 };
  const active = Object.values(w).reduce((a, b) => a + b, 0);
  const sRole = 1 - Math.min(1, Math.abs(p.formDelta) / 0.25);
  const sMapFit = p.mapFitRatio == null ? 0.5 : Math.max(0, Math.min(1, p.mapFitRatio));
  const sVol = Math.max(0, Math.min(1, (vol.erounds - 16) / 10));
  const sForm = Math.max(0, Math.min(1, 0.5 + p.formDelta * 2));
  const sBlow = 1 - vol.blowout;
  const score = Math.round(100 * (w.roleStability * sRole + w.mapFit * sMapFit + w.roundVolume * sVol + w.recentForm * sForm + w.blowout * sBlow) / active);
  const band = score >= 80 ? "STRONG" : score >= 70 ? "LEAN" : "PASS";

  const flags = [];
  if (leanFromRole(p.role) === "OVER-friendly" && vol.blowout > 0.33) flags.push("over-friendly role but elevated blowout risk → ceiling capped");
  if (p.role === "Support/IGL") flags.push("support/IGL role → kill props fragile, prefer fantasy");
  if (p.mapFitRatio != null && p.mapFitRatio < 0.85) flags.push(`weak on expected maps (${Math.round((p.mapFitRatio - 1) * 100)}% vs avg)`);
  if (Math.abs(p.formDelta) > 0.12) flags.push(`recent role/form shift (KPR ${p.formDelta > 0 ? "+" : ""}${round2(p.formDelta)}) — season avg may mislead`);
  if (p.adr != null && p.adr >= 80 && p.kpr < 0.62) flags.push(`high ADR (${Math.round(p.adr)}) on modest KPR — impact > raw kills, kills can spike`);
  if (p.adr != null && p.adr < 70 && p.kpr >= 0.70) flags.push(`kills outrun ADR (${Math.round(p.adr)}) — cleanup-dependent, more volatile`);
  if (p.openingWin != null && p.openingShare > 0.12 && p.openingWin >= 0.55) flags.push(`wins openings ${Math.round(p.openingWin * 100)}% — survives to multi-frag`);
  if (p.openingWin != null && p.openingShare > 0.12 && p.openingWin <= 0.45) flags.push(`loses openings ${Math.round(p.openingWin * 100)}% — dies early, ceiling capped`);
  if (p.clutchPerMap != null && p.clutchPerMap >= 0.6) flags.push(`clutch threat (${round2(p.clutchPerMap)}/map) — fat right tail, ceiling live`);

  return {
    nick: p.nick, role: p.role, lean: leanFromRole(p.role), n: p.n, thin: p.n < THIN_N,
    kpr: round2(p.kpr), recentKpr: round2(p.recentKpr),
    hs: p.hs == null ? null : Math.round(p.hs), kast: p.kast == null ? null : Math.round(p.kast),
    fkPerMap: round1(p.fkPerMap), floor, median, ceiling, hsFloor, hsMedian, hsCeiling,
    adr: p.adr == null ? null : Math.round(p.adr),
    survival: p.survival == null ? null : Math.round(p.survival * 100),
    clutchPerMap: p.clutchPerMap == null ? null : round2(p.clutchPerMap),
    openingWin: p.openingWin == null ? null : Math.round(p.openingWin * 100),
    deathsPerMap: round1(p.dpr * vol.erounds),
    kprStrong: p.kprStrong == null ? null : round2(p.kprStrong),
    kprWeak: p.kprWeak == null ? null : round2(p.kprWeak),
    mapFitPct: p.mapFitRatio == null ? null : Math.round((p.mapFitRatio - 1) * 100),
    kprQ: Array.from({ length: 21 }, (_, i) => Math.round(pctl(p.kprSorted, i / 20) * 1000) / 1000),
    etot: Math.round(Etot * 10) / 10,
    propType: propTypeFor(p.role, p.hs), score, band, partial: true, flags,
  };
}

// ---- module-scoped index cache (warm across invocations on a hot lambda) ----
let INDEX = null, INDEX_AT = 0;
async function loadIndex(origin) {
  if (INDEX && Date.now() - INDEX_AT < 10 * 60 * 1000) return INDEX;
  const r = await fetch(`${origin}/cs2_kpr_index.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`index ${r.status}`);
  INDEX = await r.json(); INDEX_AT = Date.now();
  return INDEX;
}

export default async function handler(req, res) {
  const q = req.query || {};
  const teamAId = q.teamAId != null ? String(q.teamAId) : null;
  const teamBId = q.teamBId != null ? String(q.teamBId) : null;
  const bestOf = Number(q.bestOf) || 3;
  if (!teamAId || !teamBId) return res.status(400).json({ error: "teamAId and teamBId are required" });

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const origin = `${proto}://${host}`;

  let index;
  try { index = await loadIndex(origin); }
  catch (e) { return res.status(502).json({ error: "could not load profile index", detail: String(e).slice(0, 150) }); }

  const A = index.teams?.[teamAId], B = index.teams?.[teamBId];
  const missing = [];
  if (!A) missing.push(q.teamA || teamAId);
  if (!B) missing.push(q.teamB || teamBId);
  if (missing.length) {
    return res.status(200).json({
      analyzable: false,
      reason: `not enough match history to project: ${missing.join(", ")}`,
      missing,
    });
  }

  const vol = volFromTeams(A, B, index.leagueOtRate ?? 0.12, index.leagueBlowout ?? 0.18);
  const nMaps = bestOf === 1 ? 1 : 2;
  const newA = new Set(A.newPids || []), newB = new Set(B.newPids || []);
  const build = (T, newSet) => (T.profiles || []).map((p) => {
    const r = { team: T.name ?? null, ...computeRead(p, vol, {}, nMaps) };
    if (newSet.has(p.pid)) r.flags = [...(r.flags || []), "new to the lineup since their prior series — confirm they're starting (CS2 rosters churn)"];
    return r;
  });
  const players = [...build(A, newA), ...build(B, newB)];

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  return res.status(200).json({
    matchId: q.matchId ? Number(q.matchId) : null,
    teamA: A.name ?? null, teamB: B.name ?? null, rankA: A.rank ?? null, rankB: B.rank ?? null,
    format: `Bo${bestOf}`, mapWindow: nMaps, windowLabel: nMaps === 1 ? "Map 1" : "Maps 1+2",
    rosterSource: (A.rosterSource === "official" && B.rosterSource === "official") ? "official" : "inferred",
    lineupAsOf: A.lineupAsOf || B.lineupAsOf || null,
    generatedAt: index.generatedAt ?? null,
    roundVolume: { erounds: vol.erounds, blowout: vol.blowout, ot: vol.otRate, gap: vol.gap, killDensity: vol.killDensity, confidence: vol.ranked ? "MED · ranked" : "LOW" },
    players, source: "live",
  });
}
