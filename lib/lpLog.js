'use strict';

// Real per-game LP is something Riot's public API and even the LCU's own
// eog-stats-block don't expose (see computeRankedLpDelta in
// leagueClientApi.js) — it only exists because this app captures it live,
// game by game, at the moment each one ends. Unlike the Solo W/L box (which
// rebuilds from real match history via ensureTodayMatches and is always a
// complete picture of the day), a daily LP total can only ever include
// games this app was actually open to catch start-to-finish on this PC — so
// it's an honest running log of captured games, not a full-day guarantee.

const { isFromToday, rankValue } = require('./rank');

const MAX_LOG_ENTRIES = 40; // a very heavy day of ranked games, with room to spare

// Appends one captured game's LP delta (see computeRankedLpDelta's return
// shape) onto the account, then recomputes today's running total from
// scratch from the log — so the total is always derived, never drifted.
function recordLpDelta(account, delta) {
  const entry = { ...delta, capturedAt: Date.now() };
  const log = Array.isArray(account.lpLog) ? account.lpLog : [];
  log.push(entry);
  account.lpLog = log.slice(-MAX_LOG_ENTRIES);
  account.lastLpDelta = entry;
  account.netLpToday = computeNetLpToday(account);
  return account.netLpToday;
}

// A promotion or demotion crosses a tier/division boundary, where a raw LP
// subtraction is meaningless (see computeRankedLpDelta's lpChange: null) —
// but Riot's actual ranked LP still carries over across that boundary (e.g.
// a win at 95 LP crosses 100, promotes, and the excess LP carries into the
// new division) rather than resetting to zero. So pre/post can still be
// diffed honestly on rankValue's normalized tier+division+lp scale instead
// of a raw subtraction. Remakes don't count as a played game at all.
function lpChangeFor(e) {
  if (typeof e.lpChange === 'number') return e.lpChange;
  if (!e.pre || !e.post) return null;
  const preValue = rankValue({ tier: e.pre.tier, rank: e.pre.division, lp: e.pre.leaguePoints });
  const postValue = rankValue({ tier: e.post.tier, rank: e.post.division, lp: e.post.leaguePoints });
  if (preValue == null || postValue == null) return null;
  return postValue - preValue;
}

function computeNetLpToday(account) {
  const log = Array.isArray(account.lpLog) ? account.lpLog : [];
  const todayStr = new Date().toDateString();
  const todays = log.filter((e) => isFromToday(e.capturedAt, todayStr));

  let total = 0;
  let gamesCounted = 0;
  let promotions = 0;
  let demotions = 0;
  let remakes = 0;

  for (const e of todays) {
    if (e.remake) {
      remakes += 1;
      continue;
    }

    if (e.promoted) promotions += 1;
    if (e.demoted) demotions += 1;

    const change = lpChangeFor(e);
    if (typeof change === 'number') {
      total += change;
      gamesCounted += 1;
    }
  }

  return { total, gamesCounted, promotions, demotions, remakes };
}

module.exports = { recordLpDelta, computeNetLpToday };
