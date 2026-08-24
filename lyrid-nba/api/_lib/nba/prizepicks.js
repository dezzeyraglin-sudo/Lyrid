// api/_lib/nba/prizepicks.js
//
// PrizePicks line client (NBA). The partner API key stays server-side; the public
// api.prizepicks.com host 403s from Vercel (Cloudflare), so pass the partner base
// URL + key via env. Standard lines only: demon/goblin are flagged alt-only and
// must NOT be bet — same rule the app enforces on lineStatus.

const DEFAULTS = {
  apiBase: process.env.PP_PARTNER_BASE || 'https://partner-api.prizepicks.com',
  apiKey: process.env.PP_PARTNER_KEY || null,
  leagueId: Number(process.env.PP_NBA_LEAGUE_ID || 7), // NBA = 7 on PrizePicks — verify per partner docs
};

// PrizePicks stat_type -> engine market key
const STAT_MARKET = {
  'Points': 'points',
  'Rebounds': 'rebounds',
  'Assists': 'assists',
  'Pts+Rebs+Asts': 'pra',
  'Pts+Rebs': 'pts_rebs',
  'Pts+Asts': 'pts_asts',
  'Rebs+Asts': 'rebs_asts',
  '3-PT Made': 'threes',
  'Fantasy Score': 'fantasy',
};

function nameKey(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

// odds_type -> our lineStatus vocabulary (app: goblin/demon/shaded/wrongline = no bet)
function lineStatusOf(oddsType) {
  const t = String(oddsType || 'standard').toLowerCase();
  if (t === 'demon') return 'demon';
  if (t === 'goblin') return 'goblin';
  return 'standard';
}

async function ppGet(path, cfg) {
  const url = `${cfg.apiBase}${path}`;
  const headers = { Accept: 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`PrizePicks ${res.status} ${url}`);
  return res.json();
}

// Parse a raw projections payload ({ data, included }) into flat line records.
// Exported so it can be unit-tested without network.
export function parseProjections(payload) {
  const players = {};
  for (const inc of payload?.included || []) {
    if (inc.type === 'new_player' || inc.type === 'player') {
      players[inc.id] = {
        id: inc.id,
        name: inc.attributes?.name ?? null,
        team: inc.attributes?.team ?? inc.attributes?.team_name ?? null,
      };
    }
  }
  const out = [];
  for (const p of payload?.data || []) {
    const a = p.attributes || {};
    const pid = p.relationships?.new_player?.data?.id
             ?? p.relationships?.player?.data?.id ?? null;
    const player = players[pid] || {};
    const statType = a.stat_type ?? null;
    const market = STAT_MARKET[statType] || (statType ? statType.toLowerCase() : null);
    const lineStatus = lineStatusOf(a.odds_type);
    out.push({
      projectionId: p.id,
      player: player.name,
      playerKey: nameKey(player.name),
      playerId: pid,
      team: player.team,
      statType,
      market,
      line: a.line_score != null ? Number(a.line_score) : null,
      oddsType: a.odds_type ?? 'standard',
      lineStatus,                       // 'standard' | 'demon' | 'goblin'
      isStandard: lineStatus === 'standard',
      startTime: a.start_time ?? null,
      status: a.status ?? null,         // 'pre_game' etc.
    });
  }
  return out;
}

// Fetch NBA standard props. Returns { lines, byPlayerMarket, alt } — `lines` is
// standard-only (bettable); `alt` holds demon/goblin for context/no-bet display.
export async function fetchNbaProps(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const payload = await ppGet(
    `/projections?league_id=${cfg.leagueId}&per_page=1000&single_stat=true`, cfg);
  const all = parseProjections(payload);

  const lines = all.filter(l => l.isStandard && l.line != null && l.market);
  const alt = all.filter(l => !l.isStandard);

  const byPlayerMarket = {};
  for (const l of lines) byPlayerMarket[`${l.playerKey}|${l.market}`] = l;

  return { lines, alt, byPlayerMarket, count: lines.length, altCount: alt.length };
}

// Look up a standard line for a player+market from a prefetched index.
export function lookupLine(byPlayerMarket, playerName, market) {
  return byPlayerMarket[`${nameKey(playerName)}|${market}`] || null;
}

export default { fetchNbaProps, parseProjections, lookupLine };
