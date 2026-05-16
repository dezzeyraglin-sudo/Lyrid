# Wave 4 Session 2 — Recent Form Weighting (Shadow Mode)
*May 15, 2026*

## What this ships

The `recentForm.js` module from Session 1 is now wired into the production code, running in **shadow mode** by default. Every hitter gets a form classification (HOT/SCORCHING/NEUTRAL/COLD/INJURY_RISK) based on their last 10 games, surfaced as a UI chip on the hitter card, and logged on every pick for validation.

**The multiplier is NOT applied to HR scoring yet.** That happens after 1 week of shadow data validates the classifier.

## Four files to deploy

```
public/index.html              ← Replace (UI: RECENT FORM chip + audit logging)
api/analyze.js                 ← Replace (parallel fetch + flag handling + return)
api/_lib/hrEmpirical.js        ← Replace (recentFormMultiplier function in pipeline)
api/_lib/recentForm.js         ← NEW FILE (the module itself)
```

## Feature flags

Two environment variables in Vercel:

| Flag | Default | What it controls |
|---|---|---|
| `RECENT_FORM_DISPLAY` | **true** (on) | Shows the RECENT FORM chip in UI, logs form on picks |
| `RECENT_FORM_ENABLED` | **false** (off) | Actually applies the multiplier to HR projection |

Initial state: **`_DISPLAY=true`, `_ENABLED=false`** (shadow mode). You'll see the form chip on every hitter card, you'll see logging in `state.bestBetHistory`, but HR scores are not affected by recent form yet.

## How to deploy

### Step 1: Replace three existing files

1. Open Finder to `~/Documents/GitHub/Lyrid/`
2. From the downloaded files, drag-and-replace:
   - `index.html` → into `~/Documents/GitHub/Lyrid/public/` (replaces existing)
   - `analyze.js` → into `~/Documents/GitHub/Lyrid/api/` (replaces existing)
   - `hrEmpirical.js` → into `~/Documents/GitHub/Lyrid/api/_lib/` (replaces existing)

### Step 2: Add the new module file

3. Drag `recentForm.js` into `~/Documents/GitHub/Lyrid/api/_lib/`
4. This is a NEW file — GitHub Desktop will show it with a "+" indicator

### Step 3: Verify in GitHub Desktop

GitHub Desktop should show **exactly 4 changed files**:
- ✏️ `public/index.html` (modified)
- ✏️ `api/analyze.js` (modified)
- ✏️ `api/_lib/hrEmpirical.js` (modified)
- ➕ `api/_lib/recentForm.js` (NEW file, green indicator)

⚠️ If you see deletions OR more than 4 files, STOP and discard.

### Step 4: Commit + push

```
Wave 4 S2: Recent form weighting (shadow mode)

- Adds api/_lib/recentForm.js — classifies hitters by last 10 games
- 5 tiers: SCORCHING (+15%), HOT (+10%), NEUTRAL, COLD (-10%), INJURY_RISK (-25%)
- Wired into analyze.js parallel fetch alongside seasonStats
- hrEmpirical.js gets new recentFormMultiplier in featureFns chain
- UI: RECENT FORM chip on hitter cards (warning style for INJURY_RISK)
- Audit logging: recentFormLabel/Multiplier/Applied/etc. on every pick
- Feature flags:
  - RECENT_FORM_DISPLAY=true  (default — show chip, log form)
  - RECENT_FORM_ENABLED=false (default — DON'T apply multiplier yet)
- Validation: 8 of 9 historical hitters classified correctly vs expected
  (Schwarber→SCORCHING, Seager→INJURY_RISK, Nimmo→COLD, etc.)
```

Push → Vercel auto-deploys in 1-2 min.

## What you'll see after deploy

Every hitter card now has a **RECENT FORM** row showing:
- Form label (SCORCHING / HOT / NEUTRAL / COLD / INJURY_RISK)
- Recent line (e.g. "7H/29PA, 5HR (last 7G)")
- Multiplier badge if non-1.0 (+10%, +15%, -10%, -25%)
- `shadow` indicator confirming multiplier is NOT applied yet

