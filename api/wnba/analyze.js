// api/wnba/analyze.js
//
// WNBA prop analysis endpoint with audit-entry generation.
//
// FEATURE FLAGS:
//   WNBA_ENABLED            (default true)  master switch — when false, returns 503
//   WNBA_AUDIT_ENABLED      (default true)  include audit entry in response
//   WNBA_SHADOW_MODE        (default true)  flag responses as shadow mode (no real bets)
//
// SHADOW MODE EXPLANATION:
//   Mirroring the MLB Lyrid pattern: ship behind a flag, observe behavior for
//   weeks before flipping to "live recommended" mode. Shadow mode adds a marker
//   to every response so the UI can show "(beta / not yet validated)" and we
//   don't accidentally treat unvalidated recommendations as production-grade.

import { analyzeBasketballProp } from "../_lib/basketball/basketballProps.js";
import { buildAuditEntry } from "../_lib/basketball/basketballAudit.js";
// Session 2 — data layer modules. When WNBA_DATA_LAYER_ENABLED=true,
// requests can include `lookup: { playerName, opponent }` instead of full
// manual JSON, and the engine will pull real data from stats.wnba.com.
import { findPlayerByName } from "../_lib/wnba/wnbaPlayerData.js";
import { aggregateRecentForm } from "../_lib/wnba/wnbaGameLog.js";
import { getTeamStats } from "../_lib/wnba/wnbaTeamData.js";

// Feature flags
const WNBA_ENABLED = (() => {
  const v = process.env.WNBA_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;  // default on — scaffold is sound enough for manual JSON testing
})();
const WNBA_AUDIT_ENABLED = (() => {
  const v = process.env.WNBA_AUDIT_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;  // default on — audit entries are foundation for validation
})();
const WNBA_SHADOW_MODE = (() => {
  const v = process.env.WNBA_SHADOW_MODE;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;  // default on — engine has not been calibrated against real outcomes
})();
// SESSION 2: data layer flag. When true, the endpoint can take a player
// lookup hint and fetch real stats. When false (initial deploy default),
// only manual JSON input is accepted — matches Session 1 behavior exactly.
//
// We keep this gated because the data layer hits stats.wnba.com which:
//   1. Adds latency (2-5 seconds per request)
//   2. May be rate-limited (no documented limits but datacenter IPs can get blocked)
//   3. Has no recent validation — Session 3 will verify end-to-end on a real game
//
// Setting to TRUE for initial deploy because the feature is opt-in via request
// payload — if a caller doesn't include `lookup`, behavior is identical to S1.
const WNBA_DATA_LAYER_ENABLED = (() => {
  const v = process.env.WNBA_DATA_LAYER_ENABLED;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;  // default on — opt-in via request payload
})();

