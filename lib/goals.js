'use strict';

// --- Account goals -------------------------------------------------------
// A goal is a target Solo/Duo tier+division. Progress is just the LP gap
// between wherever the account's rank sits right now and the target,
// recomputed fresh from current rank on every fetch — deliberately NOT
// measured against a snapshot of where you were when the goal was set. A
// snapshot-relative percentage used to get stuck at a floor of 0% the moment
// you dropped below your starting point, no matter how far — which reads as
// "you've made zero progress" even mid-climb back up. A live LP-to-go number
// has no such floor: it simply grows when you lose LP and shrinks when you
// gain it, same as the goal itself would in-client.

const { rankValue } = require('./rank');

const APEX_TIERS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];

function setAccountGoal(account, tier, division) {
  const rank = APEX_TIERS.includes(tier) ? null : (division || 'IV');
  account.goal = { tier, rank, setAt: Date.now() };
  return account.goal;
}

function clearAccountGoal(account) {
  account.goal = null;
  account.goalProgress = null;
}

// Recomputed on every fetch so the card always reflects current standing.
function computeGoalProgress(account, data) {
  if (!account.goal) {
    account.goalProgress = null;
    return null;
  }
  const { tier, rank } = account.goal;
  const goalValue = rankValue({ tier, rank: rank || 'IV', lp: 0 });
  const currentValue = data && data.solo ? rankValue(data.solo) : null;

  // Unranked (no Solo/Duo entry yet) — nothing to measure against.
  if (currentValue == null) {
    account.goalProgress = { tier, rank, lpToGo: null, reached: false };
    return account.goalProgress;
  }

  account.goalProgress = {
    tier,
    rank,
    // Same rankValue scale used elsewhere (~100 units per division) — not
    // exact promo math, just a reasonable "how far off" figure.
    lpToGo: Math.max(0, goalValue - currentValue),
    reached: currentValue >= goalValue,
  };
  return account.goalProgress;
}

module.exports = { setAccountGoal, clearAccountGoal, computeGoalProgress };
