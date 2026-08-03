// api/nfl/slate.js  — Lyrid NFL slate endpoint (Vercel serverless, Node 20 ESM)
// GET /api/nfl/slate?date=YYYY-MM-DD
//
// v3 — THE SHARPNESS UPGRADE. Prior versions ran the classifier on TWO features
// (volume_floor + recent_form) and handed it a dead neutral script. Every other
// table you built — coverage-by-position, suppression, scheme, pressure profiles,
// penalty drag, receiver quality, team tendencies — was loaded in Supabase but
// never read. This version reads all of them, plus a live ESPN odds/opponent feed,
// and turns each into a small, league-relative, CLAMPED additive nudge that flows
// into the classifier via extraNudges + a real script slot. It also assembles the
// signal + narrative shapes nflCardSummary.js reads, so every card bullet cites a
// real number the engine actually computed.
//
// Discipline (matches the rest of the engine): every nudge is z-scored vs the
// league distribution loaded THIS request, capped small, and mirrored as a driver
// so the displayed reason == the reason the probability moved (no double-count:
// the number moves via extraNudges once; signals are just the human view of it).
// The comp kNN stays 2D (unchanged pool) — enrichment is layered ON TOP additively,
// so no feature-vector rebuild is required to get sharp cards today.
//
// Degrades honestly at every step: no Supabase -> LINES mode; no ESPN -> no
// odds/opponent enrichment (script + matchup nudges just don't fire); any single
// table empty -> its nudge is 0 and dataCompleteness drops. Never fabricates.

import { parsePrizePicks, normalizeLines, getUnmappedStats, clearUnmappedStats } from '../../lib/nfl/nflLineAdapters.js';
import { classifyProp } from '../../lib/nfl/nflClassify.js';
import { compProject } from '../../lib/nfl/nflCompEngine.js';
import { buildCard } from '../../lib/nfl/nflCardSummary.js';
import { scriptNudge } from '../../lib/nfl/nflGameScriptProjection.js';

const PP_URL = 'https://partner-api.prizepicks.com/projections?league_id=9&per_page=1000';
const PROP_LABEL = {
  passing_yards: 'Passing Yards',
  rushing_yards: 'Rushing Yards',
  receiving_yards: 'Receiving Yards',
  rush_rec_yards: 'Rush + Rec Yards',
  pass_rush_yards: 'Pass + Rush Yards',
};
const FAM_TO_POS = { passing_yards: 'QB', rushing_yards: 'RB', receiving_yards: 'WR' };
const POS_GROUP = { QB: 'WR', RB: 'RB', WR: 'WR', TE: 'TE' }; // coverage table pos_group

