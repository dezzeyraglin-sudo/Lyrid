// Lyrid NFL — the shared graded history (Supabase nfl_prop_log), served to every browser.
// GET /api/nfl/history  ->  { ok, props: [entry...], totals: [entry...], count, promotion }
// The server logs and grades; browsers only read. Cached briefly at the edge.
export default async function handler(req, res) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return res.status(200).json({ ok: false, why: 'no Supabase credentials', props: [], totals: [] });
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const rows = [];
  try {
    for (let off = 0; off < 100000; off += 1000) {
      const r = await fetch(`${url}/rest/v1/nfl_prop_log?select=kind,entry&order=log_date.asc,log_key.asc&limit=1000&offset=${off}`, { headers: H });
      if (!r.ok) return res.status(200).json({ ok: false, why: `supabase ${r.status}`, props: [], totals: [] });
      const chunk = await r.json(); rows.push(...chunk);
      if (chunk.length < 1000) break;
    }
  } catch (e) {
    return res.status(200).json({ ok: false, why: String((e && e.message) || e), props: [], totals: [] });
  }
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  return res.status(200).json({ ok: true, count: rows.length,
    props: rows.filter(r => r.kind === 'prop').map(r => r.entry), totals: rows.filter(r => r.kind === 'total').map(r => r.entry) });
}
