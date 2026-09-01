'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { getUpdateState, checkForUpdates, quitAndInstall } = require('../lib/updater');

function registerUpdateIpc() {
  // Initial state for a renderer that just loaded (it also gets pushed
  // `update:status` events after this).
  ipcMain.handle(channels.UPDATE_GET_STATUS, () => getUpdateState());
  ipcMain.handle(channels.UPDATE_CHECK, () => {
    checkForUpdates();
    return getUpdateState();
  });
  ipcMain.handle(channels.UPDATE_INSTALL, () => quitAndInstall());
}

module.exports = { registerUpdateIpc };
