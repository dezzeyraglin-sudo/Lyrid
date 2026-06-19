// =============================================================================
// Lyrid — Top Picks Digest publisher (CLIENT SIDE — paste into index.html)
// -----------------------------------------------------------------------------
// Sweeps the day's engines for PLATINUM/GOLD plays across sports, builds ONE
// curated digest, and posts it to /api/publish-insight (type:"digest"), which
// fans out to Discord (immediate) and Facebook (Slack approval). Promo tool to
// drive subscriptions — NOT a live-bet feed.
//
// Reads only flat state stores the app already maintains:
//   MLB totals  -> state.projectionAudit  (via classifyInverseTotalSignal/MarketSignal)
//   MLB innings -> state.firstInningBets   (your logged YRFI/NRFI conviction plays)
//   WNBA        -> state.wnbaPropHistory[currentDate]
//   CS2         -> slot left for later; add a collector when that engine exists.
// =============================================================================

const DIGEST_TIERS = new Set(['platinum', 'gold']); // qualifying bar
const DIGEST_MAX   = 6;                              // cap for a tight promo post
const TIER_RANK    = { platinum: 0, gold: 1, elite: 0, verified: 1 };

function _digestDate() {
  try { return state.currentDate || (typeof getTodayStr === 'function' ? getTodayStr() : new Date().toISOString().slice(0,10)); }
  catch { return new Date().toISOString().slice(0,10); }
}
function _pct(v) { // normalize 0-1 or 0-100 -> integer percent
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!isFinite(n)) return '';
  return Math.round(n <= 1 ? n * 100 : n);
}

// --- MLB totals: derive tiered pregame signals from the projection audit ------
function _collectTotals(date) {
  const out = [];
  try {
    const audit = state.projectionAudit || {};
    for (const k in audit) {
      const e = audit[k];
      if (!e || e.date !== date || typeof e.projTotal !== 'number') continue;
      // Use the SAME source the dashboard's TOTALS LEAN uses (Drop #31): the
      // pre-game lean is driven solely by classifyInverseTotalSignal(projTotal).
      // Previously this preferred classifyInverseMarketSignal, which returns the
      // OPPOSITE direction on high-projection games (proj >=10.5 reads OVER on the
      // board, but the market-gap signal said UNDER) — flipping O/U in the post.
      const sig = (typeof classifyInverseTotalSignal === 'function')
                    ? classifyInverseTotalSignal(e.projTotal) : null;
      if (!sig || !DIGEST_TIERS.has(String(sig.tier).toLowerCase())) continue;
      out.push({
        sport: 'MLB', market: 'Game Total',
        matchup: `${e.awayTeam || ''} @ ${e.homeTeam || ''}`.trim(),
        lean: `${sig.side} 8.5`,
        tier: String(sig.tier).toLowerCase(),
        confidence: _pct(sig.backtestWR),
        sample_n: sig.backtestN || ''
      });
    }
  } catch (err) { console.warn('[digest] totals collect:', err.message); }
  return out;
}

// --- MLB innings: your logged YRFI/NRFI plays --------------------------------
function _collectInnings(date) {
  const out = [];
  try {
    const fib = state.firstInningBets || {};
    for (const k in fib) {
      const e = fib[k];
      if (!e || e.date !== date) continue;
      const tier = String(e.tier || '').toLowerCase();
      if (!DIGEST_TIERS.has(tier) && tier !== 'strong') continue;
      out.push({
        sport: 'MLB', market: '1st Inning',
        matchup: `${e.away || ''} @ ${e.home || ''}`.trim(),
        lean: e.pick || '',
        tier: tier === 'strong' ? 'gold' : tier,
        confidence: _pct(e.probability),
        sample_n: ''
      });
    }
  } catch (err) { console.warn('[digest] innings collect:', err.message); }
  return out;
}

// --- WNBA: top tiered props ---------------------------------------------------
function _collectWnba(date) {
  const out = [];
  try {
    const day = (state.wnbaPropHistory || {})[date] || {};
    for (const k in day) {
      const e = day[k];
      if (!e) continue;
      const tier = String(e.tier || '').toLowerCase();
      if (!DIGEST_TIERS.has(tier) && !e.isTopPick) continue;
      const leanTxt = e.line != null && e.lean ? `${e.lean} ${e.line}` : (e.lean || '');
      out.push({
        sport: 'WNBA', market: e.market || 'Prop',
        matchup: [e.player, e.opponent ? `vs ${e.opponent}` : ''].filter(Boolean).join(' '),
        lean: leanTxt,
        tier: DIGEST_TIERS.has(tier) ? tier : 'gold',
        confidence: _pct(e.confidence),
        sample_n: ''
      });
    }
  } catch (err) { console.warn('[digest] wnba collect:', err.message); }
  return out;
}

// --- Assemble: combine, rank (tier then hit rate), cap ------------------------
function lyridBuildDigest() {
  const date = _digestDate();
  let plays = [..._collectTotals(date), ..._collectInnings(date), ..._collectWnba(date)]
    .filter(p => p.matchup && p.lean);
  plays.sort((a, b) => {
    const t = (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9);
    if (t !== 0) return t;
    return (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
  });
  return { date, plays: plays.slice(0, DIGEST_MAX) };
}

// --- Post the digest to the relay --------------------------------------------
async function lyridPostDigest(digest) {
  const res = await fetch('/api/publish-insight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ type: 'digest', date: digest.date, plays: digest.plays })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// --- Floating "Post Top Picks" button ----------------------------------------
function lyridMountDigestButton() {
  if (document.getElementById('lyridDigestBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'lyridDigestBtn';
  btn.textContent = '📣 Post Top Picks';
  btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;padding:12px 18px;' +
    'border:none;border-radius:24px;background:#1e3a8a;color:#fff;font-weight:700;font-size:14px;' +
    'box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;';
  btn.onclick = async () => {
    const digest = lyridBuildDigest();
    if (digest.plays.length === 0) {
      alert('No PLATINUM/GOLD plays found for ' + digest.date + '. Load the MLB/WNBA boards first.');
      return;
    }
    const preview = digest.plays
      .map(p => `• [${p.sport}] ${p.lean} — ${p.matchup} (${p.tier.toUpperCase()}${p.confidence ? ' ' + p.confidence + '%' : ''})`)
      .join('\n');
    if (!confirm(`Post this digest (${digest.plays.length} plays) to Discord + Facebook approval?\n\n${preview}`)) return;
    btn.disabled = true; btn.textContent = 'Posting…';
    try {
      const r = await lyridPostDigest(digest);
      if (r.ok) {
        const ch = r.data?.channels || {};
        alert(`Sent.\nDiscord: ${ch.discord || '?'}\nFacebook: ${ch.facebook || '?'}`);
      } else if (r.status === 403) {
        alert('Only the founder account can post.');
      } else {
        alert('Failed: ' + (r.data?.error || r.status));
      }
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '📣 Post Top Picks';
    }
  };
  document.body.appendChild(btn);
}
// Mount once the page is ready.
if (document.readyState !== 'loading') lyridMountDigestButton();
else document.addEventListener('DOMContentLoaded', lyridMountDigestButton);
