#!/usr/bin/env node
// tools/validation-report.js
//
// LYRID VALIDATION REPORT GENERATOR (May 29, 2026)
//
// PURPOSE
//   On-demand analysis of a Lyrid backup JSON. Produces a structured
//   markdown report covering:
//
//     1. Headline performance (current window vs prior baseline)
//     2. Phase 1 fade engine validation (tier hit rates)
//     3. Phase 2 PRIME tier validation
//     4. Lineup support adjustment correlation
//     5. HITS-over-HRR preference impact
//     6. Fragility level distribution
//     7. INNING-LEVEL AUDIT (the bigger one)
//        - First Inning bet performance by tier
//        - Probability calibration check
//        - Game projection accuracy
//        - YRFI vs NRFI side-bias check
//        - Specific failure-mode decomposition
//     8. Signal-by-signal correlation summary
//
// USAGE
//   node tools/validation-report.js path/to/lyrid-backup.json [output.md]
//
//   Defaults to stdout if no output path given.

import { readFileSync, writeFileSync } from 'fs';

const PHASE_DEPLOY_DATE = '2026-05-30';  // adjust if you ship on a different date
const PRIOR_BASELINE_WR = 48.80;          // your established baseline from 1,166 picks
const BREAKEVEN_110 = 52.4;
const PRIME_TARGET = 60.0;

// =====================================================
// MAIN
// =====================================================
function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node validation-report.js path/to/backup.json [output.md]');
    process.exit(1);
  }
  const inputPath = args[0];
  const outputPath = args[1] || null;

  const data = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const report = buildReport(data, inputPath);

  if (outputPath) {
    writeFileSync(outputPath, report);
    console.error(`Report written to ${outputPath}`);
  } else {
    process.stdout.write(report);
  }
}

// =====================================================
// REPORT BUILDER
// =====================================================
function buildReport(data, inputPath) {
  const sections = [];

  const currentDate = data.currentDate || 'unknown';
  const bbh = data.bestBetHistory || {};
  const fi = data.firstInningBets || {};
  const gl = data.gameLineBets || {};
  const pa = data.projectionAudit || {};

  // Flatten best-bet entries with date
  const allBestBets = [];
  for (const [d, day] of Object.entries(bbh)) {
    if (!day || typeof day !== 'object') continue;
    for (const entry of Object.values(day)) {
      entry._date = d;
      allBestBets.push(entry);
    }
  }
  const decided = allBestBets.filter(e => e.result === 'win' || e.result === 'loss');

  // ============ HEADER ============
  sections.push(`# Lyrid Validation Report
**Source:** \`${inputPath}\`
**Current date in backup:** ${currentDate}
**Date range:** ${dateRange(allBestBets)}
**Generated:** ${new Date().toISOString()}

---
`);

  // ============ SECTION 1: HEADLINE ============
  sections.push(buildHeadline(decided, allBestBets));

  // ============ SECTION 2: PHASE 1 FADE VALIDATION ============
  sections.push(buildFadeValidation(decided));

  // ============ SECTION 3: PHASE 2 PRIME TIER ============
  sections.push(buildPrimeValidation(decided));

  // ============ SECTION 4: LINEUP SUPPORT ============
  sections.push(buildLineupSupportValidation(decided));

  // ============ SECTION 5: HITS-OVER-HRR ============
  sections.push(buildHitsOverHrrValidation(decided));

  // ============ SECTION 6: FRAGILITY ============
  sections.push(buildFragilityValidation(decided));

  // ============ SECTION 7: INNING AUDIT (THE BIG ONE) ============
  sections.push(buildInningAudit(fi, pa));

  // ============ SECTION 8: SIGNAL CORRELATIONS ============
  sections.push(buildSignalCorrelations(decided));

  // ============ FOOTER ============
  sections.push(buildFooter(decided, allBestBets));

  return sections.join('\n\n');
}

// =====================================================
// SECTION 1: HEADLINE
// =====================================================
function buildHeadline(decided, allBestBets) {
  const w = decided.filter(e => e.result === 'win').length;
  const l = decided.filter(e => e.result === 'loss').length;
  const wr = decided.length > 0 ? (w / decided.length) * 100 : 0;
  const delta = wr - PRIOR_BASELINE_WR;
  const beVsBreakeven = wr - BREAKEVEN_110;

  const verdict = wr >= BREAKEVEN_110 ? '✅ Above prop break-even'
                : wr >= PRIOR_BASELINE_WR ? '⚠️ At/above baseline, below break-even'
                : '❌ Below baseline';

  // Per-day trend
  const byDate = groupBy(decided, e => e._date);
  const sortedDates = Object.keys(byDate).sort();
  const last7 = sortedDates.slice(-7);
  let recentTrend = '';
  if (last7.length >= 3) {
    const totals = last7.map(d => {
      const day = byDate[d];
      const w = day.filter(e => e.result === 'win').length;
      const l = day.filter(e => e.result === 'loss').length;
      const dwr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
      return { d, w, l, wr: dwr };
    });
    recentTrend = totals.map(t => `| ${t.d} | ${t.w}-${t.l} | ${t.wr.toFixed(0)}% |`).join('\n');
  }

  return `## 1. Headline Performance

| Metric | Value |
|---|---|
| Decided picks | ${decided.length} |
| Wins | ${w} |
| Losses | ${l} |
| **Win rate** | **${wr.toFixed(1)}%** |
| vs prior baseline (${PRIOR_BASELINE_WR}%) | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts |
| vs -110 break-even (${BREAKEVEN_110}%) | ${beVsBreakeven >= 0 ? '+' : ''}${beVsBreakeven.toFixed(1)} pts |
| **Verdict** | **${verdict}** |

### Last 7 days trend
| Date | Record | WR |
|---|---|---|
${recentTrend}

### Sample size note
${decided.length < 50 ? '⚠️ Small sample (n<50) — single-slate variance is high. Patterns here are directional only.' :
  decided.length < 150 ? '🟡 Moderate sample (n<150) — emerging trends, but bucket-level analysis still noisy.' :
  '✅ Healthy sample for top-level analysis. Bucket-level analysis stable.'}
`;
}

