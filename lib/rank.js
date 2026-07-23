'use strict';

// Ranks a solo/flex entry onto a single comparable number so goal progress
// can diff two snapshots even across division/tier changes. Not exact promo
// math — good enough for a progress bar.
const TIER_ORDER = [
  'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD',
  'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER',
];
const DIVISION_ORDER = { IV: 0, III: 1, II: 2, I: 3 };
const RANKED_SOLO_QUEUE_ID = 420;

function rankValue(rank) {
  if (!rank) return null;
  const tierIdx = TIER_ORDER.indexOf(rank.tier);
  if (tierIdx === -1) return null;
  if (tierIdx >= TIER_ORDER.indexOf('MASTER')) return tierIdx * 400 + rank.lp;
  return tierIdx * 400 + (DIVISION_ORDER[rank.rank] || 0) * 100 + rank.lp;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isFromToday(timestampMs, todayDateString) {
  return Boolean(timestampMs) && new Date(timestampMs).toDateString() === todayDateString;
}

module.exports = { RANKED_SOLO_QUEUE_ID, rankValue, todayKey, isFromToday };
