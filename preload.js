'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Channel name strings are inlined here rather than required from
// ipcChannels.js: preload scripts run in Electron's sandboxed context (the
// default since Electron 20), which only permits requiring 'electron' and a
// handful of Node built-ins — requiring an arbitrary local file like
// ipcChannels.js fails silently at load time and takes window.api down with
// it. Keep these in sync with ipcChannels.js (used by the main-process
// ipc/*.js handlers) if a channel name ever changes.
const channels = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',

  ACCOUNTS_GET: 'accounts:get',
  ACCOUNTS_ADD: 'accounts:add',
  ACCOUNTS_UPDATE: 'accounts:update',
  ACCOUNTS_DELETE: 'accounts:delete',
  ACCOUNTS_RESTORE: 'accounts:restore',
  ACCOUNTS_REORDER: 'accounts:reorder',
  ACCOUNTS_SET_GOAL: 'accounts:setGoal',
  ACCOUNTS_CLEAR_GOAL: 'accounts:clearGoal',
  ACCOUNTS_SET_PASSWORD: 'accounts:setPassword',
  ACCOUNTS_COPY_PASSWORD: 'accounts:copyPassword',

  RIOT_FETCH: 'riot:fetch',
  RIOT_REGIONS: 'riot:regions',
  RIOT_VALIDATE_KEY: 'riot:validateKey',
  RIOT_CHAMPION_CATALOG: 'riot:championCatalog',

  SHELL_OPEN: 'shell:open',

  CLIPBOARD_WRITE: 'clipboard:write',
  RIOTCLIENT_LAUNCH: 'riotclient:launch',
  RIOTCLIENT_SIGN_OUT: 'riotclient:signOut',

  MASTERY_GET: 'mastery:get',
  MASTERY_REFRESH: 'mastery:refresh',
  MASTERY_SYNC: 'mastery:sync',

  BACKUP_EXPORT: 'backup:export',
  BACKUP_IMPORT: 'backup:import',
  BACKUP_OPEN_AUTO_FOLDER: 'backup:openAutoFolder',
  BACKUP_CHOOSE_AUTO_FOLDER: 'backup:chooseAutoFolder',
  BACKUP_UNDO_LAST_RESTORE: 'backup:undoLastRestore',
  BACKUP_SET_PASSPHRASE: 'backup:setPassphrase',
  BACKUP_CLEAR_PASSPHRASE: 'backup:clearPassphrase',
  BACKUP_VERIFY_PASSPHRASE: 'backup:verifyPassphrase',

  CLOUD_BACKUP_CHOOSE_FOLDER: 'cloudBackup:chooseFolder',
  CLOUD_BACKUP_OPEN_FOLDER: 'cloudBackup:openFolder',
  CLOUD_BACKUP_RUN_NOW: 'cloudBackup:runNow',
  CLOUD_BACKUP_RESTORE: 'cloudBackup:restore',

  LEAGUE_CLIENT_STATUS: 'leagueClient:status',

  APP_GET_VERSION: 'app:getVersion',

  UPDATE_STATUS: 'update:status',
  UPDATE_GET_STATUS: 'update:getStatus',
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
};

