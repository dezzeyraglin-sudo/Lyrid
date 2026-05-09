// api/_lib/pitcherPropsLines.js
//
// Fetches pitcher prop lines (Strikeouts O/U, Pitching Outs O/U) from The Odds API.
// Free tier: 500 requests/month — we cache aggressively so a single fetch covers
// all games on a slate for 15 minutes.
//
// Endpoint reference:
//   GET https://api.the-odds-api.com/v4/sports/baseball_mlb/odds
//     ?apiKey={ODDS_API_KEY}
//     &regions=us
//     &markets=pitcher_strikeouts,pitcher_outs
//     &bookmakers=draftkings
//
// Response shape (per game):
//   {
//     id, sport_key, commence_time,
//     home_team, away_team,
//     bookmakers: [
//       {
//         key: 'draftkings',
//         markets: [
//           {
//             key: 'pitcher_strikeouts',
//             outcomes: [
//               { name: 'Over',  description: 'Tarik Skubal', point: 7.5, price: -115 },
//               { name: 'Under', description: 'Tarik Skubal', point: 7.5, price: -105 },
//               // ... one over/under pair per pitcher in the game
//             ]
//           },
//           { key: 'pitcher_outs', outcomes: [...] }
//         ]
//       }
//     ]
//   }
//
// Important quirks:
//   - Lines may be missing for some pitchers (especially openers, late call-ups)
//   - Some pitchers only have Ks line, no Outs (or vice versa)
//   - Names may have suffixes (Jr, Sr) or accents that need normalization
//   - Game IDs from Odds API don't match MLBAM gamePks — must match by team

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds';
const CACHE_TTL_MS = 15 * 60 * 1000;  // 15 min — balance freshness with rate limits

let _cache = null;
let _cacheTime = 0;

/**
 * Normalize a pitcher name for matching across DK and our system.
 * Strips suffixes (Jr, Sr, II, III), normalizes whitespace, lowercases,
 * removes diacritics. NOT a fuzzy match — both strings get the same treatment.
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')                    // decompose accents
    .replace(/[\u0300-\u036f]/g, '')     // strip combining diacritics
    .replace(/\b(Jr|Sr|II|III|IV)\.?\b/gi, '')
    .replace(/[^\w\s]/g, '')             // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Fetch pitcher prop lines for the entire MLB slate.
 * Returns a map keyed by normalized pitcher name → { ks: {line, overOdds, underOdds}, outs: {...} }
 *
 * Cached for 15 minutes. Returns null if the API key is missing or the request fails.
 */
export async function fetchPitcherPropsLines() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.warn('[pitcherPropsLines] ODDS_API_KEY not set — skipping line fetch');
    return null;
  }

  // Check cache first — single slate fetch covers all games for 15 min
  if (_cache && Date.now() - _cacheTime < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    const url = `${ODDS_API_BASE}?apiKey=${apiKey}&regions=us&markets=pitcher_strikeouts,pitcher_outs&bookmakers=draftkings&oddsFormat=american`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) {
      // 401 = bad key; 422 = market not found; 429 = rate limited; 500 = their problem
      const detail = await res.text().catch(() => '');
      console.warn(`[pitcherPropsLines] API ${res.status}:`, detail.slice(0, 200));
      return null;
    }

    const games = await res.json();
    if (!Array.isArray(games)) return null;

    // Flatten into a per-pitcher map. Each game has up to 2 pitchers (one per side),
    // each pitcher may have ks line, outs line, both, or neither.
    const byPitcher = {};

    for (const game of games) {
      const dk = (game.bookmakers || []).find(b => b.key === 'draftkings');
      if (!dk) continue;

      for (const market of (dk.markets || [])) {
        const propType = market.key === 'pitcher_strikeouts' ? 'ks'
                       : market.key === 'pitcher_outs' ? 'outs'
                       : null;
        if (!propType) continue;

        // Group outcomes by pitcher (description field carries the pitcher name)
        const byName = {};
        for (const out of (market.outcomes || [])) {
          const name = out.description || out.participant;
          if (!name) continue;
          const key = normalizeName(name);
          if (!byName[key]) byName[key] = { rawName: name, point: out.point };
          if (out.name === 'Over') byName[key].overOdds = out.price;
          else if (out.name === 'Under') byName[key].underOdds = out.price;
        }

        for (const [key, lineData] of Object.entries(byName)) {
          if (lineData.point == null) continue;
          if (!byPitcher[key]) {
            byPitcher[key] = { rawName: lineData.rawName };
          }
          byPitcher[key][propType] = {
            line: lineData.point,
            overOdds: lineData.overOdds || null,
            underOdds: lineData.underOdds || null,
            book: 'DraftKings'
          };
        }
      }
    }

    _cache = byPitcher;
    _cacheTime = Date.now();
    return byPitcher;
  } catch (err) {
    console.warn('[pitcherPropsLines] Fetch failed:', err.message);
    return null;
  }
}

