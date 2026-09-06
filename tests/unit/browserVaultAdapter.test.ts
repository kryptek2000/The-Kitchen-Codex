/**
 * The Kitchen Codex — BrowserFsaVaultAdapter (Phase 4C2).
 *
 * Tests the first concrete platform adapter against lightweight, in-memory
 * File-System-Access-shaped doubles. No real `showDirectoryPicker`, no browser
 * DOM harness, no global `FileSystemDirectoryHandle`/`File` — mocks are plain
 * objects implementing the minimal structural shape the adapter declares.
 *
 * Covers: contract conformance (typechecks as `VaultAdapter`), recursive
 * Markdown-only listing, read/write/delete/exists, nested paths, and safe
 * vault-relative path validation (no absolute paths, no `..`, no root escape,
 * no handle leakage through the contract surface).
 */

import { describe, it, expect } from 'vitest';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';
import {
  BrowserFsaVaultAdapter,
  FsaDirectoryHandleLike,
  FsaEntryLike,
  FsaFileHandleLike,
} from '../../src/platform/browser';

// --- Minimal in-memory File-System-Access doubles ---------------------------

class MockFile implements FsaFileHandleLike {
  readonly kind = 'file' as const;
  constructor(
    public readonly name: string,
    public content: string
  ) {}
  async getFile(): Promise<{ text(): Promise<string> }> {
    return { text: async () => this.content };
  }
  async createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> {
    const self = this;
    return {
      write: async (data: string) => {
        self.content = data;
      },
      close: async () => {},
    };
  }
}

class MockDir implements FsaDirectoryHandleLike {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MockFile | MockDir>();
  constructor(public readonly name: string) {}

  async *values(): AsyncIterable<FsaEntryLike> {
    for (const child of this.children.values()) yield child;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandleLike> {
    const child = this.children.get(name);
    if (child instanceof MockFile) return child;
    if (!child) {
      if (options?.create) {
        const file = new MockFile(name, '');
        this.children.set(name, file);
        return file;
      }
      throw { name: 'NotFoundError' };
    }
    throw new Error('TypeMismatchError: expected a file.');
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FsaDirectoryHandleLike> {
    const child = this.children.get(name);
    if (child instanceof MockDir) return child;
    if (!child) {
      if (options?.create) {
        const dir = new MockDir(name);
        this.children.set(name, dir);
        return dir;
      }
      throw { name: 'NotFoundError' };
    }
    throw new Error('TypeMismatchError: expected a directory.');
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw { name: 'NotFoundError' };
  }
}

/** Builds a mock vault root from a map of relative-path -> content. */
function buildVault(files: Record<string, string>): MockDir {
  const root = new MockDir('Vault Root');
  for (const [rel, content] of Object.entries(files)) {
    const segments = rel.replace(/\\/g, '/').split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i];
      let next = dir.children.get(name);
      if (!(next instanceof MockDir)) {
        next = new MockDir(name);
        dir.children.set(name, next);
      }
      dir = next;
    }
    dir.children.set(segments[segments.length - 1], new MockFile(segments[segments.length - 1], content));
  }
  return root;
}

const VAULT = {
  'Recipes/Italian/Lasagna.md': '# Lasagna\n\n- x',
  'Recipes/Japanese/Tonkotsu Ramen.md': '# Ramen',
  'Notes/Garlic Guide.md': 'guide',
  'Images/header.png': 'binary',
  'Recipes/photo.png': 'binary',
  'Recipes/readme.txt': 'txt not markdown',
};

// --- Tests ------------------------------------------------------------------

