// api/_lib/nba/parseAnalysis.js
// Reads a pasted matchup/analysis writeup and extracts structured prop reads, then RECONCILES
// them against the engine's own projection + calibration. The text is NEVER a signal source
// (v4: scheme/matchup narrative ~r0.05 on props, and it skews to overs — the weak side). It is
// an EXTERNAL read the engine judges: agree/conflict with the engine lean, the live cohort
// rate, and an over-caution flag. Pushed reads are tagged source:'pasted-analysis' so the
// calibration layer grades THEM over time and tells you if the stream actually beats breakeven.

const MARKET_PATTERNS = [
  [/\bP\s*\+\s*R\s*\+\s*A\b|\bPRA\b/i, 'pra'],
  [/\bP\s*\+\s*R\b|points?\s*(?:\+|and|plus)\s*rebounds?|pts?\s*\+\s*rebs?/i, 'pts_rebs'],
  [/\bP\s*\+\s*A\b|points?\s*(?:\+|and|plus)\s*assists?|pts?\s*\+\s*asts?/i, 'pts_asts'],
  [/\bR\s*\+\s*A\b|rebounds?\s*(?:\+|and|plus)\s*assists?/i, 'rebs_asts'],
  [/\b3s\b|\bthrees?\b|3-?pointers?|\b3PT\b|three-?point/i, 'threes'],
  [/\bassists?\b|\bast\b|playmaking|facilitat/i, 'assists'],
  [/\brebounds?\b|\breb\b|glass|boards/i, 'rebounds'],
  [/\bpoints?\b|\bpts\b|scoring|\bPRA\b/i, 'points'],
];
const CONF = [[/highest|strongest/i, 'highest'], [/medium-?high/i, 'medium-high'], [/\bhigh\b/i, 'high'], [/\bmedium\b|\bmed\b/i, 'medium'], [/\blow\b/i, 'low']];
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

function marketsIn(seg) {
  const found = [];
  for (const [re, m] of MARKET_PATTERNS) if (re.test(seg) && !found.includes(m)) found.push(m);
  // "points or PRA" naturally hits both points and pra — keep both as separate reads
  return found;
}
function confIn(seg) { for (const [re, c] of CONF) if (re.test(seg)) return c; return null; }

// Pull "<Capitalized Name> ... Over/Under ... <markets>" from each line.
export function parseAnalysisText(text) {
  const reads = []; const seen = new Set();
  const lines = String(text || '').split(/[\n\r]+|(?<=\.)\s+/);
  const nameRe = /([A-Z][a-z]+(?:\s+[A-Z][a-z'`-]+){1,2})\s+(Over|Under)\b/g;
  for (const line of lines) {
    let m;
    while ((m = nameRe.exec(line)) !== null) {
      const player = m[1].trim(), side = m[2].toLowerCase();
      // market phrases appear right after the side word
      const after = line.slice(m.index + m[0].length, m.index + m[0].length + 80);
      const mkts = marketsIn(after);
      const conf = confIn(line);
      for (const market of (mkts.length ? mkts : ['points'])) {
        const k = nameKey(player) + '|' + market + '|' + side;
        if (seen.has(k)) continue; seen.add(k);
        reads.push({ player, playerKey: nameKey(player), market, side, confidence: conf, source: 'pasted-analysis' });
      }
    }
  }
  return reads;
}

// Judge each read against the engine's cards + calibration. Never flips the engine.
export function reconcileReads(reads, engineCards, opts = {}) {
  const byKey = {};
  for (const c of engineCards || []) byKey[nameKey(c.player)] = c;
  const out = (reads || []).map((r) => {
    const card = byKey[r.playerKey];
    const prop = card && (card.props || []).find((p) => p.market === r.market);
    const base = { ...r, player: card ? card.player : r.player };
    if (!card) return { ...base, verdict: 'no-engine-data', note: 'player not on the analyzed slate' };
    if (!prop) return { ...base, verdict: 'no-line', note: 'no line for this market' };
    const engineSide = prop.side, agree = engineSide === r.side;
    const overCaution = r.side === 'over';
    let verdict;
    if (!agree) verdict = 'conflict';
    else if (prop.provisional) verdict = 'agree-provisional';
    else if (prop.tier === 'PASS') verdict = 'agree-but-demoted';
    else verdict = 'confirmed';
    return {
      ...base, engineSide, agree, overCaution,
      engineProjection: prop.projection, line: prop.line,
      engineTier: prop.tier, liveRate: prop.liveRate != null ? prop.liveRate : null, gradedN: prop.gradedN || 0,
      verdict,
    };
  });
  const overs = out.filter((x) => x.side === 'over').length;
  const confirmed = out.filter((x) => x.verdict === 'confirmed').length;
  return {
    reads: out,
    summary: {
      total: out.length, overs, unders: out.length - overs, confirmed,
      conflicts: out.filter((x) => x.verdict === 'conflict').length,
      overBiasWarning: overs > out.length / 2 ? 'majority overs — v4: overs are the weak side; treat as low-conviction' : null,
    },
  };
}

export default { parseAnalysisText, reconcileReads };
