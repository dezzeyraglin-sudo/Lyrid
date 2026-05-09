# Mismatch Finder

Live MLB daily pitcher-vs-hitter mismatch analysis tool. Pulls probable starters, pitcher arsenals, and per-pitch-type hitter Statcast data — then layers on park factors and assigned umpire tendencies to adjust mismatch scoring.

## Stack

- Frontend: vanilla HTML/CSS/JS (no build step)
- Backend: Vercel serverless functions (Node 18+, native `fetch`)
- Data: MLB Stats API + Baseball Savant + embedded park/umpire factor datasets

## Deploy

See [DEPLOY.md](./DEPLOY.md) for step-by-step instructions.

1. Push this repo to GitHub
2. Import to Vercel
3. Deploy
4. Open URL, add to home screen

## Endpoints

```
/api/probables         today's games + probable SPs (MLB StatsAPI)
/api/pitcher-arsenal   Statcast pitch-type usage/velo/whiff %
/api/lineup            posted lineup or active roster fallback
/api/hitter-stats      hitter overall xwOBA + per-pitch xwOBA
/api/park-factor       3yr rolling park factors (Runs/HR/LHB HR/RHB HR)
/api/umpire            assigned HP ump + K/BB/Runs boost factors
/api/analyze           core mismatch engine - combines all of the above
```

## How mismatches are computed

For each game:
1. Get home/away probable pitchers from MLB StatsAPI
2. Fetch each pitcher's arsenal from Baseball Savant (pitch type, velo, usage %)
3. Fetch opposing lineup (posted lineup or active roster fallback)
4. For each hitter, fetch per-pitch-type xwOBA this season
5. Match pitcher's top 3 pitches against hitter's performance on those exact pitches
6. **Apply park factor** - power hitters (>=10% barrel) get HR PF adjustment by handedness; contact hitters get Run PF
7. **Apply umpire factor** - if HP ump is assigned, boost/dampen edge by their Runs factor
8. Tier by adjusted max xwOBA: Elite >=.420, Strong >=.370, Solid >=.330
9. Sort by adjusted edge score (xwOBA x pitcher usage % x context multipliers)

## Context adjustments explained

**Park factors** (3yr rolling from Baseball Savant):
- Coors Field: +15% runs, +12% HR - Dodgers hitters get boosted
- Oracle Park: -8% runs, -15% HR - SF visitors get dinged
- LHB/RHB HR PF are separate - Yankee Stadium is LHB +17% HR, RHB +10% HR (short porch)

**Umpire factors** (from UmpireAuditor/Swish Analytics aggregated data):
- Angel Hernandez: 0.94x K, 1.12x BB, 1.04x runs - hitter-friendly lean
- Pat Hoberg: 1.08x K, 0.88x BB, 0.96x runs - pitcher-friendly lean
- Only applied when HP ump is assigned (~1-3 hours before first pitch)

Adjustments show as colored chips on each mismatch card.

## Local structure

```
mismatch-finder/
  api/
    _data/
      parkFactors.js       3yr PF data for all 30 parks
      umpireFactors.js     K/BB/Runs factors for active HP umps
    probables.js           today's schedule
    pitcher-arsenal.js     Statcast arsenal lookup
    lineup.js              team lineup
    hitter-stats.js        hitter Statcast metrics
    park-factor.js         park PF lookup
    umpire.js              live HP ump + factors
    analyze.js             core engine combining all of above
  public/
    index.html             frontend UI
  vercel.json
  package.json
```

## Updating the embedded datasets

**Park factors** (`api/_data/parkFactors.js`): Update annually from Baseball Savant's park factor leaderboard. Source: https://baseballsavant.mlb.com/leaderboard/statcast-park-factors

**Umpire factors** (`api/_data/umpireFactors.js`): Review quarterly. Sources:
- UmpireScorecards (https://umpscorecards.com)
- Swish Analytics (https://swishanalytics.com/mlb/mlb-umpire-factors)
- UmpireAuditor aggregated data

Both files are flat JS objects - just edit the numbers and redeploy.

## License

Private. Do not redistribute.
