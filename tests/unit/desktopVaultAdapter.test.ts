// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DesktopDirectoryHandle,
  seedStarterCopies,
  type DesktopBridge,
} from '../../src/platform/desktop';
import { BrowserFsaVaultAdapter } from '../../src/platform/browser/BrowserFsaVaultAdapter';
import { BrowserAssetAdapter } from '../../src/platform/browser/BrowserAssetAdapter';

function fakeBridge() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['']);
  const bridge = {
    isDesktop: true as const,
    platform: 'linux',
    getAppInfo: async () => ({ version: 'test', platform: 'linux', isPackaged: false, userData: '/tmp' }),
    getVaultInfo: async () => null,
    ensureManagedVault: async () => ({ path: '/vault', exists: true, initialized: false, isManaged: true, name: 'My Recipe Vault' }),
    chooseVaultDirectory: async () => null,
    setActiveVault: async () => ({ path: '/vault', exists: true, initialized: false, isManaged: true, name: 'My Recipe Vault' }),
    openVaultFolder: async () => ({ opened: true }),
    beginInitialization: async () => ({ action: 'claimed' as const, root: '/vault' }),
    completeInitialization: async () => ({ completed: true }),
    list: async (_root: string, relative: string) => {
      const prefix = relative ? `${relative}/` : '';
      const names = new Set<string>();
      const result: Array<{ name: string; kind: 'file' | 'directory' }> = [];
      for (const dir of dirs) {
        if (dir.startsWith(prefix) && dir !== relative && !dir.slice(prefix.length).includes('/')) {
          const name = dir.slice(prefix.length);
          if (name) { names.add(name); result.push({ name, kind: 'directory' }); }
        }
      }
      for (const file of files.keys()) {
        if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) {
          const name = file.slice(prefix.length);
          if (name && !names.has(name)) result.push({ name, kind: 'file' });
        }
      }
      return result;
    },
    stat: async (_root: string, relative: string) => {
      if (dirs.has(relative)) return { kind: 'directory' as const, size: 0, mtimeMs: 0 };
      const bytes = files.get(relative);
      if (!bytes) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
      return { kind: 'file' as const, size: bytes.length, mtimeMs: 0 };
    },
    exists: async (_root: string, relative: string) => dirs.has(relative) || files.has(relative),
    readText: async (_root: string, relative: string) => {
      const bytes = files.get(relative);
      if (!bytes) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
      return new TextDecoder().decode(bytes);
    },
    readBinary: async (_root: string, relative: string) => {
      const bytes = files.get(relative);
      if (!bytes) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
      return Buffer.from(bytes).toString('base64');
    },
    writeText: async (_root: string, relative: string, content: string) => {
      files.set(relative, new TextEncoder().encode(content));
      return { written: true };
    },
    writeBinary: async (_root: string, relative: string, base64: string) => {
      files.set(relative, new Uint8Array(Buffer.from(base64, 'base64')));
      return { written: true };
    },
    writeTextIfUnchanged: async (_root: string, relative: string, content: string, expected: string) => {
      const bytes = files.get(relative);
      if (!bytes || new TextDecoder().decode(bytes) !== expected) throw new Error('changed');
      files.set(relative, new TextEncoder().encode(content));
      return { written: true };
    },
    mkdir: async (_root: string, relative: string) => {
      dirs.add(relative);
      return { created: true };
    },
    remove: async (_root: string, relative: string) => {
      files.delete(relative);
      dirs.delete(relative);
      return { removed: true };
    },
  } as unknown as DesktopBridge;
  return { bridge, files, dirs };
}

describe('R6 desktop native Vault adapter', () => {
  it('implements the existing VaultAdapter contract over the native bridge', async () => {
    const { bridge, files } = fakeBridge();
    const handle = new DesktopDirectoryHandle(bridge, '/vault', '', 'My Recipe Vault');
    const vault = new BrowserFsaVaultAdapter(handle as any);
    await vault.writeText('Recipes/Nested/Dinner.md', '# Dinner\n');
    expect(await vault.exists('Recipes/Nested/Dinner.md')).toBe(true);
    expect(await vault.readText('Recipes/Nested/Dinner.md')).toBe('# Dinner\n');
    expect(await vault.listMarkdownFiles()).toEqual([{ path: 'Recipes/Nested/Dinner.md', name: 'Dinner.md' }]);
    files.set('Notes/Guide.md', new TextEncoder().encode('# Guide\n'));
    handle.getDirectoryHandle('Notes', { create: true });
    expect((await vault.listMarkdownFiles()).map((file) => file.path)).toContain('Notes/Guide.md');
    await vault.delete('Recipes/Nested/Dinner.md');
    expect(await vault.exists('Recipes/Nested/Dinner.md')).toBe(false);
  });

  it('supports binary asset writes/reads through the existing AssetAdapter', async () => {
    const { bridge, files } = fakeBridge();
    const handle = new DesktopDirectoryHandle(bridge, '/vault', '', 'My Recipe Vault');
    const asset = new BrowserAssetAdapter(handle as any);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await asset.write('Assets/photo.png', bytes, 'image/png');
    expect(await asset.exists('Assets/photo.png')).toBe(true);
    expect(await asset.read('Assets/photo.png')).toEqual(bytes);
    expect(files.has('Assets/photo.png')).toBe(true);
  });

  it('seeds starter copies idempotently without duplicating existing files', async () => {
    const { bridge, files } = fakeBridge();
    const handle = new DesktopDirectoryHandle(bridge, '/vault', '', 'My Recipe Vault');
    const starters = [
      { filePath: 'Signature Collection/One.md', rawMarkdown: '# One\n' },
      { filePath: 'Signature Collection/Two.md', rawMarkdown: '# Two\n' },
    ];
    expect(await seedStarterCopies(handle, starters)).toBe(2);
    expect(files.size).toBe(2);
    expect(await seedStarterCopies(handle, starters)).toBe(0);
    expect(files.size).toBe(2);
    expect(new TextDecoder().decode(files.get('Signature Collection/One.md'))).toBe('# One\n');
  });

  it('rejects traversal entry names at the renderer adapter boundary', async () => {
    const { bridge } = fakeBridge();
    const handle = new DesktopDirectoryHandle(bridge, '/vault', '', 'My Recipe Vault');
    await expect(handle.getFileHandle('..', { create: true })).rejects.toThrow(/Invalid Vault entry name/);
    await expect(handle.writeTextAt('../escape.md', 'x')).rejects.toThrow(/Invalid Vault path/);
  });
});
