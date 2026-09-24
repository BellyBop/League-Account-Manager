'use strict';

const fs = require('fs');
const path = require('path');
const { getSettings, saveSettings, getAccounts, writeJson, autoBackupDir, dataDir, accountsPath } = require('./store');
const { todayKey } = require('./rank');
const { HOUR } = require('./constants');
const { decryptPassword, encryptPassword } = require('./accountSecrets');
const { encryptWithPassphrase, decryptWithPassphrase } = require('./passphraseCrypto');

// Backs up data Riot's API can't give back to us (label, notes, email, login
// username, session history) — cache and inventory are both refetchable
// (inventory from the local client on next sign-in) and the API key expires
// daily anyway, so neither is included, backup type or not.
//
// Passwords are the interesting case. Every backup this produces — manual
// export, the daily local auto-backup, or a cloud backup (lib/cloudBackup.js
// just calls this and adds its own `kind` marker) — is a plain file that can
// end up anywhere: another drive, a USB stick, a synced folder. safeStorage's
// DPAPI encryption is tied to this exact Windows account, so an
// encryptedPassword blob traveling in one of these files is either dead
// weight (can't decrypt elsewhere) or, worse, gives false confidence that a
// password is "backed up" when the one thing that can decrypt it is the
// single machine profile this whole feature exists to survive losing. So
// encryptedPassword is never carried over as-is. If a passphrase is given,
// each account's password is decrypted and re-encrypted under it (scrypt +
// AES-256-GCM, see lib/passphraseCrypto.js) into a portable `cloudPassword`
// field instead — same name regardless of which kind of backup this is, so
// one restore code path (see createPasswordResolver below) handles all of
// them. No passphrase, or a password that fails to decrypt locally, means
// that account just comes through with no password field, same as before.
function buildBackupPayload(passphrase) {
  const accounts = getAccounts().map(({ cache, inventory, encryptedPassword, ...rest }) => {
    if (passphrase && encryptedPassword) {
      try {
        const plaintext = decryptPassword(encryptedPassword);
        return { ...rest, cloudPassword: encryptWithPassphrase(plaintext, passphrase) };
      } catch (e) {
        // Fall through to the passwordless case below.
      }
    }
    return rest;
  });

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    defaultRegion: getSettings().defaultRegion,
    // Whether a password actually made it into this backup, not just whether
    // a passphrase was available to encrypt one with — those differ whenever
    // "include passwords" is on but no account has a saved password yet,
    // which is a normal, non-error state. Restore uses this to decide
    // whether to warn about skipped passwords, so it has to mean "there was
    // one to restore", not "one was theoretically possible".
    passwordsIncluded: accounts.some((a) => a.cloudPassword),
    accounts,
  };
}

// --- Backup passphrase --------------------------------------------------
// One passphrase, shared by every kind of backup that opts into including
// passwords (local export, local auto-backup, cloud backup) — asking someone
// to remember a separate passphrase per backup type would be its own way to
// lose a password. The passphrase itself is never written to disk in the
// clear. What's cached in settings.json is a safeStorage (DPAPI)-encrypted
// copy of it, purely so scheduled/automatic backups don't need someone
// sitting at the app to type it in. That cache is exactly as machine-bound as
// a saved account password is — it will NOT survive losing this Windows
// profile, which is the whole scenario this feature exists to protect
// against. The passphrase that actually matters is the one the user
// remembers (or saves in a real password manager) themselves; losing the
// local cache only means re-typing it once, not losing any backup made with it.
const VERIFIER_PLAINTEXT = 'league-acc-manager-backup-verifier';

function decryptCachedPassphrase() {
  const settings = getSettings();
  if (!settings.backupPassphraseEncrypted) return null;
  try {
    return decryptPassword(settings.backupPassphraseEncrypted);
  } catch (e) {
    return null;
  }
}

function setBackupPassphrase(passphrase) {
  const encryptedPassphrase = encryptPassword(passphrase);
  const verifier = encryptWithPassphrase(VERIFIER_PLAINTEXT, passphrase);
  saveSettings({
    ...getSettings(),
    backupPassphraseEncrypted: encryptedPassphrase,
    backupVerifier: verifier,
  });
}

