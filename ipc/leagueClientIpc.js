'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { getCurrentSummoner } = require('../lib/leagueClientApi');
const { getAccounts, saveAccounts } = require('../lib/store');
const { saveEogDebugSnapshot } = require('../lib/eogDebug');
const { recordLpDelta } = require('../lib/lpLog');
const { getDDragonVersion, getChampionIdSet, profileIconUrl } = require('../riot');

// Content-equality for a persisted inventory (ignores fetchedAt) — used to skip
// rewriting accounts.json on every poll when nothing actually changed.
function sameInventory(a, b) {
  if (!a || !b) return a === b;
  return (
    a.blueEssence === b.blueEssence &&
    a.riotPoints === b.riotPoints &&
    a.championsOwned === b.championsOwned &&
    a.championsTotal === b.championsTotal &&
    (a.ownedSkins ? a.ownedSkins.length : 0) === (b.ownedSkins ? b.ownedSkins.length : 0)
  );
}

function registerLeagueClientIpc() {
  ipcMain.handle(channels.LEAGUE_CLIENT_STATUS, async (_e, opts) => {
    const summoner = await getCurrentSummoner(opts && opts.forceInventory);
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

    // Blue Essence / RP / champions owned — only knowable from the local
    // client, so it's only ever for the signed-in account. The client's owned
    // list is intersected with Data Dragon's real champion roster here (so
    // "owned" can't exceed "total"), then persisted onto the matched card so it
    // still shows after the client closes.
    let inventory = summoner.inventory || null;
    if (inventory) {
      const hadChampList = Array.isArray(inventory.ownedChampionIds);
      let championsTotal = null;
      let ownedChampionIds = hadChampList ? inventory.ownedChampionIds : [];
      try {
        const validIds = await getChampionIdSet();
        championsTotal = validIds.size;
        // Keep only IDs that map to a real champion, and dedupe — the client's
        // list can carry stale/removed IDs and repeats (that's how it reported
        // 236 "owned" against a ~170-champion roster).
        ownedChampionIds = [...new Set(ownedChampionIds.filter((id) => validIds.has(id)))];
      } catch (e) {
        // Data Dragon unreachable — keep the raw client list as-is.
      }
      inventory = {
        blueEssence: inventory.blueEssence,
        riotPoints: inventory.riotPoints,
        championsOwned: hadChampList ? ownedChampionIds.length : null,
        championsTotal,
        ownedChampionIds,
        ownedSkins: Array.isArray(inventory.ownedSkins) ? inventory.ownedSkins : [],
        fetchedAt: inventory.fetchedAt,
      };
    }

    // Persist inventory + any just-happened per-game LP change onto the matched
    // account, in ONE write. This handler runs on every 15s poll, so: (a) only
    // write when something actually changed, and (b) re-read the accounts file
    // immediately before writing and patch just this account — a card refresh
    // (riot:fetch) may have rewritten accounts.json since we read it above, and
    // a blind save of our stale copy would clobber its fresh `cache`.
    const lpDelta = summoner.lpDelta && matched ? summoner.lpDelta : null;
    if (matched && (lpDelta || (inventory && !sameInventory(matched.inventory, inventory)))) {
      const fresh = getAccounts();
      const target = fresh.find((a) => a.id === matched.id);
      if (target) {
        if (inventory) target.inventory = inventory;
        if (lpDelta) recordLpDelta(target, lpDelta);
        saveAccounts(fresh);
      }
    }

    return {
      signedIn: true,
      ign: summoner.gameName && summoner.tagLine ? `${summoner.gameName}#${summoner.tagLine}` : (summoner.gameName || 'Unknown'),
      summonerLevel: summoner.summonerLevel,
      profileIcon,
      matchedAccountId: matched ? matched.id : null,
      matchedLabel: matched ? matched.label : null,
      inventory,
      gameJustEnded: summoner.gameJustEnded,
      lpDelta: summoner.lpDelta,
    };
  });
}

module.exports = { registerLeagueClientIpc };
