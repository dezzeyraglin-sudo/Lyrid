// api/digest/cache.js
// -----------------------------------------------------------------------------
// Stores the day's assembled Top Picks digest server-side so the noon cron can
// post it even when your browser is closed. Founder-gated. The client calls this
// on load + periodically while you're in the app, so by noon today's digest is
// cached and reflects every board you've looked at.
// -----------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

const FOUNDER_USER_ID      = process.env.FOUNDER_USER_ID;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'supabase_not_configured' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'bad_token' });
  if (FOUNDER_USER_ID && userData.user.id !== FOUNDER_USER_ID) return res.status(403).json({ error: 'not_founder' });

  const body = req.body || {};
  const date = body.date;
  const plays = Array.isArray(body.plays) ? body.plays : [];
  if (!date || plays.length === 0) return res.status(400).json({ error: 'missing_date_or_plays' });

  const { error } = await supabase
    .from('digest_cache')
    .upsert({ date, plays, updated_at: new Date().toISOString() }, { onConflict: 'date' });
  if (error) return res.status(500).json({ error: 'cache_failed', detail: error.message });

  return res.status(200).json({ ok: true, date, plays: plays.length });
}
