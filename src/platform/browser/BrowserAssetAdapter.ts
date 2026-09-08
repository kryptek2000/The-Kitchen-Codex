/**
 * The Kitchen Codex — Browser File System Access Asset Adapter (Phase 4D3D).
 *
 * Concrete implementation of the application `AssetAdapter` port for the browser
 * File System Access runtime. It reads/writes binary asset BYTES inside the
 * connected vault directory (e.g. `Assets/recipe.jpg`).
 *
 * PLACEMENT: browser/platform implementation detail under `src/platform/browser`.
 *
 * SECURITY / SCOPE:
 *   - bytes are `Uint8Array` (platform-neutral); the adapter never returns a
 *     `Blob`, never creates object URLs, and never touches the network.
 *   - The directory handle is INJECTED (never picked via `showDirectoryPicker`;
 *     that belongs to the UI/connection flow).
 *   - Vault-relative path traversal is validated before use (reject absolute and
 *     `.`/`..` segments); the root handle is never escaped. No Node `fs`/`path`.
 *
 * Runtime has no remote fetch, no provider/secret logic, no rendering concern.
 */

import type { AssetAdapter } from '../../application/adapters/AssetAdapter';
import type { FsaDirectoryHandleLike, FsaFileHandleLike } from './BrowserFsaVaultAdapter';

const MEDIA_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
};

function isNotFound(error: unknown): boolean {
  return Boolean(error) && String((error as { name?: unknown }).name) === 'NotFoundError';
}

function notFoundError(path: string): Error {
  const error = new Error(`Asset not found: ${path}`);
  Object.defineProperty(error, 'name', { value: 'NotFoundError' });
  Object.defineProperty(error, 'code', { value: 'NotFoundError' });
  return error;
}

function splitVaultPath(path: string): string[] {
  const normalized = String(path ?? '').replace(/\\/g, '/').trim();
  if (!normalized) throw new Error('Asset path must not be empty.');
  if (normalized.startsWith('/')) throw new Error('Absolute asset paths are not allowed.');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Invalid asset path segment "${segment}".`);
    }
  }
  return segments;
}

/** Resolves the parent directory + file name for a vault-relative asset path. */
async function resolveTarget(
  root: FsaDirectoryHandleLike,
  path: string
): Promise<{ parent: FsaDirectoryHandleLike; fileName: string }> {
  const segments = splitVaultPath(path);
  const fileName = segments[segments.length - 1];
  let dir = root;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create: true });
  }
  return { parent: dir, fileName };
}

function extFromPath(path: string): string | undefined {
  const last = (String(path ?? '').split('/').pop() ?? '').toLowerCase();
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot) : undefined;
}

/** Appends a media-type-derived extension only when the path has none. */
function normalizeWritePath(path: string, contentType: string | undefined): string {
  if (extFromPath(path)) return path;
  const ext = MEDIA_TYPE_TO_EXT[(contentType ?? '').toLowerCase()];
  return ext ? `${path}${ext}` : path;
}

/**
 * Browser File System Access implementation of the `AssetAdapter` contract.
 * The root directory handle is supplied by the browser shell (injected).
 */
export class BrowserAssetAdapter implements AssetAdapter {
  constructor(private readonly root: FsaDirectoryHandleLike) {}

  async read(path: string): Promise<Uint8Array> {
    const { parent, fileName } = await this.resolveTargetOrThrow(path);
    let fileHandle: FsaFileHandleLike;
    try {
      fileHandle = await parent.getFileHandle(fileName, { create: false });
    } catch (error) {
      if (isNotFound(error)) throw notFoundError(path);
      throw error;
    }
    const file = await fileHandle.getFile();
    const buffer = await (file as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
    return new Uint8Array(buffer);
  }

  async write(path: string, data: Uint8Array, contentType?: string): Promise<void> {
    const target = normalizeWritePath(path, contentType);
    const { parent, fileName } = await resolveTarget(this.root, target);
    const fileHandle = await parent.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(data);
      await writable.close();
    } catch (error) {
      if (typeof writable.abort === 'function') {
        try {
          await writable.abort();
        } catch {
          // ignore secondary abort failure
        }
      }
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { parent, fileName } = await resolveTarget(this.root, path);
      await parent.getFileHandle(fileName, { create: false });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(path: string): Promise<void> {
    const { parent, fileName } = await this.resolveTargetOrThrow(path);
    try {
      await parent.removeEntry(fileName);
    } catch (error) {
      if (isNotFound(error)) throw notFoundError(path);
      throw error;
    }
  }

  private async resolveTargetOrThrow(path: string): Promise<{ parent: FsaDirectoryHandleLike; fileName: string }> {
    try {
      return await resolveTarget(this.root, path);
    } catch (error) {
      if (isNotFound(error)) throw notFoundError(path);
      throw error;
    }
  }
}
