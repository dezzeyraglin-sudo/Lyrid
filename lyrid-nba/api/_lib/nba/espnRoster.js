// api/_lib/nba/espnRoster.js
//
// Current-team resolution for the NBA data layer. THE offseason-signing fix:
// a player's team comes from the live roster feed, never from a season-cumulative
// stat row (bbref) or a historical game log, which still say his OLD team.
//
// Nightly-cache pattern: buildRosterIndex() is ~1 call per team plus a ref
// resolution per player (~550 calls for the league). Run it on a cron, cache the
// { byNameKey, byId } result to KV/Supabase, and let the merge read from cache.
// For a single known player, fetchAthlete(id) is one authoritative call.

const SITE   = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const COMMONV3 = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';
const CORE   = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

async function get(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`ESPN ${res.status} ${url}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

export function nameKey(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// ESPN's NBA team ids are stable; hardcoding avoids the /teams endpoint (which 403s
// server-side) and is more reliable for a serverless function.
const ID_TO_ABBR = {
  '1':'ATL','2':'BOS','3':'NOP','4':'CHI','5':'CLE','6':'DAL','7':'DEN','8':'DET',
  '9':'GSW','10':'HOU','11':'IND','12':'LAC','13':'LAL','14':'MIA','15':'MIL','16':'MIN',
  '17':'BKN','18':'NYK','19':'ORL','20':'PHI','21':'PHX','22':'POR','23':'SAC','24':'SAS',
  '25':'OKC','26':'UTA','27':'WAS','28':'TOR','29':'MEM','30':'CHA',
};
export function fetchTeamsMap() {
  const abbrToId = {};
  for (const [id, abbr] of Object.entries(ID_TO_ABBR)) abbrToId[abbr] = id;
  return { idToAbbr: ID_TO_ABBR, abbrToId };
}

// single player's CURRENT team (authoritative). Reflects offseason signings.
export async function fetchAthlete(athleteId) {
  const d = await get(`${COMMONV3}/athletes/${athleteId}`);
  const ath = d?.athlete || d;
  const team = ath?.team || {};
  return {
    id: String(ath?.id ?? athleteId),
    name: ath?.displayName ?? null,
    nameKey: nameKey(ath?.displayName),
    team: team.abbreviation ?? null,     // <- current team
    teamId: team.id ?? null,
    pos: ath?.position?.abbreviation ?? null,
    status: ath?.status?.type ?? ath?.status?.name ?? null,
  };
}

// current roster for one team. season = upcoming NBA season year (e.g. 2027).
export async function fetchTeamRoster(teamId, season, teamAbbr) {
  const list = await get(`${CORE}/seasons/${season}/teams/${teamId}/athletes?limit=60`);
  const refs = (list?.items || []).map(i => i.$ref).filter(Boolean);
  const players = [];
  for (const ref of refs) {
    try {
      const a = await get(ref.replace(/^http:/, 'https:'));
      players.push({
        id: String(a.id),
        name: a.displayName ?? `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim(),
        nameKey: nameKey(a.displayName ?? `${a.firstName ?? ''} ${a.lastName ?? ''}`),
        team: teamAbbr ?? null,           // known from the team we're iterating
        teamId: String(teamId),
        pos: a.position?.abbreviation ?? null,
      });
    } catch { /* skip a bad ref, keep going */ }
  }
  return players;
}

// leaguewide current-team index. Run on a cron; cache the result.
export async function buildRosterIndex(season) {
  const { idToAbbr } = fetchTeamsMap();
  const byNameKey = {}, byId = {};
  for (const [teamId, abbr] of Object.entries(idToAbbr)) {
    const roster = await fetchTeamRoster(teamId, season, abbr);
    for (const p of roster) { byNameKey[p.nameKey] = p; byId[p.id] = p; }
  }
  return { season, byNameKey, byId, teams: idToAbbr };
}
