// api/nfl/slate.js
// Lyrid NFL slate endpoint — Vercel serverless (Node 20 ESM).
// GET /api/nfl/slate?date=YYYY-MM-DD
// Returns { source, picks: [{ player, player_key, propLabel, verdict, outlook? }] }
// where `verdict` is the nflClassify.classifyProp() output shape.
//
// THIS IS A STUB wired to the real engine modules but returning an honest empty
// slate until the data pipeline is populated (migration + ingest + backtest).
// Fill in the TODO block once nfl_feature_vectors / nfl_prop_lines_live have rows.

import { classifyProp } from '../../lib/nfl/nflClassify.js';
import { compProject } from '../../lib/nfl/nflCompEngine.js';
import { volumeSecurity } from '../../lib/nfl/nflVolumeSecurity.js';
import { gameScriptRisk } from '../../lib/nfl/nflGameScript.js';
import { suppressionScore, qbOutlook } from '../../lib/nfl/nflMatchupAnalysis.js';
import { buildEnvironmentNudges } from '../../lib/nfl/nflEnvironment.js';

export default async function handler(req, res) {
  const date = (req.query?.date) || new Date().toISOString().slice(0, 10);

  try {
    // ------------------------------------------------------------------
    // TODO (once data is live):
    //   1. Fetch today's live lines from nfl_prop_lines_live (or the
    //      Underdog/PrizePicks adapters in lib/nfl/nflLineAdapters.js).
    //   2. For each line: load the player's trailing games + opponent
    //      scheme/suppression + team tendency + game odds from Supabase.
    //   3. Build features (volumeSecurity, gameScriptRisk, suppressionScore,
    //      buildEnvironmentNudges), run compProject() for P(over), then
    //      classifyProp() for the tier verdict. Attach qbOutlook() for QBs.
    //   4. Push { player, player_key, propLabel, verdict, outlook? } to picks.
    //
    // The engine functions are imported above and ready; this stub returns an
    // honest empty slate so the UI shows its off-season / no-data state rather
    // than a fabricated pick.
    // ------------------------------------------------------------------

    const picks = [];

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      source: 'engine-stub',
      date,
      picks,
      note: picks.length ? undefined : 'No slate wired yet — populate nfl_prop_lines_live and remove the stub guard.',
    });
  } catch (err) {
    return res.status(500).json({ source: 'error', date, picks: [], error: String(err && err.message || err) });
  }
}
