// api/_lib/data.js
// Core data-fetching helpers used by both standalone endpoints and analyze.js
// This avoids the Vercel "function calling function" 404 issue.

import { getAbbr } from '../_data/teams.js';
import { fetchSavantCSV, arsenalURL, arsenalVeloURL, expectedStatsURL } from './savant.js';

// PHASE 1 OF DAMAGE QUALITY SYSTEM (May 9, 2026)
//
// Added batted-ball % column selections: groundballs/flyballs/linedrives/popups
// percentages, plus sweet-spot% and pull/oppo distribution. These power the
// damage quality archetype classifier (Phase 2).
//
// Column name reality check: Savant has used multiple naming conventions over
// the years. Current schema (verified in browser dev-tools against the live
// custom CSV) uses these exact slugs:
//   - groundballs_percent, flyballs_percent, linedrives_percent, popups_percent
//   - sweet_spot_percent
//   - pull_percent, straightaway_percent, oppo_percent
//
// If any column returns empty across all rows, the data layer logs a warning
// and downstream classification falls back to "BALANCED" archetype rather
// than producing garbage. See the brl_percent fallback chain below for
// the same pattern.
const CUSTOM_URL = (season) =>
  `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=batter&filter=&min=10&selections=` +
  `exit_velocity_avg%2C` +
  `launch_angle_avg%2C` +
  `brl_percent%2C` +
  `hard_hit_percent%2C` +
  `k_percent%2C` +
  `bb_percent%2C` +
  `groundballs_percent%2C` +
  `flyballs_percent%2C` +
  `linedrives_percent%2C` +
  `popups_percent%2C` +
  `sweet_spot_percent%2C` +
  `pull_percent%2C` +
  `straightaway_percent%2C` +
  `oppo_percent` +
  `&chart=false&x=exit_velocity_avg&y=exit_velocity_avg&r=no&chartType=beeswarm&sortDir=desc&csv=true`;

// Statcast batted-ball leaderboard — separate endpoint from the custom CSV.
// As of the 2026 season, Savant's /leaderboard/custom CSV stopped returning
// `brl_percent` values (column header still appears, cells are empty). The
// /leaderboard/statcast endpoint still returns Barrel% reliably under the same
// column name, so we fetch it in parallel and merge brl_percent from here.
// This endpoint also exposes `barrels` (count) and `brl_pa` (barrels-per-PA),
// which we don't currently use but could swap to in a future refactor.
const STATCAST_URL = (season) =>
  `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${season}&position=&team=&min=10&csv=true`;

// Fetch today's slate with probable pitchers + handedness
export async function getProbables(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,venue`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`MLB API ${response.status}`);

  const data = await response.json();
  const games = [];
  const pitcherIds = new Set();

  if (data.dates?.length > 0) {
    for (const d of data.dates) {
      for (const game of d.games) {
        const gameTime = new Date(game.gameDate).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
        }) + ' ET';
        // ET date (YYYY-MM-DD) for odds lookup
        const gameDateET = new Date(game.gameDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

        const awayTeamId = game.teams.away.team.id;
        const homeTeamId = game.teams.home.team.id;
        const awayPP = game.teams.away.probablePitcher;
        const homePP = game.teams.home.probablePitcher;

        if (awayPP?.id) pitcherIds.add(awayPP.id);
        if (homePP?.id) pitcherIds.add(homePP.id);

        games.push({
          gamePk: game.gamePk,
          awayTeam: {
            id: awayTeamId,
            name: game.teams.away.team.name,
            abbreviation: getAbbr(awayTeamId, game.teams.away.team.teamName)
          },
          homeTeam: {
            id: homeTeamId,
            name: game.teams.home.team.name,
            abbreviation: getAbbr(homeTeamId, game.teams.home.team.teamName)
          },
          awayPitcher: awayPP ? { id: awayPP.id, name: awayPP.fullName, hand: 'R' } : null,
          homePitcher: homePP ? { id: homePP.id, name: homePP.fullName, hand: 'R' } : null,
          venue: game.venue?.name || '',
          gameTime,
          gameDateET,
          status: game.status?.detailedState || ''
        });
      }
    }
  }

  // Batch-fetch pitcher hands
  if (pitcherIds.size > 0) {
    try {
      const ids = [...pitcherIds].join(',');
      const pr = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${ids}`, { signal: AbortSignal.timeout(5000) });
      if (pr.ok) {
        const pdata = await pr.json();
        const handMap = {};
        (pdata.people || []).forEach(p => { handMap[p.id] = p.pitchHand?.code || 'R'; });
        games.forEach(g => {
          if (g.awayPitcher) g.awayPitcher.hand = handMap[g.awayPitcher.id] || 'R';
          if (g.homePitcher) g.homePitcher.hand = handMap[g.homePitcher.id] || 'R';
        });
      }
    } catch (_) {}
  }

  return { date, games };
}

