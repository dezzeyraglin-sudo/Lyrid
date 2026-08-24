// api/_lib/nba/bbrefClient.js
//
// basketball-reference client for the Lyrid NBA data layer.
// Free scrape, no key. Node 20 ESM. Dependency-free (regex parsing).
//
// Surfaces the audit-validated driver stats ESPN box scores don't compute:
//   player : USG%, AST%, TRB/ORB/DRB%, TS%, FTr (whistle floor), 3PA-rate, MP/GS
//   team   : pace, ORtg/DRtg, and opponent-ALLOWED FG% / 3PA-rate / rebounding
//
// Cost/rate-limit: the whole league comes in TWO page fetches (all players in one
// table, all teams in another), cached per-season in-process. bbref rate-limits
// hard (~20 req/min) — so fetch season tables once and read from cache, never
// per-player. HTML comments are stripped on fetch so comment-wrapped tables parse.

const BASE = 'https://www.basketball-reference.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DEFAULT_TIMEOUT = 15000;

const _cache = new Map(); // key -> parsed payload

// bbref uses a few non-standard team abbreviations; map to the ESPN/standard set.
const TEAM_ALIAS = { BRK: 'BKN', CHO: 'CHA', PHO: 'PHX' };
// League/opponent tables label teams by full name, not abbreviation.
const NAME_TO_ABBR = {
  'atlanta hawks': 'ATL', 'boston celtics': 'BOS', 'brooklyn nets': 'BKN',
  'charlotte hornets': 'CHA', 'chicago bulls': 'CHI', 'cleveland cavaliers': 'CLE',
  'dallas mavericks': 'DAL', 'denver nuggets': 'DEN', 'detroit pistons': 'DET',
  'golden state warriors': 'GSW', 'houston rockets': 'HOU', 'indiana pacers': 'IND',
  'la clippers': 'LAC', 'los angeles clippers': 'LAC', 'los angeles lakers': 'LAL',
  'memphis grizzlies': 'MEM', 'miami heat': 'MIA', 'milwaukee bucks': 'MIL',
  'minnesota timberwolves': 'MIN', 'new orleans pelicans': 'NOP', 'new york knicks': 'NYK',
  'oklahoma city thunder': 'OKC', 'orlando magic': 'ORL', 'philadelphia 76ers': 'PHI',
  'phoenix suns': 'PHX', 'portland trail blazers': 'POR', 'sacramento kings': 'SAC',
  'san antonio spurs': 'SAS', 'toronto raptors': 'TOR', 'utah jazz': 'UTA',
  'washington wizards': 'WAS',
};
const KNOWN_ABBR = new Set(Object.values(NAME_TO_ABBR));
const stdTeam = (t) => TEAM_ALIAS[t] || t;
// resolve either an abbreviation or a full team name to a standard abbreviation
function resolveTeam(raw) {
  const s = String(raw || '').replace(/\*$/, '').trim();
  if (KNOWN_ABBR.has(stdTeam(s))) return stdTeam(s);
  const byName = NAME_TO_ABBR[s.toLowerCase()];
  return byName || (KNOWN_ABBR.has(stdTeam(s)) ? stdTeam(s) : null);
}

// ---------------- fetch ----------------
async function bbrefGet(path, { timeout = DEFAULT_TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`bbref ${res.status} ${path}`);
    const html = await res.text();
    // un-hide comment-wrapped tables so every table is parseable
    return html.replace(/<!--/g, '').replace(/-->/g, '');
  } finally { clearTimeout(timer); }
}

// ---------------- helpers ----------------
function num(v, d = null) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim(); }

// normalized join key so bbref names match ESPN names (accents, punctuation, suffixes)
export function nameKey(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Extract a table by id and return its <tbody> rows as {data-stat: text} objects.
function parseTable(html, tableId) {
  const tblRe = new RegExp(`<table[^>]*id="${tableId}"[^>]*>([\\s\\S]*?)</table>`);
  const tbl = html.match(tblRe);
  if (!tbl) return [];
  const body = tbl[1].match(/<tbody>([\s\S]*?)<\/tbody>/);
  const scope = body ? body[1] : tbl[1];
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(scope))) {
    const tr = m[1];
    if (/class="[^"]*thead/.test(tr) || !/data-stat/.test(tr)) continue; // skip header/separator rows
    const cells = {};
    const cellRe = /<t[dh][^>]*data-stat="([^"]+)"[^>]*>([\s\S]*?)<\/t[dh]>/g;
    let c;
    while ((c = cellRe.exec(tr))) cells[c[1]] = stripTags(c[2]);
    if (Object.keys(cells).length) rows.push(cells);
  }
  return rows;
}

// ================= PUBLIC API =================

