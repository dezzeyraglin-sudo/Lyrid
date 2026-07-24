# Lyrid NFL Engine — Complete Drop-in (v2)

Unzip at the repo root (`~/Documents/GitHub/Lyrid`). Overwrites the v1 NFL files
and adds the new modules. Paths mirror your existing structure.

## What changed since v1
- **`public/index.html`** — REPLACES your current one. Same NFL tab, updated
  integration script (empty state now prints the requested date + source + server
  note so an empty slate explains itself).
- **`api/nfl/slate.js`** — now fetches LIVE PrizePicks NFL lines (league_id=9).
  Fixes: UTC→Eastern date conversion (a 7:20pm ET kickoff was landing on the next
  day); returns `diagnostics.unmappedStatTypes` + `datesSeen` + `propFamilies`.
- **`lib/nfl/nflLineAdapters.js`** — stat labels are now canonicalized, so
  `Rush+Rec Yards` / `Rush + Rec Yards` / `rushing+receiving yds` all map. Anything
  unmapped is reported instead of silently dropped (this is why RB combo lines
  were missing).

## New modules
| File | What it does |
|---|---|
| `lib/nfl/nflMatchupNarrative.js` | Coverage context (man/zone %, dominant shell, blitz), **probable CB matchup** (alignment-derived, with confidence + caveat), and ranked **why-over/under drivers** |
| `lib/nfl/nflPlayerArchetype.js` | Prop-family routing: receiving backs → `rush_rec_yards`, hybrid QBs → `pass_rush_yards`. Keeps archetype and availability as separate dimensions |
| `lib/nfl/nflInactives.js` | **Day-of availability gate** (ESPN, free, no key) — the NFL analog to the MLB confirmed-starter rule. Kills props for OUT players, flags when a matchup defender or teammate is OUT |
| `data/nfl/build_coverage_by_position.py` | Coverage allowed vs RB / TE / WR receivers (RBs are covered by LB/S, not CBs) |

