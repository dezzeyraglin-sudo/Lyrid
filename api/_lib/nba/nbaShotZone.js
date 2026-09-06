// api/_lib/nba/nbaShotZone.js
//
// Location-based shot quality + open-zone read, built from ESPN play-by-play shot
// coordinates (basket at x=25, y=0; distance = sqrt((x-25)^2 + y^2), verified against
// ESPN's own text distances). This is the LOCATION half of shot quality — real, free,
// and better than TS% (a process metric, not an outcome). It does NOT capture defender
// contest/distance (that's tracking data ESPN lacks), so treat it as "where from," not
// "how open." Shadow; ZONE_EFG values are league placeholders — TUNE on NBA data.
//
// Consumes normalizeShots() output aggregated over recent games:
//   { shooterId, teamId, made, value, x, y }   (+ caller tags defTeamId for allowed maps)

const ZONE_EFG = { rim: 0.63, shortmid: 0.42, longmid: 0.40, corner3: 0.60, abovebreak3: 0.53 };
const LEAGUE_EFG = 0.53; // rough league baseline for the open-zone comparison — TUNE

export function classifyZone(x, y, value) {
  if (x == null || y == null) return null;
  const dx = x - 25, dist = Math.sqrt(dx * dx + y * y);
  const isThree = value === 3 || dist >= 22;
  if (isThree) return y <= 8 ? 'corner3' : 'abovebreak3';
  if (dist <= 4) return 'rim';
  if (dist <= 14) return 'shortmid';
  return 'longmid';
}

function tally(shots, filterFn) {
  const z = {}; let att = 0, made = 0, pts = 0;
  for (const s of shots) {
    if (filterFn && !filterFn(s)) continue;
    const zone = classifyZone(s.x, s.y, s.value); if (!zone) continue;
    z[zone] = z[zone] || { att: 0, made: 0 };
    z[zone].att++; if (s.made) z[zone].made++;
    att++; if (s.made) { made++; pts += (s.value || (zone.includes('3') ? 3 : 2)); }
  }
  return { z, att, made, pts };
}

// Player's shot-location profile: zone shares, make rate per zone, and shot-quality
// score = share-weighted expected eFG. actualEfg - expectedEfg = the hot/regression gap.
export function playerShotProfile(shots, playerId) {
  const t = tally(shots, (s) => String(s.shooterId) === String(playerId));
  if (!t.att) return { attempts: 0, insufficient: true };
  const zones = {}; let quality = 0;
  for (const [zone, v] of Object.entries(t.z)) {
    const share = v.att / t.att;
    zones[zone] = { share: +share.toFixed(3), fg: v.att ? +(v.made / v.att).toFixed(3) : null, att: v.att };
    quality += share * ZONE_EFG[zone];
  }
  const actualEfg = t.att ? (t.made + 0.5 * (t.z.corner3?.made || 0) + 0.5 * (t.z.abovebreak3?.made || 0)) / t.att : null;
  return {
    attempts: t.att, zones,
    shotQuality: +quality.toFixed(3),           // expected eFG from shot locations
    actualEfg: actualEfg != null ? +actualEfg.toFixed(3) : null,
    hotGap: actualEfg != null ? +(actualEfg - quality).toFixed(3) : null, // >0 = shooting above his shot quality (regression risk)
    insufficient: t.att < 40,
  };
}

// What a defense concedes: allowed FG% and frequency per zone (shots taken AGAINST it).
// Caller passes shots already filtered to those defended by the team (defTeamId).
export function teamAllowedProfile(shots, defTeamId) {
  const t = tally(shots, (s) => String(s.defTeamId) === String(defTeamId));
  if (!t.att) return { attempts: 0, insufficient: true };
  const zones = {};
  for (const [zone, v] of Object.entries(t.z)) {
    zones[zone] = { freq: +(v.att / t.att).toFixed(3), allowedFg: v.att ? +(v.made / v.att).toFixed(3) : null, att: v.att };
  }
  return { attempts: t.att, zones, insufficient: t.att < 80 };
}

// Open-zone read: for the player's high-usage zones, does this defense concede
// above league average? Positive = his shots come from zones this D gives up.
export function openZoneRead(playerProf, teamAllowed) {
  if (playerProf?.insufficient || teamAllowed?.insufficient) return { score: null, thin: true };
  let score = 0; const detail = [];
  for (const [zone, pv] of Object.entries(playerProf.zones)) {
    const a = teamAllowed.zones[zone]; if (!a || a.allowedFg == null) continue;
    const edge = a.allowedFg - LEAGUE_EFG;         // + = defense soft in this zone
    score += pv.share * edge;                      // weight by how much the player lives there
    detail.push({ zone, share: pv.share, allowedFg: a.allowedFg, edge: +edge.toFixed(3) });
  }
  return { score: +score.toFixed(3), detail, thin: false };
}

export default { classifyZone, playerShotProfile, teamAllowedProfile, openZoneRead };
