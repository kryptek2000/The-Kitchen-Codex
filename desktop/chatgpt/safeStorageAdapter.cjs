/**
 * Electron safeStorage adapter. Fails closed when only Chromium's basic_text
 * obfuscation is available.
 */

'use strict';

function createSafeStorageAdapter(safeStorage) {
  const backend = () => {
    try {
      return String(safeStorage.getSelectedStorageBackend?.() || 'unknown');
    } catch {
      return 'unknown';
    }
  };
  return {
    available() {
      try {
        return Boolean(safeStorage.isEncryptionAvailable()) && backend() !== 'basic_text';
      } catch {
        return false;
      }
    },
    unavailableReason() {
      if (backend() === 'basic_text') {
        return 'The operating system only offers basic_text credential obfuscation. A real keyring is required.';
      }
      return 'Secure operating-system credential storage is unavailable.';
    },
    encrypt(value) {
      return safeStorage.encryptString(String(value));
    },
    decrypt(value) {
      return safeStorage.decryptString(Buffer.from(value));
    },
    describe() {
      return backend();
    },
  };
}

module.exports = {
  createSafeStorageAdapter,
};