// =====================================================
// SECTION 2: PHASE 1 FADE VALIDATION
// =====================================================
function buildFadeValidation(decided) {
  // Pre-deploy: fadeTier not logged. Post-deploy: every entry has it.
  const tagged = decided.filter(e => e.fadeTier);

  if (tagged.length === 0) {
    return `## 2. Phase 1 Fade Engine Validation

⚠️ **No fade tier data in logged entries yet.** Either the Phase 1 fix hasn't deployed yet, or no decided picks have been logged since deploy. Re-run this report after live picks accumulate.

`;
  }

  // Tier distribution + WR
  const tiers = ['normal', 'caution', 'high_fade'];
  const tierStats = {};
  for (const t of tiers) {
    const bucket = tagged.filter(e => e.fadeTier === t);
    const w = bucket.filter(e => e.result === 'win').length;
    const l = bucket.filter(e => e.result === 'loss').length;
    tierStats[t] = { w, l, n: bucket.length, wr: (w + l > 0) ? (w / (w + l)) * 100 : 0 };
  }

  // Capped-flag specifically (Component 6)
  const capped = tagged.filter(e => e.adjustedXwobaCapped);
  const cappedW = capped.filter(e => e.result === 'win').length;

  // Pre-Phase-1 audit reference data
  const refLines = [
    `**Pre-deploy backtest (n=169 historical replay):**`,
    `- normal:    38% WR (14-23)`,
    `- caution:   55% WR (46-38)`,
    `- high_fade: 31% WR (15-33) — these picks should now be BLOCKED from best-bet logging`,
  ].join('\n');

  // After phase 1, high_fade should be 0 — fade override now blocks before logging
  const expectedHighFadePostFix = tierStats.high_fade.n === 0 ? '✅' : '⚠️';

  return `## 2. Phase 1 Fade Engine Validation

Phase 1 moved the fade override BEFORE \`logBestBets\`. Effect: HIGH_FADE picks should no longer appear in this section at all. If any do, the override didn't take.

### Tier distribution (Phase 1 post-deploy data)

| Fade tier | Record | WR | n | Expected |
|---|---|---|---|---|
| normal | ${tierStats.normal.w}-${tierStats.normal.l} | ${tierStats.normal.wr.toFixed(0)}% | ${tierStats.normal.n} | ≥50% |
| caution | ${tierStats.caution.w}-${tierStats.caution.l} | ${tierStats.caution.wr.toFixed(0)}% | ${tierStats.caution.n} | ~50% |
| **high_fade** | **${tierStats.high_fade.w}-${tierStats.high_fade.l}** | **${tierStats.high_fade.wr.toFixed(0)}%** | **${tierStats.high_fade.n}** | **${expectedHighFadePostFix} should be 0 post-Phase-1** |

${tierStats.high_fade.n > 0 ?
  `### 🚨 ALERT: ${tierStats.high_fade.n} HIGH_FADE picks were logged
This means \`applyFadeOverrides\` is NOT running before \`logBestBets\`. Check the order in \`renderAnalysis\`. The Phase 1 fix may have been reverted, the deploy may not have taken, or the override may be silently failing.

Sample HIGH_FADE picks that got through:
${tagged.filter(e => e.fadeTier === 'high_fade').slice(0, 5).map(e =>
  `- ${e._date} ${e.hitterName} fade_score=${e.fadeScore} prop=${e.propKey} result=${e.result}`
).join('\n')}
` : `### ✅ Fade override is working
Zero HIGH_FADE picks reached best-bet logging since deploy. This is the +5.6 WR-pt fix doing its job.`}

### Component 6: Multiplier runaway flag

Picks where \`adjustedXwobaCapped = true\` (raw value exceeded 0.80 ceiling):
- Count: ${capped.length}
- WR if logged: ${capped.length > 0 ? ((cappedW / capped.length) * 100).toFixed(0) + '%' : 'n/a'}
- Expected: most should now be high_fade (Component 6 awards 15 points). Those that slip through caution+capped should be watched.

### Reference: pre-deploy expected behavior
${refLines}
`;
}

