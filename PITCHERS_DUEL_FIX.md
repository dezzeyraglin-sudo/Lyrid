# Pitcher's Duel Failure Analysis & Proposed Fix
*May 9, 2026*

## The pattern

Across 9 recently-analyzed games, the model has a clear failure mode: it **clusters projections at 10+ runs even when both pitchers are genuinely elite**.

| Game | Proj | Actual | Off by | Both SPs elite? |
|---|---|---|---|---|
| PIT @ SF | 10.48 | 7 | +3.5 | mixed |
| ATL @ LAD | 12.22 | 4 | **+8.2** | one elite |
| STL @ SD | 6.14 | 6 | +0.1 | YES (got it right) |
| NYM @ ARI | 11.30 | 4 | **+7.3** | one elite |
| CHC @ TEX | 12.00 | 8 | +4.0 | one elite |
| NYY @ MIL | 12.64 | 6 | **+6.6** | YES |
| SEA @ CWS | 12.87 | 20 | -7.1 | (slugfest, separate issue) |
| DET @ KC | 10.84 | 7 | +3.8 | one elite |
| MIN @ CLE | 11.11 | 10 | +1.1 | one elite |

8 of 9 games projected double-digit totals. The model only hit a low projection (6.14) on STL@SD — a game where both pitchers were elite AND the park (Petco) suppresses runs. Every other game where one or both pitchers were genuinely elite still got projected at 10-13 runs.

## Where the bug lives

The run projection is built from this multiplicative chain in `buildGameProjection`:

```
projRuns = BASELINE(4.45) × lineupMult × pitcherBlend × envRunMult × umpRunMult × convMult
```

Both `lineupMult` and `pitcherBlend` independently see the matchup, but they don't talk to each other. The lineup composition reads "how well can hitters do against this pitcher's arsenal" → `lineupMult`. The pitcher composition reads "how good is this pitcher overall" → `pitcherBlend`. They're combined as a flat product.

That seems fine, but here's the actual problem:

### `lineupMult` uses `avgMaxXwoba` — a systematic over-estimate

`computeLineupTier` builds `avgMaxXwoba` like this:

> For each hitter in the lineup, find the pitch in this pitcher's arsenal that the hitter hits best. Take that best xwOBA. Average across the lineup.

For a typical "EXPLOITABLE" tier lineup, this produces `avgMaxXwoba` of roughly 0.400-0.430 (best-pitch xwOBAs averaged across 6-9 hitters).

Then:
```javascript
const lineupMult = 1.0 + ((avgMaxXw - 0.320) × 2.4);  // .040 above avg → +9.6%
```

So an EXPLOITABLE lineup at .410 produces `lineupMult ≈ 1.22` — a 22% boost.

**The bug:** `avgMaxXwoba` is the BEST-CASE outcome per hitter. But pitchers don't throw their hittable pitch 100% of the time. A hitter who hits the slider at .500 xwOBA and the fastball at .250 xwOBA, against a pitcher throwing 60% fastballs / 40% sliders, has an EXPECTED xwOBA of .350 — not .500.

The "max" is a theoretical upper bound that's only realized when the pitcher cooperates. Elite pitchers don't cooperate. They throw their best pitch in their best counts and avoid throwing hittable pitches when it matters.

The arsenal-mismatch logic is essentially answering "what's the upside if everything goes right for the hitters?" rather than "what's the expected output?"

### `pitcherBlend` doesn't fight back hard enough

For an elite SP at .243 xwOBA-against:
```javascript
pitcherMult = 1.0 + ((0.243 - 0.320) × 2.0) = 0.846
```

Combined with average bullpen at .310:
```javascript
bullpenMult = 1.0 + ((0.310 - 0.320) × 0.8) = 0.992
```

60/40 blend:
```javascript
pitcherBlend = (0.846 × 0.60) + (0.992 × 0.40) = 0.905
```

So a genuinely elite SP only suppresses runs by 9.5%. That's far too weak. An elite SP routinely produces games where lineups score 1-3 runs against him, not "9.5% fewer than average."

The slope of `((xw - 0.320) × 2.0)` was probably tuned conservatively to avoid over-suppression on mediocre pitchers. But the linear mapping doesn't capture the steepness of true elite SP impact.

### The compounding miss

When BOTH SPs are elite, the model needs a CONJUNCTION suppression that's stronger than the additive product. STL@SD got this right (projecting 6.14) probably because both starters were elite AND Petco suppresses, so multiple weak signals stacked. But on NYY@MIL with both .274 and .243 SPs in a neutral park, the model misses it entirely.

## The fix — three targeted changes

The fix is NOT a new module. It's three calibration changes in existing code that work together to suppress run projections when pitching dominates.

### Change 1: Regress `avgMaxXwoba` toward expected

`avgMaxXwoba` is best-case. Blend it toward the `avgWeightedXwoba` (expected output across the actual pitch distribution). This is already computed in the lineup tier function. Use it as the regression target.