// Get a pitcher's arsenal
//
// TIER 2 (PITCHER VELOCITY): the pitch-arsenal-stats leaderboard does NOT carry
// pitch velocity. We ALSO fetch pitch-arsenals?type=avg_speed (wide format, one
// <code>_avg_speed column per pitch type) in parallel and merge raw avg velocity
// (mph) onto each pitch row as `velo`. Velo failure is soft — `velo` is null and
// the archetype falls back to whiff-only. Never fabricated. The velo-vs-league
// delta is computed downstream in index.html. Matched pair: deploy data.js +
// savant.js before analyze.js.
export async function getPitcherArsenal(mlbam, season) {
  const pid = String(mlbam).trim();
  const [rows, veloRows] = await Promise.all([
    fetchSavantCSV(arsenalURL(season, 'pitcher')),
    fetchSavantCSV(arsenalVeloURL(season)).catch(() => [])
  ]);
  const veloRow = veloRows.find(r => String(r.pitcher || r.player_id || '').trim() === pid) || null;
  const veloFor = (typeCode) => {
    if (!veloRow || !typeCode) return null;
    const col = `${String(typeCode).toLowerCase()}_avg_speed`;
    const v = veloRow[col];
    const n = v != null && v !== '' ? parseFloat(v) : NaN;
    return Number.isFinite(n) ? +n.toFixed(1) : null;
  };
  const myRows = rows.filter(r => String(r.player_id).trim() === pid);
  return myRows.map(r => ({
    type: r.pitch_name || r.pitch_type || '',
    typeCode: r.pitch_type || '',
    usage: r.pitch_usage ? parseFloat(r.pitch_usage).toFixed(1) : null,
    whiffPct: r.whiff_percent ? parseFloat(r.whiff_percent).toFixed(1) : null,
    kPct: r.k_percent ? parseFloat(r.k_percent).toFixed(1) : null,
    xwoba: r.est_woba ? parseFloat(r.est_woba).toFixed(3) : null,
    ba: r.ba ? parseFloat(r.ba).toFixed(3) : null,
    slg: r.slg ? parseFloat(r.slg).toFixed(3) : null,
    hardHitPct: r.hard_hit_percent ? parseFloat(r.hard_hit_percent).toFixed(1) : null,
    velo: veloFor(r.pitch_type),
    pitches: parseInt(r.pitches) || 0
  })).filter(p => p.type && p.pitches > 0)
    .sort((a, b) => parseFloat(b.usage || 0) - parseFloat(a.usage || 0));
}

// Build a team's bullpen composite arsenal - aggregated pitch-type usage
// across all relievers (excluding today's SP), weighted by pitches thrown.
// Returns arsenal in same shape as getPitcherArsenal().
export async function getBullpenProfile(teamAbbr, season, excludePitcherId) {
  // Savant uses team_name_alt codes like NYY, LAD, etc. Some differ:
  const abbr = (teamAbbr === 'CWS' ? 'CHW' :
                teamAbbr === 'WSH' ? 'WSH' :
                teamAbbr === 'ATH' ? 'OAK' :
                teamAbbr === 'AZ'  ? 'AZ'  : teamAbbr);

  const allRows = await fetchSavantCSV(arsenalURL(season, 'pitcher'));
  const excludeId = String(excludePitcherId || '').trim();

  // Filter to this team, excluding the starter
  const teamRows = allRows.filter(r => {
    const t = String(r.team_name_alt || '').trim();
    const pid = String(r.player_id || '').trim();
    // Accept common variants
    return (t === abbr || t === teamAbbr) && pid !== excludeId;
  });

  if (teamRows.length === 0) return { pitches: [], pitcherCount: 0 };

  // Identify relievers by checking who has low per-pitcher total pitch volume
  // (SPs typically have 200+ pitches of one type; RPs have < 100)
  // Group by player, sum pitches
  const playerTotals = {};
  teamRows.forEach(r => {
    const pid = String(r.player_id);
    if (!playerTotals[pid]) playerTotals[pid] = 0;
    playerTotals[pid] += parseInt(r.pitches) || 0;
  });

  // For reliever identification use a threshold - RPs rarely have > 300 total pitches per pitch-type early season
  // but this is secondary; the primary filter is "not today's starter"
  const relieverIds = new Set(Object.keys(playerTotals));

  // Filter to reliever rows only
  const rpRows = teamRows.filter(r => relieverIds.has(String(r.player_id)));

  // Aggregate by pitch type: weighted average of usage, xwoba, etc.
  // Weight by total pitches thrown across the bullpen
  const byPitch = {};
  let totalPitchesAll = 0;
  rpRows.forEach(r => {
    const pitches = parseInt(r.pitches) || 0;
    if (pitches < 5) return; // ignore tiny samples
    totalPitchesAll += pitches;
    const key = r.pitch_name || r.pitch_type || 'Unknown';
    if (!byPitch[key]) {
      byPitch[key] = {
        type: key,
        typeCode: r.pitch_type,
        totalPitches: 0,
        weightedXwoba: 0,
        weightedSlg: 0,
        weightedWhiff: 0,
        weightedHardHit: 0,
        pitcherCount: 0
      };
    }
    const bp = byPitch[key];
    bp.totalPitches += pitches;
    bp.pitcherCount += 1;
    if (r.est_woba) bp.weightedXwoba += parseFloat(r.est_woba) * pitches;
    if (r.slg) bp.weightedSlg += parseFloat(r.slg) * pitches;
    if (r.whiff_percent) bp.weightedWhiff += parseFloat(r.whiff_percent) * pitches;
    if (r.hard_hit_percent) bp.weightedHardHit += parseFloat(r.hard_hit_percent) * pitches;
  });

  // Convert aggregates into final arsenal rows
  const pitches = Object.values(byPitch).map(bp => ({
    type: bp.type,
    typeCode: bp.typeCode,
    // Usage in bullpen = share of this pitch across all bullpen pitches
    usage: totalPitchesAll > 0 ? ((bp.totalPitches / totalPitchesAll) * 100).toFixed(1) : '0',
    xwoba: bp.totalPitches > 0 ? (bp.weightedXwoba / bp.totalPitches).toFixed(3) : null,
    slg:   bp.totalPitches > 0 ? (bp.weightedSlg   / bp.totalPitches).toFixed(3) : null,
    whiffPct: bp.totalPitches > 0 ? (bp.weightedWhiff / bp.totalPitches).toFixed(1) : null,
    hardHitPct: bp.totalPitches > 0 ? (bp.weightedHardHit / bp.totalPitches).toFixed(1) : null,
    pitches: bp.totalPitches,
    pitcherCount: bp.pitcherCount
  })).filter(p => p.type && p.pitches >= 20)  // require meaningful sample
    .sort((a, b) => parseFloat(b.usage) - parseFloat(a.usage));

  return {
    pitches,
    pitcherCount: Object.keys(playerTotals).length,
    totalPitches: totalPitchesAll
  };
}

