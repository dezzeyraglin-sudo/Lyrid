import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeClient, normalizeTotals, consensusLine } from './oddspapiClient.mjs';
import { buildRowsFromCsv } from './tennisFeed.js';
import { scanTotalGames } from './tennisTotalGamesScan.js';
const KEY = process.env.ODDSPAPI_KEY;
const dataDir = process.argv[2] || './data/tennis';
const MAX_T = Number(process.env.MAX_TOURNAMENTS || 8);
async function main() {
  if (!KEY) { console.error('Set ODDSPAPI_KEY'); process.exit(1); }
  const api = makeClient(KEY, { bookmaker: 'pinnacle' });
  const sportId = await api.resolveTennisSportId();
  let mkt = null; try { mkt = await api.resolveTotalGamesMarketId(); } catch {}
  console.error(`sportId=${sportId} totalsMarketId=${mkt ?? '(auto-scan)'}`);
  const tt = await api.getTournaments(sportId);
  const ids = (Array.isArray(tt) ? tt : tt?.data || []).slice(0, MAX_T).map(t => t.tournamentId ?? t.id).filter(Boolean);
  console.error(`tournaments: ${ids.length}`);
  const fx = await api.getOddsByTournaments(ids);
  const fl = Array.isArray(fx) ? fx : fx?.data || [];
  const recs = [];
  for (const f of fl) {
    const line = consensusLine(normalizeTotals(f, mkt));
    if (line == null) continue;
    recs.push({ date: (f.startTime||'').slice(0,10), playerA: f.participant1Name || f.participant1Id, playerB: f.participant2Name || f.participant2Id, line });
  }
  console.error(`line records: ${recs.length}`);
  if (recs.length) console.error('sample names:', recs.slice(0,3).map(r=>`${r.playerA} vs ${r.playerB}`).join(' | '));
  let rows = [];
  for (const fn of readdirSync(dataDir).filter(f => /_matches_.*\.csv$/i.test(f))) rows = rows.concat(buildRowsFromCsv(readFileSync(join(dataDir, fn), 'utf8')));
  const res = scanTotalGames(recs, rows);
  console.log(`\njoined ${res.matches} matches to real lines\n`);
  console.log('SIGNAL'.padEnd(48) + 'n     hit%   lift   edge?');
  for (const s of res.signals) { const l = s.lift==null?'  —':((s.lift>=0?'+':'')+(s.lift*100).toFixed(1)).padStart(6); console.log(`${s.name.padEnd(46)} ${String(s.n).padStart(4)}  ${s.rate==null?' —':(s.rate*100).toFixed(1).padStart(5)}  ${l}   ${s.edge?'YES':''}`); }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
