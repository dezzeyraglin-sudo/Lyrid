# Wave 1+2 Deploy Bundle — Ready for GitHub Upload
*May 10, 2026 — Lyrid Calibration Update*

## What's in this zip

Four files with **all Wave 1+2 patches applied**. These are drop-in replacements for the originals.

```
wave12-deploy/
├── public/
│   └── index.html           ← Replace your current public/index.html
├── api/
│   ├── analyze.js           ← Replace your current api/analyze.js
│   └── _lib/
│       └── hrEmpirical.js   ← Replace your current api/_lib/hrEmpirical.js
└── Lyrid-ROADMAP.md         ← Replace your current Lyrid-ROADMAP.md (root)
```

All files passed Node syntax-check before bundling. No partial edits, no broken references.

## What was changed in each file

### `public/index.html` (4 edits)
- **Patch 1** — Bias-sign label fix in Calibration tab (lines ~8248, ~8299, comment block ~7436)
- **Patch 2** — Banned-list filter wired into auto-log function (HR audit + top pick paths, ~line 6519 and ~6531)
- **Patch 3** — `seasonPa` displayed next to Barrel% in HR audit debug line (~line 4044)
- **Patch 7** — Calibration fields (`regressedMaxXwoba`, `tierEvalXwoba`, `adjustedEdgeScore`, `cappedContextMultiplier`) now logged on every pick (~line 6573)

### `api/analyze.js` (3 edits)
- **Patch 4** — `contextMultiplier` capped at 1.40 to prevent inflated `adjustedMaxXwoba` (~line 527)
- **Patch 5** — FULL GAME bonus (1.18×) removed from top-pick scoring; switch-hitter-vs-RHP boost (1.06×) added (~line 695-712)
- **Patch 8** — `TB_PROP_ENABLED` flag added (default OFF); TB 1.5 props no longer generated (~line 92, ~line 2014)

### `api/_lib/hrEmpirical.js` (1 edit)
- **Patch 6** — `bullpenMultiplier` renamed to `bullpenEdgeMultiplier`; recalibrated from 1.18× to 1.08× elite/strong, 1.06 → 1.05 solid; misleading "FULL GAME HR vulnerable" driver text replaced with "Hitter strong vs bullpen arsenal" (~line 244)

### `Lyrid-ROADMAP.md` (2 edits)
- Line 17: "under-projects" → "over-projects"
- Item #1 acceptance criterion: bias direction sign corrected, note added about reducing projections

---

## How to upload to GitHub (Mac, GitHub Desktop)

Per your handoff, you've been using GitHub Desktop with local clone at `~/Documents/GitHub/Lyrid`.

### Recommended flow:

1. **Backup current state first.** In GitHub Desktop, your current state is the safety net. If you have uncommitted changes, commit or stash them before this upload.

2. **Open the unzipped `wave12-deploy/` folder in Finder.**

3. **In a separate Finder window, open `~/Documents/GitHub/Lyrid/`.**

4. **Replace files one by one** (drag-and-drop into the matching folder, click "Replace" when prompted):
   - `wave12-deploy/public/index.html` → `~/Documents/GitHub/Lyrid/public/index.html`
   - `wave12-deploy/api/analyze.js` → `~/Documents/GitHub/Lyrid/api/analyze.js`
   - `wave12-deploy/api/_lib/hrEmpirical.js` → `~/Documents/GitHub/Lyrid/api/_lib/hrEmpirical.js`
   - `wave12-deploy/Lyrid-ROADMAP.md` → `~/Documents/GitHub/Lyrid/Lyrid-ROADMAP.md`

5. **Open GitHub Desktop.** It should show 4 changed files in the left panel.

6. **Review the diffs** in GitHub Desktop's diff viewer — you should see only the changes documented above. If you see unexpected diffs, stop and ask before committing.

7. **Commit message** (suggested):
   ```
   Wave 1+2 calibration update: bias sign, banned filter, contextMultiplier cap, FULL GAME bonus removal, bullpen recalibration, TB props disabled

   Patches 1-8 from May 10 calibration analysis (928-pick study).
   - Bias label flipped (+/- was inverted in display)
   - Banned-list filter wired into auto-log
   - seasonPa surfaced in HR audit debug line
   - regressedMaxXwoba and friends now logged on every pick
   - contextMultiplier capped at 1.40 to fix the >0.70 anti-predictive zone
   - FULL GAME 1.18x bonus removed (data showed it double-counts correlated signals)
   - Switch-hitter-vs-RHP boost added (60.4% empirical hit rate)
   - bullpenMultiplier -> bullpenEdgeMultiplier rename + 1.18 -> 1.08
   - TB_PROP_ENABLED flag added; TB 1.5 disabled until archetype-aware
   - Roadmap line 17 sign correction
   ```

