// api/probables.js
import { getProbables } from './_lib/data.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Default to ET date, not UTC, since MLB schedules by ET
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const result = await getProbables(date);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(result);
  } catch (err) {
    console.error('Probables error:', err);
    return res.status(500).json({ error: err.message });
  }
}
