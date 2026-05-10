# Pitcher Novelty + First-Inning Recalibration Design
*May 9, 2026 — design phase, build deferred to next session*

## The failure that motivated this

Tonight: TOR vs LAA, Trey Yesavage starting. Tool projected over on YRFI. Game went under — Yesavage struck nearly everyone out on splitters off the plate. Announcer noted it was the lineup's first time facing him.

The model treated Yesavage like any other pitcher with similar season xwOBA-against. It didn't account for the fact that the opposing lineup had no MLB exposure to his arsenal, no timing on his release, no recognition of his out pitch (the splitter, which fewer than 10% of MLB pitchers throw with significant usage).

This is a real, repeating failure mode. Every time a rookie debuts, gets called up, returns from injury after long absence, or gets traded mid-season into a new league, the same pattern fires: the model projects based on stats but the lineup gets dominated because they've literally never seen the pitcher live.

## Why this matters for ROI

YRFI/NRFI is one of the cleanest betting markets — binary outcome, smaller variance than full-game totals, sharp lines. Getting it right consistently compounds. A YRFI projection that systematically overshoots on novel pitchers is a fixable leak.

The same novelty signal also helps with:
- **Pitcher K props (Underdog).** Novel pitchers strike out more hitters in their first MLB look than season stats suggest.
- **First 5 innings totals (PrizePicks F5).** Novelty effect is strongest first time through the order, fades by the 4th-5th inning.
- **Hitter HRR / TB / Hits props.** Going against a novel pitcher, lineup-wide props underperform their usual lines.

## The novelty signals we can detect

Three tiers of novelty, in order of how detectable they are with current data:

### Tier 1: HIGH NOVELTY (strong NRFI/under bias)
- **MLB debut** — first career start, lineup has zero MLB tape on him
- **Recent call-up** — fewer than 3 MLB starts career
- **First time through league** — pitcher just traded to opposite league (NL→AL or vice versa) and facing former-league teams for first time