function clearBackupPassphrase() {
  const settings = getSettings();
  delete settings.backupPassphraseEncrypted;
  delete settings.backupVerifier;
  saveSettings({ ...settings, localBackupIncludePasswords: false, cloudBackupIncludePasswords: false });
}

// Checks a candidate passphrase (typed in fresh, e.g. to restore on a new
// machine where nothing is cached) against the stored verifier, without
// needing an actual backup file to test it against.
function verifyPassphrase(passphrase) {
  const settings = getSettings();
  if (!settings.backupVerifier) return null; // nothing to check against
  try {
    return decryptWithPassphrase(settings.backupVerifier, passphrase) === VERIFIER_PLAINTEXT;
  } catch (e) {
    return false; // wrong passphrase / corrupt verifier — GCM auth failed
  }
}

// Shared by every restore path (local import, cloud restore): validates the
// passphrase up front against one sample cloudPassword so a wrong passphrase
// fails the whole restore cleanly before anything is touched, rather than
// silently importing some accounts with passwords and others without. Returns
// {error: 'BAD_PASSPHRASE'} on a bad passphrase, otherwise
// {resolvePassword, wasAnyPasswordRestored} — resolvePassword plugs straight
// into normalizeRestoredAccounts below, and wasAnyPasswordRestored() (call it
// only after normalizeRestoredAccounts has run) reports whether any account
// actually ended up with a password, for the UI's "restored N accounts,
// passwords included/skipped" message.
function createPasswordResolver(rawAccounts, passphrase) {
  if (!passphrase) return { resolvePassword: undefined, wasAnyPasswordRestored: () => false };

  const sample = rawAccounts.find((a) => a.cloudPassword);
  if (sample) {
    try {
      decryptWithPassphrase(sample.cloudPassword, passphrase);
    } catch (e) {
      return { error: 'BAD_PASSPHRASE' };
    }
  }

  let restored = false;
  const resolvePassword = (a) => {
    if (!a.cloudPassword) return undefined;
    try {
      const plaintext = decryptWithPassphrase(a.cloudPassword, passphrase);
      const encrypted = encryptPassword(plaintext);
      // Only counts once safeStorage has actually accepted the re-encrypt —
      // flipping this on the passphrase-decrypt alone would report a
      // password as restored even when encryptPassword() then throws (e.g.
      // safeStorage unavailable on this machine) and no account ends up
      // with one.
      restored = true;
      return encrypted;
    } catch (e) {
      return undefined;
    }
  };
  return { resolvePassword, wasAnyPasswordRestored: () => restored };
}

// --- Automatic scheduled backups ---------------------------------------------
// Same data as a manual export, just saved silently to a fixed folder on a
// timer instead of requiring the user to remember to click a button.
const AUTO_BACKUP_INTERVAL = 24 * HOUR;
const AUTO_BACKUP_KEEP = 7;

function listAutoBackups(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('auto-backup-') && f.endsWith('.json'))
      .sort();
  } catch (e) {
    return [];
  }
}

// Where daily local auto-backups actually go — the built-in folder unless
// someone's pointed it elsewhere (mirrors cloudBackupFolder in
// lib/cloudBackup.js). Exported so the IPC layer can show/open the same
// path this function actually writes to.
function localBackupTargetDir() {
  return getSettings().localBackupFolder || autoBackupDir();
}

function runAutoBackupIfDue() {
  if (getAccounts().length === 0) return; // nothing worth backing up yet

  const dir = localBackupTargetDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return; // e.g. a custom folder on an unplugged drive — try again next interval
  }

  const existing = listAutoBackups(dir);
  const last = existing[existing.length - 1];
  if (last) {
    const age = Date.now() - fs.statSync(path.join(dir, last)).mtimeMs;
    if (age < AUTO_BACKUP_INTERVAL) return; // not due yet
  }

  const settings = getSettings();
  const passphrase = settings.localBackupIncludePasswords ? decryptCachedPassphrase() : null;
  writeJson(path.join(dir, `auto-backup-${todayKey()}-${Date.now()}.json`), buildBackupPayload(passphrase));

  // Prune down to the most recent AUTO_BACKUP_KEEP files.
  const updated = listAutoBackups(dir);
  for (const stale of updated.slice(0, Math.max(0, updated.length - AUTO_BACKUP_KEEP))) {
    try {
      fs.unlinkSync(path.join(dir, stale));
    } catch (e) {
      // Non-fatal — it'll just get cleaned up on a later pass.
    }
  }
}

