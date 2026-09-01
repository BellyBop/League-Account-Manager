'use strict';

// --- Auto-update via electron-updater against GitHub Releases -----------------
// When "automatically check for updates" is on (the default), checks on launch
// and every few hours, downloads a newer release in the background, and once
// it's ready pushes an `update:status` event so the renderer can show a
// "restart to apply" banner. The install itself happens on the next quit (or
// immediately if the user clicks restart). When the setting is off, nothing
// automatic runs — only the Settings "Check for updates" link triggers a check.
// Unsigned build: electron-updater verifies the download against the sha512 in
// latest.yml, so it works without code signing — it just skips the
// publisher-signature check.

const { app, BrowserWindow } = require('electron');
const { HOUR } = require('./constants');
const { getSettings } = require('./store');

const CHECK_INTERVAL = 6 * HOUR;

let autoUpdater = null;
let autoCheckTimer = null;
let state = { status: 'idle', version: null, percent: 0, error: null };

function broadcast() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', state);
  }
}

function setState(patch) {
  state = { ...state, ...patch };
  broadcast();
}

function getUpdateState() {
  return state;
}

// Always allowed, regardless of the auto-check setting — this is what the
// Settings "Check for updates" link calls.
function checkForUpdates() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((err) => {
    setState({ status: 'error', error: String((err && err.message) || err) });
  });
}

function autoCheckEnabled() {
  return getSettings().autoUpdateCheck !== false; // default on
}

// (Re)start or stop the launch + periodic checks to match the current setting.
// Called on init and again from settings:save whenever the toggle changes.
function applyAutoCheckSetting() {
  if (!autoUpdater) return;
  if (autoCheckTimer) {
    clearInterval(autoCheckTimer);
    autoCheckTimer = null;
  }
  if (autoCheckEnabled()) {
    checkForUpdates();
    autoCheckTimer = setInterval(checkForUpdates, CHECK_INTERVAL);
  }
}

// isSilent:false lets the NSIS installer show its progress; isForceRunAfter
// relaunches the app once the update is applied.
function quitAndInstall() {
  if (!autoUpdater || state.status !== 'ready') return { ok: false, error: 'NO_UPDATE_READY' };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}

function initAutoUpdater() {
  // Nothing to update when running from source (`npm start`) — and
  // electron-updater throws in that case rather than no-opping.
  if (!app.isPackaged) return;

  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setState({ status: 'downloading', version: info && info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setState({ status: 'idle', version: null, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => setState({ status: 'ready', version: info && info.version, percent: 100 }));
  autoUpdater.on('error', (err) => setState({ status: 'error', error: String((err && err.message) || err) }));

  applyAutoCheckSetting();
}

module.exports = { initAutoUpdater, getUpdateState, checkForUpdates, quitAndInstall, applyAutoCheckSetting };
