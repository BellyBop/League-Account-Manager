'use strict';

// Single source of truth for IPC channel names, required by the main
// process's ipc/*.js handlers. preload.js can't require this file (Electron's
// sandboxed preload context only permits requiring 'electron' + Node
// built-ins) — it keeps its own inlined copy of these same strings, which
// must be kept in sync with this file if a channel name ever changes.
module.exports = {
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
