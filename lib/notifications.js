'use strict';

// --- API key expiry notifications --------------------------------------------
// Riot dev keys expire ~24h after issue and there's no endpoint to check their
// remaining lifetime, so we approximate using when the key was pasted in.

const { Notification } = require('electron');
const { getSettings } = require('./store');
const { HOUR } = require('./constants');

let notifiedExpiringForKey = null;
let notifiedExpiredForKey = null;

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

function checkApiKeyExpiry() {
  const settings = getSettings();
  if (!settings.apiKey || !settings.apiKeySavedAt) return;
  const age = Date.now() - settings.apiKeySavedAt;

  if (age >= 23.5 * HOUR && age < 24 * HOUR && notifiedExpiringForKey !== settings.apiKey) {
    notifiedExpiringForKey = settings.apiKey;
    notify('Riot API key expiring soon', 'Your dev key expires in about 30 minutes — grab a fresh one from developer.riotgames.com.');
  }
  if (age >= 24 * HOUR && notifiedExpiredForKey !== settings.apiKey) {
    notifiedExpiredForKey = settings.apiKey;
    notify('Riot API key expired', 'Paste a fresh key in Settings to keep your account cards updating.');
  }
}

// Called whenever a new key is saved, so the old key's notification state
// doesn't suppress notifications for the new one.
function resetApiKeyExpiryNotifications() {
  notifiedExpiringForKey = null;
  notifiedExpiredForKey = null;
}

module.exports = { checkApiKeyExpiry, resetApiKeyExpiryNotifications };
