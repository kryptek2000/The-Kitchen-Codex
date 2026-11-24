/**
 * Vault authorization and path-shape utilities.
 *
 * This module deliberately contains NO privileged filesystem read/write
 * primitives. Actual Vault operations are performed by the native descriptor-
 * relative helper (`vaultFs.cjs`), anchored to the authorized root's device and
 * inode identity. Keeping path checks here would create a second, weaker
 * implementation and invite another path-based workaround.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizeRelative(relative) {
  const rel = String(relative ?? '').replace(/\\/g, '/').trim();
  if (!rel) return '';
  if (rel.startsWith('/')) throw new Error('Absolute vault paths are not allowed.');
  const segments = rel.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Invalid vault path segment "${segment}".`);
    }
  }
  return segments.join('/');
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function readRootIdentity(root) {
  const resolved = path.resolve(String(root ?? ''));
  const stat = fs.statSync(resolved, { bigint: true });
  if (!stat.isDirectory()) throw new Error('The selected Vault path is not a directory.');
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function rootChangedError() {
  const error = new Error('The Vault directory was replaced. Re-select the Vault.');
  error.code = 'DESKTOP_VAULT_ROOT_CHANGED';
  return error;
}

/**
 * Authorize a real Vault root. The optional identity map binds the real path to
 * the accepted directory inode. A different directory at the same path is
 * rejected unless the caller explicitly re-selected it (`refreshIdentity`).
 */
function authorizeRoot(root, allowedRoots, identities, options = {}) {
  const real = fs.realpathSync(path.resolve(String(root ?? '')));
  const next = readRootIdentity(real);
  const previous = identities ? identities.get(real) : null;
  if (
    previous &&
    !options.refreshIdentity &&
    (previous.dev !== next.dev || previous.ino !== next.ino)
  ) {
    throw rootChangedError();
  }
  allowedRoots.add(real);
  if (identities) identities.set(real, next);
  return real;
}

function canonicalExistingRoot(root, allowedRoots) {
  const resolved = path.resolve(String(root ?? ''));
  const real = fs.realpathSync(resolved);
  const stat = fs.statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error('The selected Vault path is not a directory.');
  if (!allowedRoots.has(real)) throw new Error('Vault root is not authorized.');
  return real;
}

/**
 * Verify that the path still names the accepted directory inode. Missing
 * identity is filled on first use for an already-authorized root.
 */
function assertRootIdentity(root, identities) {
  const resolved = path.resolve(String(root ?? ''));
  const current = readRootIdentity(resolved);
  const previous = identities ? identities.get(resolved) : null;
  if (previous && (previous.dev !== current.dev || previous.ino !== current.ino)) {
    throw rootChangedError();
  }
  if (identities && !previous) identities.set(resolved, current);
  return current;
}

module.exports = {
  assertRootIdentity,
  authorizeRoot,
  canonicalExistingRoot,
  inside,
  normalizeRelative,
  readRootIdentity,
};
