// nflCardSummary.js
// Lyrid NFL engine — the human layer (Layer 10).
// Turns an analyzeProp() result into (a) data-backed bullet explanations and
// (b) one short plain-language paragraph on why this player should clear the line
// or fall under it.
//
// RULE: every sentence must trace to a number the engine actually computed. No
// filler, no narrative that isn't in the signals. If a driver isn't there, it
// doesn't get mentioned. If the read is thin, the summary says so instead of
// sounding confident.

const DIR_WORD = { '+': 'helps', '-': 'hurts' };

function pctTxt(p) { return p == null ? null : `${Math.round(p * 100)}%`; }

// ---- 1. BULLETS — each one cites its own number ----
export function buildExplanations(analysis) {
  const b = [];
  const s = analysis?.signals || {};
  const v = analysis?.verdict || {};

  // line vs model median (the core)
  if (v.pOver != null && analysis.comp?.median != null) {
    const soft = analysis.comp.lineSoftness;
    b.push({
      label: 'Line vs model',
      value: `median ${analysis.comp.median} vs line ${v.line}`,
      dir: soft > 0 ? '+' : '-',
      text: soft > 0
        ? `Comparable player-games in this scenario median ${analysis.comp.median} yards — ${Math.abs(soft)} above the line.`
        : `Comparable games median ${analysis.comp.median} yards — ${Math.abs(soft)} BELOW the line.`,
    });
  }

  // volume floor
  if (s.volume?.volume_floor_score != null) {
    const d = s.volume.detail || {};
    const bits = [];
    if (d.tsMean != null) bits.push(`${pctTxt(d.tsMean)} target share`);
    if (d.routeMean != null) bits.push(`${pctTxt(d.routeMean)} of routes`);
    if (d.carryMean != null) bits.push(`${d.carryMean} carries/g`);
    if (d.attMean != null) bits.push(`${d.attMean} attempts/g`);
    b.push({
      label: 'Volume floor',
      value: s.volume.volume_floor_score,
      dir: s.volume.volume_floor_score >= 0.6 ? '+' : '-',
      text: `${s.volume.archetype?.replace(/_/g, ' ')} — ${bits.join(', ') || 'role data'} (floor ${s.volume.volume_floor_score}).`,
    });
  }

  // snap security
  if (s.leakage?.parts?.snap?.score != null) {
    const sn = s.leakage.parts.snap;
    b.push({ label: 'Snap share', value: sn.score, dir: sn.nudge >= 0 ? '+' : '-',
      text: sn.reasons[0] || `snap security ${sn.score}` });
  }

  // hands / resilience
  if (s.leakage?.parts?.resilience?.z) {
    const r = s.leakage.parts.resilience;
    if (r.reasons.length) b.push({ label: 'Hands', value: r.tag, dir: r.z >= 0 ? '+' : '-', text: r.reasons[0] });
  }

  // QB accuracy
  if (s.leakage?.parts?.qbAccuracy?.reasons?.length) {
    const q = s.leakage.parts.qbAccuracy;
    b.push({ label: 'QB accuracy', value: q.tag, dir: (q.nudgeAdjusted ?? q.nudge) >= 0 ? '+' : '-', text: q.reasons[0] });
  }

  // pressure / checkdown
  if (s.pressure?.parts?.checkdown?.reasons?.length) {
    const c = s.pressure.parts.checkdown;
    b.push({ label: 'Under pressure', value: c.tag, dir: '-', text: c.reasons[0] });
  }
  if (s.pressure?.parts?.battle?.edge && s.pressure.parts.battle.edge !== 'even') {
    const bt = s.pressure.parts.battle;
    b.push({ label: 'Trench battle', value: bt.edge, dir: bt.edge === 'offense' ? '+' : '-',
      text: bt.reasons[bt.reasons.length - 1] });
  }

  // matchup / coverage
  if (analysis.narrative?.coverage?.text) {
    b.push({ label: 'Coverage', value: analysis.narrative.coverage.lean, dir: '0',
      text: analysis.narrative.coverage.text });
  }
  if (analysis.narrative?.probableCoverage?.defender) {
    const pc = analysis.narrative.probableCoverage;
    b.push({ label: 'Likely defender', value: pc.defender, dir: '0',
      text: `${pc.defender} — ${pc.basis}. (${pc.confidence} confidence; ${pc.note})` });
  }

  // suppression
  if (s.suppression?.reason && s.suppression.tag !== 'neutral') {
    b.push({ label: 'Opponent', value: s.suppression.tag, dir: s.suppression.nudge >= 0 ? '+' : '-',
      text: s.suppression.reason });
  }

  // penalties
  if (s.leakage?.parts?.penalty?.reasons?.length && s.leakage.parts.penalty.tag !== 'neutral') {
    b.push({ label: 'Penalties', value: s.leakage.parts.penalty.tag, dir: '-',
      text: s.leakage.parts.penalty.reasons[0] });
  }

  // game script
  if (s.script?.flag) {
    b.push({ label: 'Game script', value: `risk ${s.script.risk}`, dir: '-',
      text: s.script.reasons[0] || 'blowout / abandonment risk' });
  }

  // environment
  if (s.env?.total) {
    const e = s.env;
    const parts = Object.entries(e.nudges || {}).filter(([, x]) => x).map(([k]) => k.replace(/_/g, ' '));
    if (parts.length) b.push({ label: 'Conditions', value: e.roof, dir: e.total >= 0 ? '+' : '-',
      text: `${e.venue} (${e.roof})${parts.length ? ' — ' + parts.join(', ') : ''}.` });
  }

  // former team (informational only)
  if (analysis.revenge?.isRevengeGame) {
    b.push({ label: 'Former team', value: 'context', dir: '0', text: analysis.revenge.display });
  }

  return b;
}

