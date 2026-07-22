// api/nfl/slate.js
// Lyrid NFL slate endpoint — Vercel serverless (Node 20 ESM).
// GET /api/nfl/slate?date=YYYY-MM-DD
//
// Pulls LIVE PrizePicks NFL lines (league_id=9) and runs Lyrid analysis on them.
// Returns { source, date, picks: [{ player, player_key, propLabel, verdict, outlook? }] }.
//
// TWO MODES (degrades honestly):
//   * FULL   — if the player's feature/baseline data is available (Supabase
//              nfl_feature_vectors / comp pool), runs the comp engine + classifier
//              for a real tier verdict.
//   * LINES  — if baseline data isn't loaded yet, still returns the PP games/lines
//              with a 'baseline pending' verdict (no fake tier). This is what makes
//              Sept 9 games appear before the nflverse ingest is run.
//
// PrizePicks endpoint is unofficial/undocumented and may rate-limit a serverless
// IP. On any fetch failure we return source:'unavailable' with an empty slate so
// the UI shows its honest empty state and the manual tracker remains the fallback.

import { parsePrizePicks, normalizeLines } from '../../lib/nfl/nflLineAdapters.js';
import { classifyProp } from '../../lib/nfl/nflClassify.js';
import { compProject } from '../../lib/nfl/nflCompEngine.js';

const PP_URL = 'https://partner-api.prizepicks.com/projections?league_id=9&per_page=1000';
const PROP_LABEL = {
  passing_yards: 'Passing Yards',
  rushing_yards: 'Rushing Yards',
  receiving_yards: 'Receiving Yards',
  rush_rec_yards: 'Rush + Rec Yards',
  pass_rush_yards: 'Pass + Rush Yards',
};

// A "baseline pending" verdict — honest placeholder when feature data isn't loaded.
// Shows the line, no tier, filters unknown. Never fabricates an edge.
function pendingVerdict(line, pick) {
  return {
    pick: pick || 'higher',
    line,
    tier_candidate: 'none',
    filters: { softLine: false, volumeSecure: false, scriptClear: false },
    pOver: null,
    pOverAdjusted: null,
    edge: null,
    reasons: [],
    blocked: ['baseline pending — run the nflverse ingest to enable analysis'],
    provisional: true,
  };
}

export default async function handler(req, res) {
  const date = (req.query && req.query.date) || new Date().toISOString().slice(0, 10);
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  // 1) fetch PrizePicks NFL projections (best-effort)
  let ppJson = null;
  try {
    const r = await fetch(PP_URL, {
      headers: {
        'Accept': 'application/json',
        // a browser-ish UA reduces the chance of an instant block; still unofficial
        'User-Agent': 'Mozilla/5.0 (Lyrid analytics)',
      },
    });
    if (r.ok) ppJson = await r.json();
  } catch (_) { /* fall through to unavailable */ }

  if (!ppJson) {
    return res.status(200).json({
      source: 'unavailable',
      date,
      picks: [],
      note: 'PrizePicks lines could not be fetched (rate-limited or offline). Use the manual tracker, or retry.',
    });
  }

  // 2) normalize to yardage lines, filter to the requested date
  let lines = normalizeLines(parsePrizePicks(ppJson));
  if (date) lines = lines.filter(l => !l.game_date || l.game_date === date);

  if (!lines.length) {
    return res.status(200).json({
      source: 'prizepicks',
      date,
      picks: [],
      note: 'No PrizePicks yardage lines for this date yet.',
    });
  }

  // 3) try to load baseline/feature data for these players (FULL mode).
  //    If unavailable, we stay in LINES mode. Kept optional so the tab works
  //    before the ingest is run.
  let baselineReady = false;
  let compPoolByPos = null;
  let featureByPlayer = null;
  try {
    const mod = await loadBaselines(lines); // Supabase-backed; returns null if not configured
    if (mod && mod.ready) {
      baselineReady = true;
      compPoolByPos = mod.compPoolByPos;
      featureByPlayer = mod.featureByPlayer;
    }
  } catch (_) { /* stay in LINES mode */ }

  // 4) build picks
  const picks = lines.map(l => {
    const propLabel = PROP_LABEL[l.prop_type] || l.raw_stat || l.prop_type;
    const base = {
      player: l.player_name,
      player_key: l.player_key || l.player_name,
      propLabel,
    };

    if (!baselineReady) {
      return { ...base, verdict: pendingVerdict(l.line, 'higher') };
    }

    // FULL mode: comp projection -> classifier
    const feat = featureByPlayer[base.player_key];
    const pool = compPoolByPos[feat && feat.position] || [];
    const comp = compProject({
      target: { position: feat.position, propFamily: l.prop_type, features: feat.features },
      pool, line: l.line,
    });
    const verdict = classifyProp({
      comp,
      volume: feat.volume,
      script: feat.script,
      line: l.line,
      structure: 'standard_3',
      extraNudges: feat.extraNudges || 0,
      pick: 'higher',
    });
    return { ...base, verdict, outlook: feat.outlook };
  });

  // sort: qualifying tiers first, then by line-softness/edge
  const rank = { GUARANTEED: 3, PLATINUM: 2, GOLD: 1, none: 0 };
  picks.sort((a, b) =>
    (rank[b.verdict.tier_candidate] - rank[a.verdict.tier_candidate]) ||
    ((b.verdict.edge || 0) - (a.verdict.edge || 0))
  );

  return res.status(200).json({
    source: baselineReady ? 'prizepicks+engine' : 'prizepicks',
    date,
    count: picks.length,
    picks,
    note: baselineReady ? undefined : 'Showing PrizePicks lines. Tier analysis activates once the nflverse baseline is loaded.',
  });
}

// ---- optional baseline loader (Supabase). Returns null until wired to your data. ----
// Fill this in after running the nflverse ingest: query nfl_feature_vectors for the
// players in `lines`, and nfl_player_games for the position comp pools. Until then it
// returns null and the endpoint runs in LINES mode (shows games + PP lines, no tiers).
async function loadBaselines(/* lines */) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  // TODO: fetch feature vectors + comp pools from Supabase REST and shape into
  //   { ready:true, featureByPlayer:{[player_key]:{position,features,volume,script,extraNudges,outlook}},
  //     compPoolByPos:{QB:[...],RB:[...],WR:[...],TE:[...]} }
  // Return null while not yet populated so we degrade to LINES mode.
  return null;
}
