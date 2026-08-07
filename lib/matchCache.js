'use strict';

// Match results never change once a game ends, so any match we've already
// fetched can be reused forever instead of re-fetched on every refresh — this
// is what keeps a "nothing new happened" refresh down to 3 API calls instead
// of 9 (see riot.js's getMatchDetails). Keyed by `${matchId}:${puuid}` — not
// matchId alone, since a duo-queued match is fetched from each participant's
// own perspective (champion, K/D/A) and those must not collide across two
// tracked accounts sharing the same match. Pruned by age and by a hard cap
// so it can't grow without bound over months of use.

const { readJson, writeJson, matchCachePath } = require('./store');
const { HOUR } = require('./constants');

const MAX_AGE = 30 * 24 * HOUR;
const MAX_ENTRIES = 500;

function loadMatchCache() {
  return readJson(matchCachePath(), {});
}

function pruneMatchCache(cache) {
  const cutoff = Date.now() - MAX_AGE;
  let entries = Object.entries(cache).filter(([, m]) => !m.gameEndTimestamp || m.gameEndTimestamp >= cutoff);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => (b[1].gameEndTimestamp || 0) - (a[1].gameEndTimestamp || 0));
    entries = entries.slice(0, MAX_ENTRIES);
  }
  return Object.fromEntries(entries);
}

function saveMatchCache(cache) {
  writeJson(matchCachePath(), pruneMatchCache(cache));
}

module.exports = { loadMatchCache, saveMatchCache };
