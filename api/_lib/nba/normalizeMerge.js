// api/_lib/nba/normalizeMerge.js
//
// Fuses the three feeds into one engine-shape player object:
//   ESPN roster  -> CURRENT team (offseason-signing fix)
//   ESPN gamelog -> shot profile (shots-to-clear inputs) + recent form
//   ESPN injuries-> availability
//   bbref        -> intrinsic driver rates + opponent (matchup) context
//   PrizePicks   -> the line being graded
//
// Key behaviour: a player's RATES and shot profile are intrinsic and carry across
// a trade, but his TEAM CONTEXT (opponent, pace) and — critically — his minutes/
// usage are not. So when the current team != the team his stats were earned on,
// we flag `teamChange` -> role/usage uncertain, which the engine turns into a
// confidence cut / wider variance band. ("Role > matchup history.")

import { fetchPlayerGameLog, buildShotProfile } from './espnClient.js';
import { nameKey } from './espnRoster.js';

function last(rows, n, key) {
  const v = rows.filter(r => r.min != null).slice(0, n).map(r => r[key]).filter(x => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// Merge one player. Pass preloaded league data so a slate fetches each source ONCE:
//   rosterIndex : { byNameKey } from espnRoster.buildRosterIndex (cached nightly)
//   bbrefAdv    : fetchPlayerAdvanced(season).byKey  (Map)
//   bbrefTeams  : fetchTeamContext(season).teams     (object)
//   injuryIdx   : espnClient.injuryIndex()           (object)
export async function mergePlayer(ppLine, { rosterIndex, bbrefAdv, bbrefTeams, injuryIdx, opponentAbbr, gameLog } = {}) {
  const key = nameKey(ppLine.player);
  const roster = rosterIndex?.byNameKey?.[key] || null;

  const dc = {
    playerResolved: !!roster, hasShotProfile: false, hasBbrefRates: false,
    hasOpponentCtx: false, hasInjury: false, teamChangeFlagged: false,
  };

  // identity + CURRENT team (the fix)
  const id = roster?.id ?? null;
  const currentTeam = roster?.team ?? null;

  // ESPN gamelog -> shot profile + recent form (intrinsic; survives a trade)
  const rows = gameLog ?? (id ? await fetchPlayerGameLog(id).catch(() => []) : []);
  const shotProfile = rows.length ? buildShotProfile(rows) : null;
  dc.hasShotProfile = !!shotProfile && !shotProfile.insufficient;

  // bbref intrinsic rates + the historical team they were earned on
  const adv = bbrefAdv?.get?.(key) || null;
  dc.hasBbrefRates = !!adv;
  const historicalTeam = adv?.team ?? null;

  // matchup context = the CURRENT opponent (from bbref team-allowed table)
  const opp = opponentAbbr ? bbrefTeams?.[opponentAbbr] || null : null;
  dc.hasOpponentCtx = !!opp;

  // availability
  const inj = id ? injuryIdx?.[id] || null : null;
  dc.hasInjury = !!inj;

  // team-change: stats earned on a different team than the player now plays for
  const teamChange = !!(historicalTeam && currentTeam && historicalTeam !== currentTeam);
  dc.teamChangeFlagged = teamChange;

  return {
    resolved: !!roster,
    id, name: roster?.name ?? ppLine.player, pos: roster?.pos ?? adv?.pos ?? null,
    currentTeam,
    opponent: opponentAbbr ?? null,
    line: { market: ppLine.market, line: ppLine.line, side: ppLine.side ?? null },

    shotProfile,                         // 2PA/3PA/FTA per-min, make rates, minutes mean/CV
    form: rows.length ? {
      gamesUsed: Math.min(rows.length, 5),
      ptsL5: last(rows, 5, 'pts'), minL5: last(rows, 5, 'min'), ftaL5: last(rows, 5, 'fta'),
    } : null,

    drivers: adv ? {
      usgPct: adv.usgPct, ftr: adv.ftr, tsPct: adv.tsPct,
      trbPct: adv.trbPct, orbPct: adv.orbPct, drbPct: adv.drbPct,
      astPct: adv.astPct, fg3aRate: adv.fg3aRate,
    } : null,

    matchup: opp ? {
      defRtg: opp.defRtg, oppFgPct: opp.oppFgPct,
      oppFg3aRate: opp.oppFg3aRate, oppFg3aPerG: opp.oppFg3aPerG, pace: opp.pace,
    } : null,

    availability: inj ? { status: inj.status, available: inj.available } : { status: null, available: true },

    flags: {
      teamChange,
      historicalTeam,
      // stats say his old team -> usage/role/minutes on the new team are uncertain.
      // Engine should cut confidence / widen the band and lean on role over history.
      roleUncertain: teamChange,
    },

    dataCompleteness: dc,
  };
}

// Merge a whole slate against preloaded league data (one fetch per source).
export async function mergeSlate(ppLines, ctx) {
  return Promise.all(ppLines.map(l =>
    mergePlayer(l, { ...ctx, opponentAbbr: l.opponent ?? ctx.opponentAbbr })));
}