// Expose a small, safe API surface to the renderer. No Node access leaks.
contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke(channels.SETTINGS_GET),
  saveSettings: (settings) => ipcRenderer.invoke(channels.SETTINGS_SAVE, settings),

  getAccounts: () => ipcRenderer.invoke(channels.ACCOUNTS_GET),
  addAccount: (account) => ipcRenderer.invoke(channels.ACCOUNTS_ADD, account),
  updateAccount: (id, changes) => ipcRenderer.invoke(channels.ACCOUNTS_UPDATE, { id, changes }),
  deleteAccount: (id) => ipcRenderer.invoke(channels.ACCOUNTS_DELETE, id),
  restoreAccount: (account, index) => ipcRenderer.invoke(channels.ACCOUNTS_RESTORE, { account, index }),
  reorderAccounts: (orderedIds) => ipcRenderer.invoke(channels.ACCOUNTS_REORDER, orderedIds),
  setAccountGoal: (id, tier, division) => ipcRenderer.invoke(channels.ACCOUNTS_SET_GOAL, { id, tier, division }),
  clearAccountGoal: (id) => ipcRenderer.invoke(channels.ACCOUNTS_CLEAR_GOAL, id),
  setAccountPassword: (id, password) => ipcRenderer.invoke(channels.ACCOUNTS_SET_PASSWORD, { id, password }),
  copyAccountPassword: (id) => ipcRenderer.invoke(channels.ACCOUNTS_COPY_PASSWORD, id),

  fetchAccountData: (id) => ipcRenderer.invoke(channels.RIOT_FETCH, { id }),
  getRegions: () => ipcRenderer.invoke(channels.RIOT_REGIONS),
  validateApiKey: () => ipcRenderer.invoke(channels.RIOT_VALIDATE_KEY),
  getChampionCatalog: () => ipcRenderer.invoke(channels.RIOT_CHAMPION_CATALOG),

  openExternal: (url) => ipcRenderer.invoke(channels.SHELL_OPEN, url),

  copyToClipboard: (text) => ipcRenderer.invoke(channels.CLIPBOARD_WRITE, text),
  launchRiotClient: () => ipcRenderer.invoke(channels.RIOTCLIENT_LAUNCH),
  signOutRiotClient: () => ipcRenderer.invoke(channels.RIOTCLIENT_SIGN_OUT),

  getMastery: () => ipcRenderer.invoke(channels.MASTERY_GET),
  refreshMastery: () => ipcRenderer.invoke(channels.MASTERY_REFRESH),
  syncMastery: () => ipcRenderer.invoke(channels.MASTERY_SYNC),

  exportBackup: () => ipcRenderer.invoke(channels.BACKUP_EXPORT),
  importBackup: (passphrase) => ipcRenderer.invoke(channels.BACKUP_IMPORT, { passphrase }),
  openAutoBackupFolder: () => ipcRenderer.invoke(channels.BACKUP_OPEN_AUTO_FOLDER),
  chooseAutoBackupFolder: () => ipcRenderer.invoke(channels.BACKUP_CHOOSE_AUTO_FOLDER),
  undoLastRestore: () => ipcRenderer.invoke(channels.BACKUP_UNDO_LAST_RESTORE),
  setBackupPassphrase: (passphrase) => ipcRenderer.invoke(channels.BACKUP_SET_PASSPHRASE, passphrase),
  clearBackupPassphrase: () => ipcRenderer.invoke(channels.BACKUP_CLEAR_PASSPHRASE),
  verifyBackupPassphrase: (passphrase) => ipcRenderer.invoke(channels.BACKUP_VERIFY_PASSPHRASE, passphrase),

  chooseCloudBackupFolder: () => ipcRenderer.invoke(channels.CLOUD_BACKUP_CHOOSE_FOLDER),
  openCloudBackupFolder: () => ipcRenderer.invoke(channels.CLOUD_BACKUP_OPEN_FOLDER),
  runCloudBackupNow: () => ipcRenderer.invoke(channels.CLOUD_BACKUP_RUN_NOW),
  restoreCloudBackup: (passphrase) => ipcRenderer.invoke(channels.CLOUD_BACKUP_RESTORE, { passphrase }),

  getActiveAccountStatus: (opts) => ipcRenderer.invoke(channels.LEAGUE_CLIENT_STATUS, opts),

  getAppVersion: () => ipcRenderer.invoke(channels.APP_GET_VERSION),

  getUpdateStatus: () => ipcRenderer.invoke(channels.UPDATE_GET_STATUS),
  checkForUpdate: () => ipcRenderer.invoke(channels.UPDATE_CHECK),
  installUpdate: () => ipcRenderer.invoke(channels.UPDATE_INSTALL),
  onUpdateStatus: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on(channels.UPDATE_STATUS, listener);
    return () => ipcRenderer.removeListener(channels.UPDATE_STATUS, listener);
  },

  // Page zoom (Ctrl +/-/0, Ctrl+scroll) — webFrame acts on this renderer's own
  // frame directly and synchronously, no IPC round trip to the main process
  // needed. Persisting the chosen level across launches is a separate,
  // explicit saveSettings() call the renderer makes after changing it.
  getZoomLevel: () => webFrame.getZoomLevel(),
  setZoomLevel: (level) => webFrame.setZoomLevel(level),
});
