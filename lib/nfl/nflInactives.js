// nflInactives.js
// Lyrid NFL engine — day-of availability gate (Layer 8).
//
// The NFL analog to Lyrid's MLB confirmed-starter pre-bet rule. NFL inactives are
// released ~90 MINUTES BEFORE KICKOFF. nflverse is post-game/daily and cannot
// provide this, so we read ESPN's free unofficial API.
//
// Why it matters more in NFL than people assume — it breaks BOTH sides of a read:
//   * SUBJECT out  -> the prop is dead (obvious)
//   * DEFENDER out -> the matchup read inverts. If you faded a WR because he draws
//     a shutdown corner and that corner is inactive, the fade is now wrong.
//   * TEAMMATE out -> volume redistributes (WR1 out => WR2 target share spikes)
//
// Endpoints (verified live, no key required):
//   scoreboard: site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=YYYYMMDD
//   summary:    site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={id}
// The summary payload carries `injuries[]` per team, each entry:
//   { status, date, athlete:{displayName, position:{abbreviation}}, type, details }
//
// CAVEAT: unofficial/undocumented — can change or rate-limit. Every function here
// degrades to `unknown` rather than throwing, and `unknown` must never be treated
// as "available" by the caller (see gateProp: unknown => flag, not pass).

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const UA = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.espn.com/nfl/injuries',
  'Origin': 'https://www.espn.com',
};

// statuses that mean the player will NOT play
const OUT_STATUSES = new Set(['out', 'inactive', 'injured reserve', 'ir', 'suspended', 'did not play']);
// statuses that mean meaningful doubt
const DOUBT_STATUSES = new Set(['doubtful', 'questionable']);

function norm(s) { return String(s || '').trim().toLowerCase(); }
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.'']/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJson(url, tries = 2) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return r.json();
      lastErr = new Error(`ESPN ${r.status}`);
      if (r.status !== 429 && r.status !== 403 && r.status < 500) break; // don't retry a hard client error twice
    } catch (e) { lastErr = e; }
    if (i < tries - 1) await new Promise(res => setTimeout(res, 350));
  }
  throw lastErr || new Error('ESPN fetch failed');
}