// ESPN scoreboard uses a few abbreviations your tables don't. Normalize to yours.
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
    const r = await fetch(PP_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Lyrid analytics)' },
    });
    if (r.ok) ppJson = await r.json();
  } catch (_) {}
  if (!ppJson) {
    return res.status(200).json({
      source: 'unavailable', date, picks: [],
      note: 'PrizePicks lines could not be fetched (rate-limited or offline). Use the manual tracker, or retry.',
    });
  }

  // 2) normalize + filter to the requested ET date (UTC->Eastern, as before)
  clearUnmappedStats();
  let lines = normalizeLines(parsePrizePicks(ppJson));
  lines = lines.map(l => {
    const st = l._start_time || l.start_time || null;
    let etDate = l.game_date;
    try {
      if (l.raw_start || st) {
        const d = new Date(l.raw_start || st);
        if (!isNaN(d)) etDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(d);
      }
    } catch (_) {}
    return { ...l, game_date: etDate };
  });
  const datesSeen = Array.from(new Set(lines.map(l => l.game_date).filter(Boolean))).sort();
  if (date) lines = lines.filter(l => !l.game_date || l.game_date === date);

  if (!lines.length) {
    return res.status(200).json({
      source: 'prizepicks', date, picks: [],
      note: 'No PrizePicks yardage lines for this date yet.',
      diagnostics: { unmappedStatTypes: getUnmappedStats(), datesSeen: datesSeen.slice(0, 12) },
    });
  }

  // 3) load enriched baselines (FULL mode) — everything you built, wired
  let mod = null;
  try { mod = await loadBaselines(lines, date); } catch (_) { mod = null; }
  const baselineReady = !!(mod && mod.ready);
  const compPoolByPos = baselineReady ? mod.compPoolByPos : null;
  const featureByPlayer = baselineReady ? mod.featureByPlayer : null;
  const nameToTeam = baselineReady ? (mod.nameToTeam || {}) : {};
  const oppByTeam = baselineReady ? (mod.oppByTeam || {}) : {};
  const enrichCoverage = baselineReady ? (mod.enrichCoverage || 0) : 0;

  // 4) build picks
  const picks = lines.map(l => {
    const propLabel = PROP_LABEL[l.prop_type] || l.raw_stat || l.prop_type;
    const team = nameToTeam[l.player_name] || l.team || null;
    const opponent = (team && oppByTeam[team]) || l.opponent || null;
    const base = {
      player: l.player_name,
      player_key: l.player_key || l.player_name,
      team, position: l.position || null, opponent, propLabel,
    };

    if (!baselineReady) return { ...base, verdict: pendingVerdict(l.line, 'higher') };

    const feat = featureByPlayer[base.player_key];
    if (!feat) return { ...base, verdict: pendingVerdict(l.line, 'higher'), note: 'no historical baseline for this player yet' };

    const pool = compPoolByPos[feat.position] || [];
    const comp = compProject({
      target: { position: feat.position, propFamily: l.prop_type, features: feat.features },
      pool, line: l.line,
    });
    const verdict = classifyProp({
      comp, volume: feat.volume, script: feat.script,
      line: l.line, structure: 'standard_3',
      extraNudges: feat.extraNudges || 0, pick: 'higher',
    });
    // surface the directional script lean so the game-first UI chip lights up
    if (feat.scriptLean) { verdict.scriptLean = feat.scriptLean; verdict.scriptMargin = feat.scriptMargin; }

    const analysisLike = {
      player: base.player, propFamily: l.prop_type, line: l.line, comp, verdict,
      signals: feat.signals || { volume: feat.volume, script: feat.script },
      narrative: feat.narrative || null,
      revenge: null,
      dataCompleteness: feat.dataCompleteness ?? null,
    };
    let card = null;
    try { card = buildCard(analysisLike); } catch (_) { card = null; }

    return { ...base, verdict, outlook: feat.outlook, comp, card };
  });

  const rank = { GUARANTEED: 3, PLATINUM: 2, GOLD: 1, none: 0 };
  picks.sort((a, b) =>
    (rank[b.verdict.tier_candidate] - rank[a.verdict.tier_candidate]) ||
    ((b.verdict.edge || 0) - (a.verdict.edge || 0)));

  return res.status(200).json({
    source: baselineReady ? 'prizepicks+engine' : 'prizepicks',
    date, count: picks.length, picks,
    diagnostics: {
      unmappedStatTypes: getUnmappedStats(),
      propFamilies: Array.from(new Set(lines.map(l => l.prop_type))),
      baselineResolved: baselineReady ? Object.keys(featureByPlayer || {}).length : 0,
      matchupEnriched: enrichCoverage,
    },
    note: baselineReady ? undefined : 'Showing PrizePicks lines. Tier analysis activates once the nflverse baseline is loaded.',
  });
}

