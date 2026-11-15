/**
 * F2 — native descriptor-relative Vault confinement.
 *
 * Reproduces Luna's intermediate-directory substitution against the actual
 * native helper used by the desktop shell, and verifies text, binary, read,
 * conditional, list/stat, mkdir/remove, root-replacement, and failure-integrity
 * behavior.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const fsSafety = require('../../desktop/fsSafety.cjs') as {
  authorizeRoot(
    root: string,
    allowedRoots: Set<string>,
    identities?: Map<string, { dev: string; ino: string }>
  ): string;
};
const vaultFs = require('../../desktop/vaultFs.cjs') as {
  exists(root: string, relative: string, identity: { dev: string; ino: string }): boolean;
  list(root: string, relative: string, identity: { dev: string; ino: string }): Array<{
    name: string;
    kind: 'file' | 'directory';
  }>;
  mkdir(root: string, relative: string, identity: { dev: string; ino: string }): void;
  readBinary(root: string, relative: string, identity: { dev: string; ino: string }): Buffer;
  readText(root: string, relative: string, identity: { dev: string; ino: string }): string;
  remove(root: string, relative: string, identity: { dev: string; ino: string }): void;
  stat(root: string, relative: string, identity: { dev: string; ino: string }): {
    kind: 'file' | 'directory';
    size: number;
    mtimeMs: number;
  };
  writeBinary(
    root: string,
    relative: string,
    bytes: Buffer,
    identity: { dev: string; ino: string },
    options?: { exclusive?: boolean }
  ): void;
  writeText(
    root: string,
    relative: string,
    content: string,
    identity: { dev: string; ino: string },
    options?: { exclusive?: boolean }
  ): void;
  writeTextIfUnchanged(
    root: string,
    relative: string,
    content: string,
    expected: string,
    identity: { dev: string; ino: string }
  ): void;
};

type Identity = { dev: string; ino: string };

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createVault(): { vault: string; identity: Identity } {
  const vault = temporaryDirectory('tkc-f2-vault-');
  const allowedRoots = new Set<string>();
  const identities = new Map<string, Identity>();
  const real = fsSafety.authorizeRoot(vault, allowedRoots, identities);
  return { vault: real, identity: identities.get(real)! };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('F2 — native Vault confinement', () => {
  it("blocks Luna's intermediate-directory substitution for text and binary writes", () => {
    const { vault, identity } = createVault();
    const outside = temporaryDirectory('tkc-f2-outside-');
    vaultFs.mkdir(vault, 'Assets', identity);

    fs.renameSync(path.join(vault, 'Assets'), path.join(vault, 'Assets-original'));
    fs.symlinkSync(outside, path.join(vault, 'Assets'));

    expect(() =>
      vaultFs.writeText(vault, 'Assets/escape.md', 'ESCAPED', identity)
    ).toThrow(/symbolic link/i);
    expect(() =>
      vaultFs.writeBinary(vault, 'Assets/escape.bin', Buffer.from([9, 9]), identity)
    ).toThrow(/symbolic link/i);

    expect(fs.existsSync(path.join(outside, 'escape.md'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'escape.bin'))).toBe(false);
  });

  it('blocks intermediate symlinks for reads, conditional writes, stat, and list', () => {
    const { vault, identity } = createVault();
    const outside = temporaryDirectory('tkc-f2-outside-read-');
    fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE-SECRET', 'utf8');
    vaultFs.mkdir(vault, 'Assets', identity);
    fs.renameSync(path.join(vault, 'Assets'), path.join(vault, 'Assets-original'));
    fs.symlinkSync(outside, path.join(vault, 'Assets'));

    expect(() => vaultFs.readText(vault, 'Assets/secret.md', identity)).toThrow(
      /symbolic link/i
    );
    expect(() =>
      vaultFs.writeTextIfUnchanged(vault, 'Assets/secret.md', 'NEW', 'OUTSIDE-SECRET', identity)
    ).toThrow(/symbolic link/i);
    expect(() => vaultFs.stat(vault, 'Assets/secret.md', identity)).toThrow(/symbolic link/i);
    expect(() => vaultFs.list(vault, 'Assets', identity)).toThrow(/symbolic link/i);
    expect(vaultFs.exists(vault, 'Assets/secret.md', identity)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('OUTSIDE-SECRET');
  });

  it('blocks final-leaf symlinks for text, binary, read, conditional, and remove', () => {
    const { vault, identity } = createVault();
    const outside = temporaryDirectory('tkc-f2-outside-final-');
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, 'ORIGINAL', 'utf8');
    fs.symlinkSync(secret, path.join(vault, 'recipe.md'));

    expect(() => vaultFs.writeText(vault, 'recipe.md', 'OVERWRITTEN', identity)).toThrow(
      /symbolic link/i
    );
    expect(() =>
      vaultFs.writeBinary(vault, 'recipe.md', Buffer.from([1, 2]), identity)
    ).toThrow(/symbolic link/i);
    expect(() => vaultFs.readText(vault, 'recipe.md', identity)).toThrow(/symbolic link/i);
    expect(() =>
      vaultFs.writeTextIfUnchanged(vault, 'recipe.md', 'NEW', 'ORIGINAL', identity)
    ).toThrow(/symbolic link/i);
    expect(() => vaultFs.remove(vault, 'recipe.md', identity)).toThrow(/symbolic link/i);
    expect(fs.readFileSync(secret, 'utf8')).toBe('ORIGINAL');
  });

  it('preserves legitimate nested recipe and asset paths', () => {
    const { vault, identity } = createVault();
    vaultFs.writeText(vault, 'Recipes/Nested/Dinner.md', '# Dinner\n', identity);
    vaultFs.writeBinary(vault, 'Assets/photo.png', Buffer.from([1, 2, 3]), identity);

    expect(vaultFs.readText(vault, 'Recipes/Nested/Dinner.md', identity)).toBe('# Dinner\n');
    expect([...vaultFs.readBinary(vault, 'Assets/photo.png', identity)]).toEqual([1, 2, 3]);
    expect(vaultFs.list(vault, '', identity)).toEqual(
      expect.arrayContaining([
        { name: 'Recipes', kind: 'directory' },
        { name: 'Assets', kind: 'directory' },
      ])
    );
    expect(vaultFs.stat(vault, 'Recipes/Nested/Dinner.md', identity).kind).toBe('file');
    expect(vaultFs.exists(vault, 'Recipes/Nested/Dinner.md', identity)).toBe(true);
    expect(vaultFs.exists(vault, 'Recipes/Nested/Missing.md', identity)).toBe(false);
  });

  it('keeps exclusive creation and conditional writes exact', () => {
    const { vault, identity } = createVault();
    vaultFs.mkdir(vault, '.kitchen-codex', identity);
    vaultFs.writeText(vault, '.kitchen-codex/initialization.json', 'first', identity, {
      exclusive: true,
    });
    expect(() =>
      vaultFs.writeText(vault, '.kitchen-codex/initialization.json', 'second', identity, {
        exclusive: true,
      })
    ).toThrow(/already exists/i);

    vaultFs.writeText(vault, 'recipe.md', 'EXPECTED', identity);
    vaultFs.writeTextIfUnchanged(vault, 'recipe.md', 'UPDATED', 'EXPECTED', identity);
    expect(vaultFs.readText(vault, 'recipe.md', identity)).toBe('UPDATED');
    expect(() =>
      vaultFs.writeTextIfUnchanged(vault, 'recipe.md', 'STALE', 'EXPECTED', identity)
    ).toThrow(/changed on disk/i);
    expect(vaultFs.readText(vault, 'recipe.md', identity)).toBe('UPDATED');
  });

  it('does not corrupt an existing file when a write cannot start', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const { vault, identity } = createVault();
    vaultFs.writeText(vault, 'recipe.md', 'ORIGINAL', identity);
    fs.chmodSync(vault, 0o500);
    try {
      expect(() => vaultFs.writeText(vault, 'recipe.md', 'REPLACEMENT', identity)).toThrow(
        /EACCES|permission denied/i
      );
    } finally {
      fs.chmodSync(vault, 0o700);
    }
    expect(vaultFs.readText(vault, 'recipe.md', identity)).toBe('ORIGINAL');
  });

  it('rejects a replacement Vault root with the original identity', () => {
    const { vault, identity } = createVault();
    fs.renameSync(vault, `${vault}-moved`);
    temporaryDirectories.push(`${vault}-moved`);
    fs.mkdirSync(vault);

    expect(() => vaultFs.writeText(vault, 'replacement.md', 'NOPE', identity)).toThrow(
      /replaced/i
    );
  });

  it('removes files and directories without following links', () => {
    const { vault, identity } = createVault();
    const outside = temporaryDirectory('tkc-f2-outside-remove-');
    vaultFs.writeText(vault, 'Recipes/One.md', '# One\n', identity);
    vaultFs.remove(vault, 'Recipes/One.md', identity);
    expect(vaultFs.exists(vault, 'Recipes/One.md', identity)).toBe(false);

    fs.symlinkSync(outside, path.join(vault, 'Assets'));
    expect(() => vaultFs.remove(vault, 'Assets', identity)).toThrow(/symbolic link/i);
    expect(fs.existsSync(outside)).toBe(true);
  });
});
