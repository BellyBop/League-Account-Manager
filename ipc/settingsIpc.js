'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { getSettings, saveSettings } = require('../lib/store');
const { resetApiKeyExpiryNotifications } = require('../lib/notifications');
const { applyLaunchOnStartup } = require('../lib/autoLaunch');
const { applyAutoCheckSetting } = require('../lib/updater');

// The backup passphrase (shared by local and cloud backups, see
// lib/backup.js) never needs to reach the renderer once set — only whether
// one exists, so the UI knows whether to show "Set passphrase" or "Change
// passphrase". The encrypted blob and verifier are mutated only through
// their own dedicated IPC channels (ipc/backupIpc.js), never through this
// generic get/save pair.
function sanitizeSettingsForRenderer(settings) {
  const { backupPassphraseEncrypted, backupVerifier, ...rest } = settings;
  return { ...rest, backupPassphraseSet: Boolean(backupPassphraseEncrypted) };
}

function registerSettingsIpc() {
  ipcMain.handle(channels.SETTINGS_GET, () => sanitizeSettingsForRenderer(getSettings()));

  ipcMain.handle(channels.SETTINGS_SAVE, (_e, settings) => {
    // Defense in depth alongside sanitizeSettingsForRenderer above — even if
    // something in the renderer echoed these back on a save, they can't be
    // set through this generic path.
    const { backupPassphraseEncrypted, backupVerifier, backupPassphraseSet, ...incoming } = settings;
    const current = getSettings();
    const merged = { ...current, ...incoming };
    // Track when the key was pasted so we can warn before it expires (~24h).
    if (typeof settings.apiKey === 'string' && settings.apiKey !== current.apiKey) {
      merged.apiKeySavedAt = settings.apiKey ? Date.now() : null;
      resetApiKeyExpiryNotifications();
    }
    if (typeof settings.launchOnStartup === 'boolean' && settings.launchOnStartup !== current.launchOnStartup) {
      applyLaunchOnStartup(settings.launchOnStartup);
    }
    saveSettings(merged);
    if (typeof settings.autoUpdateCheck === 'boolean' && settings.autoUpdateCheck !== current.autoUpdateCheck) {
      applyAutoCheckSetting(); // reads the setting we just saved
    }
    return sanitizeSettingsForRenderer(merged);
  });
}

module.exports = { registerSettingsIpc };
