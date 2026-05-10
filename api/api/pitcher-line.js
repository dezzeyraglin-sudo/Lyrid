// api/pitcher-line.js
//
// Returns a pitcher's final box score line for a given game.
// Used for auto-grading logged pitcher prop bets (Strikeouts / Outs / ER / BB / Win).
//
// Response shape (when found and game is final):
//   {
//     gamePk, mlbam, found: true, didPitch: true,
//     gameStatus, detailedStatus, isFinal,
//     team: 'home' | 'away',
//     playerName: 'Tarik Skubal',
//     line: { K, IP, IPouts, BB, ER, H, HR, decision },
//     outcomes: {
//       // Pre-graded against common book lines (caller picks side based on bet metadata)
//       K_4_5: bool,  // K ≥ 4.5 (won an Over 4.5 K bet)
//       K_5_5: bool,
//       ...
//       // For non-line props, the value is directly comparable
//     }
//   }
//
// Notes on edge cases:
//   - "Did not pitch": if the pitcher is in the box score but has 0 batters faced
//     and 0 IPouts, treat as didnotplay (rare — usually a pitcher who was scheduled
//     but scratched returns found: false instead).
//   - Rain-shortened games: still grade based on whatever stats accumulated. The
//     auto-grader caller decides how to handle these (typically grade as-is; if
//     the bet voided due to non-qualifying start, mark as push manually).
//   - IPouts vs. IP: MLB Stats API returns IP as a string like "6.1" meaning
//     6 innings + 1 out (not 6.1 innings). We expose both for safety.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { gamePk, mlbam } = req.query;
  if (!gamePk || !mlbam) {
    return res.status(400).json({ error: 'gamePk and mlbam required' });
  }

  try {
    const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`MLB API ${r.status}`);
    const data = await r.json();

    // Game status (separate fetch — more reliable than boxscore status)
    let gameStatus = 'Unknown';
    let detailedStatus = '';
    let isFinal = false;
    try {
      const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${gamePk}`;
      const sr = await fetch(schedUrl, { signal: AbortSignal.timeout(5000) });
      if (sr.ok) {
        const sd = await sr.json();
        const game = sd.dates?.[0]?.games?.[0] || sd.games?.[0];
        if (game?.status) {
          gameStatus = game.status.abstractGameState || 'Unknown';
          detailedStatus = game.status.detailedState || '';
          isFinal = gameStatus === 'Final'
                 || detailedStatus === 'Final'
                 || detailedStatus === 'Game Over'
                 || detailedStatus === 'Completed Early';
        }
      }
    } catch (_) {}

    // Same fallback as batter-line: if both teams have pitchers logged and 8.5+ IP recorded,
    // the game is almost certainly done even if status fetch failed.
    if (!isFinal && data.teams?.home?.pitchers?.length > 0 && data.teams?.away?.pitchers?.length > 0) {
      const homeIp = data.teams.home.teamStats?.pitching?.inningsPitched;
      if (homeIp && parseFloat(homeIp) >= 8.5) isFinal = true;
    }

    // Locate the pitcher in either team
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
        message: 'Pitcher not in this game boxscore'
      });
    }

    const pitching = playerData.stats?.pitching || {};

    // Parse innings pitched. MLB API returns IP as string "6.1" meaning 6 innings + 1 out.
    // Convert to total outs for clean math (1 inning = 3 outs).
    const ipStr = pitching.inningsPitched || '0.0';
    const ipMatch = String(ipStr).match(/^(\d+)(?:\.(\d))?$/);
    const fullInnings = ipMatch ? parseInt(ipMatch[1]) : 0;
    const partialOuts = ipMatch && ipMatch[2] ? parseInt(ipMatch[2]) : 0;
    const ipouts = (fullInnings * 3) + partialOuts;

    const line = {
      K: pitching.strikeOuts || 0,
      IP: ipStr,                          // string form, e.g. "6.1"
      IPouts: ipouts,                     // numeric outs for math (6.1 IP → 19 outs)
      BB: pitching.baseOnBalls || 0,
      ER: pitching.earnedRuns || 0,
      H: pitching.hits || 0,
      HR: pitching.homeRuns || 0,
      R: pitching.runs || 0,
      battersFaced: pitching.battersFaced || 0,
      pitches: pitching.pitchesThrown || pitching.numberOfPitches || 0,
      strikes: pitching.strikes || 0,
      // Decision — note (W/L/H/S) lives on stats.pitching.note in MLBAM data;
      // not always populated, so caller should check for null.
      decision: pitching.note || null,
      // Quality Start = ≥6 IP and ≤3 ER
      isQualityStart: ipouts >= 18 && (pitching.earnedRuns || 0) <= 3,
      // No-hitter and complete game flags from boxscore (Stats API exposes these on team-level
      // pitching stats but not always on individual pitcher records — derive defensively)
      isNoHitter: (pitching.completeGames > 0 || pitching.shutouts > 0) && (pitching.hits || 0) === 0
    };

    // didPitch: at least 1 batter faced or 1 out recorded.
    // Pitchers in the boxscore who didn't enter the game still appear with all-zero stats.
    const didPitch = line.battersFaced > 0 || line.IPouts > 0;

    // Pre-grade against common book lines. The bet record stores the line + side, so the
    // caller will use these to determine win/loss based on which side they bet.
    // Each entry: true if the actual stat ≥ the line value (i.e., Over wins).
    // For pitcher Ks the typical line range is 3.5 to 9.5 in 0.5-step increments.
    // For Outs (Pitching Outs) typical lines are 12.5 to 21.5.
    const kLines = [3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5];
    const outsLines = [12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5];
    const erLines = [1.5, 2.5, 3.5];
    const bbLines = [1.5, 2.5];

    const outcomes = {};
    // K Over outcomes
    for (const v of kLines) outcomes[`K_OVER_${v}`] = line.K > v;
    // Outs Over outcomes
    for (const v of outsLines) outcomes[`OUTS_OVER_${v}`] = line.IPouts > v;
    // ER Under outcomes (more common bet direction for ER)
    for (const v of erLines) outcomes[`ER_UNDER_${v}`] = line.ER < v;
    // BB Under outcomes
    for (const v of bbLines) outcomes[`BB_UNDER_${v}`] = line.BB < v;
    // Win — pitcher recorded the win (decision starts with W)
    outcomes.WIN = line.decision === 'W' || (line.decision || '').startsWith('W');
    // Quality Start
    outcomes.QUALITY_START = line.isQualityStart;
    // No-Hitter (rare; team-level no-hitter is the relevant market)
    outcomes.NO_HITTER = line.isNoHitter;

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      gamePk, mlbam,
      found: true,
      didPitch,
      gameStatus, detailedStatus, isFinal,
      team,
      playerName: playerData.person?.fullName || '',
      line,
      outcomes
    });
  } catch (err) {
    console.error('pitcher-line error:', err);
    return res.status(500).json({ error: err.message });
  }
}