// Shared by both the plain restore (ipc/backupIpc.js) and the cloud restore
// (ipc/cloudBackupIpc.js) — same field defaults either way. resolvePassword,
// if given, is called with each raw imported account and may return an
// encryptedPassword (safeStorage-encrypted, ready to save locally) to attach;
// leaving it out (or having it return nothing for a given account) just means
// that account comes back with no saved password, same as any other restore.
function normalizeRestoredAccounts(rawAccounts, { resolvePassword } = {}) {
  return rawAccounts.map((a, i) => {
    const account = {
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
    };
    const encryptedPassword = resolvePassword ? resolvePassword(a) : undefined;
    if (encryptedPassword) account.encryptedPassword = encryptedPassword;
    return account;
  });
}

// --- Pre-restore safety net --------------------------------------------------
// A restore (local backup or cloud backup — both go through this) fully
// replaces accounts.json, which means restoring the wrong file, or one made
// without passwords, silently wipes whatever was there a moment ago. That's
// exactly the kind of loss that's expensive to redo by hand (see
// normalizeRestoredAccounts's comment above — a restored account only gets a
// password back if the backup had one). So every restore takes an exact,
// byte-for-byte copy of the CURRENT accounts.json — unlike buildBackupPayload,
// deliberately keeping cache/inventory/encryptedPassword as-is rather than
// stripping them — before it's allowed to overwrite anything. If the copy
// can't be made, the restore itself should refuse to proceed rather than
// silently drop the safety net.
const PRE_RESTORE_DIR_NAME = 'pre-restore-snapshots';
const PRE_RESTORE_KEEP = 10;

function preRestoreDir() {
  return path.join(dataDir(), PRE_RESTORE_DIR_NAME);
}

function listPreRestoreSnapshots() {
  try {
    return fs
      .readdirSync(preRestoreDir())
      .filter((f) => f.startsWith('pre-restore-') && f.endsWith('.json'))
      .sort();
  } catch (e) {
    return [];
  }
}

// Called immediately before a restore writes anything. Returns {ok:false} if
// there was nothing to protect (accounts.json doesn't exist yet — a restore
// here can't be destroying anything) or if the copy itself failed, in which
// case the caller should treat that as a reason to abort the restore.
function snapshotBeforeRestore() {
  if (!fs.existsSync(accountsPath())) return { ok: false, reason: 'NOTHING_TO_PROTECT' };

  const dir = preRestoreDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `pre-restore-${todayKey()}-${Date.now()}.json`);
    fs.copyFileSync(accountsPath(), dest);

    const existing = listPreRestoreSnapshots();
    for (const stale of existing.slice(0, Math.max(0, existing.length - PRE_RESTORE_KEEP))) {
      try {
        fs.unlinkSync(path.join(dir, stale));
      } catch (e) {
        // Non-fatal — cleaned up on a later pass.
      }
    }
    return { ok: true, filePath: dest };
  } catch (e) {
    return { ok: false, reason: 'SNAPSHOT_FAILED', error: e.message || String(e) };
  }
}

// Puts accounts.json back exactly as it was right before the most recent
// restore — a raw overwrite, not through normalizeRestoredAccounts, since
// these snapshots are already in the app's exact live shape (including
// encryptedPassword) rather than the portable/stripped backup shape.
function undoLastRestore() {
  const existing = listPreRestoreSnapshots();
  const last = existing[existing.length - 1];
  if (!last) return { ok: false, error: 'NO_SNAPSHOT' };

  try {
    fs.copyFileSync(path.join(preRestoreDir(), last), accountsPath());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  buildBackupPayload,
  runAutoBackupIfDue,
  localBackupTargetDir,
  normalizeRestoredAccounts,
  snapshotBeforeRestore,
  undoLastRestore,
  listPreRestoreSnapshots,
  decryptCachedPassphrase,
  setBackupPassphrase,
  clearBackupPassphrase,
  verifyPassphrase,
  createPasswordResolver,
};