Visual hierarchy:
- **INJURY_RISK** — red/warning style, draws attention
- **HOT/SCORCHING** — amber, signals heat
- **COLD** — cool blue, signals fade
- **NEUTRAL** — gray, low visual weight
- **INSUFFICIENT** — hidden (no chip shown)

## Performance impact

Each slate analysis now adds:
- ~25 hitters × 1 MLB Stats API call = 25 extra HTTP requests per slate
- All run in parallel via `Promise.all` so total slate time barely changes
- 30-min in-memory cache means re-running analysis within same session is free

MLB Stats API rate limits: no documented hard cap, anecdotally tolerates hundreds of req/min. We're nowhere near. If we ever hit a limit, the module fails gracefully (returns INSUFFICIENT, no slate breakage).

## Validation plan (1 week)

After 5-7 slates with shadow data:

1. Pull a fresh backup
2. Group post-deploy picks by `recentFormLabel`
3. Compute hit rate per label

**Acceptance criteria to flip `RECENT_FORM_ENABLED=true`:**

| Label | Expected Hit Rate vs NEUTRAL |
|---|---|
| SCORCHING | ≥1.4x NEUTRAL |
| HOT | ≥1.2x NEUTRAL |
| NEUTRAL | (baseline) |
| COLD | ≤0.7x NEUTRAL |
| INJURY_RISK | ≤0.5x NEUTRAL |

If criteria met → set `RECENT_FORM_ENABLED=true` in Vercel + redeploy. Live behavior change.

If criteria NOT met → keep in shadow mode, tune thresholds in `recentForm.js`, redeploy, revalidate.

## DevTools verification commands

After tonight's slate analysis, in Safari console:

```javascript
// Check recentForm data is flowing
const latestPick = Object.values(state.bestBetHistory[getTodayStr()] || {})[0];
console.log('Recent form data on latest pick:', {
  label: latestPick.recentFormLabel,
  multiplier: latestPick.recentFormMultiplier,
  applied: latestPick.recentFormApplied,
  gamesUsed: latestPick.recentFormGamesUsed
});
```

```javascript
// Count form distribution on tonight's picks
const today = getTodayStr();
const picks = Object.values(state.bestBetHistory[today] || {});
const dist = {};
picks.forEach(p => { dist[p.recentFormLabel] = (dist[p.recentFormLabel] || 0) + 1; });
console.log('Tonight form distribution:', dist);
```

Expected output: most hitters NEUTRAL, ~5-15% HOT/SCORCHING, ~5-10% COLD, occasional INJURY_RISK.

## Rollback options

**Soft (env var):** Set `RECENT_FORM_DISPLAY=false` in Vercel + redeploy. Module still loaded but UI chip disappears, no audit logging. Useful for debugging UI issues.

**Hard (commit revert):** GitHub Desktop → History → Revert the Wave 4 S2 commit → Push.

## What's NOT in this session

- ❌ Multiplier NOT applied to HR scoring (Session 3, after validation)
- ❌ HRR scoring uses recent form (Session 3 extension)
- ❌ Distribution-based UNDER recommendations (Session 4)
- ❌ Fantasy Score line analysis (Wave 6 territory)

## Risk summary

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| MLB API rate limiting | Very Low | Slate gets stale recent data | Cache aggressively, fail gracefully to INSUFFICIENT |
| Module loaded but not used | N/A | None — that's shadow mode | (this is the intent) |
| Classifications look wrong on UI | Medium | User confusion | Shadow mode catches before live; we can tune |
| Performance degradation | Low | Slower slate analysis | Parallel fetching keeps total time stable |
| Production cache memory | Very Low | Slow Vercel function | TTL + per-invocation reset |

## Why this is a clean ship

1. **Module is validated.** 8 of 9 historical hitters classified correctly. The one outlier (Witt/Buxton showing NEUTRAL in test) was a test-fixture artifact, not a module bug — they classified SCORCHING when given real season stats.
2. **MLB API fetcher live-tested.** Pulled Schwarber's actual 2026 gameLog successfully. 45 games returned with correct field shapes.
3. **Two-flag staged rollout.** Display first, multiplier second. We can see the data before changing model behavior.
4. **Audit log is set up for validation.** Every pick now records its form label so we can score the model retroactively.

Ship when you're ready. Send the next backup ~7 days out and we'll do the validation analysis.
