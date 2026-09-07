// api/_lib/nba/espnClient.js
//
// ESPN unofficial-API client for the Lyrid NBA data layer.
// Free, no key. Node 20 ESM (global fetch). Mirrors the WNBA bdlFeed drop-in.
//
// Robustness: box score and gamelog stats arrive as positional arrays paired
// with an ESPN-supplied `keys`/`names` array. We map by NAME, not by hardcoded
// index, so a column reorder on ESPN's side can't silently corrupt output.
//
// Endpoints (all public, no auth) — live-verified:
//   scoreboard : site.api.espn.com    /apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD
//   summary    : site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={id}
//   injuries   : site.api.espn.com    /apis/site/v2/sports/basketball/nba/injuries
//   gamelog    : site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/gamelog

const SITE   = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const WEB    = 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba';
const COMMON = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';

const UA = 'curl/8.5.0';  // ESPN blocks browser-like UAs; curl passes (verified)
const DEFAULT_TIMEOUT = 12000;

// ---------------- low-level fetch ----------------
async function espnGet(url, { timeout = DEFAULT_TIMEOUT, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`ESPN ${res.status} ${url}`); continue; }
      return await res.json();
    } catch (e) { clearTimeout(timer); lastErr = e; }
  }
  throw lastErr;
}

// ---------------- helpers ----------------
function num(v, d = null) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function splitPair(s) {                    // "8-18" -> { made:8, att:18 }
  if (typeof s !== 'string' || !s.includes('-')) return { made: null, att: null };
  const [m, a] = s.split('-');
  return { made: num(m), att: num(a) };
}

function parseMinutes(v) {                  // "40" or "40:00"
  if (v == null) return null;
  const s = String(v);
  return s.includes(':') ? num(s.split(':')[0]) : num(s);
}

function pct(made, att) { return att > 0 ? made / att : null; }

function tsPct(pts, fga, fta) {             // TS% = PTS / (2 * (FGA + 0.44*FTA))
  const denom = 2 * ((fga || 0) + 0.44 * (fta || 0));
  return denom > 0 ? pts / denom : null;
}

function parseSpreadDetails(details) {       // "TOR -4.5" -> { favAbbr, spread }
  if (typeof details !== 'string') return { favAbbr: null, spread: null };
  const m = details.match(/([A-Z]{2,4})\s*(-?\d+(?:\.\d+)?)/);
  return m ? { favAbbr: m[1], spread: num(m[2]) } : { favAbbr: null, spread: null };
}

function mapStats(keys, stats) {             // positional stats[] -> named object
  const o = {};
  (keys || []).forEach((k, i) => { o[k] = stats?.[i]; });
  return o;
}

// Some endpoints (e.g. /injuries) omit athlete.id and only expose it inside the
// player-card link href: ".../player/_/id/4712863/name". Fall back to that.
function athleteIdFrom(ath) {
  if (!ath) return null;
  if (ath.id != null) return String(ath.id);
  const href = (ath.links || []).map(l => l && l.href).find(h => /\/id\/\d+/.test(h || ''));
  const m = href && href.match(/\/id\/(\d+)/);
  return m ? m[1] : null;
}

// availability classifier for the injury feed (factors 3 & 4)
export function isAvailable(status) {
  if (!status) return true;
  const s = String(status).toLowerCase();
  if (s.includes('out') || s.includes('doubtful') || s.includes('suspend')) return false;
  return true; // day-to-day / questionable / probable -> assume active, flagged
}

