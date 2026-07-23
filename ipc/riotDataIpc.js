'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { fetchAccountData, REGIONS } = require('../riot');
const { getSettings, getAccounts, saveAccounts } = require('../lib/store');
const { loadMatchCache, saveMatchCache } = require('../lib/matchCache');
const { ensureTodayMatches } = require('../lib/todayMatches');
const { computeGoalProgress } = require('../lib/goals');

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

      saveMatchCache(matchCache);
      saveAccounts(accounts);
      return { ok: true, data, sessionLP, goalProgress };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle(channels.RIOT_REGIONS, () => REGIONS);
}

module.exports = { registerRiotDataIpc };
