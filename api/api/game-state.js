// api/game-state.js
// Returns current live score + status for a game. Used by:
//   - Mobile app (shows live score alongside projection)
//   - Web app (same, for analysis screen)
//   - Projection auditor (grades projection vs actual when final)
//
// Safe to call during in-progress games — returns current state.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { gamePk } = req.query;
  if (!gamePk) return res.status(400).json({ error: 'gamePk required' });

  try {
    const url = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`MLB API ${r.status}`);
    const feed = await r.json();

    const status = feed?.gameData?.status || {};
    const ls = feed?.liveData?.linescore || feed?.gameData?.linescore || {};
    const teams = feed?.gameData?.teams || {};

    // Extract inning-by-inning runs
    const innings = (ls.innings || []).map(inn => ({
      num: inn.num,
      away: inn.away?.runs ?? null,
      home: inn.home?.runs ?? null
    }));

    // Inning 1 runs for YRFI grading
    const inn1 = innings.find(i => i.num === 1);
    const awayRunsInn1 = inn1?.away ?? null;
    const homeRunsInn1 = inn1?.home ?? null;

    const result = {
      gamePk: Number(gamePk),
      status: {
        coded: status.codedGameState,              // 'S' scheduled, 'I' in progress, 'F' final, 'O' game over
        detailed: status.detailedState,            // 'Scheduled', 'Pre-Game', 'In Progress', 'Final'
        abstract: status.abstractGameState,        // 'Preview', 'Live', 'Final'
        isFinal: status.codedGameState === 'F' || status.codedGameState === 'O',
        isLive: status.codedGameState === 'I'
      },
      score: {
        away: ls.teams?.away?.runs ?? null,
        home: ls.teams?.home?.runs ?? null,
        awayHits: ls.teams?.away?.hits ?? null,
        homeHits: ls.teams?.home?.hits ?? null,
        awayErrors: ls.teams?.away?.errors ?? null,
        homeErrors: ls.teams?.home?.errors ?? null
      },
      inning: {
        current: ls.currentInning ?? null,
        state: ls.inningState ?? null,             // 'Top', 'Bottom', 'Middle', 'End'
        half: ls.inningHalf ?? null,
        ordinal: ls.currentInningOrdinal ?? null   // '3rd', '7th'
      },
      firstInning: {
        awayRuns: awayRunsInn1,
        homeRuns: homeRunsInn1,
        total: (awayRunsInn1 ?? 0) + (homeRunsInn1 ?? 0),
        complete: inn1 && inn1.home != null   // bottom of 1 done
      },
      innings,
      teams: {
        away: {
          id: teams.away?.id,
          name: teams.away?.name,
          abbreviation: teams.away?.abbreviation
        },
        home: {
          id: teams.home?.id,
          name: teams.home?.name,
          abbreviation: teams.home?.abbreviation
        }
      }
    };

    // Cache aggressively when final, briefly when live
    if (result.status.isFinal) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    } else if (result.status.isLive) {
      res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=40');
    } else {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('game-state error:', err);
    return res.status(200).json({
      gamePk: Number(gamePk),
      status: { coded: 'UNKNOWN', isFinal: false, isLive: false },
      error: err.message
    });
  }
}
