# Prop Engine Integration Guide

This upgrade is safe because it adds a standalone formula module at:

```txt
api/_lib/prop-formulas.js
```

It does **not** replace your existing `api/analyze.js` logic.

## What your current tool already does

Your current engine already pulls pitcher arsenals, hitter Statcast pitch-type xwOBA, park factors, and umpire factors, then ranks pitch-matchup mismatches.

## What this upgrade adds

- Run Power Index (RPI)
- Run Contact Index (RCI)
- Game Type Classification
- Prop edge math
- Volatility scoring
- Role stability scoring
- K suppression scoring
- Late-inning equity scoring
- Trap detection
- PrizePicks Demon/Goblin side blocking
- Final pick labels: NUKE / STRONG / STANDARD / PASS

## How to use inside `api/analyze.js`

At the top:

```js
import {
  PROP_TYPES,
  SIDES,
  calculateEnvironment,
  gradeProp
} from "./_lib/prop-formulas.js";
```

After you calculate a game/team matchup, create the environment:

```js
const environment = calculateEnvironment({
  teamHRIndex: team.hrIndex,
  xbhIndex: team.xbhIndex,
  parkHRFactor: park.hr,
  weatherHRFactor: weather?.hr ?? 100,
  pitcherHRWeakness: pitcher.hrWeaknessIndex,
  contactRateIndex: team.contactIndex,
  obpIndex: team.obpIndex,
  kSuppressionIndex: team.kSuppressionIndex,
  bullpenXwOBAIndex: bullpen.xwobaIndex,
  babipRunProfile: team.babipIndex
});
```

Then grade a prop:

```js
const propGrade = gradeProp({
  propType: PROP_TYPES.FANTASY_SCORE,
  side: SIDES.MORE,
  projectionType: "normal", // "normal", "demon", or "goblin"
  projection: hitter.projectedFantasyScore,
  line: hitter.fantasyScoreLine,
  gameType: environment.gameType,
  matchupScore: hitter.edgeScore,
  roleStability: hitter.roleStabilityScore,
  lineupSpot: hitter.lineupSpot,
  projectedPA: hitter.projectedPA,
  startsLast10: hitter.startsLast10,
  pinchHitRisk: hitter.pinchHitRisk,
  popularityIndex: hitter.popularityIndex,
  lineInflationIndex: hitter.lineInflationIndex
});
```

Add the result to your existing output:

```js
return {
  ...existingMismatch,
  environment,
  propGrade
};
```

## Local test command

```bash
node --test api/_lib/prop-formulas.test.js
```

## Important PrizePicks rule included

The module blocks unders on Demon/Goblin projections:

```js
projectionType: "demon" // unders blocked
projectionType: "goblin" // unders blocked
```

If the desired side is blocked, `gradeProp()` returns:

```js
{
  allowed: false,
  decision: "PASS",
  reason: "Desired side is blocked by Demon/Goblin projection rules."
}
```