// ---- 2. SUMMARY — one short paragraph, plain language ----
export function buildSummary(analysis) {
  const v = analysis?.verdict || {};
  const drivers = analysis?.narrative?.drivers || [];
  const pos = drivers.filter(d => d.dir === '+').slice(0, 2);
  const neg = drivers.filter(d => d.dir === '-').slice(0, 2);
  const name = analysis.player || 'This player';
  const lineTxt = `${v.line} ${String(analysis.propFamily || '').replace(/_/g, ' ')}`;

  // routing override takes precedence — it's the most actionable thing on the card
  if (v.routingOverride) {
    const alt = (analysis.routing?.prefer || []).map(p => `${p.who} ${String(p.prop).replace(/_/g, ' ')}`).slice(0, 2);
    return `Pass on ${name} at ${lineTxt}. ${v.routingOverride.reason} The yardage doesn't vanish — it moves${alt.length ? `, so ${alt.join(' or ')} is the better side of this offense` : ''}.`;
  }

  if (v.blocked?.some(x => /is OUT/.test(x))) {
    return `${name} is not expected to play. No action.`;
  }

  if (v.pOver == null) {
    return `${name}'s line is showing, but the baseline data needed to judge it isn't loaded yet — no lean either way. ${analysis.dataCompleteness != null ? `Data completeness ${Math.round(analysis.dataCompleteness * 100)}%.` : ''}`.trim();
  }

  const lean = v.pOverAdjusted >= 0.56 ? 'over' : (v.pOverAdjusted <= 0.44 ? 'under' : 'neutral');
  const conf = v.tier_candidate !== 'none' ? `Qualifies ${v.tier_candidate}.` : 'Does not clear the three-filter bar.';

  const posTxt = pos.length ? pos.map(d => d.f).join(' and ') : null;
  const negTxt = neg.length ? neg.map(d => d.f).join(' and ') : null;

  if (lean === 'over') {
    return `${name} projects to clear ${lineTxt} — model reads ${Math.round(v.pOverAdjusted * 100)}%. ` +
      `${posTxt ? `The case is ${posTxt}.` : ''}` +
      `${negTxt ? ` Working against it: ${negTxt}.` : ''} ${conf}`.replace(/\s+/g, ' ').trim();
  }
  if (lean === 'under') {
    return `${name} projects to fall short of ${lineTxt} — model reads ${Math.round(v.pOverAdjusted * 100)}% to go over. ` +
      `${negTxt ? `The drag is ${negTxt}.` : ''}` +
      `${posTxt ? ` In his favor: ${posTxt}.` : ''} ${conf}`.replace(/\s+/g, ' ').trim();
  }
  return `${name} sits close to a coin flip at ${lineTxt} (${Math.round(v.pOverAdjusted * 100)}%). ` +
    `${posTxt ? `For: ${posTxt}.` : ''}${negTxt ? ` Against: ${negTxt}.` : ''} No edge worth taking.`.replace(/\s+/g, ' ').trim();
}

export function buildCard(analysis) {
  return { summary: buildSummary(analysis), explanations: buildExplanations(analysis) };
}
