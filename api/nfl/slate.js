// api/nfl/slate.js  — Lyrid NFL slate endpoint (Vercel serverless, Node 20 ESM)
// GET /api/nfl/slate?date=YYYY-MM-DD
//
// v4 — RUNS THE REAL ENGINE. Instead of a thin inline path, this builds a full
// ctx for each prop and calls analyzeProp() (nflAnalyze.js), which runs EVERY
// feature module — volume security, game-script risk, scheme matchup, suppression,
// per-position coverage, environment, efficiency leakage, pressure dynamics,
// player-vs-opp, injury impact, comp kNN, classifier, prop routing (the blitz ×
// checkdown override), narrative + probable coverage, and the QB outlook — and
// assembles the card. The endpoint's only job is to gather inputs and shape ctx.
//
// Why this resolves the "volume scale" question: volumeSecurity() computes the
// 0-1 floor the classifier's filter wants from trailing GAME rows, while the
// feature-vector's z-score volume_floor stays purely a kNN distance feature. Two
// different numbers, each correct in its place — no logistic reconciliation needed.
//
// ROBUSTNESS: the engine module graph is imported DYNAMICALLY inside the handler
// and wrapped in try/catch. If any lib module is missing from the deploy bundle,
// or nflEnvironment can't read data/nfl/stadiums.json, we degrade to LINES mode
// (PP lines, no tiers) instead of a 500. (This is the failure that bit us before.)
//
// Degrades honestly everywhere: no Supabase -> LINES; no ESPN -> no odds/opponent/
// availability enrichment (those modules just return neutral); any single table
// empty -> that module is skipped and reported in `missing` / dataCompleteness.

import {
  parsePrizePicks, normalizeLines, getUnmappedStats, clearUnmappedStats,
  getAltLinesDropped, clearAltLinesDropped,
} from '../../lib/nfl/nflLineAdapters.js';

const PP_URL = 'https://partner-api.prizepicks.com/projections?league_id=9&per_page=1000';
const PROP_LABEL = {
  passing_yards: 'Passing Yards', rushing_yards: 'Rushing Yards',
  receiving_yards: 'Receiving Yards', rush_rec_yards: 'Rush + Rec Yards',
  pass_rush_yards: 'Pass + Rush Yards',
};
const FAM_TO_POS = { passing_yards: 'QB', rushing_yards: 'RB', receiving_yards: 'WR', pass_rush_yards: 'QBC', rush_rec_yards: 'RBC' };  // QBC/RBC = combo pools
// ESPN scoreboard uses a few abbreviations the aggregate tables don't. Normalize.
const ESPN_ABBR = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR' };
const fixAbbr = a => (a ? (ESPN_ABBR[a] || a) : a);

function pendingVerdict(line, pick) {
  return {
    pick: pick || 'higher', line, tier_candidate: 'none',
    filters: { softLine: false, volumeSecure: false, scriptClear: false },
    pOver: null, pOverAdjusted: null, edge: null, reasons: [],
    blocked: ['baseline pending — run the nflverse ingest to enable analysis'],
    provisional: true,
  };
}