// ===========================================================================
// loadBaselines — the enriched loader
// ===========================================================================
async function loadBaselines(lines, date) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const b = url.replace(/\/$/, '');
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const q = async (path) => {
    const r = await fetch(`${b}/rest/v1/${path}`, { headers: H });
    if (!r.ok) throw new Error(`supabase ${r.status} on ${path}`);
    return r.json();
  };
  const qSafe = async (path) => { try { return await q(path); } catch (_) { return []; } };
  const enc = s => encodeURIComponent(String(s));
  const inList = arr => arr.map(k => `"${String(k).replace(/"/g, '')}"`).join(',');

  // ---- (a) ESPN scoreboard: opponent + spread + total per team (free, no key) ----
  // CONFIRM the field paths against a live response before trusting — ESPN reshuffles
  // this JSON. It's fully optional: on any miss, script + matchup enrichment simply
  // doesn't fire and the card falls back to the 2D comp read.
  const oddsByTeam = {}; // teamAbbr -> { spread (team POV, neg=favored), total }
  const oppByTeam = {};  // teamAbbr -> opponent teamAbbr
  try {
    const yyyymmdd = String(date).replace(/-/g, '');
    const sb = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${yyyymmdd}`)
      .then(r => r.ok ? r.json() : null);
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
        oddsByTeam[ha] = { spread: homeFav ? -absSpread : absSpread, total };
        oddsByTeam[aa] = { spread: homeFav ? absSpread : -absSpread, total };
      }
    }
  } catch (_) {}

  // ---- (b) resolve names -> GSIS + team, and trailing usage, in one query ----
  const names = [...new Set(lines.map(l => l.player_name).filter(Boolean))];
  const nameToKey = {}, nameToTeam = {};
  const usageRowsByKey = {}; // player_key -> [recent rows] for trailing volume detail
  if (names.length) {
    const orExpr = names.map(n => `player_name.eq.${enc(n)}`).join(',');
    const rows = await qSafe(`nfl_player_games?or=(${orExpr})&order=season.desc,week.desc&select=player_key,player_name,team_abbr,position,season,week,target_share,carries,pass_attempts,rush_attempts,targets,receptions&limit=6000`);
    for (const r of rows) {
      if (!nameToKey[r.player_name]) {
        nameToKey[r.player_name] = r.player_key;
        if (r.team_abbr) nameToTeam[r.player_name] = fixAbbr(r.team_abbr);
      }
      (usageRowsByKey[r.player_key] ||= []).push(r);
    }
  }
  const slateKeys = [...new Set(Object.values(nameToKey))];
  if (!slateKeys.length) return null;

  // teams (and their opponents) that appear on this slate — scope aggregate pulls
  const slateTeams = [...new Set(Object.values(nameToTeam))];
  const oppTeams = [...new Set(slateTeams.map(t => oppByTeam[t]).filter(Boolean))];
  const allTeams = [...new Set([...slateTeams, ...oppTeams])];
  const teamFilter = allTeams.length ? `&team_abbr=in.(${inList(allTeams)})` : '';

  // ---- (c) Layer-2 feature rows for the slate players ----
  const feats = await qSafe(`nfl_feature_vectors?player_key=in.(${inList(slateKeys)})&order=season.desc,week.desc&select=player_key,prop_type,volume_floor_score,feature_json`);
  const featBaseByKey = {};
  for (const r of feats) {
    if (featBaseByKey[r.player_key]) continue; // first = most recent
    const fj = r.feature_json || {};
    featBaseByKey[r.player_key] = {
      position: FAM_TO_POS[r.prop_type] || 'WR',
      propFamily: r.prop_type,
      zFloor: num(r.volume_floor_score),               // raw z (for kNN + reconciliation)
      features: { volume_floor: num(r.volume_floor_score), recent_form: num(fj.recent_form) },
    };
  }
  if (!Object.keys(featBaseByKey).length) return null;

  // ---- (d) the aggregate tables — one scoped query each, empty-safe ----
  const [
    tendRows, covRows, supRows, schemeRows, penRows, teamPressRows, recQualRows, qbPressRows,
  ] = await Promise.all([
    qSafe(`nfl_team_tendencies?select=team_abbr,season,proe_pct,plays_per_game,identity&order=season.desc${teamFilter}`),
    qSafe(`nfl_defense_coverage_by_pos?select=team_abbr,season,pos_group,yards_per_target,catch_rate_allowed&order=season.desc${teamFilter}`),
    qSafe(`nfl_defense_suppression?select=team_abbr,season,pass_epa_allowed,rush_epa_allowed,ypc_allowed,sack_rate&order=season.desc${teamFilter}`),
    qSafe(`nfl_defense_scheme?select=team_abbr,season,blitz_rate,heavy_box_rate,man_rate,pressure_rate&order=season.desc${teamFilter}`),
    qSafe(`nfl_team_penalty_drag?select=team_abbr,season,nullify_pct,top_penalty&order=season.desc${teamFilter}`),
    qSafe(`nfl_team_pressure?select=team_abbr,season,pressure_rate,sack_rate,sack_pct_allowed&order=season.desc${teamFilter}`),
    qSafe(`nfl_receiver_quality?player_key=in.(${inList(slateKeys)})&order=season.desc&select=player_key,position,rec_cpoe,offense_pct_mean,offense_pct_sd`),
    qSafe(`nfl_qb_pressure_profile?player_key=in.(${inList(slateKeys)})&order=season.desc&select=player_key,player_name,te_share_clean,te_share_pressured,adot_clean,adot_pressured,sack_per_pressure,pressure_rate`),
  ]);

  // most-recent row per team/player, + league mean/sd per metric (from loaded rows)
  const firstBy = (rows, keyfn) => { const m = {}; for (const r of rows) { const k = keyfn(r); if (!(k in m)) m[k] = r; } return m; };
  const tend = firstBy(tendRows, r => r.team_abbr);
  const sup = firstBy(supRows, r => r.team_abbr);
  const scheme = firstBy(schemeRows, r => r.team_abbr);
  const pen = firstBy(penRows, r => r.team_abbr);
  const teamPress = firstBy(teamPressRows, r => r.team_abbr);
  const recQual = firstBy(recQualRows, r => r.player_key);
  const qbPress = firstBy(qbPressRows, r => r.player_key);
  // coverage is per (team,pos_group)
  const cov = {}; for (const r of covRows) { const k = `${r.team_abbr}|${r.pos_group}`; if (!(k in cov)) cov[k] = r; }

  // league stats from the rows we actually have (season-agnostic; small n is fine)
  const stats = (rows, key) => {
    const xs = rows.map(r => Number(r[key])).filter(Number.isFinite);
    if (xs.length < 4) return null;
    const m = xs.reduce((a, x) => a + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length) || 1;
    return { m, sd };
  };
  const covStatsByPos = {};
  for (const pg of ['WR', 'TE', 'RB']) covStatsByPos[pg] = stats(covRows.filter(r => r.pos_group === pg), 'yards_per_target');
  const S = {
    proe: stats(tendRows, 'proe_pct'), pace: stats(tendRows, 'plays_per_game'),
    passEpa: stats(supRows, 'pass_epa_allowed'), rushEpa: stats(supRows, 'rush_epa_allowed'),
    ypc: stats(supRows, 'ypc_allowed'), press: stats(teamPressRows, 'pressure_rate'),
    nullify: stats(penRows, 'nullify_pct'),
  };
  const zOf = (v, st) => (st && Number.isFinite(Number(v))) ? (Number(v) - st.m) / st.sd : null;

  // ---- (e) Layer-1 comp pool (unchanged, deterministic full paging) ----
  const compPoolByPos = { QB: [], RB: [], WR: [], TE: [] };
  for (const [fam, pos] of [['passing_yards', 'QB'], ['rushing_yards', 'RB'], ['receiving_yards', 'WR']]) {
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
        compPoolByPos[pos].push({
          position: pos,
          features: { volume_floor: num(r.volume_floor_score), recent_form: num(fj.recent_form) },
          outcome,
        });
      }
      if (chunk.length < 1000) break;
    }
  }
  compPoolByPos.TE = compPoolByPos.WR;
  if (!compPoolByPos.QB.length && !compPoolByPos.RB.length && !compPoolByPos.WR.length) return null;

  // ---- (f) enrich each slate player: nudges + signals + narrative + outlook ----
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const logistic = z => (z == null ? null : 1 / (1 + Math.exp(-z))); // z-floor -> 0..1 for classifier
  const featureByPlayer = {};
  let enrichCoverage = 0;

  for (const [name, gsis] of Object.entries(nameToKey)) {
    const fb = featBaseByKey[gsis];
    if (!fb) continue;
    const team = nameToTeam[name];
    const opp = team ? oppByTeam[team] : null;
    const fam = fb.propFamily;
    const isPassGame = fam === 'passing_yards' || fam === 'receiving_yards';

    const drivers = [];      // ranked {dir,f,w} for the summary
    const bullets = {};      // signal sub-objects nflCardSummary reads
    let extra = 0;
    let filled = 0, possible = 0;
    const add = (nudge, dir, label, w) => { extra += nudge; drivers.push({ dir, f: label, w: Math.abs(w ?? nudge) }); };

    // (1) GAME SCRIPT — your validated per-family projection (real weight)
    const od = team ? oddsByTeam[team] : null;
    let scriptSlot = { risk: 0, flag: false, reasons: [] };
    let scriptLean = null, scriptMargin = null;
    if (od && od.spread != null) {
      possible++;
      const sc = scriptNudge({
        spread: od.spread, gameTotal: od.total,
        teamProe: tend[team] ? Number(tend[team].proe_pct) / 100 : null,
        oppProe: opp && tend[opp] ? Number(tend[opp].proe_pct) / 100 : null,
        propFamily: fam, position: fb.position,
      });
      if (sc && Number.isFinite(sc.nudge)) {
        filled++;
        extra += sc.nudge;
        scriptLean = sc.lean; scriptMargin = sc.margin;
        if (sc.reasons?.length) drivers.push({ dir: sc.nudge >= 0 ? '+' : '-', f: sc.reasons[0], w: Math.abs(sc.nudge) });
        // volume-kill case -> real risk flag (RB trailing hard / pass-catcher leading big)
        const abandonsRun = fam === 'rushing_yards' && sc.chase >= 0.35;
        const cratersPass = isPassGame && sc.chase <= -0.35;
        if (abandonsRun || cratersPass) scriptSlot = { risk: Math.min(1, Math.abs(sc.chase)), flag: true, reasons: sc.reasons };
      }
    }
    bullets.script = scriptSlot;

    // (2) OPPONENT COVERAGE by position (yards/target allowed) — soft-matchup lift
    if (opp) {
      possible++;
      const pg = POS_GROUP[fb.position] || 'WR';
      const cr = cov[`${opp}|${pg}`];
      const st = covStatsByPos[pg];
      const z = cr ? zOf(cr.yards_per_target, st) : null;
      if (z != null && isPassGame) {
        filled++; enrichCoverage++;
        const n = clamp(z * 0.06, -0.15, 0.15);
        add(n, n >= 0 ? '+' : '-', `${opp} coverage vs ${pg}`, n);
        bullets.suppression = bullets.suppression || {};
        bullets.__coverageText = `${opp} allows ${Number(cr.yards_per_target).toFixed(1)} yds/target to ${pg}s (league ~${st.m.toFixed(1)}) — ${z >= 0 ? 'soft' : 'tough'} draw.`;
      }
    }

    // (3) SUPPRESSION (opp defense EPA allowed) — pass or rush path
    if (opp && sup[opp]) {
      possible++;
      let z = null, txt = null;
      if (isPassGame) { z = zOf(sup[opp].pass_epa_allowed, S.passEpa); if (z != null) txt = `${opp} pass D ${z >= 0 ? 'leaks' : 'suppresses'} EPA (${Number(sup[opp].pass_epa_allowed).toFixed(3)}/play).`; }
      else if (fam === 'rushing_yards') {
        const ze = zOf(sup[opp].rush_epa_allowed, S.rushEpa), zy = zOf(sup[opp].ypc_allowed, S.ypc);
        z = [ze, zy].filter(v => v != null).reduce((a, v, _, arr) => a + v / arr.length, 0) || null;
        if (z != null) txt = `${opp} run D gives ${Number(sup[opp].ypc_allowed).toFixed(1)} ypc (${z >= 0 ? 'gap-prone' : 'stout'}).`;
      }
      if (z != null) {
        filled++;
        const n = clamp(z * 0.05, -0.12, 0.12);
        add(n, n >= 0 ? '+' : '-', `${opp} ${isPassGame ? 'pass' : 'run'} suppression`, n);
        bullets.suppression = { tag: z >= 0 ? 'leaky' : 'stingy', nudge: n, reason: txt };
      }
    }

    // (4) PRESSURE ENVIRONMENT (pass game) — opp pressure suppresses; QB profile colors it
    if (isPassGame && opp && teamPress[opp]) {
      possible++;
      const z = zOf(teamPress[opp].pressure_rate, S.press);
      if (z != null) {
        filled++;
        const n = clamp(-z * 0.05, -0.12, 0.08); // more pressure -> fewer pass yds
        add(n, n >= 0 ? '+' : '-', `${opp} pressure rate`, n);
        const qp = qbPress[gsis];
        const teLean = qp ? (Number(qp.te_share_pressured) - Number(qp.te_share_clean)) : null;
        bullets.pressure = { parts: {
          checkdown: (teLean != null && teLean > 0.02)
            ? { tag: 'checkdown', reasons: [`under pressure this QB leans TE +${(teLean * 100).toFixed(0)}pp — yardage shifts short`] }
            : {},
          battle: { edge: z >= 0.4 ? 'defense' : (z <= -0.4 ? 'offense' : 'even'),
                    reasons: [`${opp} generates pressure at ${(Number(teamPress[opp].pressure_rate) * 100).toFixed(0)}%`] },
        } };
      }
    }

    // (5) PENALTY DRAG (own team) — self-inflicted erased pass plays (pass game only)
    if (isPassGame && team && pen[team]) {
      possible++;
      const z = zOf(pen[team].nullify_pct, S.nullify);
      if (z != null) {
        filled++;
        const n = clamp(-z * 0.05, -0.12, 0.05);
        if (Math.abs(n) > 0.005) add(n, '-', `${team} penalty drag`, n);
        if (z > 0.5) bullets.leakage = { parts: { penalty: { tag: 'high', reasons: [`${team} wipes ${(Number(pen[team].nullify_pct) * 100).toFixed(1)}% of pass plays on own flags (${pen[team].top_penalty || 'penalties'})`] } } };
      }
    }

    // (6) TEAM IDENTITY (PROE base) + PACE — volume lift independent of script
    if (team && tend[team]) {
      possible++;
      const zp = zOf(tend[team].proe_pct, S.proe), zpace = zOf(tend[team].plays_per_game, S.pace);
      let any = false;
      if (zp != null) {
        const dir = isPassGame ? 1 : -1;
        const n = clamp(dir * zp * 0.04, -0.08, 0.08);
        if (Math.abs(n) > 0.005) { add(n, n >= 0 ? '+' : '-', `${team} ${tend[team].identity || 'identity'}`, n); any = true; }
      }
      if (zpace != null) {
        const n = clamp(zpace * 0.03, -0.06, 0.06);
        if (Math.abs(n) > 0.005) { extra += n; drivers.push({ dir: n >= 0 ? '+' : '-', f: `${team} pace ${Number(tend[team].plays_per_game).toFixed(0)} plays/g`, w: Math.abs(n) }); any = true; }
      }
      if (any) filled++;
    }

    // (7) RECEIVER QUALITY (own) — snap security (volume) + rec_cpoe (shield), pass game
    let volumeSecureBonus = 0;
    if (isPassGame && recQual[gsis]) {
      possible++;
      const rq = recQual[gsis];
      const mean = Number(rq.offense_pct_mean), sd = Number(rq.offense_pct_sd);
      if (Number.isFinite(mean)) {
        filled++;
        const everyDown = mean >= 0.75 && (Number.isFinite(sd) ? sd <= 0.10 : true);
        const volatile = Number.isFinite(sd) && sd >= 0.20;
        volumeSecureBonus = everyDown ? 0.03 : (volatile ? -0.03 : 0);
        extra += volumeSecureBonus;
        bullets.leakage = bullets.leakage || { parts: {} };
        bullets.leakage.parts = bullets.leakage.parts || {};
        bullets.leakage.parts.snap = {
          score: +mean.toFixed(2), nudge: volumeSecureBonus,
          reasons: [`snap share ${(mean * 100).toFixed(0)}%${volatile ? ' but volatile — role shifting' : (everyDown ? ' — every-down role' : '')}`],
        };
        if (volumeSecureBonus) drivers.push({ dir: volumeSecureBonus >= 0 ? '+' : '-', f: everyDown ? 'every-down snaps' : 'volatile snaps', w: Math.abs(volumeSecureBonus) });
      }
      const cpoe = Number(rq.rec_cpoe);
      if (Number.isFinite(cpoe) && Math.abs(cpoe) >= 8) {
        bullets.leakage = bullets.leakage || { parts: {} };
        bullets.leakage.parts.resilience = { z: cpoe / 6, tag: cpoe >= 0 ? 'resilient' : 'brittle',
          reasons: [`catches ${cpoe >= 0 ? 'above' : 'below'} expected (CPOE ${cpoe.toFixed(1)}) — ${cpoe >= 0 ? 'shielded from a bad-ball day' : 'exposed to inaccuracy'}`] };
      }
    }

    // (8) ENVIRONMENT — game total lifts/suppresses all yardage (from ESPN)
    if (od && Number.isFinite(od.total)) {
      possible++;
      const zt = (od.total - 44) / 20;
      const n = clamp(zt * (isPassGame ? 0.08 : 0.05), -0.10, 0.10);
      if (Math.abs(n) > 0.005) {
        filled++;
        extra += n;
        drivers.push({ dir: n >= 0 ? '+' : '-', f: `total ${od.total}`, w: Math.abs(n) });
        bullets.env = { total: n, roof: 'game', venue: `O/U ${od.total}`, nudges: { shootout: n > 0.04 } };
      }
    }

    // ---- trailing usage detail for the volume bullet (from nfl_player_games) ----
    const usage = (usageRowsByKey[gsis] || []).slice(0, 6);
    const avg = (k) => { const xs = usage.map(r => Number(r[k])).filter(Number.isFinite); return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null; };
    const detail = {};
    const ts = avg('target_share'); if (ts != null) detail.tsMean = ts;
    const cy = avg('carries'); if (cy != null) detail.carryMean = +cy.toFixed(1);
    const at = avg('pass_attempts'); if (at != null) detail.attMean = +at.toFixed(1);

    // reconcile volume_floor z -> 0..1 for the classifier's volumeSecure filter,
    // then nudge with snap security. (Fixes the z(2.44)-vs-0..1 scale mismatch.)
    const floor01 = clamp((logistic(fb.zFloor) ?? 0.5) + volumeSecureBonus, 0, 1);
    const archetype = fb.position === 'RB' ? (detail.carryMean >= 15 ? 'bell_cow' : 'rotational_back')
      : fb.position === 'QB' ? 'passer'
      : (detail.tsMean >= 0.24 ? 'target_hog' : (detail.tsMean >= 0.16 ? 'starter' : 'role'));
    bullets.volume = { volume_floor_score: +floor01.toFixed(2), archetype, detail };

    // coverage bullet as narrative text (card reads narrative.coverage.text)
    const narrative = { drivers: drivers.sort((x, y) => (y.w || 0) - (x.w || 0)).slice(0, 6) };
    if (bullets.__coverageText) { narrative.coverage = { text: bullets.__coverageText, lean: extra >= 0 ? 'over' : 'under' }; delete bullets.__coverageText; }

    // ---- QB outlook (passing only) from suppression + pressure + total ----
    let outlook = null;
    if (fam === 'passing_yards') {
      const od2 = [];
      if (bullets.suppression?.nudge != null) od2.push({ dir: bullets.suppression.nudge >= 0 ? '+' : '-', w: Math.abs(bullets.suppression.nudge), f: 'opponent pass defense' });
      if (bullets.pressure) od2.push({ dir: (bullets.pressure.parts?.battle?.edge === 'defense') ? '-' : '+', w: 0.1, f: 'pass-rush pressure' });
      if (bullets.env?.total) od2.push({ dir: bullets.env.total >= 0 ? '+' : '-', w: Math.abs(bullets.env.total), f: 'game total' });
      const net = od2.reduce((a, d) => a + (d.dir === '+' ? d.w : -d.w), 0);
      outlook = { outlook: net > 0.05 ? 'flourish' : (net < -0.05 ? 'struggle' : 'neutral'), drivers: od2.sort((x, y) => y.w - x.w).slice(0, 4) };
    }

    featureByPlayer[name] = {
      position: fb.position,
      features: fb.features,                         // 2D kNN target (unchanged)
      volume: bullets.volume,                        // 0..1 floor + detail + archetype
      script: bullets.script,
      extraNudges: +clamp(extra, -0.5, 0.5).toFixed(4),
      scriptLean, scriptMargin,
      signals: bullets,
      narrative,
      outlook,
      dataCompleteness: possible ? +(filled / possible).toFixed(2) : null,
    };
  }

  if (!Object.keys(featureByPlayer).length) return null;
  return { ready: true, compPoolByPos, featureByPlayer, nameToTeam, oppByTeam, enrichCoverage };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
