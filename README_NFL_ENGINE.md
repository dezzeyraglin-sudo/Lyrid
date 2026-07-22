# Lyrid NFL Engine — Drop-in

Unzip at the root of the Lyrid repo (`~/Documents/GitHub/Lyrid`). Paths mirror the
existing structure (`lib/`, `data/`, `sql/`, `api/`). Nothing here overwrites an
existing file — every path is NFL-namespaced.

## What's included
```
lib/nfl/            9 engine modules (feature builders, comp engine, classifier, adapters)
data/nfl/           4 ingest/build scripts (run locally) + stadiums.json + requirements.txt
sql/                001_nfl_schema.sql  (12 tables, complete, Postgres-validated)
api/nfl/slate.js    Vercel serverless endpoint the SPA calls (stub → wire to data)
docs/               SPA integration snippets + the integration <script>
```

## Deploy order

1. **Schema** — run `sql/001_nfl_schema.sql` in the Supabase SQL editor (lyrid-prod).
   Idempotent; safe to re-run. Creates 12 `nfl_*` tables.

2. **Ingest (local, needs Supabase service key)**
   ```
   pip install -r data/nfl/requirements.txt
   export SUPABASE_URL=https://xtldczxlibdkwqvgmnob.supabase.co
   export SUPABASE_SERVICE_KEY=...        # service_role; rotate after backfill
   # seed stadiums/teams first (see stadiums.json), then:
   python3 data/nfl/ingest_nflverse.py --seasons 2022 2023 2024 2025
   python3 data/nfl/build_team_tendencies.py --seasons 2022 2023 2024 2025
   python3 data/nfl/build_defense_scheme.py --seasons 2023 2024
   python3 data/nfl/build_defense_suppression.py --seasons 2022 2023 2024 2025
   ```
   Add `--dry-run` to any script to preview rows without writing.

3. **SPA integration** — from a fresh fork of the deployed `public/index.html`,
   apply the 4 additive edits in `docs/nfl-insertion-snippets.txt`
   (nav button, nfl-panel, scoped CSS, and paste `docs/nfl-integration.html`'s
   `<script>` after `window.switchTab` is defined). Zero core edits.

4. **Backtest calibration (before any tier BADGE ships)** — one-time DraftKings
   historical pull via The Odds API into `nfl_prop_lines_historical`, grade into
   `nfl_backtest_grades` (walk-forward folds), then replace the PROVISIONAL
   thresholds flagged in-code:
     - `nflGameScript.js` flag cutoff (0.30)
     - `nflClassify.js` tier P-cutoffs (GOLD 0.57 / PLATINUM 0.62 / GUARANTEED 0.68)
     - `nflMatchupAnalysis.js` qbOutlook + shootout tail saturation
   No tier label is authorized until its empirical Wilson lower bound clears
   breakeven (`wilsonLower()` in nflClassify.js enforces this).

5. **Wire the endpoint** — fill the TODO block in `api/nfl/slate.js` to read live
   lines + features from Supabase and return real picks. Until then it returns an
   honest empty slate and the UI shows its no-data state.

## Notes
- All feature combination is additive (never multiplicative), per Lyrid rules.
- Altitude models air-density carry (Denver), not "ball rotation".
- Manual Underdog/PrizePicks tracker (`nfl_pickem_manual`) is kept SEPARATE from
  the DK backtest set so the biased manual sample can't contaminate tier math.
- `lyrid-tokens.css` is intentionally NOT included — you already have it.
