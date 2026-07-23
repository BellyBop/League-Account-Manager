'use strict';

// --- Account goals -------------------------------------------------------
// A goal is a target Solo/Duo tier+division. Progress is measured on the same
// rankValue scale as session LP tracking, from wherever the account's rank
// was when the goal was set, up to the LP value at the very start of the
// target division. That means progress starts at 0% the moment a goal is
// set (there's nothing to show yet) and only moves as you actually climb
// afterward — it does not reflect how close you already were beforehand.

const { rankValue } = require('./rank');

const APEX_TIERS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];

function setAccountGoal(account, tier, division) {
  const rank = APEX_TIERS.includes(tier) ? null : (division || 'IV');
  const startValue = account.cache && account.cache.solo ? rankValue(account.cache.solo) : 0;
  account.goal = { tier, rank, startValue: startValue != null ? startValue : 0, setAt: Date.now() };
  return account.goal;
}

function clearAccountGoal(account) {
  account.goal = null;
  account.goalProgress = null;
}

// Recomputed on every fetch so the card always reflects current progress.
function computeGoalProgress(account, data) {
  if (!account.goal) {
    account.goalProgress = null;
    return null;
  }
  const { tier, rank, startValue } = account.goal;
  const goalValue = rankValue({ tier, rank: rank || 'IV', lp: 0 });
  const currentValue = rankValue(data.solo);
  const effectiveCurrent = currentValue != null ? currentValue : startValue;

  const span = goalValue - startValue;
  let percent;
  if (span <= 0) {
    // Goal is at or below the starting point (e.g. already there) — no
    // meaningful ratio to show, just whether it's been hit.
    percent = effectiveCurrent >= goalValue ? 100 : 0;
  } else {
    percent = ((effectiveCurrent - startValue) / span) * 100;
  }

  account.goalProgress = {
    tier,
    rank,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    reached: effectiveCurrent >= goalValue,
  };
  return account.goalProgress;
}

module.exports = { setAccountGoal, clearAccountGoal, computeGoalProgress };