```javascript
// Pseudocode in computeLineupTier or buildGameProjection
const expectedXw = avgWeightedXwoba;  // expected vs actual arsenal distribution
const maxXw = avgMaxXwoba;            // best-case if hitters always get their pitch

// Regress 50% toward expected — recognizes that pitchers control which pitches
// hitters see, especially elite pitchers
const regressedXw = (maxXw * 0.5) + (expectedXw * 0.5);
```

For an EXPLOITABLE lineup with `maxXw=0.410` and `expectedXw=0.340`, this produces `0.375` — pulling lineupMult from 1.22 down to 1.13.

### Change 2: Steepen the elite SP curve

The current linear `((xw - 0.320) × 2.0)` undercounts elite pitchers. Add a non-linear amplifier in the elite range:

```javascript
function pitcherMultFromXw(xw) {
  if (xw == null) return 1.0;
  const baseDelta = (xw - 0.320) * 2.0;
  // Amplify in the elite range (sub-.290): each .010 below .290 adds another 4%
  let eliteAmp = 0;
  if (xw < 0.290) {
    eliteAmp = (0.290 - xw) * 4.0;  // .270 → 0.08, .250 → 0.16
  }
  return 1.0 + baseDelta - eliteAmp;
}
```

For .243 SP: `1.0 + (0.243 - 0.320) × 2.0 - (0.290 - 0.243) × 4.0 = 1.0 - 0.154 - 0.188 = 0.658`

That's a 34% suppression for a truly elite pitcher — much closer to reality. An ace SP CAN turn a 9-run-environment game into a 5-run game.

### Change 3: Pitcher's duel detector

When BOTH starting pitchers are elite (xwOBA-against ≤ 0.290), apply an additional multiplicative suppression that recognizes the conjunction.

```javascript
// After computing both pitcher blends, check for the dual-elite scenario
const awayElite = awayVsHome?.pitcherXwAgainst != null && awayVsHome.pitcherXwAgainst <= 0.290;
const homeElite = homeVsAway?.pitcherXwAgainst != null && homeVsAway.pitcherXwAgainst <= 0.290;
const dualEliteFactor = (awayElite && homeElite) ? 0.93 : 1.0;

// Apply to BOTH teams' projections
projAwayRuns *= dualEliteFactor;
projHomeRuns *= dualEliteFactor;
```

Magnitude (-7%) is intentionally modest because Changes 1+2 already do most of the work. The dual-elite factor catches the "conjunction is more than the sum of parts" pattern.

## Expected impact

Re-running the failed games mentally:

**NYY@MIL** (was 12.64, actual 6):
- Both SPs elite (.274, .243)
- Change 1: lineupMult drops ~7-9%
- Change 2: home pitcherMult drops ~5%, away pitcherMult drops ~10%
- Change 3: dual-elite -7%
- Combined: roughly 12.64 × 0.91 × 0.93 × 0.93 ≈ **10.0**

Still high vs 6 actual, but much closer. And on the other side — STL@SD (which the model got right) — the existing 6.14 projection would only drop slightly because Change 2 wouldn't double-count when the pitcher is already in the elite suppression zone.

**ATL@LAD** (was 12.22, actual 4):
- One elite SP (.269), one bad SP (.360)
- Change 1: lineupMult drops modestly
- Change 2: away pitcherMult amplified down (-8%), home pitcherMult unchanged
- Change 3: doesn't fire (only one elite)
- Combined: roughly 12.22 × 0.94 × 0.96 ≈ **11.0**

Less correction here — and that's fine, because half of "ATL@LAD finished 1-3" is genuine variance, not detectable signal. We can't fix every game; we can fix the systematic failure on dual-elite matchups.

## Acceptance criteria

After deploy, on the next slate:
1. Games with BOTH SPs at xwOBA-against ≤ 0.290 should project 7-9 runs total, NOT 11+
2. Games with one elite SP should project ~9-11 runs (modest correction)
3. Games with both SPs above 0.310 should be largely unchanged
4. STL@SD-type games should still project 6-7 (no regression on the games we already get right)

If you re-run today's slate and the dual-elite games come in at 11+, the calibration didn't take and we need to revisit.

## What this doesn't fix

**Slugfests (under-projection):** SEA@CWS finished 20 runs vs 12.87 projected. That's a different failure mode — the model can't anticipate offensive explosions in the same way it can't anticipate pitcher's duels. A "slugfest detector" would need different signals (back-end-of-rotation matchups, weak bullpens both sides, hitter park, hot weather). This fix doesn't address slugfests.

**Lineup composition tier issues:** EXPLOITABLE label may itself be too generous. Future work could re-tune the tier thresholds. Out of scope for this fix.

**Conversion rate / sequencing:** Real pitcher's duels also feature poor offensive sequencing (rally killers, GIDPs). The conversionMult is small (±8%) and wouldn't catch this. Out of scope for this fix.

## Implementation plan

One file changed: `/api/analyze.js`. Three localized changes inside `buildGameProjection` and the `sideMult` helper. ~25 lines of code total.

Feature flag: I'll add `PITCHER_DUEL_FIX_ENABLED` defaulting to `true` (since the fix is well-justified) but flippable via Vercel env var if it overcorrects.

Diagnostic: extend the existing `factors` object output to surface the regression amounts so we can see what the fix is doing on each game.