/**
 * Look up lines for a specific pitcher by name. Tries exact normalized match first,
 * then last-name + first-initial fallback (handles "T. Skubal" vs "Tarik Skubal" cases).
 */
export function getPitcherLinesByName(linesMap, pitcherName) {
  if (!linesMap || !pitcherName) return null;
  const normalized = normalizeName(pitcherName);

  // Direct hit
  if (linesMap[normalized]) return linesMap[normalized];

  // Last name + first initial fallback
  const parts = normalized.split(' ');
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    const firstInitial = parts[0][0];
    for (const [key, val] of Object.entries(linesMap)) {
      const keyParts = key.split(' ');
      if (keyParts.length < 2) continue;
      const keyLast = keyParts[keyParts.length - 1];
      const keyFirstInitial = keyParts[0][0];
      if (keyLast === lastName && keyFirstInitial === firstInitial) return val;
    }
  }

  return null;
}

/**
 * Convert American odds to implied probability.
 * +120 → 0.4545, -150 → 0.6000
 */
function americanToImpliedProb(odds) {
  if (odds == null || isNaN(odds)) return null;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

/**
 * Grade a projection against a book line. Returns over/under recommendation with EV.
 *
 * Approach:
 *   1. Compute model probability that actual result > line (using Poisson approximation
 *      around the projected mean — Ks and Outs are reasonably Poisson-distributed)
 *   2. Compare to the book's implied probability (devigged across over/under)
 *   3. Edge = model probability - true book probability
 *   4. Tier the recommendation by edge magnitude
 */
export function gradeProjectionVsLine(projection, line, propType) {
  if (projection == null || !line || line.line == null) return null;

  const stddev = propType === 'ks' ? 2.2 : 3.5;  // empirical stddev per start

  // Probability of exceeding the line, using normal approximation
  // For Ks/Outs at typical lines, this is close enough to a true Poisson
  const z = (projection - line.line) / stddev;
  const modelProbOver = 0.5 * (1 + erf(z / Math.SQRT2));
  const modelProbUnder = 1 - modelProbOver;

  // Book implied probabilities (devigged so over + under = 1.0)
  const overImplied = americanToImpliedProb(line.overOdds);
  const underImplied = americanToImpliedProb(line.underOdds);
  let bookOverProb = 0.5, bookUnderProb = 0.5;
  if (overImplied != null && underImplied != null) {
    const totalImplied = overImplied + underImplied;
    bookOverProb = overImplied / totalImplied;
    bookUnderProb = underImplied / totalImplied;
  }

  // Edge = model probability - book probability
  const overEdge = modelProbOver - bookOverProb;
  const underEdge = modelProbUnder - bookUnderProb;

  // Pick the better side
  const side = overEdge > underEdge ? 'over' : 'under';
  const edge = side === 'over' ? overEdge : underEdge;
  const modelProb = side === 'over' ? modelProbOver : modelProbUnder;
  const bookProb = side === 'over' ? bookOverProb : bookUnderProb;
  const odds = side === 'over' ? line.overOdds : line.underOdds;

  // Tier by edge magnitude
  let tier, tierLabel;
  if (edge >= 0.08) { tier = 'play'; tierLabel = 'PLAY'; }
  else if (edge >= 0.04) { tier = 'lean'; tierLabel = 'LEAN'; }
  else if (edge >= 0.015) { tier = 'slight'; tierLabel = 'SLIGHT'; }
  else { tier = 'no-play'; tierLabel = 'NO PLAY'; }

  return {
    line: line.line,
    side,
    odds,
    modelProb: parseFloat(modelProb.toFixed(3)),
    bookProb: parseFloat(bookProb.toFixed(3)),
    edge: parseFloat((edge * 100).toFixed(1)),  // as percentage
    tier,
    tierLabel,
    book: line.book || 'DraftKings'
  };
}

// Approximation of the error function (used for normal CDF)
// Abramowitz and Stegun 7.1.26 — accurate to ~1e-7
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
