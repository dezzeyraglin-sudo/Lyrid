// api/cron/wnba-prefetch.js
//
// Scheduled prefetch: pulls WNBA props + injuries from BallDontLie and writes
// them to the Supabase cache (wnba_cache). The slate then reads warm data with
// zero BDL calls at request time — instant loads, and no trial-rate-cap throttle
// hitting the user. The cron can take its time spacing calls under the 5/min cap
// because nobody is waiting on it.
//
// SCHEDULE: registered in vercel.json (e.g. every 10 minutes). Vercel cron sends
// a GET with an Authorization: Bearer <CRON_SECRET> header — we verify it so the
// endpoint can't be triggered to burn the BDL budget by randoms.
//
// FAIL-SAFE: always returns 200 with a JSON report; never throws.

import { fetchWnbaProps, fetchWnbaInjuries } from '../_lib/wnba/bdlFeed.js';
import { cacheWrite, CACHE_KEYS, isCacheConfigured } from '../_lib/wnba/wnbaCache.js';

// "Today" in US Eastern (WNBA scheduling TZ), matching the slate's date logic.
function easternDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export default async function handler(req, res) {
  // Auth: allow Vercel cron (Bearer CRON_SECRET) or a manual ?key= for testing.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers?.authorization || '';
    const url = new URL(req.url, 'http://localhost');
    const keyParam = url.searchParams.get('key');
    const ok = auth === `Bearer ${secret}` || keyParam === secret;
    if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const report = { ok: true, ranAt: new Date().toISOString(), cacheConfigured: isCacheConfigured(), steps: {} };

  if (!isCacheConfigured()) {
    report.ok = false;
    report.error = 'Supabase cache not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing). Prefetch has nowhere to write.';
    return res.status(200).json(report);
  }

  const date = easternDate();

  // 1) Props for today (forces a fresh fetch, bypassing the in-memory TTL).
  try {
    const props = await fetchWnbaProps(date, { noCache: true });
    const wrote = await cacheWrite(CACHE_KEYS.props(date), props);
    report.steps.props = {
      date, propRows: props?._audit?.propRows ?? 0,
      lines: Object.keys(props?.propLines || {}).length, wrote,
    };
  } catch (err) {
    report.steps.props = { error: err.message };
  }

  // 2) Injuries (slate-wide, not date-specific).
  try {
    const injuries = await fetchWnbaInjuries({ noCache: true });
    const wrote = await cacheWrite(CACHE_KEYS.injuries(), injuries);
    report.steps.injuries = { count: injuries?.all?.length ?? 0, wrote };
  } catch (err) {
    report.steps.injuries = { error: err.message };
  }

  return res.status(200).json(report);
}
