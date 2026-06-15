// api/cron/post-digest.js
// -----------------------------------------------------------------------------
// Daily cron: posts today's cached Top Picks digest at NOON CENTRAL (Little Rock).
//
// DST-safe without manual edits: scheduled at both 17:00 and 18:00 UTC in
// vercel.json, but only actually posts when it's the 12:00 hour in America/Chicago
// (CDT in summer, CST in winter). Date-dedup guarantees one post per day even if
// both fire. Reads the digest the client cached on load; if nothing cached for
// today, it posts nothing.
//
// Protected by CRON_SECRET (Vercel sends it as a Bearer header on cron requests).
// -----------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

const CRON_SECRET          = process.env.CRON_SECRET;
const ZAP_HOOK             = process.env.ZAPIER_PUBLISH_HOOK;
const DISCORD_WEBHOOK      = process.env.DISCORD_PUBLISH_WEBHOOK;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIER_COLOR = { elite: 16742973, platinum: 6740200, gold: 13041469, verified: 6740200 };

function digestEmbed(plays, dateStr) {
  const fields = plays.slice(0, 8).map(p => {
    const tier = String(p.tier || '').toLowerCase();
    const hit = (p.confidence != null && p.confidence !== '')
      ? `${p.confidence}%${p.sample_n ? ` (n=${p.sample_n})` : ''}` : '';
    const head = [p.sport, p.market].filter(Boolean).join(' · ') || 'Signal';
    const body = [
      `**${p.lean || ''}** — ${p.matchup || ''}`.trim(),
      [tier ? tier.toUpperCase() : '', hit].filter(Boolean).join(' · ')
    ].filter(Boolean).join('\n');
    return { name: head, value: body || '—', inline: false };
  });
  return {
    username: 'Lyrid Signals',
    embeds: [{
      title: `Lyrid — Today's Top Signals${dateStr ? ` · ${dateStr}` : ''}`,
      description: 'The strongest plays our models are surfacing right now.',
      url: 'https://lyrid.app',
      color: TIER_COLOR.platinum,
      fields,
      footer: { text: 'Lyrid • analytics, not advice • full board at lyrid.app' },
      timestamp: new Date().toISOString()
    }]
  };
}

async function postDiscord(plays, date) {
  const r = await fetch(DISCORD_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(digestEmbed(plays, date))
  });
  if (!r.ok) throw new Error(`discord ${r.status}`);
  return true;
}
async function postZapier(plays, date) {
  const r = await fetch(ZAP_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'digest', date, plays, sent_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`zapier ${r.status}`);
  return true;
}

function chicagoNow() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) };
}

export default async function handler(req, res) {
  // Cron auth
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Only post during the noon hour, Central time (DST-safe).
  const { date, hour } = chicagoNow();
  if (hour !== 12) return res.status(200).json({ skipped: 'not_noon_central', central_hour: hour });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'supabase_not_configured' });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Read today's cached digest
  let plays = [];
  try {
    const { data } = await supabase.from('digest_cache').select('plays').eq('date', date).single();
    if (data && Array.isArray(data.plays)) plays = data.plays;
  } catch (_) { /* no row */ }
  if (plays.length === 0) return res.status(200).json({ skipped: 'no_cache', date });

  // One post per day, even if both cron times fire
  const { error: insErr } = await supabase.from('published_insights').insert({ insight_id: `digest-${date}` });
  if (insErr) {
    if (insErr.code === '23505') return res.status(200).json({ skipped: 'already_posted', date });
    console.warn('[cron] dedup insert:', insErr.message);
  }

  const jobs = [];
  if (DISCORD_WEBHOOK) jobs.push(['discord', postDiscord(plays, date)]);
  if (ZAP_HOOK)        jobs.push(['facebook', postZapier(plays, date)]);
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const result = {};
  settled.forEach((s, i) => {
    result[jobs[i][0]] = s.status === 'fulfilled' ? 'sent' : `failed: ${s.reason?.message || 'error'}`;
  });
  return res.status(200).json({ date, plays: plays.length, channels: result });
}
