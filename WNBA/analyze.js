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

async function readBody(req) {
  if (req.method !== "POST") return {};
  try {
    return await req.json();
  } catch {
    return {};
  }
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
    const input = Object.keys(body ?? {}).length ? body : queryInput(req);

    if (!input) {
      return res.status(200).json(examplePayload());
    }

    const analysis = analyzeBasketballProp(input, league);

    // Build audit entry if enabled
    let auditEntry = null;
    if (WNBA_AUDIT_ENABLED && !analysis.error) {
      auditEntry = buildAuditEntry(input, analysis, {
        gameDate: input?.game?.date || new Date().toISOString().split('T')[0],
        league: 'WNBA',
        source: req.method === 'POST' ? 'manual_post' : 'manual_query'
      });
    }

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      shadowMode: WNBA_SHADOW_MODE,
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