## The orchestrator — `lib/nfl/nflAnalyze.js`
`analyzeProp(ctx)` runs EVERY feature module for one prop and returns a single
object: `verdict` (tier), `routing` (what to take instead), `narrative` (coverage +
probable CB + ranked why-drivers), `outlook` (QB struggle/flourish), `signals` (each
module's raw output), plus `missing` / `dataCompleteness` so a thin read is visibly
thin. Everything combines ADDITIVELY.

**Prop routing (the blitz x checkdown rule).** If the opponent is blitz-heavy AND the
QB leans on his TE under pressure, the WR1 line is the wrong side of that offense —
the yardage moves to the TE and to the QB's short-completion total. The router emits
`avoid` / `prefer` lists, and a HIGH-severity avoid **overrides the tier** (a card
must never read GUARANTEED while the routing says don't take it). The inverse case is
handled too: a QB who pushes it downfield under pressure (Allen-type) turns a heavy
blitz into a deep-WR *preference*.

## Card output — `lib/nfl/nflCardSummary.js`
`analyzeProp()` now returns `card = { summary, explanations }`.
* **summary** — one plain-language paragraph on why he clears or misses the line.
  A routing override takes precedence ("Pass on X — the yardage moves to the TE").
* **explanations** — bullets where every line cites the number behind it
  (target share, snap %, drop rate, coverage split, penalty rate, etc).
Rule enforced in code: no sentence appears unless the engine actually computed it.

## Former-team ("revenge game") flag — `lib/nfl/nflRevengeGame.js`
Tested on nflverse 2020-24 (WR/TE, n=104 qualifying games): mean +1.9 yds,
**median -4.4**, over-baseline rate **48.1%**, p=0.54 — NO league-wide effect.
Individual players look consistent (Diggs vs former teams +40.7/+28.7/+95.9/-24.1;
Kupp vs LA -17.8/-1.8/-4.8) but at n=3-4 that is expected by chance, and those are
exactly the cases people remember. The flag is therefore **informational (weight 0)**:
it displays the history on the card and lets nflPlayerVsOpponent.js (min 4 meetings,
shrunk, capped +/-0.25) do any actual weighting. Same discipline as the retired MLB
SCORCHING tier.

## Injured lineups — `lib/nfl/nflInjuryImpact.js`
Detection lives in `nflInactives.js`; **magnitude** lives here.
* **Offense (measured, real).** nflverse 2024, 51 teammate observations where a
  team's top target missed: **+4.2pp target share, +6.2 yds, 60.8% of teammates
  gained, p=0.021.** Scaled by ROLE PROXIMITY — a direct same-role replacement
  projects ~+7-8pp / +25 yds, a distant-role teammate ~+2pp / +12 yds.
* **Defense (detected, NOT quantified).** The same test on defenses missing their
  top CB found n=6 usable splits, mean -0.4 yds, p=0.97 — too small to establish a
  magnitude. So opponent injuries emit a FLAG and widen `uncertainty`; they do not
  move the projection, and a GUARANTEED tier is demoted to PLATINUM because the
  matchup read it rested on just went stale.

## Deploy order
1. **Schema** — run `sql/001_nfl_schema.sql` in Supabase (14 tables, idempotent).
2. **Ingest** (local, needs your Supabase service key):
   ```
   pip install -r data/nfl/requirements.txt
   export SUPABASE_URL=https://xtldczxlibdkwqvgmnob.supabase.co
   export SUPABASE_SERVICE_KEY=...     # rotate after backfill
   python3 data/nfl/ingest_nflverse.py            --seasons 2022 2023 2024 2025
   python3 data/nfl/build_team_tendencies.py      --seasons 2022 2023 2024 2025
   python3 data/nfl/build_defense_scheme.py       --seasons 2023 2024
   python3 data/nfl/build_defense_suppression.py  --seasons 2022 2023 2024 2025
   python3 data/nfl/build_coverage_by_position.py --seasons 2022 2023 2024 2025
   python3 data/nfl/build_penalty_drag.py         --seasons 2022 2023 2024 2025
   python3 data/nfl/build_receiver_quality.py     --seasons 2022 2023 2024 2025
   python3 data/nfl/build_pressure_profiles.py    --seasons 2023 2024   # participation-based
   ```
   `--dry-run` on any script previews without writing.
3. **Deploy** — push. `public/index.html` and `api/nfl/slate.js` go live together.
4. **Activate tiers** — fill `loadBaselines()` in `api/nfl/slate.js` to read
   `nfl_feature_vectors` + comp pools from Supabase. Until then the tab shows PP
   lines with "baseline pending" (honest, no fabricated tiers).
5. **Calibrate before badges** — one-time DraftKings historical pull → grade into
   `nfl_backtest_grades` → replace the PROVISIONAL thresholds flagged in-code
   (`nflGameScript` 0.30 cutoff; `nflClassify` GOLD .57 / PLAT .62 / GUAR .68;
   `nflMatchupAnalysis` tail saturation). `wilsonLower()` gates any label.

## IMPORTANT: nflverse release rename (fixed in this drop)
nflverse moved player stats: 2024-and-earlier are at
`player_stats/player_stats_{yr}.parquet`, **2025+ at
`stats_player/stats_player_week_{yr}.parquet`**. The old path 404s for 2025, which
would have silently skipped the most recent season from your comp pool.
`ingest_nflverse.py` now tries both. 2025 is confirmed complete (through week 22).

## Data notes (verified live)
- PrizePicks **does not** block Vercel — direct fetch works.
- nflverse gives rosters, depth charts (CB1/CB2/slot), and **CB coverage quality**
  (`pfr_advstats` weekly: yards/target allowed, passer rating allowed) — all free.
- nflverse is post-game/daily and **cannot** provide the 90-minutes-before-kickoff
  inactives. That's why `nflInactives.js` uses ESPN.
- True CB **shadow** assignments (does CB X travel with WR Y) are paid data
  (PFF/SIS). `probableCoverage` is an alignment inference and says so; set
  `defScheme.shadow_cb` manually to upgrade confidence for known shadow corners.
