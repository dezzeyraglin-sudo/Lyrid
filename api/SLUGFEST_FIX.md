# Slugfest Detection Fix
*May 9, 2026 — second fix in the same session as the pitcher's duel fix*

## What it addresses

Mirror of the pitcher's duel failure. Model projects 9-13 on games that end 14-20+. SEA@CWS finished 20 runs vs 12.87 projected. Bigger pattern: model can't differentiate "elite SP duel" (NYY@MIL projected 12.64, finished 6) from "two bad SPs vs stacked lineups in a hitter park" (SEA@CWS projected 12.87, finished 20). Everything compresses into the 10-13 zone.

## The 4-signal conjunction

The fix uses a multi-factor scoring system. Each signal worth 1.0 (or 0.5 for the meltdown signal). 3+ score triggers +7%. 4+ score triggers +10%.

**Signal 1: Both SPs bad** — `xwOBA-against ≥ 0.330` for both starters. Translation: neither pitcher is good enough to lock down their opposing lineup.

**Signal 2: Both lineups stacked** — both EXPLOITABLE-tier with `tieredCount ≥ 7`. Translation: 7+ of 9 hitters in BOTH lineups have at least a SOLID edge against their pitcher's arsenal.

**Signal 3: Hitter park/weather** — `envRunMult ≥ 1.05`. Captures park HR factors AND weather effects (heat, wind out). Rate Field at +13% HR triggers this naturally.

**Signal 4: Multiple HR-elite hitters** — 3+ hitters across both lineups projected at HR/PA ≥ 6%. Comes from the existing HR projection module — finally connecting it to the run total.

**Signal 5 (half-weight): Both meltdown innings ≤ 7th** — both pitchers have a flagged high-leverage scoring window in regulation. Adds 0.5 to score.

## Why a score-based approach instead of all-or-nothing

The pitcher's duel fix uses a strict gate: BOTH SPs elite or it doesn't fire. That's appropriate when both starters are the dominant signal. Slugfests are noisier — they're about a *combination* of conditions, not one binary. Score-based lets us catch the "almost a slugfest" cases at +7% while reserving +10% for the textbook setups.

## Magnitude rationale

A real slugfest goes 14-20 runs. Old projection was 12.87. Boosting to 14.16 (+10%) gets us much closer without overshooting. We can't fully predict a 20-run explosion — half of that is variance — but pulling the projection from 13 to 14 turns "model said low total" into "model said high total" which changes the bet recommendation entirely.

We're **not** trying to project actual slugfests at 18 runs. We're trying to flag them as "this is going to score" so the over recommendation comes through.

## Sanity guarantees (no collisions)

**Pitcher's duel games (NYY@MIL):** Both SPs elite, so `bothSPsBad` fails. Score stays low. Slugfest factor stays 1.0. Pitcher's duel fix still applies. The two fixes work in opposite directions and don't interfere because the gate conditions are mutually exclusive.

**Average games:** Needs 3 of 4 main signals to fire. Just one bad pitcher doesn't trip it. Just one stacked lineup doesn't trip it. A neutral park alone is irrelevant. The conjunction requirement protects against false positives.

**Test cases that should/shouldn't fire:**
- SEA@CWS: should fire +10% (4 of 4 + meltdown)
- ATL@LAD: shouldn't fire (one elite SP — Signal 1 fails)
- DET@KC: probably 1-2 score, no boost
- NYY@MIL: zero or one signal, no boost
- Coors Field with two ace SPs: Signal 1 fails, can't fire even with hitter park

## What to look for in production

When you analyze tonight's slate:

1. Open the network tab and look at `factors.slugfestScore` and `factors.slugfestSignals` in the response. The signals array tells you exactly which conditions matched.

2. Games that should trigger slugfest detection:
   - Two bad SPs (xwOBA-against shown in pitcher analysis ≥ .330)
   - Both lineups labeled EXPLOITABLE
   - Hitter park (Coors, Rate Field, Yankee Stadium with wind out)
   - Multiple HR-elite badges in the hitter section

3. The narrative line will appear in projection reasoning: "Slugfest setup — [signals] — projection boosted X%"

4. If the calibration is too aggressive (slugfests over-projecting), flip `SLUGFEST_FIX_ENABLED=false` in Vercel env vars.

## Files changed

`api/analyze.js` only. Same file as the pitcher's duel fix. Approximately 60 lines of new code total.

## Feature flag

`SLUGFEST_FIX_ENABLED` — defaults to ON. Vercel env var override available.

When disabled, `slugfestFactor` stays at 1.0 and the projection math is unchanged. Diagnostic outputs still populate so you can see what would have applied.
