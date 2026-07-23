'use strict';

// Riot records the install location of RiotClientServices.exe in this manifest
// on every Windows install, so we can launch it without asking the user to
// browse for it.

const fs = require('fs');

const RIOT_CLIENT_MANIFEST = 'C:\\ProgramData\\Riot Games\\RiotClientInstalls.json';
const RIOT_CLIENT_FALLBACK = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';

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

module.exports = { findRiotClientPath, readInstallManifest };
