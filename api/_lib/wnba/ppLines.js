// api/_lib/wnba/ppLines.js — PrizePicks WNBA line feed
//
// Sibling of the MLB pp-lines feed, same proven partner-api endpoint and rules.
// Pulls PrizePicks' partner projections, filters to WNBA + the stats Lyrid models,
// and returns lines the slate joins against players by name+team.
//
// STANDARD-ONLY RULE: PP labels every line standard / goblin / demon. The betting
// rule is "standard only; demon'd or goblin'd = no bet." This feed exposes the type
// so the slate can ENFORCE it (only ~11% of WNBA lines are standard).
//
// HONEST CAVEATS (same as MLB feed):
//  1. partner-api returned 200 from a datacenter IP; Vercel is a different range.
//     If it 403s in production, the slate MUST fall back to manual lines — never
//     depend on this. Failure returns { ok:false } cleanly.
//  2. Join is name+team only. PP ships name and display_name which can disagree;
//     we key under both normalized spellings. A miss falls back to manual entry,
//     never to a wrong line.
//  3. Unofficial endpoint — can change or vanish without notice.

const PP_URL = 'https://partner-api.prizepicks.com/projections?per_page=1000';
const WNBA_LEAGUE_NAME = 'WNBA';

// PP stat_type → Lyrid market key. Only what the tool models.
const STAT_MAP = {
  'Points': 'points',
  'Rebounds': 'rebounds',
  'Assists': 'assists',
  'Pts+Rebs+Asts': 'pra',
  '3-PT Made': 'threes',
};

export function normalizeName(n) {
  if (!n) return '';
  return String(n)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let _memo = { at: 0, data: null };
const _TTL = 3 * 60 * 1000;   // 3 min — PP lines move but not every second

export async function fetchWnbaPpLines({ standardOnly = false, noCache = false } = {}) {
  if (!noCache && _memo.data && (Date.now() - _memo.at) < _TTL) return _memo.data;

  let r;
  try {
    r = await fetch(PP_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  } catch (err) {
    const out = { ok: false, reason: err?.name === 'TimeoutError' ? 'PrizePicks timed out' : String(err?.message || err), blocked: false, lines: [], byKey: {}, altIndex: {} };
    return out;
  }
  if (!r.ok) {
    // 403 almost certainly = Vercel IP range blocked. Clean failure → manual fallback.
    return { ok: false, reason: `PrizePicks returned ${r.status}`, blocked: r.status === 403, lines: [], byKey: {}, altIndex: {} };
  }

  const payload = await r.json();
  const data = payload.data || [];
  const included = payload.included || [];
  const players = {}, leagues = {};
  for (const i of included) {
    if (i.type === 'new_player') players[i.id] = i.attributes || {};
    else if (i.type === 'league') leagues[i.id] = (i.attributes || {}).name;
  }

  const lines = [];
  for (const p of data) {
    const a = p.attributes || {}, rel = p.relationships || {};
    const leagueId = rel.league?.data ? rel.league.data.id : null;
    if (leagues[leagueId] !== WNBA_LEAGUE_NAME) continue;
    const market = STAT_MAP[a.stat_type];
    if (!market) continue;
    const playerId = rel.new_player?.data ? rel.new_player.data.id : null;
    const pl = players[playerId] || {};
    const nameA = pl.name || '', nameB = pl.display_name || '';
    if (!nameA && !nameB) continue;
    lines.push({
      name: nameA, displayName: nameB,
      norm: normalizeName(nameA), normDisplay: normalizeName(nameB),
      team: pl.team || null, position: pl.position || null,
      market, statLabel: a.stat_type, line: a.line_score,
      oddsType: a.odds_type || 'standard',
      isStandard: (a.odds_type || 'standard') === 'standard',
      startTime: a.start_time || null, status: a.status || null,
    });
  }

  // byKey: standard lines keyed "normname|market" (both spellings) → line info.
  // This is what the slate joins against — standard only, since alt = no bet.
  const byKey = {};
  const putKey = (nm, mk, obj) => { const k = `${nm}|${mk}`; if (nm && !byKey[k]) byKey[k] = obj; };
  // altIndex: props that exist ONLY as demon/goblin → "alt-only" (a no-bet, but a
  // different fact from "no line found").
  const altIndex = {};
  for (const l of lines) {
    if (l.isStandard) {
      const obj = { line: l.line, team: l.team, oddsType: l.oddsType, statLabel: l.statLabel };
      putKey(l.norm, l.market, obj);
      if (l.normDisplay && l.normDisplay !== l.norm) putKey(l.normDisplay, l.market, obj);
    } else {
      if (l.norm) { const k = `${l.norm}|${l.market}`; if (!altIndex[k]) altIndex[k] = l.oddsType; }
      if (l.normDisplay && l.normDisplay !== l.norm) { const k = `${l.normDisplay}|${l.market}`; if (!altIndex[k]) altIndex[k] = l.oddsType; }
    }
  }

  const standardCount = lines.filter(l => l.isStandard).length;
  const out = {
    ok: true, fetchedAt: new Date().toISOString(),
    total: lines.length, standardCount, altCount: lines.length - standardCount,
    byKey, altIndex,
    lines: standardOnly ? lines.filter(l => l.isStandard) : lines,
  };
  _memo = { at: Date.now(), data: out };
  return out;
}
