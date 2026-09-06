/**
 * The Kitchen Codex — Browser File System Access Vault Adapter (Phase 4C2).
 *
 * The first CONCRETE platform adapter. It implements the application-facing
 * `VaultAdapter` port using the browser File System Access API primitives the app
 * already uses (directory handles, `getFileHandle`/`getDirectoryHandle`/
 * `createWritable`/`removeEntry`), WITHOUT inventing a second filesystem engine.
 *
 * PLACEMENT: this is browser/platform implementation detail, so it lives under
 * `src/platform/browser/`, NEVER under `src/core` or `src/application`. Its only
 * project dependency is the `VaultAdapter` contract (platform -> application is the
 * allowed direction; application/core must not import platform).
 *
 * DESIGN:
 *   - The active `FileSystemDirectoryHandle` is INJECTED via the constructor.
 *     The adapter NEVER calls `showDirectoryPicker` — user interaction and
 *     permission prompts belong to the UI/connection flow, not to the storage
 *     contract (and future Obsidian/PWA adapters need no picker semantics).
 *   - Only the five `VaultAdapter` (text/Markdown) methods are exposed. Image/
 *     asset operations, sync/watch/conflict, and drag-drop/upload/download
 *     fallbacks are NOT absorbed here (deferred).
 *   - Handles are duck-typed to a minimal structural shape so the adapter is both
 *     browser-safe and directly testable in Node with plain-object mocks (no
 *     reliance on the DOM global `FileSystemDirectoryHandle`/`File`).
 *
 * SECURITY: vault-relative path traversal is validated before use — absolute paths
 * and `.`/`..` segments are rejected, separators are normalized, and the root
 * directory handle is never escaped. No Node `fs`/`path` imports are used.
 */

import type { VaultAdapter, VaultMarkdownFile } from '../../application/adapters/VaultAdapter';

// --- Minimal structural duck-types (browser-safe, mock-friendly) -------------

/** A directory or file entry yielded by `values()`. */
export type FsaEntryLike = FsaFileHandleLike | FsaDirectoryHandleLike;

/** Minimal writable stream returned by `createWritable()`. */
export interface FsaWritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

/** Minimal file handle shape (only what read/write need). */
export interface FsaFileHandleLike {
  readonly name: string;
  readonly kind: 'file';
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<FsaWritableLike>;
}

/** Minimal directory handle shape (only what vault CRUD needs). */
export interface FsaDirectoryHandleLike {
  readonly name: string;
  readonly kind: 'directory';
  values(): AsyncIterable<FsaEntryLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsaDirectoryHandleLike>;
  removeEntry(name: string): Promise<void>;
  queryPermission?(descriptor?: unknown): Promise<string>;
  requestPermission?(descriptor?: unknown): Promise<string>;
}

// --- Helpers -----------------------------------------------------------------

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

/** Splits and validates a vault-relative path into a list of clean segments. */
function splitVaultPath(path: string): string[] {
  const normalized = String(path ?? '').replace(/\\/g, '/').trim();
  if (!normalized) throw new Error('Vault path must not be empty.');
  if (normalized.startsWith('/')) throw new Error('Absolute vault paths are not allowed.');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Invalid vault path segment "${segment}" in "${path}".`);
    }
  }
  return segments;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error) && String((error as { name?: unknown }).name) === 'NotFoundError';
}

/** Normalizes a missing-vault-file condition into a real `Error` (contract-safe). */
function notFoundError(path: string): Error {
  const error = new Error(`Vault file not found: ${path}`);
  Object.defineProperty(error, 'name', { value: 'NotFoundError' });
  Object.defineProperty(error, 'code', { value: 'NotFoundError' });
  return error;
}

/**
 * The single implementation of vault-relative path traversal. Walks every
 * non-leaf segment as a directory handle (escaping the root is impossible because
 * segments are validated and `..`/absolute paths are rejected first).
 */
async function resolveFileTarget(
  root: FsaDirectoryHandleLike,
  path: string,
  createParents: boolean
): Promise<{ parent: FsaDirectoryHandleLike; fileName: string }> {
  const segments = splitVaultPath(path);
  const fileName = segments[segments.length - 1];
  let dir: FsaDirectoryHandleLike = root;
  for (let i = 0; i < segments.length - 1; i++) {
    // `create:true` up-creates parent dirs for writes; `create:false` surfaces
    // NotFoundError for reads/deletes/exists (the caller handles that).
    dir = await dir.getDirectoryHandle(segments[i], { create: createParents });
  }
  return { parent: dir, fileName };
}

/**
 * Browser File System Access implementation of the `VaultAdapter` contract.
 * The root `FileSystemDirectoryHandle` is supplied by the caller (injected).
 */
export class BrowserFsaVaultAdapter implements VaultAdapter {
  constructor(private readonly root: FsaDirectoryHandleLike) {}

  async listMarkdownFiles(): Promise<VaultMarkdownFile[]> {
    const results: VaultMarkdownFile[] = [];

    const walk = async (dir: FsaDirectoryHandleLike, prefix: string): Promise<void> => {
      for await (const entry of dir.values()) {
        if (entry.kind === 'directory') {
          await walk(entry, prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.kind === 'file' && MARKDOWN_EXTENSION.test(entry.name)) {
          results.push({
            path: prefix ? `${prefix}/${entry.name}` : entry.name,
            name: entry.name,
          });
        }
      }
    };

    await walk(this.root, '');
    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  async readText(path: string): Promise<string> {
    const { parent, fileName } = await this.resolveFileOrThrow(path, false);
    let fileHandle: FsaFileHandleLike;
    try {
      fileHandle = await parent.getFileHandle(fileName, { create: false });
    } catch (error) {
      if (isNotFound(error)) throw notFoundError(path);
      throw error;
    }
    const file = await fileHandle.getFile();
    return file.text();
  }

  async writeText(path: string, content: string): Promise<void> {
    const { parent, fileName } = await resolveFileTarget(this.root, path, true);
    const fileHandle = await parent.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async delete(path: string): Promise<void> {
    const { parent, fileName } = await this.resolveFileOrThrow(path, false);
    try {
      await parent.removeEntry(fileName);
    } catch (error) {
      if (isNotFound(error)) throw notFoundError(path);
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { parent, fileName } = await resolveFileTarget(this.root, path, false);
      await parent.getFileHandle(fileName, { create: false });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /** Resolves a read/delete target, surfacing missing parents/files as a real Error. */
  private async resolveFileOrThrow(
    path: string,
    createParents: boolean
  ): Promise<{ parent: FsaDirectoryHandleLike; fileName: string }> {
    try {
      return await resolveFileTarget(this.root, path, createParents);
    } catch (error) {
      if (isNotFound(error)) throw notFoundError(path);
      throw error;
    }
  }
}
