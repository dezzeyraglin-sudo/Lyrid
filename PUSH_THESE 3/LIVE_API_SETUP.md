# Live Tennis API + Context Layer — setup

## What was added
1. `api/tennis/liveApi.mjs` — Live Tennis API adapter (FREE tier: schedule + scores + players).
   Drop-in board source that replaces the flaky OddsPapi schedule. Caches hard to respect the
   100/day free-tier limit.
2. `tennis/tennisContext.mjs` — the "unseen edge" layer: recent FORM + FATIGUE adjustments that
   nudge a projection for what the Sackmann career average can't see. Bounded to ±6% win-prob so
   context informs, never dominates the Elo anchor.

## Env var (already set)
- `livetennisapi` = your free API key ✓

## To wire the board to the new feed
In `api/tennis/schedule.mjs`, add Live Tennis API as the PRIMARY source:
```js
import { liveMatches } from './liveApi.mjs';
// try live API first, fall back to existing sources
try { const live = await liveMatches('upcoming'); if (live.length) return live; } catch {}
// ...existing api-tennis.com / OddsPapi fallback...
```

## To wire context into the read (the unseen-edge part)
In the analyze path, after computing the base Elo win prob:
```js
import { formScore, fatigueScore, contextWinAdj } from '../../tennis/tennisContext.mjs';
// pull recent results from the index `recent` block or a /players/{id} call
const ctx = contextWinAdj({ formA, formB, fatigueA, fatigueB });
const adjustedWinA = Math.max(0.05, Math.min(0.95, baseWinA + ctx.adj));
// feed adjustedWinA to the projector; surface ctx.factors on the card as extra "why" factors
```

## Honest scope
- FREE tier gives fixtures + scores + player bios. Enough to fix the board and power form/fatigue.
- Serve stats for the engine still come from the Sackmann index (free tier has no per-match serve
  splits — that's the Ultra tier). The context layer works with what free provides.
- The $9.99 Basic tier adds historical results + point-by-point tape — that's the upgrade that
  replaces the dead Sackmann repos with live-updated data. Recommended when ready, not required now.

## What context CAN and CANNOT do
CAN (data-driven, built): recent form momentum, recent-match fatigue, H2H.
CANNOT (won't fake): undisclosed injuries, private motivation, gut reads. The model never invents
these — it adjusts only on signals the data actually contains.