describe('BrowserFsaVaultAdapter (Phase 4C2)', () => {
  it('typechecks as a VaultAdapter contract implementation', () => {
    const adapter: VaultAdapter = new BrowserFsaVaultAdapter(buildVault({}));
    expect(adapter).toBeInstanceOf(BrowserFsaVaultAdapter);
    // Contract surface is exactly the five text methods.
    expect(typeof adapter.listMarkdownFiles).toBe('function');
    expect(typeof adapter.readText).toBe('function');
    expect(typeof adapter.writeText).toBe('function');
    expect(typeof adapter.delete).toBe('function');
    expect(typeof adapter.exists).toBe('function');
  });

  it('listMarkdownFiles is recursive, Markdown-only, sorted, and leaks no handles', async () => {
    const adapter = new BrowserFsaVaultAdapter(buildVault(VAULT));
    const files = await adapter.listMarkdownFiles();
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([
      'Notes/Garlic Guide.md',
      'Recipes/Italian/Lasagna.md',
      'Recipes/Japanese/Tonkotsu Ramen.md',
    ]);
    // Results carry only path + name (no FileSystemHandle escapes).
    for (const file of files) {
      expect(Object.keys(file).sort()).toEqual(['name', 'path']);
      expect(typeof file.name).toBe('string');
      expect(typeof file.path).toBe('string');
    }
    // Non-Markdown files (images, txt) are excluded.
    expect(paths.some((p) => /\.(png|txt)$/i.test(p))).toBe(false);
  });

  it('readText returns the raw Markdown for a nested path', async () => {
    const adapter = new BrowserFsaVaultAdapter(buildVault(VAULT));
    await expect(adapter.readText('Recipes/Italian/Lasagna.md')).resolves.toBe(
      '# Lasagna\n\n- x'
    );
  });

  it('writeText creates a new nested file and updates an existing one', async () => {
    const root = buildVault(VAULT);
    const adapter = new BrowserFsaVaultAdapter(root);
    await adapter.writeText('Recipes/French/Coq au Vin.md', '# Coq au Vin');
    await expect(adapter.readText('Recipes/French/Coq au Vin.md')).resolves.toBe('# Coq au Vin');
    await adapter.writeText('Recipes/Italian/Lasagna.md', '# Updated');
    await expect(adapter.readText('Recipes/Italian/Lasagna.md')).resolves.toBe('# Updated');
  });

  it('delete removes a target file and leaves siblings intact', async () => {
    const root = buildVault(VAULT);
    const adapter = new BrowserFsaVaultAdapter(root);
    await adapter.delete('Recipes/Japanese/Tonkotsu Ramen.md');
    expect(await adapter.exists('Recipes/Japanese/Tonkotsu Ramen.md')).toBe(false);
    expect(await adapter.exists('Recipes/Italian/Lasagna.md')).toBe(true);
    const files = await adapter.listMarkdownFiles();
    expect(files.some((f) => f.name === 'Tonkotsu Ramen.md')).toBe(false);
  });

  it('exists distinguishes present vs missing (and does not mutate)', async () => {
    const root = buildVault(VAULT);
    const adapter = new BrowserFsaVaultAdapter(root);
    expect(await adapter.exists('Recipes/Italian/Lasagna.md')).toBe(true);
    expect(await adapter.exists('Recipes/Italian/Not There.md')).toBe(false);
    // exists must not create files.
    expect(await adapter.exists('Recipes/Other/New.md')).toBe(false);
  });

  it('rejects absolute vault paths', async () => {
    const adapter = new BrowserFsaVaultAdapter(buildVault(VAULT));
    await expect(adapter.readText('/Recipes/Italian/Lasagna.md')).rejects.toThrow(
      /Absolute vault paths are not allowed/
    );
  });

  it('rejects traversal segments and empty segments', async () => {
    const adapter = new BrowserFsaVaultAdapter(buildVault(VAULT));
    await expect(adapter.readText('../etc/passwd')).rejects.toThrow(/Invalid vault path segment/);
    await expect(adapter.readText('Recipes/../Lasagna.md')).rejects.toThrow(
      /Invalid vault path segment/
    );
    await expect(adapter.readText('Recipes//Italian/Lasagna.md')).rejects.toThrow(
      /Invalid vault path segment/
    );
    await expect(adapter.readText('.')).rejects.toThrow(/Invalid vault path segment/);
    await expect(adapter.readText('')).rejects.toThrow(/must not be empty/);
    await expect(adapter.writeText('../../outside.md', 'x')).rejects.toThrow(
      /Invalid vault path segment/
    );
  });

  it('never leaves the injected root directory handle', async () => {
    const root = buildVault(VAULT);
    const adapter = new BrowserFsaVaultAdapter(root);
    // Any attempt to escape the root via `..` in a nested dir is rejected before
    // any directory handle is resolved.
    await expect(adapter.readText('Recipes/../../secret.md')).rejects.toThrow(
      /Invalid vault path segment/
    );
    // The full result set stays within the vault tree.
    const files = await adapter.listMarkdownFiles();
    for (const f of files) {
      expect(f.path.startsWith('../')).toBe(false);
      expect(f.path.includes('/../')).toBe(false);
    }
  });

  it('readText rejects a missing file cleanly as a real Error', async () => {
    const adapter = new BrowserFsaVaultAdapter(buildVault(VAULT));
    const error = await adapter.readText('Recipes/Missing.md').catch((e) => e);
    expect(error).toMatchObject({ name: 'NotFoundError' });
    expect(error.message).toMatch(/not found/i);
  });
});
