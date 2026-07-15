# Lyrid Tennis — Handoff & Maintenance

Everything needed to deploy, run, and maintain the Tennis addition **without the original chat session**. If you (or another dev, or a fresh AI session) need to finish or fix it, start here.

## What it does
Tennis tab in the SPA. Pulls the upcoming slate, and for any matchup projects both players' performance — win prob, holds, aces, double faults, total games, **total games won (per player)**, and **fantasy score** — congregating surface, recent form, fatigue, surface transition, and head-to-head. You type the PrizePicks line for any market and it returns the over/under likelihood.

Everything is **priors** (`bet:false`) until validated against real logged lines. That's by design — no fake tiers.

## Architecture (three data sources, on purpose)
- **Index** (`tennis/tennis_serve_index.json`) — deep serve/return baselines per player by surface, built from historical match data (Sackmann schema). Slow-moving; rebuild periodically.
- **Live augment** (`tennisLiveAugment.mjs`) — refreshes only the recency-sensitive bits (form/fatigue) at read time so reads stay current between index rebuilds. Adapter not yet wired to a source (see TODO).
- **OddsPapi** — the upcoming **schedule** (`api/tennis/schedule.mjs`). Fixture-first: tournaments → fixtures. Board needs only fixtures (players+time); you type lines, so no odds pull needed for the board.

## File map (all under repo root)
- `index.html` — SPA with the Tennis tab already integrated (nav button, `#tennis-panel`, controller).
- `api/tennis/analyze.mjs` — serves a match read from the index. Query: `a`, `b`, `surface`, `bestOf`, `rankA/B`, `h2hEdge`, and line params `acesA/B, dfA, totalGames, fantasyA/B, gamesWonA/B`.
- `api/tennis/schedule.mjs` — upcoming slate from OddsPapi (needs `ODDSPAPI_KEY`).
- `tennis/tennisFeed.js` — parse Sackmann CSVs + melt to player rows.
- `tennis/tennisFeatureBuilder.js` — build the index (per-player surface profiles + recent form). CLI: `node tennis/tennisFeatureBuilder.js ./data/tennis ./tennis/tennis_serve_index.json`.
- `tennis/tennisProjector.js` — Monte-Carlo match model → all projections + fantasy (confirmed PrizePicks scoring: match +10, game ±1, set ±3, ace +0.5, DF −0.5).
- `tennis/tennisMatchRead.js` — assembles the read (congregates circumstances, grades lines).
- `tennis/tennisClassify.js` — tier/gate logic (mirrors wnbaClassify; UNGRADED until real lines).
- `tennis/tennisLiveAugment.mjs` — live form/fatigue refresh.
- `tennis/tennisColdStart.mjs` — builds a player profile on demand from the live source when they're NOT in the index (ITF, Challenger, new pros). This is how off-index players get reads.
- `tennis/tennisApiTennis.mjs` — api-tennis.com live source (drop-in alt to Matchstat).
- `tennis/tennisMatchstat.mjs` — live-stats source (Matchstat RapidAPI); resolves names->ids, pulls recent matches with serve stats. Wired into analyze.mjs.
- `tennis/oddspapiClient.mjs` — OddsPapi client (fixture-first; see note below).
- `tennis/tennisTotalGamesScan.js` + `tennis/oddspapiRunner.mjs` — real-line total-games edge scan (you run with your key).
- `tennis/tennisBacktest.js` — naive-baseline edge exploration on history.
- `build_tennis_index.sh` — rebuild the index (multi-mirror, self-healing).

## Deploy (what's on `main` vs what to push)
Already on `main`: the `tennis/` folder, `api/tennis/*`, and an `index.html` with the tab.
Push these updated files (drag into GitHub `upload/main`, or `git add`):
- `index.html` (adds games-won + fantasy line inputs)
- `api/tennis/schedule.mjs` (rewritten for OddsPapi)
- `api/tennis/analyze.mjs`, `tennis/tennisMatchRead.js` (games-won grading)
- `tennis/tennis_serve_index.json` (the built index — required for reads)

