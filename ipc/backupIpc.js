'use strict';

const fs = require('fs');
const { ipcMain, BrowserWindow, dialog, shell } = require('electron');
const channels = require('../ipcChannels');
const { getSettings, saveSettings, writeJson, accountsPath, settingsPath } = require('../lib/store');
const {
  buildBackupPayload,
  localBackupTargetDir,
  normalizeRestoredAccounts,
  snapshotBeforeRestore,
  undoLastRestore,
  decryptCachedPassphrase,
  setBackupPassphrase,
  clearBackupPassphrase,
  verifyPassphrase,
  createPasswordResolver,
} = require('../lib/backup');
const { todayKey } = require('../lib/rank');

function registerBackupIpc() {
  // Reveals wherever local auto-backups are actually landing right now — the
  // built-in folder, or a custom one if BACKUP_CHOOSE_AUTO_FOLDER below has
  // been used — same "choose one, open it" shape as cloud backup's folder.
  // localBackupFolder is user-choosable (unlike the always-writable built-in
  // folder under userData), so this can now legitimately fail — e.g. it was
  // pointed at a drive that's since been unplugged.
  ipcMain.handle(channels.BACKUP_OPEN_AUTO_FOLDER, () => {
    try {
      const dir = localBackupTargetDir();
      fs.mkdirSync(dir, { recursive: true });
      shell.openPath(dir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'FOLDER_UNAVAILABLE' };
    }
  });

  ipcMain.handle(channels.BACKUP_CHOOSE_AUTO_FOLDER, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for local auto-backups',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return { ok: false, error: 'CANCELED' };

    saveSettings({ ...getSettings(), localBackupFolder: filePaths[0] });
    return { ok: true, folder: filePaths[0] };
  });

  ipcMain.handle(channels.BACKUP_EXPORT, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Backup account data',
      defaultPath: `league-acc-manager-backup-${todayKey()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, error: 'CANCELED' };

    const settings = getSettings();
    let passphrase = null;
    let passphraseUnavailable = false;
    if (settings.localBackupIncludePasswords) {
      passphrase = decryptCachedPassphrase();
      if (!passphrase) passphraseUnavailable = true;
    }

    const payload = buildBackupPayload(passphrase);
    writeJson(filePath, payload);
    // passphraseUnavailable: the export still succeeds without passwords if
    // the local passphrase cache is gone (e.g. a fresh DPAPI/Windows
    // profile) — the renderer uses this to nudge re-entering it in Settings
    // rather than silently shipping password-less exports forever.
    return { ok: true, filePath, passwordsIncluded: payload.passwordsIncluded, passphraseUnavailable };
  });

  ipcMain.handle(channels.BACKUP_IMPORT, async (_e, { passphrase } = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Restore account data',
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
    if (!parsed || !Array.isArray(parsed.accounts)) return { ok: false, error: 'BAD_FILE' };

    const resolver = createPasswordResolver(parsed.accounts, passphrase);
    if (resolver.error) return { ok: false, error: resolver.error };

    // Restoring fully replaces accounts.json — take an undo-able snapshot of
    // what's there right now first. Only a real failure to snapshot existing
    // data aborts the restore; NOTHING_TO_PROTECT (no accounts.json yet)
    // just means there's nothing this restore could be destroying.
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

  // Puts accounts.json back exactly as it was right before the most recent
  // restore (local or cloud — both take a snapshot via snapshotBeforeRestore
  // before they touch anything). Single-level: undoing doesn't itself create
  // a further undo point, same as the existing delete-account undo toast.
  ipcMain.handle(channels.BACKUP_UNDO_LAST_RESTORE, () => undoLastRestore());

  // --- Backup passphrase (shared by local and cloud backups) ----------------
  ipcMain.handle(channels.BACKUP_SET_PASSPHRASE, (_e, passphrase) => {
    if (!passphrase || passphrase.length < 8) return { ok: false, error: 'TOO_SHORT' };
    try {
      setBackupPassphrase(passphrase);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'ENCRYPTION_FAILED' };
    }
  });

  ipcMain.handle(channels.BACKUP_CLEAR_PASSPHRASE, () => {
    clearBackupPassphrase();
    return { ok: true };
  });

  // Lets the renderer check a freshly-typed passphrase against what backups
  // are currently encrypted with, without needing an actual backup file on
  // hand to test it against (e.g. right after typing it into the "change
  // passphrase" field, or before a restore on a machine with nothing cached).
  ipcMain.handle(channels.BACKUP_VERIFY_PASSPHRASE, (_e, passphrase) => {
    return { ok: true, valid: verifyPassphrase(passphrase) };
  });
}

module.exports = { registerBackupIpc };