8. **Push to origin.** Vercel auto-deploys from main; site should update in 1-2 min.

---

## After deploy — validation checklist

### Wave 1 (the cleanup) — verify in production within first hour:

1. **Bias label fix**
   - Open History → Calibration tab
   - Bias should display a number (e.g. "-2.78")
   - Below the number: should say "runs over" (not "runs under")
   - "WHAT THIS MEANS" section should say "Model over-projects by 2.78 runs on avg"

2. **Banned-list filter**
   - Settings → BAN LISTS — verify your bans are still there
   - Run a deep-mode analysis on a slate that includes a banned player or team
   - Open DevTools → Console → check `state.bestBetHistory[CURRENT_DATE]` keys
   - Should NOT contain new entries for banned hitters or teams

3. **seasonPa in HR audit**
   - Open the HR audit panel for any side
   - Each row's debug line should show "(N PA)" next to bbl
   - For early-season hitters (PA < 100), the regression arrow should appear AND the PA count should explain why

4. **Calibration fields logging**
   - DevTools → Console: `Object.values(state.bestBetHistory[CURRENT_DATE])[0]`
   - The latest pick entry should have `regressedMaxXwoba`, `tierEvalXwoba`, `cappedContextMultiplier` populated

### Wave 2 (the calibration changes) — track over next 7-10 days:

5. **contextMultiplier cap firing**
   - DevTools → Console: inspect `state.bestBetHistory` entries
   - `contextMultiplier` may be > 1.40 sometimes; `cappedContextMultiplier` should be ≤ 1.40 always
   - `adjustedMaxXwoba` should not exceed ~0.70 for any hitter

6. **FULL GAME bonus removed**
   - Top picks should still appear (the visual badge "FULL GAME" still surfaces)
   - But the *selection* of which hitter is top pick should differ — expect more SP-only edge picks promoted, fewer bullpen-amplified picks

7. **Switch-hitter boost**
   - Switch hitters facing RHP should appear more often as top picks when they have an edge
   - Watch for SHH (switch-handed hitters) appearing in top-pick slots they wouldn't have before

8. **TB props gone**
   - No "TB 1.5" entries in the prop recommendation list on any hitter card
   - History tab should still show old TB picks (legacy data preserved)

9. **Bullpen text update**
   - HR audit panel: when a hitter has bullpen edge, driver should read "Hitter strong vs bullpen arsenal" (not "FULL GAME HR vulnerable")
   - Multiplier shown should be `1.08` for elite/strong, `1.05` for solid

### Performance metrics to watch (50-100 picks needed):

| Metric | Pre-rollout baseline | Post-rollout target |
|---|---|---|
| Top picks hit rate | 46.5% | **50%+** |
| Elite tier hit rate | 49.6% | **53%+** |
| Overall hit rate | 49.9% | **52%+** |

If these don't improve over 100 picks, send the next backup and we'll dig into why.

---

## Rollback plan (if something breaks)

GitHub Desktop's commit history is your rollback. If anything breaks in production:

1. Open GitHub Desktop → History tab
2. Right-click the commit before this one → "Revert this Commit"
3. Push the revert
4. Vercel redeploys to previous state in ~1 min

The patches are designed to fail safe — even if one patch has an edge case I missed, the syntax checks passed and the boost function tolerates missing TB keys silently. But the rollback is there if you need it.

---

## What's NOT in this deploy

Wave 3 (Damage Quality Phase 2 archetype classifier) is intentionally not included. That's the next session's work, after Wave 1+2 has 5-7 days of validation data.

The standalone `damageArchetype.js` module file is in the previous bundle (`lyrid-rollout-1.zip`) along with `PATCH_9_archetype_integration.md` — those are ready when you are, but don't apply them yet. Validate Wave 1+2 first.

---

## Questions to expect from this deploy

**"Why are some of my elite-tier hitters now strong-tier?"**
The contextMultiplier cap (Patch 4) reduces inflation on extreme-context games. Hitters who were riding park × umpire × platoon stacking into elite tier may now land in strong tier. That's correct behavior — the data showed those picks were 40% hits.

**"Why don't I see any TB 1.5 props anymore?"**
Patch 8 disabled them — 33% historical hit rate. Re-enabled in Wave 3 only for ELITE_POWER archetype hitters (Phase 2 work).

**"Why does the HR audit say 'Hitter strong vs bullpen arsenal' instead of 'FULL GAME HR vulnerable'?"**
The old text was semantically backwards. New text matches what the field actually represents.

**"Why did my switch-hitter top pick suddenly become much more prominent?"**
60.4% hit rate observed on switch-hitters vs RHP. Patch 5 added a 1.06× boost for that matchup.

If any of these questions have answers different from what's documented above, that means the deploy didn't take — re-check the file replacement step.
