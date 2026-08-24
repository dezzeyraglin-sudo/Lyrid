# Lyrid NBA Engine

Drop-in NBA points/rebounds/assists engine + data layer for Lyrid. Mirrors the WNBA
build: current-team-aware data spine → shots-to-clear / counting-stat projections →
best bets logged to the shared History tab. Everything is **shadow posture** and every
threshold is a **WNBA-derived placeholder to re-fit on NBA graded data**.

## Drop it in

Unzip at the repo root — the `api/...` paths merge into your existing tree:

```
api/
  _lib/nba/
    espnClient.js            ESPN: schedule · box · gamelog · injuries · shot coords
    espnRoster.js            current-team resolution (offseason-signing fix)
    bbrefClient.js           advanced rates (USG/AST/TRB/FTr) + team/opponent context
    normalizeMerge.js        fuse ESPN + bbref + PP line → engine-shape player (+ teamChange)
    leagueConfig.js          NBA tunable constants (all TUNE placeholders)
    minutesModel.js          minutes distribution: recency-weighted (0.45 L10/0.55 L5),
                             blowout-by-role (alpha exemption / bench garbage-time),
                             injury-designation haircut, B2B/rest, teammate-out, <75% under-zone flag
    pointsEngine.js          shots-to-clear P(clear): sum-of-binomials + minutes integ.
    reboundsAssistsEngine.js counting-stat P(clear): minutes × rate, negative-binomial
    prizepicks.js            PrizePicks partner API, standard-only enforcement
    cadenceEngine.js         production cadence (assist trap / rebound support) from PBP
    formFloor.js             recent-form floor / formKill guard (market-aware gaps)
    biasCorrection.js        per-(player,market) rolling bias from graded uploads
    nbaVerdict.js            single-verdict pipeline: bias → engine → form floor → cadence
    nbaBestBets.js           rank verdicts → History candidate records
  nba/
    analyze.js               slate endpoint: lines → merge → minutes → rank → candidates
    slate.js                 board endpoint: schedule + line counts
  cron/
    nba-roster-index.js      nightly: rebuild + cache the current roster index
```

The design tokens you already have go at `public/lyrid/tokens.css`.

## Environment variables

```
PP_PARTNER_BASE     PrizePicks partner API base (key stays server-side)
PP_PARTNER_KEY      PrizePicks partner API key
PP_NBA_LEAGUE_ID    NBA league id on PrizePicks (default 7 — VERIFY in partner docs)
NBA_SEASON          bbref rate season (default 2026; prior season until new games accrue)
NBA_ROSTER_SEASON   ESPN roster season for current teams (default 2027)
CRON_SECRET         guards the roster cron
```

## vercel.json

```json
{ "crons": [ { "path": "/api/cron/nba-roster-index", "schedule": "0 8 * * *" } ] }
```

## Data flow

```
schedule (ESPN) ┐
roster index ────┤→ per PrizePicks standard line:
injuries (ESPN) ─┤     mergePlayer → projectMinutes → analyzePoints / analyzeCounting
bbref adv+team ──┤     → rankBestBets → toCandidates (History record)
PrizePicks lines ┘
```

`analyzeSlate()` in `analyze.js` is a pure function (fetchers injected) so it unit-tests
offline; the default export is the Vercel handler that wires the real clients.

## Wire the History logging (like the other sports)

`nbaBestBets.toCandidates` **is** your `nbaToCandidates` — it emits the exact `parlay_log`
record shape (`sport:'nba'`, `id`, `player`, `market`, `side`, `line`, `tier`, `cashRate`,
`why`, `flags.lineStatus`). Have the NBA analyze path call, mirroring MLB's `logBestBets(data)`:

```js
const ranked = rankBestBets(mergedPlayers, ppIndex);   // or read analyze.js output
const candidates = toCandidates(ranked, { date });     // pending, provisional
logBestBets(candidates);                                // your existing writer → parlay_log
```

Entries enter **pending**. No auto-grading — you grade via your periodic uploads, same as the
existing pending→graded flow.

## Honest caveats

- **Shadow mode.** Probabilities + provisional `LEAN`/`STRONG` tiers, never graded conviction.
  Nothing here has earned an edge until your uploads grade it. Tiers are deliberately *not* the
  validated WNBA names.
- **Every constant is a TUNE placeholder** in `leagueConfig.js` — calibration weights, minutes
  penalties, negative-binomial `k`, min edges. Re-fit on NBA outcomes.
- **Verify `PP_NBA_LEAGUE_ID`** — the public PP API 403s from a server, so I couldn't confirm it live.
- **bbref rates are prior-season** until a new season accrues games; a player with a team change on
  top of that is the shakiest input — surface it.
- **ESPN endpoints are unofficial** and rate-limit; a few paths (`/teams`, `/roster`, search) 403
  server-side and are routed around. Keep the roster index on the nightly cron, not the hot path.
- **Designation haircuts are reasoned, not backtested** (no historical pick carried its pregame
  designation). Log each pick's designation at slate time so these calibrate — highest-value logging step.
- **Markets:** points, rebounds, assists. Combos (PRA, etc.) and the walled tracking layers
  (shot quality, potential assists, scheme/coverage) are not built — those are the paid-data decision.

## Validated signals baked in (structure only — re-fit numbers on NBA data)

Minutes is the master variable (<75% of baseline → ~87% under). Blowout applies BY ROLE (alpha
exemption; bench garbage-time), not blanket. Volatility and foul-risk widen the band, never a lean.
B2B is a real NBA minutes signal (it was null in the WNBA). Confident overs are faded; line-above-
ceiling → under.

## Full validated stack — BUILT (composed in nbaVerdict.js)

All validated signals are now wired into one single-verdict pipeline (each stage only narrows):
minutes model → base engine → **form floor / formKill** → **production cadence** → **per-player
bias correction** → OVER/UNDER/PASS. Two stages sit inert until you feed them and go live:

- **Cadence** needs per-market 2nd-half shares fed as `mergedPlayer.cadenceShares` (aggregate
  ESPN play-by-play over a player's recent games); it self-gates at 5+ games. Points & assists
  shares come from `cadenceEngine.pointsAssistShareFromPlays`; rebound shares need a rebound-event
  parse. Until fed, cadence is skipped safely.
- **Bias correction** reads `gradedHistory` (your uploads: {player, market, projected, actual}).
  Empty until you upload — then it self-calibrates per player/market.

Nothing here is a blocker: the engine runs and produces best bets with these inactive; they only
sharpen it as data arrives.
