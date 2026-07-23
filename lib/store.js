'use strict';

// ---------------------------------------------------------------------------
// Simple JSON file storage in the app's userData folder. All persistence in
// the app goes through here, so the on-disk layout only needs to change in
// one place.
// ---------------------------------------------------------------------------

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const dataDir = () => app.getPath('userData');
const settingsPath = () => path.join(dataDir(), 'settings.json');
const accountsPath = () => path.join(dataDir(), 'accounts.json');
const masteryPath = () => path.join(dataDir(), 'mastery.json');
const matchCachePath = () => path.join(dataDir(), 'matchCache.json');
const autoBackupDir = () => path.join(dataDir(), 'auto-backups');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getSettings() {
  return readJson(settingsPath(), { apiKey: '', apiKeySavedAt: null, defaultRegion: 'oce', compactView: false });
}

function saveSettings(settings) {
  writeJson(settingsPath(), settings);
}

function getAccounts() {
  return readJson(accountsPath(), []);
}

function saveAccounts(accounts) {
  writeJson(accountsPath(), accounts);
}

function getMastery() {
  return readJson(masteryPath(), null);
}

function saveMastery(widget) {
  writeJson(masteryPath(), widget);
}

module.exports = {
  dataDir,
  settingsPath,
  accountsPath,
  matchCachePath,
  autoBackupDir,
  readJson,
  writeJson,
  getSettings,
  saveSettings,
  getAccounts,
  saveAccounts,
  getMastery,
  saveMastery,
};
