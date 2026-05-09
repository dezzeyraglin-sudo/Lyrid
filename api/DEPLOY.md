# Mismatch Finder — Deployment Guide

Get the tool running on the internet with live MLB data in ~15 minutes. $0 cost. You don't need any coding experience, just a web browser.

---

## What you're deploying

- **Frontend**: The tool UI (`public/index.html`)
- **4 API endpoints**: Live data pulls (`api/probables.js`, `api/pitcher-arsenal.js`, `api/lineup.js`, `api/hitter-stats.js`, `api/analyze.js`)
- **Data sources**: MLB Stats API (schedule, probables, lineups) + Baseball Savant (Statcast pitch-level data). Both are free, public.

---

## What you need

1. A GitHub account (free) — https://github.com/signup
2. A Vercel account (free) — https://vercel.com/signup (sign up with your GitHub)

That's it.

---

## Step 1 — Put the code on GitHub

**Option A: Use GitHub website (easiest, no Git install)**

1. Go to https://github.com/new
2. Repository name: `mismatch-finder`
3. Keep it **Public** (free Vercel tier requires this; no one will find it)
4. Check "Add a README file"
5. Click **Create repository**
6. On the new repo page, click **Add file → Upload files**
7. Drag in all 4 files/folders from the `mismatch-finder` folder I made:
   - `api/` (whole folder with 5 files inside)
   - `public/` (whole folder with `index.html`)
   - `vercel.json`
   - `package.json`
8. Scroll down, click **Commit changes**

**Option B: Use Git command line** (if you have it installed)

```bash
cd mismatch-finder
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mismatch-finder.git
git push -u origin main
```

---

## Step 2 — Deploy on Vercel

1. Go to https://vercel.com/new
2. Click **Import Git Repository**
3. Find `mismatch-finder` in the list, click **Import**
4. On the configuration screen:
   - **Framework Preset**: Other (should auto-detect)
   - **Root Directory**: leave as `./`
   - **Build Command**: leave empty
   - **Output Directory**: `public`
   - **Install Command**: leave empty
5. Click **Deploy**

Wait 30-60 seconds. You'll get a URL like `https://mismatch-finder-xyz.vercel.app`.

**That's your live tool.** Open that URL on any device.

---

## Step 3 — Add to your phone's home screen

**iPhone:**
1. Open the Vercel URL in Safari
2. Tap share icon (bottom center)
3. Scroll down → **Add to Home Screen**
4. Name it "Mismatch Finder" → Add

**Android:**
1. Open in Chrome
2. Three-dot menu → **Add to Home screen**

Now it opens like a native app with your live MLB data.

---

## Step 4 — Test it

1. Tap **⟳ LOAD LIVE SLATE**
2. You should see today's games with probable pitchers pulled from MLB
3. Tap any game → the tool runs analysis on the full lineup vs opposing pitcher
4. Mismatches surface automatically, ranked by tier

First analyze click takes 15-30 seconds (pulling arsenal + 9 hitters' Statcast data). Subsequent loads are cached.

---

## How the data flows

```
Your browser
    ↓ /api/probables?date=2026-04-17
Vercel serverless function
    ↓ calls statsapi.mlb.com
MLB Stats API (free, public)
    ↓ returns today's games + probable SPs
Vercel function → your browser

Your browser
    ↓ /api/analyze?gamePk=XXXXX
Vercel function
    ↓ parallel calls to:
    • MLB Stats API (lineup)
    • Baseball Savant (pitcher arsenal)
    • Baseball Savant (each hitter's per-pitch xwOBA)
    ↓ cross-references arsenal vs hitter performance
Returns ranked mismatches → your browser
```

All free APIs. No keys needed. Vercel's free tier gives you 100GB bandwidth/month, which is way more than you'll ever use.

---

## Tier logic (how mismatches are ranked)

The analyze endpoint matches the pitcher's top 3 pitches by usage against each hitter's per-pitch-type xwOBA this season. Tiers are assigned by the hitter's highest xwOBA against any of those pitches:

- **ELITE** (orange): xwOBA ≥ .420 vs a key pitch
- **STRONG** (green): xwOBA ≥ .370
- **SOLID** (blue): xwOBA ≥ .330

Hitters with no matched pitch-type data or below .330 are filtered out entirely.

The `edgeScore` that sorts them weights by the pitcher's usage — a .450 xwOBA on a pitch the pitcher throws 40% is bigger than .450 on a 5% pitch.

---

## Future improvements (ask me when you want them)

- **Umpire tendencies** — K-zone data per-ump
- **Park factors** — Coors/Yankee Stadium adjustments to HR probability
- **Probability distribution modeling** — expected strikeouts as a distribution instead of a point estimate
- **Platoon-specific xwOBA** — vs RHP vs LHP splits
- **Live line integration** — FanDuel/DK odds if you want auto-flagging of value

The backend is in place; these are all additions, not rewrites.

---

## Troubleshooting

**Games list is empty after tapping LOAD LIVE SLATE**
- Check the date — if you picked a future date, no games yet
- MLB API occasionally hiccups; retry

**Analysis shows "no pure mismatches found" for every game**
- Baseball Savant early-season data is sparse (small samples)
- Mid-April onward gets more robust
- This is correct behavior — if a pitcher's arsenal genuinely shuts down the lineup, no mismatches should show

**"Analysis failed" error**
- Baseball Savant rate-limited you (unlikely on free tier)
- Wait 60 seconds and retry
- Cached for 30 min once successful

**Pitcher arsenal shows empty**
- Pitcher hasn't thrown enough in the current season yet
- Try checking back later in April once samples stabilize

---

Hit me up if any step breaks. I built this to be bulletproof but APIs change.
