'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { getMastery } = require('../lib/store');
const { refreshMasteryIfStale } = require('../lib/mastery');

function registerMasteryIpc() {
  ipcMain.handle(channels.MASTERY_GET, () => getMastery());
  ipcMain.handle(channels.MASTERY_REFRESH, () => refreshMasteryIfStale(true));
  // Called once after a bulk "Refresh all", not per-account — only does real
  // work if an account is missing from the cached widget or the TTL lapsed.
  ipcMain.handle(channels.MASTERY_SYNC, () => refreshMasteryIfStale(false));
}

module.exports = { registerMasteryIpc };
