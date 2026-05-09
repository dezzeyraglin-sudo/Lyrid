// api/park-factor.js
// Returns park factor for a given venue ID or home team abbreviation

import { PARK_FACTORS, PARK_FACTORS_BY_TEAM, classifyPF } from './_data/parkFactors.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { venueId, team } = req.query;

  let pf = null;

  if (venueId && PARK_FACTORS[venueId]) {
    pf = PARK_FACTORS[venueId];
  } else if (team) {
    const key = String(team).toUpperCase();
    if (PARK_FACTORS_BY_TEAM[key]) {
      pf = { ...PARK_FACTORS_BY_TEAM[key], team: key };
    }
  }

  if (!pf) {
    return res.status(404).json({
      error: 'Park not found',
      requested: { venueId, team }
    });
  }

  // Add classifications
  const classified = {
    ...pf,
    tiers: {
      runs: classifyPF(pf.runs, 'runs'),
      hr: classifyPF(pf.hr, 'hr'),
      hits: classifyPF(pf.hits, 'hits'),
      so: classifyPF(pf.so, 'so'),
      lhbHr: classifyPF(pf.lhbHr, 'hr'),
      rhbHr: classifyPF(pf.rhbHr, 'hr')
    }
  };

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json(classified);
}
