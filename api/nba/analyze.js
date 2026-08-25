// api/nba/analyze.js
//
// Slate orchestration: PrizePicks standard lines -> merged players -> minutes ->
// ranked best bets -> History candidates. The pure core `analyzeSlate` takes its
// fetchers injected so it can be unit-tested without network; the default export
// is the Vercel handler that wires the real clients + env.

import * as espn from '../_lib/nba/espnClient.js';
import { fetchPlayerAdvanced, fetchTeamContext } from '../_lib/nba/bbrefClient.js';
import { fetchNbaProps } from '../_lib/nba/prizepicks.js';
import { buildRosterIndex } from '../_lib/nba/espnRoster.js';
import { mergePlayer } from '../_lib/nba/normalizeMerge.js';
import { projectMinutes } from '../_lib/nba/minutesModel.js';
import { rankBestBets, toCandidates } from '../_lib/nba/nbaBestBets.js';

function todayISO() { return new Date().toISOString().slice(0, 10); }
function yyyymmdd(iso) { return iso.replace(/-/g, ''); }

// index the schedule by team abbr -> { opponent, spread, gameId, date, isHome }
function gamesByTeam(schedule) {
  const idx = {};
  for (const g of schedule || []) {
    const homeSpread = g.favAbbr === g.home.abbr ? g.spread : (g.favAbbr === g.away.abbr ? -g.spread : null);
    idx[g.home.abbr] = { opponent: g.away.abbr, gameId: g.eventId, date: g.date, isHome: true, spread: homeSpread };
    idx[g.away.abbr] = { opponent: g.home.abbr, gameId: g.eventId, date: g.date, isHome: false, spread: homeSpread == null ? null : -homeSpread };
  }
  return idx;
}

// count a player's OUT rotation teammates from the injury index (usage funnel)
function teammatesOutFor(teamAbbr, rosterIndex, injuryIdx) {
  if (!rosterIndex?.byId) return 0;
  let n = 0;
  for (const id of Object.keys(rosterIndex.byId)) {
    const p = rosterIndex.byId[id];
    if (p.team !== teamAbbr) continue;
    const inj = injuryIdx?.[id];
    if (inj && inj.available === false) n++;
  }
  return n;
}

// PURE CORE — inject fetchers/data so this is testable offline.
export async function analyzeSlate(io) {
  const {
    date = todayISO(), season, props, schedule, rosterIndex, injuryIdx,
    bbrefAdv, bbrefTeams, fetchGameLog,
  } = io;

  const byTeam = gamesByTeam(schedule);
  const ppIndex = {};
  for (const l of props.lines) ppIndex[`${l.playerKey}|${l.market}`] = l;

  // unique players that have at least one standard line
  const seen = new Set();
  const players = props.lines.filter((l) => { const k = l.playerKey; if (seen.has(k)) return false; seen.add(k); return true; });

  const merged = [];
  for (const pl of players) {
    const roster = rosterIndex?.byNameKey?.[pl.playerKey];
    const team = roster?.team || pl.team || null;
    const game = team ? byTeam[team] : null;
    if (!game) continue; // player's team not on this slate

    const gameLog = roster?.id ? await fetchGameLog(roster.id).catch(() => []) : [];
    const m = await mergePlayer(
      { player: pl.player, market: pl.market, line: pl.line, side: null },
      { rosterIndex, bbrefAdv, bbrefTeams, injuryIdx, opponentAbbr: game.opponent, gameLog },
    );
    if (!m.resolved) continue;

    // minutes model -> attach projMinutes + cv + flags
    const adv = bbrefAdv?.get?.(pl.playerKey);
    const mm = projectMinutes({
      gameLog, gameDate: game.date, spread: game.spread,
      age: adv?.age ?? null,
      gsRatio: adv && adv.g ? (adv.gs || 0) / adv.g : null,
      teammatesOut: teammatesOutFor(team, rosterIndex, injuryIdx),
      roleUncertain: m.flags?.roleUncertain,
      designation: (roster?.id && injuryIdx?.[roster.id]?.status) || null,
      usgPct: adv?.usgPct ?? null,
    }, 'NBA');

    m.gameId = game.gameId; m.date = date;
    if (mm.ok) { m.projMinutes = mm.projMinutes; m.minutesCV = mm.cv; m.minutes = { flags: mm.flags }; }
    merged.push(m);
  }

  const ranked = rankBestBets(merged, ppIndex, { league: 'NBA' });
  const candidates = toCandidates(ranked, { date });
  return { date, count: candidates.length, candidates, ranked, mergedCount: merged.length };
}

// Vercel handler
export default async function handler(req, res) {
  try {
    const date = (req.query?.date) || todayISO();
    const season = Number(req.query?.season || process.env.NBA_SEASON || 2026); // bbref rate season (prior until new-season games accrue)
    const rosterSeason = Number(process.env.NBA_ROSTER_SEASON || 2027);

    const [schedule, props, advPack, teamPack, rosterIndex, injuryIdx] = await Promise.all([
      espn.fetchSchedule(yyyymmdd(date)),
      fetchNbaProps(),
      fetchPlayerAdvanced(season),
      fetchTeamContext(season),
      buildRosterIndex(rosterSeason),  // in production: read from cache written by the roster cron
      espn.injuryIndex(),
    ]);

    const out = await analyzeSlate({
      date, season, props, schedule, rosterIndex, injuryIdx,
      bbrefAdv: advPack.byKey, bbrefTeams: teamPack.teams,
      fetchGameLog: espn.fetchPlayerGameLog,
    });

    // Optional: upsert out.candidates into Supabase parlay_log here (PENDING),
    // mirroring the other sports' logBestBets. Left to the app's existing writer.
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
