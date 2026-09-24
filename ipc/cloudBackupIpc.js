'use strict';

const fs = require('fs');
const { ipcMain, BrowserWindow, dialog, shell } = require('electron');
const channels = require('../ipcChannels');
const { getSettings, saveSettings, accountsPath, settingsPath, writeJson } = require('../lib/store');
const { normalizeRestoredAccounts, snapshotBeforeRestore, createPasswordResolver, decryptCachedPassphrase } = require('../lib/backup');
const { CLOUD_BACKUP_KIND, writeCloudBackupNow } = require('../lib/cloudBackup');

function registerCloudBackupIpc() {
  ipcMain.handle(channels.CLOUD_BACKUP_CHOOSE_FOLDER, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a cloud-synced folder for backups',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return { ok: false, error: 'CANCELED' };

    saveSettings({ ...getSettings(), cloudBackupFolder: filePaths[0] });
    return { ok: true, folder: filePaths[0] };
  });

  ipcMain.handle(channels.CLOUD_BACKUP_OPEN_FOLDER, () => {
    const folder = getSettings().cloudBackupFolder;
    if (!folder) return { ok: false, error: 'NO_FOLDER' };
    try {
      fs.mkdirSync(folder, { recursive: true });
      shell.openPath(folder);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'FOLDER_UNAVAILABLE' };
    }
  });

  ipcMain.handle(channels.CLOUD_BACKUP_RUN_NOW, () => {
    const settings = getSettings();
    if (!settings.cloudBackupFolder) return { ok: false, error: 'NO_FOLDER' };

    let passphrase = null;
    let passphraseUnavailable = false;
    if (settings.cloudBackupIncludePasswords) {
      passphrase = decryptCachedPassphrase();
      if (!passphrase) passphraseUnavailable = true;
    }

    const result = writeCloudBackupNow(passphrase);
    if (!result.ok) return result;
    // Backup still succeeds without passwords if the local passphrase cache
    // is gone (e.g. this is a fresh DPAPI/Windows profile) — the renderer
    // uses this flag to nudge the user to re-enter it in Settings rather
    // than silently shipping password-less backups forever.
    return { ...result, passphraseUnavailable };
  });

  // Cloud backups live in a user-chosen folder rather than a fixed one, so
  // the file picker starts there instead of the renderer having to know the
  // path.
  ipcMain.handle(channels.CLOUD_BACKUP_RESTORE, async (_e, { passphrase } = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const settings = getSettings();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Restore from cloud backup',
      defaultPath: settings.cloudBackupFolder || undefined,
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return { ok: false, error: 'CANCELED' };

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    } catch (e) {
      return { ok: false, error: 'BAD_FILE' };
    }
    if (!parsed || parsed.kind !== CLOUD_BACKUP_KIND || !Array.isArray(parsed.accounts)) {
      return { ok: false, error: 'BAD_FILE' };
    }

    const resolver = createPasswordResolver(parsed.accounts, passphrase);
    if (resolver.error) return { ok: false, error: resolver.error };

    // Restoring fully replaces accounts.json — take an undo-able snapshot of
    // what's there right now first. Only a real failure to snapshot existing
    // data aborts the restore; NOTHING_TO_PROTECT (no accounts.json yet) just
    // means there's nothing this restore could be destroying.
    const snapshot = snapshotBeforeRestore();
    if (!snapshot.ok && snapshot.reason === 'SNAPSHOT_FAILED') {
      return { ok: false, error: 'SNAPSHOT_FAILED' };
    }

    const restored = normalizeRestoredAccounts(parsed.accounts, { resolvePassword: resolver.resolvePassword });
    writeJson(accountsPath(), restored);

    if (parsed.defaultRegion) {
      writeJson(settingsPath(), { ...getSettings(), defaultRegion: parsed.defaultRegion });
    }

    return {
      ok: true,
      count: restored.length,
      passwordsAvailable: Boolean(parsed.passwordsIncluded),
      passwordsRestored: resolver.wasAnyPasswordRestored(),
    };
  });
}

module.exports = { registerCloudBackupIpc };
