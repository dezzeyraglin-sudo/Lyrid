# Hitter Tier Regression & Calibration Design
*May 9, 2026 — design phase, build deferred to next session*

## The empirical problem

928 graded picks reveal a calibration inversion:

| Category | Record | Hit Rate |
|---|---|---|
| All-time | 463-465 | 49.9% |
| Top picks | 154-177 | **46.5%** |
| Elite tier | 391-397 | 49.6% |
| Strong tier | 72-68 | **51.4%** |

Two problems jump out:

1. **Tier inversion** — Strong tier (51.4%) outperforms Elite tier (49.6%). This shouldn't happen if classification is correctly identifying the highest-quality picks.

2. **Top picks underperform their parent tier** — 46.5% vs 49.6% Elite. The "top pick" selection logic is choosing the WORST of the Elite tier on average, not the best.

This isn't variance. The pattern is too consistent across 928 graded outcomes.

## Root cause hypothesis

Same root cause as the pitcher's duel fix, applied to a different layer. The pitcher's duel fix addressed `lineupMult` (run total) by regressing `avgMaxXwoba` toward `avgWeightedXwoba` 50/50. We never propagated the same fix to per-hitter prop tier classification or top pick selection.

`adjustedMaxXwoba` represents the BEST-CASE outcome — what the hitter does against the pitcher's best matchup pitch. It's a theoretical ceiling, not an expected value. When the model uses this for tier classification, it's saying "this hitter COULD do well if they get the right pitch."

Reality: pitchers — especially the ones with sub-.290 xwOBA-against — control which pitches hitters see. A hitter with a .500 xwOBA on sliders facing a pitcher who throws 60% fastballs and 40% sliders has an EXPECTED xwOBA around .350, not .500. The model has been classifying these hitters as Elite tier based on the .500 ceiling, but they perform like Solid tier in practice.

The Strong-over-Elite inversion makes sense in this light: Strong tier hitters often have lower max-xwOBA but more consistent edges across the arsenal (lower variance). They produce closer to expected output. Elite tier hitters more often have ONE huge edge (drives the max) but get controlled by the pitcher in actual matchups.

## What just shipped (May 9, flag-gated OFF)

`HITTER_TIER_REGRESSION_ENABLED` env flag added. When ON:
- Per-hitter tier classification uses `regressedMaxXwoba = (adjustedMaxXwoba + adjustedEdge) / 2`
- Top pick qualification check uses the same regressed value for strong-tier promotion gate

When OFF (current default), nothing changes in production. Code is in place but inert.

Both regressed and raw values are surfaced in the diagnostic output (`regressedMaxXwoba`, `tierEvalXwoba`) so we can compare classifier behavior across slates without flipping the flag.

## The calibration problem

If we just flip the flag on with current thresholds (Elite ≥ 0.420, Strong ≥ 0.370, Solid ≥ 0.330), the regressed values will be lower across the board because they pull theoretical max toward expected. The result:
- Elite tier population shrinks dramatically (maybe 40-60% smaller)
- Strong tier expands  
- Solid tier expands

That changes the picker's distribution but doesn't necessarily improve hit rate. We could:
- Have FEWER top picks per slate (some slates with no qualifying Elite hitter)
- Top picks come more from regressed-Strong tier where current data shows they hit better

The question is: **at what regressed-xwOBA threshold does hit rate actually peak?**

## Calibration plan (next session)

This needs the 928 graded picks to drive it. Here's the plan:

### Step 1: Audit the existing graded data

Pull the existing graded picks and compute, per pick:
- `adjustedMaxXwoba` (current tier criterion)
- `adjustedEdgeScore` (would-be regression target)
- `regressedMaxXwoba` (50/50 blend)
- Outcome: hit/miss
- Tier assigned

Then build a hit-rate curve across `regressedMaxXwoba` ranges:
- 0.300-0.320: hit rate?
- 0.320-0.340: hit rate?
- 0.340-0.360: hit rate?
- ... etc through 0.450+

The thresholds where hit rate jumps meaningfully become the new tier boundaries.

### Step 2: Fit new tier thresholds

Likely thresholds based on intuition (calibrate against actual data next session):
- Elite: regressed ≥ 0.380 (current 0.420 is too aggressive after regression)
- Strong: regressed ≥ 0.350
- Solid: regressed ≥ 0.320

