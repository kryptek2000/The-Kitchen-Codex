/**
 * Narrow wrapper around the native Vault filesystem confinement helper.
 *
 * Every operation is anchored to an authorized real Vault root and its accepted
 * device/inode identity. The native helper walks every component with directory
 * descriptors; there is no path-based fallback that follows intermediate
 * symbolic links. This module intentionally exposes no arbitrary filesystem API.
 */

'use strict';

const native = require('./native/tkc_vault.node');

function identityValues(identity) {
  if (!identity || identity.dev === undefined || identity.ino === undefined) {
    const error = new Error('The Vault root identity is unavailable.');
    error.code = 'DESKTOP_VAULT_ROOT_UNVERIFIED';
    throw error;
  }
  return { dev: String(identity.dev), ino: String(identity.ino) };
}

function translate(error) {
  if (error && error.code === 'ENOENT') {
    const notFound = new Error(error.message || 'Vault path not found.');
    notFound.name = 'NotFoundError';
    notFound.code = 'NotFoundError';
    return notFound;
  }
  return error;
}

function call(operation) {
  try {
    return operation();
  } catch (error) {
    throw translate(error);
  }
}

function readText(rootPath, relative, identity) {
  const id = identityValues(identity);
  return call(() => native.readText(rootPath, relative, id.dev, id.ino));
}

function readBinary(rootPath, relative, identity) {
  const id = identityValues(identity);
  return call(() => native.readBinary(rootPath, relative, id.dev, id.ino));
}

function writeText(rootPath, relative, content, identity, options = {}) {
  const id = identityValues(identity);
  return call(() =>
    native.writeText(rootPath, relative, String(content ?? ''), id.dev, id.ino, Boolean(options.exclusive))
  );
}

function writeBinary(rootPath, relative, bytes, identity, options = {}) {
  const id = identityValues(identity);
  return call(() =>
    native.writeBinary(rootPath, relative, bytes, id.dev, id.ino, Boolean(options.exclusive))
  );
}

function writeTextIfUnchanged(rootPath, relative, content, expected, identity) {
  const id = identityValues(identity);
  return call(() =>
    native.writeTextIfUnchanged(
      rootPath,
      relative,
      String(content ?? ''),
      String(expected ?? ''),
      id.dev,
      id.ino
    )
  );
}

function list(rootPath, relative, identity) {
  const id = identityValues(identity);
  return call(() => native.list(rootPath, relative, id.dev, id.ino));
}

function stat(rootPath, relative, identity) {
  const id = identityValues(identity);
  return call(() => native.stat(rootPath, relative, id.dev, id.ino));
}

function exists(rootPath, relative, identity) {
  const id = identityValues(identity);
  return call(() => native.exists(rootPath, relative, id.dev, id.ino));
}

function mkdir(rootPath, relative, identity) {
  const id = identityValues(identity);
  return call(() => native.mkdir(rootPath, relative, id.dev, id.ino));
}

function remove(rootPath, relative, identity) {
  const id = identityValues(identity);
  return call(() => native.remove(rootPath, relative, id.dev, id.ino));
}

module.exports = {
  exists,
  list,
  mkdir,
  readBinary,
  readText,
  remove,
  stat,
  writeBinary,
  writeText,
  writeTextIfUnchanged,
};
