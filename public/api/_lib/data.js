// api/_lib/data.js
// Core data-fetching helpers used by both standalone endpoints and analyze.js
// This avoids the Vercel "function calling function" 404 issue.

import { getAbbr } from '../_data/teams.js';
import { fetchSavantCSV, arsenalURL, expectedStatsURL } from './savant.js';

const CUSTOM_URL = (season) =>
  `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=batter&filter=&min=10&selections=exit_velocity_avg%2Cbrl_percent%2Chard_hit_percent%2Ck_percent%2Cbb_percent&chart=false&x=exit_velocity_avg&y=exit_velocity_avg&r=no&chartType=beeswarm&sortDir=desc&csv=true`;

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
export async function getPitcherArsenal(mlbam, season) {
  const rows = await fetchSavantCSV(arsenalURL(season, 'pitcher'));
  const pid = String(mlbam).trim();
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

  if (gamePk) {
    try {
      const boxRes = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { signal: AbortSignal.timeout(6000) });
      if (boxRes.ok) {
        const box = await boxRes.json();
        const teamSide = side === 'home' ? 'home' : 'away';
        const teamBox = box.teams?.[teamSide];
        const battingOrder = teamBox?.battingOrder || [];
        if (battingOrder.length > 0) {
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
    // Roster path already has hand, no extra fetch needed
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

  return hitters;
}

// Get hitter Statcast data
export async function getHitterStats(mlbam, season) {
  const pid = String(mlbam).trim();

  const [arsenalRows, expectedRows, customRows] = await Promise.all([
    fetchSavantCSV(arsenalURL(season, 'batter')).catch(() => []),
    fetchSavantCSV(expectedStatsURL(season, 'batter')).catch(() => []),
    fetchSavantCSV(CUSTOM_URL(season)).catch(() => [])
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

  // Barrel% can come back from Savant under different column names depending on
  // their custom-leaderboard export schema. Try the common variants in order.
  // If we find any of them, we use it; otherwise null. Logging the mismatch helps
  // catch future schema shifts before they silently zero out the HR projection.
  const brlRaw = custRow.brl_percent
              ?? custRow.barrel_batted_rate
              ?? custRow.barrels_per_pa_percent
              ?? custRow.barrel_pct
              ?? null;
  if (brlRaw == null && Object.keys(custRow).length > 0 && process.env.NODE_ENV !== 'production') {
    // We have a custom row but no barrel column — Savant schema likely changed.
    // Log once per session would be ideal but a simple console.warn is enough for now.
    console.warn('[data.js] custRow has no recognized barrel% column. Available keys:', Object.keys(custRow).slice(0, 20));
  }

  return {
    overall: {
      xwoba: { value: expRow.est_woba ? parseFloat(expRow.est_woba).toFixed(3) : null },
      xba: { value: expRow.est_ba ? parseFloat(expRow.est_ba).toFixed(3) : null },
      xslg: { value: expRow.est_slg ? parseFloat(expRow.est_slg).toFixed(3) : null },
      barrel_batted_rate: { value: brlRaw != null ? parseFloat(brlRaw).toFixed(1) : null },
      hard_hit_percent: { value: custRow.hard_hit_percent ? parseFloat(custRow.hard_hit_percent).toFixed(1) : null },
      avg_exit_velocity: { value: custRow.exit_velocity_avg ? parseFloat(custRow.exit_velocity_avg).toFixed(1) : null },
      k_percent: { value: custRow.k_percent ? parseFloat(custRow.k_percent).toFixed(1) : null }
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
        // K rate (since MLB API doesn't return K%)
        row.kPct = row.pa > 0 ? ((row.k / row.pa) * 100).toFixed(1) : null;
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
        row.kPct = row.pa > 0 ? ((row.k / row.pa) * 100).toFixed(1) : null;
        row.bbPct = row.pa > 0 ? ((row.bb / row.pa) * 100).toFixed(1) : null;
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