// Get team lineup (posted or active-roster fallback)
export async function getLineup(teamId, gamePk, side) {
  let hitters = [];
  // (Drop #4 — May 30, 2026) Lineup confirmation tracking.
  // 'official' = battingOrder populated from MLB boxscore (lineup posted by team)
  // 'projected' = fell through to roster fallback (lineup not yet posted)
  // 'unknown' = no data, edge case
  // Surfaces in UI as confirmation chip so user knows when to manually verify.
  let lineupSource = 'unknown';
  const fetchedAt = Date.now();

  if (gamePk) {
    try {
      const boxRes = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { signal: AbortSignal.timeout(6000) });
      if (boxRes.ok) {
        const box = await boxRes.json();
        const teamSide = side === 'home' ? 'home' : 'away';
        const teamBox = box.teams?.[teamSide];
        const battingOrder = teamBox?.battingOrder || [];
        if (battingOrder.length > 0) {
          // The team has POSTED an official batting order — this is the
          // signal that the lineup is locked in (or near-locked).
          lineupSource = 'official';
          for (const batterId of battingOrder) {
            const p = teamBox.players?.[`ID${batterId}`];
            if (p) {
              // MLB API returns battingOrder as "100" for leadoff, "200" for 2nd, etc.
              // (slot × 100 + sub-position). Normalize to 1-9.
              const rawOrder = p.battingOrder || '';
              const slot = rawOrder ? Math.floor(parseInt(rawOrder) / 100) : '';
              hitters.push({
                id: batterId,
                name: p.person?.fullName || '',
                position: p.position?.abbreviation || '',
                battingOrder: slot || '',
                hand: 'R' // placeholder - batSide not in boxscore, we batch-fetch below
              });
            }
          }
        }
      }
    } catch (_) {}
  }

  if (hitters.length === 0 && teamId) {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&hydrate=person`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Roster API ${r.status}`);
    const data = await r.json();

    hitters = (data.roster || [])
      .filter(p => p.position?.type !== 'Pitcher' && p.position?.abbreviation !== 'P')
      .map(p => ({
        id: p.person.id,
        name: p.person.fullName,
        position: p.position?.abbreviation || '',
        battingOrder: '',
        hand: p.person.batSide?.code || 'R'
      }));
    // (Drop #4) Roster fallback — lineup is projected, not confirmed
    lineupSource = 'projected';
    // Attach metadata as non-enumerable property so existing iteration works unchanged
    Object.defineProperty(hitters, '_lineupMeta', {
      value: { source: lineupSource, fetchedAt },
      enumerable: false,
      writable: true
    });
    return hitters;
  }

  // Boxscore path: batch-fetch bat hands from people endpoint
  if (hitters.length > 0) {
    try {
      const ids = hitters.map(h => h.id).join(',');
      const pr = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${ids}`, { signal: AbortSignal.timeout(5000) });
      if (pr.ok) {
        const pdata = await pr.json();
        const handMap = {};
        (pdata.people || []).forEach(p => { handMap[p.id] = p.batSide?.code || 'R'; });
        hitters.forEach(h => { h.hand = handMap[h.id] || 'R'; });
      }
    } catch (_) {}
  }

  // (Drop #4) Attach metadata as non-enumerable property
  Object.defineProperty(hitters, '_lineupMeta', {
    value: { source: lineupSource, fetchedAt },
    enumerable: false,
    writable: true
  });
  return hitters;
}

// Get hitter Statcast data
export async function getHitterStats(mlbam, season) {
  const pid = String(mlbam).trim();

  const [arsenalRows, expectedRows, customRows, statcastRows] = await Promise.all([
    fetchSavantCSV(arsenalURL(season, 'batter')).catch(() => []),
    fetchSavantCSV(expectedStatsURL(season, 'batter')).catch(() => []),
    fetchSavantCSV(CUSTOM_URL(season)).catch(() => []),
    fetchSavantCSV(STATCAST_URL(season)).catch(() => [])
  ]);

  const myArsenal = arsenalRows.filter(r => String(r.player_id).trim() === pid);
  const pitchTypes = myArsenal.map(r => ({
    type: r.pitch_name || r.pitch_type || '',
    typeCode: r.pitch_type || '',
    pitches: parseInt(r.pitches) || 0,
    pa: parseInt(r.pa) || 0,
    xwoba: r.est_woba ? parseFloat(r.est_woba).toFixed(3) : null,
    xba: r.est_ba ? parseFloat(r.est_ba).toFixed(3) : null,
    xslg: r.est_slg ? parseFloat(r.est_slg).toFixed(3) : null,
    whiffPct: r.whiff_percent ? parseFloat(r.whiff_percent).toFixed(1) : null,
    kPct: r.k_percent ? parseFloat(r.k_percent).toFixed(1) : null
  })).filter(p => p.type && p.pa > 0);

  const expRow = expectedRows.find(r => String(r.player_id).trim() === pid) || {};
  const custRow = customRows.find(r => String(r.player_id).trim() === pid) || {};
  const statcastRow = statcastRows.find(r => String(r.player_id).trim() === pid) || {};

  // Barrel% — read from the statcast endpoint first (custom endpoint returns
  // empty cells as of 2026), fall back to custom variants if statcast is
  // unavailable. Empty-string check handles the case where Savant returns
  // `""` instead of an absent field. The fallbacks preserve resilience if
  // Savant restores brl_percent in the custom CSV later.
  const brlRaw = (statcastRow.brl_percent !== '' && statcastRow.brl_percent != null) ? statcastRow.brl_percent
              : (custRow.brl_percent !== '' && custRow.brl_percent != null) ? custRow.brl_percent
              : custRow.barrel_batted_rate
              ?? custRow.barrels_per_pa_percent
              ?? custRow.barrel_pct
              ?? null;
  if (brlRaw == null && Object.keys(custRow).length > 0 && process.env.NODE_ENV !== 'production') {
    // Both endpoints failed to provide barrel data — Savant schema likely shifted.
    // Log once per session would be ideal but a simple console.warn is enough for now.
    console.warn('[data.js] no brl_percent from custom or statcast endpoints. custRow keys:',
                 Object.keys(custRow).slice(0, 20),
                 'statcastRow keys:', Object.keys(statcastRow).slice(0, 20));
  }

  // PHASE 1 DAMAGE QUALITY: Read batted-ball percentages with defensive parsing.
  // Each field uses the same empty-string-check pattern as brl_percent because
  // Savant returns `""` when a column is requested but the underlying value is
  // unavailable (small sample, recent call-up, etc.). Returning null in those
  // cases lets the classifier (Phase 2) fall back to BALANCED rather than
  // computing on bad data.
  //
  // Fallback aliases included for the most common Savant rename patterns.
  // If all fail, the field is null and the classifier ignores it.
  const parsePctField = (row, ...fieldNames) => {
    for (const name of fieldNames) {
      const raw = row[name];
      if (raw !== '' && raw != null && !isNaN(parseFloat(raw))) {
        return parseFloat(raw).toFixed(1);
      }
    }
    return null;
  };

  const gbPct = parsePctField(custRow, 'groundballs_percent', 'gb_percent', 'ground_ball_percent');
  const fbPct = parsePctField(custRow, 'flyballs_percent', 'fb_percent', 'fly_ball_percent');
  const ldPct = parsePctField(custRow, 'linedrives_percent', 'ld_percent', 'line_drive_percent');
  const puPct = parsePctField(custRow, 'popups_percent', 'pu_percent', 'popup_percent');
  const sweetSpotPct = parsePctField(custRow, 'sweet_spot_percent', 'sweetspot_percent');
  const pullPct = parsePctField(custRow, 'pull_percent');
  const straightawayPct = parsePctField(custRow, 'straightaway_percent', 'straight_percent');
  const oppoPct = parsePctField(custRow, 'oppo_percent', 'opposite_percent');
  // Tier 3: average launch angle — HR/multi-hit banner input. Null if absent.
  const launchAngleAvg = (custRow.launch_angle_avg !== '' && custRow.launch_angle_avg != null && !isNaN(parseFloat(custRow.launch_angle_avg))) ? parseFloat(custRow.launch_angle_avg).toFixed(1) : null;

  // Phase 1 diagnostic: log once per process start whether the batted-ball
  // columns are populating. If GB/FB/LD all return null for a hitter that
  // has barrel% data (so we know the row is non-empty), the URL selections
  // probably need updating.
  if (gbPct == null && fbPct == null && ldPct == null && brlRaw != null && process.env.NODE_ENV !== 'production') {
    console.warn('[data.js] Phase 1 damage quality: batted-ball columns empty despite valid row. custRow keys:',
                 Object.keys(custRow).slice(0, 30));
  }

  return {
    overall: {
      xwoba: { value: expRow.est_woba ? parseFloat(expRow.est_woba).toFixed(3) : null },
      xba: { value: expRow.est_ba ? parseFloat(expRow.est_ba).toFixed(3) : null },
      xslg: { value: expRow.est_slg ? parseFloat(expRow.est_slg).toFixed(3) : null },
      barrel_batted_rate: { value: brlRaw != null ? parseFloat(brlRaw).toFixed(1) : null },
      hard_hit_percent: { value: custRow.hard_hit_percent ? parseFloat(custRow.hard_hit_percent).toFixed(1) : null },
      avg_exit_velocity: { value: custRow.exit_velocity_avg ? parseFloat(custRow.exit_velocity_avg).toFixed(1) : null },
      k_percent: { value: custRow.k_percent ? parseFloat(custRow.k_percent).toFixed(1) : null },
      // (Fixed — bb_percent was already requested in CUSTOM_URL's selections
      // list but was never mapped into the returned `overall` object, so
      // seasonStats.bbPct downstream always resolved to null. Same
      // empty-string guard pattern as k_percent/hard_hit_percent.)
      bb_percent: { value: (custRow.bb_percent !== '' && custRow.bb_percent != null) ? parseFloat(custRow.bb_percent).toFixed(1) : null },
      // PHASE 1 DAMAGE QUALITY fields — null when Savant doesn't return data
      gb_percent: { value: gbPct },
      fb_percent: { value: fbPct },
      ld_percent: { value: ldPct },
      popup_percent: { value: puPct },
      sweet_spot_percent: { value: sweetSpotPct },
      pull_percent: { value: pullPct },
      straightaway_percent: { value: straightawayPct },
      oppo_percent: { value: oppoPct },
      launch_angle: { value: launchAngleAvg }
    },
    pitchTypes
  };
}

// Get a hitter's platoon splits (vs RHP and vs LHP)
// Uses MLB Stats API statSplits endpoint with situation codes vr/vl
// Returns { vsR: {ops, avg, slg, pa, ...}, vsL: {...} }
export async function getHitterSplits(mlbam, season) {
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=statSplits&group=hitting&season=${season}&sitCodes=vr,vl`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { vsR: null, vsL: null };
    const data = await r.json();

    const splits = { vsR: null, vsL: null };
    for (const block of (data.stats || [])) {
      for (const split of (block.splits || [])) {
        const code = split.split?.code;
        const s = split.stat || {};
        const row = {
          avg: s.avg || null,
          obp: s.obp || null,
          slg: s.slg || null,
          ops: s.ops || null,
          pa: s.plateAppearances || 0,
          hr: s.homeRuns || 0,
          k: s.strikeOuts || 0,
          bb: s.baseOnBalls || 0,
          h: s.hits || 0,
          doubles: s.doubles || 0,
          triples: s.triples || 0
        };
        // K rate fallback chain: prefer K/PA, fall back to K/AB when PA is 0
        // (MLB API occasionally returns PA=0 for early-season low-sample splits)
        if (row.pa > 0) {
          row.kPct = ((row.k / row.pa) * 100).toFixed(1);
        } else if (s.atBats && s.atBats > 0 && row.k > 0) {
          row.kPct = ((row.k / s.atBats) * 100).toFixed(1);
          row.pa = s.atBats;  // surface AB as PA for display
        } else {
          row.kPct = null;
        }
        row.iso = s.sluggingPct && s.battingAvg
          ? (parseFloat(s.sluggingPct) - parseFloat(s.battingAvg)).toFixed(3)
          : null;
        if (code === 'vr') splits.vsR = row;
        else if (code === 'vl') splits.vsL = row;
      }
    }
    return splits;
  } catch (err) {
    return { vsR: null, vsL: null };
  }
}

