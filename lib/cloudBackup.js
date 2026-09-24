'use strict';

// ---------------------------------------------------------------------------
// Cloud backup: writes the same payload as a manual/local-auto backup (see
// buildBackupPayload in lib/backup.js — this just tags it with a `kind`
// marker), but to a folder the user points at their own cloud-synced
// directory (OneDrive, Google Drive, Dropbox, ...) instead of the fixed local
// auto-backup folder. Whatever syncs that folder to the cloud is not this
// app's problem — this just has to write a plain file there. That also means
// there's no account to sign into, no API key to ship, and nothing that can
// be revoked or rate-limited out from under it.
//
// The backup passphrase (used if "include passwords" is on) is shared with
// local backups too — see lib/backup.js for that and for why it isn't
// cloud-specific.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { getSettings, saveSettings, getAccounts, writeJson } = require('./store');
const { todayKey } = require('./rank');
const { HOUR } = require('./constants');
const { buildBackupPayload, decryptCachedPassphrase } = require('./backup');

const CLOUD_BACKUP_KIND = 'league-acc-manager-cloud-backup';
const CLOUD_BACKUP_PREFIX = 'league-acc-manager-cloud-backup-';
const CLOUD_BACKUP_INTERVAL = 6 * HOUR;
const CLOUD_BACKUP_KEEP = 5;

function listCloudBackups(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(CLOUD_BACKUP_PREFIX) && f.endsWith('.json'))
      .sort();
  } catch (e) {
    return [];
  }
}

function buildCloudBackupPayload(passphrase) {
  return { ...buildBackupPayload(passphrase), kind: CLOUD_BACKUP_KIND };
}

function writeCloudBackupNow(passphrase) {
  const settings = getSettings();
  if (!settings.cloudBackupFolder) return { ok: false, error: 'NO_FOLDER' };

  const dir = settings.cloudBackupFolder;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: 'FOLDER_UNAVAILABLE' };
  }

  const payload = buildCloudBackupPayload(passphrase);
  const filePath = path.join(dir, `${CLOUD_BACKUP_PREFIX}${todayKey()}-${Date.now()}.json`);
  writeJson(filePath, payload);

  const updated = listCloudBackups(dir);
  for (const stale of updated.slice(0, Math.max(0, updated.length - CLOUD_BACKUP_KEEP))) {
    try {
      fs.unlinkSync(path.join(dir, stale));
    } catch (e) {
      // Non-fatal — cleaned up on a later pass, or by the sync client's own history.
    }
  }

  saveSettings({ ...getSettings(), lastCloudBackupAt: Date.now() });
  return { ok: true, filePath, passwordsIncluded: payload.passwordsIncluded };
}

// Called on a timer (see main.js) — silent, best-effort, never surfaces
// errors anywhere (a missing/unmounted sync folder just means try again next
// interval).
function runCloudBackupIfDue() {
  const settings = getSettings();
  if (!settings.cloudBackupEnabled || !settings.cloudBackupFolder) return;
  if (getAccounts().length === 0) return;

  const existing = listCloudBackups(settings.cloudBackupFolder);
  const last = existing[existing.length - 1];
  if (last) {
    try {
      const age = Date.now() - fs.statSync(path.join(settings.cloudBackupFolder, last)).mtimeMs;
      if (age < CLOUD_BACKUP_INTERVAL) return; // not due yet
    } catch (e) {
      // Folder/file vanished since listing — fall through and just try to write.
    }
  }

  const passphrase = settings.cloudBackupIncludePasswords ? decryptCachedPassphrase() : null;
  writeCloudBackupNow(passphrase);
}

module.exports = {
  CLOUD_BACKUP_KIND,
  buildCloudBackupPayload,
  writeCloudBackupNow,
  runCloudBackupIfDue,
  listCloudBackups,
};
