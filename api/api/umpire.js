// api/umpire.js
// Returns assigned home plate umpire for a game + their historical K/BB/runs factors
// Umpire assignments post ~1-3 hours before first pitch per MLB

import { UMPIRE_FACTORS, classifyUmp, getAbsAdjustedFactors } from './_data/umpireFactors.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { gamePk } = req.query;

  if (!gamePk) {
    return res.status(400).json({ error: 'gamePk required' });
  }

  try {
    // Live feed includes officials when assigned
    const url = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`MLB API ${response.status}`);
    }

    const data = await response.json();
    const officials = data?.gameData?.officials || [];

    const hpUmp = officials.find(o =>
      o.officialType === 'Home Plate' ||
      o.officialType === 'Home'
    );

    if (!hpUmp) {
      // Not yet assigned
      return res.status(200).json({
        gamePk,
        assigned: false,
        message: 'Home plate umpire not yet assigned (usually posted 1-3 hours before first pitch)',
        umpire: null,
        factors: null,
        lean: null
      });
    }

    const umpName = hpUmp.official?.fullName || '';
    const factors = getAbsAdjustedFactors(umpName);

    const result = {
      gamePk,
      assigned: true,
      umpire: {
        id: hpUmp.official?.id,
        name: umpName
      },
      factors,
      absAdjusted: factors.absAdjusted || false,
      highOverturn: factors.highOverturn || false,
      ...classifyUmp(factors)
    };

    // Cache 15 min - assignments don't change once posted
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    return res.status(200).json(result);
  } catch (err) {
    console.error('Umpire error:', err);
    return res.status(200).json({
      gamePk,
      assigned: false,
      umpire: null,
      factors: null,
      error: err.message
    });
  }
}
