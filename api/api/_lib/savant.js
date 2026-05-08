// api/_lib/savant.js
// Shared helpers for fetching Baseball Savant leaderboard CSVs

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Parse a CSV row handling quoted fields with commas
function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result.map(s => s.replace(/^\uFEFF/, '').trim());
}

export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] !== undefined ? values[i] : ''; });
    return obj;
  });
}

// Simple LRU-ish cache keyed on URL
const cache = new Map();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function fetchSavantCSV(url) {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && (now - cached.time) < TTL_MS) {
    return cached.data;
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000)  // Savant CSVs can be 1-3 MB; allow 15s
  });
  if (!res.ok) throw new Error(`Savant ${res.status}`);
  const text = await res.text();

  // If they served us an error HTML page
  if (text.trim().startsWith('<')) {
    throw new Error('Savant returned HTML (likely invalid params)');
  }

  const parsed = parseCSV(text);
  cache.set(url, { time: now, data: parsed });

  // Trim cache to max 20 entries
  if (cache.size > 20) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].time - b[1].time)[0];
    cache.delete(oldest[0]);
  }

  return parsed;
}

// Build pitch arsenal leaderboard URL (all pitchers/batters, we filter client-side)
export function arsenalURL(season, type) {
  // min=10 lowers the qualifier so early-season samples show up
  return `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=${type}&pitchType=&year=${season}&team=&min=10&csv=true`;
}

// Percentile rankings - overall hitter Statcast metrics
export function percentileURL(season, type) {
  return `https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=${type}&year=${season}&csv=true`;
}

// Expected stats leaderboard (true xwOBA/xBA/barrel values, not percentiles)
export function expectedStatsURL(season, playerType) {
  return `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${playerType}&year=${season}&position=&team=&filterType=bip&min=10&csv=true`;
}
