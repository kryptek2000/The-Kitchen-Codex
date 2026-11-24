/**
 * Session-only credential authority for the local ChatGPT subscription
 * connection.
 *
 * - Access, refresh, and ID tokens live only in the Electron main-process
 *   service. They are never written to disk by this module.
 * - The only persistent records are a stable host identity and the issued
 *   non-secret OAuth client registration.
 * - Legacy encrypted credential records and revocation journals are never
 *   read. They are deleted best-effort and are inert when deletion fails.
 * - Persistent files are atomic, owner-only (0600), and the directory is 0700.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_VERSION = 2;
const METADATA_VERSION = 1;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ACCOUNTS = 20;
const LEGACY_FILES = Object.freeze(['credentials.bin', 'revocations.json']);
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

class CredentialStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

function fsyncDirectory(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* directory fsync is best effort on platforms that reject it */
  }
}

function atomicWrite(file, bytes, mode = 0o600) {
  const dir = path.dirname(file);
  const temp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeFileSync(fd, bytes);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    fs.chmodSync(file, mode);
    fsyncDirectory(dir);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CredentialStoreError(
      'CREDENTIAL_PATH_UNSAFE',
      'The credential directory is not a regular directory.'
    );
  }
  fs.chmodSync(dir, 0o700);
}

function readPrivateFile(file, maxBytes = MAX_METADATA_BYTES) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CredentialStoreError(
      'CREDENTIAL_PATH_UNSAFE',
      'The credential path is not a regular file.'
    );
  }
  if (stat.size > maxBytes) {
    throw new CredentialStoreError('CREDENTIAL_TOO_LARGE', 'The credential metadata file is too large.');
  }
  return fs.readFileSync(file);
}

function defaultState(hostId, registration) {
  return {
    version: STATE_VERSION,
    hostId,
    registration,
    activeAccountKey: null,
    accounts: {},
  };
}

function validateRegistration(value, hostId) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CredentialStoreError('REGISTRATION_CORRUPT', 'The client registration is malformed.');
  }
  if (value.hostId !== undefined && value.hostId !== hostId) {
    throw new CredentialStoreError('REGISTRATION_HOST_MISMATCH', 'The client registration host identity does not match.');
  }
  if (typeof value.clientId !== 'string' || !CLIENT_ID_PATTERN.test(value.clientId)) {
    throw new CredentialStoreError('REGISTRATION_CORRUPT', 'The client registration identifier is invalid.');
  }
  return { clientId: value.clientId };
}

function validateState(value, hostId = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CredentialStoreError('CREDENTIAL_CORRUPT', 'Session state is malformed.');
  }
  if (value.version !== STATE_VERSION) {
    throw new CredentialStoreError('CREDENTIAL_VERSION', 'Session state version is unsupported.');
  }
  if (typeof value.hostId !== 'string' || !value.hostId.startsWith('urn:')) {
    throw new CredentialStoreError('CREDENTIAL_CORRUPT', 'Credential host identity is invalid.');
  }
  if (hostId && value.hostId !== hostId) {
    throw new CredentialStoreError('HOST_ID_MISMATCH', 'The session host identity does not match.');
  }
  const accounts = value.accounts && typeof value.accounts === 'object' && !Array.isArray(value.accounts)
    ? value.accounts
    : {};
  if (Object.keys(accounts).length > MAX_ACCOUNTS) {
    throw new CredentialStoreError('CREDENTIAL_CORRUPT', 'Session account count is invalid.');
  }
  for (const [key, account] of Object.entries(accounts)) {
    if (!account || typeof account !== 'object' || Array.isArray(account) || account.accountKey !== key) {
      throw new CredentialStoreError('CREDENTIAL_CORRUPT', 'Session account state is invalid.');
    }
  }
  return {
    version: STATE_VERSION,
    hostId: value.hostId,
    registration: validateRegistration(value.registration, value.hostId),
    activeAccountKey: typeof value.activeAccountKey === 'string' ? value.activeAccountKey : null,
    accounts: clone(accounts),
  };
}

class ChatGptCredentialStore {
  constructor({ dir, encryption, now = () => Date.now() }) {
    if (!dir) throw new Error('Credential store directory is required.');
    if (!encryption) throw new Error('Credential store encryption adapter is required.');
    this.dir = path.resolve(dir);
    this.encryption = encryption;
    this.now = now;
    this.hostFile = path.join(this.dir, 'host.json');
    this.registrationFile = path.join(this.dir, 'registration.json');
    this.state = null;
    this.legacyStatus = { present: [], removed: [], failed: [], inert: false };
    this.lastRegistrationSerialized = '';
    this.registrationPersistenceWarning = null;
  }

  secureStorageReason() {
    try {
      if (!this.encryption.available()) {
        return this.encryption.unavailableReason?.() || 'Secure operating-system credential storage is unavailable.';
      }
      return '';
    } catch {
      return 'Secure operating-system credential storage could not be initialized.';
    }
  }