// Fetch every game's availability report for a date (YYYY-MM-DD).
// Returns { ok, byPlayer: { normalizedName: {status, statusRaw, position, team, gameId} }, games:[...] }
export async function fetchAvailability(date) {
  const out = { ok: false, byPlayer: {}, games: [], fetchedAt: new Date().toISOString(), error: null, sources: [], leagueError: null, injuryCount: 0 };

  // Merge one injury entry into byPlayer. Same entry shape across ESPN's league-injuries,
  // team-injuries, and game-summary payloads: { athlete:{displayName, position}, status,
  // details, longComment/shortComment, type }. CONFIRM field names against a live payload.
  const severity = (s) => (s === 'out' ? 2 : (s === 'doubtful' ? 1 : 0));
  const ingest = (entry, team, gameId) => {
    const name = entry && entry.athlete && entry.athlete.displayName;
    if (!name) return;
    const statusRaw = entry.status || (entry.type && entry.type.description) || null;
    const st = norm(statusRaw);
    const detailStr = (entry.details && (entry.details.type || entry.details.detail))
      || (typeof entry.type === 'string' ? entry.type : (entry.type && entry.type.description)) || null;
    const blurb = entry.longComment || entry.shortComment
      || (entry.details && (entry.details.longComment || entry.details.detail)) || null;
    const rec = {
      name, statusRaw,
      status: OUT_STATUSES.has(st) ? 'out' : (DOUBT_STATUSES.has(st) ? 'doubtful' : 'active'),
      position: (entry.athlete.position && entry.athlete.position.abbreviation) || null,
      team: team || (entry.athlete.team && entry.athlete.team.abbreviation) || null,
      gameId: gameId || null,
      detail: detailStr, blurb,
      side: entry.details && entry.details.side || null,
      returnDate: entry.details && entry.details.returnDate || null,
    };
    const key = normName(name);
    const prev = out.byPlayer[key];
    // keep the MORE severe status; on a tie, prefer the record that carries a blurb
    if (!prev || severity(rec.status) > severity(prev.status)
        || (severity(rec.status) === severity(prev.status) && rec.blurb && !prev.blurb)) {
      out.byPlayer[key] = rec;
    }
  };

  try {
    const ymd = String(date).replace(/-/g, '');

    // (a) scoreboard — the games on this date (kept for game context / summary fetch)
    const sb = await getJson(`${ESPN}/scoreboard?dates=${ymd}`).catch(() => null);
    const events = (sb && sb.events) || [];
    out.games = events.map(e => ({ id: e.id, name: e.name, start: e.date }));

    // (b) LEAGUE-WIDE injury report (PRIMARY) — every team's current designations, posted
    // mid-week, not just 90-min-pre-kickoff inactives. This is where a QUESTIONABLE like
    // Kittle actually lives days ahead. One call, all teams.
    try {
      const lg = await getJson(`${ESPN}/injuries`);
      const blocks = (lg && lg.injuries) || [];
      for (const b of blocks) {
        const team = (b && b.team && b.team.abbreviation) || (b && b.abbreviation) || null;
        for (const entry of ((b && b.injuries) || [])) ingest(entry, team, null);
      }
      if (blocks.length) out.sources.push('league');
    } catch (e) { out.leagueError = String((e && e.message) || e); }

    // (c) per-game summaries (SUPPLEMENT) — day-of inactives that may not be in the report yet
    const summaries = await Promise.all(events.map(e =>
      getJson(`${ESPN}/summary?event=${e.id}`).catch(() => null)
    ));
    summaries.forEach((s, i) => {
      if (!s || !Array.isArray(s.injuries)) return;
      const gameId = events[i] && events[i].id;
      for (const teamBlock of s.injuries) {
        const team = (teamBlock && teamBlock.team && teamBlock.team.abbreviation) || null;
        for (const entry of ((teamBlock.injuries) || [])) ingest(entry, team, gameId);
      }
    });
    if (summaries.some(Boolean)) out.sources.push('summary');

    out.injuryCount = Object.keys(out.byPlayer).length;
    out.ok = out.injuryCount > 0 || out.sources.length > 0 || out.games.length > 0;
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

// Look up one player. Returns 'active' | 'doubtful' | 'out' | 'unknown'.
// NOTE: 'unknown' means ESPN listed no report for him. Most players aren't listed
// (only those with a designation), so unknown is the NORMAL healthy case — but we
// return it distinctly so callers can decide, rather than silently assuming healthy.
export function playerStatus(availability, playerName) {
  if (!availability || !availability.ok) return { status: 'unknown', reason: 'availability feed unavailable' };
  const hit = availability.byPlayer[normName(playerName)];
  if (!hit) return { status: 'unknown', reason: 'no injury designation listed (typically means healthy)' };
  return { status: hit.status, statusRaw: hit.statusRaw, position: hit.position, team: hit.team, detail: hit.detail, blurb: hit.blurb, side: hit.side, returnDate: hit.returnDate };
}

// THE GATE. Applies day-of availability to a prop and returns a decision.
//   prop: { player, propType }
//   context: { keyDefender, teammates:[names] }  (optional matchup dependencies)
// Returns { decision: 'pass'|'flag'|'kill', reasons[] }
export function gateProp({ availability, prop, context = {} }) {
  const reasons = [];
  let decision = 'pass';

  if (!availability || !availability.ok) {
    return { decision: 'flag', reasons: ['day-of availability feed unavailable — matchup unverified'] };
  }

  // 1) subject availability
  const subj = playerStatus(availability, prop.player);
  if (subj.status === 'out') {
    return { decision: 'kill', reasons: [`${prop.player} is OUT (${subj.statusRaw})`] };
  }
  if (subj.status === 'doubtful') {
    decision = 'flag';
    reasons.push(`${prop.player} listed ${subj.statusRaw} — volume floor unreliable`);
  }

  // 2) key defender out => the matchup read that justified this pick may invert
  if (context.keyDefender) {
    const def = playerStatus(availability, context.keyDefender);
    if (def.status === 'out') {
      decision = decision === 'kill' ? decision : 'flag';
      reasons.push(`matchup defender ${context.keyDefender} is OUT — coverage read no longer holds (re-evaluate; a fade may now be wrong)`);
    } else if (def.status === 'doubtful') {
      decision = decision === 'kill' ? decision : 'flag';
      reasons.push(`matchup defender ${context.keyDefender} is ${def.statusRaw} — coverage read uncertain`);
    }
  }

  // 3) teammate out => volume redistribution (can help or hurt)
  for (const mate of (context.teammates || [])) {
    const m = playerStatus(availability, mate);
    if (m.status === 'out') {
      decision = decision === 'kill' ? decision : 'flag';
      reasons.push(`teammate ${mate} OUT — target/carry share redistributes; baseline volume is stale`);
    }
  }

  if (!reasons.length) reasons.push('no day-of availability concerns found');
  return { decision, reasons, subjectStatus: subj.status };
}

export { normName, OUT_STATUSES, DOUBT_STATUSES };