// All players' advanced rate stats for a season. Deduped to one row per player
// (prefers the combined multi-team row for players who were traded).
export async function fetchPlayerAdvanced(season) {
  const ck = `adv:${season}`;
  if (_cache.has(ck)) return _cache.get(ck);
  const html = await bbrefGet(`/leagues/NBA_${season}_advanced.html`);
  const rows = parseTable(html, 'advanced');
  const byKey = new Map();
  for (const r of rows) {
    const name = r.name_display;
    if (!name) continue;
    const team = r.team_name_abbr || r.team_id || '';
    const combined = /^\dTM$|^TOT$/.test(team);
    const rec = {
      name,
      nameKey: nameKey(name),
      team: combined ? null : stdTeam(team),
      combinedSeason: combined,
      pos: r.pos || null,
      g: num(r.games), gs: num(r.games_started), mp: num(r.mp),
      usgPct: num(r.usg_pct),
      astPct: num(r.ast_pct),
      trbPct: num(r.trb_pct), orbPct: num(r.orb_pct), drbPct: num(r.drb_pct),
      tsPct: num(r.ts_pct),
      ftr: num(r.fta_per_fga_pct),        // FTA/FGA — the whistle-floor driver
      fg3aRate: num(r.fg3a_per_fga_pct),  // 3PA/FGA — jump-shooter / variance profile
    };
    const prev = byKey.get(rec.nameKey);
    // prefer combined-season row (stable full-season rates) when a player has several
    if (!prev || (combined && !prev.combinedSeason)) byKey.set(rec.nameKey, rec);
  }
  const out = { season, players: [...byKey.values()], byKey };
  _cache.set(ck, out);
  return out;
}

// Team context: pace, ratings, and opponent-ALLOWED shooting/rebounding.
// Returns a map keyed by standard team abbreviation.
export async function fetchTeamContext(season) {
  const ck = `team:${season}`;
  if (_cache.has(ck)) return _cache.get(ck);
  const html = await bbrefGet(`/leagues/NBA_${season}.html`);
  const adv = parseTable(html, 'advanced-team');   // pace, off/def rtg, efg, opp_efg
  const opp = parseTable(html, 'per_game-opponent'); // what each team ALLOWS, per game

  const teams = {};
  for (const r of adv) {
    const t = resolveTeam(r.team);
    if (!t) continue;
    teams[t] = {
      team: t,
      pace: num(r.pace),
      offRtg: num(r.off_rtg), defRtg: num(r.def_rtg), netRtg: num(r.net_rtg),
      efgPct: num(r.efg_pct), oppEfgPct: num(r.opp_efg_pct),
      fg3aRate: num(r.fg3a_per_fga_pct),   // this team's own 3PA rate
    };
  }
  for (const r of opp) {
    const t = resolveTeam(r.team);
    if (!t || !teams[t]) continue;
    const g = num(r.g) || 1;
    Object.assign(teams[t], {
      // per-game "allowed" figures -> what a player's matchup concedes
      oppFgPct: num(r.opp_fg_pct),          // soft (high) vs tough (low) defense
      oppFg3aPerG: num(r.opp_fg3a),         // opp 3PA volume -> long-miss / rebound env
      oppFg3Pct: num(r.opp_fg3_pct),
      oppPtsPerG: num(r.opp_pts),
      oppDrbPerG: num(r.opp_drb), oppOrbPerG: num(r.opp_orb), oppTrbPerG: num(r.opp_trb),
      oppFg3aRate: num(r.opp_fg3a) != null && num(r.opp_fga) ? num(r.opp_fg3a) / num(r.opp_fga) : null,
    });
  }
  const out = { season, teams };
  _cache.set(ck, out);
  return out;
}

// Convenience: merge a player's advanced rates + their matchup opponent's context
// into one object the engine/factors can read directly.
export async function fetchPlayerContext(season, playerName, opponentAbbr) {
  const [{ byKey }, { teams }] = await Promise.all([
    fetchPlayerAdvanced(season),
    fetchTeamContext(season),
  ]);
  const p = byKey.get(nameKey(playerName)) || null;
  const opp = opponentAbbr ? teams[stdTeam(opponentAbbr)] || null : null;
  return {
    player: p,
    opponent: opp,
    // driver-ready reads
    usageFunnel: p?.usgPct ?? null,
    whistleFloor: p?.ftr ?? null,           // high FTr -> over floor; low -> under (no cushion)
    reboundEquity: p?.trbPct ?? null,
    jumpShooterProfile: p?.fg3aRate ?? null, // high -> more shooting variance (wing-PRA flag)
    oppDefense: opp ? { defRtg: opp.defRtg, oppFgPct: opp.oppFgPct } : null,
    reboundEnvironment: opp ? { oppFg3aPerG: opp.oppFg3aPerG, oppFg3aRate: opp.oppFg3aRate } : null,
    pace: opp?.pace ?? null,
    _found: { player: !!p, opponent: !!opp }, // surfaced for dataCompleteness, never faked
  };
}
