// api/cron/nba-grade.js
// Nightly: settle ungraded logged picks from ESPN box scores so calibration is fed
// automatically (no manual upload needed). Grades a short backfill window; a game that
// isn't final yet is simply retried next run. DNP / missing player -> 'void' (excluded
// from win/loss cohorts). vercel.json: { "path": "/api/cron/nba-grade", "schedule": "0 11 * * *" }

import { fetchSchedule, fetchGameSummary } from '../_lib/nba/espnClient.js';
import { readUngraded, gradeOne, actualForMarket, gradeSide, logConfigured } from '../_lib/nba/propLog.js';

const yyyymmdd = (iso) => iso.replace(/-/g, '');
const isFinal = (status) => /final/i.test(String(status || ''));

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers?.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!logConfigured()) return res.status(500).json({ error: 'prop log not configured' });
  try {
    const backfill = Number(process.env.NBA_GRADE_BACKFILL_DAYS || 3);
    const dates = [];
    for (let i = 1; i <= backfill; i++) dates.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    let graded = 0, voided = 0, pending = 0;
    for (const date of dates) {
      const ungraded = await readUngraded([date]);
      if (!ungraded.length) continue;
      const schedule = await fetchSchedule(yyyymmdd(date)).catch(() => []);
      const finals = schedule.filter((g) => isFinal(g.status));
      const boxById = {};
      for (const g of finals) {
        try { const sm = await fetchGameSummary(g.eventId); for (const bp of sm.players || []) if (bp.id != null) boxById[String(bp.id)] = bp; } catch { /* skip */ }
      }
      for (const p of ungraded) {
        const bp = boxById[String(p.player_id)];
        if (!bp) { pending++; continue; }                 // game not final yet or player absent — retry next run
        const actual = actualForMarket(p.market, bp);
        if (bp.dnp || actual == null) { await gradeOne(p.pick_id, 'void', actual); voided++; continue; }
        const result = gradeSide(p.side, actual, p.line);
        if (!result) { pending++; continue; }
        await gradeOne(p.pick_id, result, actual); graded++;
      }
    }
    res.status(200).json({ ok: true, graded, voided, pending, dates });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
