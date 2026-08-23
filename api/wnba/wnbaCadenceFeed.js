// wnbaCadenceFeed.js — production CADENCE from ESPN play-by-play.
//
// For each player, over a recent window, we bucket their POINTS, REBOUNDS and ASSISTS
// by quarter to learn WHEN in a game they produce: front-loaded (banks early),
// back-loaded (picks up mid-to-late), or even. This drives two things:
//   1) An under/over conviction signal crossed with game script (back-loaded + blowout
//      risk = strong under; back-loaded + close game = weak under — the Onyenwere trap).
//   2) A per-quarter / per-half PROJECTION: given a player's projected total for a
//      market, split it across quarters by their cadence, so you can see roughly what
//      they'll have by halftime and whether you'll be sweating the 2nd half.
//
// ESPN PBP quirks: play participants carry athlete IDs only (names come from the game
// boxscore); on an assisted basket participants[0] is the scorer, participants[1] the
// assister; rebounds are typed plays credited to participants[0].

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

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

const z = () => ({ pts: 0, reb: 0, ast: 0 });

// Per-game: { normName: { name, q: {1..4}: {pts,reb,ast} } } from one game's PBP.
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
  const bucket = (name, q) => {
    const key = normName(name);
    const row = (out[key] = out[key] || { name, q: { 1: z(), 2: z(), 3: z(), 4: z() } });
    return row.q[q];
  };
  for (const p of d.plays) {
    const q = p.period?.number;
    if (!q || q > 4) continue;                          // ignore OT for the half split
    const parts = p.participants || [];
    if (!parts.length) continue;
    const scorerName = id2name[parts[0]?.athlete?.id];
    const text = String(p.text || '').toLowerCase();
    const typ = String(p.type?.text || '').toLowerCase();
    if (p.scoringPlay && scorerName) bucket(scorerName, q).pts += Number(p.scoreValue) || 0;
    if (typ.includes('rebound') && scorerName) bucket(scorerName, q).reb += 1;
    if (p.scoringPlay && text.includes('assist') && parts[1]) {
      const assister = id2name[parts[1].athlete?.id];
      if (assister) bucket(assister, q).ast += 1;
    }
  }
  return out;
}

// Per-quarter totals → shares + a cadence label.
function profileMarket(q) {
  const tot = q[1] + q[2] + q[3] + q[4];
  if (tot < 6) return null;
  const shares = [q[1] / tot, q[2] / tot, q[3] / tot, q[4] / tot].map((x) => Number(x.toFixed(3)));
  const share2h = Number(((q[3] + q[4]) / tot).toFixed(2));
  let label = 'even';
  if (share2h >= 0.60) label = 'back';
  else if (share2h <= 0.40) label = 'front';
  return { total: tot, shares, share2h, label };
}

let _cache = null, _cacheAt = 0;
const TTL = 6 * 60 * 60 * 1000;

export async function buildCadenceProfiles({ days = 14, maxGames = 60 } = {}) {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;
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
  const agg = {};
  const CONC = 4;
  for (let i = 0; i < ids.length; i += CONC) {
    const batch = await Promise.all(ids.slice(i, i + CONC).map((id) => fetchGameCadence(id)));
    for (const game of batch) {
      if (!game) continue;
      for (const [key, row] of Object.entries(game)) {
        const a = (agg[key] = agg[key] || {
          name: row.name, gp: 0,
          pts: { 1: 0, 2: 0, 3: 0, 4: 0 }, reb: { 1: 0, 2: 0, 3: 0, 4: 0 }, ast: { 1: 0, 2: 0, 3: 0, 4: 0 },
        });
        a.gp += 1;
        for (const qn of [1, 2, 3, 4]) {
          a.pts[qn] += row.q[qn].pts; a.reb[qn] += row.q[qn].reb; a.ast[qn] += row.q[qn].ast;
        }
      }
    }
  }
  const profiles = {};
  for (const [key, a] of Object.entries(agg)) {
    if (a.gp < 3) continue;
    const points = profileMarket(a.pts), rebounds = profileMarket(a.reb), assists = profileMarket(a.ast);
    if (!points && !rebounds && !assists) continue;
    profiles[key] = { name: a.name, games: a.gp, points, rebounds, assists };
  }
  _cache = profiles; _cacheAt = Date.now();
  return profiles;
}

// Split a projected TOTAL for a market across quarters/halves by cadence.
export function splitByCadence(profile, market, projectedTotal) {
  const mk = String(market || '').toLowerCase();
  const c = profile ? (mk === 'rebounds' ? profile.rebounds : mk === 'assists' ? profile.assists : profile.points) : null;
  const T = Number(projectedTotal);
  if (!c || !Array.isArray(c.shares) || !Number.isFinite(T)) return null;
  const byQuarter = c.shares.map((s) => Number((T * s).toFixed(1)));
  return {
    byQuarter,
    firstHalf: Number((byQuarter[0] + byQuarter[1]).toFixed(1)),
    secondHalf: Number((byQuarter[2] + byQuarter[3]).toFixed(1)),
    label: c.label, share2h: c.share2h,
  };
}

export function cadenceSignal(profile, market, blowoutRisk) {
  if (!profile) return null;
  const mk = String(market || '').toLowerCase();
  const c = mk === 'rebounds' ? profile.rebounds : mk === 'assists' ? profile.assists : profile.points;
  if (!c || c.label === 'even') return null;
  const blowout = blowoutRisk && blowoutRisk.risk && blowoutRisk.risk !== 'MILD' && !blowoutRisk.isAlpha;
  if (c.label === 'back') {
    if (blowout) return { side: 'UNDER', confBoost: 4, label: 'back', share2h: c.share2h,
      note: `Back-loaded — ${Math.round(c.share2h * 100)}% of production comes in the 2nd half. With blowout risk the late buckets it needs may not come. Strengthens the under.` };
    return { side: 'CONTEXT', confBoost: 0, fadeUnder: true, label: 'back', share2h: c.share2h,
      note: `Back-loaded — ${Math.round(c.share2h * 100)}% of production is 2nd-half. In a competitive game it catches up late, so a low early read is a weak under.` };
  }
  if (c.label === 'front') return { side: 'UNDER', confBoost: blowout ? 1 : 2, label: 'front', share2h: c.share2h,
    note: `Front-loaded — ${Math.round((1 - c.share2h) * 100)}% of production is 1st-half. Banks stats early and is steadier for the under.` };
  return null;
}