// Get a pitcher's splits vs LHB and RHB
export async function getPitcherSplits(mlbam, season) {
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=statSplits&group=pitching&season=${season}&sitCodes=vr,vl`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { vsR: null, vsL: null };
    const data = await r.json();

    const splits = { vsR: null, vsL: null };
    for (const block of (data.stats || [])) {
      for (const split of (block.splits || [])) {
        const code = split.split?.code;
        const s = split.stat || {};
        const row = {
          avg: s.avg || null,
          opsAgainst: s.ops || null,
          slgAgainst: s.slg || null,
          obpAgainst: s.obp || null,
          pa: s.plateAppearances || 0,
          hr: s.homeRuns || 0,
          k: s.strikeOuts || 0,
          bb: s.baseOnBalls || 0,
          hitsAllowed: s.hits || 0
        };
        // Compute K% from K/PA, with fallback to AB-based denominator if PA is 0.
        // MLB Stats API can return PA=0 for some early-season splits even when
        // K and AB are populated. AB is always >= K so we can use it as a
        // safe denominator when PA is missing. K rate from AB is slightly higher
        // than K rate from PA (PA includes walks/HBP that AB doesn't), so this
        // is a small over-estimate when used as fallback — acceptable for display.
        if (row.pa > 0) {
          row.kPct = ((row.k / row.pa) * 100).toFixed(1);
          row.bbPct = ((row.bb / row.pa) * 100).toFixed(1);
        } else if (s.atBats && s.atBats > 0 && row.k > 0) {
          // PA missing but AB+K available — use AB as fallback denominator
          row.kPct = ((row.k / s.atBats) * 100).toFixed(1);
          row.bbPct = row.bb > 0 ? ((row.bb / s.atBats) * 100).toFixed(1) : null;
          // Update PA to AB so display doesn't show 0PA
          row.pa = s.atBats;
        } else {
          row.kPct = null;
          row.bbPct = null;
        }
        // 'vr' for pitcher = vs RHB, 'vl' = vs LHB
        if (code === 'vr') splits.vsR = row;
        else if (code === 'vl') splits.vsL = row;
      }
    }
    return splits;
  } catch (err) {
    return { vsR: null, vsL: null };
  }
}

// =============================================================
// Home / Road splits for pitchers
// =============================================================
// MLB Stats API exposes h (home) and a (away/road) sitCodes for pitchers.
// Returns OPS-against, K%, BB%, and PA per location. Useful for catching
// dome-vs-outdoor and altitude effects (e.g., a pitcher who's significantly
// worse at Coors than at home).
//
// Returns { home: { ... }, road: { ... } } or { home: null, road: null } on failure.
export async function getPitcherHomeRoadSplits(mlbam, season) {
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=statSplits&group=pitching&season=${season}&sitCodes=h,a`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { home: null, road: null };
    const data = await r.json();

    const splits = { home: null, road: null };
    for (const block of (data.stats || [])) {
      for (const split of (block.splits || [])) {
        const code = split.split?.code;
        const s = split.stat || {};
        const row = {
          opsAgainst: s.ops || null,
          eraStr: s.era || null,
          pa: s.plateAppearances || 0,
          ip: s.inningsPitched || null,
          k: s.strikeOuts || 0,
          bb: s.baseOnBalls || 0,
          hr: s.homeRuns || 0,
        };
        row.kPct = row.pa > 0 ? ((row.k / row.pa) * 100).toFixed(1) : null;
        if (code === 'h') splits.home = row;
        else if (code === 'a') splits.road = row;
      }
    }
    return splits;
  } catch (err) {
    return { home: null, road: null };
  }
}

