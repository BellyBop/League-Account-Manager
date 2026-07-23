'use strict';

const { ipcMain } = require('electron');
const channels = require('../ipcChannels');
const { getSettings, getAccounts, saveAccounts } = require('../lib/store');
const { setAccountGoal, clearAccountGoal, computeGoalProgress } = require('../lib/goals');
const { computeNetLpToday } = require('../lib/lpLog');

function registerAccountsIpc() {
  // netLpToday is otherwise only recomputed inside recordLpDelta, i.e. when a
  // game just ended — so on a day with no games yet it would keep showing
  // yesterday's stale total instead of resetting. Recompute it fresh from
  // the log (which is already date-filtered) on every fetch instead.
  ipcMain.handle(channels.ACCOUNTS_GET, () => {
    const accounts = getAccounts();
    for (const account of accounts) {
      account.netLpToday = computeNetLpToday(account);
    }
    return accounts;
  });

  ipcMain.handle(channels.ACCOUNTS_ADD, (_e, account) => {
    const accounts = getAccounts();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    accounts.push({
      id,
      label: account.label || 'Smurf',
      riotId: account.riotId || '',
      region: account.region || getSettings().defaultRegion || 'oce',
      email: account.email || '',
      loginUsername: account.loginUsername || '',
      notes: account.notes || '',
      cache: null,
    });
    saveAccounts(accounts);
    return accounts;
  });

  ipcMain.handle(channels.ACCOUNTS_UPDATE, (_e, { id, changes }) => {
    const accounts = getAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx !== -1) {
      accounts[idx] = { ...accounts[idx], ...changes };
      saveAccounts(accounts);
    }
    return accounts;
  });

  ipcMain.handle(channels.ACCOUNTS_DELETE, (_e, id) => {
    const accounts = getAccounts().filter((a) => a.id !== id);
    saveAccounts(accounts);
    return accounts;
  });

  // Undo for the above — re-inserts the exact account object (same id, cache,
  // session/goal history) at its original index, rather than going through
  // accounts:add, which would generate a new id and lose all of that.
  ipcMain.handle(channels.ACCOUNTS_RESTORE, (_e, { account, index }) => {
    const accounts = getAccounts();
    if (!accounts.find((a) => a.id === account.id)) {
      if (typeof index === 'number' && index >= 0 && index <= accounts.length) {
        accounts.splice(index, 0, account);
      } else {
        accounts.push(account);
      }
      saveAccounts(accounts);
    }
    return accounts;
  });

  // Persists a manual drag-to-reorder — orderedIds is every account id in its
  // new display order. Anything missing from it (shouldn't normally happen)
  // gets appended at the end rather than silently dropped.
  ipcMain.handle(channels.ACCOUNTS_REORDER, (_e, orderedIds) => {
    const accounts = getAccounts();
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const reordered = [];
    for (const id of orderedIds) {
      if (byId.has(id)) {
        reordered.push(byId.get(id));
        byId.delete(id);
      }
    }
    reordered.push(...byId.values());
    saveAccounts(reordered);
    return reordered;
  });

  ipcMain.handle(channels.ACCOUNTS_SET_GOAL, (_e, { id, tier, division }) => {
    const accounts = getAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx === -1) return { ok: false, error: 'NOT_FOUND' };

    const goal = setAccountGoal(accounts[idx], tier, division);
    const goalProgress = accounts[idx].cache ? computeGoalProgress(accounts[idx], accounts[idx].cache) : null;
    saveAccounts(accounts);
    return { ok: true, goal, goalProgress };
  });

  ipcMain.handle(channels.ACCOUNTS_CLEAR_GOAL, (_e, id) => {
    const accounts = getAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx === -1) return { ok: false, error: 'NOT_FOUND' };

    clearAccountGoal(accounts[idx]);
    saveAccounts(accounts);
    return { ok: true };
  });
}

module.exports = { registerAccountsIpc };
