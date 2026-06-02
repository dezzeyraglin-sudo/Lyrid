// api/wnba/debug-bdl.js
//
// DEBUG ENDPOINT (June 2, 2026)
//
// Verify the BallDontLie WNBA integration in the deployed environment. Hit
// /api/wnba/debug-bdl?date=YYYY-MM-DD after setting BDL_API_KEY in Vercel.
//
// This is the coverage GATE: it tells you, without a local curl, whether your
// GOAT trial/plan key actually returns WNBA player props for a real slate —
// before you wire props into the slate or pay past the trial.
//
//   keyConfigured  → is BDL_API_KEY set
//   props.audit    → httpStatus, gamesFound, propRows, tierBlocked, warnings
//   sampleProps    → first few parsed "Name_market": line entries
//   live.audit     → live box-score reachability
//
// Never prints the key.

import { fetchWnbaProps, fetchWnbaLiveScores, isBdlConfigured } from '../_lib/wnba/bdlFeed.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  try {
    const props = await fetchWnbaProps(date, { noCache: true });
    const live = await fetchWnbaLiveScores({ noCache: true });
    const sample = Object.entries(props.propLines).slice(0, 8)
      .map(([k, v]) => ({ key: k, line: v }));

    return res.status(200).json({
      ok: true,
      keyConfigured: isBdlConfigured(),
      date,
      props: { audit: props._audit, totalPropLines: Object.keys(props.propLines).length, sampleProps: sample },
      live: { audit: live._audit, sample: Object.values(live.byMatchup).slice(0, 4) },
      hint: !isBdlConfigured()
        ? 'BDL_API_KEY not set. Add it in Vercel → Settings → Environment Variables, then REDEPLOY.'
        : (props._audit.tierBlocked
            ? 'Key works but player-props is GOAT-gated — start the 48h GOAT trial or upgrade.'
            : (Object.keys(props.propLines).length > 0
                ? 'Props flowing — ready to wire into the slate (recommendations can leave shadow mode).'
                : 'Key works but 0 props for this date — try a date with scheduled games, or check closer to tip-off.'))
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
