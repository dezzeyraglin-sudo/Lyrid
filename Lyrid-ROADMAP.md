# Lyrid — Roadmap & Current State

*Living document. Last updated: May 8, 2026, after sample-size regression ship.*

---

## Where Lyrid is right now

Lyrid is a daily MLB betting analytics tool, currently deployed at `mismatch-finder.vercel.app` (renamed repo: `dezzeyraglin-sudo/Lyrid`). The model produces tiered hitter prop recommendations, game-line bets, YRFI/NRFI plays, and pitcher prop projections.

**Current honest assessment of model performance** (from rollup data through ~894 graded bets):

- Overall: 50.2% across all bet types
- Hitter Best Bets: 49.7% (ELITE 49.4%, STRONG 51.4%, Top Picks 44.9%)
- Game-Line Bets: 60.0% (small sample, +4.38u)
- YRFI/NRFI: 61.5% (+9.03u, sharper of the two)
- Calibration: model over-projects totals by 2.9 runs on average (MAE 4.97)

The hitter-tier model is essentially coin-flip at the tier level. The totals projector has a known directional bias. The first-inning model is genuinely sharp.

**Not ready for monetization.** The user has stated this clearly. Validation against real outcomes needs to come before pricing tiers go live.

---

## What's shipped (current state of Lyrid)

### Core analysis pipeline
- `/api/analyze.js` — main slate analysis endpoint
- Hitter prop recommendations with ELITE/STRONG/SOLID tiering
- Pitcher prop recommendations (Strikeouts, Outs, ER, BB, Hits Allowed, Win)
- Game-line analysis (ML, Spread, Total)
- YRFI/NRFI projection
- Park factors (Run, HR, LHB-HR, RHB-HR)
- Weather impact (temp, wind direction/speed, humidity, marine layer)
- Bullpen-tier classification (elite/strong/solid/exploitable)
- Lineup vulnerability scoring (per-handedness arsenal weakness)
- Conversion-rate signals (RISP, batter-RISP)

### HR projection module (`hrEmpirical.js`)
- Empirical multiplier model with 9 features: barrel, hard-hit, pitch matchup, pitcher HR/9, park, weather, platoon, K penalty, bullpen
- Sample-size regression for Barrel% (120-PA prior, blends observed with league average)
- Tier gating (ELITE / STRONG / SOLID / SUSPECT)
- Diagnostic `_debug` trace surfacing every input + multiplier
- Audit panel with per-row inline diagnostic line in deep mode

### Data layer
- Baseball Savant: arsenal, expected stats, custom CSV, statcast CSV (4 parallel fetches with 10-min cache)
- MLB Stats API: schedule, lineups, splits, box scores, probables
- Odds API: live game lines + pitcher prop lines with grading
- Park factor lookups
- Weather API integration

### Tracking + history
- Logged bet store: `bestBetHistory`, `gameLineBets`, `firstInningBets`, `pitcherPropBets`
- Auto-grade orchestrator (runs once per session, throttled)
- History tab with subnav: Best Bets, Game Bets, YRFI/NRFI, Pitcher Bets, Calibration, Rollup, My Bets
- Rollup dashboard: cross-type accuracy, by-tier breakdown, by-prop-type breakdown, by-model-tier (pitcher props)
- CSV bulk import for hitter prop bets (paste-or-upload, fuzzy matching, vocabulary mapping, duplicate detection, auto-grade on import)

### UI / Lyrid brand
- Sharp Light theme, Deep observatory blue primary, museum gold for prominence
- Custom Lyrid CSS overrides (~96KB, 512 brace-balanced)
- Pitcher props panel with form trend, HR splits, sharp K projection, batter K breakdown, prop rows with auto-pulled DK lines, manual line entry, inline LOG forms
- HR audit panel with diagnostic debug line
- Bonus markets section (Quality Start, No-Hitter)
- Settings tab with personal override, CSV import, secret filter
- Empty states with character