// =============================================================
// Recent starts for pitchers (last 3-5)
// =============================================================
// Returns the pitcher's most recent N starts with IP, K, BB, ER, opponent.
// Used by the pitcher props panel to show form trend (e.g., "trending short").
//
// Returns array of { date, opp, ip, k, bb, er, hits, hr, decision } sorted recent first.
export async function getPitcherRecentStarts(mlbam, season, n = 3) {
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=gameLog&group=pitching&season=${season}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const data = await r.json();

    const games = [];
    for (const block of (data.stats || [])) {
      for (const split of (block.splits || [])) {
        const s = split.stat || {};
        // Filter to actual starts (IP >= 1.0 typically; some openers go <1)
        const ipStr = s.inningsPitched || '0.0';
        const ip = parseFloat(ipStr);
        if (ip < 0.1) continue;  // skip blowouts/relief 0-out appearances
        games.push({
          date: split.date,
          opp: split.opponent?.abbreviation || split.opponent?.name || '?',
          ip,
          ipStr,
          k: parseInt(s.strikeOuts) || 0,
          bb: parseInt(s.baseOnBalls) || 0,
          er: parseInt(s.earnedRuns) || 0,
          hits: parseInt(s.hits) || 0,
          hr: parseInt(s.homeRuns) || 0,
          decision: s.note || null,  // W/L/ND/SV in some contexts
        });
      }
    }
    // Sort by date descending and take top N
    games.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return games.slice(0, n);
  } catch (err) {
    return [];
  }
}

