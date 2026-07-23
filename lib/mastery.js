'use strict';

// --- Collective mastery widget (top champions across all accounts), ~weekly -

const { computeMasteryWidget } = require('../riot');
const { getSettings, getAccounts, getMastery, saveMastery } = require('./store');
const { HOUR } = require('./constants');

const MASTERY_REFRESH_INTERVAL = 7 * 24 * HOUR;

// True if some account we could now query (it has a puuid) is missing from the
// cached widget — e.g. it was added/first-fetched after the last mastery run.
// Without this check, a newly-added account's mastery would silently sit
// uncounted for up to a week until the TTL naturally expired.
function masteryMissingAccounts(current, accounts) {
  if (!current || !current.accountIds) return accounts.length > 0;
  const known = new Set(current.accountIds);
  return accounts.some((a) => !known.has(a.id));
}

async function refreshMasteryIfStale(force) {
  const settings = getSettings();
  if (!settings.apiKey) return getMastery();

  const current = getMastery();
  const accounts = getAccounts()
    .filter((a) => a.cache && a.cache.puuid)
    .map((a) => ({ id: a.id, puuid: a.cache.puuid, region: a.region }));

  const isStale = !current || Date.now() - current.fetchedAt >= MASTERY_REFRESH_INTERVAL;
  if (!force && !isStale && !masteryMissingAccounts(current, accounts)) {
    return current;
  }

  try {
    const widget = await computeMasteryWidget({ apiKey: settings.apiKey, accounts });
    saveMastery(widget);
    return widget;
  } catch (e) {
    return current; // keep whatever we had rather than blowing away stale-but-valid data
  }
}

module.exports = { refreshMasteryIfStale };
