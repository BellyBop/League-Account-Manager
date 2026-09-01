'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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

  LEAGUE_CLIENT_STATUS: 'leagueClient:status',

  APP_GET_VERSION: 'app:getVersion',
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
  importBackup: () => ipcRenderer.invoke(channels.BACKUP_IMPORT),
  openAutoBackupFolder: () => ipcRenderer.invoke(channels.BACKUP_OPEN_AUTO_FOLDER),

  getActiveAccountStatus: (opts) => ipcRenderer.invoke(channels.LEAGUE_CLIENT_STATUS, opts),

  getAppVersion: () => ipcRenderer.invoke(channels.APP_GET_VERSION),
});