// =============================================================
// Hitter vs specific pitcher — "does he rake against this arm" (BvP)
// =============================================================
// (Added July 2026) The mirror of getPitcherVsTeam: some hitters genuinely own
// specific pitchers. Uses MLB's dedicated vsPlayer stats endpoint, which
// returns a batter's exact career line against one pitcher (the authoritative
// BvP source — not a gameLog approximation).
//
// IMPORTANT HONESTY NOTE: BvP samples are tiny and notoriously noisy — a 6-for-12
// line is 12 at-bats, which regresses hard to a hitter's true talent. This
// function returns the real numbers but flags the sample size prominently and
// only sets `owns` on a threshold that requires BOTH a strong line AND enough
// AB to be more than pure noise. We never badge a 3-for-5 as "owns."
export async function getHitterVsPitcher(batterId, pitcherId) {
  if (!batterId || !pitcherId) return null;
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();

    // The vsPlayerTotal group carries the career aggregate line.
    let total = null;
    for (const block of (data.stats || [])) {
      const groupName = block.type?.displayName || block.group?.displayName || '';
      if (groupName === 'vsPlayerTotal' || groupName === 'vsPlayer') {
        // last split in the total group is the career aggregate
        const splits = block.splits || [];
        if (splits.length) {
          const s = splits[splits.length - 1].stat || {};
          if (s.atBats != null) total = s;
        }
      }
    }
    if (!total || total.atBats == null) return null;

    const ab = parseInt(total.atBats) || 0;
    const pa = parseInt(total.plateAppearances) || ab;
    if (ab < 5) return null;   // under 5 AB is not even worth showing

    const h = parseInt(total.hits) || 0;
    const hr = parseInt(total.homeRuns) || 0;
    const k = parseInt(total.strikeOuts) || 0;
    const bb = parseInt(total.baseOnBalls) || 0;
    const avg = parseFloat(total.avg) || (ab > 0 ? h / ab : 0);
    const ops = parseFloat(total.ops) || null;

    // "Owns" requires a genuinely strong line AND a sample past pure-noise
    // territory. 10+ AB with .900+ OPS (or multiple HR) is the bar. Below that
    // it's shown as history, not a domination badge.
    let owns = false, reason = null;
    if (ab >= 10 && ((ops != null && ops >= 0.900) || hr >= 2)) {
      owns = true;
      reason = `${h}-for-${ab} (.${String(Math.round(avg*1000)).padStart(3,'0')})${hr ? `, ${hr} HR` : ''}${ops != null ? `, ${ops.toFixed(3)} OPS` : ''} career vs this pitcher`;
    }

    return {
      ab, pa, hits: h, hr, k, bb,
      avg: +avg.toFixed(3),
      ops,
      owns,
      reason,
      // Sample-quality flag so the UI never presents tiny samples as firm.
      sampleTier: ab >= 20 ? 'solid' : ab >= 10 ? 'moderate' : 'thin',
      noisy: ab < 15
    };
  } catch (err) {
    return null;
  }
}

// =============================================================
// Pitcher vs specific team — "does he own this lineup" history
// =============================================================
// (Added July 2026) A pitcher's history against a SPECIFIC opponent is a real,
// nameable edge — some arms genuinely shut down certain lineups repeatedly
// (the Matthew Liberatore vs ATL case that prompted this). Uses the same
// gameLog endpoint as getPitcherRecentStarts, but pulls the current season
// plus up to two prior seasons and filters to starts against `oppAbbr`, so the
// sample spans real head-to-head history rather than one lucky start.
//
// Returns null when there's no meaningful history (< 2 starts vs the team) —
// one prior start is an anecdote, not a pattern; we don't badge anecdotes.
// Otherwise returns aggregate line + a domination read (ERA/K-rate/whether he
// has consistently suppressed them).
export async function getPitcherVsTeam(mlbam, oppAbbr, currentSeason, opts = {}) {
  if (!mlbam || !oppAbbr) return null;
  const lookbackSeasons = opts.lookbackSeasons || 3;   // current + 2 prior
  const seasons = [];
  for (let i = 0; i < lookbackSeasons; i++) seasons.push(currentSeason - i);
  const oppUpper = String(oppAbbr).toUpperCase();

  try {
    const allStarts = [];
    await Promise.all(seasons.map(async (season) => {
      const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=gameLog&group=pitching&season=${season}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      const data = await r.json();
      for (const block of (data.stats || [])) {
        for (const split of (block.splits || [])) {
          const oppA = (split.opponent?.abbreviation || '').toUpperCase();
          if (oppA !== oppUpper) continue;
          const s = split.stat || {};
          const ip = parseFloat(s.inningsPitched || '0.0');
          if (ip < 0.1) continue;
          allStarts.push({
            date: split.date, season,
            ip, ipStr: s.inningsPitched || '0.0',
            k: parseInt(s.strikeOuts) || 0,
            bb: parseInt(s.baseOnBalls) || 0,
            er: parseInt(s.earnedRuns) || 0,
            hits: parseInt(s.hits) || 0,
            hr: parseInt(s.homeRuns) || 0,
            battersFaced: parseInt(s.battersFaced) || 0
          });
        }
      }
    }));

    if (allStarts.length < 2) return null;   // need a pattern, not an anecdote

    allStarts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const totIp = allStarts.reduce((s, g) => s + g.ip, 0);
    const totEr = allStarts.reduce((s, g) => s + g.er, 0);
    const totK = allStarts.reduce((s, g) => s + g.k, 0);
    const totBb = allStarts.reduce((s, g) => s + g.bb, 0);
    const totBf = allStarts.reduce((s, g) => s + g.battersFaced, 0);
    const era = totIp > 0 ? (totEr * 9 / totIp) : null;
    const kRate = totBf > 0 ? (totK / totBf) : null;
    const kPer9 = totIp > 0 ? (totK * 9 / totIp) : null;
    const avgIp = totIp / allStarts.length;

    // Domination read: consistently low ERA + solid length across multiple
    // starts = a genuine "owns this team" pattern. Thresholds intentionally
    // conservative so a badge means something.
    let owns = false, reason = null;
    if (allStarts.length >= 2 && era != null && era <= 2.50 && avgIp >= 5.0) {
      owns = true;
      reason = `${allStarts.length} career starts vs ${oppUpper}: ${era.toFixed(2)} ERA, ${avgIp.toFixed(1)} IP/start${kPer9 != null ? `, ${kPer9.toFixed(1)} K/9` : ''}`;
    }

    return {
      oppAbbr: oppUpper,
      starts: allStarts.length,
      totalIp: +totIp.toFixed(1),
      era: era != null ? +era.toFixed(2) : null,
      kRate: kRate != null ? +(kRate * 100).toFixed(1) : null,
      kPer9: kPer9 != null ? +kPer9.toFixed(1) : null,
      avgIp: +avgIp.toFixed(1),
      totalHr: allStarts.reduce((s, g) => s + g.hr, 0),
      owns, reason,
      recentStarts: allStarts.slice(0, 4)
    };
  } catch (err) {
    return null;
  }
}

