'use strict';

// Optional saved login password for 1-click sign-in. Encrypted with
// Electron's safeStorage (OS-level: DPAPI on Windows, Keychain on macOS,
// libsecret on Linux) rather than a hand-rolled cipher — the key is managed
// entirely by the OS and tied to this machine's login, so it never has to
// live in this app's source or config. That also means a saved password
// won't decrypt after a backup is restored on a different PC; everything
// else in a backup carries over fine, just not this field.

const { safeStorage } = require('electron');

function encryptPassword(plaintext) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('ENCRYPTION_UNAVAILABLE');
  }
  return safeStorage.encryptString(plaintext).toString('base64');
}

function decryptPassword(encryptedBase64) {
  return safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'));
}

// The encrypted blob has no business leaving the main process — the
// renderer only ever needs to know whether one exists, to decide whether to
// show the "copy password" button.
function sanitizeAccount(account) {
  const { encryptedPassword, ...rest } = account;
  return { ...rest, hasPassword: Boolean(encryptedPassword) };
}

module.exports = { encryptPassword, decryptPassword, sanitizeAccount };
