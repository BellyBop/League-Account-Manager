'use strict';

const { ipcMain, clipboard, shell } = require('electron');
const { spawn } = require('child_process');
const channels = require('../ipcChannels');
const { findRiotClientPath } = require('../lib/riotClient');

function registerMiscIpc() {
  // Open a URL in the user's default browser.
  ipcMain.handle(channels.SHELL_OPEN, (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // Clipboard + Riot Client launch (1-click sign-in).
  ipcMain.handle(channels.CLIPBOARD_WRITE, (_e, text) => {
    clipboard.writeText(typeof text === 'string' ? text : '');
    return true;
  });

  ipcMain.handle(channels.RIOTCLIENT_LAUNCH, () => {
    const exePath = findRiotClientPath();
    if (!exePath) return { ok: false, error: 'CLIENT_NOT_FOUND' };
    try {
      const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

module.exports = { registerMiscIpc };
