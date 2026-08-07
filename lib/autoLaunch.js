'use strict';

// Wraps Electron's OS-level login-item registration. Kept separate from
// settingsIpc.js so it can also be re-applied once at startup (see main.js)
// — that catches the case where the user removed the app from their OS
// startup list some other way (e.g. Windows' Task Manager > Startup apps)
// without going through our Settings screen, so the saved setting and the
// actual OS state don't silently drift apart.
const { app } = require('electron');

function applyLaunchOnStartup(enabled) {
  // No-op in dev (running unpackaged via `electron .`) — setLoginItemSettings
  // would register the electron.exe binary itself to auto-launch, which is
  // never what you want outside of a packaged install.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
}

module.exports = { applyLaunchOnStartup };
