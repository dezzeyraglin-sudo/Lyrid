// wnbaCadenceFeed.js — production CADENCE from ESPN play-by-play.
//
// For each player, over a recent window of games, we bucket their production by
// quarter to learn WHEN in a game they score/rebound: front-loaded (banks early),
// back-loaded (struggles early, picks up mid-to-late), or even. This is a real
// under/over signal because cadence interacts with game script:
//
//   • BACK-loaded + blowout risk  → the sharpest UNDER. They need late production,
//     and a decided game (bench, slower pace, garbage time) never delivers it.
//   • BACK-loaded + close game    → FADE the under. They catch up late — this is the
//     Michaela Onyenwere trap (0 pts in Q1, 11 of 14 in the 2nd half, beat her under).
//   • FRONT-loaded                → less game-script sensitive; already banked early,
//     so blowout risk barely moves them and their unders are steadier.
//
// ESPN PBP quirk: play participants carry athlete IDs only; names come from the
// game's boxscore. We build the id→name map per game, then attribute.

import https from 'node:https';

const UA = 'curl/8.5.0';
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

const SB = (ymd) => `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${ymd}`;
const SUM = (id) => `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event=${id}`;

// Per-game cadence: { normName: { q: {pts,reb}, name } } from one game's PBP.
async function fetchGameCadence(eventId) {
  const d = await getJson(SUM(eventId)).catch(() => null);
  if (!d || !Array.isArray(d.plays)) return null;
  const id2name = {};
  for (const team of (d.boxscore?.players || [])) {
    for (const stat of (team.statistics || [])) {
      for (const a of (stat.athletes || [])) {
        const ath = a.athlete || {};
        if (ath.id) id2name[ath.id] = ath.displayName;
      }
    }
  }
  const out = {};
  for (const p of d.plays) {
    const q = p.period?.number;
    if (!q || q > 4) continue;                       // ignore OT for the 1H/2H split
    const parts = p.participants || [];
    if (!parts.length) continue;
    const sid = parts[0].athlete?.id;
    const name = id2name[sid];
    if (!name) continue;
    const key = normName(name);
    const row = (out[key] = out[key] || { name, q: { 1: { pts: 0, reb: 0 }, 2: { pts: 0, reb: 0 }, 3: { pts: 0, reb: 0 }, 4: { pts: 0, reb: 0 } } });
    if (p.scoringPlay) row.q[q].pts += Number(p.scoreValue) || 0;
    const typ = String(p.type?.text || '').toLowerCase();
    if (typ.includes('rebound')) row.q[q].reb += 1;
  }
  return out;
}

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Classify a 1H/2H split into a cadence label + a signed skew (-1 fully front .. +1 fully back).
function classify(h1, h2) {
  const tot = h1 + h2;
  if (tot < 6) return { label: 'even', skew: 0, share2h: 0.5 };   // too little to judge
  const share2h = h2 / tot;
  const skew = Number((share2h - 0.5).toFixed(2)) * 2;            // -1..+1
  let label = 'even';
  if (share2h >= 0.60) label = 'back';
  else if (share2h <= 0.40) label = 'front';
  return { label, skew: Number(skew.toFixed(2)), share2h: Number(share2h.toFixed(2)) };
}

let _cache = null, _cacheAt = 0;
const TTL = 6 * 60 * 60 * 1000;   // 6h — cadence drifts slowly

/**
 * Build per-player cadence profiles over the last `days` of completed games.
 * Returns { normName: { name, games, points:{h1,h2,label,skew,share2h}, rebounds:{...} } }.
 * Cached in-process for 6h. Bounded window keeps the PBP fetch count sane; for
 * production this belongs in a nightly job writing to storage, not per-slate.
 */
export async function buildCadenceProfiles({ days = 14, maxGames = 60 } = {}) {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;

  // Collect completed game IDs across the window.
  const ids = [];
  const today = new Date();
  for (let i = 0; i < days && ids.length < maxGames; i++) {
    const dt = new Date(today); dt.setDate(dt.getDate() - i);
    const ymd = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
    const sb = await getJson(SB(ymd)).catch(() => null);
    for (const e of (sb?.events || [])) {
      if (e.competitions?.[0]?.status?.type?.completed) ids.push(e.id);
    }
  }

  // Aggregate per-player production by half across those games (bounded concurrency).
  const agg = {};   // key -> { name, gp, pts:{h1,h2}, reb:{h1,h2} }
  const CONC = 4;
  for (let i = 0; i < ids.length; i += CONC) {
    const batch = await Promise.all(ids.slice(i, i + CONC).map((id) => fetchGameCadence(id)));
    for (const game of batch) {
      if (!game) continue;
      for (const [key, row] of Object.entries(game)) {
        const a = (agg[key] = agg[key] || { name: row.name, gp: 0, pts: { h1: 0, h2: 0 }, reb: { h1: 0, h2: 0 } });
        a.gp += 1;
        a.pts.h1 += row.q[1].pts + row.q[2].pts; a.pts.h2 += row.q[3].pts + row.q[4].pts;
        a.reb.h1 += row.q[1].reb + row.q[2].reb; a.reb.h2 += row.q[3].reb + row.q[4].reb;
      }
    }
  }

  const profiles = {};
  for (const [key, a] of Object.entries(agg)) {
    if (a.gp < 3) continue;   // need a few games to trust the cadence
    profiles[key] = {
      name: a.name, games: a.gp,
      points: { h1: a.pts.h1, h2: a.pts.h2, ...classify(a.pts.h1, a.pts.h2) },
      rebounds: { h1: a.reb.h1, h2: a.reb.h2, ...classify(a.reb.h1, a.reb.h2) },
    };
  }
  _cache = profiles; _cacheAt = Date.now();
  return profiles;
}

// Turn a player's cadence + game script into an under/over conviction nudge.
// Returns { note, confBoost, side } or null. blowoutRisk is the buildBlowoutRisk output.
export function cadenceSignal(profile, market, blowoutRisk) {
  if (!profile) return null;
  const mk = String(market || '').toLowerCase();
  const c = mk === 'rebounds' ? profile.rebounds : profile.points;   // points cadence proxies PRA
  if (!c || c.label === 'even') return null;
  const blowout = blowoutRisk && blowoutRisk.risk && blowoutRisk.risk !== 'MILD' && !blowoutRisk.isAlpha;
  if (c.label === 'back') {
    if (blowout) return {
      side: 'UNDER', confBoost: 4,
      note: `Back-loaded — ${Math.round(c.share2h * 100)}% of production comes in the 2nd half. With blowout risk, the late buckets it needs may never come. Strengthens the under.`,
    };
    return {
      side: 'OVER', confBoost: 0, fadeUnder: true,
      note: `Back-loaded — ${Math.round(c.share2h * 100)}% of production is 2nd-half. In a competitive game it catches up late, so a low early read is a weak under (the Onyenwere pattern).`,
    };
  }
  if (c.label === 'front') {
    return {
      side: 'UNDER', confBoost: blowout ? 1 : 2,
      note: `Front-loaded — ${Math.round((1 - c.share2h) * 100)}% of production is 1st-half. Banks stats early and is steadier for the under; blowout risk barely moves it.`,
    };
  }
  return null;
}
