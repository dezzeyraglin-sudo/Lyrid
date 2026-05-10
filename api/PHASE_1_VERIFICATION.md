# Phase 1 Verification — Damage Quality Data Layer
*May 9, 2026*

## What shipped

**File 1: `api/_lib/data.js`**
- Updated Savant custom URL to request 8 new batted-ball columns:
  - `groundballs_percent`, `flyballs_percent`, `linedrives_percent`, `popups_percent`
  - `sweet_spot_percent`, `pull_percent`, `straightaway_percent`, `oppo_percent`
- Added defensive `parsePctField` helper that handles 3 known Savant naming conventions per field
- Added warning log when columns return empty for a row that has barrel data
- Surfaces 8 new fields on the `getHitterStats` return object

**File 2: `api/analyze.js`**
- Piped 7 of those fields into per-hitter `seasonStats` (gb, fb, ld, popup, sweet-spot, pull, oppo)
- Available to Phase 2 classifier and any other downstream consumer

**File 3: `public/index.html`**
- Added a Phase 1 diagnostic chip row labeled `DAMAGE` that shows GB%, FB%, LD%, PU%, Sweet%, Pull% when available
- Only renders when at least one batted-ball field has data (silent when nothing flows)

## How to verify after deploy

### Check 1: Look at any hitter on tonight's slate

Pull up a game analysis. Find any hitter card in the lineup analysis. Below the existing xwOBA / Barrel% / HH% / EV chip row, you should now see a SECOND chip row with a "DAMAGE" label followed by GB%, FB%, LD%, etc.

**Example expected output for Aaron Judge:**
```
xwOBA .395   Barrel% 22.1   HH% 64.0   EV 95.4
DAMAGE   GB% 32.1   FB% 48.5   LD% 19.4   Sweet% 38.2   Pull% 47.5
```

### Check 2: Hitter without enough batted balls (early-season call-up)

Some hitters won't have enough sample. The DAMAGE row should NOT appear at all for them — the conditional in the template hides it cleanly.

### Check 3: Open browser DevTools console while loading a slate

If Savant changed any column names since I wrote this, you'll see warnings like:

```
[data.js] Phase 1 damage quality: batted-ball columns empty despite valid row.
custRow keys: [...]
```

The keys array tells us exactly what columns Savant IS returning, so we can fix the field names. **Send me a screenshot of any such warning.**

### Check 4: API health endpoint

Hit `mismatch-finder.vercel.app/api/health` — should still return `overall=healthy`. New data fields shouldn't break the existing pipeline.

## Failure modes (and what to do)

### Failure mode A: DAMAGE row never appears
**Cause:** Savant column names different from what I'm requesting.
**Diagnostic:** Open DevTools console, look for the warning log with `custRow keys`.
**Fix:** Pass me the keys list, I update the fallback aliases in `parsePctField` calls.

### Failure mode B: Some columns appear, others don't
**Cause:** Partial rename — Savant kept some columns, renamed others.
**Diagnostic:** Compare which chips show vs which are missing across multiple hitters.
**Fix:** Targeted alias addition for the missing ones.

### Failure mode C: All columns appear but values look wrong
**Cause:** Unit confusion (decimal 0.32 vs percent 32.1).
**Diagnostic:** Compare displayed values to baseballsavant.mlb.com for the same hitter.
**Fix:** Apply ×100 multiplier in the parsePctField helper.

### Failure mode D: Stats page slow to load
**Cause:** Adding columns shouldn't increase fetch time, but if Savant rate-limits or the larger CSV is slower, might add a second.
**Diagnostic:** Compare load time before/after deploy.
**Fix:** Probably fine — Savant CSVs are tiny, +8 columns is negligible.

## What this does NOT do

- **No archetype classification yet.** The data is flowing but nothing is labeled as ELITE POWER / LINE-DRIVE / etc. That's Phase 2.
- **No tier shifts on prop recommendations.** The matchup matrix from the design doc isn't applied yet. That's Phase 2.
- **No badges on hitter cards.** Visual badges come in Phase 2 once classification is real.
- **No projection multipliers.** Lineup-level damage signals don't affect run totals yet. That's Phase 3.
- **No demon trap detection.** That's Phase 3.

## Phase 1 acceptance criteria

✅ Phase 1 is verified complete when:
1. DAMAGE chip row appears on at least 70% of hitters analyzed
2. Values look sane (GB% + FB% + LD% + PU% should sum to ~100%)
3. No console warnings about empty columns
4. No regression on existing functionality

If those all check out, we're ready for Phase 2 (archetype classification + badges).

## Phase 2 entry point

When you come back to build Phase 2:
1. Confirm Phase 1 is still working (DAMAGE chips visible on slate analysis)
2. Build `api/_lib/damageArchetype.js` with `classifyHitter()` and `classifyPitcher()`
3. Apply to per-hitter analysis
4. Add archetype badges (visual ribbons) to hitter cards
5. Apply tier shifts to prop recommendations based on matchup matrix

The DAMAGE chip row stays in place as a diagnostic — gives you raw data to verify the classifier is making sensible calls.
