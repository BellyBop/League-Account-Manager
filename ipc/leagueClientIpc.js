'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { getCurrentSummoner } = require('../lib/leagueClientApi');
const { getAccounts, saveAccounts } = require('../lib/store');
const { saveEogDebugSnapshot } = require('../lib/eogDebug');
const { recordLpDelta } = require('../lib/lpLog');
const { getDDragonVersion, profileIconUrl } = require('../riot');

function registerLeagueClientIpc() {
  ipcMain.handle(channels.LEAGUE_CLIENT_STATUS, async () => {
    const summoner = await getCurrentSummoner();
    if (!summoner.signedIn) return { signedIn: false, gameJustEnded: summoner.gameJustEnded || false };

    // Cross-reference against tracked accounts, so the widget can show which
    // of your cards (if any) this is, rather than just a name. Prefer puuid
    // (authoritative), but fall back to matching the Riot ID string — an
    // account that hasn't been successfully refreshed yet (stale/missing
    // cache, e.g. from an expired key) has no puuid to compare against, and
    // would otherwise never match even though it's clearly one of yours.
    const accounts = getAccounts();
    const currentIgn = summoner.gameName && summoner.tagLine ? `${summoner.gameName}#${summoner.tagLine}`.toLowerCase() : null;
    const matched =
      accounts.find((a) => a.cache && a.cache.puuid === summoner.puuid) ||
      (currentIgn ? accounts.find((a) => (a.riotId || '').trim().toLowerCase() === currentIgn) : null);

    let profileIcon = null;
    if (summoner.profileIconId != null) {
      try {
        const version = await getDDragonVersion();
        profileIcon = profileIconUrl(version, summoner.profileIconId);
      } catch (e) {
        // Non-fatal — the widget just shows no icon.
      }
    }

    if (summoner.eogStats) saveEogDebugSnapshot(summoner.eogStats);

    // Real per-game LP change (see computeRankedLpDelta in
    // lib/leagueClientApi.js) — only present on the one poll where a ranked
    // Solo/Duo game just ended and a pre-game snapshot existed to diff
    // against. Persist it onto the matched account so it survives past the
    // one-shot widget flash and shows up on that account's card.
    if (summoner.lpDelta && matched) {
      recordLpDelta(matched, summoner.lpDelta);
      saveAccounts(accounts);
    }

    return {
      signedIn: true,
      ign: summoner.gameName && summoner.tagLine ? `${summoner.gameName}#${summoner.tagLine}` : (summoner.gameName || 'Unknown'),
      summonerLevel: summoner.summonerLevel,
      profileIcon,
      matchedAccountId: matched ? matched.id : null,
      matchedLabel: matched ? matched.label : null,
      gameJustEnded: summoner.gameJustEnded,
      lpDelta: summoner.lpDelta,
    };
  });
}

module.exports = { registerLeagueClientIpc };