// =====================================================
// SECTION 3: PHASE 2 PRIME TIER
// =====================================================
function buildPrimeValidation(decided) {
  const tagged = decided.filter(e => e.isPrime !== undefined);

  if (tagged.length === 0) {
    return `## 3. Phase 2 PRIME Tier Validation

⚠️ **No PRIME field data in logged entries yet.** Re-run after live picks accumulate.

`;
  }

  const prime = tagged.filter(e => e.isPrime === true);
  const eligibleNotPromoted = tagged.filter(e => e.isPrimeEligible && !e.isPrime);
  const nonElig = tagged.filter(e => !e.isPrimeEligible);

  const primeW = prime.filter(e => e.result === 'win').length;
  const primeL = prime.filter(e => e.result === 'loss').length;
  const primeWR = (primeW + primeL > 0) ? (primeW / (primeW + primeL)) * 100 : 0;

  const nonPrimeW = nonElig.filter(e => e.result === 'win').length;
  const nonPrimeL = nonElig.filter(e => e.result === 'loss').length;
  const nonPrimeWR = (nonPrimeW + nonPrimeL > 0) ? (nonPrimeW / (nonPrimeW + nonPrimeL)) * 100 : 0;

  const primeVerdict = primeW + primeL < 15 ? '🟡 sample too small'
                     : primeWR >= PRIME_TARGET ? `✅ holding above ${PRIME_TARGET}% target`
                     : primeWR >= 55 ? `⚠️ below target, monitoring`
                     : `❌ missing target by ${(PRIME_TARGET - primeWR).toFixed(0)} pts`;

  // Reject-reason breakdown
  const rejectReasons = {};
  for (const e of tagged) {
    if (!e.primeRejectReason) continue;
    const reasons = e.primeRejectReason.split(';');
    for (const r of reasons) {
      const key = r.replace(/_\d.*$/, '');  // strip values
      rejectReasons[key] = (rejectReasons[key] || 0) + 1;
    }
  }
  const topReasons = Object.entries(rejectReasons).sort((a, b) => b[1] - a[1]).slice(0, 6);

  return `## 3. Phase 2 PRIME Tier Validation

PRIME is the marketing-grade tier — top 5/slate, target 60%+ WR.

### PRIME performance

| Metric | Value |
|---|---|
| PRIME picks logged | ${prime.length} |
| Record | ${primeW}-${primeL} |
| **PRIME WR** | **${primeWR.toFixed(1)}%** (target ${PRIME_TARGET}%) |
| Non-eligible record | ${nonPrimeW}-${nonPrimeL} (${nonPrimeWR.toFixed(0)}%) |
| Lift (PRIME vs non-eligible) | ${(primeWR - nonPrimeWR >= 0 ? '+' : '') + (primeWR - nonPrimeWR).toFixed(1)} pts |
| **Verdict** | **${primeVerdict}** |

### Eligible but not promoted (slate cap)

| Metric | Value |
|---|---|
| Count | ${eligibleNotPromoted.length} |
| These exist because of the per-slate MAX_PRIME=5 cap. If count is high (>20 over a few weeks), consider raising cap. | |

### Top rejection reasons (PRIME-eligible criteria that failed)

| Reason | Count |
|---|---|
${topReasons.map(([r, n]) => `| ${r} | ${n} |`).join('\n')}

${prime.length === 0 ? `
### 🚨 ALERT: 0 PRIME picks logged
This is concerning if you've had a few full slates since deploy. Most likely cause: criteria too tight. Common candidates for loosening:
- \`REG_MIN\` (0.45) → 0.43
- \`CTX_MAX\` (1.15) → 1.18

Don't loosen until 3+ slates have passed with zero PRIME — could be a sampling artifact.
` : ''}

### Per-slate PRIME count

| Date | PRIME count | PRIME WR |
|---|---|---|
${(() => {
  const byDate = groupBy(prime, e => e._date);
  return Object.keys(byDate).sort().map(d => {
    const day = byDate[d];
    const w = day.filter(e => e.result === 'win').length;
    const l = day.filter(e => e.result === 'loss').length;
    const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
    return `| ${d} | ${day.length} | ${wr.toFixed(0)}% |`;
  }).join('\n') || '| (none) | 0 | n/a |';
})()}
`;
}

// =====================================================
// SECTION 4: LINEUP SUPPORT
// =====================================================
function buildLineupSupportValidation(decided) {
  const tagged = decided.filter(e => e.lineupSupportFactor != null);

  if (tagged.length === 0) {
    return `## 4. Lineup Support Factor Validation

⚠️ No lineup support data yet. Re-run after live picks accumulate.

`;
  }

  // Bucket by adjustment magnitude
  const buckets = [
    { name: 'Strong boost (≥+10%)', filter: e => e.lineupSupportAdjustment >= 0.10 },
    { name: 'Mild boost (+3 to +10%)', filter: e => e.lineupSupportAdjustment >= 0.03 && e.lineupSupportAdjustment < 0.10 },
    { name: 'Neutral (±3%)', filter: e => Math.abs(e.lineupSupportAdjustment) < 0.03 },
    { name: 'Mild penalty (-3 to -10%)', filter: e => e.lineupSupportAdjustment > -0.10 && e.lineupSupportAdjustment <= -0.03 },
    { name: 'Strong penalty (≤-10%)', filter: e => e.lineupSupportAdjustment <= -0.10 },
  ];

  const rows = buckets.map(b => {
    const subset = tagged.filter(b.filter);
    const w = subset.filter(e => e.result === 'win').length;
    const l = subset.filter(e => e.result === 'loss').length;
    const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
    return { name: b.name, n: subset.length, w, l, wr };
  });

  // Trend check: more boost should correlate with higher WR
  const boostWR = rows[0].n + rows[1].n > 0
    ? ((rows[0].w + rows[1].w) / (rows[0].w + rows[0].l + rows[1].w + rows[1].l)) * 100
    : 0;
  const penaltyWR = rows[3].n + rows[4].n > 0
    ? ((rows[3].w + rows[4].w) / (rows[3].w + rows[3].l + rows[4].w + rows[4].l)) * 100
    : 0;

  const correlationVerdict = (boostWR - penaltyWR) >= 5 ? '✅ working as intended'
                            : (boostWR - penaltyWR) >= 0 ? '⚠️ weak signal'
                            : '❌ INVERTED — boosts hitting worse than penalties';

  return `## 4. Lineup Support Factor Validation

The factor should correlate positively with WR — picks getting boost should outperform picks getting penalty.

### Adjustment buckets

| Bucket | Record | WR | n |
|---|---|---|---|
${rows.map(r => `| ${r.name} | ${r.w}-${r.l} | ${r.wr.toFixed(0)}% | ${r.n} |`).join('\n')}

| Comparison | Value |
|---|---|
| Boosted picks WR | ${boostWR.toFixed(0)}% |
| Penalized picks WR | ${penaltyWR.toFixed(0)}% |
| **Differential** | **${(boostWR - penaltyWR >= 0 ? '+' : '') + (boostWR - penaltyWR).toFixed(1)} pts** |
| **Verdict** | **${correlationVerdict}** |