  init() {
    const reason = this.secureStorageReason();
    if (reason) {
      throw new CredentialStoreError('SECURE_STORAGE_UNAVAILABLE', reason);
    }
    ensurePrivateDirectory(this.dir);
    const hostId = this.loadOrCreateHostId();
    const registration = this.loadRegistration(hostId);
    this.legacyStatus = this.cleanupLegacyCredentials();
    this.state = defaultState(hostId, registration);
    return this.state;
  }

  cleanupLegacyCredentials() {
    const present = [];
    const removed = [];
    const failed = [];
    for (const name of LEGACY_FILES) {
      const file = path.join(this.dir, name);
      try {
        if (!fs.existsSync(file)) continue;
        present.push(name);
        fs.unlinkSync(file);
        removed.push(name);
      } catch (error) {
        failed.push({ name, code: String(error?.code || 'UNKNOWN').slice(0, 40) });
      }
    }
    if (removed.length) fsyncDirectory(this.dir);
    return {
      present,
      removed,
      failed,
      inert: failed.length > 0,
    };
  }

  loadOrCreateHostId() {
    if (fs.existsSync(this.hostFile)) {
      const raw = readPrivateFile(this.hostFile);
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new CredentialStoreError('HOST_ID_CORRUPT', 'The host identity file is malformed.');
      }
      if (
        !parsed ||
        typeof parsed.hostId !== 'string' ||
        !/^urn:(uuid:[0-9a-f-]{36}|ietf:params:oauth:jwk-thumbprint:.+|did:key:.+)$/i.test(parsed.hostId)
      ) {
        throw new CredentialStoreError('HOST_ID_CORRUPT', 'The host identity is invalid.');
      }
      fs.chmodSync(this.hostFile, 0o600);
      return parsed.hostId;
    }
    const hostId = `urn:uuid:${crypto.randomUUID()}`;
    atomicWrite(this.hostFile, `${JSON.stringify({ version: 1, hostId }, null, 2)}\n`, 0o600);
    return hostId;
  }

  loadRegistration(hostId) {
    if (!fs.existsSync(this.registrationFile)) return null;
    const raw = readPrivateFile(this.registrationFile);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new CredentialStoreError('REGISTRATION_CORRUPT', 'The client registration file is malformed.');
    }
    if (!parsed || parsed.version !== METADATA_VERSION) {
      throw new CredentialStoreError('REGISTRATION_CORRUPT', 'The client registration file is invalid.');
    }
    const registration = validateRegistration(parsed, hostId);
    fs.chmodSync(this.registrationFile, 0o600);
    this.lastRegistrationSerialized = this.serializeRegistration(hostId, registration);
    return registration;
  }

  serializeRegistration(hostId, registration) {
    if (!registration) return '';
    return `${JSON.stringify({
      version: METADATA_VERSION,
      hostId,
      clientId: registration.clientId,
    })}\n`;
  }

  getHostId() {
    if (!this.state) throw new Error('Credential store is not initialized.');
    return this.state.hostId;
  }

  getRegistration() {
    if (!this.state) throw new Error('Credential store is not initialized.');
    return this.state.registration ? { ...this.state.registration } : null;
  }

  getLegacyStatus() {
    return clone(this.legacyStatus);
  }

  getState() {
    if (!this.state) throw new Error('Credential store is not initialized.');
    return this.state;
  }

  /**
   * Replace the in-memory session state. Only the non-secret client
   * registration is ever written to disk; account tokens are not serialized.
   */
  setSessionState(state) {
    const normalized = validateState({ ...state, version: STATE_VERSION });
    this.state = normalized;
    if (normalized.registration) {
      const serialized = this.serializeRegistration(normalized.hostId, normalized.registration);
      if (serialized !== this.lastRegistrationSerialized) {
        try {
          atomicWrite(this.registrationFile, serialized, 0o600);
          this.lastRegistrationSerialized = serialized;
          this.registrationPersistenceWarning = null;
        } catch (error) {
          this.registrationPersistenceWarning = {
            code: 'REGISTRATION_PERSISTENCE_FAILED',
            message: 'The non-secret ChatGPT client registration could not be saved; this session remains usable.',
            detail: String(error?.code || 'UNKNOWN').slice(0, 40),
          };
        }
      }
    }
    return normalized;
  }

  getRegistrationPersistenceWarning() {
    return this.registrationPersistenceWarning
      ? { ...this.registrationPersistenceWarning }
      : null;
  }

  deleteAll() {
    for (const file of [
      this.hostFile,
      this.registrationFile,
      path.join(this.dir, 'credentials.bin'),
      path.join(this.dir, 'revocations.json'),
    ]) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    this.state = null;
  }
}

module.exports = {
  ChatGptCredentialStore,
  CredentialStoreError,
  MAX_ACCOUNTS,
  STATE_VERSION,
  validateState,
};
