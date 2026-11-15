import { describe, it, expect, vi } from 'vitest';
import { saveImageToVaultAssets } from '../../src/utils/vaultAssets';
import type { AssetAdapter, RemoteImageDownloader } from '../../src/application/adapters/AssetAdapter';

const mk = (s: string) => new TextEncoder().encode(s);

function makeAsset(): AssetAdapter & { writes: Array<{ path: string; bytes: Uint8Array; contentType?: string }> } {
  const writes: Array<{ path: string; bytes: Uint8Array; contentType?: string }> = [];
  return {
    writes,
    async read() { return mk(''); },
    async write(path, bytes, contentType) { writes.push({ path, bytes, contentType }); },
    async exists() { return false; },
    async delete() {},
  };
}

function makeDownloader() {
  const fn = vi.fn<RemoteImageDownloader['downloadRemoteImage']>(async (url) => ({ bytes: mk('PNG'), contentType: 'image/png' }));
  return { fn, downloader: { downloadRemoteImage: fn } };
}

describe('saveImageToVaultAssets (Phase 4D3D)', () => {
  it('downloads a remote image via the injected downloader and writes it through the AssetAdapter', async () => {
    const asset = makeAsset();
    const { fn, downloader } = makeDownloader();
    const result = await saveImageToVaultAssets({ asset, downloadRemoteImage: downloader }, 'Test', 'https://r.example/a.jpg');
    expect(fn).toHaveBeenCalled();
    expect(fn.mock.calls[0][0]).toBe('https://r.example/a.jpg');
    expect(asset.writes).toHaveLength(1);
    expect(asset.writes[0].path).toMatch(/^Assets\/Test\.[a-z]+$/);
    expect(new TextDecoder().decode(asset.writes[0].bytes)).toBe('PNG');
    expect(result.success).toBe(true);
  });

  it('decodes a data URL locally (never calls the downloader)', async () => {
    const asset = makeAsset();
    const { fn, downloader } = makeDownloader();
    await saveImageToVaultAssets({ asset, downloadRemoteImage: downloader }, 'Data', 'data:image/png;base64,aGVsbG8=');
    expect(fn).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(asset.writes[0].bytes)).toBe('hello');
  });

  it('infers the extension from content-type (png)', async () => {
    const asset = makeAsset();
    const { downloader } = makeDownloader();
    await saveImageToVaultAssets({ asset, downloadRemoteImage: downloader }, 'Pic', 'https://r.example/img');
    expect(asset.writes[0].path).toMatch(/^Assets\/Pic\.png$/);
  });

  it('honors a preferredExtension override', async () => {
    const asset = makeAsset();
    const { downloader } = makeDownloader();
    await saveImageToVaultAssets({ asset, downloadRemoteImage: downloader }, 'Pic', 'https://r.example/img', 'jpeg');
    expect(asset.writes[0].path).toMatch(/^Assets\/Pic\.jpeg$/);
  });

  it('writes a Blob source directly (no downloader/direct fetch)', async () => {
    const asset = makeAsset();
    const { fn, downloader } = makeDownloader();
    const blob = new globalThis.Blob(['BLOB'], { type: 'image/gif' });
    await saveImageToVaultAssets({ asset, downloadRemoteImage: downloader }, 'Pic', blob);
    expect(fn).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(asset.writes[0].bytes)).toBe('BLOB');
    expect(asset.writes[0].contentType).toBe('image/gif');
  });

  it('fails gracefully (no unhandled rejection) when a remote download needs a downloader', async () => {
    const asset = makeAsset();
    const result = await saveImageToVaultAssets({ asset }, 'Pic', 'https://r.example/a.jpg');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/downloader/i);
  });

  it('never falls back to a direct fetch of the remote URL', async () => {
    const asset = makeAsset();
    const { fn, downloader } = makeDownloader();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response('x'));
    try {
      await saveImageToVaultAssets({ asset, downloadRemoteImage: downloader }, 'Pic', 'https://r.example/a.jpg');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalledWith('https://r.example/a.jpg');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('R6 — case-insensitive reference schemes', () => {
  it('never downloads or writes a case-variant blob URL source', async () => {
    let writes = 0;
    const asset = {
      write: async () => { writes += 1; },
      exists: async () => false,
      read: async () => new Uint8Array(),
      delete: async () => {},
    } as any;
    const downloader = { downloadRemoteImage: vi.fn(async () => ({ bytes: mk('PNG'), contentType: 'image/png' })) };
    for (const source of ['blob:x', 'Blob:x', 'BLOB:x', 'BLOB:http://example.test/a']) {
      const result = await saveImageToVaultAssets({ asset, downloadRemoteImage: downloader }, 'Pic', source);
      expect(result.success).toBe(false);
    }
    expect(downloader.downloadRemoteImage).not.toHaveBeenCalled();
    expect(writes).toBe(0);
  });

  it('accepts uppercase DATA URLs through the existing byte path', async () => {
    const writes: string[] = [];
    const asset = {
      write: async (path: string) => { writes.push(path); },
      exists: async () => false,
      read: async () => new Uint8Array(),
      delete: async () => {},
    } as any;
    const result = await saveImageToVaultAssets({ asset }, 'Upper Data', 'DATA:image/png;base64,aGVsbG8=');
    expect(result.success).toBe(true);
    expect(writes).toHaveLength(1);
  });
});
