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
const UA = { 'User-Agent': 'Mozilla/5.0 (Lyrid analytics)', Accept: 'application/json' };

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

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

// Fetch every game's availability report for a date (YYYY-MM-DD).
// Returns { ok, byPlayer: { normalizedName: {status, statusRaw, position, team, gameId} }, games:[...] }
export async function fetchAvailability(date) {
  const out = { ok: false, byPlayer: {}, games: [], fetchedAt: new Date().toISOString(), error: null };
  try {
    const ymd = String(date).replace(/-/g, '');
    const sb = await getJson(`${ESPN}/scoreboard?dates=${ymd}`);
    const events = sb.events || [];
    out.games = events.map(e => ({ id: e.id, name: e.name, start: e.date }));

    // fetch summaries in parallel (small slates; cap concurrency implicitly)
    const summaries = await Promise.all(events.map(e =>
      getJson(`${ESPN}/summary?event=${e.id}`).catch(() => null)
    ));

    summaries.forEach((s, i) => {
      if (!s || !Array.isArray(s.injuries)) return;
      const gameId = events[i] && events[i].id;
      for (const teamBlock of s.injuries) {
        const team = teamBlock?.team?.abbreviation || null;
        for (const entry of (teamBlock.injuries || [])) {
          const name = entry?.athlete?.displayName;
          if (!name) continue;
          const statusRaw = entry.status || null;
          const st = norm(statusRaw);
          // ESPN carries a short news "spin" blurb per injury — long/short comment. Field
          // names vary across payloads; grab defensively (CONFIRM against a live summary).
          const detailStr = (entry?.details && (entry.details.type || entry.details.detail))
            || (typeof entry?.type === 'string' ? entry.type : entry?.type?.description) || null;
          const blurb = entry?.longComment || entry?.shortComment
            || (entry?.details && (entry.details.longComment || entry.details.detail)) || null;
          out.byPlayer[normName(name)] = {
            name,
            statusRaw,
            status: OUT_STATUSES.has(st) ? 'out' : (DOUBT_STATUSES.has(st) ? 'doubtful' : 'active'),
            position: entry?.athlete?.position?.abbreviation || null,
            team, gameId,
            detail: detailStr,
            blurb,
            side: entry?.details?.side || null,
            returnDate: entry?.details?.returnDate || null,
          };
        }
      }
    });
    out.ok = true;
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