### Auth / monetization (dormant)
- Supabase configured, schema deployed
- Stripe web + RevenueCat mobile IAP (deferred)
- `MONETIZATION_LAUNCHED=false` flag

---

## Known issues / pending validation

### Just shipped, needs real-slate validation
- **HR data feed fix** (May 8) — Barrel% now flows from `/leaderboard/statcast` endpoint instead of broken `/leaderboard/custom`. Confirmed working on one Nathaniel Lowe screenshot. Needs full slate validation.
- **Sample-size regression for Barrel%** (May 8) — 120-PA prior pulls small-sample observed values toward league average. Bleday's 23.1% / 39 PA → regressed to 11.33%. Needs validation that ELITE-tier projections fall in 5-12% range across the slate, not 20%+.

### Long-running calibration concerns
- **Hitter Best Bets tier classifier doesn't separate signal from noise** (49.4% Elite, 51.4% Strong). When hitter Barrel% data was broken for weeks, this metric was contaminated. After validation period with real Barrel% flowing, re-evaluate whether Elite vs Strong actually carries signal.
- **Top Picks underperform overall best bets** (44.9% vs 49.7%). Same root cause likely. Re-evaluate after data feed fix bakes.
- **Total projection bias** (+2.9 runs UNDER). Documented but unaddressed. The reason game-line OVERs hit at 64.3% — model's directional error, not its accuracy.
- **HRR (H+R+RBI) at 48.7% across 727 graded bets**. In DFS pricing context this is roughly breakeven, not catastrophically broken. But "Elite" should mean better than breakeven.

### Architectural debt
- **Pitcher HR/9 still null early-season** by design (requires 30+ PA per handedness). Will populate naturally as season progresses. Not a bug.
- **`/leaderboard/custom` Savant endpoint may stay broken indefinitely**. We have a fallback but if both endpoints break we have no Barrel% source.
- **CSV import only supports hitter prop bets**. Game-line and YRFI imports planned but not built.

### Operational / deploy
- **GitHub Desktop migration complete**. Web uploader was hitting hidden-file errors and 100-file commit limits. Local clone + Replace All + commit + push is the standard flow now.

---

## Roadmap — eight systems from the May 2 design doc

These are the systems the user proposed in the document during the conversation about model improvements. Listed in recommended priority order based on dependency analysis, not in the order they appeared in the original doc.

### 1. Environment modifier refactor (foundational)
**Estimated sessions: 2**

Make park, weather, and HR-suppression environment factors mathematical projection modifiers, not just visual notes. Run projections currently include some environmental signal but the magnitude doesn't match real-world impact.

**Why first:** Directly addresses the +2.9 runs UNDER bias the calibration shows. Several downstream systems (RCI, False Over Detector, archetype classifier) all depend on environment math being right. Fix the foundation, and the systems built on it become meaningful.

**Inputs:** park run/HR factors, wind direction/speed, temperature, humidity, marine layer, roof status, altitude, dome.

**Output:** Adjusted projected runs (currently raw projection × small environment factor → should be raw projection × meaningful environment multiplier).

**Acceptance criterion:** After deploy, MAE on totals drops from 4.97 toward 4.0. Bias drops from -2.9 toward ±1. (Environment modifiers must REDUCE projections in pitcher-friendly contexts — model currently over-projects.)

---

### 2. Run Conversion Index (RCI)
**Estimated sessions: 2-3**

Detect when offensive traffic will fail to convert into runs. Lower projected runs in pitcher-friendly parks, wind-in environments, low-barrel lineups, sequencing-dependent offenses. Higher projected runs in explosive HR environments.

**Why second:** Builds on environment math. Once environment modifiers feed projections correctly, RCI is the next layer of refinement — accounting for which lineups can actually convert their traffic.

**Inputs:** team ISO, barrel%, hard-hit%, HR/FB%, RISP conversion, bullpen strand%, GB%, FB%, lineup slug clustering, XBH concentration.

**Output:** 0-100 score that adjusts projected run totals. 70+ explosive, 50-69 neutral, 40-49 false-over danger, <40 strong suppression.

