'use strict';

// Portable, passphrase-based encryption — used for the password field in any
// backup that opts into including one: local (manual export and the daily
// auto-backup) or cloud, see lib/backup.js. Deliberately NOT Electron's
// safeStorage (see lib/accountSecrets.js): safeStorage's key is tied to this
// Windows account/machine via DPAPI, which is exactly what makes it useless
// for a backup meant to survive losing this machine (or this Windows profile)
// entirely. Here the only secret is a passphrase the user picks and remembers
// themselves — this module never persists it, that's the caller's problem
// (see lib/backup.js's local passphrase cache for the convenience/portability
// trade-off that involves).

const crypto = require('crypto');

const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM standard nonce size
const KEY_BYTES = 32; // AES-256
// scrypt cost parameters — deliberately expensive (tens of ms) since this key
// is the only thing standing between a stolen cloud backup file and every
// saved password in it.
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_OPTS);
}

function encryptWithPassphrase(plaintext, passphrase) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

// Throws if the passphrase is wrong or the blob was tampered with — GCM's
// auth tag check fails closed, it never silently returns garbage.
function decryptWithPassphrase(blob, passphrase) {
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const authTag = Buffer.from(blob.authTag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encryptWithPassphrase, decryptWithPassphrase };
