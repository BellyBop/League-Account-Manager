'use strict';

// Riot records the install location of RiotClientServices.exe in this manifest
// on every Windows install, so we can launch it without asking the user to
// browse for it.

const fs = require('fs');
const path = require('path');
const https = require('https');

const RIOT_CLIENT_MANIFEST = 'C:\\ProgramData\\Riot Games\\RiotClientInstalls.json';
const RIOT_CLIENT_FALLBACK = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';

// A self-signed cert is normal for this local API — always 127.0.0.1, never
// anything remote. Same convention as the League Client's own local API in
// lib/leagueClientApi.js.
const localAgent = new https.Agent({ rejectUnauthorized: false });

// Shared by anything that needs to locate the Riot/League install — also
// used by lib/leagueClientApi.js to find the League of Legends directory
// (the key of `associated_client`) for reading its lockfile.
function readInstallManifest() {
  try {
    return JSON.parse(fs.readFileSync(RIOT_CLIENT_MANIFEST, 'utf8'));
  } catch (e) {
    return null;
  }
}

function findRiotClientPath() {
  const manifest = readInstallManifest();
  if (manifest) {
    for (const key of ['rc_default', 'rc_live']) {
      if (manifest[key] && fs.existsSync(manifest[key])) return manifest[key];
    }
  }
  return fs.existsSync(RIOT_CLIENT_FALLBACK) ? RIOT_CLIENT_FALLBACK : null;
}

// The Riot Client's own local API — a separate service and lockfile from the
// League Client's LCU (see lib/leagueClientApi.js), always at this fixed
// path rather than derived from an install manifest. Same lockfile format
// and Basic-auth scheme as the LCU (verified live against a running client:
// same "name:pid:port:password:protocol" layout, same `Basic riot:<password>`
// auth).
function findRiotClientLockfilePath() {
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData ? path.join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile') : null;
}

function readRiotClientLockfile() {
  const lockfilePath = findRiotClientLockfilePath();
  if (!lockfilePath) return null;
  try {
    const contents = fs.readFileSync(lockfilePath, 'utf8');
    const [, , port, password, protocol] = contents.trim().split(':');
    if (!port || !password) return null;
    return { port, password, protocol: protocol || 'https' };
  } catch (e) {
    return null; // no lockfile — the client isn't running
  }
}

// Shared by anything talking to a local Riot/League API — same self-signed
// cert, same Basic riot:<password> auth, same lockfile shape, whether it's
// this file's own Riot Client API or League's LCU in lib/leagueClientApi.js.
// Resolves with the response body along with the status — a failure here
// (e.g. "sign_out_failed_other_games_running", discovered by actually
// reading this instead of discarding it) is exactly the kind of detail
// worth keeping rather than swallowing.
function localApiRequest(lockfile, method, endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: lockfile.port,
        path: endpoint,
        method,
        agent: localAgent,
        timeout: 3000,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`riot:${lockfile.password}`).toString('base64'),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Local API request timed out')));
    req.end();
  });
}

// Riot's error bodies don't carry a distinct machine-readable error code for
// the specific reason — `errorCode` is always the generic "RPC_ERROR" — it's
// embedded inside the human-readable `message` instead, as `error '<slug>':
// <description>`. Pulling that slug out explicitly here means callers (like
// the sign-out retry loop) can key off a stable value instead of pattern
// -matching the same text that's also shown to the user.
function parseErrorBody(body, status) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.message) {
      const slugMatch = /error '([a-z_]+)'/.exec(parsed.message);
      return { message: parsed.message, slug: slugMatch ? slugMatch[1] : null };
    }
  } catch (e) {
    // not JSON — fall through to the generic message below
  }
  return { message: `Unexpected response (${status})`, slug: null };
}

// Ends the current sign-in session via the Riot Client's own local API —
// this is a real logout (verified live: flips the client's own
// riot-login/v1/status from {persist:true, phase:"logged_in"} to
// {persist:false, phase:"not_logged_in"}), not a process kill standing in
// for one. Unlike closing the client, this doesn't need a relaunch at all —
// the running Riot Client reacts to the session ending on its own and
// presents its login screen live.
//
// Also confirmed live: this refuses to run at all while League (or another
// Riot game) is still running (400, "sign_out_failed_other_games_running")
// — callers need to close those first (see closeLeagueClient in
// lib/leagueClientApi.js).
async function endRiotClientSession() {
  const lockfile = readRiotClientLockfile();
  if (!lockfile) return { ok: false, error: 'CLIENT_NOT_FOUND' };
  try {
    const { status, body } = await localApiRequest(lockfile, 'DELETE', '/rso-auth/v1/session');
    // 204 = ended successfully. 404 here means there was no session to end
    // (already signed out) — not a failure from this app's point of view.
    if (status === 204 || status === 404) return { ok: true };
    const { message, slug } = parseErrorBody(body, status);
    return { ok: false, error: message, errorSlug: slug };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { findRiotClientPath, readInstallManifest, endRiotClientSession, localApiRequest };
