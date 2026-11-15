/**
 * The Kitchen Codex — Obsidian AssetAdapter (R6).
 *
 * Implements the platform-neutral AssetAdapter contract over the Obsidian
 * vault's binary data adapter. The Vault is injected (type-only import), so this
 * module remains Node-loadable with a duck-typed fake for tests.
 *
 * No network, no object URLs, no browser handles. Paths are vault-relative with
 * forward slashes and the same safe-segment policy as the text adapter.
 */

import type { Vault } from 'obsidian';
import {
  AssetPathCollisionError,
  type AssetAdapter,
} from '../../application/adapters/AssetAdapter';

interface ObsidianDataAdapterLike {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

interface ObsidianFolderLike {
  children?: unknown[];
}

interface ObsidianBinaryVaultLike {
  adapter: ObsidianDataAdapterLike;
  getAbstractFileByPath(path: string): unknown;
  createFolder(path: string): Promise<unknown>;
  createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
}

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

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = data.slice();
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
}

function isFolderLike(value: unknown): value is ObsidianFolderLike {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as ObsidianFolderLike).children);
}

export class ObsidianAssetAdapter implements AssetAdapter {
  constructor(private readonly vault: Vault) {}

  private get binaryVault(): ObsidianBinaryVaultLike {
    return this.vault as unknown as ObsidianBinaryVaultLike;
  }

  async read(path: string): Promise<Uint8Array> {
    const target = normalizeVaultRelativePath(path);
    const data = await this.binaryVault.adapter.readBinary(target);
    return new Uint8Array(data);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const target = normalizeVaultRelativePath(path);
    await this.ensureParentFolders(target);
    await this.binaryVault.adapter.writeBinary(target, toArrayBuffer(data));
  }

  async writeExclusive(path: string, data: Uint8Array): Promise<void> {
    const target = normalizeVaultRelativePath(path);
    if (await this.exists(target)) throw new AssetPathCollisionError(target);
    await this.ensureParentFolders(target);
    try {
      await this.binaryVault.createBinary(target, toArrayBuffer(data));
    } catch (error) {
      // If the target now exists, a concurrent writer won the name: report the
      // benign collision. Otherwise surface the real failure.
      if (await this.exists(target)) throw new AssetPathCollisionError(target);
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      return await this.binaryVault.adapter.exists(normalizeVaultRelativePath(path));
    } catch {
      return false;
    }
  }

  async delete(path: string): Promise<void> {
    const target = normalizeVaultRelativePath(path);
    await this.binaryVault.adapter.remove(target);
  }

  private async ensureParentFolders(target: string): Promise<void> {
    const segments = target.split('/');
    let current = '';
    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.binaryVault.getAbstractFileByPath(current);
      if (isFolderLike(existing)) continue;
      if (!existing) {
        await this.binaryVault.createFolder(current);
      } else {
        throw new Error(`Vault path "${current}" exists and is not a folder.`);
      }
    }
  }
}
