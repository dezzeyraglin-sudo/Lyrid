// ============================================================================
// api/pp-lines.js — PrizePicks line feed (Drop #60, July 2026)
//
// Pulls PrizePicks' partner projections endpoint, filters to MLB, and returns a
// compact payload the client can join against tonight's slate.
//
// WHY THIS EXISTS: every PP line was hand-typed into the manual-entry fields.
// That made the forward line-log impractical, which meant tiers (unified call,
// MAX-5 convergence, HRR-under) could never be graded against the market —
// they stayed conviction flags forever. Auto-filled lines close that loop.
//
// THE BIG ONE — odds_type: PP labels every projection standard / goblin /
// demon. The standing rule is "standard line only; demon'd or goblin'd = no
// bet", and until now the app could only WARN about it because it couldn't see
// the line type. Now it can enforce it. (Reality check from a live pull:
// only ~7% of MLB projections are standard. The other 93% are alt lines.)
//
// HONEST CAVEATS, read before trusting this:
//   1. partner-api returned 200 from a datacenter IP in testing, unlike
//      api.prizepicks.com which hard-403s. Vercel is ALSO a datacenter IP but
//      a different range — if this 403s in production, that's why, and the
//      manual-entry path must keep working. Never make the app depend on it.
//   2. There is NO MLB player id in the feed (external_player_id is null), so
//      joining to Lyrid's players is name+team only. PP ships two name fields
//      that disagree ("Vlad Guerrero Jr." vs "Vladimir Guerrero Jr."); we
//      return both and let the client try each. Fuzzy joins WILL miss some.
//      A miss must fall back to manual entry, never to a wrong line.
//   3. Unofficial endpoint. It can change or disappear without notice.
// ============================================================================

const PP_URL = 'https://partner-api.prizepicks.com/projections?per_page=1000';
const MLB_LEAGUE_NAME = 'MLB';

// Only the stats Lyrid actually models. Keeps the payload small and stops us
// shipping 8,000 rows of props the app has no read on.
const STAT_MAP = {
  'Hits+Runs+RBIs': 'HRR',
  'Hits': 'HITS',
  'Total Bases': 'TB',
  'Runs': 'RUNS',
  'RBIs': 'RBI',
  'Home Runs': 'HR',
  'Singles': 'SINGLES',
  'Doubles': 'DOUBLES',
  'Walks': 'BB',
  'Stolen Bases': 'SB',
  'Hitter Strikeouts': 'HITTER_K',
  'Hitter Fantasy Score': 'HITTER_FS',
  'Pitcher Strikeouts': 'K',
  'Pitching Outs': 'OUTS',
  'Earned Runs Allowed': 'ER',
  'Hits Allowed': 'HITS_ALLOWED',
  'Walks Allowed': 'BB_ALLOWED',
  'Pitcher Fantasy Score': 'PITCHER_FS',
  'Pitches Thrown': 'PITCHES',
  '1st Inning Runs Allowed': 'F1_RUNS',
  '1st Inning Walks Allowed': 'F1_BB'
};

// Normalize a player name for joining: strip accents, punctuation, suffixes,
// lowercase. "Vladimir Guerrero Jr." and "Vlad Guerrero Jr." still won't match
// each other — that's why we return both raw names too.
function normalizeName(n) {
  if (!n) return '';
  return String(n)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function handler(req, res) {
  // ?standard=1 returns ONLY standard lines. That's ~613 rows / ~90KB instead
  // of ~8,400 rows / ~1.3MB — a 93% cut, and it matches the actual betting
  // rule (standard only; demons and goblins are no-bets). Default returns
  // everything so the client can still SHOW that a line exists but is alt-only,
  // which is different from "no line found" and shouldn't be confused with it.
  const standardOnly = String((req.query && req.query.standard) || '') === '1';

  try {
    const r = await fetch(PP_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000)
    });

    if (!r.ok) {
      // 403 here almost certainly means Vercel's IP range is blocked (caveat 1).
      // Return a clean, explicit failure so the client keeps manual entry.
      return res.status(200).json({
        ok: false,
        reason: `PrizePicks returned ${r.status}`,
        blocked: r.status === 403,
        lines: []
      });
    }

    const payload = await r.json();
    const data = payload.data || [];
    const included = payload.included || [];

    const players = {};
    const leagues = {};
    for (const i of included) {
      if (i.type === 'new_player') players[i.id] = i.attributes || {};
      else if (i.type === 'league') leagues[i.id] = (i.attributes || {}).name;
    }

    const lines = [];
    for (const p of data) {
      const a = p.attributes || {};
      const rel = p.relationships || {};

      const leagueId = rel.league && rel.league.data ? rel.league.data.id : null;
      if (leagues[leagueId] !== MLB_LEAGUE_NAME) continue;

      const key = STAT_MAP[a.stat_type];
      if (!key) continue;                       // stat Lyrid doesn't model

      const playerId = rel.new_player && rel.new_player.data ? rel.new_player.data.id : null;
      const pl = players[playerId] || {};
      const nameA = pl.name || '';
      const nameB = pl.display_name || '';
      if (!nameA && !nameB) continue;

      lines.push({
        // Both names shipped — the client tries each (caveat 2).
        name: nameA,
        displayName: nameB,
        norm: normalizeName(nameA),
        normDisplay: normalizeName(nameB),
        team: pl.team || null,
        position: pl.position || null,
        prop: key,
        statLabel: a.stat_type,
        line: a.line_score,
        // standard | goblin | demon — the whole point.
        oddsType: a.odds_type || 'standard',
        isStandard: (a.odds_type || 'standard') === 'standard',
        wagerTypes: a.allowed_wager_types || null,
        startTime: a.start_time || null,
        status: a.status || null
      });
    }

    const standardCount = lines.filter(l => l.isStandard).length;
    const out = standardOnly ? lines.filter(l => l.isStandard) : lines;

    // Compact alt-index: "normname|PROP" -> oddsType, for lines that exist on
    // the PP board but ONLY as demon/goblin. Both "no line" and "alt-only" are
    // no-bets under the standing rule, but they're different facts and the
    // client should be able to say which. Costs ~40 bytes/row instead of ~180.
    //
    // Keyed under BOTH name spellings. PP ships name and display_name, which
    // disagree on a handful of players ("Vladimir Guerrero Jr." vs "Vlad
    // Guerrero Jr."). Testing caught a lookup on the display spelling falling
    // through to "no line" when a demon line existed — i.e. the app would have
    // said "not on the board" about a prop that IS on the board and is a no-bet.
    const altIndex = {};
    for (const l of lines) {
      if (l.isStandard) continue;
      if (l.norm) { const k = `${l.norm}|${l.prop}`; if (!altIndex[k]) altIndex[k] = l.oddsType; }
      if (l.normDisplay && l.normDisplay !== l.norm) {
        const k2 = `${l.normDisplay}|${l.prop}`; if (!altIndex[k2]) altIndex[k2] = l.oddsType;
      }
    }

    // Cache at the edge: PP lines move, but not every second. 3 min keeps the
    // slate fresh without hammering an endpoint we don't own.
    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=300');
    return res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      // Counts always describe the FULL board, even when the payload is
      // filtered — so the client can say "no standard line (3 alt lines exist)"
      // rather than pretending the player isn't on the board at all.
      total: lines.length,
      standardCount,
      altCount: lines.length - standardCount,
      filtered: standardOnly,
      altIndex,
      lines: out
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      reason: err && err.name === 'TimeoutError' ? 'PrizePicks timed out' : String(err && err.message || err),
      blocked: false,
      lines: []
    });
  }
}
