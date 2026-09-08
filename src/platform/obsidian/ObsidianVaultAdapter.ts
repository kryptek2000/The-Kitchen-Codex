/**
 * The Kitchen Codex — Obsidian Vault Adapter (Phase 4D3B).
 *
 * The first REAL alternate-surface implementation of the application-facing
 * `VaultAdapter` port, backed by the Obsidian `Vault` API. It proves
 * "one core, multiple shells": the SAME `VaultAdapter` contract that the browser
 * File System Access adapter implements is now implemented against the Obsidian
 * vault, so the platform-neutral application/core pipeline runs unchanged.
 *
 * PLACEMENT: Obsidian platform implementation detail, so it lives under
 * `src/platform/obsidian/`, NEVER under `src/core` or `src/application`.
 *
 * DESIGN:
 *   - The Obsidian `Vault` is INJECTED via the constructor (from `app.vault`).
 *     It is never imported as a runtime value — only as a TYPE — so this module
 *     is runtime-clean of Obsidian dependencies and can be unit-tested in Node
 *     with a plain-object vault fake.
 *   - Obsidian `TFile`/`TFolder`/`TAbstractFile` are ALSO type-only and are
 *     detected by conservative duck-typing (a folder exposes a `children` array;
 *     a file exposes a string `extension`). This avoids `instanceof` on a module
 *     that has no runtime, keeps the adapter testable, and never leaks TFile/
 *     TFolder through the application contract.
 *   - Paths stay vault-root-relative with forward-slash semantics. The path
 *     policy is the SAME as the browser adapter (no absolute path, no `.`/`..`
 *     segments) so nested recipe paths are preserved and never collapse to a
 *     basename.
 *
 * Only the five `VaultAdapter` (text/Markdown) methods are exposed. No asset
 * bytes, no sync/watch, no conflict engine, no arbitrary remote fetch.
 */

import type { Vault, TFile } from 'obsidian';
import type { VaultAdapter, VaultMarkdownFile } from '../../application/adapters/VaultAdapter';

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

/** A minimal duck-typed Obsidian vault file (TFile-shaped, no runtime import). */
interface ObsidianFileLike {
  readonly path: string;
  readonly name: string;
  readonly extension?: string;
}

/** A minimal duck-typed Obsidian vault folder (TFolder-shaped). */
interface ObsidianFolderLike {
  readonly path: string;
  readonly name: string;
  readonly children?: unknown[];
}

function isFolderLike(value: unknown): value is ObsidianFolderLike {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as ObsidianFolderLike).children);
}

function isFileLike(value: unknown): value is ObsidianFileLike {
  return Boolean(value) && typeof value === 'object' && typeof (value as ObsidianFileLike).extension === 'string';
}

/** Validates + normalizes a vault-root-relative path (mirrors the browser policy). */
function normalizeVaultRelativePath(path: string): string {
  const normalized = String(path ?? '').replace(/\\/g, '/').trim();
  if (!normalized) throw new Error('Vault path must not be empty.');
  if (normalized.startsWith('/')) throw new Error('Absolute vault paths are not allowed.');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Invalid vault path segment "${segment}" in "${path}".`);
    }
  }
  return normalized;
}

/** Builds an Obsidian-`NotFoundError`-shaped error (matches the browser adapter). */
function notFoundError(path: string): Error {
  const error = new Error(`Vault file not found: ${path}`);
  Object.defineProperty(error, 'name', { value: 'NotFoundError' });
  Object.defineProperty(error, 'code', { value: 'NotFoundError' });
  return error;
}

/**
 * Obsidian implementation of the `VaultAdapter` contract. The `Vault` instance is
 * supplied by the plugin bootstrap (`this.app.vault`); it is in injected, never
 * imported as a runtime value.
 */
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly vault: Vault) {}

  async listMarkdownFiles(): Promise<VaultMarkdownFile[]> {
    const files = this.vault.getMarkdownFiles();
    return files
      .filter((f) => MARKDOWN_EXTENSION.test(f.name))
      .map((f) => ({ path: f.path, name: f.name }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readText(path: string): Promise<string> {
    const file = this.resolveFile(path);
    return this.vault.read(file as unknown as TFile);
  }

  async writeText(path: string, content: string): Promise<void> {
    const target = normalizeVaultRelativePath(path);
    const existing = this.vault.getAbstractFileByPath(target);

    if (isFileLike(existing)) {
      await this.vault.modify(existing as unknown as TFile, content);
      return;
    }
    if (existing) {
      // A folder (or anything non-file) at the target is a name conflict.
      throw new Error(`Vault path "${target}" already exists and is not a file.`);
    }

    await this.ensureParentFolders(target);
    await this.vault.create(target, content);
  }

  async delete(path: string): Promise<void> {
    const file = this.resolveFile(path);
    await this.vault.delete(file as unknown as TFile);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const target = normalizeVaultRelativePath(path);
      return isFileLike(this.vault.getAbstractFileByPath(target));
    } catch {
      return false;
    }
  }

  /** Resolves a path to a duck-typed Obsidian file, or throws NotFoundError. */
  private resolveFile(path: string): ObsidianFileLike {
    const target = normalizeVaultRelativePath(path);
    const found = this.vault.getAbstractFileByPath(target);
    if (!isFileLike(found)) throw notFoundError(target);
    return found;
  }


  /** Creates every missing parent folder, so `vault.create` never throws on them. */
  private async ensureParentFolders(target: string): Promise<void> {
    const segments = target.split('/');
    const folderSegments = segments.slice(0, -1);
    let current = '';
    for (const segment of folderSegments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.vault.getAbstractFileByPath(current);
      if (isFolderLike(existing)) continue;
      if (!existing) {
        await this.vault.createFolder(current);
      } else {
        throw new Error(`Vault path "${current}" exists and is not a folder.`);
      }
    }
  }
}
