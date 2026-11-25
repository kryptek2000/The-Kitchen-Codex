/**
 * F2 — root authorization and inode identity.
 *
 * The privileged filesystem operations now live in the native helper and its
 * tests (`desktopVaultFs.test.ts`). This file verifies the authorization layer
 * that binds a real Vault path to the accepted directory inode.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const fsSafety = require('../../desktop/fsSafety.cjs') as {
  assertRootIdentity(root: string, identities: Map<string, { dev: string; ino: string }>): {
    dev: string;
    ino: string;
  };
  authorizeRoot(
    root: string,
    allowedRoots: Set<string>,
    identities?: Map<string, { dev: string; ino: string }>,
    options?: { refreshIdentity?: boolean }
  ): string;
  canonicalExistingRoot(root: string, allowedRoots: Set<string>): string;
  normalizeRelative(relative: string): string;
  readRootIdentity(root: string): { dev: string; ino: string };
};

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('F2 — Vault root authorization identity', () => {
  it('binds an authorized real root to its device and inode', () => {
    const vault = temporaryDirectory('tkc-f2-auth-');
    const allowedRoots = new Set<string>();
    const identities = new Map<string, { dev: string; ino: string }>();
    const real = fsSafety.authorizeRoot(vault, allowedRoots, identities);
    const expected = fs.statSync(real, { bigint: true });

    expect(allowedRoots.has(real)).toBe(true);
    expect(identities.get(real)).toEqual({
      dev: expected.dev.toString(),
      ino: expected.ino.toString(),
    });
    expect(fsSafety.canonicalExistingRoot(real, allowedRoots)).toBe(real);
    expect(fsSafety.assertRootIdentity(real, identities)).toEqual(identities.get(real));
  });

  it('rejects a replacement directory at the same authorized path', () => {
    const vault = temporaryDirectory('tkc-f2-auth-replaced-');
    const allowedRoots = new Set<string>();
    const identities = new Map<string, { dev: string; ino: string }>();
    const real = fsSafety.authorizeRoot(vault, allowedRoots, identities);

    fs.renameSync(real, `${real}-moved`);
    temporaryDirectories.push(`${real}-moved`);
    fs.mkdirSync(real);

    expect(() => fsSafety.assertRootIdentity(real, identities)).toThrow(/replaced/i);
    expect(() => fsSafety.authorizeRoot(real, allowedRoots, identities)).toThrow(/replaced/i);
  });

  it('allows an explicit re-selection to refresh the identity', () => {
    const vault = temporaryDirectory('tkc-f2-auth-refresh-');
    const allowedRoots = new Set<string>();
    const identities = new Map<string, { dev: string; ino: string }>();
    const real = fsSafety.authorizeRoot(vault, allowedRoots, identities);

    fs.renameSync(real, `${real}-moved`);
    temporaryDirectories.push(`${real}-moved`);
    fs.mkdirSync(real);

    const refreshed = fsSafety.authorizeRoot(real, allowedRoots, identities, {
      refreshIdentity: true,
    });
    expect(refreshed).toBe(real);
    expect(identities.get(real)).toEqual(fsSafety.readRootIdentity(real));
  });

  it('rejects unauthorized roots and invalid relative paths', () => {
    const vault = temporaryDirectory('tkc-f2-auth-unauthorized-');
    expect(() => fsSafety.canonicalExistingRoot(vault, new Set())).toThrow(/not authorized/i);
    expect(() => fsSafety.normalizeRelative('../escape')).toThrow(/Invalid vault path/i);
    expect(() => fsSafety.normalizeRelative('/absolute')).toThrow(/Absolute vault paths/i);
    expect(fsSafety.normalizeRelative('Recipes\\Nested\\Dinner.md')).toBe('Recipes/Nested/Dinner.md');
  });
});