### Tier 2: MODERATE NOVELTY
- **Limited career sample** — under ~150 career PAs faced, or under 50 IP
- **Long absence return** — first start back from IL after 60+ day absence (hitters' tape is stale)
- **Rare arsenal** — pitcher's primary out pitch is league-rare (splitter, screwball, knuckleball, sidearm sweeper)

### Tier 3: LOW-LEVEL NOVELTY (small effect, applies broadly)
- **First time facing this lineup** in calendar year — even known pitchers have an edge first matchup
- **Interleague matchup** with limited shared scouting

## Current data layer audit

Already available:
- Season xwOBA-against (Savant)
- Season pitch arsenal usage (Savant)
- Inning-split xwOBA (1-3, 4-6, 7+)
- Season K%, BB%

Not currently fetched but doable via existing patterns:
- Career stats from MLB Stats API — `batterRisp.js` already uses `statsapi.mlb.com/api/v1/people/{id}/stats?stats=careerRegularSeason` pattern. We can pull pitcher career PAs/IP the same way.
- Recent call-up status — derivable from comparing season debut date to current date
- Last-start date — pitcher recent starts already pulled (verify in `pitcherRecentStarts`)

Not in current data, would need new feeds:
- Lineup-vs-pitcher historical PA counts — would need MLB Stats API matchup endpoint or BRef. Doable but more work.
- Pitch arsenal rarity scores — compute league-wide pitch usage distribution once per season, cache. Cheap.

## Two implementation paths

### PATH A: Quick heuristic ship (~30-45 min, next session)

Single-signal novelty detector. Just check: is the pitcher's career sample small?

**Logic:**
```
career_pas_faced = pull from MLB Stats API
if career_pas_faced < 50:
    novelty_tier = HIGH
    yrfi_mult = 0.65  // strong reduction
    pitcher_k_boost = 1.20  // 20% K rate boost
elif career_pas_faced < 150:
    novelty_tier = MODERATE
    yrfi_mult = 0.85
    pitcher_k_boost = 1.10
else:
    novelty_tier = NONE
    no adjustment
```

**Where it applies:**
1. `firstInning.js` — multiply scoring probability by `yrfi_mult` for the side with the novel pitcher
2. `pitcherKProjection.js` — boost K projection by novelty factor
3. UI surfaces "ROOKIE" or "LIMITED MLB SAMPLE" badge on pitcher analysis card

**Catches Yesavage-class cases.** Misses traded veterans, post-injury returns, rare-arsenal vets. But those are smaller categories.

### PATH B: Full novelty system (2-3 sessions)

Layered detection with all three tiers, plus arsenal rarity, plus matchup history.

**New module:** `api/_lib/pitcherNovelty.js`
- `classifyNovelty(pitcher) → { tier, signals, magnitude }`
- Pulls career stats, debut date, last-start gap
- Combines with arsenal rarity score

**New module:** `api/_lib/arsenalRarity.js`
- One-time-per-season computation of league-wide pitch usage
- Pitchers with primary arsenal at <5% league usage flagged

**Integration changes:**
- `firstInning.js` — multi-tier YRFI adjustment
- `pitcherKProjection.js` — novelty-aware K boost
- `pitcherProps.js` — affect prop tier classifications
- `analyze.js` — surface novelty in projection reasoning

**Caches:**
- Pitcher career stats — 24hr TTL (don't refetch every game)
- Arsenal rarity computation — season-long cache, refresh weekly

### My recommendation: Path A first, Path B if needed

Same discipline as the pitcher's duel/slugfest fixes. Ship the heuristic, validate, see if it catches enough cases to be worth the effort of Path B.

Reasoning: rookies and recent call-ups are the loudest cases. Most of the YRFI losses you'd notice in real-time are these. Veterans returning from injury or recently traded are quieter, fewer per slate, lower aggregate impact.

## Magnitude rationale

Why -35% YRFI for HIGH tier (`yrfi_mult = 0.65`)?

Looking at known historical examples:
- Spencer Strider's MLB debut (2021): faced 6 hitters, 4 Ks, no runs in his inning
- Paul Skenes' debut (2024): 6 K through 4 IP, 0 R
- Yesavage tonight: shut out the first inning entirely

NRFI rate league-wide is ~43% (1 - 0.57 YRFI). For novel pitchers, the empirical rate is closer to 60-65% NRFI. So an adjustment that reduces YRFI by ~30-35% on the side with the novel pitcher matches the observed effect.

Why +20% K boost? Same hitters facing the same novel pitcher strike out at significantly higher rates than their season K%. League average K% is ~22%; novel-pitcher K% is closer to 27-30%. Multiplying season K% by 1.20 approximates this.

Both magnitudes are first-pass estimates. Calibrate against real outcomes after Path A ships.

## Acceptance criteria for Path A

After Path A deploys:

1. Any rookie/recent-callup starter triggers visible "LIMITED MLB SAMPLE" badge on their analysis card
2. YRFI projection for games with novel pitcher comes in noticeably lower than identical-stats veteran
3. K projection for novel pitchers increases by ~20%
4. Narrative line in YRFI reasoning: "Home SP novel to lineup (X career PAs) — projection adjusted"
5. Validate over next 2-3 weeks: track YRFI bets on novel-pitcher games. Should improve hit rate.

## Risks

**Career PA fetch latency.** Adding another MLB Stats API call per game adds ~200-500ms per analysis. Mitigations: fetch in parallel with existing data calls (no serial penalty), cache aggressively (24hr+ TTL).

**False positives on quality call-ups.** Some rookies are legit aces (Skenes, Strider). The novelty effect still applies — they DO get extra outs from being unfamiliar — but tier-classified hitters might still get hits. The fix has to be applied multiplicatively to existing projections, not as a hard gate.

**Hitters HAVE seen them in spring training / minors.** Real concern for top-prospect debuts where the hitter saw the pitcher in AAA. Hard to detect without minor-league matchup data. Accept as known limitation; Path B could address with PCL/IL data feeds.

**Over-correction on borderline cases.** Pitcher with 100 career PAs is a borderline call. Make sure thresholds aren't cliffs — soft transitions are safer than hard yes/no.

## Phase 2 of damage quality interaction

When Phase 2 of the damage quality system ships (archetype classifier), it should INTERACT with novelty:

- **Novel pitcher × ELITE POWER hitter** — power hitters are LESS affected by novelty. They sit on a pitch and hit it. Smaller K boost, smaller YRFI reduction.
- **Novel pitcher × CONTACT/LD hitter** — contact hitters need to recognize spin and sequencing, which is exactly what novelty defeats. LARGER K boost, LARGER projection reduction.
- **Novel pitcher × ALL-OR-NOTHING hitter** — most affected. They already swing-and-miss a lot. Novelty makes it worse.

Don't build this interaction in Path A. Note it for when both systems are live.

## What NOT to do

**Don't ship without verifying career-PA fetch works.** Same lesson as damage quality Phase 1. Build the data layer first, verify it flows, then apply logic on top.

**Don't apply novelty bias to game-level run total.** YRFI is the right scope — first inning is where novelty hits hardest. Full-game totals already factor in the broader pitcher/hitter dynamic, and novelty effect dilutes by inning 5+. Keep the fix narrow.

**Don't forget the K boost.** The Yesavage observation wasn't just "low scoring" — it was "everyone struck out on splitters off the plate." That's a K-rate phenomenon AS MUCH as a run-suppression phenomenon. The fix must hit both YRFI and pitcher K props.

## Build plan when ready

**Session 1 (Path A — ~30-45 min):**
1. Add `getPitcherCareerStats()` to `data.js` — uses same MLB Stats API pattern as `batterRisp.js`
2. Wire into `analyze.js` parallel fetch
3. Add novelty tier classification (HIGH/MODERATE/NONE) inline
4. Apply `yrfi_mult` in `firstInning.js`
5. Apply `pitcher_k_boost` in `pitcherKProjection.js`
6. Surface badge in pitcher analysis UI
7. Surface narrative line in projections

**Validation pass (2-3 days of slates):**
- Track YRFI hits on games with novel pitchers
- Compare novel vs veteran K projection accuracy
- Look for over-correction (any games where novelty bias was wrong)

**Path B trigger:**
If Path A misses meaningful cases (post-injury returns, rare-arsenal vets), build Path B's full novelty module. Otherwise, Path A is sufficient.

## Out of scope

- Fixing all first-inning logic. The current `firstInning.js` is mostly fine — pitcher inning splits, lineup tier, park, weather, ump are reasonable signals. We're adding ONE missing signal (novelty), not rebuilding.
- Spring training / minor-league matchup detection. Too sparse data, too noisy.
- Lineup-vs-this-pitcher historical PAs. Path B territory.

This is a focused, narrow fix to a specific failure mode. ROI is in the targeting — catch rookie/callup YRFI overprojections, leave everything else alone.
