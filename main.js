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
const { getSettings } = require('./lib/store');
const { applyLaunchOnStartup } = require('./lib/autoLaunch');

// Only one instance should ever be running. Without this, launching the app
// again (double-clicking the shortcut while it's already open, or the OS
// auto-starting it via "Launch on startup" on top of an instance that never
// closed) silently spawns a second, fully independent process — same window
// title, no visible difference, but it can't see the first instance's state
// and any install/update done in between won't be reflected in whichever one
// you happen to be looking at. Losing the lock means another instance beat
// us to it, so just hand off to that one instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  return;
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

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

  // Re-apply on every launch so the OS-level login item stays in sync even
  // if the user removed it some other way (e.g. Windows' Task Manager >
  // Startup apps) without touching our Settings screen.
  applyLaunchOnStartup(getSettings().launchOnStartup);

  refreshMasteryIfStale(false);
  runAutoBackupIfDue();
  setInterval(checkApiKeyExpiry, 5 * 60 * 1000);
  setInterval(() => refreshMasteryIfStale(false), 6 * HOUR);
  setInterval(runAutoBackupIfDue, 6 * HOUR);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
