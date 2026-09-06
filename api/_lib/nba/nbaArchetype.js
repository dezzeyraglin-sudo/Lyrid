// api/_lib/nba/nbaArchetype.js
//
// Shot-type archetype for the player card, assigned from the player's own data:
// bbref rates (3PA rate, FT rate, USG%, AST%, TRB%) refined by the ESPN shot-zone
// profile when available. Rule-based + a confidence score; every threshold is a TUNE
// placeholder. Each archetype carries a signalHint — the market/variance tendency it
// implies — so the card and the engine speak the same language.

const ARCH = {
  PLAYMAKER:      { label: 'Playmaking Guard',      hint: 'assist-market focus; scoring can be secondary' },
  CREATOR:        { label: 'Primary Shot Creator',  hint: 'high usage; volume floor, but self-created variance' },
  SLASHER:        { label: 'Rim-Pressure Slasher',  hint: 'whistle floor — points-over floor even on cold nights' },
  STRETCH_BIG:    { label: 'Stretch Big',           hint: 'boards + threes; 3P variance on the scoring line' },
  INTERIOR_BIG:   { label: 'Interior Big',          hint: 'low-variance scoring; rebound-driven' },
  CS_WING:        { label: 'Catch-and-Shoot Wing',  hint: 'high shooting variance — fade thin PRA/points overs' },
  FLOOR_SPACER:   { label: 'Floor-Spacing Scorer',  hint: 'perimeter-heavy; boom/bust scoring' },
  MIDRANGE:       { label: 'Midrange Scorer',       hint: 'stable volume, modest efficiency' },
  BALANCED:       { label: 'Balanced Scorer',       hint: 'no dominant tendency' },
};

// r: { fg3aRate, ftr, usgPct, astPct, trbPct, pos }  shotZone: playerShotProfile (optional)
export function assignArchetype(r = {}, shotZone = null) {
  const fg3 = r.fg3aRate ?? null, ftr = r.ftr ?? null, usg = r.usgPct ?? null;
  const ast = r.astPct ?? null, trb = r.trbPct ?? null;
  const z = (shotZone && !shotZone.insufficient) ? shotZone.zones : null;
  const rimShare = z ? (z.rim?.share || 0) : null;
  const threeShare = z ? ((z.corner3?.share || 0) + (z.abovebreak3?.share || 0)) : null;
  const midShare = z ? ((z.shortmid?.share || 0) + (z.longmid?.share || 0)) : null;

  const traits = [];
  if (fg3 != null) traits.push(`3PAr ${fg3.toFixed(2)}`);
  if (ftr != null) traits.push(`FTr ${ftr.toFixed(2)}`);
  if (usg != null) traits.push(`USG ${usg.toFixed(1)}%`);
  if (ast != null) traits.push(`AST ${ast.toFixed(1)}%`);
  if (z) traits.push(`rim ${(rimShare*100)|0}% / mid ${(midShare*100)|0}% / 3 ${(threeShare*100)|0}%`);

  // priority-ordered rules (TUNE thresholds)
  let key, conf = 0.6;
  const big = (trb != null && trb >= 13);
  const perimeter = (fg3 != null && fg3 >= 0.45) || (threeShare != null && threeShare >= 0.5);
  const bigStretch = (fg3 != null && fg3 >= 0.33) || (threeShare != null && threeShare >= 0.4); // bigs shoot fewer 3s
  const interior = (fg3 != null && fg3 < 0.2) || (rimShare != null && rimShare >= 0.45);

  if (ast != null && ast >= 28 && (usg == null || usg >= 20)) { key = 'PLAYMAKER'; conf = 0.7; }
  else if (big && bigStretch) { key = 'STRETCH_BIG'; conf = 0.75; }
  else if (big && interior) { key = 'INTERIOR_BIG'; conf = 0.8; }
  else if (ftr != null && ftr >= 0.4 && (fg3 == null || fg3 < 0.3)) { key = 'SLASHER'; conf = 0.75; }
  else if (usg != null && usg >= 27 && ftr != null && ftr >= 0.22) { key = 'CREATOR'; conf = 0.7; }
  else if (perimeter && usg != null && usg < 22) { key = 'CS_WING'; conf = 0.75; }
  else if (perimeter && usg != null && usg >= 22) { key = 'FLOOR_SPACER'; conf = 0.65; }
  else if (midShare != null && midShare >= 0.45) { key = 'MIDRANGE'; conf = 0.7; }
  else { key = 'BALANCED'; conf = 0.5; }

  // confidence bump when the shot-zone data corroborates a perimeter/interior read
  if (z && ((key === 'CS_WING' || key === 'FLOOR_SPACER' || key === 'STRETCH_BIG') && threeShare >= 0.55)) conf = Math.min(0.9, conf + 0.1);
  if (z && (key === 'SLASHER' || key === 'INTERIOR_BIG') && rimShare >= 0.5) conf = Math.min(0.9, conf + 0.1);

  return { archetype: ARCH[key].label, key, signalHint: ARCH[key].hint, confidence: +conf.toFixed(2), traits, usedShotZone: !!z };
}

export default { assignArchetype };
