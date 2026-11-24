import { describe, expect, it, vi } from 'vitest';
import { ObsidianAssetAdapter } from '../../src/platform/obsidian/ObsidianAssetAdapter';
import { AssetPathCollisionError } from '../../src/application/adapters/AssetAdapter';

function fakeObsidianVault() {
  const files = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  const adapter = {
    readBinary: vi.fn(async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error('ENOENT');
      return bytes.slice().buffer;
    }),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      files.set(path, new Uint8Array(data));
    }),
    exists: vi.fn(async (path: string) => files.has(path)),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  const vault = {
    adapter,
    getAbstractFileByPath: (path: string) => {
      if (folders.has(path)) return { children: [] };
      const bytes = files.get(path);
      return bytes ? { path, name: path.split('/').pop(), extension: 'png' } : null;
    },
    createFolder: vi.fn(async (path: string) => {
      folders.add(path);
      return { path, name: path.split('/').pop(), children: [] };
    }),
    createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      if (files.has(path)) throw new Error('File already exists.');
      files.set(path, new Uint8Array(data));
      return { path, name: path.split('/').pop(), extension: 'png' };
    }),
  };
  return { vault, adapter, files, folders };
}

describe('R6 ObsidianAssetAdapter', () => {
  it('reads, writes, verifies existence and deletes binary assets', async () => {
    const { vault, files } = fakeObsidianVault();
    const asset = new ObsidianAssetAdapter(vault as any);
    const bytes = new Uint8Array([1, 2, 3]);
    await asset.write('Assets/Nested/photo.png', bytes);
    expect(files.get('Assets/Nested/photo.png')).toEqual(bytes);
    expect(await asset.exists('Assets/Nested/photo.png')).toBe(true);
    expect(Array.from(await asset.read('Assets/Nested/photo.png'))).toEqual([1, 2, 3]);
    await asset.delete('Assets/Nested/photo.png');
    expect(await asset.exists('Assets/Nested/photo.png')).toBe(false);
  });

  it('rejects an exclusive create when the asset already exists without overwriting', async () => {
    const { vault, files } = fakeObsidianVault();
    const asset = new ObsidianAssetAdapter(vault as any);
    files.set('Assets/photo.png', new Uint8Array([9]));
    await expect(asset.writeExclusive!('Assets/photo.png', new Uint8Array([1]))).rejects.toBeInstanceOf(
      AssetPathCollisionError
    );
    expect(files.get('Assets/photo.png')).toEqual(new Uint8Array([9]));
  });

  it('rejects unsafe absolute and traversal paths', async () => {
    const { vault } = fakeObsidianVault();
    const asset = new ObsidianAssetAdapter(vault as any);
    await expect(asset.write('/absolute.png', new Uint8Array([1]))).rejects.toThrow(/Absolute/);
    await expect(asset.write('Assets/../escape.png', new Uint8Array([1]))).rejects.toThrow(/Invalid/);
  });
});