${(boostWR - penaltyWR) < 0 ? `
### 🚨 Signal looks inverted
The factor is producing the opposite of expected effect. Most likely causes:
1. The 4 components (slot, offense, obpAhead, obpBehind) are over-weighting opportunity (slot/offense) at the expense of conversion (obpAhead/obpBehind), and we're recommending hitters in good spots who aren't actually finishing the play.
2. The OBP fallback math (xwoba × 0.7) is biasing OBP estimates and producing wrong rankings.
3. The clamp range [0.65, 1.35] is too wide and extreme picks are getting through.

Don't disable the factor immediately — small samples can produce inversions by chance. Re-check after n>=80 tagged picks.
` : ''}
`;
}

// =====================================================
// SECTION 5: HITS-OVER-HRR
// =====================================================
function buildHitsOverHrrValidation(decided) {
  const flipped = decided.filter(e => e.hitsPreferenceApplied === true);
  const allHits = decided.filter(e => e.propKey === 'H');
  const allHrr = decided.filter(e => e.propKey === 'HRR');

  if (flipped.length === 0 && allHits.length === 0) {
    return `## 5. HITS-over-HRR Preference Validation

⚠️ No HITS preference data yet. Either no flips have occurred or data isn't tagged yet.

`;
  }

  const flippedW = flipped.filter(e => e.result === 'win').length;
  const flippedL = flipped.filter(e => e.result === 'loss').length;
  const flippedWR = (flippedW + flippedL > 0) ? (flippedW / (flippedW + flippedL)) * 100 : 0;

  const hitsW = allHits.filter(e => e.result === 'win').length;
  const hitsL = allHits.filter(e => e.result === 'loss').length;
  const hitsWR = (hitsW + hitsL > 0) ? (hitsW / (hitsW + hitsL)) * 100 : 0;

  const hrrW = allHrr.filter(e => e.result === 'win').length;
  const hrrL = allHrr.filter(e => e.result === 'loss').length;
  const hrrWR = (hrrW + hrrL > 0) ? (hrrW / (hrrW + hrrL)) * 100 : 0;

  return `## 5. HITS-over-HRR Preference Validation

Default-prefer HITS when within 10pts of HRR — May 29 audit showed +16 WR pts on same pool.

| Metric | Record | WR | n |
|---|---|---|---|
| All HITS picks | ${hitsW}-${hitsL} | ${hitsWR.toFixed(0)}% | ${allHits.length} |
| All HRR picks | ${hrrW}-${hrrL} | ${hrrWR.toFixed(0)}% | ${allHrr.length} |
| **Flipped (HRR→HITS)** | **${flippedW}-${flippedL}** | **${flippedWR.toFixed(0)}%** | **${flipped.length}** |
| HITS vs HRR gap | | ${(hitsWR - hrrWR >= 0 ? '+' : '') + (hitsWR - hrrWR).toFixed(1)} pts | |

${flipped.length === 0 ? `
### Note: 0 picks have been flipped
This is fine — most picks have a clear best prop and don't trigger the preference. The flip only fires when HRR was selected AND HITS is within 10 prob points. If you see 0 flips after 50+ HRR picks, the preference may not be wiring through; check \`applyHitsOverHrrPreference\` is being called.
` : ''}

${(hitsWR - hrrWR) < 10 && allHits.length >= 15 && allHrr.length >= 30 ? `
### 🟡 HITS vs HRR gap closing
The audit-baseline 16-pt gap is shrinking. If gap drops below 5pts on n>=50, consider relaxing HITS preference or removing it (lineup support may have closed the original gap).
` : ''}
`;
}

// =====================================================
// SECTION 6: FRAGILITY
// =====================================================
function buildFragilityValidation(decided) {
  const tagged = decided.filter(e => e.fragilityLevel);

  if (tagged.length === 0) {
    return `## 6. Fragility Validation

⚠️ No fragility data tagged yet.

`;
  }

  const levels = ['solid', 'minor', 'moderate', 'fragile'];
  const rows = levels.map(lvl => {
    const subset = tagged.filter(e => e.fragilityLevel === lvl);
    const w = subset.filter(e => e.result === 'win').length;
    const l = subset.filter(e => e.result === 'loss').length;
    const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
    return { lvl, n: subset.length, w, l, wr };
  });

  return `## 6. Fragility Validation

Fragility should correlate negatively with WR — solid picks should outperform fragile ones.

| Level | Record | WR | n |
|---|---|---|---|
${rows.map(r => `| ${r.lvl} | ${r.w}-${r.l} | ${r.wr.toFixed(0)}% | ${r.n} |`).join('\n')}

${rows[0].n >= 20 && rows[3].n >= 5 && rows[0].wr < rows[3].wr ? `
### 🚨 Fragility inverted
Solid picks performing WORSE than fragile picks. Possible explanations:
1. The criteria measuring "fragility" are catching picks that have GOOD reasons to be edge-of-cohort.
2. Selection bias: fragile picks already get filtered from PRIME, so the residual is over-selected.

Audit the \`computeFragility\` function — likely the \`reg_near_bottom\` or \`arsenal_pa\` rules are too aggressive.
` : ''}

### Top fragility issues found

