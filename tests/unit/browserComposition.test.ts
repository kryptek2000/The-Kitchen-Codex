import { describe, it, expect } from 'vitest';
import {
  createBrowserSettingsAdapter,
  createBrowserNetworkAdapter,
  createBrowserVaultAdapter,
} from '../../src/platform/browser/createBrowserAppServices';
import { BrowserSettingsAdapter } from '../../src/platform/browser/BrowserSettingsAdapter';
import { BrowserNetworkAdapter } from '../../src/platform/browser/BrowserNetworkAdapter';
import { BrowserFsaVaultAdapter } from '../../src/platform/browser/BrowserFsaVaultAdapter';

describe('browser composition bootstrap (Phase 4D3C)', () => {
  it('constructs the browser settings adapter', () => {
    const adapter = createBrowserSettingsAdapter();
    expect(adapter).toBeInstanceOf(BrowserSettingsAdapter);
  });

  it('constructs the browser network adapter', () => {
    const adapter = createBrowserNetworkAdapter();
    expect(adapter).toBeInstanceOf(BrowserNetworkAdapter);
  });

  it('constructs a browser vault adapter ONLY from a directory handle', async () => {
    const emptyDir = {
      kind: 'directory',
      name: 'vault',
      values: async function* () {},
      getFileHandle: async () => ({ name: '', kind: 'file', getFile: async () => ({ text: async () => '' }), createWritable: async () => ({ write: async () => {}, close: async () => {} }) }),
      getDirectoryHandle: async () => emptyDir,
      removeEntry: async () => {},
    };
    const adapter = createBrowserVaultAdapter(emptyDir);
    expect(adapter).toBeInstanceOf(BrowserFsaVaultAdapter);
    expect(await adapter.listMarkdownFiles()).toEqual([]);
  });

  it('returns a fresh instance per call (no shared singleton)', () => {
    expect(createBrowserSettingsAdapter()).not.toBe(createBrowserSettingsAdapter());
    expect(createBrowserNetworkAdapter()).not.toBe(createBrowserNetworkAdapter());
  });
});