export default async function handler(req, res) {
  const date = (req.query && req.query.date) || new Date().toISOString().slice(0, 10);
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  // 1) PrizePicks NFL projections (best-effort)
  let ppJson = null;
  try {
    const r = await fetch(PP_URL, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Lyrid analytics)' } });
    if (r.ok) ppJson = await r.json();
  } catch (_) {}
  if (!ppJson) {
    return res.status(200).json({ source: 'unavailable', date, picks: [],
      note: 'PrizePicks lines could not be fetched (rate-limited or offline). Use the manual tracker, or retry.' });
  }

  // 2) normalize + filter to the requested ET date
  clearUnmappedStats();
  clearAltLinesDropped();
  let lines = normalizeLines(parsePrizePicks(ppJson));
  lines = lines.map(l => {
    const st = l._start_time || l.start_time || null;
    let etDate = l.game_date;
    try {
      if (l.raw_start || st) {
        const d = new Date(l.raw_start || st);
        if (!isNaN(d)) etDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      }
    } catch (_) {}
    return { ...l, game_date: etDate };
  });
  const datesSeen = Array.from(new Set(lines.map(l => l.game_date).filter(Boolean))).sort();
  if (date) lines = lines.filter(l => !l.game_date || l.game_date === date);
  if (!lines.length) {
    return res.status(200).json({ source: 'prizepicks', date, picks: [],
      note: 'No PrizePicks yardage lines for this date yet.',
      diagnostics: { unmappedStatTypes: getUnmappedStats(), datesSeen: datesSeen.slice(0, 12) } });
  }

  // 2b) LINE-HISTORY CAPTURE (best-effort) — bank every distinct line we see so a real
  // archive builds going forward (no free historical prop-line source exists). One row per
  // distinct (player, prop, date, line); ignore-duplicates preserves first-seen, so
  // re-fetches are no-ops and genuine line moves append. Never blocks the response.
  try {
    const SBU = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), SBK = process.env.SUPABASE_SERVICE_KEY;
    if (SBU && SBK) {
      const rows = lines.map(l => ({
        player_key: l.player_name, player_name: l.player_name, team: l.team || null,
        prop_type: l.prop_type, game_date: l.game_date || date, line: Number(l.line),
        captured_at: new Date().toISOString(),
      })).filter(r => Number.isFinite(r.line));
      if (rows.length) {
        await fetch(`${SBU}/rest/v1/nfl_line_history?on_conflict=player_key,prop_type,game_date,line`, {
          method: 'POST',
          headers: { apikey: SBK, Authorization: `Bearer ${SBK}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
      }
    }
  } catch (_) {}

  // 3) dynamically load the engine (degrade to LINES if any module/data is missing)
  let analyzeProp = null, fetchAvailability = null, playerStatus = null, engineError = null;
  try {
    ({ analyzeProp } = await import('../../lib/nfl/nflAnalyze.js'));
    try { ({ fetchAvailability, playerStatus } = await import('../../lib/nfl/nflInactives.js')); } catch (_) { fetchAvailability = null; }
  } catch (e) { engineError = String((e && e.message) || e); analyzeProp = null; }

  // 4) gather all engine inputs (Supabase + ESPN). null => LINES mode.
  let E = null;
  if (analyzeProp) {
    try { E = await loadEngineData(lines, date, fetchAvailability); } catch (e) { E = null; engineError = engineError || String(e); }
  }
  const ready = !!(analyzeProp && E && E.ready);

  // 5) build picks
  const picks = lines.map(l => {
    const propLabel = PROP_LABEL[l.prop_type] || l.raw_stat || l.prop_type;
    const team = (ready && E.nameToTeam[l.player_name]) || l.team || null;
    const opponent = (ready && team && E.oppByTeam[team]) || l.opponent || null;
    const base = {
      player: l.player_name, player_key: l.player_key || l.player_name,
      team, position: l.position || (ready ? E.posByName[l.player_name] : null) || null,
      opponent, propLabel,
    };
    if (!ready) return { ...base, verdict: pendingVerdict(l.line, 'higher') };

    const ctx = buildCtx(E, l, base);
    if (!ctx) return { ...base, verdict: pendingVerdict(l.line, 'higher'), note: 'no historical baseline for this player yet' };

    let result;
    try { result = analyzeProp(ctx); }
    catch (e) { return { ...base, verdict: pendingVerdict(l.line, 'higher'), note: 'engine error: ' + String((e && e.message) || e) }; }

    // per-game directional lean for the game-first UI chip (from the spread)
    const od = E.oddsByTeam[team];
    if (od && od.spread != null) {
      const s = od.spread;
      result.verdict.scriptLean = Math.abs(s) < 3 ? 'neutral_script' : (s < 0 ? 'run_script' : 'pass_script');
      result.verdict.scriptMargin = -s;
    }

    // ---- NEAR-MEDIAN GUARD: an edge smaller than the model's own resolution is a coin
    // flip, not an edge — the #1 way narrow-miss legs die (Kamara 72 vs 73.5, Darnold
    // 213 vs 223.5). Force no-play when the line sits within a family-scaled noise floor
    // of the projected median. Direction-agnostic, so it protects unders when they ship.
    {
      const c = result.comp || {};
      const ln = result.verdict && result.verdict.line;
      if (c.median != null && ln != null) {
        const NM_FLOOR = { receiving_yards: 5, rushing_yards: 5, rush_rec_yards: 6, passing_yards: 14, pass_rush_yards: 16 };
        const margin = Math.abs(Number(c.median) - Number(ln));
        const floor = NM_FLOOR[l.prop_type] || 5;
        if (margin < floor && result.verdict) {
          const v = result.verdict;
          if (v.tier_candidate && v.tier_candidate !== 'none') {
            v.nearMedianOverride = { demotedFrom: v.tier_candidate, margin: +margin.toFixed(1), floor };
            v.tier_candidate = 'none';
            v.blocked = [`near-median coin flip — proj ${Number(c.median).toFixed(0)} vs line ${Number(ln)} within model noise (${margin.toFixed(1)} < ${floor} yds)`, ...(v.blocked || [])];
          }
          v.nearMedian = true;
        }
      }
    }

    // ---- STALENESS GATE: cap the tier when the read rests on a role that changed ----
    // A new team, a depth-chart demotion, or a non-starter QB means the historical
    // baseline no longer describes this player's situation — cap it, never GUARANTEED.
    const stale = computeStaleness(base, l, E);
    if (stale.severity !== 'none' && result.verdict) {
      const ORD = { GUARANTEED: 3, PLATINUM: 2, GOLD: 1, none: 0 };
      const v = result.verdict, cap = stale.capTier;
      if (ORD[v.tier_candidate] > ORD[cap]) {
        v.stalenessOverride = { demotedFrom: v.tier_candidate, to: cap };
        v.tier_candidate = cap;
        v.blocked = ['stale role \u2014 ' + (stale.reasons[0] || 'situation changed'), ...(v.blocked || [])];
      }
      v.stale = { severity: stale.severity, teamChanged: stale.teamChanged, roleNote: stale.roleNote, reasons: stale.reasons };
    }

    // ---- INJURY / RETURN-RISK: surface status + ESPN blurb, and cap the tier for a
    // questionable/doubtful player. A soft line on an injured player is usually the market
    // pricing reduced volume (Kittle back from injury at 39.5), not a free edge — so a
    // real injury designation can't carry a top tier. A listed-but-active player gets an
    // informational tag only (no cap): the model can't see rust, but you should.
    let injury = null;
    if (playerStatus && E.availability && E.availability.ok) {
      const s = playerStatus(E.availability, base.player);
      if (s && s.status && s.status !== 'unknown') {
        injury = { status: s.status, statusRaw: s.statusRaw || null, detail: s.detail || null, blurb: s.blurb || null, side: s.side || null };
        if (s.status === 'doubtful' && result.verdict) {   // 'doubtful' bucket = questionable OR doubtful
          const ORD = { GUARANTEED: 3, PLATINUM: 2, GOLD: 1, none: 0 };
          const v = result.verdict;
          if (ORD[v.tier_candidate] > ORD['GOLD']) {
            v.injuryOverride = { demotedFrom: v.tier_candidate, to: 'GOLD', status: s.statusRaw };
            v.tier_candidate = 'GOLD';
            v.blocked = [`injury risk — listed ${s.statusRaw || 'questionable'}; soft line likely prices reduced volume`, ...(v.blocked || [])];
          }
        }
      }
    }

    return {
      ...base,
      verdict: result.verdict,
      stale: (result.verdict && result.verdict.stale) || null,
      injury,
      outlook: result.outlook || null,
      comp: result.comp || null,
      card: result.card || null,
      routing: result.routing || null,
      dataCompleteness: result.dataCompleteness ?? null,
    };
  });

  const rank = { GUARANTEED: 3, PLATINUM: 2, GOLD: 1, none: 0 };
  picks.sort((a, b) =>
    (rank[b.verdict.tier_candidate] - rank[a.verdict.tier_candidate]) ||
    ((b.verdict.edge || 0) - (a.verdict.edge || 0)));

  return res.status(200).json({
    source: ready ? 'prizepicks+engine' : 'prizepicks',
    date, count: picks.length, picks,
    diagnostics: {
      unmappedStatTypes: getUnmappedStats(),
      altLinesDropped: getAltLinesDropped(),
      propFamilies: Array.from(new Set(lines.map(l => l.prop_type))),
      baselineResolved: ready ? Object.keys(E.featByKey).length : 0,
      availabilityOk: ready ? !!(E.availability && E.availability.ok) : false,
      availabilitySources: (ready && E.availability && E.availability.sources) || [],
      injuryCount: (ready && E.availability && E.availability.injuryCount) || 0,
      availabilityError: (ready && E.availability && (E.availability.leagueError || E.availability.error)) || null,
      engineError: engineError || undefined,
    },
    note: ready ? undefined
      : (engineError ? 'Showing PrizePicks lines (engine unavailable — see diagnostics).'
        : 'Showing PrizePicks lines. Tier analysis activates once the nflverse baseline is loaded.'),
  });
}

// ===========================================================================
// buildCtx — shape one analyzeProp() context from the loaded lookups
// ===========================================================================
function buildCtx(E, l, base) {
  const gsis = E.nameToKey[l.player_name];
  if (!gsis) return null;
  const fam = l.prop_type;
  const perFam = E.featByKeyFam[gsis];
  const famRow = perFam && perFam[fam];
  if (!famRow) return null; // no baseline for THIS family -> pending (honest, not a wrong pool)

  // poolPos = which family-partitioned comp pool to search (passing→QB pool,
  // rushing→RB pool, receiving→WR pool). rosterPos = the player's actual position,
  // used for receiverType/archetype (a QB's rushing prop searches the RB pool but
  // is NOT a running back).
  const poolPos = FAM_TO_POS[fam] || 'WR';
  const rosterPos = E.posByKey[gsis] || E.posByName[l.player_name] || poolPos;
  const team = base.team, opp = base.opponent;
  const od = team ? E.oddsByTeam[team] : null;

  // receiverType (approx; slot-rate data would refine WR into deep/possession)
  const receiverType = rosterPos === 'RB' ? 'RB' : rosterPos === 'TE' ? 'TE'
    : rosterPos === 'WR' ? 'deep_WR' : null;
  const posGroup = rosterPos === 'RB' ? 'RB' : (rosterPos === 'TE' ? 'TE' : 'WR');

  // QB pressure profile: the player himself for a QB prop, else his team's QB
  const qbKey = fam === 'passing_yards' ? gsis : (team ? E.teamQbKey[team] : null);
  const qbPressure = qbKey ? E.qbPressByKey[qbKey] : null;
  const qbCpoe = qbKey ? E.cpoeByKey[qbKey] : null;

  // opponent per-position coverage table -> { WR, TE, RB }
  const defCoverageByPos = opp ? E.coverageByTeam[opp] || null : null;
  const rq = E.recQualByKey[gsis] || null;

  return {
    player: base.player, propFamily: fam, line: l.line, structure: 'standard_3', pick: 'higher',
    position: poolPos,  // compProject target.position must match the pool rows' label
    injuryPlayerProfile: { position: rosterPos },
    // volume + archetype
    trailingGames: E.trailingByKey[gsis] || null,
    seasonTotals: E.seasonByKey[gsis] || null,
    receiverType,
    // matchup
    defScheme: opp ? E.schemeByTeam[opp] || null : null,
    defSuppression: opp ? E.supByTeam[opp] || null : null,
    defCoverageByPos,
    teamTendency: team ? E.tendByTeam[team] || null : null,
    oppName: opp,
    // pressure
    qbPressure,
    teamPressure: opp ? E.teamPressByTeam[opp] || null : null,   // opponent pass rush (defense)
    offense: team ? E.teamPressByTeam[team] || null : null,      // own protection
    qb: qbCpoe != null ? { cpoe: qbCpoe } : null,
    // efficiency leakage
    teamPenalty: team ? E.penByTeam[team] || null : null,
    resilience: rq && rq.rec_cpoe != null ? { recCpoe: Number(rq.rec_cpoe), position: rosterPos, targets: famRow.recentTargets ?? 40 } : null,
    snap: rq && rq.offense_pct_mean != null ? { offense_pct_mean: Number(rq.offense_pct_mean), offense_pct_sd: Number(rq.offense_pct_sd) } : null,
    // script + environment
    spread: od ? od.spread : null,
    gameTotal: od ? od.total : null,
    homeTeam: team ? E.homeByTeam[team] || null : null,
    weather: null, roofStatus: null,
    // comp
    compPool: E.compPoolByPos[poolPos] || [],
    features: (() => {
      const skill = famRow.features || {};
      const envTeam = (team && E.curTeamEnvZ && E.curTeamEnvZ[team]) || {};
      const envQbKey = (fam === 'passing_yards' || fam === 'pass_rush_yards') ? gsis : (team ? E.teamQbKey[team] : null);
      const envQb = (envQbKey && E.curQbEnvZ && E.curQbEnvZ[envQbKey]) || {};
      const ms = (E.milestoneByKey && E.milestoneByKey[gsis] && E.milestoneByKey[gsis][fam]) || 0;
      return { ...skill, ...envTeam, ...envQb, milestone_pull: ms };  // player's OWN skill + TONIGHT'S environment
    })(),
    // explosive / chunk-play inputs
    receiverExpl: fam === 'receiving_yards' ? (E.recExplByKey[gsis] || null) : null,
    qbDeep: qbKey ? (E.qbDeepByKey[qbKey] || null) : null,
    oppExplAllowed: opp ? ((E.explByTeam[opp] && E.explByTeam[opp][posGroup]) || null) : null,
    // availability gate (kills OUT players)
    availability: E.availability || null,
    // opponent context
    opponent: opp, season: E.season || null,
  };
}

// ===========================================================================
// loadEngineData — one place to fetch every engine input
// ===========================================================================
async function loadEngineData(lines, date, fetchAvailability) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const b = url.replace(/\/$/, '');
  let cumByKey = {}, playedWeeks = {}, milestoneByKey = {};
  const CURY = Number(String(date).slice(0, 4)) || 0;
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const q = async (path) => { const r = await fetch(`${b}/rest/v1/${path}`, { headers: H }); if (!r.ok) throw new Error(`supabase ${r.status} on ${path}`); return r.json(); };
  const qSafe = async (path) => { try { return await q(path); } catch (_) { return []; } };
  const enc = s => encodeURIComponent(String(s));
  const inList = arr => arr.map(k => `"${String(k).replace(/"/g, '')}"`).join(',');
  const firstBy = (rows, kf) => { const m = {}; for (const r of rows) { const k = kf(r); if (!(k in m)) m[k] = r; } return m; };

  // ---- ESPN scoreboard: opponent + spread + total + home team ----
  const oddsByTeam = {}, oppByTeam = {}, homeByTeam = {}, espnIdByAbbr = {};
  try {
    const ymd = String(date).replace(/-/g, '');
    const sb = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${ymd}`).then(r => r.ok ? r.json() : null);
    for (const ev of (sb?.events || [])) {
      const comp = ev.competitions?.[0]; if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const ha = fixAbbr(home?.team?.abbreviation), aa = fixAbbr(away?.team?.abbreviation);
      const odds = comp.odds?.[0] || {};
      const total = Number(odds.overUnder);
      const absSpread = Math.abs(Number(odds.spread) || 0);
      const homeFav = odds.homeTeamOdds?.favorite === true;
      if (ha && aa) {
        oppByTeam[ha] = aa; oppByTeam[aa] = ha;
        homeByTeam[ha] = ha; homeByTeam[aa] = ha;
        if (home?.team?.id) espnIdByAbbr[ha] = home.team.id;
        if (away?.team?.id) espnIdByAbbr[aa] = away.team.id;
        oddsByTeam[ha] = { spread: homeFav ? -absSpread : absSpread, total };
        oddsByTeam[aa] = { spread: homeFav ? absSpread : -absSpread, total };
      }
    }
  } catch (_) {}

  // ---- ESPN depth charts: current role + team (the staleness cross-reference) ----
  const seasonYear = Number(String(date).slice(0, 4)) || new Date().getFullYear();
  const liveTeams = [...new Set(lines.map(l => fixAbbr(l.team)).filter(Boolean))];
  let roleByName = {};
  try { roleByName = await fetchDepthChartRoles(liveTeams, espnIdByAbbr, seasonYear); } catch (_) {}

  // ---- day-of availability (best-effort; kills OUT players via gateProp) ----
  let availability = null;
  if (typeof fetchAvailability === 'function') { try { availability = await fetchAvailability(date); } catch (_) { availability = null; } }

  // ---- resolve names -> key/team/position + trailing game rows ----
  const names = [...new Set(lines.map(l => l.player_name).filter(Boolean))];
  const nameToKey = {}, nameToTeam = {}, posByName = {}, posByKey = {}, cpoeByKey = {};
  const trailingByKey = {}, seasonByKey = {}, recentTargetsByKey = {};
  let latestSeason = 0;
  if (names.length) {
    const orExpr = names.map(n => `player_name.eq.${enc(n)}`).join(',');
    const rows = await qSafe(`nfl_player_games?or=(${orExpr})&order=season.desc,week.desc&select=player_key,player_name,team_abbr,position,season,week,passing_yards,rushing_yards,receiving_yards,pass_attempts,rush_attempts,targets,receptions,target_share,air_yards_share,cpoe&limit=8000`);
    const cpoeAccum = {};
    for (const r of rows) {
      const k = r.player_key;
      latestSeason = Math.max(latestSeason, Number(r.season) || 0);
      if (Number(r.season) === CURY) {
        const cb = (cumByKey[k] ||= { passing_yards: 0, rushing_yards: 0, receiving_yards: 0 });
        cb.passing_yards += num(r.passing_yards) || 0; cb.rushing_yards += num(r.rushing_yards) || 0; cb.receiving_yards += num(r.receiving_yards) || 0;
        (playedWeeks[k] ||= new Set()).add(Number(r.week));
      }
      if (!nameToKey[r.player_name]) {
        nameToKey[r.player_name] = k;
        if (r.team_abbr) nameToTeam[r.player_name] = fixAbbr(r.team_abbr);
        if (r.position) posByName[r.player_name] = r.position;
      }
      if (!posByKey[k] && r.position) posByKey[k] = r.position;
      // trailing games for volumeSecurity (map carries->rush_attempts already named)
      (trailingByKey[k] ||= []).push({
        targets: num(r.targets), target_share: num(r.target_share), air_yards_share: num(r.air_yards_share),
        rush_attempts: num(r.rush_attempts), pass_attempts: num(r.pass_attempts), receptions: num(r.receptions),
      });
      // cpoe rolling (QB accuracy)
      const c = num(r.cpoe); if (c != null) { (cpoeAccum[k] ||= []).push(c); }
    }
    for (const [k, arr] of Object.entries(cpoeAccum)) cpoeByKey[k] = arr.slice(0, 8).reduce((a, x) => a + x, 0) / Math.min(arr.length, 8);
    for (const [k, arr] of Object.entries(trailingByKey)) {
      trailingByKey[k] = arr.slice(0, 8);
      const t = arr.slice(0, 6).map(g => g.targets).filter(Number.isFinite);
      recentTargetsByKey[k] = t.length ? Math.round(t.reduce((a, x) => a + x, 0) / t.length) : null;
    }
    // current-season cumulative -> milestone pull per family (context-conditioning channel)
    for (const k of Object.keys(cumByKey)) {
      const played = (playedWeeks[k] && playedWeeks[k].size) || 0;
      const gl = Math.max(0, 17 - played);
      milestoneByKey[k] = {
        receiving_yards: milestonePull(cumByKey[k].receiving_yards, gl, 'receiving_yards'),
        rushing_yards: milestonePull(cumByKey[k].rushing_yards, gl, 'rushing_yards'),
        passing_yards: 0,
      };
    }
    // season totals (latest season only) for archetype
    const bySeasonKey = {};
    for (const r of rows) {
      if (Number(r.season) !== latestSeason) continue;
      const k = r.player_key;
      const s = (bySeasonKey[k] ||= { position: r.position, games: 0, rushing_yards: 0, receiving_yards: 0, passing_yards: 0, targets: 0, carries: 0 });
      s.games += 1;
      s.rushing_yards += num(r.rushing_yards) || 0;
      s.receiving_yards += num(r.receiving_yards) || 0;
      s.passing_yards += num(r.passing_yards) || 0;
      s.targets += num(r.targets) || 0;
      s.carries += num(r.rush_attempts) || 0;
    }
    Object.assign(seasonByKey, bySeasonKey);
  }
  const slateKeys = [...new Set(Object.values(nameToKey))];
  if (!slateKeys.length) return null;

  // ---- team -> primary QB (for receiver checkdown routing + team QB cpoe) ----
  const slateTeams = [...new Set(Object.values(nameToTeam))];
  const oppTeams = [...new Set(slateTeams.map(t => oppByTeam[t]).filter(Boolean))];
  const allTeams = [...new Set([...slateTeams, ...oppTeams])];
  const teamFilter = allTeams.length ? `&team_abbr=in.(${inList(allTeams)})` : '';
  const teamQbKey = {};
  if (slateTeams.length) {
    const qbRows = await qSafe(`nfl_player_games?position=eq.QB&team_abbr=in.(${inList(slateTeams)})&order=season.desc,week.desc&select=player_key,team_abbr,pass_attempts,cpoe&limit=4000`);
    const attByTeamKey = {};
    for (const r of qbRows) {
      const t = fixAbbr(r.team_abbr); if (!t) continue;
      const acc = (attByTeamKey[t] ||= {});
      acc[r.player_key] = (acc[r.player_key] || 0) + (num(r.pass_attempts) || 0);
      if (cpoeByKey[r.player_key] == null && num(r.cpoe) != null) cpoeByKey[r.player_key] = num(r.cpoe);
    }
    for (const [t, acc] of Object.entries(attByTeamKey)) {
      teamQbKey[t] = Object.entries(acc).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    }
  }
  const qbKeys = [...new Set(Object.values(teamQbKey).filter(Boolean))];

  // ---- CURRENT environment (trailed to now) + norms — the context-conditioned target ----
  // z-score TONIGHT'S env with the IDENTICAL norms the pool build persisted, else the
  // distance metric is comparing different scales. env = mean of the last <=6 weekly rows.
  let normsByMetric = {}, curTeamEnvZ = {}, curQbEnvZ = {};
  try {
    for (const r of await qSafe(`nfl_env_norms?select=metric,mean,sd`)) normsByMetric[r.metric] = { mean: num(r.mean), sd: num(r.sd) };
    const zf = (v, metric) => { const n = normsByMetric[metric]; if (!n || n.sd == null || v == null) return null; return +(((v - n.mean) / n.sd)).toFixed(4); };
    const avgLast6 = (arr, key) => { const xs = arr.slice(0, 6).map(x => num(x[key])).filter(Number.isFinite); return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null; };
    const twe = allTeams.length ? await qSafe(`nfl_team_week_env?team_abbr=in.(${inList(allTeams)})&order=season.desc,week.desc&select=team_abbr,season,week,proe,plays,sack_rate_allowed`) : [];
    const twByTeam = {}; for (const r of twe) (twByTeam[r.team_abbr] ||= []).push(r);
    for (const [t, arr] of Object.entries(twByTeam)) {
      const sackZ = zf(avgLast6(arr, 'sack_rate_allowed'), 'sack');
      curTeamEnvZ[t] = { env_proe: zf(avgLast6(arr, 'proe'), 'proe'), env_pace: zf(avgLast6(arr, 'plays'), 'pace'), env_passblock: sackZ == null ? null : +(-sackZ).toFixed(4) };
    }
    const qkeys = [...new Set([...slateKeys, ...qbKeys])];
    const qwe = qkeys.length ? await qSafe(`nfl_qb_week_env?player_key=in.(${inList(qkeys)})&order=season.desc,week.desc&select=player_key,season,week,adot,deep_comp_pct,cpoe`) : [];
    const qwByKey = {}; for (const r of qwe) (qwByKey[r.player_key] ||= []).push(r);
    for (const [k, arr] of Object.entries(qwByKey)) {
      curQbEnvZ[k] = { env_qb_adot: zf(avgLast6(arr, 'adot'), 'qb_adot'), env_qb_deepconnect: zf(avgLast6(arr, 'deep_comp_pct'), 'qb_deep'), env_qb_cpoe: zf(avgLast6(arr, 'cpoe'), 'qb_cpoe') };
    }
  } catch (_) {}


  // ---- feature rows for the slate players (target features; position) ----
  const feats = await qSafe(`nfl_feature_vectors?player_key=in.(${inList(slateKeys)})&order=season.desc,week.desc&select=player_key,prop_type,volume_floor_score,feature_json`);
  // Keep the most-recent row PER (player, family). A QB has both passing and
  // rushing vectors; his passing prop must search the passing pool with his
  // passing features, his rushing prop the rushing pool — not one shared row.
  const featByKeyFam = {};   // player_key -> { prop_type -> { features, recentTargets } }
  const featByKey = {};      // player_key -> any row (for the resolved-count diagnostic only)
  for (const r of feats) {
    const fam = r.prop_type;
    const perFam = (featByKeyFam[r.player_key] ||= {});
    if (perFam[fam]) continue; // first = most recent for THIS family
    const fj = r.feature_json || {};
    perFam[fam] = {
      features: { volume_floor: num(r.volume_floor_score), recent_form: num(fj.recent_form), skill_tshare: num(fj.skill_tshare), skill_ays: num(fj.skill_ays), skill_carry: num(fj.skill_carry) },
      recentTargets: recentTargetsByKey[r.player_key] ?? null,
    };
    if (!featByKey[r.player_key]) featByKey[r.player_key] = perFam[fam];
  }
  if (!Object.keys(featByKeyFam).length) return null;

  // ---- aggregate tables (scoped), plus player-level pressure/quality ----
  const [tendRows, covRows, supRows, schemeRows, penRows, teamPressRows, recQualRows, qbPressRows] = await Promise.all([
    qSafe(`nfl_team_tendencies?select=team_abbr,season,proe_pct,plays_per_game,identity&order=season.desc${teamFilter}`),
    qSafe(`nfl_defense_coverage_by_pos?select=team_abbr,season,pos_group,yards_per_target,catch_rate_allowed&order=season.desc${teamFilter}`),
    qSafe(`nfl_defense_suppression?select=team_abbr,season,pass_epa_allowed,pass_success_allowed,sack_rate,qb_hit_rate,rush_epa_allowed,rush_success_allowed,ypc_allowed&order=season.desc${teamFilter}`),
    qSafe(`nfl_defense_scheme?select=team_abbr,season,man_rate,zone_rate,blitz_rate,heavy_box_rate,pressure_rate,cover1_share,cover2_share,cover3_share,cover4_share&order=season.desc${teamFilter}`),
    qSafe(`nfl_team_penalty_drag?select=team_abbr,season,nullify_pct,top_penalty&order=season.desc${teamFilter}`),
    qSafe(`nfl_team_pressure?select=team_abbr,season,pressure_rate,sack_rate,sack_pct_allowed&order=season.desc${teamFilter}`),
    qSafe(`nfl_receiver_quality?player_key=in.(${inList(slateKeys)})&order=season.desc&select=player_key,position,rec_cpoe,offense_pct_mean,offense_pct_sd`),
    qSafe(`nfl_qb_pressure_profile?player_key=in.(${inList([...new Set([...slateKeys, ...qbKeys])])})&order=season.desc&select=player_key,te_share_clean,te_share_pressured,adot_clean,adot_pressured,sack_per_pressure,pressure_rate,times_sacked,times_pressured,attempts`),
  ]);

  const tendByTeam = firstBy(tendRows, r => r.team_abbr);
  const supByTeam = firstBy(supRows, r => r.team_abbr);
  const schemeByTeam = firstBy(schemeRows, r => r.team_abbr);
  const penByTeam = firstBy(penRows, r => r.team_abbr);
  const teamPressByTeam = firstBy(teamPressRows, r => r.team_abbr);
  const recQualByKey = firstBy(recQualRows, r => r.player_key);
  const qbPressRaw = firstBy(qbPressRows, r => r.player_key);
  // normalize qb pressure fields to the shapes nflPressureDynamics expects
  const qbPressByKey = {};
  for (const [k, r] of Object.entries(qbPressRaw)) {
    qbPressByKey[k] = {
      te_share_clean: num(r.te_share_clean), te_share_pressured: num(r.te_share_pressured),
      adot_clean: num(r.adot_clean), adot_pressured: num(r.adot_pressured),
      sack_per_pressure: num(r.sack_per_pressure), pressure_rate: num(r.pressure_rate),
      times_sacked: num(r.times_sacked), times_pressured: num(r.times_pressured),
      dropbacks: num(r.attempts),
    };
  }
  // coverage -> { team: { WR, TE, RB } }
  const coverageByTeam = {};
  for (const r of covRows) { const t = r.team_abbr; (coverageByTeam[t] ||= {}); if (!coverageByTeam[t][r.pos_group]) coverageByTeam[t][r.pos_group] = { yards_per_target: num(r.yards_per_target), catch_rate_allowed: num(r.catch_rate_allowed) }; }

  // ---- explosive / chunk-play tables ----
  const [recExplRows, qbDeepRows, defExplRows] = await Promise.all([
    qSafe(`nfl_receiver_explosive?player_key=in.(${inList(slateKeys)})&order=season.desc&select=player_key,pos_group,adot,deep_target_rate,explosive_catch_rate,breakaway_rate,yprc,explosiveness_score`),
    qSafe(`nfl_qb_deepball?player_key=in.(${inList([...new Set([...slateKeys, ...qbKeys])])})&order=season.desc&select=player_key,adot,deep_att_rate,deep_comp_pct,deep_ypa,deepball_score,deep_connect_score`),
    qSafe(`nfl_defense_explosive_allowed?select=team_abbr,season,pos_group,deep_target_rate_allowed,explosive_catch_rate_allowed&order=season.desc${teamFilter}`),
  ]);
  const recExplByKey = firstBy(recExplRows, r => r.player_key);
  const qbDeepByKey = firstBy(qbDeepRows, r => r.player_key);
  // defense explosive-allowed, with a league z per pos_group on explosive_catch_rate_allowed
  // (the matchup amplifier the tail model reads as oppAllowed._z)
  const explByTeam = {};
  {
    const byPos = { WR: [], TE: [], RB: [] };
    for (const r of defExplRows) if (byPos[r.pos_group]) byPos[r.pos_group].push(num(r.explosive_catch_rate_allowed));
    const stat = arr => { const xs = arr.filter(Number.isFinite); if (xs.length < 4) return null; const m = xs.reduce((a, x) => a + x, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length) || 1; return { m, sd }; };
    const st = { WR: stat(byPos.WR), TE: stat(byPos.TE), RB: stat(byPos.RB) };
    for (const r of defExplRows) {
      const t = r.team_abbr; (explByTeam[t] ||= {});
      if (!explByTeam[t][r.pos_group]) {
        const s = st[r.pos_group]; const v = num(r.explosive_catch_rate_allowed);
        explByTeam[t][r.pos_group] = {
          explosive_catch_rate_allowed: v,
          deep_target_rate_allowed: num(r.deep_target_rate_allowed),
          _z: (s && v != null) ? +(((v - s.m) / s.sd)).toFixed(3) : null,
        };
      }
    }
  }

  // ---- comp pool (deterministic full paging; 2D features + realized outcome) ----
  const compPoolByPos = { QB: [], RB: [], WR: [], TE: [], QBC: [], RBC: [] };
  for (const [fam, pos] of [['passing_yards', 'QB'], ['rushing_yards', 'RB'], ['receiving_yards', 'WR'], ['pass_rush_yards', 'QBC'], ['rush_rec_yards', 'RBC']]) {
    for (let start = 0; start < 60000; start += 1000) {
      let chunk = [];
      try {
        chunk = await fetch(`${b}/rest/v1/nfl_feature_vectors?prop_type=eq.${fam}&order=player_key.asc,season.asc,week.asc&select=volume_floor_score,feature_json`, {
          headers: { ...H, 'Range-Unit': 'items', Range: `${start}-${start + 999}` },
        }).then(r => r.ok ? r.json() : []);
      } catch (_) { chunk = []; }
      if (!chunk.length) break;
      for (const r of chunk) {
        const fj = r.feature_json || {};
        const outcome = Number(fj.outcome_yards ?? fj.trailing_yards);
        if (!Number.isFinite(outcome)) continue;
        compPoolByPos[pos].push({ position: pos, features: poolFeatures(r.volume_floor_score, fj), outcome });
      }
      if (chunk.length < 1000) break;
    }
  }
  compPoolByPos.TE = compPoolByPos.WR;
  if (!compPoolByPos.QB.length && !compPoolByPos.RB.length && !compPoolByPos.WR.length) return null;

  return {
    ready: true, season: latestSeason || null,
    nameToKey, nameToTeam, posByName, posByKey, cpoeByKey, teamQbKey,
    trailingByKey, seasonByKey, featByKey, featByKeyFam, recQualByKey, qbPressByKey,
    oddsByTeam, oppByTeam, homeByTeam, availability, milestoneByKey, curTeamEnvZ, curQbEnvZ, roleByName,
    tendByTeam, supByTeam, schemeByTeam, penByTeam, teamPressByTeam, coverageByTeam,
    recExplByKey, qbDeepByKey, explByTeam,
    compPoolByPos,
  };
}

// ---- name normalizer shared by the depth-chart + staleness helpers ----
function _norm(s) {
  return String(s || '').toLowerCase().replace(/[.'`]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

// ---- ESPN depth charts -> current role map: name -> { team, posGroup, rank } ----
// roster (site API: id->name) + depthcharts (core API: ordered $refs). Best-effort;
// a failed team is skipped and the gate falls back to the free team-change signal.
// CONFIRM the two endpoint shapes against a live response before trusting.
async function fetchDepthChartRoles(teams, idByAbbr, seasonYear) {
  const roleByName = {};
  const POSG = { qb: 'QB', rb: 'RB', wr: 'WR', te: 'TE', fb: 'RB' };
  const yr = seasonYear || new Date().getFullYear();
  await Promise.all((teams || []).map(async (abbr) => {
    const id = idByAbbr && idByAbbr[abbr];
    if (!id) return;
    try {
      const roster = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/roster`).then(r => r.ok ? r.json() : null);
      const idToName = {};
      for (const grp of (roster?.athletes || [])) for (const a of (grp.items || [])) { if (a && a.id) idToName[String(a.id)] = a.displayName || a.fullName || null; }
      const dc = await fetch(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${yr}/teams/${id}/depthcharts?lang=en&region=us`).then(r => r.ok ? r.json() : null);
      for (const item of (dc?.items || [])) {
        const positions = item.positions || {};
        for (const posKey of Object.keys(positions)) {
          const pg = POSG[String(posKey).toLowerCase()];
          if (!pg) continue;
          const ats = (positions[posKey].athletes || []).slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
          ats.forEach((entry, i) => {
            const ref = entry && entry.athlete && entry.athlete.$ref;
            const m = ref && String(ref).match(/athletes\/(\d+)/);
            const nm = m && idToName[m[1]];
            if (!nm) return;
            const key = _norm(nm);
            const rank = entry.rank != null ? entry.rank : (i + 1);
            if (!roleByName[key] || rank < roleByName[key].rank) roleByName[key] = { team: abbr, posGroup: pg, rank };
          });
        }
      }
    } catch (_) {}
  }));
  return roleByName;
}

// ---- staleness: does the historical baseline still describe this player's situation? ----
function computeStaleness(base, l, E) {
  const fam = l.prop_type, name = l.player_name;
  const reasons = [];
  let sev = 'none', teamChanged = false, roleNote = null;
  const baseTeam = (E.nameToTeam && E.nameToTeam[name]) || null;
  const role = (E.roleByName && E.roleByName[_norm(name)]) || null;
  const liveTeam = (role && role.team) || l.team || base.team || null;
  if (baseTeam && liveTeam && baseTeam !== liveTeam) {
    teamChanged = true;
    reasons.push(`new team (${baseTeam} \u2192 ${liveTeam}) \u2014 the baseline is last season's role and scheme`);
    sev = 'moderate';
  }
  if (role && role.rank != null) {
    if ((fam === 'passing_yards' || fam === 'pass_rush_yards') && role.posGroup === 'QB' && role.rank > 1) {
      reasons.unshift(`listed QB${role.rank} on the depth chart \u2014 not the current starter`); sev = 'high'; roleNote = 'non-starter QB';
    } else if ((fam === 'rushing_yards' || fam === 'rush_rec_yards') && role.posGroup === 'RB' && role.rank >= 2) {
      if (role.rank >= 3) { reasons.unshift(`listed RB${role.rank} \u2014 deep in the backfield now`); sev = 'high'; }
      else { reasons.unshift(`listed RB2 behind the current lead back \u2014 trailing carries reflect a larger role than he holds now`); if (sev !== 'high') sev = 'moderate'; }
      roleNote = 'backfield demotion';
    } else if (fam === 'receiving_yards' && ((role.posGroup === 'WR' && role.rank >= 4) || (role.posGroup === 'TE' && role.rank >= 3))) {
      reasons.push(`listed ${role.posGroup}${role.rank} \u2014 a reduced target role`); if (sev !== 'high') sev = 'moderate'; roleNote = 'target-share demotion';
    }
  }
  const capTier = sev === 'high' ? 'none' : (sev === 'moderate' ? 'GOLD' : 'none');
  return { severity: sev, capTier, reasons, teamChanged, roleNote };
}

// pool-row feature extraction — expose ALL context-conditioning channels (null keys
// are skipped by the distance metric, so pre-rebuild pools stay compatible).
function poolFeatures(volFloorScore, fj) {
  fj = fj || {};
  return {
    volume_floor: num(volFloorScore), recent_form: num(fj.recent_form),
    skill_tshare: num(fj.skill_tshare), skill_ays: num(fj.skill_ays), skill_carry: num(fj.skill_carry),
    env_proe: num(fj.env_proe), env_pace: num(fj.env_pace), env_passblock: num(fj.env_passblock),
    env_qb_adot: num(fj.env_qb_adot), env_qb_deepconnect: num(fj.env_qb_deepconnect), env_qb_cpoe: num(fj.env_qb_cpoe),
    milestone_pull: num(fj.milestone_pull),
  };
}

// milestone pull — mirrors build_feature_vectors.milestone_pull exactly (must stay in sync).
function milestonePull(cum, gamesLeft, fam) {
  if (fam === 'passing_yards') return 0;
  if (cum == null || gamesLeft == null || gamesLeft <= 0 || gamesLeft > 4) return 0;
  if (cum >= 1000) return 0;
  const per = (1000 - cum) / gamesLeft;
  if (per < 30 || per > 130) return 0;
  return +Math.max(0, Math.min(1, (1 - Math.abs(per - 80) / 80) * (1 - (gamesLeft - 1) / 4))).toFixed(3);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
