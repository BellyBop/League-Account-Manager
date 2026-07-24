'use strict';

const { ipcMain, clipboard, shell } = require('electron');
const { spawn } = require('child_process');
const channels = require('../ipcChannels');
const { findRiotClientPath, endRiotClientSession } = require('../lib/riotClient');
const { closeLeagueClient } = require('../lib/leagueClientApi');

const SIGN_OUT_RETRY_ATTEMPTS = 5;
const SIGN_OUT_RETRY_DELAY_MS = 1000;

function registerMiscIpc() {
  // Open a URL in the user's default browser.
  ipcMain.handle(channels.SHELL_OPEN, (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // Clipboard + Riot Client launch (1-click sign-in).
  ipcMain.handle(channels.CLIPBOARD_WRITE, (_e, text) => {
    clipboard.writeText(typeof text === 'string' ? text : '');
    return true;
  });

  ipcMain.handle(channels.RIOTCLIENT_LAUNCH, () => {
    const exePath = findRiotClientPath();
    if (!exePath) return { ok: false, error: 'CLIENT_NOT_FOUND' };
    try {
      const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // A real sign-out via the Riot Client's own local API (see
  // endRiotClientSession in lib/riotClient.js) — verified live to actually
  // end the session (persist:false, phase:"not_logged_in"), not just close
  // a window. Riot Client's own API refuses to do this at all while League
  // is still running (confirmed live: "sign_out_failed_other_games_running"),
  // so League has to be closed — gracefully, via its own shutdown endpoint,
  // not killed — first. closeLeagueClient() already waits for League's own
  // lockfile to disappear, but Riot Client's internal "is a game running"
  // bookkeeping can lag a moment behind that file being gone (confirmed
  // live: the exact same sign-out call that fails immediately after succeeds
  // a moment later with nothing else changed) — so retry specifically
  // through that error instead of surfacing a spurious failure.
  ipcMain.handle(channels.RIOTCLIENT_SIGN_OUT, async () => {
    const closeResult = await closeLeagueClient();
    if (!closeResult.ok) return { ok: false, error: `couldn't close League Client first (${closeResult.error})` };

    let result;
    for (let attempt = 0; attempt < SIGN_OUT_RETRY_ATTEMPTS; attempt++) {
      result = await endRiotClientSession();
      if (result.ok || result.errorSlug !== 'sign_out_failed_other_games_running') break;
      await new Promise((resolve) => setTimeout(resolve, SIGN_OUT_RETRY_DELAY_MS));
    }
    return result;
  });
}

module.exports = { registerMiscIpc };
