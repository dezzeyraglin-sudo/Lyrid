// nflExplosiveness.js
// Lyrid NFL engine — chunk-play / ceiling layer.
//
// The problem it fixes: the comp kNN only sees volume + recent form, so a boom-bust
// field-stretcher (JSN, Chase) is pooled with a possession chain-mover at the same
// target share, and his fat right tail gets averaged away. His median-based P(over)
// at a STIFF line reads low even though his ceiling is exactly what clears it.
//
// THE MODEL IS SKEW-AWARE, not a bump. Boom raises P(over) at a line ABOVE the comp
// median and LOWERS it at a line below — the same variance that produces a 130-yd
// game produces a 3-for-40 dud. Direction is set by lineGap = line - median (which
// the comp exposes as -lineSoftness), so a possession player at a stiff line gets a
// NEGATIVE nudge (even less likely to spike). Additive, capped, feeds extraNudges.
//
// Inputs (all optional; missing -> neutral, never faked):
//   receiver: nfl_receiver_explosive row { explosiveness_score, adot, explosive_catch_rate, ... }
//   qb:       nfl_qb_deepball row        { deepball_score, deep_att_rate, deep_comp_pct, adot }
//   oppAllowed: { explosive_catch_rate_allowed, _z }  // _z computed vs league by the caller
//   comp:     the compProject result (for median + lineSoftness)
//   propFamily

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pct = x => (x == null ? null : `${Math.round(Number(x) * 100)}%`);

// ---- receiver boom/possession read ----
export function receiverExplosiveness(p) {
  if (!p || p.explosiveness_score == null) return { score: 0, tag: 'unknown', reasons: [] };
  const s = Number(p.explosiveness_score);
  const reasons = [];
  const tag = s >= 0.8 ? 'field_stretcher' : (s <= -0.8 ? 'possession' : 'balanced');
  if (s >= 0.8) {
    const bits = [];
    if (p.adot != null) bits.push(`${Number(p.adot).toFixed(1)} aDOT`);
    if (p.explosive_catch_rate != null) bits.push(`${pct(p.explosive_catch_rate)} of catches go 20+`);
    reasons.push(`downfield / boom-bust${bits.length ? ` — ${bits.join(', ')}` : ''}`);
  } else if (s <= -0.8) {
    reasons.push('possession / underneath — low aDOT, few chunk catches');
  }
  return { score: s, tag, adot: p.adot ?? null, explosiveCatchRate: p.explosive_catch_rate ?? null, reasons };
}

// ---- QB deep-ball read ----
export function qbDeepBall(p) {
  if (!p || p.deepball_score == null) return { score: 0, connect: 0, tag: 'unknown', reasons: [] };
  const s = Number(p.deepball_score);                                   // tendency (throws deep?)
  const connect = p.deep_connect_score != null ? Number(p.deep_connect_score) : 0; // efficiency (completes deep?)
  const highAtt = p.deep_att_rate != null && Number(p.deep_att_rate) >= 0.12;
  const reasons = [];
  let tag;
  if (s >= 0.7 && connect >= 0) tag = 'gunslinger';                     // throws deep AND connects
  else if (highAtt && connect <= -0.7) tag = 'inaccurate_deep';         // throws deep, MISSES (McCarthy)
  else if (s <= -0.7) tag = 'checkdown';                               // rarely goes deep
  else tag = 'neutral';

  if (tag === 'gunslinger') {
    const bits = [];
    if (p.deep_att_rate != null) bits.push(`${pct(p.deep_att_rate)} of throws 20+ air yds`);
    if (p.deep_comp_pct != null) bits.push(`${pct(p.deep_comp_pct)} deep completion`);
    reasons.push(`pushes it deep and connects${bits.length ? ` — ${bits.join(', ')}` : ''}`);
  } else if (tag === 'inaccurate_deep') {
    reasons.push(`throws deep but misses — ${pct(p.deep_comp_pct)} deep completion; caps his deep receivers rather than feeding them`);
  } else if (tag === 'checkdown') {
    reasons.push('checkdown lean — rarely attempts deep');
  }
  return { score: s, connect, tag, reasons };
}

// ---- THE TAIL MODEL ----
// Returns { nudge, boom, skew, tag, ceiling, reasons }. nudge folds into extraNudges.
export function explosiveTail({ receiver, qb, oppAllowed, comp, propFamily }) {
  const rec = receiverExplosiveness(receiver);
  const q = qbDeepBall(qb);
  const reasons = [];

  // composite boom score: the receiver leads; a gunslinger QB amplifies his ceiling
  // (and lifts a QB's own passing tail); a chunk-bleeding defense amplifies both.
  let boom = 0, w = 0;
  if (receiver && rec.score != null) { boom += rec.score * 1.0; w += 1.0; if (rec.reasons[0]) reasons.push(rec.reasons[0]); }
  // A receiver's ceiling keys on whether the QB actually CONNECTS deep (efficiency) —
  // a QB who throws deep but misses (McCarthy) caps him. The QB's OWN passing tail
  // keys on deep tendency (his deep volume inflates his own yardage variance).
  if (qb) {
    const qbTerm = propFamily === 'receiving_yards' ? q.connect
      : (propFamily === 'passing_yards' ? q.score : null);
    if (qbTerm != null) { boom += qbTerm * 0.6; w += 0.6; if (q.reasons[0]) reasons.push(q.reasons[0]); }
  }
  let oppZ = null;
  if (oppAllowed && oppAllowed._z != null) {
    oppZ = Number(oppAllowed._z); boom += oppZ * 0.5; w += 0.5;
    if (oppZ >= 0.6) reasons.push(`opponent bleeds chunk plays (${pct(oppAllowed.explosive_catch_rate_allowed)} of catches allowed go 20+)`);
  }
  if (!w) return { nudge: 0, boom: 0, skew: 0, tag: 'unknown', ceiling: null, reasons: [] };
  boom = boom / w;

  // skew: sign from which side of the comp median the line sits.
  // comp exposes lineSoftness = median - line, so lineGap (line - median) = -lineSoftness.
  const lineGap = comp && comp.lineSoftness != null ? -comp.lineSoftness : 0; // + = stiff (line above median)
  const sd = comp && comp.median ? Math.max(15, comp.median * 0.35) : 25;     // rough outcome sd
  const skew = Math.tanh(lineGap / sd);                                        // -1..+1
  const nudge = +clamp(boom * skew * 0.18, -0.22, 0.22).toFixed(4);

  if (nudge > 0.02) reasons.push(`boom profile clears a stiff line more often than the median implies (+${nudge})`);
  else if (nudge < -0.02) reasons.push(`boom-bust variance adds downside at this line (${nudge})`);

  const ceiling = (rec.tag === 'field_stretcher' || q.tag === 'gunslinger')
    ? { level: 'high', text: `Ceiling: explosive — ${[rec.reasons[0], q.reasons[0]].filter(Boolean).join('; ')}${oppZ != null && oppZ >= 0.6 ? '; soft chunk matchup' : ''}.` }
    : null;

  return {
    nudge, boom: +boom.toFixed(3), skew: +skew.toFixed(3),
    tag: rec.tag !== 'unknown' ? rec.tag : q.tag, ceiling, reasons,
  };
}