**Acceptance criterion:** Game-line OVER recommendation hit rate stays ≥60% but with reduced false-over rate (over-projection on suppressed environments).

---

### 3. False Over Detector
**Estimated sessions: 1-2**

Identify games where projected total looks high but conditions suppress conversion. Triggers FALSE_OVER classification. Downgrades over confidence and recommendation strength.

**Why third:** Effectively a higher-level surface on top of RCI. Uses RCI score plus environment modifiers to flag specific games as traps. Builds on items 1 and 2.

**Inputs:** projected total, RCI score, park factors, HR suppression, wind direction, bullpen quality, lineup barrel%, slugging concentration, RISP efficiency, GB environment.

**Output:** FALSE_OVER_RISK score (LOW / MODERATE / HIGH / EXTREME). High and Extreme reduce over recommendation.

**Acceptance criterion:** Of bets currently flagged as Game-Line OVERs, those that get FALSE_OVER classification show clearly worse hit rate than ones that don't.

---

### 4. Damage-quality offensive refactor
**Estimated sessions: 2**

Reweight offensive projections to prioritize damage quality (barrels, hard-hit, launch angle, pull-side lift, ISO, HR/FB) over contact quality (singles, OBP, contact rate, walks). Especially in hitter parks, warm weather, wind-out environments.

**Why fourth:** Independent track from items 1-3 (game totals). Affects per-batter HR projection and prop recommendations. Could be done in parallel with totals work if multiple sessions available.

**Inputs:** existing Statcast metrics + new weights based on environment.

**Output:** Modified hitter scoring that better detects "fake offense" environments where contact exists but damage quality is weak.

**Acceptance criterion:** Hitter Best Bets ELITE tier separates from STRONG tier (currently 49.4% vs 51.4% — should diverge with proper damage weighting).

---

### 5. Sequencing Failure Probability module
**Estimated sessions: 1-2**

Detect when teams generate baserunners but fail to cluster events into runs. Models stranded runners, poor hit clustering, double-play risk, low slug sequencing, HR dependency.

**Why fifth:** Specialized refinement on top of RCI. Different from RCI in that RCI scores the overall environment; sequencing failure scores the specific lineup's run-conversion shape. Useful but more incremental than the foundation work above.

**Inputs:** team OBP, ISO, slugging concentration, lineup clustering, GDP%, K timing, bullpen strand%, RISP efficiency, HR dependency%.

**Output:** SEQUENCING_FAILURE score (0-100). High score suppresses projected runs and downgrades overs.

---

### 6. Bullpen Stabilization Model
**Estimated sessions: 1-2**

Stop assuming bullpen exposure = bullish for overs. Some bullpens stabilize games. Suppress over projections accordingly.

**Why sixth:** Refinement of the bullpen-tier classification we already have. The current model has bullpen tiers (elite/strong/solid/exploitable) but they only adjust HR multipliers, not run totals.

**Inputs:** bullpen ERA, leverage ERA, inherited-runner strand%, bullpen HR/9, bullpen GB%, bullpen walk%, fatigue, recent workload, handedness matchup, late-inning run prevention.

**Output:** BULLPEN_STABILITY score (0-100). High stability reduces projected late-game scoring.

---

### 7. Game archetype classifier
**Estimated sessions: 2**

Classify games by scoring environment: TRUE_OVER, FALSE_OVER, CHAOS_OVER, STABLE_UNDER, DECEPTIVE_UNDER. Replaces or augments raw run-projection-based recommendations.

**Why seventh:** Highest-level synthesis. Requires items 1-6 to be in place (their outputs become the inputs to archetype classification).

**Inputs:** outputs of all preceding systems.

**Output:** archetype label + confidence%. Replaces or augments current "STRONG OVER 8.5" style recommendations.

**Acceptance criterion:** Archetype classifications correlate with actual outcome distributions.

---

### 8. Advanced HR engine + fantasy under model
**Estimated sessions: 3 combined**

