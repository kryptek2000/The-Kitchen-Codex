/**
 * Desktop Vault selection authority.
 *
 * A native picker only AUTHORIZES a candidate root for the current session.
 * Restart authority is persisted exclusively through `commitAcceptedVault`,
 * which the renderer calls only after the candidate scan/transition is accepted.
 *
 * State writes are atomic (temp + rename), throw on failure, and never update
 * the in-memory persisted authority before the filesystem write succeeds. A
 * failed write therefore leaves the previously accepted Vault as the next-launch
 * authority.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertRootIdentity, canonicalExistingRoot } = require('./fsSafety.cjs');

function createDesktopVaultState(statePath, fsImpl = fs) {
  if (!statePath) throw new Error('A desktop state path is required.');
  let persistedVaultPath = null;

  function readState() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function loadPersistedVaultPath() {
    const state = readState();
    persistedVaultPath =
      typeof state.lastVaultPath === 'string' && state.lastVaultPath.trim()
        ? path.resolve(state.lastVaultPath)
        : null;
    return persistedVaultPath;
  }

  function writeState(next) {
    const directory = path.dirname(statePath);
    const temporary = `${statePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    fsImpl.mkdirSync(directory, { recursive: true });
    try {
      fsImpl.writeFileSync(temporary, JSON.stringify(next, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fsImpl.renameSync(temporary, statePath);
    } catch (error) {
      try {
        fsImpl.rmSync(temporary, { force: true });
      } catch {
        // best effort; the previous state file is untouched
      }
      throw error;
    }
  }

  function persistActiveVault(realRoot) {
    // writeState is synchronous and throws before this assignment. Callers keep
    // the previous persisted path if the write fails.
    writeState({ ...readState(), lastVaultPath: realRoot });
    persistedVaultPath = realRoot;
    return persistedVaultPath;
  }

  return {
    readState,
    writeState,
    loadPersistedVaultPath,
    persistActiveVault,
    getPersistedVaultPath: () => persistedVaultPath,
  };
}

/**
 * Persist a root that the application already accepted (scan + transition).
 * Unauthorized or invalid roots are rejected before any state write.
 */
function commitAcceptedVault({ requestedRoot, allowedRoots, state, rootIdentities }) {
  const real = canonicalExistingRoot(requestedRoot, allowedRoots);
  if (rootIdentities) assertRootIdentity(real, rootIdentities);
  if (state.getPersistedVaultPath() === real) return real;
  try {
    state.persistActiveVault(real);
  } catch (error) {
    // The renderer still needs to know which session root was accepted so the
    // current window can remain usable; the persistent authority is untouched.
    error.desktopVaultRoot = real;
    error.originalCode = error.code;
    error.code = 'DESKTOP_STATE_WRITE_FAILED';
    throw error;
  }
  return real;
}

/**
 * The only root that Open Vault Folder may reveal. It must be the current
 * accepted session root, still resolve to that exact real directory, and remain
 * in the authorized root set. There is no renderer-supplied path.
 */
function resolveOpenableVault({ activeVaultRoot, allowedRoots, rootIdentities, fsImpl = fs }) {
  if (!activeVaultRoot) throw new Error('No personal Recipe Vault is active yet.');
  const candidate = path.resolve(String(activeVaultRoot));
  const real = fsImpl.realpathSync(candidate);
  if (real !== candidate) throw new Error('The active Vault path is no longer the accepted directory.');
  if (!allowedRoots.has(real)) throw new Error('The active Vault is no longer authorized.');
  const stat = fsImpl.statSync(real);
  if (!stat.isDirectory()) throw new Error('The active Vault is not a directory.');
  if (rootIdentities) assertRootIdentity(real, rootIdentities);
  return real;
}

module.exports = {
  commitAcceptedVault,
  createDesktopVaultState,
  resolveOpenableVault,
};
