'use strict';

const fs = require('fs');
const { ipcMain, BrowserWindow, dialog, shell } = require('electron');
const channels = require('../ipcChannels');
const { getSettings, writeJson, accountsPath, settingsPath, autoBackupDir } = require('../lib/store');
const { buildBackupPayload } = require('../lib/backup');
const { todayKey } = require('../lib/rank');

function registerBackupIpc() {
  // Auto-backups save silently to a fixed folder rather than a chosen file, so
  // this just reveals that folder for anyone who wants to check or grab one.
  ipcMain.handle(channels.BACKUP_OPEN_AUTO_FOLDER, () => {
    fs.mkdirSync(autoBackupDir(), { recursive: true });
    shell.openPath(autoBackupDir());
  });

  ipcMain.handle(channels.BACKUP_EXPORT, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Backup account data',
      defaultPath: `league-acc-manager-backup-${todayKey()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, error: 'CANCELED' };

    writeJson(filePath, buildBackupPayload());
    return { ok: true, filePath };
  });

  ipcMain.handle(channels.BACKUP_IMPORT, async () => {
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

    const restored = parsed.accounts.map((a, i) => ({
      id: a.id || (Date.now().toString(36) + i.toString(36) + Math.random().toString(36).slice(2, 6)),
      label: a.label || 'Smurf',
      riotId: a.riotId || '',
      region: a.region || 'oce',
      email: a.email || '',
      loginUsername: a.loginUsername || '',
      notes: a.notes || '',
      sessionLP: a.sessionLP || null,
      todayMatches: a.todayMatches || null,
      goal: a.goal || null,
      goalProgress: a.goalProgress || null,
      favorite: a.favorite || false,
      cache: null,
    }));
    writeJson(accountsPath(), restored);

    if (parsed.defaultRegion) {
      writeJson(settingsPath(), { ...getSettings(), defaultRegion: parsed.defaultRegion });
    }

    return { ok: true, count: restored.length };
  });
}

module.exports = { registerBackupIpc };
