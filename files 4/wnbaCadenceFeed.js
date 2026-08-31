// wnbaCadenceFeed.js — production CADENCE from ESPN play-by-play, per player, over
// BOTH the last 10 and last 5 games so you can see whether the front/back-loaded
// pattern is stable or shifting recently (same idea as the L10/L5 shooting form).
//
// For each player we bucket POINTS, REBOUNDS and ASSISTS by quarter to learn WHEN they
// produce: front-loaded (banks early), back-loaded (picks up mid-to-late), or even.
// Drives: (1) an under/over conviction signal crossed with game script, and (2) a
// per-quarter/half projection (split a projected total by cadence).
//
// ESPN PBP quirks: participants carry athlete IDs only (names from the boxscore); on an
// assisted basket participants[0] is the scorer, participants[1] the assister; rebounds
// are typed plays credited to participants[0].

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

// One game's PBP → { normName: { name, q:{1..4}:{pts,reb,ast} } }.
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
    if (!q || q > 4) continue;
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

// Sum the per-quarter breakdowns across a set of games, then profile each market.
function windowProfile(games) {
  if (games.length < 3) return null;
  const pts = { 1: 0, 2: 0, 3: 0, 4: 0 }, reb = { 1: 0, 2: 0, 3: 0, 4: 0 }, ast = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const g of games) for (const qn of [1, 2, 3, 4]) {
    pts[qn] += g.q[qn].pts; reb[qn] += g.q[qn].reb; ast[qn] += g.q[qn].ast;
  }
  const points = profileMarket(pts), rebounds = profileMarket(reb), assists = profileMarket(ast);
  if (!points && !rebounds && !assists) return null;
  // Per-game FIRST-HALF points share — the consistency (CV) of this, not the aggregate,
  // is what makes the fast/slow-starter read trustworthy (r=0.20 gated on CV<0.25 vs
  // r=0.055 ungated). Surfaced so firstHalfProfile.classifyFirstHalf can gate on it.
  const h1Shares = [];
  for (const g of games) {
    const gp = g.q[1].pts + g.q[2].pts + g.q[3].pts + g.q[4].pts;
    if (gp >= 6) h1Shares.push(Number(((g.q[1].pts + g.q[2].pts) / gp).toFixed(3)));
  }
  return { games: games.length, points, rebounds, assists, h1Shares };
}

let _cache = null, _cacheAt = 0;
const TTL = 6 * 60 * 60 * 1000;

/**
 * { normName: { name, l10:{games,points,rebounds,assists}, l5:{...} } }
 * Each market carries { shares:[q1..q4], share2h, label }.
 */
export async function buildCadenceProfiles({ days = 24, maxGames = 100 } = {}) {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;

  const games = [];   // { id, date }
  const today = new Date();
  for (let i = 0; i < days && games.length < maxGames; i++) {
    const dt = new Date(today); dt.setDate(dt.getDate() - i);
    const ymd = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
    const sb = await getJson(SB(ymd)).catch(() => null);
    for (const e of (sb?.events || [])) {
      if (e.competitions?.[0]?.status?.type?.completed) games.push({ id: e.id, date: ymd });
    }
  }
  games.sort((a, b) => a.date.localeCompare(b.date));   // oldest first

  // Per player: an ordered list of per-game quarter breakdowns.
  const byPlayer = {};
  const CONC = 4;
  for (let i = 0; i < games.length; i += CONC) {
    const batch = games.slice(i, i + CONC);
    const results = await Promise.all(batch.map((g) => fetchGameCadence(g.id).then((r) => ({ r, date: g.date }))));
    for (const { r, date } of results) {
      if (!r) continue;
      for (const [key, row] of Object.entries(r)) {
        const rec = (byPlayer[key] = byPlayer[key] || { name: row.name, games: [] });
        rec.games.push({ date, q: row.q });
      }
    }
  }

  const profiles = {};
  for (const [key, rec] of Object.entries(byPlayer)) {
    rec.games.sort((a, b) => a.date.localeCompare(b.date));   // ascending → recent last
    const l10 = windowProfile(rec.games.slice(-10));
    const l5 = windowProfile(rec.games.slice(-5));
    if (!l10 && !l5) continue;
    profiles[key] = { name: rec.name, l10, l5 };
  }
  _cache = profiles; _cacheAt = Date.now();
  return profiles;
}

// Pick a window's market cadence. Defaults to L10 (more stable); falls back to L5.
function pick(profile, market, window = 'l10') {
  const w = profile?.[window] || profile?.l10 || profile?.l5;
  if (!w) return null;
  const mk = String(market || '').toLowerCase();
  return mk === 'rebounds' ? w.rebounds : mk === 'assists' ? w.assists : w.points;
}

// Split a projected TOTAL across quarters/halves by cadence (L10 by default).
export function splitByCadence(profile, market, projectedTotal, window = 'l10') {
  const c = pick(profile, market, window);
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

// Under/over conviction nudge from cadence × game script (L10 by default).
export function cadenceSignal(profile, market, blowoutRisk, window = 'l10') {
  const c = pick(profile, market, window);
  if (!c || c.label === 'even') return null;
  const blowout = blowoutRisk && blowoutRisk.risk && blowoutRisk.risk !== 'MILD' && !blowoutRisk.isAlpha;
  const p2h = Math.round(c.share2h * 100);
  if (c.label === 'back') {
    if (blowout) return { side: 'UNDER', confBoost: 2, label: 'back', scenario: 'BACK_BLOWOUT', share2h: c.share2h,
      note: `Back-loaded — ${p2h}% 2nd-half; blowout risk caps the late buckets (backtest 58% under). Mild under support.` };
    return { side: 'CONTEXT', confBoost: 0, fadeUnder: true, label: 'back', scenario: 'BACK_TRAP', share2h: c.share2h,
      note: `Back-loaded — ${p2h}% 2nd-half; competitive game, catches up late (went OVER ~56%). Under is a trap — fade.` };
  }
  return { side: 'CONTEXT', confBoost: 0, informational: true, label: 'front', scenario: blowout ? 'FRONT_BLOWOUT' : 'FRONT_CLOSE', share2h: c.share2h,
    note: `Front-loaded — ${100 - p2h}% 1st-half. ${blowout ? 'Blowout: banked early, under leans mildly live (54%).' : 'Informational (~neutral, 55%).'}` };
}
