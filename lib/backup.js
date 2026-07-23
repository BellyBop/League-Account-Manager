'use strict';

const fs = require('fs');
const path = require('path');
const { getSettings, getAccounts, writeJson, autoBackupDir } = require('./store');
const { todayKey } = require('./rank');
const { HOUR } = require('./constants');

// Only backs up data Riot's API can't give back to us (label, notes, email,
// login username, session history) — cache is refetchable and the API key
// expires daily anyway, so neither is included.
function buildBackupPayload() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    defaultRegion: getSettings().defaultRegion,
    accounts: getAccounts().map(({ cache, ...rest }) => rest),
  };
}

// --- Automatic scheduled backups ---------------------------------------------
// Same data as a manual export, just saved silently to a fixed folder on a
// timer instead of requiring the user to remember to click a button.
const AUTO_BACKUP_INTERVAL = 24 * HOUR;
const AUTO_BACKUP_KEEP = 7;

function listAutoBackups(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('auto-backup-') && f.endsWith('.json'))
      .sort();
  } catch (e) {
    return [];
  }
}

function runAutoBackupIfDue() {
  if (getAccounts().length === 0) return; // nothing worth backing up yet

  const dir = autoBackupDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return;
  }

  const existing = listAutoBackups(dir);
  const last = existing[existing.length - 1];
  if (last) {
    const age = Date.now() - fs.statSync(path.join(dir, last)).mtimeMs;
    if (age < AUTO_BACKUP_INTERVAL) return; // not due yet
  }

  writeJson(path.join(dir, `auto-backup-${todayKey()}-${Date.now()}.json`), buildBackupPayload());

  // Prune down to the most recent AUTO_BACKUP_KEEP files.
  const updated = listAutoBackups(dir);
  for (const stale of updated.slice(0, Math.max(0, updated.length - AUTO_BACKUP_KEEP))) {
    try {
      fs.unlinkSync(path.join(dir, stale));
    } catch (e) {
      // Non-fatal — it'll just get cleaned up on a later pass.
    }
  }
}

module.exports = { buildBackupPayload, runAutoBackupIfDue };