// =============================================================
// Pitcher career stats — for novelty detection
// =============================================================
// Pulls career-level pitching stats from MLB Stats API. Used by the pitcher
// novelty detector to flag rookies and recent call-ups whose lineups have
// minimal MLB exposure to their arsenal. Same endpoint pattern as
// batterRisp.js but on the pitching group.
//
// Returns: { careerPa, careerIp, careerStarts, careerKs, isRookieOrCallup }
// or null on fetch failure.
//
// "Rookie or callup" is defined as career PA faced < 150 — captures both
// debut starts and pitchers within their first dozen MLB outings. Magnitude
// based on the Yesavage failure mode + known debut performances (Strider,
// Skenes) showing dominant first-time-through-order effects below this threshold.
export async function getPitcherCareerStats(mlbam) {
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=careerRegularSeason&group=pitching`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();

    const split = data?.stats?.[0]?.splits?.[0]?.stat;
    if (!split) {
      // No career stats means no MLB tape — true rookie / first start
      return {
        careerPa: 0,
        careerIp: 0,
        careerStarts: 0,
        careerKs: 0,
        isRookieOrCallup: true,
        noviceTier: 'HIGH'  // strongest novelty
      };
    }

    const careerPa = parseInt(split.battersFaced) || 0;
    const careerIpRaw = parseFloat(split.inningsPitched) || 0;
    const careerStarts = parseInt(split.gamesStarted) || 0;
    const careerKs = parseInt(split.strikeOuts) || 0;

    // Tier classification
    let noviceTier = 'NONE';
    if (careerPa < 50 || careerStarts < 3) noviceTier = 'HIGH';
    else if (careerPa < 150 || careerStarts < 8) noviceTier = 'MODERATE';

    return {
      careerPa,
      careerIp: careerIpRaw,
      careerStarts,
      careerKs,
      isRookieOrCallup: noviceTier !== 'NONE',
      noviceTier
    };
  } catch (err) {
    return null;
  }
}

// =============================================================
// DEEP SPLITS: per-pitch-type xwOBA filtered by pitcher handedness
// =============================================================
// Pulls raw pitch-by-pitch from Statcast search endpoint and aggregates.
// Heavier than regular arsenal stats (each call = 300-800 rows of CSV),
// so cache aggressively and use only when needed ("deep mode").

const deepCache = new Map();
const DEEP_CACHE_TTL_MS = 30 * 60 * 1000;  // 30 minutes

function pitchNameFromCode(code) {
  const map = {
    FF: '4-Seam Fastball', FT: '2-Seam Fastball', SI: 'Sinker', FC: 'Cutter',
    SL: 'Slider', ST: 'Sweeper', SV: 'Slurve', CU: 'Curveball', KC: 'Knuckle Curve',
    CH: 'Changeup', FS: 'Split-Finger', FO: 'Forkball', KN: 'Knuckleball',
    EP: 'Eephus', SC: 'Screwball', CS: 'Slow Curve'
  };
  return map[code] || code;
}

// Simple CSV line parser (handles quoted fields with commas)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

// Fetch per-pitch-type xwOBA for a hitter filtered to one pitcher hand.
// Returns array of { type, typeCode, pitches, pa, xwoba, xwobaSampleSize }
export async function getHitterPitchTypeByHand(mlbam, season, pitcherHand) {
  const key = `${mlbam}-${season}-${pitcherHand}`;
  const cached = deepCache.get(key);
  if (cached && Date.now() - cached.t < DEEP_CACHE_TTL_MS) return cached.data;

  try {
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=${season}%7C&player_type=batter&pitcher_throws=${pitcherHand}&batters_lookup%5B%5D=${mlbam}&type=details`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Mismatch Finder)' },
      signal: AbortSignal.timeout(25000)
    });
    if (!r.ok) {
      deepCache.set(key, { t: Date.now(), data: [] });
      return [];
    }
    const text = await r.text();
    if (text.startsWith('<') || text.length < 200) {
      deepCache.set(key, { t: Date.now(), data: [] });
      return [];
    }

    const cleaned = text.replace(/^\uFEFF/, '');
    const lines = cleaned.split('\n');
    if (lines.length < 2) {
      deepCache.set(key, { t: Date.now(), data: [] });
      return [];
    }

    const headers = parseCSVLine(lines[0]);
    const idx = {
      pitch_type: headers.indexOf('pitch_type'),
      events: headers.indexOf('events'),
      description: headers.indexOf('description'),
      estimated_woba: headers.indexOf('estimated_woba_using_speedangle'),
      woba_value: headers.indexOf('woba_value')
    };

    if (idx.pitch_type < 0 || idx.events < 0) {
      deepCache.set(key, { t: Date.now(), data: [] });
      return [];
    }

    const byPitch = {};
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cells = parseCSVLine(lines[i]);
      if (cells.length < Math.max(idx.pitch_type, idx.events) + 1) continue;
      const pt = (cells[idx.pitch_type] || '').trim();
      if (!pt) continue;

      if (!byPitch[pt]) {
        byPitch[pt] = {
          pitches: 0,
          pa: 0,
          xwobaSum: 0,
          xwobaN: 0,
          // K-rate tracking: strikeouts on this pitch / PAs that ended on this pitch
          strikeouts: 0,
          // Whiff-rate tracking: swinging strikes / total swings on this pitch
          swings: 0,
          swingsAndMisses: 0
        };
      }
      byPitch[pt].pitches++;

      // Description-based whiff tracking (every pitch has a description)
      const description = idx.description >= 0 ? (cells[idx.description] || '').trim() : '';
      if (description) {
        const isSwingMiss = description.includes('swinging_strike');  // covers swinging_strike and swinging_strike_blocked
        const isFoul = description.includes('foul') && !description.includes('foul_pitchout');
        const isInPlay = description.startsWith('hit_into_play');
        if (isSwingMiss) {
          byPitch[pt].swings++;
          byPitch[pt].swingsAndMisses++;
        } else if (isFoul || isInPlay) {
          byPitch[pt].swings++;
        }
      }

      const events = (cells[idx.events] || '').trim();
      if (events) {
        byPitch[pt].pa++;
        // K-rate: count strikeouts (covers strikeout and strikeout_double_play)
        if (events.startsWith('strikeout')) {
          byPitch[pt].strikeouts++;
        }
        const ewRaw = idx.estimated_woba >= 0 ? (cells[idx.estimated_woba] || '').trim() : '';
        const wvRaw = idx.woba_value >= 0 ? (cells[idx.woba_value] || '').trim() : '';
        let val = null;
        if (ewRaw && ewRaw !== 'null' && ewRaw !== 'NaN') {
          const n = parseFloat(ewRaw);
          if (!isNaN(n)) val = n;
        }
        if (val === null && wvRaw && wvRaw !== 'null' && wvRaw !== 'NaN') {
          const n = parseFloat(wvRaw);
          if (!isNaN(n)) val = n;
        }
        if (val !== null) {
          byPitch[pt].xwobaSum += val;
          byPitch[pt].xwobaN++;
        }
      }
    }

    const result = Object.entries(byPitch).map(([code, d]) => ({
      type: pitchNameFromCode(code),
      typeCode: code,
      pitches: d.pitches,
      pa: d.pa,
      xwoba: d.xwobaN > 0 ? (d.xwobaSum / d.xwobaN).toFixed(3) : null,
      xwobaSampleSize: d.xwobaN,
      // NEW: K rate and whiff rate per pitch type — used by pitcher prop projection
      kRate: d.pa > 0 ? parseFloat((d.strikeouts / d.pa).toFixed(3)) : null,
      strikeouts: d.strikeouts,
      whiffRate: d.swings > 0 ? parseFloat((d.swingsAndMisses / d.swings).toFixed(3)) : null,
      swings: d.swings,
      swingsAndMisses: d.swingsAndMisses
    })).filter(p => p.pitches >= 5)
      .sort((a, b) => b.pitches - a.pitches);

    deepCache.set(key, { t: Date.now(), data: result });
    return result;
  } catch (err) {
    deepCache.set(key, { t: Date.now(), data: [] });
    return [];
  }
}

