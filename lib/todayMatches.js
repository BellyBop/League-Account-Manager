'use strict';

// --- Today's Solo W-L (real match history, not a cumulative-counter diff) ---
// Unlike LP, per-game results ARE queryable from Riot after the fact — so
// instead of needing a same-day baseline (which can only start from whenever
// the app first checks, not true midnight), this pages back through actual
// match history until it crosses into yesterday, and counts real games.
// Capped per day to bound worst-case API usage on unusually heavy play days;
// once that boundary is found (or the cap is hit), it's cached and later
// refreshes just merge in newly-completed games for free.

const { fetchMatchPage } = require('../riot');
const { todayKey, isFromToday, RANKED_SOLO_QUEUE_ID } = require('./rank');

const MAX_EXTRA_TODAY_MATCHES = 20;

async function ensureTodayMatches(account, data, apiKey, matchCache) {
  const today = todayKey();
  if (!account.todayMatches || account.todayMatches.date !== today) {
    account.todayMatches = { date: today, matches: [], complete: false };
  }
  const store = account.todayMatches;
  const known = new Set(store.matches.map((m) => m.matchId));
  const todayStr = new Date().toDateString();
  const isCountable = (m) => m.queueId === RANKED_SOLO_QUEUE_ID && !m.remake && isFromToday(m.gameEndTimestamp, todayStr);

  // Games already fetched for the "last 5" display are free — merge them in.
  const recentGames = data.games || [];
  for (const g of recentGames) {
    if (isCountable(g) && !known.has(g.matchId)) {
      store.matches.push({ matchId: g.matchId, win: g.win, gameEndTimestamp: g.gameEndTimestamp });
      known.add(g.matchId);
    }
  }

  if (store.complete) return store;

  const oldestFetched = recentGames[recentGames.length - 1];
  if (!oldestFetched || !isFromToday(oldestFetched.gameEndTimestamp, todayStr)) {
    store.complete = true; // the last-5 list already reaches back into yesterday
    return store;
  }

  // There might be more Solo games today beyond the last 5 — page back for
  // them, apiKey permitting (no key yet just means try again next refresh).
  if (!apiKey) return store;

  let start = recentGames.length;
  let checked = 0;
  while (checked < MAX_EXTRA_TODAY_MATCHES) {
    const batchSize = Math.min(10, MAX_EXTRA_TODAY_MATCHES - checked);
    let batch, requestedCount;
    try {
      const page = await fetchMatchPage({ apiKey, puuid: data.puuid, region: account.region, start, count: batchSize, cache: matchCache });
      batch = page.matches;
      requestedCount = page.requestedCount;
    } catch (e) {
      break; // transient failure — just try again next refresh, don't mark complete
    }
    if (requestedCount === 0) {
      store.complete = true; // no more match history at all
      break;
    }
    // Advance by requestedCount (how many match IDs Riot actually returned),
    // not batch.length (how many of those resolved successfully) — a single
    // match that failed to fetch (e.g. a transient 429) would otherwise leave
    // `start` pointing at the same failed match forever, looping without
    // making progress until the cap below silently marks the day "complete".
    checked += requestedCount;
    start += requestedCount;

    let reachedYesterday = false;
    for (const m of batch) {
      if (!isFromToday(m.gameEndTimestamp, todayStr)) {
        reachedYesterday = true;
        break;
      }
      if (m.queueId === RANKED_SOLO_QUEUE_ID && !m.remake && !known.has(m.matchId)) {
        store.matches.push({ matchId: m.matchId, win: m.win, gameEndTimestamp: m.gameEndTimestamp });
        known.add(m.matchId);
      }
    }
    if (reachedYesterday) {
      store.complete = true;
      break;
    }
  }
  // Hit the cap without finding yesterday (an extremely heavy play day) —
  // stop for today rather than re-paying this cost on every refresh.
  if (checked >= MAX_EXTRA_TODAY_MATCHES) store.complete = true;

  return store;
}

module.exports = { ensureTodayMatches };