// Vercel Node.js serverless functions don't have req.json() — that's the
// Web/Edge Functions API. For Node functions, req is an IncomingMessage
// and Vercel automatically parses JSON bodies when Content-Type matches.
//
// Fixed May 17, 2026 — original used req.json() which crashed on POST with
// "string did not match the expected pattern" (Vercel platform error, not
// network failure). See slate.js for full bug history.
async function readBody(req) {
  if (req.method !== "POST") return {};
  // Case 1: Vercel pre-parsed the body
  if (req.body && typeof req.body === 'object') return req.body;
  // Case 2: Vercel left it as a string
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Case 3: Manual stream read (defensive fallback)
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function queryInput(req) {
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams;
  if (![...q.keys()].length) return null;

  return {
    player: {
      name: q.get("player") ?? q.get("name") ?? "Unknown Player",
      team: q.get("team"),
      position: q.get("position"),
      seasonAvg: Number(q.get("seasonAvg") ?? q.get("avg")),
      last5Avg: Number(q.get("last5")),
      last10Avg: Number(q.get("last10")),
      minutesAvg: Number(q.get("minutes")),
      expectedMinutes: Number(q.get("expectedMinutes")),
      usageRate: Number(q.get("usage")),
      seasonUsage: Number(q.get("seasonUsage")),
      touches: Number(q.get("touches")),
      starter: q.get("starter") === "true",
      closingRole: q.get("closingRole") === "true",
      injuryTag: q.get("status")
    },
    market: q.get("market") ?? "points",
    line: Number(q.get("line")),
    team: {
      abbr: q.get("team"),
      pace: Number(q.get("teamPace")),
      impliedTotal: Number(q.get("teamTotal"))
    },
    opponent: {
      abbr: q.get("opponent"),
      pace: Number(q.get("oppPace")),
      defRating: Number(q.get("defRating")),
      rimProtection: Number(q.get("rimProtection")),
      reboundAllowed: Number(q.get("reboundAllowed")),
      assistAllowed: Number(q.get("assistAllowed")),
      threeAllowed: Number(q.get("threeAllowed")),
      foulRate: Number(q.get("foulRate"))
    },
    game: {
      spread: Number(q.get("spread")),
      total: Number(q.get("total")),
      home: q.get("home") === "true",
      restDays: Number(q.get("restDays")),
      backToBack: q.get("backToBack") === "true"
    }
  };
}

function examplePayload() {
  return {
    message: "WNBA basketball analysis endpoint is live. Send POST JSON or query params.",
    shadowMode: WNBA_SHADOW_MODE,
    note: WNBA_SHADOW_MODE
      ? "Engine is in SHADOW MODE — recommendations are scaffold-level, NOT validated against historical outcomes yet."
      : "Engine is in live recommendation mode.",
    example: {
      player: {
        name: "A'ja Wilson",
        team: "LVA",
        position: "F",
        seasonAvg: 24.1,
        last5Avg: 26.4,
        last10Avg: 25.5,
        minutesAvg: 33.5,
        expectedMinutes: 34.0,
        usageRate: 31.2,
        seasonUsage: 31.2,
        touches: 64,
        starter: true,
        closingRole: true,
        primaryCreator: true
      },
      market: "points",
      line: 24.5,
      team: { pace: 81.5, impliedTotal: 87.5 },
      opponent: { abbr: "NYL", pace: 79.2, defRating: 101.4, rimProtection: 48, foulRate: 18.8 },
      game: { spread: -3.5, total: 166.5, home: true, restDays: 1, backToBack: false }
    }
  };
}

export default async function handler(req, res) {
  const league = "WNBA";

  if (!WNBA_ENABLED) {
    return res.status(503).json({
      ok: false,
      error: "WNBA analysis endpoint is currently disabled (WNBA_ENABLED=false)"
    });
  }

  try {
    const body = await readBody(req);
    let input = Object.keys(body ?? {}).length ? body : queryInput(req);

    if (!input) {
      return res.status(200).json(examplePayload());
    }

    // SESSION 2: data layer lookup path.
    // If request includes `lookup: { playerName, opponent, season? }`, fetch
    // real data from stats.wnba.com and merge with any explicit overrides.
    // Caller-provided fields always win over fetched data — allows manual
    // overrides for last-minute injury news, etc.
    let dataLayerUsed = false;
    let dataLayerWarnings = [];
    if (WNBA_DATA_LAYER_ENABLED && input.lookup?.playerName) {
      try {
        const merged = await mergeWithDataLayer(input);
        if (merged.warnings.length) dataLayerWarnings = merged.warnings;
        input = merged.input;
        dataLayerUsed = true;
      } catch (lookupErr) {
        // If data layer fails, proceed with manually-supplied data.
        // Don't fail the whole request — caller may have provided enough.
        dataLayerWarnings.push(`Data layer lookup failed: ${lookupErr.message}`);
      }
    }

    const analysis = analyzeBasketballProp(input, league);

    // Build audit entry if enabled
    let auditEntry = null;
    if (WNBA_AUDIT_ENABLED && !analysis.error) {
      auditEntry = buildAuditEntry(input, analysis, {
        gameDate: input?.game?.date || new Date().toISOString().split('T')[0],
        league: 'WNBA',
        source: dataLayerUsed ? 'data_layer' : (req.method === 'POST' ? 'manual_post' : 'manual_query')
      });
    }

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      shadowMode: WNBA_SHADOW_MODE,
      dataLayerUsed,
      dataLayerWarnings: dataLayerWarnings.length ? dataLayerWarnings : undefined,
      ...analysis,
      auditEntry
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message ?? "Unknown basketball analysis error"
    });
  }
}

// =============================================================
// DATA LAYER LOOKUP
// =============================================================

/**
 * Given an input with `lookup: { playerName, opponent, season }`, fetch
 * real WNBA stats and merge into the input. Caller-supplied fields are
 * preserved (manual override wins).
 *
 * Returns: { input: <merged>, warnings: [<any issues encountered>] }
 */
async function mergeWithDataLayer(input) {
  const lookup = input.lookup || {};
  const season = Number(lookup.season) || new Date().getFullYear();
  const market = input.market || 'points';
  const warnings = [];

  // Fetch player season stats + recent form + opponent team stats in parallel.
  // All have independent failure modes — if one fails, others may still succeed.
  const [playerStats, opponentTeam] = await Promise.all([
    findPlayerByName(lookup.playerName, season, market).catch(err => {
      warnings.push(`Player lookup "${lookup.playerName}" failed: ${err.message}`);
      return null;
    }),
    lookup.opponent
      ? getTeamStats(lookup.opponent, season).catch(err => {
          warnings.push(`Opponent "${lookup.opponent}" lookup failed: ${err.message}`);
          return null;
        })
      : Promise.resolve(null)
  ]);

  if (!playerStats) {
    warnings.push(`Could not find player "${lookup.playerName}" — proceeding with manual input only`);
    return { input, warnings };
  }

  // Now fetch recent form using the resolved player ID
  const recentForm = await aggregateRecentForm(playerStats.id, 10, market, season).catch(err => {
    warnings.push(`Recent form fetch failed: ${err.message}`);
    return null;
  });

  // Merge: data-layer-fetched values fill any missing fields in input.
  // Caller-supplied values always win.
  const mergedPlayer = {
    ...playerStats,
    ...(recentForm ? {
      last5Avg: recentForm.last5Avg,
      last10Avg: recentForm.last10Avg,
      minutesLast5: recentForm.minutesLast5,
      minutesCv: recentForm.minutesCv,
      expectedMinutes: recentForm.minutesAvg
    } : {}),
    ...(input.player || {})  // caller overrides win
  };

  const mergedOpponent = opponentTeam
    ? { ...opponentTeam, ...(input.opponent || {}) }
    : input.opponent;

  // Also fetch caller's own team stats if requested
  let mergedTeam = input.team;
  if (lookup.team) {
    const teamStats = await getTeamStats(lookup.team, season).catch(() => null);
    if (teamStats) {
      mergedTeam = { ...teamStats, ...(input.team || {}) };
    }
  }

  return {
    input: {
      ...input,
      player: mergedPlayer,
      opponent: mergedOpponent,
      team: mergedTeam || input.team
    },
    warnings
  };
}
