// api/nba/analyze.js
//
// Slate orchestration: PrizePicks standard lines -> merged players -> minutes ->
// ranked best bets -> History candidates. The pure core `analyzeSlate` takes its
// fetchers injected so it can be unit-tested without network; the default export
// is the Vercel handler that wires the real clients + env.

import * as espn from '../_lib/nba/espnClient.js';
import { fetchPlayerAdvanced, fetchTeamContext } from '../_lib/nba/bbrefClient.js';
import { fetchNbaProps } from '../_lib/nba/prizepicks.js';
import { buildRosterIndex, fetchTeamsMap } from '../_lib/nba/espnRoster.js';
import { mergePlayer } from '../_lib/nba/normalizeMerge.js';
import { projectMinutes } from '../_lib/nba/minutesModel.js';
import { evaluateSlate, rankBestBets, toCandidates } from '../_lib/nba/nbaBestBets.js';
import { assignArchetype } from '../_lib/nba/nbaArchetype.js';
import { playerShotProfile, teamAllowedProfile, openZoneRead, lastNGameShots } from '../_lib/nba/nbaShotZone.js';
import { recentForm } from '../_lib/nba/recentForm.js';

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

// Build the shot-zone cache from a set of ESPN game summaries. Run this in a cron
// (like the roster index) and cache the result — it fetches many summaries, so it
// must NOT run on the analyze hot path. Returns { byPlayer:{id->profile},
// teamAllowed:{ABBR->profile} }.
export function buildShotZoneIndex(gameSummaries) {
  const { idToAbbr } = fetchTeamsMap();
  const allShots = [];
  for (const sm of gameSummaries || []) {
    const shots = sm.shots || [];
    const teams = [...new Set(shots.map((s) => s.teamId).filter(Boolean))];
    for (const s of shots) allShots.push({ ...s, defTeamId: teams.find((t) => t !== s.teamId), gameDate: sm.date || null });
  }
  const byPlayer = {}; const teamAllowed = {};
  for (const pid of new Set(allShots.map((s) => s.shooterId).filter(Boolean))) {
    const pShots = allShots.filter((s) => String(s.shooterId) === String(pid));
    byPlayer[String(pid)] = {
      season: playerShotProfile(allShots, pid),
      l10: playerShotProfile(lastNGameShots(pShots, 10), pid),  // recency window
    };
  }
  for (const tid of new Set(allShots.map((s) => s.defTeamId).filter(Boolean))) {
    const abbr = idToAbbr[String(tid)] || String(tid);
    teamAllowed[abbr] = teamAllowedProfile(allShots, tid);
  }
  return { byPlayer, teamAllowed };
}

// PURE CORE — inject fetchers/data so this is testable offline.
export async function analyzeSlate(io) {
  const {
    date = todayISO(), season, props, schedule, rosterIndex, injuryIdx,
    bbrefAdv, bbrefTeams, fetchGameLog, shotZoneIndex = null,
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

    // --- recent-form panel (L5/L10 effectiveness from the game log) -> player card ---
    m.recentForm = recentForm(gameLog);

    // --- shot-type archetype (bbref rates, sharpened by shot-zone if cached) -> player card ---
    const szEntry = (shotZoneIndex && roster?.id) ? shotZoneIndex.byPlayer?.[String(roster.id)] || null : null;
    const szProfile = szEntry
      ? ((szEntry.l10 && !szEntry.l10.insufficient) ? szEntry.l10 : (szEntry.season || szEntry.l10 || szEntry))
      : null;
    m.archetype = assignArchetype(
      { fg3aRate: adv?.fg3aRate, ftr: adv?.ftr, usgPct: adv?.usgPct, astPct: adv?.astPct, trbPct: adv?.trbPct, pos: m.pos },
      szProfile,
    );
    // --- shot-zone read vs opponent defense (shadow) -> verdict + card ---
    if (shotZoneIndex) {
      const allowed = shotZoneIndex.teamAllowed?.[game.opponent] || null;
      m.shotZone = { profile: szProfile, openZone: (szProfile && allowed) ? openZoneRead(szProfile, allowed) : null };
    }

    merged.push(m);
  }

  // Evaluate the whole slate ONCE; the board shows all players, logging uses the bets.
  const allRows = evaluateSlate(merged, ppIndex, { league: 'NBA' });
  const slatePlayers = toCandidates(allRows, { date });                 // full informational slate
  const ranked = allRows.filter((r) => r.isBet).sort((a, b) => b.edge - a.edge);
  const candidates = toCandidates(ranked, { date });                    // LEAN+ bets (logged)

  // attach archetype + shot-zone read onto the output rows by player id (so the card
  // has them even though toCandidates doesn't know about them)
  const metaById = {};
  for (const m of merged) if (m.id) metaById[String(m.id)] = { archetype: m.archetype, shotZone: m.shotZone || null, recentForm: m.recentForm || null };
  const attach = (arr) => (arr || []).map((c) => {
    const meta = c.playerId != null ? metaById[String(c.playerId)] : null;
    return meta ? { ...c, archetype: meta.archetype, shotZone: meta.shotZone, recentForm: meta.recentForm } : c;
  });

  return {
    date,
    count: candidates.length,
    candidates: attach(candidates),
    players: attach(slatePlayers),
    ranked,
    mergedCount: merged.length,
  };
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

    // shot-zone cache is written by a cron (buildShotZoneIndex over recent summaries);
    // read it here when available. Null is fine — archetype falls back to bbref rates
    // and the shot-zone verdict reads stay dormant until the cache exists.
    const shotZoneIndex = null; // TODO: load from Supabase/KV (cron output)

    const out = await analyzeSlate({
      date, season, props, schedule, rosterIndex, injuryIdx,
      bbrefAdv: advPack.byKey, bbrefTeams: teamPack.teams,
      fetchGameLog: espn.fetchPlayerGameLog,
      shotZoneIndex,
    });

    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
