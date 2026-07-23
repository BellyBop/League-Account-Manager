'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { getSettings, saveSettings } = require('../lib/store');
const { resetApiKeyExpiryNotifications } = require('../lib/notifications');

function registerSettingsIpc() {
  ipcMain.handle(channels.SETTINGS_GET, () => getSettings());

  ipcMain.handle(channels.SETTINGS_SAVE, (_e, settings) => {
    const current = getSettings();
    const merged = { ...current, ...settings };
    // Track when the key was pasted so we can warn before it expires (~24h).
    if (typeof settings.apiKey === 'string' && settings.apiKey !== current.apiKey) {
      merged.apiKeySavedAt = settings.apiKey ? Date.now() : null;
      resetApiKeyExpiryNotifications();
    }
    saveSettings(merged);
    return merged;
  });
}

module.exports = { registerSettingsIpc };
