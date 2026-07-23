// nflRevengeGame.js
// Lyrid NFL engine — former-team ("revenge game") flag.
//
// EMPIRICAL FINDING (tested on nflverse 2020-2024, WR/TE, n=104 qualifying games):
//   mean diff vs same-season baseline: +1.9 yards
//   MEDIAN diff: -4.4 yards
//   over-baseline rate: 48.1%   (i.e. slightly WORSE than a coin flip)
//   t=0.61, p=0.54  -> NO significant league-wide effect
//
// Individual players DO look consistent — Diggs vs former teams ran +40.7/+28.7/
// +95.9/-24.1; Kupp vs the Rams ran -17.8/-1.8/-4.8 (all under). But at n=3-4 a
// consistent direction is weak evidence: across ~50 players with revenge games,
// several will look "consistent" by chance alone, and those are exactly the ones
// people remember. This is the same trap as the retired MLB SCORCHING tier.
//
// THEREFORE: this module is INFORMATIONAL BY DEFAULT (weight 0). It surfaces the
// history on the card so the user can see it, but does not move the projection
// unless the player clears the same sample bar as any other opponent history —
// in which case nflPlayerVsOpponent.js (min 4 meetings, empirical-Bayes shrink,
// hard cap ±0.25) already handles it with proper discipline.
//
// Set `allowNudge: true` only after a backtest shows a player-specific effect that
// survives out-of-sample. Do not enable it on narrative.

const LEAGUE_FINDING = {
  n: 104, meanDiff: 1.9, medianDiff: -4.4, overRate: 0.481, p: 0.54,
  verdict: 'no significant league-wide revenge-game effect',
};

// teamHistory: [{ team, firstSeason, lastSeason }] for this player
// game: { opponent, season }
export function revengeFlag({ teamHistory, game, priorMeetingsVsOpp, baseline, allowNudge = false }) {
  const out = {
    isRevengeGame: false, formerTeamSeasons: null,
    history: null, nudge: 0, display: null, leagueFinding: LEAGUE_FINDING,
  };
  if (!teamHistory || !game) return out;

  const stint = teamHistory.find(t =>
    t.team === game.opponent && t.lastSeason != null && t.lastSeason < game.season);
  if (!stint) return out;

  out.isRevengeGame = true;
  out.formerTeamSeasons = `${stint.firstSeason}-${stint.lastSeason}`;

  // summarize his actual history vs this team, if we have it
  if (Array.isArray(priorMeetingsVsOpp) && priorMeetingsVsOpp.length && baseline?.mean != null) {
    const vals = priorMeetingsVsOpp.map(g => g.receiving_yards ?? g.yards).filter(v => v != null);
    if (vals.length) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const diffs = vals.map(v => v - baseline.mean);
      const overN = diffs.filter(d => d > 0).length;
      out.history = {
        meetings: vals.length,
        meanVsOpp: +mean.toFixed(1),
        vsBaseline: +(mean - baseline.mean).toFixed(1),
        overBaselineRate: +(overN / vals.length).toFixed(2),
        perGame: diffs.map(d => +d.toFixed(1)),
      };
    }
  }

  // DISPLAY text — honest about what the sample supports
  const h = out.history;
  if (h) {
    const dir = h.vsBaseline > 0 ? 'above' : 'below';
    out.display = `Faces a former team (${out.formerTeamSeasons}). In ${h.meetings} prior meeting${h.meetings === 1 ? '' : 's'} he has averaged ${h.meanVsOpp} yds, ${Math.abs(h.vsBaseline)} ${dir} his baseline.` +
      (h.meetings < 4
        ? ' Too few meetings to be predictive — shown for context only.'
        : ' Weighted through the standard opponent-history filter (heavily shrunk).');
  } else {
    out.display = `Faces a former team (${out.formerTeamSeasons}). No usable prior-meeting sample.`;
  }

  // NUDGE stays 0 unless explicitly enabled AND the sample bar is met.
  if (allowNudge && h && h.meetings >= 4 && baseline?.std) {
    const z = (h.meanVsOpp - baseline.mean) / baseline.std;
    const shrink = h.meetings / (h.meetings + 6);
    out.nudge = +Math.max(-0.15, Math.min(0.15, z * shrink * 0.25)).toFixed(4);
  }
  return out;
}

export { LEAGUE_FINDING };
