// api/_lib/pitcherInnings.js
// Fetches pitcher per-inning stats from Baseball Savant Statcast search CSV.
// Caches aggressively since per-pitch data is heavy.

const inningCache = new Map();  // key: `${mlbam}-${season}`, val: { timestamp, data }
const CACHE_TTL = 6 * 60 * 60 * 1000;  // 6 hours

const EVENTS_TERMINAL = new Set([
  'single', 'double', 'triple', 'home_run',
  'walk', 'hit_by_pitch',
  'strikeout', 'strikeout_double_play',
  'field_out', 'force_out', 'grounded_into_double_play',
  'fielders_choice', 'fielders_choice_out',
  'double_play', 'triple_play',
  'sac_fly', 'sac_fly_double_play',
  'sac_bunt', 'sac_bunt_double_play',
  'field_error', 'catcher_interf',
  'fan_interference',
  'other_out'
]);

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Fetch raw pitch-by-pitch for a pitcher for a season, aggregate per-inning
export async function getPitcherInningSplits(mlbam, season) {
  if (!mlbam) return null;
  const cacheKey = `${mlbam}-${season}`;
  const cached = inningCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=${season}%7C&player_type=pitcher&pitchers_lookup%5B%5D=${mlbam}&min_pitches=1&min_results=0&group_by=name&type=details`;

  let text;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    text = await res.text();
  } catch (err) {
    console.warn(`Inning splits fetch failed ${mlbam}/${season}:`, err.message);
    return null;
  }

  if (!text || text.length < 300) return null;
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;

  const headers = parseCsvLine(lines[0]).map(h => h.replace(/"/g, ''));
  const idx = {
    inning: headers.indexOf('inning'),
    events: headers.indexOf('events'),
    xwoba: headers.indexOf('estimated_woba_using_speedangle'),
    wobaDenom: headers.indexOf('woba_denom'),
    abNum: headers.indexOf('at_bat_number'),
    gameDate: headers.indexOf('game_date'),
    balls: headers.indexOf('balls'),
    strikes: headers.indexOf('strikes'),
    desc: headers.indexOf('description')
  };
  if (idx.inning < 0 || idx.events < 0) return null;

  const innings = {};
  for (let i = 1; i <= 9; i++) innings[i] = { pa: 0, bb: 0, k: 0, hits: 0, hrs: 0, xwobaSum: 0, xwobaN: 0, pitches: 0 };

  const seenAB = new Set();
  for (const line of lines.slice(1)) {
    const r = parseCsvLine(line);
    if (r.length < 20) continue;
    const inn = parseInt(r[idx.inning]);
    if (!inn || inn < 1 || inn > 9) continue;
    innings[inn].pitches++;

    const events = (r[idx.events] || '').trim();
    if (!events || !EVENTS_TERMINAL.has(events)) continue;
    // Dedupe — one event per AB
    const abKey = `${inn}_${r[idx.abNum]}_${r[idx.gameDate]}`;
    if (seenAB.has(abKey)) continue;
    seenAB.add(abKey);

    const I = innings[inn];
    I.pa++;
    if (events === 'walk' || events === 'hit_by_pitch') I.bb++;
    if (events === 'strikeout' || events === 'strikeout_double_play') I.k++;
    if (['single', 'double', 'triple', 'home_run'].includes(events)) I.hits++;
    if (events === 'home_run') I.hrs++;
    const xw = parseFloat(r[idx.xwoba]);
    const wd = parseFloat(r[idx.wobaDenom]);
    if (!isNaN(xw) && wd > 0) { I.xwobaSum += xw; I.xwobaN++; }
  }

  // Compute per-inning rates and groupings
  const perInning = {};
  for (let i = 1; i <= 9; i++) {
    const d = innings[i];
    perInning[i] = {
      pa: d.pa,
      bbPct: d.pa > 0 ? (d.bb / d.pa) : null,
      kPct: d.pa > 0 ? (d.k / d.pa) : null,
      xwobaAgainst: d.xwobaN > 0 ? (d.xwobaSum / d.xwobaN) : null,
      hrs: d.hrs,
      hits: d.hits,
      pitches: d.pitches
    };
  }

  // Compact groupings: innings 1-3 (fresh), 4-6 (2nd time through), 7+ (fatigue)
  const bucket = (from, to) => {
    let pa = 0, bb = 0, k = 0, hrs = 0, hits = 0, xwobaSum = 0, xwobaN = 0;
    for (let i = from; i <= to; i++) {
      if (!innings[i]) continue;
      pa += innings[i].pa;
      bb += innings[i].bb;
      k += innings[i].k;
      hrs += innings[i].hrs;
      hits += innings[i].hits;
      xwobaSum += innings[i].xwobaSum;
      xwobaN += innings[i].xwobaN;
    }
    return {
      pa, bb, k, hrs, hits,
      bbPct: pa > 0 ? bb / pa : null,
      kPct: pa > 0 ? k / pa : null,
      xwobaAgainst: xwobaN > 0 ? xwobaSum / xwobaN : null,
      hrPer9: pa > 0 ? (hrs / pa) * 38.5 : null  // approx PA per 9 IP = 38.5
    };
  };

  const groups = {
    firstTime: bucket(1, 3),
    secondTime: bucket(4, 6),
    thirdTime: bucket(7, 9)
  };

  // Identify meltdown inning: inning with highest xwOBA-against AND min 12 PA
  let meltdownInning = null, meltdownXw = 0;
  let shutdownInning = null, shutdownXw = 1;
  for (let i = 1; i <= 9; i++) {
    const d = perInning[i];
    if (d.pa < 12 || d.xwobaAgainst == null) continue;
    if (d.xwobaAgainst > meltdownXw) { meltdownXw = d.xwobaAgainst; meltdownInning = i; }
    if (d.xwobaAgainst < shutdownXw) { shutdownXw = d.xwobaAgainst; shutdownInning = i; }
  }

  // Totals
  let totalPa = 0, totalBb = 0, totalK = 0, totalHr = 0, totalXwSum = 0, totalXwN = 0;
  for (let i = 1; i <= 9; i++) {
    totalPa += innings[i].pa;
    totalBb += innings[i].bb;
    totalK += innings[i].k;
    totalHr += innings[i].hrs;
    totalXwSum += innings[i].xwobaSum;
    totalXwN += innings[i].xwobaN;
  }
  const season_stats = {
    pa: totalPa,
    bbPct: totalPa > 0 ? totalBb / totalPa : null,
    kPct: totalPa > 0 ? totalK / totalPa : null,
    xwobaAgainst: totalXwN > 0 ? totalXwSum / totalXwN : null,
    hrPer9: totalPa > 0 ? (totalHr / totalPa) * 38.5 : null
  };

  const result = {
    mlbam,
    season,
    perInning,
    groups,
    meltdownInning,
    meltdownXw,
    shutdownInning,
    shutdownXw,
    season_stats,
    fetchedAt: Date.now()
  };

  inningCache.set(cacheKey, { timestamp: Date.now(), data: result });
  return result;
}

// Blend current + prior season into a single smoothed view.
// In-season small samples get regressed toward prior-year averages.
export async function getBlendedInningSplits(mlbam) {
  if (!mlbam) return null;
  const currentYear = new Date().getFullYear();
  const [current, prior] = await Promise.all([
    getPitcherInningSplits(mlbam, currentYear).catch(() => null),
    getPitcherInningSplits(mlbam, currentYear - 1).catch(() => null)
  ]);
  if (!current && !prior) return null;

  // Sample-size-aware blend: weight current by pa, prior by 50 PA minimum
  const blend = (c, p, paNow, paPrior) => {
    if (c == null && p == null) return null;
    if (c == null) return p;
    if (p == null) return c;
    // Weight: regress current toward prior based on sample
    const wNow = Math.max(paNow, 0);
    const wPrior = Math.max(paPrior * 0.7, 0);  // prior discounted 30%
    if (wNow + wPrior === 0) return null;
    return (c * wNow + p * wPrior) / (wNow + wPrior);
  };

  const perInning = {};
  for (let i = 1; i <= 9; i++) {
    const c = current?.perInning[i] || { pa: 0 };
    const p = prior?.perInning[i] || { pa: 0 };
    perInning[i] = {
      pa: c.pa + p.pa,
      paCurrent: c.pa,
      paPrior: p.pa,
      bbPct: blend(c.bbPct, p.bbPct, c.pa, p.pa),
      kPct: blend(c.kPct, p.kPct, c.pa, p.pa),
      xwobaAgainst: blend(c.xwobaAgainst, p.xwobaAgainst, c.pa, p.pa),
      smallSample: (c.pa + p.pa) < 20
    };
  }

  // Recompute groups and meltdown from blended per-inning
  const bucket = (from, to) => {
    let totalPa = 0, pa = 0, bbSum = 0, kSum = 0, xwSum = 0;
    for (let i = from; i <= to; i++) {
      const d = perInning[i];
      if (!d || d.pa === 0) continue;
      totalPa += d.pa;
      if (d.bbPct != null) { bbSum += d.bbPct * d.pa; pa += d.pa; }
    }
    pa = totalPa;
    let bbPct = null, kPct = null, xwobaAgainst = null;
    for (let i = from; i <= to; i++) {
      const d = perInning[i];
      if (!d || d.pa === 0) continue;
      if (d.bbPct != null) bbPct = (bbPct || 0) + d.bbPct * (d.pa / pa);
      if (d.kPct != null) kPct = (kPct || 0) + d.kPct * (d.pa / pa);
      if (d.xwobaAgainst != null) xwobaAgainst = (xwobaAgainst || 0) + d.xwobaAgainst * (d.pa / pa);
    }
    return { pa, bbPct, kPct, xwobaAgainst };
  };

  const groups = {
    firstTime: bucket(1, 3),
    secondTime: bucket(4, 6),
    thirdTime: bucket(7, 9)
  };

  // Meltdown / shutdown identification (with min-PA bar, use blended data)
  let meltdownInning = null, meltdownXw = 0;
  let shutdownInning = null, shutdownXw = 1;
  for (let i = 1; i <= 9; i++) {
    const d = perInning[i];
    if (d.pa < 15 || d.xwobaAgainst == null) continue;
    if (d.xwobaAgainst > meltdownXw) { meltdownXw = d.xwobaAgainst; meltdownInning = i; }
    if (d.xwobaAgainst < shutdownXw) { shutdownXw = d.xwobaAgainst; shutdownInning = i; }
  }

  // Control tier based on overall BB%
  const overallBb = groups.firstTime.bbPct;
  let controlTier = null;
  if (overallBb != null) {
    if (overallBb <= 0.06) controlTier = 'elite';
    else if (overallBb <= 0.08) controlTier = 'above-average';
    else if (overallBb <= 0.10) controlTier = 'average';
    else if (overallBb <= 0.12) controlTier = 'below-average';
    else controlTier = 'wild';
  }

  // Meltdown differential: how much worse is meltdown inning vs overall
  const overallXw = current?.season_stats?.xwobaAgainst || prior?.season_stats?.xwobaAgainst;
  let meltdownDelta = null;
  if (meltdownXw && overallXw) meltdownDelta = meltdownXw - overallXw;

  return {
    mlbam,
    current: current?.season_stats,
    prior: prior?.season_stats,
    perInning,
    groups,
    meltdownInning,
    meltdownXw,
    meltdownDelta,
    shutdownInning,
    shutdownXw,
    controlTier,
    hasCurrentData: !!current && current.season_stats.pa >= 30,
    hasPriorData: !!prior && prior.season_stats.pa >= 100
  };
}