${(() => {
  const issueCount = {};
  for (const e of tagged) {
    const issues = e.fragilityIssues || [];
    for (const issue of issues) {
      const key = issue.replace(/_\d.*$/, '');
      issueCount[key] = (issueCount[key] || 0) + 1;
    }
  }
  const sorted = Object.entries(issueCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return sorted.length > 0
    ? sorted.map(([k, n]) => `- ${k}: ${n}`).join('\n')
    : '(none)';
})()}
`;
}

// =====================================================
// SECTION 7: INNING AUDIT — THE BIG ONE
// =====================================================
function buildInningAudit(fi, pa) {
  // Flatten FI bets
  const fiBets = Object.values(fi);
  const fiDecided = fiBets.filter(b => b.result === 'win' || b.result === 'loss');

  // Projection audit — projected vs actual runs
  const paEntries = Object.values(pa).filter(e => e.graded && e.actualHomeRuns != null);

  if (fiDecided.length === 0 && paEntries.length === 0) {
    return `## 7. Inning Audit

⚠️ No inning data available.

`;
  }

  // === 7A: FI by tier ===
  const tiers = ['STRONG', 'MODERATE', 'SLIGHT'];
  const fiByTier = tiers.map(t => {
    const subset = fiDecided.filter(b => b.tier === t);
    const w = subset.filter(b => b.result === 'win').length;
    const l = subset.filter(b => b.result === 'loss').length;
    const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
    return { t, n: subset.length, w, l, wr };
  });

  // === 7B: FI by pick side (YRFI vs NRFI) ===
  const yrfi = fiDecided.filter(b => b.pick === 'YRFI');
  const nrfi = fiDecided.filter(b => b.pick === 'NRFI');
  const yrfiW = yrfi.filter(b => b.result === 'win').length;
  const nrfiW = nrfi.filter(b => b.result === 'win').length;
  const yrfiWR = yrfi.length > 0 ? (yrfiW / yrfi.length) * 100 : 0;
  const nrfiWR = nrfi.length > 0 ? (nrfiW / nrfi.length) * 100 : 0;

  // === 7C: Probability calibration ===
  // Buckets in 0.05 increments
  const calibBuckets = [
    [0.45, 0.50], [0.50, 0.55], [0.55, 0.60],
    [0.60, 0.65], [0.65, 0.70], [0.70, 0.80], [0.80, 1.0]
  ];
  const calibRows = calibBuckets.map(([lo, hi]) => {
    const bucket = fiDecided.filter(b => b.probability >= lo && b.probability < hi);
    const w = bucket.filter(b => b.result === 'win').length;
    const expected = (lo + hi) / 2 * 100;
    const actual = bucket.length > 0 ? (w / bucket.length) * 100 : 0;
    const miss = actual - expected;
    return { lo, hi, expected, actual, n: bucket.length, miss };
  });

  // === 7D: Failure mode decomposition ===
  // Categorize each loss
  const losses = fiDecided.filter(b => b.result === 'loss');
  const yrfiLosses = losses.filter(b => b.pick === 'YRFI');
  const nrfiLosses = losses.filter(b => b.pick === 'NRFI');

  // YRFI losses: bet a run would score, none did
  // Categorize by total runs in 1st (0 means full shutout; 1+ means error in our team-allocation)
  let yrfiTrueShutout = 0;  // 0-0
  let yrfiBlankInning = 0;  // No first-inning runs at all
  for (const b of yrfiLosses) {
    const total = (b.awayRunsInn1 || 0) + (b.homeRunsInn1 || 0);
    if (total === 0) yrfiTrueShutout++;
  }
  yrfiBlankInning = yrfiTrueShutout;

  // NRFI losses: bet no runs, runs scored
  // Categorize by which team scored and how many
  let nrfiHomeScored = 0;
  let nrfiAwayScored = 0;
  let nrfiBothScored = 0;
  let nrfiBlowoutFirst = 0;  // 3+ first-inning runs
  for (const b of nrfiLosses) {
    const ar = b.awayRunsInn1 || 0;
    const hr = b.homeRunsInn1 || 0;
    if (ar > 0 && hr > 0) nrfiBothScored++;
    else if (ar > 0) nrfiAwayScored++;
    else if (hr > 0) nrfiHomeScored++;
    if ((ar + hr) >= 3) nrfiBlowoutFirst++;
  }

  // === 7E: Game projection audit ===
  // Did the team that scored first match the team we expected to score first?
  let projTotalErrorSum = 0;
  let projTotalAbsErrorSum = 0;
  let projUnderActual = 0;
  let projOverActual = 0;
  const projErrors = [];
  for (const e of paEntries) {
    const projTotal = e.projTotal;
    const actualTotal = e.actualTotal;
    if (projTotal == null || actualTotal == null) continue;
    const err = actualTotal - projTotal;
    projErrors.push({ err, gamePk: e.gamePk });
    projTotalErrorSum += err;
    projTotalAbsErrorSum += Math.abs(err);
    if (err > 0) projOverActual++;  // actual > projected = we under-projected
    else if (err < 0) projUnderActual++;
  }
  const meanErr = projErrors.length > 0 ? projTotalErrorSum / projErrors.length : 0;
  const meanAbsErr = projErrors.length > 0 ? projTotalAbsErrorSum / projErrors.length : 0;

  // === 7F: Per-team scoring projection accuracy ===
  let awayProjError = 0, homeProjError = 0;
  let awayProjAbsError = 0, homeProjAbsError = 0;
  let awayCount = 0, homeCount = 0;
  for (const e of paEntries) {
    if (e.projAwayRuns != null && e.actualAwayRuns != null) {
      const err = e.actualAwayRuns - e.projAwayRuns;
      awayProjError += err;
      awayProjAbsError += Math.abs(err);
      awayCount++;
    }
    if (e.projHomeRuns != null && e.actualHomeRuns != null) {
      const err = e.actualHomeRuns - e.projHomeRuns;
      homeProjError += err;
      homeProjAbsError += Math.abs(err);
      homeCount++;
    }
  }
  const awayMeanErr = awayCount > 0 ? awayProjError / awayCount : 0;
  const homeMeanErr = homeCount > 0 ? homeProjError / homeCount : 0;
  const awayAbsErr = awayCount > 0 ? awayProjAbsError / awayCount : 0;
  const homeAbsErr = homeCount > 0 ? homeProjAbsError / homeCount : 0;

  // === 7G: Winner accuracy ===
  let projWinnerCorrect = 0;
  let projWinnerTotal = 0;
  for (const e of paEntries) {
    if (!e.projWinner || !e.winner) continue;
    projWinnerTotal++;
    if (e.projWinner === e.winner) projWinnerCorrect++;
  }
  const winnerAcc = projWinnerTotal > 0 ? (projWinnerCorrect / projWinnerTotal) * 100 : 0;

  return `## 7. Inning Audit — How Are FI/NRFI Bets Actually Failing?

This is the section you specifically asked for. Innings get failure-mode decomposition, not just hit-rate.

### 7A. First Inning bets by tier (overall record)

| Tier | Record | WR | n | Verdict |
|---|---|---|---|---|
${fiByTier.map(r => {
  let v = '';
  if (r.n < 10) v = '(small sample)';
  else if (r.wr >= 60) v = '✅';
  else if (r.wr >= 50) v = '⚠️';
  else v = '❌';
  return `| ${r.t} | ${r.w}-${r.l} | ${r.wr.toFixed(0)}% | ${r.n} | ${v} |`;
}).join('\n')}

**Total FI:** ${fiDecided.filter(b => b.result === 'win').length}-${fiDecided.filter(b => b.result === 'loss').length} (${fiDecided.length > 0 ? (fiDecided.filter(b => b.result === 'win').length / fiDecided.length * 100).toFixed(0) : 0}%) on n=${fiDecided.length}

### 7B. YRFI vs NRFI side bias

| Side | Record | WR | n |
|---|---|---|---|
| YRFI | ${yrfiW}-${yrfi.length - yrfiW} | ${yrfiWR.toFixed(0)}% | ${yrfi.length} |
| NRFI | ${nrfiW}-${nrfi.length - nrfiW} | ${nrfiWR.toFixed(0)}% | ${nrfi.length} |
| **Gap** | | **${(yrfiWR - nrfiWR >= 0 ? '+' : '') + (yrfiWR - nrfiWR).toFixed(1)} pts** | |

${Math.abs(yrfiWR - nrfiWR) >= 10 && Math.min(yrfi.length, nrfi.length) >= 15 ? `
### 🚨 Side bias detected
One side is materially outperforming the other. Possible causes:
- Model's baseline P(YRFI) anchor (currently 0.57) may be miscalibrated for current MLB run environment
- One of the multipliers (top-of-order, arsenal vulnerability) may be over-fitted to one direction
- Park factor application may be asymmetric

Quick fix: in \`firstInning.js\` line ~14, check \`LEAGUE_YRFI = 0.57\`. If MLB-wide YRFI rate has shifted since calibration, this should be updated.
` : ''}

### 7C. Probability calibration — the credibility test

If our 0.65 displays should hit 65%, here's the actual gap. **Pre-Phase-1 calibration showed up to -32 pt miss** (0.75 hit at 43%). Post-Phase-1 should be much tighter.

| Bucket | Displayed | Actual | Miss | n |
|---|---|---|---|---|
${calibRows.map(r => {
  let flag = '';
  if (r.n < 5) flag = ' (small)';
  else if (Math.abs(r.miss) >= 15) flag = ' 🚨';
  else if (Math.abs(r.miss) >= 8) flag = ' ⚠️';
  else flag = ' ✅';
  return `| ${r.lo.toFixed(2)}-${r.hi.toFixed(2)} | ${r.expected.toFixed(0)}% | ${r.actual.toFixed(0)}% | ${r.miss >= 0 ? '+' : ''}${r.miss.toFixed(1)} pts | ${r.n}${flag} |`;
}).join('\n')}

${calibRows.some(r => r.n >= 10 && r.miss < -10) ? `
### 🚨 Calibration still off
At least one well-populated bucket is missing by >10 pts. The Phase 1 calibration table in \`firstInning.js\` may need updating with this slice of data. Re-fit \`FI_CALIBRATION_POINTS\` from these numbers.
` : ''}

### 7D. Failure mode decomposition — WHY do FI bets lose?

**YRFI losses (we bet a run, no run happened):**
- Total YRFI losses: ${yrfiLosses.length}
- True shutouts (0-0 in 1st): ${yrfiTrueShutout} (${yrfiLosses.length > 0 ? (yrfiTrueShutout / yrfiLosses.length * 100).toFixed(0) : 0}%)

When YRFI loses, it's almost always a true 0-0 first inning. That means the failure isn't an allocation error (right total, wrong team) — it's a forecast miss. The model thought there was scoring volatility there and there wasn't.

**NRFI losses (we bet no runs, runs scored):**
- Total NRFI losses: ${nrfiLosses.length}
- Away team scored only: ${nrfiAwayScored} (${nrfiLosses.length > 0 ? (nrfiAwayScored / nrfiLosses.length * 100).toFixed(0) : 0}%)
- Home team scored only: ${nrfiHomeScored} (${nrfiLosses.length > 0 ? (nrfiHomeScored / nrfiLosses.length * 100).toFixed(0) : 0}%)
- Both teams scored: ${nrfiBothScored} (${nrfiLosses.length > 0 ? (nrfiBothScored / nrfiLosses.length * 100).toFixed(0) : 0}%)
- Big inning (3+ runs in 1st): ${nrfiBlowoutFirst} (${nrfiLosses.length > 0 ? (nrfiBlowoutFirst / nrfiLosses.length * 100).toFixed(0) : 0}%)

${nrfiBlowoutFirst >= nrfiLosses.length * 0.4 ? `
### 🚨 NRFI losses are predominantly big innings
${(nrfiBlowoutFirst / Math.max(1, nrfiLosses.length) * 100).toFixed(0)}% of NRFI losses involved 3+ runs in the 1st. This means the model isn't catching games where the pitcher matchup is structurally vulnerable to crooked numbers. The fix is on the pitcher side, not the lineup side.

Look at \`pitcherInningSplits\` data for 1st-inning xwOBA-against — is the model's "1st inning meltdown" detection actually being applied to NRFI predictions? It's documented as a hitter-side signal but the symmetric pitcher-side application may not be wired.
` : ''}

${nrfiAwayScored > nrfiHomeScored * 1.5 ? `
### 🟡 NRFI losses skewed to away team scoring
${(nrfiAwayScored / Math.max(1, nrfiLosses.length) * 100).toFixed(0)}% of NRFI losses were away team only. The home pitcher (who throws to the away lineup first) is the more common point of failure. Check whether home SP analysis is symmetric with away SP analysis.
` : ''}

### 7E. Game total projection accuracy

The FI/NRFI prediction is downstream of full-game projection. If projections systematically miss, FI does too.

| Metric | Value | Verdict |
|---|---|---|
| Games audited | ${projErrors.length} | |
| **Mean error (actual - proj)** | **${meanErr >= 0 ? '+' : ''}${meanErr.toFixed(2)} runs** | ${Math.abs(meanErr) < 0.3 ? '✅' : Math.abs(meanErr) < 0.6 ? '⚠️' : '❌'} |
| Mean absolute error | ${meanAbsErr.toFixed(2)} runs | ${meanAbsErr < 2.5 ? '✅' : meanAbsErr < 3.5 ? '⚠️' : '❌'} |
| Games we under-projected (low) | ${projOverActual} (${projErrors.length > 0 ? (projOverActual / projErrors.length * 100).toFixed(0) : 0}%) | |
| Games we over-projected (high) | ${projUnderActual} (${projErrors.length > 0 ? (projUnderActual / projErrors.length * 100).toFixed(0) : 0}%) | |

${meanErr > 0.5 ? `
### 🚨 Systematic UNDER-projection
Actual run totals exceed projections by ${meanErr.toFixed(2)} runs on average. The model is too conservative on scoring. This directly hurts YRFI calls (model thinks low-scoring 1st is more likely than it really is) and inflates NRFI confidence (which then loses).

Likely candidates:
- Pitcher xwOBA baseline anchored to outdated MLB scoring environment
- Bullpen quality estimate is too high
- Park factors compressed too much
` : meanErr < -0.5 ? `
### 🚨 Systematic OVER-projection
Projections exceed actual run totals by ${(-meanErr).toFixed(2)} runs on average. Hurts NRFI (model thinks scoring is more likely than it really is) and inflates YRFI confidence.
` : ''}

### 7F. Per-team scoring projection bias

| Side | Mean error (actual-proj) | Mean abs error |
|---|---|---|
| Away projection | ${awayMeanErr >= 0 ? '+' : ''}${awayMeanErr.toFixed(2)} | ${awayAbsErr.toFixed(2)} |
| Home projection | ${homeMeanErr >= 0 ? '+' : ''}${homeMeanErr.toFixed(2)} | ${homeAbsErr.toFixed(2)} |
| Asymmetry | ${(awayMeanErr - homeMeanErr >= 0 ? '+' : '') + (awayMeanErr - homeMeanErr).toFixed(2)} | |

${Math.abs(awayMeanErr - homeMeanErr) >= 0.4 ? `
### 🚨 Home/away projection asymmetry
The model is biased between teams. This compounds in FI: when the home and away projections drift in opposite directions, the FI YRFI/NRFI logic compounds the error. Likely the home-field-advantage constant or the pitcher home/road split application is misaligned.
` : ''}

### 7G. Game winner accuracy

| Metric | Value |
|---|---|
| Winner correct | ${projWinnerCorrect}/${projWinnerTotal} (${winnerAcc.toFixed(0)}%) |
| Baseline (favorite-only, ~57% MLB) | ${winnerAcc > 57 ? '✅' : winnerAcc > 52 ? '⚠️' : '❌'} |

${winnerAcc < 55 ? `
The model is barely above coin-flip on winner prediction. This is a fundamental signal-strength issue. If winners are this hard to predict, FI is harder still (it's a less-predictable derivative). FI confidence should be capped accordingly — currently the FI engine displays 0.70+ probabilities which is implausible given winner accuracy.
` : ''}

### 7H. Key actionables for innings

${(() => {
  const actions = [];
  if (yrfiTrueShutout / Math.max(1, yrfiLosses.length) > 0.85) {
    actions.push('YRFI losses are dominated by true 0-0 first innings — model is over-predicting first-inning scoring volatility');
  }
  if (nrfiBlowoutFirst / Math.max(1, nrfiLosses.length) > 0.4) {
    actions.push('NRFI losses include too many big innings — pitcher 1st-inning meltdown detection needs strengthening');
  }
  if (Math.abs(meanErr) > 0.5) {
    actions.push(`Game total projections are systematically biased by ${meanErr.toFixed(2)} runs — recalibrate baseline run environment`);
  }
  if (Math.abs(awayMeanErr - homeMeanErr) >= 0.4) {
    actions.push('Home/away projection asymmetry detected — check home-field-advantage constant');
  }
  if (Math.abs(yrfiWR - nrfiWR) >= 10 && Math.min(yrfi.length, nrfi.length) >= 15) {
    actions.push('YRFI/NRFI side bias detected — recheck LEAGUE_YRFI baseline');
  }
  if (calibRows.some(r => r.n >= 10 && r.miss < -10)) {
    actions.push('FI probability calibration table needs re-fitting — buckets still missing badly');
  }
  if (actions.length === 0) actions.push('No critical inning-side issues detected. Innings are tracking within expected variance.');
  return actions.map((a, i) => `${i + 1}. ${a}`).join('\n');
})()}
`;
}

// =====================================================
// SECTION 8: SIGNAL CORRELATIONS
// =====================================================
function buildSignalCorrelations(decided) {
  const lines = [];

  // adjustedMaxXwoba buckets
  const xwBuckets = [
    [0.0, 0.50], [0.50, 0.60], [0.60, 0.70], [0.70, 0.80], [0.80, 0.90], [0.90, 99]
  ];
  const xwRows = xwBuckets.map(([lo, hi]) => {
    const bucket = decided.filter(e => {
      const xw = parseFloat(e.adjustedMaxXwoba);
      return Number.isFinite(xw) && xw >= lo && xw < hi;
    });
    const w = bucket.filter(e => e.result === 'win').length;
    const l = bucket.filter(e => e.result === 'loss').length;
    const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
    return `| ${lo.toFixed(2)}-${hi.toFixed(2)} | ${w}-${l} | ${wr.toFixed(0)}% | ${bucket.length} |`;
  });

  // regressedMaxXwoba buckets
  const regBuckets = [
    [0.40, 0.45], [0.45, 0.50], [0.50, 0.55], [0.55, 0.60], [0.60, 0.65], [0.65, 99]
  ];
  const regRows = regBuckets.map(([lo, hi]) => {
    const bucket = decided.filter(e => {
      const reg = parseFloat(e.regressedMaxXwoba);
      return Number.isFinite(reg) && reg >= lo && reg < hi;
    });
    const w = bucket.filter(e => e.result === 'win').length;
    const l = bucket.filter(e => e.result === 'loss').length;
    const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
    return `| ${lo.toFixed(2)}-${hi.toFixed(2)} | ${w}-${l} | ${wr.toFixed(0)}% | ${bucket.length} |`;
  });

  // contextMultiplier buckets
  const ctxBuckets = [
    [0, 0.95], [0.95, 1.05], [1.05, 1.15], [1.15, 1.25], [1.25, 99]
  ];
  const ctxRows = ctxBuckets.map(([lo, hi]) => {
    const bucket = decided.filter(e => {
      const ctx = parseFloat(e.contextMultiplier);
      return Number.isFinite(ctx) && ctx >= lo && ctx < hi;
    });
    const w = bucket.filter(e => e.result === 'win').length;
    const l = bucket.filter(e => e.result === 'loss').length;
    const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
    return `| ${lo.toFixed(2)}-${hi.toFixed(2)} | ${w}-${l} | ${wr.toFixed(0)}% | ${bucket.length} |`;
  });

  // Handedness matrix
  const handCombos = [['L','R'],['R','L'],['R','R'],['L','L'],['S','R'],['S','L']];
  const handRows = handCombos.map(([h, p]) => {
    const bucket = decided.filter(e => e.hand === h && e.pitcherHand === p);
    const w = bucket.filter(e => e.result === 'win').length;
    const l = bucket.filter(e => e.result === 'loss').length;
    const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
    return { combo: `${h} vs ${p}`, w, l, wr, n: bucket.length };
  }).sort((a, b) => b.n - a.n);

  return `## 8. Signal-by-Signal Correlation

### Adjusted xwoba buckets

| Bucket | Record | WR | n |
|---|---|---|---|
${xwRows.join('\n')}

### Regressed xwoba buckets (the validated predictor)

| Bucket | Record | WR | n |
|---|---|---|---|
${regRows.join('\n')}

### Context multiplier buckets

| Bucket | Record | WR | n |
|---|---|---|---|
${ctxRows.join('\n')}

### Handedness matchup (the L vs R bleed)

| Combo | Record | WR | n |
|---|---|---|---|
${handRows.map(r => `| ${r.combo} | ${r.w}-${r.l} | ${r.wr.toFixed(0)}% | ${r.n} |`).join('\n')}

${(() => {
  const lvr = handRows.find(r => r.combo === 'L vs R');
  if (lvr && lvr.n >= 30 && lvr.wr < 45) {
    return `### 🚨 L vs R still bleeding
${lvr.n} picks at ${lvr.wr.toFixed(0)}% WR. This is the largest single drag identified in the May 29 audit and has NOT been addressed yet. Recommended Phase 2.5 work: audit platoon adjustment math.`;
  }
  return '';
})()}
`;
}

// =====================================================
// FOOTER
// =====================================================
function buildFooter(decided, all) {
  return `---

## Validation summary

| Phase | Status | Sample | Next gate |
|---|---|---|---|
| Phase 1 — Fade override | ${decided.filter(e => e.fadeTier === 'high_fade').length === 0 ? '✅ working' : '🚨 broken'} | n=${decided.filter(e => e.fadeTier).length} | continued zero high_fade |
| Phase 1 — FI calibration | check Section 7C | n=${Object.keys({}).length} | <5pt avg miss |
| Phase 2 — PRIME tier | ${(() => {
  const p = decided.filter(e => e.isPrime);
  const w = p.filter(e => e.result === 'win').length;
  const l = p.filter(e => e.result === 'loss').length;
  const wr = (w + l > 0) ? (w / (w + l)) * 100 : 0;
  return p.length < 15 ? '🟡 sample too small' : wr >= 60 ? '✅ holding' : '⚠️ below target';
})()} | n=${decided.filter(e => e.isPrime).length} | ≥60% on n≥30 |
| Phase 2 — Lineup support | check Section 4 | n=${decided.filter(e => e.lineupSupportFactor != null).length} | positive WR differential |
| Phase 2 — HITS preference | check Section 5 | n=${decided.filter(e => e.hitsPreferenceApplied).length} | flips outperform HRR baseline |

## How to use this report

Run after every 1-2 slates while validating Phase 1+2. Once PRIME hits ≥60% on n≥30 AND bulk WR holds ≥52.4% on n≥100 sustained over 2 weeks, you're ad-ready.

If any section shows 🚨, that's the next thing to fix. If everything is ✅, ship Phase 3.

## Marketing-claim gates

| Claim | Required |
|---|---|
| "PRIME picks hit 60%+" | n≥100 PRIME, WR≥60% |
| "Beats prop break-even" | n≥200 bulk, WR≥52.4% |
| "Calibrated probabilities" | FI calibration <5pt miss across all buckets |
| "Refuses bad picks" | 0 HIGH_FADE in best-bet log (this is the Phase 1 fix) |

---

*Generated by \`tools/validation-report.js\`. Re-run after each backup export.*
`;
}

// =====================================================
// HELPERS
// =====================================================
function dateRange(entries) {
  const dates = entries.map(e => e._date).filter(Boolean).sort();
  if (dates.length === 0) return 'unknown';
  return `${dates[0]} to ${dates[dates.length - 1]}`;
}

function groupBy(arr, fn) {
  const out = {};
  for (const item of arr) {
    const k = fn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

// =====================================================
// RUN
// =====================================================
main();