Then in **Vercel → project → Settings → Environment Variables** add:
- `ODDSPAPI_KEY` = your OddsPapi key (for the schedule board)
- `MATCHSTAT_KEY` = your RapidAPI key for "Tennis API - ATP WTA ITF" (for live current-form reads; optional — reads fall back to the index if unset)

Vercel redeploys on push. Tab works once the index is committed and the key is set.

## How to use
Open Tennis tab → board lists upcoming matches → tap one → it shows projections. Type the PrizePicks line(s) in the inputs (total games, games won per player, fantasy per player, aces, DF) → tap **Apply lines** → each shows over/under % vs the projection.

## Maintenance
**Rebuild the index** (do this weekly-ish so form stays current):
```
bash build_tennis_index.sh
```
It tries multiple data mirrors, rebuilds, commits, pushes. If it prints "ALL MIRRORS FAILED", find any `tennis_atp` fork on GitHub with `atp_matches_YYYY.csv` files (search github for `atp_matches_2024.csv`), add `owner/repo/branch` to `ATP_MIRRORS` at the top of the script, rerun.

**Auto-refresh (future-proof, optional):** add a `vercel.json` cron that hits a rebuild endpoint on a schedule, OR run `build_tennis_index.sh` from a local cron / GitHub Action weekly. The multi-mirror fallback means it keeps working when a single source dies.

## Measured tier baselines (real completed Bo3, 2023-24) — use these, not intuition
| Tier | mean games | 3-set % | tiebreak % |
|---|---|---|---|
| ITF Futures | 21.35 | 29.0% | 23.5% |
| Challenger | 22.57 | 34.3% | 30.5% |
| ATP Tour | 23.49 | 36.0% | 38.5% |

**ITF runs SHORTER than tour** — fewest 3-setters, fewest tiebreaks. Big early-round skill gaps produce blowouts; tightly-matched tour fields are what create long matches. The common assumption that lower-tier matches grind to 3 sets/tiebreaks is backwards, and betting ITF OVERs on that theory fades a real UNDER lean. Note this makes the calibration bug WORSE at ITF (model ~25 vs ITF reality 21.35).

## ITF Futures — why they're NOT in the index
Sackmann's `atp_matches_futures_YYYY.csv` files exist (18,423 rows in 2024) but contain **zero serve statistics** — the stat columns are empty, because ITF Futures events don't record match stats. They cannot feed the index (no aces/svpt/SvGms to build a profile from). Challengers ARE in (`atp_matches_qual_chall_YYYY.csv`, 100% stat coverage, 2020-2025) — that's what took the index from 1,605 to 3,408 players. True ITF players are handled by cold start (below).

## ITF / new players (cold start)
Players outside the historical index (ITF, Challenger, first-year pros) are read via `tennisColdStart.mjs`: analyze.mjs misses the index, then builds their profile from the live source's recent matches. Requires a live key. Board marks these "live profile"; deep-history (indexed) matches sort first. Cold-start reads carry a smaller sample, so the thin-sample gate fires — that's intended.

## ⚠️ KNOWN CALIBRATION BUG — total games biased HIGH (fix before betting)
**Symptom:** model projects ~25.0-25.4 total games; ATP reality is 23.49. ITF reality is 21.35.
**Root cause (measured):** the model produces **~52-55% three-setters vs ATP's real 36%**. Games-per-set is correct (~10); SETS-per-match is wrong. Real 36% implies the typical favorite wins each set ~77% of the time; our model makes real matchups look closer to coin flips.

**Ruled out:** hold rate for average players is correct (0.804 vs tour ~80%). Set/game sim logic is correct (win-by-2, 7-6 tiebreak). The model DOES go lopsided when the gap is genuinely large (Sinner v Svrcina → 94%, 20.9 games), so the sim isn't broken — the rate *inputs* are too compressed.

