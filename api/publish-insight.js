// api/publish-insight.js
// -----------------------------------------------------------------------------
// Server-side relay: receives a publish-worthy Lyrid insight from the browser
// and fans it out to two channels, each suited to its audience:
//
//   DISCORD  -> posts immediately as a structured embed (your community; fast).
//   FACEBOOK -> goes to the Zapier hook, which runs Slack approval before posting
//               (public-facing; gated).
//
// Both target URLs live ONLY in Vercel env vars — never in client code.
// The two channels fire independently: one failing does not block the other.
// -----------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

const ZAP_HOOK              = process.env.ZAPIER_PUBLISH_HOOK;       // Zapier "Catch Hook" URL (Facebook path)
const DISCORD_WEBHOOK       = process.env.DISCORD_PUBLISH_WEBHOOK;   // Discord channel webhook URL
const FOUNDER_USER_ID       = process.env.FOUNDER_USER_ID;
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_TIERS = new Set(['platinum', 'elite', 'verified']);

// Embed accent color per tier (decimal). Tweak to taste.
const TIER_COLOR = {
  elite:    16742973, // 0xFF7A3D  orange/heat
  platinum:  6740200, // 0x66D9E8  cyan/cool
  gold:     13041469, // 0xC6FF3D  lime/accent
  verified:  6740200
};

function discordEmbed(insight, tier) {
  const engineLine = `${insight.engine || ''} ${insight.signal || ''}`.trim() || '—';
  const hitRate = insight.confidence !== '' && insight.confidence != null
    ? `${insight.confidence}%${insight.sample_n ? ` (n=${insight.sample_n})` : ''}`
    : '—';
  return {
    username: 'Lyrid Signals',
    embeds: [{
      title: `${tier.toUpperCase()} — ${insight.matchup}`,
      description: `**${insight.lean}**`,
      url: 'https://lyrid.app',
      color: TIER_COLOR[tier] || 8421504,
      fields: [
        { name: 'Market',   value: insight.market || '—', inline: true },
        { name: 'Engine',   value: engineLine,            inline: true },
        { name: 'Hit Rate', value: hitRate,               inline: true }
      ],
      footer: { text: 'Lyrid • analytics, not advice' },
      timestamp: new Date().toISOString()
    }]
  };
}

// Build a single multi-play digest embed (one promotional post listing top plays).
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

async function postDigestToDiscord(plays, dateStr) {
  const r = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(digestEmbed(plays, dateStr))
  });
  if (!r.ok) throw new Error(`discord ${r.status}`);
  return true;
}

async function postDigestToZapier(plays, dateStr) {
  const r = await fetch(ZAP_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'digest', date: dateStr, plays, sent_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`zapier ${r.status}`);
  return true;
}

async function postToDiscord(insight, tier) {
  const r = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(discordEmbed(insight, tier))
  });
  if (!r.ok) throw new Error(`discord ${r.status}`); // Discord returns 204 on success
  return true;
}

async function postToZapier(insight, tier) {
  const r = await fetch(ZAP_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      insight_id: insight.insight_id,
      matchup:    insight.matchup,
      market:     insight.market    || '',
      lean:       insight.lean,
      engine:     insight.engine    || '',
      signal:     insight.signal    || '',
      confidence: insight.confidence ?? '',
      sample_n:   insight.sample_n   ?? '',
      tier,
      sent_at:    new Date().toISOString()
    })
  });
  if (!r.ok) throw new Error(`zapier ${r.status}`);
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!ZAP_HOOK && !DISCORD_WEBHOOK) {
    console.error('[publish-insight] no channel configured (set ZAPIER_PUBLISH_HOOK and/or DISCORD_PUBLISH_WEBHOOK)');
    return res.status(500).json({ error: 'no_channel_configured' });
  }

  // --- 1. Auth gate: only the founder's logged-in session may trigger a post ---
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });

  let supabase = null;
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'bad_token' });
    if (FOUNDER_USER_ID && userData.user.id !== FOUNDER_USER_ID) {
      return res.status(403).json({ error: 'not_founder' });
    }
  }

  // --- 1b. DIGEST mode: one curated multi-play promo post (button / daily cron) ---
  if ((req.body || {}).type === 'digest') {
    const plays = Array.isArray(req.body.plays) ? req.body.plays : [];
    const dateStr = req.body.date || new Date().toISOString().slice(0, 10);
    if (plays.length === 0) {
      return res.status(400).json({ error: 'no_plays' });
    }
    const jobs = [];
    if (DISCORD_WEBHOOK) jobs.push(['discord', postDigestToDiscord(plays, dateStr)]);
    if (ZAP_HOOK)        jobs.push(['facebook', postDigestToZapier(plays, dateStr)]);
    const settled = await Promise.allSettled(jobs.map(([, p]) => p));
    const result = {};
    settled.forEach((s, i) => {
      const name = jobs[i][0];
      result[name] = s.status === 'fulfilled' ? 'sent' : `failed: ${s.reason?.message || 'error'}`;
      if (s.status === 'rejected') console.warn(`[publish-insight:digest] ${name}`, s.reason?.message);
    });
    const anySent = Object.values(result).some(v => v === 'sent');
    return res.status(anySent ? 200 : 502).json({ type: 'digest', plays: plays.length, channels: result });
  }

  // --- 2. Validate the insight payload ---
  const insight = req.body || {};
  const tier = String(insight.tier || '').toLowerCase();

  if (!insight.insight_id || !insight.matchup || !insight.lean) {
    return res.status(400).json({ error: 'missing_fields', need: ['insight_id', 'matchup', 'lean'] });
  }
  if (!ALLOWED_TIERS.has(tier) && insight.post_eligible !== true) {
    return res.status(200).json({ skipped: 'tier_not_eligible', tier });
  }

  // --- 3. Dedup by insight_id (one publish attempt across both channels) ---
  if (supabase) {
    const { error: insErr } = await supabase
      .from('published_insights')
      .insert({ insight_id: insight.insight_id });
    if (insErr) {
      if (insErr.code === '23505') {
        return res.status(200).json({ skipped: 'already_published', insight_id: insight.insight_id });
      }
      console.warn('[publish-insight] dedup insert error:', insErr.message);
    }
  }

  // --- 4. Fan out. Channels fire independently; one failing won't block the other.
  const jobs = [];
  if (DISCORD_WEBHOOK) jobs.push(['discord', postToDiscord(insight, tier)]);
  if (ZAP_HOOK)        jobs.push(['facebook', postToZapier(insight, tier)]);

  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const result = {};
  settled.forEach((s, i) => {
    const name = jobs[i][0];
    result[name] = s.status === 'fulfilled' ? 'sent' : `failed: ${s.reason?.message || 'error'}`;
    if (s.status === 'rejected') console.warn(`[publish-insight] ${name}`, s.reason?.message);
  });

  const anySent = Object.values(result).some(v => v === 'sent');
  return res.status(anySent ? 200 : 502).json({ insight_id: insight.insight_id, channels: result });
}

// -----------------------------------------------------------------------------
// CommonJS variant: swap the import for require(), and `export default` for
// module.exports = async function handler(req, res) { ... }.
// -----------------------------------------------------------------------------