These should be CHOSEN such that:
- Elite tier has highest hit rate (currently it's NOT — that's the inversion)
- Each tier has materially different hit rates (not all 49-51%)
- Sample sizes are reasonable (Elite shouldn't be 5% of picks)

### Step 3: Re-tune top pick selection

Currently top picks score by:
```
topScore = adjustedEdgeScore × tierWeight × bullpenBonus × platoonBonus
```

Tier weights (Elite 1.30, Strong 1.15, Solid 1.0) should be re-derived from the new hit rates. Probably:
- Elite multiplier: ~1.25
- Strong multiplier: ~1.10
- Solid multiplier: 1.0

Also: the FULL GAME bonus (1.18×) might be too high. If bullpen-mismatch hitters underperform alongside the pitcher mismatch (because both signals overlap), the multiplier could be reduced to 1.10.

### Step 4: Validate via shadow mode

Before flipping the flag live, run "shadow mode" for 3-5 slates: compute both classifications (raw AND regressed) but only ACT on the raw classification. Track:
- For each top pick, did the raw classification hit?
- Did the would-be regressed classification have hit it as a top pick?
- Where do they diverge?

If shadow regressed-mode top picks hit at 55%+ vs raw at 46%, that's the green light to flip live.

### Step 5: Flip the flag, monitor

Set `HITTER_TIER_REGRESSION_ENABLED=true` in Vercel env vars. Track hit rate over the next 30+ picks. If it doesn't show improvement over the calibration projection, dig deeper before declaring victory.

## Why the FULL GAME bonus might be the real bug

A different hypothesis worth checking: the 1.18× multiplier for hitters with both SP-mismatch AND BP-mismatch may be over-rewarding correlated signals. If a pitcher throws a hittable slider (SP edge) AND the bullpen also has hittable sliders (BP edge), those are NOT independent signals — they're the same tendency surfacing twice.

The picker treats them as independent and stacks the bonus. Result: top picks lean toward "both edges fire" hitters, but the actual outcome correlation is much weaker than the bonus suggests.

Test in step 1: compare hit rate of (BOTH SP+BP edge) vs (only SP edge) vs (only BP edge). If the FULL GAME group performs at the same rate as single-edge groups, the 1.18× is double-counting.

## Connection to other shipped fixes

The pitcher's duel and slugfest fixes addressed RUN TOTAL projection. They're working correctly (validated with first total bet hitting tonight). 

This hitter tier issue is a SEPARATE problem at the per-hitter prop layer. The fixes don't conflict — they address different signals at different levels:
- Pitcher's duel: lineup-aggregate xwOBA → run total
- Slugfest: lineup-aggregate xwOBA + park + HR threats → run total
- Hitter tier (this fix): per-hitter xwOBA → prop tier classification

All three follow the same architectural pattern: regress theoretical max toward expected output, then apply business rules on the regressed value.

## Acceptance criteria

After Step 5 (flag flipped live), we should see:

1. **Top picks hitting at >50%** (target: 55-60%)
2. **Elite tier hit rate > Strong tier hit rate** (inversion fixed)
3. **Tier hit-rate spread of at least 4-5%** (Elite ~58%, Strong ~52%, Solid ~48%)
4. **Top picks per slate may decrease** — that's expected. Quality over quantity.

## Risks

**Risk 1: Re-tuning to past data overfits.** The 928 picks reflect the current model's biases. If we tune thresholds to maximize hit rate on those 928, the new thresholds might not generalize. Mitigation: cross-validate by holding out 20% of picks (recent ones) when tuning.

**Risk 2: Smaller Elite tier means fewer top picks.** Some slates may have no Elite hitter at all. That's actually fine — low-confidence days should produce no top pick rather than a forced pick.

**Risk 3: Regression magnitude (50/50) might be wrong.** Could be 60/40 max-favored, or 40/60 expected-favored. Step 1 audit should reveal which blend best predicts outcomes.

**Risk 4: Tier inversion has another cause we're missing.** Could be the description/badge logic, not the underlying classification. If after flipping the flag tier inversion persists, the bug is elsewhere. Step 4 shadow mode catches this before going live.

## Out of scope

- Changing the prop recommendation logic itself (Hits 0.5 vs HRR 1.5 vs RBI 0.5 thresholds). That's a separate calibration question.
- Adding new signals (recent form, platoon weighting). One change at a time.
- Demon trap detection (high-line fade). Phase 3 of damage quality system, separate doc.

## Next session entry point

1. Verify the `regressedMaxXwoba` field is populating in deployed analysis output (use API response or DevTools)
2. Pull 928 graded picks from the database (Supabase, projectionAudit table)
3. For each pick, compute the regressed value if not stored (we should be storing it now)
4. Build the hit-rate curve, find tier boundaries
5. Implement new thresholds
6. Run shadow mode validation
7. Flip flag

Estimated total time: 1-2 careful sessions. The calibration math is straightforward once data is pulled.

## What NOT to do (lessons baked in)

1. **Don't flip the flag without calibration.** Untuned regression with old thresholds could shift the tier population in unpredictable ways and make things worse before getting better.

2. **Don't drop "top picks doing terrible" → ship "unders mode."** That was a reactive response. The 928-pick record reveals the actual structural issue. Building "unders mode" would have flipped losses, not reduced them.

3. **Don't tune tiers to maximize sample sizes.** Tier sample size is a side effect, not a goal. If Elite tier ends up with 20% of picks at 60% hit rate, that's better than 50% of picks at 50% hit rate.

4. **Don't trust gut feel ("Trout/Neto underperforming").** Track 5-10+ observations before reacting to per-player perceived patterns. Variance fools observation.

## Honest scope assessment

This is the most important calibration work the tool needs right now. It addresses the structural reason top picks aren't profitable — not by changing the picker, but by giving the picker a more accurate input signal.

Other fixes (pitcher novelty, damage quality Phase 2, etc) all build ON TOP OF tier classification. If tier is wrong, those fixes refine bad signal. Get the tier calibration right first.

ETA: 1-2 sessions to ship calibrated, validated, live. Worth the time.
