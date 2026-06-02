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

// Server-side path prober — tries candidate odds/props endpoints with the real
// key (never exposed) against a real game id and reports each status + a snippet.
// Settles "wrong path" vs "no props posted yet" without a local curl.
async function probe(url) {
  try {
    const r = await fetch(url, { headers: { Authorization: process.env.BDL_API_KEY } });
    let bodySnippet = '';
    try {
      const txt = await r.text();
      bodySnippet = txt.slice(0, 300);
    } catch {}
    return { url: url.replace(/\?.*/, '?…'), status: r.status, body: bodySnippet };
  } catch (err) {
    return { url: url.replace(/\?.*/, '?…'), status: 0, error: err.message };
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  // PROBE MODE: /api/wnba/debug-bdl?probe=1[&game_id=24815]
  if (url.searchParams.get('probe')) {
    if (!isBdlConfigured()) return res.status(200).json({ ok: false, error: 'BDL_API_KEY not set in this environment' });
    let gid = url.searchParams.get('game_id');
    let gamesNote = null;
    // If no game id given, resolve one from today's games first.
    if (!gid) {
      try {
        const g = await fetch(`https://api.balldontlie.io/wnba/v1/games?dates[]=${date}&per_page=5`,
          { headers: { Authorization: process.env.BDL_API_KEY } });
        const gj = await g.json();
        gid = gj?.data?.[0]?.id;
        gamesNote = `resolved game_id ${gid} from ${date} (${gj?.data?.length || 0} games)`;
      } catch (e) { gamesNote = `could not resolve a game id: ${e.message}`; }
    }
    const B1 = 'https://api.balldontlie.io/wnba/v1';
    const B2 = 'https://api.balldontlie.io/wnba/v2';
    const candidates = [
      `${B1}/odds/player_props?game_id=${gid}`,
      `${B2}/odds/player_props?game_id=${gid}`,
      `${B1}/odds/player-props?game_id=${gid}`,
      `${B1}/player_props?game_id=${gid}`,
      `${B2}/player_props?game_id=${gid}`,
      `${B1}/odds?game_id=${gid}`,
      `${B2}/odds?game_id=${gid}`,
      `${B2}/odds/player_props`,            // no filter — any props at all?
      `${B1}/odds/game_props?game_id=${gid}`,
    ];
    const results = [];
    for (const c of candidates) { results.push(await probe(c)); }
    return res.status(200).json({ ok: true, mode: 'probe', date, gid, gamesNote, results,
      readme: 'Look for the first status:200. That is the live path. 404 = wrong path OR no props for that game. 401 = key issue.' });
  }

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