**Why the rates compress — the real blocker.** Mixing Challenger data exposed that raw serve/return rates are level-biased (a Challenger player returns vs weak servers → his return% reads elite). The adjustment for this is **mathematically under-determined**: `p(point) = spw_server + (TOUR_RET − ret_returner)` is invariant under adding the same constant to every spw AND every ret. Within a closed pool you cannot distinguish "all weak servers + strong returners" from "all average". Only cross-level players (who play both Challenger and tour) carry the true gap. Attempts that did NOT work: single-pass opponent adjustment; 4-pass iteration (diverges — an inflated returner inflates his opponents' serve ratings, shrinking his own correction); + damping (0.5) and sample-size shrinkage (K=600 pts) — still leaves Svrcina at ret=0.446, i.e. best-returner-in-history territory; + re-centering the scale on tour-level players — pushed everything to impossible values (Sinner ret 0.472). Current shipped state = damped + shrunk, no gauge fix.

**THE MOST PROMISING UNTRIED FIX — use empirical hold%, don't derive it.** The sim currently derives hold probability from point-win prob assuming i.i.d. points. But the data already contains **actual observed holds**: `breaks_suffered ≈ bpFaced − bpSaved`, so `holdPct = 1 − (bpFaced − bpSaved) / svGms`. `newAcc()` already accumulates bpSaved/bpFaced/svGms — the numbers are sitting there unused. Feeding observed hold rates straight into `simSet()` bypasses the entire point-model calibration problem AND captures clutch/break-point performance (a player who saves break points holds more than his raw point% implies). This is the single highest-value next change.

## Opponent adjustment (why lower-tier stats needed fixing)
Raw rates are level-biased: a Challenger player returns against weak servers, so his return% reads elite (Svrcina 0.447 vs Dimitrov 0.373 — nonsense). `tennisFeatureBuilder.js` now runs an iterated (4-pass) opponent adjustment: each player's serve/return rates are re-estimated with the opponent's own strength stripped out, converging against already-adjusted peers. This is what makes Challenger + tour data mixable in one index.

## Troubleshooting (the exact things that bit us)
- **Board empty / "schedule unavailable"** → `ODDSPAPI_KEY` not set in Vercel, or off-hours (no fixtures in the 36h window). Set the key; check during active tournament hours.
- **Reads say "index not found"** → `tennis/tennis_serve_index.json` isn't committed. Run the build script, push.
- **Downloads get 0 files** → the data mirror died. Add a new one to `ATP_MIRRORS` (Sackmann's own `JeffSackmann/tennis_atp` was removed from GitHub — do not use it).
- **"thin sample" on a player** → they're not in the index (WTA is only 2024; ITF/Challenger players often absent). Widen the index data or accept ATP-strong coverage.
- **Terminal pastes mangle** (zsh eats multi-line/`#`) → put commands in a script file and `bash file.sh`, or paste single-line commands only.
- **OddsPapi total-games SCAN** (`oddspapiRunner.mjs`) → OddsPapi is fixture-first and odds only populate on live/imminent fixtures; the odds-parsing in `oddspapiClient.mjs` (`normalizeTotals`) still needs the real market shape confirmed on a fixture that has `hasOdds:true` during play. The schedule board does NOT depend on this.
- **API keys** → never commit or paste them; keep in the shell (`export ODDSPAPI_KEY=…`) or Vercel env. Rotate if exposed.

## What's done vs TODO
Done: index build, projections + fantasy (confirmed scoring), congregation (form/fatigue/surface/H2H), games-won + fantasy line grading, OddsPapi schedule board, live-augment logic, multi-mirror self-healing builder.
TODO: (1) DONE — live form is wired via Matchstat (`tennisMatchstat.mjs` + `augmentMatchup` in `analyze.mjs`); set `MATCHSTAT_KEY`. If reads don't refresh (aces come back null), the per-match `stat` field names differ from the docs — run `node -e` importing `makeMatchstatSource(...).probe("Jannik Sinner")`, paste the sample, and adjust `mapStat()`. (2) confirm OddsPapi's total-games market shape for the edge scan; (3) widen WTA data (only 2024 now); (4) once you've logged real lines for a few weeks, promote graded tiers in `tennisClassify.js`.