The user's design doc combined an "advanced HR prediction engine focused on damage quality" with a "PrizePicks/Underdog under model focused on pathway suppression." These are conceptually similar — both shift from contact-quality to damage-quality scoring, just from opposite directions (HR upside vs scoring-path suppression).

**Why last:** Most ambitious of the eight systems. Requires real validation data to tune weights. Likely the right project for after we've validated items 1-4 against ~3 weeks of real outcomes.

**Outputs:**
- TRUE_HR_CONTACT_SCORE
- DAMAGE_TRIGGER_SCORE
- PATHWAY_SUPPRESSION_SCORE for unders
- Fantasy-pathway risk classification

**Acceptance criterion:** HR-tier prop recommendations show clear win-rate separation by tier (currently the "ELITE HR" tier on hitters is undertested due to data feed bug). Pathway-suppression unders show profitable hit rate at PrizePicks/Underdog pricing.

---

## Recommended sequencing

Given current state (HR fixes shipped today, validation period needed):

**Phase 1 — validate current build (1-2 weeks of live use):**
- No new feature work
- Run real slates, log bets, let calibration data accumulate with real Barrel% flowing
- Look at audit panel for unexpected projections, send screenshots of anomalies
- Goal: confirm HR data feed + sample-size regression actually produce reasonable projections across the slate

**Phase 2 — environment refactor (Sessions 1-2):**
- Item 1 above
- Foundation for everything that follows
- Ship in two sessions: math layer first, then UI surfacing of environment impacts

**Phase 3 — RCI + False Over (Sessions 3-5):**
- Items 2 and 3 together
- Built on environment math from Phase 2

**Phase 4 — re-evaluate and pick next:**
- Look at performance data
- Pick from items 4-8 based on what's actually breaking
- Don't pre-commit beyond Phase 3 — sequencing depends on what we learn

**Out of phase but parallel-track candidates:**
- CSV import for game-line + YRFI bets (1 session, low-risk)
- Pitcher prop bet logging UX polish (small refinements)
- Marketing surfaces, mobile parity, monetization launch (after model is validated, not before)

---

## Out of scope for now

These are real things to do eventually but explicitly not in the immediate roadmap:

- **Mobile React Native app** — wait until web model is validated and stable
- **Landing/pricing pages** — wait until model performs well enough to charge for
- **Stripe checkout / RevenueCat IAP** — Phase 2+ of monetization
- **OCR / screenshot bet imports** — nice-to-have, not foundational
- **NPB / international leagues** — possible future expansion, not current focus
- **Live in-game model adjustments** — different product

---

## Working agreements

These are discipline commitments made over the recent sessions and they've been working:

1. **Closure-scope discipline before code edits.** Read the surrounding code, list every variable referenced in proposed changes, confirm all in scope before writing.
2. **Plan-it-as-multiple-sessions.** When scope feels tight, split into sessions properly rather than rushing. Each session has a clear, testable end state.
3. **Diagnose before fixing.** Add instrumentation when a bug is real but cause is unclear. Don't guess at fixes — see the data first. The HR bug arc proved this discipline pays off.
4. **API budget awareness.** Count parallel fetches, confirm timeouts, confirm cumulative <10s Vercel budget before adding new external calls.
5. **Honest scope reflection.** When the user wants three things and they don't fit, say so. Better to ship one thing well than three things half-broken.
6. **Validation before scaling.** Don't launch new features on top of unvalidated foundations. Each layer needs to bake before the next layer goes on.
7. **Don't pretend.** When something isn't working, say so. When the data shows a feature is unconvincing, surface it. The user is here to build something real, not to be told it's already great.

---

## Index of related documents

- `DEPLOY.md` — deployment instructions (GitHub Desktop flow)
- `MONETIZATION_SETUP.md` — payment infrastructure setup notes
- `README.md` — basic project overview
- `journal.txt` (in transcripts) — catalog of session summaries

This roadmap document is the living source of truth for "what's next." Update after each major ship or scope change.