// ---------------- box score ----------------
function normalizeBoxPlayer(raw, teamAbbr, keys) {
  const s   = mapStats(keys, raw.stats);
  const fg  = splitPair(s['fieldGoalsMade-fieldGoalsAttempted']);
  const fg3 = splitPair(s['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
  const ft  = splitPair(s['freeThrowsMade-freeThrowsAttempted']);
  const pts = num(s.points);
  return {
    id: raw.athlete?.id ?? null,
    name: raw.athlete?.displayName ?? null,
    pos: raw.athlete?.position?.abbreviation ?? null,
    team: teamAbbr,
    active: raw.active ?? null,
    starter: raw.starter ?? null,
    dnp: raw.didNotPlay ?? false,
    reason: raw.reason ?? null,
    min: parseMinutes(s.minutes),
    pts,
    fgm: fg.made, fga: fg.att,
    fg3m: fg3.made, fg3a: fg3.att,
    // --- FTA carry-over fix: surfaced explicitly ---
    fta: ft.att, ftm: ft.made, ftPct: pct(ft.made, ft.att),
    twoPa: fg.att != null && fg3.att != null ? fg.att - fg3.att : null,
    twoPm: fg.made != null && fg3.made != null ? fg.made - fg3.made : null,
    reb: num(s.rebounds), oreb: num(s.offensiveRebounds), dreb: num(s.defensiveRebounds),
    ast: num(s.assists), tov: num(s.turnovers), stl: num(s.steals),
    blk: num(s.blocks), pf: num(s.fouls), plusMinus: num(s.plusMinus),
    tsPct: tsPct(pts, fg.att, ft.att),
  };
}

function normalizePlayers(sm) {
  const out = [];
  for (const tb of sm?.boxscore?.players || []) {
    const abbr = tb.team?.abbreviation ?? null;
    const block = (tb.statistics || [])[0] || {};
    for (const a of block.athletes || []) out.push(normalizeBoxPlayer(a, abbr, block.keys || []));
  }
  return out;
}

// ---------------- lines (DraftKings via ESPN pickcenter) ----------------
function normalizeLines(sm) {
  const pc = sm?.pickcenter || sm?.odds || [];
  if (!pc.length) return null;
  const dk = pc.find(o => (o.provider?.name || '').toLowerCase().includes('draftkings')) || pc[0];
  const { favAbbr, spread } = parseSpreadDetails(dk.details);
  return {
    provider: dk.provider?.name ?? null,
    details: dk.details ?? null,
    favAbbr, spread,
    total: num(dk.overUnder),
  };
}

// ---------------- shot coordinates ----------------
function normalizeShots(sm) {
  const shots = [];
  for (const p of sm?.plays || []) {
    if (!p.shootingPlay) continue;
    const c = p.coordinate || {};
    shots.push({
      shooterId: p.participants?.[0]?.athlete?.id ?? null,
      assisterId: p.participants?.[1]?.athlete?.id ?? null,
      teamId: p.team?.id ?? null,
      made: !!p.scoringPlay,
      value: num(p.scoreValue),               // 1 / 2 / 3
      x: num(c.x), y: num(c.y),
      period: typeof p.period === 'object' ? num(p.period?.number) : num(p.period),
      text: p.text ?? null,
    });
  }
  return shots;
}

function normalizeSummaryInjuries(sm) {
  const out = [];
  for (const g of sm?.injuries || []) {
    for (const it of g.injuries || []) {
      out.push({
        team: g.team?.abbreviation ?? g.displayName ?? null,
        athleteId: athleteIdFrom(it.athlete),
        name: it.athlete?.displayName ?? null,
        status: it.status ?? null,
      });
    }
  }
  return out;
}

// ================= PUBLIC API =================

// One fetch -> everything the engine needs from a game.
export async function fetchGameSummary(eventId) {
  const sm = await espnGet(`${WEB}/summary?event=${eventId}`);
  return {
    eventId: String(eventId),
    status: sm?.header?.competitions?.[0]?.status?.type?.name
         ?? (sm?.boxscore ? 'available' : null),
    players: normalizePlayers(sm),
    lines: normalizeLines(sm),
    shots: normalizeShots(sm),
    injuries: normalizeSummaryInjuries(sm),
  };
}

// Thin wrappers (pass a cached summary to avoid re-fetching).
export async function fetchBoxScore(eventId, summary) { return (summary ?? await fetchGameSummary(eventId)).players; }
export async function fetchGameLines(eventId, summary) { return (summary ?? await fetchGameSummary(eventId)).lines; }
export async function fetchShotChart(eventId, summary) { return (summary ?? await fetchGameSummary(eventId)).shots; }

export async function fetchSchedule(dateYYYYMMDD) {
  const url = dateYYYYMMDD ? `${SITE}/scoreboard?dates=${dateYYYYMMDD}` : `${SITE}/scoreboard`;
  const sb = await espnGet(url);
  return (sb?.events || []).map(ev => {
    const comp = ev.competitions?.[0] || {};
    const cs = comp.competitors || [];
    const home = cs.find(c => c.homeAway === 'home') || {};
    const away = cs.find(c => c.homeAway === 'away') || {};
    const odds = (comp.odds || [])[0] || {};
    const { favAbbr, spread } = parseSpreadDetails(odds.details);
    return {
      eventId: ev.id,
      date: ev.date,
      status: comp.status?.type?.name ?? null,
      home: { id: home.team?.id ?? null, abbr: home.team?.abbreviation ?? null, score: num(home.score) },
      away: { id: away.team?.id ?? null, abbr: away.team?.abbreviation ?? null, score: num(away.score) },
      favAbbr, spread, total: num(odds.overUnder),
    };
  });
}

// League-wide injuries -> flat list (factors 3 & 4).
export async function fetchInjuries() {
  const data = await espnGet(`${SITE}/injuries`);
  const out = [];
  for (const g of data?.injuries || []) {
    for (const it of g.injuries || []) {
      out.push({
        teamId: g.id ?? null,
        team: it.athlete?.team?.abbreviation ?? g.displayName ?? null,
        athleteId: athleteIdFrom(it.athlete),
        name: it.athlete?.displayName ?? null,
        status: it.status ?? null,                       // 'Out' | 'Day-To-Day' | ...
        available: isAvailable(it.status),
        type: it.type?.description ?? it.type?.name ?? null,
        detail: it.shortComment ?? null,
        date: it.date ?? null,
      });
    }
  }
  return out;
}

// athleteId -> availability, for quick pre-game gating.
export async function injuryIndex() {
  const list = await fetchInjuries();
  const idx = {};
  for (const i of list) if (i.athleteId != null) idx[String(i.athleteId)] = i;
  return idx;
}

// Per-game log, newest first (recent form + shot-profile source).
export async function fetchPlayerGameLog(athleteId, { regularSeasonOnly = true } = {}) {
  const gl = await espnGet(`${COMMON}/athletes/${athleteId}/gamelog`);
  const names = gl?.names || [];
  const meta  = gl?.events || {};
  const rows = [];
  for (const st of gl?.seasonTypes || []) {
    for (const cat of st.categories || []) {
      for (const e of cat.events || []) {
        const s   = mapStats(names, e.stats);
        const m   = meta[String(e.eventId)] || {};
        const fg  = splitPair(s['fieldGoalsMade-fieldGoalsAttempted']);
        const fg3 = splitPair(s['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
        const ft  = splitPair(s['freeThrowsMade-freeThrowsAttempted']);
        rows.push({
          eventId: String(e.eventId),
          date: m.gameDate ?? null,
          opponent: m.opponent?.abbreviation ?? null,
          homeAway: m.atVs === '@' ? 'away' : m.atVs === 'vs' ? 'home' : null,
          seasonType: st.displayName ?? null,
          min: parseMinutes(s.minutes),
          pts: num(s.points),
          fgm: fg.made, fga: fg.att,
          fg3m: fg3.made, fg3a: fg3.att,
          fta: ft.att, ftm: ft.made, ftPct: pct(ft.made, ft.att),
          twoPa: fg.att != null && fg3.att != null ? fg.att - fg3.att : null,
          twoPm: fg.made != null && fg3.made != null ? fg.made - fg3.made : null,
          reb: num(s.totalRebounds), ast: num(s.assists),
          blk: num(s.blocks), stl: num(s.steals), tov: num(s.turnovers), pf: num(s.fouls),
        });
      }
    }
  }
  // exclude preseason + postseason from the recency window (regime discipline: never
  // pool playoffs with regular season). Off-season, this pulls last season's final
  // regular-season games instead of the playoffs — the right prior for an opener.
  let out = rows;
  if (regularSeasonOnly) {
    const reg = rows.filter((r) => /regular season/i.test(r.seasonType || ''));
    if (reg.length) out = reg; // fall back to all rows only if no regular-season games exist
  }
  out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return out;
}

// Player vs a specific opponent — returns the aggregate + n + thin flag.
// (Shrink-toward-baseline weighting lives in the nbaPlayerVsOpponent module.)
export async function fetchPlayerVsOpponent(athleteId, oppAbbr, { minGames = 3, gameLog } = {}) {
  const rows = gameLog ?? await fetchPlayerGameLog(athleteId);
  const vs = rows.filter(r => r.opponent === oppAbbr && r.min != null);
  const n = vs.length;
  const mean = k => (n ? vs.reduce((s, r) => s + (r[k] || 0), 0) / n : null);
  return {
    opponent: oppAbbr, n,
    thin: n < minGames,                    // surfaced, never faked as signal
    ptsAvg: mean('pts'), minAvg: mean('min'),
    fgaAvg: mean('fga'), fg3aAvg: mean('fg3a'), ftaAvg: mean('fta'),
    games: vs,
  };
}

// Shots-to-clear input profile: per-minute attempt rates, pooled make rates,
// and a minutes mean/std/CV — computed from the last N played games.
export function buildShotProfile(rows, { lastN = 15 } = {}) {
  const played = (rows || []).filter(r => r.min && r.min > 0).slice(0, lastN);
  const g = played.length;
  if (!g) return { games: 0, insufficient: true };
  const sum = k => played.reduce((s, r) => s + (r[k] || 0), 0);
  const totMin = sum('min');
  const rate = t => (totMin > 0 ? t / totMin : null);
  const mins = played.map(r => r.min);
  const mMean = totMin / g;
  const mStd = Math.sqrt(mins.reduce((s, m) => s + (m - mMean) ** 2, 0) / g);
  return {
    games: g,
    minutes: { mean: mMean, std: mStd, cv: mMean > 0 ? mStd / mMean : null },
    twoPaPerMin: rate(sum('twoPa')),
    threePaPerMin: rate(sum('fg3a')),
    ftaPerMin: rate(sum('fta')),
    rebPerMin: rate(sum('reb')),
    astPerMin: rate(sum('ast')),
    twoPct: pct(sum('twoPm'), sum('twoPa')),
    threePct: pct(sum('fg3m'), sum('fg3a')),
    ftPct: pct(sum('ftm'), sum('fta')),
    insufficient: g < 5,
  };
}
