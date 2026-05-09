# Damage Quality System — Design Doc
*May 9, 2026 — design phase, build deferred to next session*

## Why this matters

Two hitters with identical .350 xwOBA can produce wildly different outcomes:
- **Line-drive Hitter A:** 25% LD, 35% GB, 40% FB → consistent hits, occasional doubles, low HR
- **Flyball Hitter B:** 18% LD, 28% GB, 54% FB → more HR, more outs, more variance

The current model treats them as identical because xwOBA collapses both into one number. This is the gap that differentiates Lyrid from PrizePicks/Underdog public-data tools.

**Direct ROI use cases:**
1. **HR props (Underdog FB/PP HR):** FB% drives HR conversion. A 12% Barrel hitter at 55% FB vs 35% FB has ~30% different HR rate at the same Barrel%.
2. **TB props (PrizePicks 1.5 TB):** LD% drives doubles. Groundball hitters underhit TB lines even with high xwOBA.
3. **Hits props (PP/UD H 0.5):** GB% with high contact rate inflates hits in non-shifted alignments. LD% drives hits universally.
4. **H+R+RBI props (PP HRR):** LD-heavy hitters in high-LOB lineups score hidden hits via RBI singles. FB-heavy hitters in same spot leave runners stranded.
5. **Run total projection:** Lineup-level FB% with hitter park = overs. Lineup-level GB% with pitcher who induces grounders = unders. Currently invisible to the model.
6. **LOB / sequencing:** Groundballs with runners on first → double plays. Flyballs at least advance runners. Groundball lineups have artificially suppressed conversion rates that the conversion module can't see.

## What the model currently sees vs. what it misses

**Already in the data layer (`api/_lib/data.js`):**
- `barrel_batted_rate` — best-pitch outcome quality
- `hard_hit_percent` — contact strength
- `avg_exit_velocity` — raw power
- `xwoba`, `xba`, `xslg` — expected outcomes
- `k_percent`, `bb_percent` — plate discipline

**NOT currently fetched (the gap):**
- `gb_percent` — groundball rate
- `fb_percent` — flyball rate
- `ld_percent` — line-drive rate
- `popup_percent` — infield-fly rate
- `sweet_spot_percent` — launch-angle 8°-32° (the "damage zone")
- `pull_percent`, `straightaway_percent`, `oppo_percent` — spray angle

**Pitcher batted-ball profile NOT fetched:**
- Pitcher's induced GB% / FB% / LD% rates
- Pitcher's allowed Barrel% / sweet-spot% in matchups

These all live in Savant's custom leaderboard CSV — we just need to add the column selections to the URL. **No new API integration needed. Same endpoint, more columns.**

## The damage quality archetype system

Classify each hitter into one of five archetypes based on batted-ball profile:

