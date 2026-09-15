'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { fetchAccountData, REGIONS, validateApiKey, getChampionCatalog } = require('../riot');
const { getSettings, getAccounts, saveAccounts } = require('../lib/store');
const { loadMatchCache, saveMatchCache } = require('../lib/matchCache');
const { ensureTodayMatches } = require('../lib/todayMatches');
const { computeGoalProgress } = require('../lib/goals');
const { computeNetLpToday } = require('../lib/lpLog');

function registerRiotDataIpc() {
  ipcMain.handle(channels.RIOT_FETCH, async (_e, { id }) => {
    const settings = getSettings();
    const accounts = getAccounts();
    const account = accounts.find((a) => a.id === id);
    if (!account) return { ok: false, error: 'NOT_FOUND' };

    try {
      const matchCache = loadMatchCache();
      // If we already resolved a puuid for this exact Riot ID before, reuse
      // it and skip the account-v1 lookup call — the resolution only needs
      // to happen again if the Riot ID string itself changes (e.g. edited
      // in the app, or the summoner renamed and you updated it to match).
      const canSkipResolve = Boolean(account.cache && account.cache.puuid && account.cache.resolvedFor === account.riotId);

      const data = await fetchAccountData({
        apiKey: settings.apiKey,
        riotId: account.riotId,
        region: account.region,
        knownPuuid: canSkipResolve ? account.cache.puuid : null,
        matchCache,
      });
      data.resolvedFor = account.riotId; // stamp so the next fetch knows this puuid is still valid

      // Cache the result on the account so cards render instantly next launch.
      const idx = accounts.findIndex((a) => a.id === id);
      accounts[idx].cache = data;
      const todayMatches = await ensureTodayMatches(accounts[idx], data, settings.apiKey, matchCache);
      const sessionLP = {
        soloWins: todayMatches.matches.filter((m) => m.win).length,
        soloLosses: todayMatches.matches.filter((m) => !m.win).length,
      };
      accounts[idx].sessionLP = sessionLP;
      const goalProgress = computeGoalProgress(accounts[idx], data);
      // Recomputed on every refresh (same reason ACCOUNTS_GET does — see its
      // comment): it's date-scoped ("today"), so a value computed once at
      // launch goes stale the moment the calendar day rolls over, and the
      // card's ↻ button only ever went through this handler, never a full
      // accounts reload, so it had no way to pick up new log entries either.
      accounts[idx].netLpToday = computeNetLpToday(accounts[idx]);

      saveMatchCache(matchCache);
      saveAccounts(accounts);
      return { ok: true, data, sessionLP, goalProgress, netLpToday: accounts[idx].netLpToday };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle(channels.RIOT_REGIONS, () => REGIONS);

  // Cheap "is this key live right now?" probe, run the instant a new key is
  // saved so the UI recovers immediately instead of waiting out a full refresh.
  ipcMain.handle(channels.RIOT_VALIDATE_KEY, async () => {
    const settings = getSettings();
    return validateApiKey({ apiKey: settings.apiKey, region: settings.defaultRegion });
  });

  // Champion id/key/name list from Data Dragon — needs no API key. Used by the
  // renderer's "owned champions / skins" browser to render names and pictures.
  ipcMain.handle(channels.RIOT_CHAMPION_CATALOG, async () => {
    try {
      return await getChampionCatalog();
    } catch (e) {
      return { version: null, champions: [] };
    }
  });
}

module.exports = { registerRiotDataIpc };
