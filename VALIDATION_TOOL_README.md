# Validation Report Generator — Deployment & Usage

## Short answer: it doesn't deploy anywhere
The validation generator is a **local-only Node CLI script**. It runs on your laptop against a backup JSON file you export from the running app. It is NOT part of the Vercel deployment, NOT a server endpoint, NOT something that runs on a schedule. Think of it as a personal diagnostic tool, like a wrench.

## Where the file goes in your repo
Put it at:
```
~/Documents/GitHub/Lyrid/tools/validation-report.js
```
The `tools/` directory at repo root is where you'd add any future devops scripts. If `tools/` doesn't exist, create it.

You CAN commit it to git so it's tracked alongside the app code (recommended — version control for your own diagnostics, plus it survives if your laptop dies). It will sit in the repo doing nothing on Vercel — that's fine. Vercel only runs the API endpoints under `api/` and serves `index.html`; the `tools/` directory is ignored.

## How to run it

### Prerequisites
- Node 18+ installed (you already have this since you run Vercel locally)
- A backup JSON file exported from Lyrid (the same kind you've been uploading to me)

### Export a backup from the running app
In the app, you should already have a way to export `bestBetHistory` etc. Save it as something like:
```
~/Downloads/lyrid-full-backup-2026-06-05.json
```

### Run the generator
From your repo root:
```bash
node tools/validation-report.js ~/Downloads/lyrid-full-backup-2026-06-05.json
```

By default this prints the report to stdout. Pipe it to a file:
```bash
node tools/validation-report.js ~/Downloads/lyrid-full-backup-2026-06-05.json > reports/2026-06-05.md
```

Or pass output path as second argument:
```bash
node tools/validation-report.js ~/Downloads/lyrid-full-backup-2026-06-05.json reports/2026-06-05.md
```

Open the .md in any markdown viewer (VS Code preview, GitHub web view, Obsidian, etc) and read it.

## How often to run it

**During Phase 1+2 validation (next 2-3 weeks):** after every 2-3 slates. You want to catch regressions early.

**After validation stabilizes:** weekly is plenty. The generator is fast (<1 second on the 832KB May 29 backup) so there's no cost to running it more often.

**Anytime you make a code change:** run it before AND after to confirm the change had the expected effect.

## What to look at first
Every report starts with Section 1 (Headline) — your top-of-funnel number. If WR ≥ 50%, you're winning territory. Below 50%, dig into Sections 2-7 to find the leak.

Section 2 ("Phase 1 Fade Engine Validation") is the canary — it tells you whether the critical wiring fix is still working. If you ever see "🚨 ALERT" there with HIGH_FADE picks reaching best-bet logs, something has reverted or broken — investigate immediately.

Section 7 ("Inning Audit") gives the deepest diagnosis. After you ship the Inning Audit Fixes #1-#3, this section is how you'll know if they worked.

## What the report can't tell you (limitations)

- **Live ad-hoc questions** ("did Yelich's pick last night fire correctly?") — for one-off investigations, use the browser console or the existing audit UI. The generator is a periodic statistical summary.
- **Things not tracked in the backup JSON.** If a feature doesn't log fields, the generator can't analyze them. Phase 3 work will require new logged fields (calibration prob, stage probs, edge-vs-line) before this generator can audit it.
- **Causal explanations.** The generator says "your home projections are biased -0.84 runs." It can't tell you WHY without you investigating the projection math. That's a human task; the generator surfaces what needs investigation, not what to do.

## Updating the generator over time

The generator is dumb code that reads JSON. To extend it:
- Add new sections by writing a `buildXxx(data)` function and pushing its output to `sections` in `buildReport()`
- The pre-deploy baseline constants are at the top of the file (`PRIOR_BASELINE_WR`, `BREAKEVEN_110`, `PRIME_TARGET`) — update as the data shifts
- The FI calibration audit references the same buckets you'd want to feed back into `FI_CALIBRATION_POINTS` in `firstInning.js` — that's intentional, the generator and the model talk to each other

If you ever want to refit the FI calibration table from accumulated live data:
1. Run the generator
2. Read Section 7C's actual hit rates per bucket
3. Update the `FI_CALIBRATION_POINTS` array in `firstInning.js` to match
4. Push, re-run, confirm the miss column shrinks toward zero

That's the calibration loop. As long as the generator is honest, the model can be made honest.
