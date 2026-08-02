// nflLineAdapters.js
// Lyrid NFL engine — live line adapters (Layer 7).
// Normalizes current prop lines from Underdog / PrizePicks (unofficial endpoints)
// and the free odds tier into a common shape the classifier consumes.
//
// IMPORTANT:
//   * These are UNOFFICIAL endpoints — undocumented, can change/break, rate-limited,
//     ToS-gray. Treat as best-effort; the MANUAL tracker (nfl_pickem_manual) is the
//     reliable fallback and the primary validation path.
//   * Live lines feed the LIVE/validation flow, never the DK backtest set.
//   * Yardage prop families only (the winning style).

const YARDAGE_MAP = {
  // Underdog / PrizePicks stat labels -> our prop_family
  'Passing Yards': 'passing_yards',
  'Pass Yards': 'passing_yards',
  'Rushing Yards': 'rushing_yards',
  'Rush Yards': 'rushing_yards',
  'Receiving Yards': 'receiving_yards',
  'Rec Yards': 'receiving_yards',
  'Rush + Rec Yards': 'rush_rec_yards',
  'Rushing + Receiving Yards': 'rush_rec_yards',
  'Pass + Rush Yards': 'pass_rush_yards', // QB combo; treat as passing-dominant
};

// Unmapped stat types encountered this run — lets callers surface what PP actually
// sends instead of silently dropping props (this is how RB combo lines went missing).
const unmappedStats = new Set();

// Canonicalize a stat label so label variations all resolve:
//   "Rush+Rec Yards", "Rush + Rec Yards", "rushing + receiving yards" -> same key
function canon(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\+/g, ' + ')        // normalize plus spacing
    .replace(/[^a-z+]+/g, ' ')    // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// Canonical lookup built from the display map, plus explicit aliases.
const CANON_MAP = (() => {
  const m = {};
  for (const [k, v] of Object.entries(YARDAGE_MAP)) m[canon(k)] = v;
  // explicit aliases seen in the wild
  const alias = {
    'pass yds': 'passing_yards',
    'passing yds': 'passing_yards',
    'rush yds': 'rushing_yards',
    'rushing yds': 'rushing_yards',
    'rec yds': 'receiving_yards',
    'receiving yds': 'receiving_yards',
    'rush + rec yds': 'rush_rec_yards',
    'rushing + receiving yds': 'rush_rec_yards',
    'rush + rec': 'rush_rec_yards',
    'pass + rush yds': 'pass_rush_yards',
    'pass + rush': 'pass_rush_yards',
    'passing + rushing yards': 'pass_rush_yards',
  };
  for (const [k, v] of Object.entries(alias)) m[canon(k)] = v;
  return m;
})();

function normFamily(label) {
  const c = canon(label);
  if (CANON_MAP[c]) return CANON_MAP[c];
  // heuristic fallback: any label containing yard(s) + the right nouns
  if (/yard|yds/.test(c)) {
    const hasRush = /rush/.test(c), hasRec = /rec|receiv/.test(c), hasPass = /pass/.test(c);
    if (hasRush && hasRec) return 'rush_rec_yards';
    if (hasPass && hasRush) return 'pass_rush_yards';
    if (hasPass) return 'passing_yards';
    if (hasRec) return 'receiving_yards';
    if (hasRush) return 'rushing_yards';
  }
  if (label) unmappedStats.add(String(label));
  return null;
}

export function getUnmappedStats() { return Array.from(unmappedStats); }
export function clearUnmappedStats() { unmappedStats.clear(); }

// ---- PrizePicks: partner-api.prizepicks.com/projections (JSON:API shape) ----
// Response has data[] (projections) + included[] (players). We join them.
export function parsePrizePicks(json) {
  if (!json || !Array.isArray(json.data)) return [];
  const players = {};
  const teams = {};      // playerId -> team abbr
  const positions = {};  // playerId -> position
  for (const inc of (json.included || [])) {
    if (inc.type === 'new_player' || inc.type === 'player') {
      const at = inc.attributes || {};
      players[inc.id] = at.name || at.display_name;
      teams[inc.id] = at.team || at.team_name || at.market || null;
      positions[inc.id] = at.position || null;
    }
  }
  const out = [];
  for (const d of json.data) {
    const a = d.attributes || {};
    const family = normFamily(a.stat_type);
    if (!family) continue; // yardage only
    const playerId = d.relationships?.new_player?.data?.id || d.relationships?.player?.data?.id;
    out.push({
      app: 'prizepicks',
      player_name: players[playerId] || a.name || 'unknown',
      team: teams[playerId] || a.team || null,
      position: positions[playerId] || null,
      opponent: a.description || a.opponent || null,  // PP puts "vs OPP" in description
      prop_type: family,
      line: Number(a.line_score),
      game_date: a.start_time ? a.start_time.slice(0, 10) : null,
      raw_start: a.start_time || null,   // preserved so callers can re-derive ET date
      raw_stat: a.stat_type,
    });
  }
  return out;
}

// ---- Underdog: internal props feed (over_under_lines shape) ----
export function parseUnderdog(json) {
  if (!json) return [];
  const out = [];
  const players = {};
  for (const p of (json.players || [])) {
    players[p.id] = `${p.first_name || ''} ${p.last_name || ''}`.trim();
  }
  // appearances tie a player to a match; over_under_lines carry the numbers
  const appPlayer = {};
  for (const ap of (json.appearances || [])) appPlayer[ap.id] = ap.player_id;

  for (const l of (json.over_under_lines || [])) {
    const ou = l.over_under || {};
    const label = ou.appearance_stat?.display_stat || ou.title || '';
    const family = normFamily(label);
    if (!family) continue;
    const appId = ou.appearance_stat?.appearance_id;
    const playerId = appPlayer[appId];
    out.push({
      app: 'underdog',
      player_name: players[playerId] || 'unknown',
      prop_type: family,
      line: Number(l.stat_value),
      game_date: null, // fill from match join if available
      raw_stat: label,
    });
  }
  return out;
}

// ---- The Odds API / free tier (DraftKings live) ----
// event-odds response: bookmakers[].markets[].outcomes[] with description=player, point=line
export function parseOddsApi(json, vendor = 'draftkings') {
  const out = [];
  const MARKET_MAP = {
    player_pass_yds: 'passing_yards',
    player_rush_yds: 'rushing_yards',
    player_reception_yds: 'receiving_yards',
  };
  const book = (json.bookmakers || []).find(b => b.key === vendor);
  if (!book) return out;
  for (const m of (book.markets || [])) {
    const family = MARKET_MAP[m.key];
    if (!family) continue;
    // group over/under per player, keep the line (point)
    const seen = {};
    for (const o of (m.outcomes || [])) {
      const name = o.description;
      if (!name || seen[name]) continue;
      seen[name] = true;
      out.push({
        app: vendor, player_name: name, prop_type: family,
        line: Number(o.point), over_odds: o.name === 'Over' ? o.price : null,
        game_date: json.commence_time ? json.commence_time.slice(0, 10) : null,
        raw_stat: m.key,
      });
    }
  }
  return out;
}

// Normalize any adapter output; drop rows without a numeric line.
export function normalizeLines(rows) {
  return (rows || []).filter(r => r && r.prop_type && Number.isFinite(r.line) && r.line > 0);
}

export { YARDAGE_MAP, normFamily };
