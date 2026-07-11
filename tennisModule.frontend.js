/* tennisModule.frontend.js — drop-in SPA module. Exposes window.LyridTennis.
 * Mirrors the CS2 card conventions (lyrid-game-card / lyrid-empty). Fetches /api/tennis/analyze
 * and renders a match read. Every prop shows PRIOR-ONLY badges — nothing is presented as a bet
 * until you've graded a real slate and promoted the tiers in tennisClassify.
 * Integrate: paste inside the SPA's main <script> (or load as a module), then call
 * LyridTennis.analyze({a:'Jannik Sinner', b:'Alexander Zverev', surface:'Hard', lines:{acesA:11.5, totalGames:22.5}})
 * and drop LyridTennis.renderInto(el, read) — or use the returned HTML.
 */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');

  // Prior-lean label → badge class (reuses your tier palette; PRIOR-* are visually distinct).
  function badgeClass(tier) {
    const t = String(tier || '');
    if (t.includes('GUARANTEED')) return 'lyrid-badge tier-guaranteed prior';
    if (t.includes('PLATINUM')) return 'lyrid-badge tier-platinum prior';
    if (t.includes('GOLD')) return 'lyrid-badge tier-gold prior';
    if (t === 'BANNED') return 'lyrid-badge tier-banned';
    return 'lyrid-badge tier-ungraded';
  }

  function propRow(label, prop) {
    if (!prop) return '';
    const v = prop.verdict || {};
    return `
      <div class="lyrid-tennis-prop">
        <div class="lyrid-tennis-prop-head">
          <span class="lyrid-tennis-prop-label">${esc(label)}</span>
          <span class="${badgeClass(v.tier)}">${esc(v.tier || 'UNGRADED')}</span>
        </div>
        <div class="lyrid-tennis-prop-line">${esc(prop.lean)} ${esc(prop.line)} ·
          model ${pct(prop.prob)} · proj ${prop.mean == null ? '—' : prop.mean.toFixed(1)}</div>
        <div class="lyrid-tennis-prop-reason">${esc(v.reason || '')}</div>
      </div>`;
  }

  function render(read) {
    if (!read) return `<div class="lyrid-empty"><div class="lyrid-empty-title">No read</div></div>`;
    const w = read.winProb || {};
    const names = Object.keys(w).filter((k) => k !== 'favored' && k !== 'edge');
    const holds = read.holds || {};
    const drivers = (read.drivers && read.drivers.aces || []).concat(read.drivers && read.drivers.totalGames || []);
    const gates = read.gates || {};
    const gateChips = [
      gates.thinSampleA || gates.thinSampleB ? 'thin surface sample' : '',
      gates.retirementA || gates.retirementB ? 'retirement risk' : '',
      gates.blowout ? 'rout risk' : '',
    ].filter(Boolean);

    return `
      <div class="lyrid-game-card lyrid-tennis-read">
        <div class="lyrid-tennis-header">
          <div class="lyrid-tennis-matchup">${esc(read.matchup)}</div>
          <div class="lyrid-tennis-sub">${esc(read.surface)} · ${esc(read.bestOf === 5 ? 'Bo5' : 'Bo3')} ·
            favored ${esc(w.favored || '—')}</div>
        </div>
        <div class="lyrid-tennis-winprob">
          ${names.map((n) => `<span>${esc(n)} ${pct(w[n])} · hold ${pct(holds[n])}</span>`).join('')}
        </div>
        <div class="lyrid-tennis-props">
          ${propRow('Aces — ' + names[0], read.props && read.props.acesA)}
          ${propRow('Aces — ' + names[1], read.props && read.props.acesB)}
          ${propRow('Double Faults — ' + names[0], read.props && read.props.dfA)}
          ${propRow('Total Games', read.props && read.props.totalGames)}
        </div>
        ${drivers.length ? `<details class="lyrid-tennis-drivers"><summary>why</summary>
          <ul>${drivers.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}
        ${gateChips.length ? `<div class="lyrid-tennis-gates">${gateChips.map((g) =>
          `<span class="lyrid-chip warn">${esc(g)}</span>`).join('')}</div>` : ''}
        <div class="lyrid-tennis-footer">Priors only — not bets. Uses: ${esc((read.usesFields || []).join(', '))}.
          Ignores: ${esc((read.ignoresFields || []).join(', '))}.</div>
      </div>`;
  }

  async function analyze(opts = {}) {
    const qs = new URLSearchParams();
    qs.set('a', opts.a); qs.set('b', opts.b);
    if (opts.surface) qs.set('surface', opts.surface);
    if (opts.bestOf) qs.set('bestOf', opts.bestOf);
    if (opts.rankA != null) qs.set('rankA', opts.rankA);
    if (opts.rankB != null) qs.set('rankB', opts.rankB);
    if (opts.h2h) qs.set('h2h', opts.h2h);
    const L = opts.lines || {};
    for (const k of ['acesA', 'acesB', 'dfA', 'totalGames']) if (L[k] != null) qs.set(k, L[k]);
    const r = await fetch('/api/tennis/analyze?' + qs.toString(), { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return j.read;
  }

  function renderInto(el, read) { if (el) el.innerHTML = render(read); }

  window.LyridTennis = { analyze, render, renderInto };
})();