// =============================================================
// ESPN SCOREBOARD → DraftKings totals, spreads, moneylines
// =============================================================
// Free, no auth. Returns { total, spread, favorite, awayML, homeML, provider }
// Cached 5 minutes since odds update frequently as game approaches

const oddsCache = new Map();
const ODDS_CACHE_TTL_MS = 5 * 60 * 1000;

// ESPN uses 3-letter codes mostly matching MLB but differs for ATH/AZ/WSH
function espnTeamCode(mlbAbbr) {
  const map = {
    'ATH': 'OAK',  // Athletics
    'AZ': 'ARI',
    'CWS': 'CHW'
  };
  return map[mlbAbbr] || mlbAbbr;
}

export async function getGameOdds(awayAbbr, homeAbbr, gameDateStr) {
  // gameDateStr like '2026-04-18' - ESPN uses YYYYMMDD
  const dateParam = gameDateStr.replace(/-/g, '');
  const cacheKey = `${dateParam}-${awayAbbr}-${homeAbbr}`;
  const cached = oddsCache.get(cacheKey);
  if (cached && Date.now() - cached.t < ODDS_CACHE_TTL_MS) return cached.data;

  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateParam}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) {
      oddsCache.set(cacheKey, { t: Date.now(), data: null });
      return null;
    }
    const data = await r.json();
    const awayCode = espnTeamCode(awayAbbr);
    const homeCode = espnTeamCode(homeAbbr);

    // Find the matching event
    for (const ev of (data.events || [])) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const competitors = comp.competitors || [];
      const espnAway = competitors.find(c => c.homeAway === 'away');
      const espnHome = competitors.find(c => c.homeAway === 'home');
      const aAbbr = espnAway?.team?.abbreviation || '';
      const hAbbr = espnHome?.team?.abbreviation || '';

      // Match by abbreviation, trying both ESPN's alt codes
      if ((aAbbr === awayCode || aAbbr === awayAbbr) &&
          (hAbbr === homeCode || hAbbr === homeAbbr)) {
        const odds = (comp.odds || [])[0];
        if (!odds) {
          const result = { found: true, hasOdds: false, gameStatus: comp.status?.type?.description };
          oddsCache.set(cacheKey, { t: Date.now(), data: result });
          return result;
        }
        // Parse details like "NYY -149" or "PIT -1.5" to infer favorite
        const details = odds.details || '';
        const detailsMatch = details.match(/^([A-Z]{2,3})\s+([-+]?\d+(?:\.\d+)?)/);
        let favorite = null;
        let favoriteML = null;
        if (detailsMatch) {
          favorite = detailsMatch[1];
          favoriteML = parseFloat(detailsMatch[2]);
        }
        const result = {
          found: true,
          hasOdds: true,
          provider: odds.provider?.name || 'Unknown',
          total: odds.overUnder || null,
          spread: odds.spread || null,
          details,
          favorite,
          favoriteML,
          homeTeam: hAbbr,
          awayTeam: aAbbr,
          gameStatus: comp.status?.type?.description
        };
        oddsCache.set(cacheKey, { t: Date.now(), data: result });
        return result;
      }
    }

    oddsCache.set(cacheKey, { t: Date.now(), data: { found: false } });
    return { found: false };
  } catch (err) {
    oddsCache.set(cacheKey, { t: Date.now(), data: null });
    return null;
  }
}
