// api/pitcher-arsenal.js
import { getPitcherArsenal } from './_lib/data.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { mlbam, season } = req.query;
  if (!mlbam) return res.status(400).json({ error: 'mlbam required' });
  const yr = season || new Date().getFullYear();

  try {
    const pitches = await getPitcherArsenal(mlbam, yr);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ mlbam, season: yr, pitches });
  } catch (err) {
    console.error('Arsenal error:', err);
    return res.status(200).json({ mlbam, season: yr, pitches: [], error: err.message });
  }
}
