'use strict';

const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

const { registerSettingsIpc } = require('./ipc/settingsIpc');
const { registerAccountsIpc } = require('./ipc/accountsIpc');
const { registerRiotDataIpc } = require('./ipc/riotDataIpc');
const { registerMasteryIpc } = require('./ipc/masteryIpc');
const { registerBackupIpc } = require('./ipc/backupIpc');
const { registerMiscIpc } = require('./ipc/miscIpc');
const { registerLeagueClientIpc } = require('./ipc/leagueClientIpc');

const { checkApiKeyExpiry } = require('./lib/notifications');
const { refreshMasteryIfStale } = require('./lib/mastery');
const { runAutoBackupIfDue } = require('./lib/backup');
const { HOUR } = require('./lib/constants');

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0a0e14',
    title: 'League Account Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Without this, Chromium throttles the renderer's setInterval timers
      // once the window loses focus — which is exactly what happens the
      // whole time you're actually playing League (the game has focus, this
      // window doesn't). That silently slows the active-account poll enough
      // to miss short-lived gameflow phases like EndOfGame entirely.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

registerSettingsIpc();
registerAccountsIpc();
registerRiotDataIpc();
registerMasteryIpc();
registerBackupIpc();
registerMiscIpc();
registerLeagueClientIpc();

app.whenReady().then(() => {
  // The menu bar's already hidden, but Electron's default menu still
  // registers accelerators (Ctrl+R = reload, etc.) that would fight with our
  // own in-app keyboard shortcuts. Removing it entirely frees those keys up.
  Menu.setApplicationMenu(null);

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  refreshMasteryIfStale(false);
  runAutoBackupIfDue();
  setInterval(checkApiKeyExpiry, 5 * 60 * 1000);
  setInterval(() => refreshMasteryIfStale(false), 6 * HOUR);
  setInterval(runAutoBackupIfDue, 6 * HOUR);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
