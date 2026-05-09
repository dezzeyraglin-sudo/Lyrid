// api/lineup.js
import { getLineup } from './_lib/data.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { teamId, gamePk, side } = req.query;
  if (!teamId && !gamePk) return res.status(400).json({ error: 'teamId or gamePk required' });

  try {
    const hitters = await getLineup(teamId, gamePk, side);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ teamId, gamePk, hitters });
  } catch (err) {
    console.error('Lineup error:', err);
    return res.status(500).json({ error: err.message });
  }
}