### Archetype 1: ELITE POWER (FB-heavy + high Barrel%)
- FB% ≥ 45%, Barrel% ≥ 12%
- Examples: Aaron Judge, Shohei Ohtani, Kyle Schwarber
- **Prop edge:** HR overs in hitter parks. TB 1.5 in elite matchups. Avoid hits unders (they're rarely shutout).
- **Run total signal:** In hitter parks they push totals up *more* than xwOBA suggests.

### Archetype 2: LINE-DRIVE (LD-heavy + balanced)
- LD% ≥ 24%, FB% < 45%
- Examples: Luis Arraez, Steven Kwan, Freddie Freeman
- **Prop edge:** Hits 0.5 has the strongest signal. Most reliable HRR pathway. Underrated TB 1.5 in pitcher parks.
- **Run total signal:** Less park-dependent. Performs across environments.

### Archetype 3: GROUND-BALL CONTACT (GB-heavy + low K%)
- GB% ≥ 50%, K% < 20%
- Examples: Bo Bichette types, contact-first speedsters
- **Prop edge:** Hits via infield singles when not shifted. Avoid HR / TB props. STRONG fade against GB pitchers.
- **Run total signal:** Suppresses team totals when lineup is GB-heavy collectively.

### Archetype 4: ALL-OR-NOTHING (FB-heavy + high K%)
- FB% ≥ 45%, K% ≥ 25%
- Examples: Joey Gallo, Mike Zunino types
- **Prop edge:** HR yes, hits no. AVOID HRR overs (no floor). High variance — not a sharp foundation prop.
- **Run total signal:** Contributes only when matchup is exploitable.

### Archetype 5: BALANCED (no clear lean)
- None of the above thresholds met
- Most hitters
- **Prop edge:** Use existing model.
- **Run total signal:** Use existing model.

## Pitcher batted-ball archetypes

Pitchers also classify into batted-ball types. The interaction is what creates the edges.

### Pitcher Archetype A: GROUND-BALL ARTIST
- Induced GB% ≥ 50%
- Examples: Framber Valdez, Logan Webb, Clay Holmes
- **Effect on hitters:** Suppresses HR/TB across the board. Forces groundballs even from FB-heavy hitters. Triples down on GB hitters.

### Pitcher Archetype B: FLY-BALL PRONE
- Induced FB% ≥ 40%
- Examples: starters with low GB rates, sinker-less arsenals
- **Effect on hitters:** Boosts HR/TB. ELITE POWER + FLY-BALL PRONE pitcher in hitter park = green-light HR prop.

### Pitcher Archetype C: BARREL SUSCEPTIBLE
- Allowed Barrel% ≥ 9%
- **Effect on hitters:** Universal boost on damage quality. The "demon trap" of pitchers — looks fine on K rate, terrible on damage.

### Pitcher Archetype D: STANDARD
- Within typical ranges. Use base model.

## The damage matchup matrix

The interaction between hitter archetype and pitcher archetype creates predictable edges:

| Hitter \\ Pitcher | GB Artist | FB Prone | Barrel Susceptible | Standard |
|---|---|---|---|---|
| Elite Power | -2 tier (HR fade) | **+2 tier (HR target)** | **+1 tier** | unchanged |
| Line-Drive | -1 tier | +1 tier | +1 tier | unchanged |
| GB Contact | **-2 tier (DOUBLE FADE)** | unchanged | unchanged | unchanged |
| All-or-Nothing | -1 tier | **+2 tier (HR target)** | +1 tier | unchanged |
| Balanced | -1 tier | +1 tier | unchanged | unchanged |

**Tier shifts adjust the existing `tier` field** (elite/strong/solid) on each hitter's prop recommendations. A LINE-DRIVE hitter facing a BARREL SUSCEPTIBLE pitcher gets bumped from "solid" to "strong" on hits/HRR props.

The double-fade for GB Contact vs GB Artist is critical for fading PrizePicks demon traps — when a high-line hitter looks like a hits target but the pitcher locks them into rollovers.

## Lineup-level aggregation (run total impact)

Aggregate the hitter archetypes across the lineup:

- **lineup_FB_pct** = average FB% across batting order
- **lineup_GB_pct** = average GB% across batting order  
- **lineup_barrel_avg** = weighted barrel% (top-6 heavier weight)
- **lineup_archetype_distribution** = count of each archetype in lineup

**New signals for `buildGameProjection`:**

1. **FB-heavy lineup × hitter park:** `lineup_FB_pct ≥ 0.42 AND park HR factor ≥ +5%` → +5% run multiplier (HRs become real, not just "expected")

2. **GB-heavy lineup × GB-artist pitcher:** `lineup_GB_pct ≥ 0.48 AND pitcher_GB_induced ≥ 0.50` → -7% run multiplier (rallies die in DPs)

3. **Barrel-rich lineup × Barrel-susceptible pitcher:** `lineup_barrel_avg ≥ 9% AND pitcher_barrel_allowed ≥ 9%` → +6% run multiplier (damage quality conjunction)

4. **All-or-Nothing lineup × elite SP:** `2+ all-or-nothing hitters AND pitcher xwOBA-against ≤ 0.290` → -4% (boom-or-bust hitters bust against good arms)

These are NEW signals on top of the pitcher's duel and slugfest fixes. They don't replace those — they refine within them.

## In-app explanations (the user-facing communication)

This is critical: the differentiation only matters if YOU can see and act on it. The damage quality reasoning needs to surface clearly in three places.

### 1. Hitter prop recommendations (per-hitter cards)

Add a new line under the existing prop reasoning:

**Format:** `Damage profile · {ARCHETYPE_BADGE} · vs {PITCHER_ARCHETYPE_BADGE}`

Examples:
- `Damage profile · LINE-DRIVE · vs BARREL SUSCEPTIBLE — hits/HRR boost (+1 tier)`
- `Damage profile · ELITE POWER · vs FB PRONE — HR target (+2 tier)`
- `Damage profile · GB CONTACT · vs GB ARTIST — DOUBLE FADE (-2 tier)`
- `Damage profile · BALANCED · vs STANDARD — no archetype edge`

### 2. Game projection reasoning (projection panel)

When a lineup-level damage signal fires, surface it:

Examples:
- `Lineup damage profile — FB-heavy (44% lineup FB%) in hitter park → +5% runs`
- `Lineup damage profile — GB-heavy (51%) vs GB artist (52% induced) → -7% runs (rallies die in DP)`
- `Damage conjunction — barrel-rich lineup (9.4%) vs barrel-susceptible pitcher (10.1% allowed) → +6%`

### 3. Top Pick / hitter card badges

Add a small archetype badge next to existing tier labels:

Visual:
- `LINE-DRIVE` — green
- `ELITE POWER` — blue
- `GB CONTACT` — orange
- `ALL-OR-NOTHING` — red (caution)
- `BALANCED` — gray (neutral)

Pitcher archetype shown on pitcher analysis card:
- `GB ARTIST` — green
- `FB PRONE` — orange
- `BARREL SUSCEPTIBLE` — red
- `STANDARD` — gray

### 4. Demon trap detection (the unique value)

The killer feature: **mark high-public-line hitters who are damage-quality fades.**

When a hitter is on PP/UD with a high implied probability (over line at 75%+) BUT their damage matchup is -1 or -2 tier, surface a `DAMAGE FADE` warning:

`⚠ DEMON TRAP — Hits 0.5 line at 88% implied, but GB CONTACT vs GB ARTIST (-2 tier). Consider fade.`

This is the kind of signal nobody else has packaged. PrizePicks/Underdog users see "88% over!" and bet over. Your tool says "wait — the damage profile says rollover."

## Implementation phases

This is too big for one session. Plan it as 3 phases.

### Phase 1: Data layer (~1 session)
- Add GB%, FB%, LD%, popup%, sweet-spot%, pull%, oppo% to Savant URL selections
- Verify columns return data (Savant occasionally renames; need fallbacks)
- Add same fields to pitcher arsenal CSV pulls
- Compute weighted lineup aggregates
- Validate: every hitter card should have batted-ball % showing in audit data

### Phase 2: Archetype classification (~1 session)
- Create `api/_lib/damageArchetype.js` module
- Functions: `classifyHitter(stats) → archetype`, `classifyPitcher(stats) → archetype`
- Tier-shift matrix application
- Unit-test against known examples (Judge → ELITE POWER, Arraez → LINE-DRIVE, etc.)

### Phase 3: Integration + UI (~1-2 sessions)
- Apply tier shifts to per-hitter prop recommendations
- Add lineup-level run multipliers to `buildGameProjection`
- Add archetype badges to hitter cards (CSS + render)
- Add damage profile lines to projection reasoning
- Add demon trap detection on PP/UD lines

Total: 3-4 short sessions. NOT one heroic build. Each phase is independently testable and shippable.

## Acceptance criteria

After full deployment:

1. Every analyzed hitter has an archetype badge visible
2. Every analyzed pitcher has an archetype badge visible
3. Tier shifts visible in prop reasoning (e.g. "BARREL SUSCEPTIBLE matchup +1 tier")
4. Lineup damage signals visible in projection reasoning when they fire
5. At least one demon-trap warning per slate (if any matchups qualify)
6. Validate against tonight's slate: do GB-heavy lineups vs GB-artist pitchers actually under-perform their xwOBA-implied totals? If yes, model is calibrated correctly.

## Risks and unknowns

**Savant column availability:** GB%/FB%/LD% are returned by some custom-leaderboard configurations and not others. Need to verify the URL selections produce non-empty cells. Fallback: derive from raw exit-velocity + launch-angle data on per-hitter basis (slower, more reliable).

**Sample size:** Early-season hitters may not have enough batted balls for stable archetype classification. Use a regression-toward-league-average prior similar to what HR projection uses (regress toward 36% FB / 44% GB / 20% LD until ~100 BBE).

**Archetype drift:** Hitters change profile mid-season. Use rolling 30-day window when sample permits. Flag as "EVOLVING PROFILE" if recent 30d differs significantly from season.

**Pitcher induction stats:** Pitchers' induced GB%/FB% requires aggregating across all batters faced. Need to verify Savant returns these directly or if computation is required.

## What NOT to do (lessons from env refactor)

The env refactor failed because it was built on the assumption that the model "under-projects by +2.9 runs" — without verifying the calibration display. We almost shipped a system tuned in the wrong direction.

For damage quality:

1. **Phase 1 (data layer) is foundation.** Don't build Phase 2 logic until Phase 1 data is verified flowing correctly. Use diagnostic UI panels, not "I think it's working."

2. **Calibrate against tonight's slate before going live.** Build the classifier in shadow mode first — compute archetype for every hitter, log it, but don't apply tier shifts yet. After 1-2 slates, compare predicted edges to actual outcomes. THEN flip the flag.

3. **Feature flag everything.** `DAMAGE_QUALITY_ENABLED`, `LINEUP_DAMAGE_RUNMULT_ENABLED`, `DEMON_TRAP_DETECTION_ENABLED` — three separate flags so we can isolate which piece is helping or hurting.

4. **Surface honestly.** If 80% of hitters classify as BALANCED, the system isn't useful — say so out loud rather than pretending it's working. Calibration data over rationalization.

## ROI prioritization within this work

If sessions are constrained, here's the order of value:

**Highest ROI (build first):**
- Phase 1 data layer — without this nothing else works
- Hitter archetype classification — even alone, gives prop tier shifts
- Demon trap detection — the unique-value feature

**Medium ROI:**
- Lineup aggregation + run multipliers — refines totals
- Pitcher archetype + matchup matrix — sharpens prop recommendations

**Lower ROI (defer if needed):**
- Spray angle (pull/oppo) — small marginal edge
- Evolving profile detection — nice-to-have, not foundational

## Next session plan

When you come back with damage quality time:

1. Open this doc, confirm the design still feels right
2. Build Phase 1 (data layer) — ~25-30 minutes, focused work
3. Verify column availability on a real Savant pull
4. Ship it as standalone — no logic changes yet, just data flowing through

Validation: in the audit panel of any hitter analysis, you should see GB%, FB%, LD% values populated. If you see them, Phase 1 is done. If not, we debug the Savant URL before building Phase 2.

Phase 2 and Phase 3 in subsequent sessions, each independently shippable.
