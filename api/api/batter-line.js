// api/batter-line.js
// Returns a batter's final box score line for a given game.
// Used for auto-grading tracked hitters.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { gamePk, mlbam } = req.query;
  if (!gamePk || !mlbam) {
    return res.status(400).json({ error: 'gamePk and mlbam required' });
  }

  try {
    const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`MLB API ${r.status}`);
    const data = await r.json();

    // Get game status from schedule endpoint (more reliable than the feed/live ?fields= variant)
    let gameStatus = 'Unknown';
    let detailedStatus = '';
    let isFinal = false;
    try {
      const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${gamePk}`;
      const sr = await fetch(schedUrl);
      if (sr.ok) {
        const sd = await sr.json();
        const game = sd.dates?.[0]?.games?.[0] || sd.games?.[0];
        if (game?.status) {
          gameStatus = game.status.abstractGameState || 'Unknown';
          detailedStatus = game.status.detailedState || '';
          // 'Final' or 'Game Over' both count as final for grading
          isFinal = gameStatus === 'Final' || detailedStatus === 'Final' || detailedStatus === 'Game Over' || detailedStatus === 'Completed Early';
        }
      }
    } catch(_) {}

    // Fallback: if box score has a non-empty teams.home.batters list AND game is not in-progress,
    // we can still grade even if status fetch failed
    if (!isFinal && data.teams?.home?.batters?.length > 0 && data.teams?.away?.batters?.length > 0) {
      // Check for innings played — if 9+ innings recorded, game is almost certainly done
      const homeInnings = data.teams.home.teamStats?.pitching?.inningsPitched;
      if (homeInnings && parseFloat(homeInnings) >= 8.5) isFinal = true;
    }

    // Look up player in both teams
    const pidKey = `ID${mlbam}`;
    let playerData = null;
    let team = null;
    for (const side of ['home', 'away']) {
      const p = data.teams?.[side]?.players?.[pidKey];
      if (p) {
        playerData = p;
        team = side;
        break;
      }
    }

    if (!playerData) {
      return res.status(200).json({
        gamePk, mlbam,
        found: false,
        gameStatus, detailedStatus, isFinal,
        message: 'Player not in this game boxscore'
      });
    }

    const batting = playerData.stats?.batting || {};
    const didPlay = (batting.atBats || 0) > 0 || (batting.plateAppearances || 0) > 0;

    const line = {
      AB: batting.atBats || 0,
      PA: batting.plateAppearances || 0,
      H: batting.hits || 0,
      R: batting.runs || 0,
      RBI: batting.rbi || 0,
      HR: batting.homeRuns || 0,
      TB: batting.totalBases || 0,
      BB: batting.baseOnBalls || 0,
      K: batting.strikeOuts || 0,
      SB: batting.stolenBases || 0,
      HBP: batting.hitByPitch || 0,
      doubles: batting.doubles || 0,
      triples: batting.triples || 0,
      summary: batting.summary || ''
    };

    // PrizePicks / Underdog fantasy score calculation
    // Singles 3, Doubles 5, Triples 8, HR 10, R 2, RBI 2, BB 2, HBP 2, SB 5
    const singles = line.H - line.doubles - line.triples - line.HR;
    const fantasyScore = (singles * 3)
      + (line.doubles * 5)
      + (line.triples * 8)
      + (line.HR * 10)
      + (line.R * 2)
      + (line.RBI * 2)
      + (line.BB * 2)
      + (line.HBP * 2)
      + (line.SB * 5);

    // Pre-grade against standard PP/UD prop lines
    const outcomes = {
      H:        line.H >= 1,
      HRR:      (line.H + line.R + line.RBI) >= 2,  // PP: H+R+RBI 1.5 line
      TB:       line.TB >= 2,                         // TB 1.5 line
      HR:       line.HR >= 1,
      R:        line.R >= 1,
      RBI:      line.RBI >= 1,
      SINGLES:  singles >= 1,
      SB:       line.SB >= 1,
      WALKS:    (line.BB + line.HBP) >= 1,
      PP_FS_6:  fantasyScore >= 6,
      PP_FS_8:  fantasyScore >= 8,
      UD_FS_5:  fantasyScore >= 5,
      UD_FS_7:  fantasyScore >= 7
    };

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      gamePk, mlbam,
      found: true,
      didPlay,
      gameStatus, detailedStatus, isFinal,
      team,
      playerName: playerData.person?.fullName || '',
      line,
      fantasyScore,
      outcomes
    });
  } catch (err) {
    console.error('batter-line error:', err);
    return res.status(500).json({ error: err.message });
  }
}
