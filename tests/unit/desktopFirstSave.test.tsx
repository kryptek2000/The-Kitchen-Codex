// @vitest-environment jsdom
/**
 * Desktop Foundation — zero-setup native Vault onboarding tests.
 *
 * The fake bridge implements the same narrow IPC contract as preload; the real
 * renderer DesktopDirectoryHandle and the existing App/VaultAdapter pipeline run
 * unchanged on top of it.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../src/App';
import {
  installDesktopRuntime,
  type DesktopBridge,
  type DesktopVaultInfo,
} from '../../src/platform/desktop';

interface FakeDesktop {
  bridge: DesktopBridge;
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  info: DesktopVaultInfo;
  failWrite: (relative: string) => boolean;
  marker: 'missing' | 'initializing' | 'complete';
  setActiveVaultCalls: string[];
  starterCount(): number;
}

function makeFakeDesktop(seed: Record<string, string> = {}, initialized = false): FakeDesktop {
  const files = new Map<string, Uint8Array>(
    Object.entries(seed).map(([path, text]) => [path, new TextEncoder().encode(text)])
  );
  const dirs = new Set<string>(['']);
  const root = '/tmp/tkc-desktop-test/My Recipe Vault';
  let marker: 'missing' | 'initializing' | 'complete' = initialized ? 'complete' : 'missing';
  let failWrite: (relative: string) => boolean = () => false;
  const setActiveVaultCalls: string[] = [];

  const ensureParents = (relative: string) => {
    const parts = relative.split('/');
    let current = '';
    for (const part of parts.slice(0, -1)) {
      current = current ? `${current}/${part}` : part;
      dirs.add(current);
    }
  };
  const info = (): DesktopVaultInfo => ({
    path: root,
    exists: true,
    initialized: marker === 'complete',
    initialization: marker,
    hasMarkdown: [...files.keys()].some((path) => /\.md$/i.test(path)),
    isManaged: true,
    name: 'My Recipe Vault',
  });

  const bridge = {
    isDesktop: true as const,
    platform: 'linux',
    getAppInfo: async () => ({ version: 'test', platform: 'linux', isPackaged: false, userData: '/tmp/tkc-desktop-test' }),
    getVaultInfo: async () => info(),
    ensureManagedVault: async () => { dirs.add(''); return info(); },
    chooseVaultDirectory: async () => info(),
    setActiveVault: async (activeRoot: string) => {
      setActiveVaultCalls.push(activeRoot);
      return info();
    },
    openVaultFolder: async () => ({ opened: true }),
    beginInitialization: async () => {
      if (marker === 'complete') return { action: 'already' as const, root };
      if (marker === 'initializing') return { action: 'resume' as const, root };
      const hasMarkdown = [...files.keys()].some((path) => /\.md$/i.test(path));
      if (hasMarkdown) return { action: 'existing' as const, root };
      marker = 'initializing';
      return { action: 'claimed' as const, root };
    },
    completeInitialization: async () => {
      marker = 'complete';
      return { completed: true };
    },
    list: async (_root: string, relative: string) => {
      const prefix = relative ? `${relative}/` : '';
      const result: Array<{ name: string; kind: 'file' | 'directory' }> = [];
      const names = new Set<string>();
      for (const dir of dirs) {
        if (dir !== relative && dir.startsWith(prefix)) {
          const name = dir.slice(prefix.length);
          if (name && !name.includes('/') && !names.has(name)) {
            names.add(name);
            result.push({ name, kind: 'directory' });
          }
        }
      }
      for (const file of files.keys()) {
        if (file.startsWith(prefix)) {
          const name = file.slice(prefix.length);
          if (name && !name.includes('/') && !names.has(name)) {
            names.add(name);
            result.push({ name, kind: 'file' });
          }
        }
      }
      return result;
    },
    stat: async (_root: string, relative: string) => {
      if (dirs.has(relative)) return { kind: 'directory' as const, size: 0, mtimeMs: 0 };
      const bytes = files.get(relative);
      if (!bytes) throw Object.assign(new Error(`NotFound: ${relative}`), { name: 'NotFoundError' });
      return { kind: 'file' as const, size: bytes.length, mtimeMs: 0 };
    },
    exists: async (_root: string, relative: string) => dirs.has(relative) || files.has(relative),
    readText: async (_root: string, relative: string) => {
      const bytes = files.get(relative);
      if (!bytes) throw Object.assign(new Error(`NotFound: ${relative}`), { name: 'NotFoundError' });
      return new TextDecoder().decode(bytes);
    },
    readBinary: async (_root: string, relative: string) => {
      const bytes = files.get(relative);
      if (!bytes) throw Object.assign(new Error(`NotFound: ${relative}`), { name: 'NotFoundError' });
      return Buffer.from(bytes).toString('base64');
    },
    writeText: async (_root: string, relative: string, content: string) => {
      if (failWrite(relative)) throw new Error('simulated native storage failure');
      ensureParents(relative);
      files.set(relative, new TextEncoder().encode(content));
      return { written: true };
    },
    writeBinary: async (_root: string, relative: string, base64: string) => {
      if (failWrite(relative)) throw new Error('simulated native storage failure');
      ensureParents(relative);
      files.set(relative, new Uint8Array(Buffer.from(base64, 'base64')));
      return { written: true };
    },
    writeTextIfUnchanged: async (_root: string, relative: string, content: string, expected: string) => {
      if (failWrite(relative)) throw new Error('simulated native storage failure');
      const bytes = files.get(relative);
      if (!bytes || new TextDecoder().decode(bytes) !== expected) throw new Error('changed');
      files.set(relative, new TextEncoder().encode(content));
      return { written: true };
    },
    mkdir: async (_root: string, relative: string) => {
      ensureParents(`${relative}/placeholder`);
      dirs.add(relative);
      return { created: true };
    },
    remove: async (_root: string, relative: string) => {
      files.delete(relative);
      dirs.delete(relative);
      return { removed: true };
    },
  } as unknown as DesktopBridge;

  return {
    bridge,
    files,
    dirs,
    info: info(),
    failWrite: (relative) => failWrite(relative),
    setActiveVaultCalls,
    get marker() { return marker; },
    starterCount: () => [...files.keys()].filter((path) => path.startsWith('Signature Collection/')).length,
  } as unknown as FakeDesktop;
}

function statusLine(): string {
  return document.getElementById('sidenav-vault-status-line')?.textContent || '';
}

async function openNewRecipe(title: string): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: /New Recipe Note/i }, { timeout: 15000 });
  fireEvent.click(buttons[0]);
  await waitFor(
    () => expect(screen.getByPlaceholderText(/Sourdough Rosemary Focaccia/i)).toBeTruthy(),
    { timeout: 15000 }
  );
  fireEvent.change(screen.getByPlaceholderText(/Sourdough Rosemary Focaccia/i), { target: { value: title } });
}

async function saveEditor(): Promise<void> {
  await waitFor(() => expect(screen.getByText('Save Obsidian Note')).toBeTruthy(), { timeout: 15000 });
  fireEvent.click(screen.getByText('Save Obsidian Note'));
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
  delete (window as any).kitchenCodexDesktop;
  delete (window as any).showDirectoryPicker;
});

describe('Desktop Foundation — first-save native Vault onboarding', () => {
  it('first launch shows the nine starters and New Recipe Note without a folder picker', async () => {
    const desktop = makeFakeDesktop();
    (window as any).kitchenCodexDesktop = desktop.bridge;
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    expect(screen.getAllByRole('button', { name: /New Recipe Note/i }).length).toBeGreaterThan(0);
    expect(desktop.files.size).toBe(0);
  });

  it('first Save creates the managed Vault with the original recipe and nine starter copies', async () => {
    const desktop = makeFakeDesktop();
    (window as any).kitchenCodexDesktop = desktop.bridge;
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    await openNewRecipe('My First Recipe');
    await saveEditor();

    await waitFor(() => expect(desktop.files.has('My First Recipe.md')).toBe(true), { timeout: 15000 });
    expect(desktop.starterCount()).toBe(9);
    expect(desktop.files.size).toBe(10);
    expect(desktop.marker).toBe('complete');
    expect(document.body.textContent).toContain('My First Recipe');
    expect(statusLine()).toMatch(/10 recipes/i);
  }, 45000);

  it('restart auto-reopens the managed Vault without duplicating starters', async () => {
    const desktop = makeFakeDesktop();
    (window as any).kitchenCodexDesktop = desktop.bridge;
    const first = render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openNewRecipe('Restart Recipe');
    await saveEditor();
    await waitFor(() => expect(desktop.files.has('Restart Recipe.md')).toBe(true), { timeout: 15000 });
    const beforeCount = desktop.files.size;
    first.unmount();

    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain('Restart Recipe'), { timeout: 15000 });
    expect(desktop.files.size).toBe(beforeCount);
    expect(desktop.starterCount()).toBe(9);
    expect(statusLine()).toMatch(/10 recipes/i);
  }, 60000);

  it('a simulated first-save storage failure keeps the editor draft and retries without duplication', async () => {
    const desktop = makeFakeDesktop();
    let fail = true;
    desktop.bridge.writeText = (async (_root: string, relative: string, content: string) => {
      if (fail && relative === 'Draft Recipe.md') throw new Error('simulated native storage failure');
      desktop.files.set(relative, new TextEncoder().encode(content));
      return { written: true };
    }) as any;
    (window as any).kitchenCodexDesktop = desktop.bridge;
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    await openNewRecipe('Draft Recipe');
    await saveEditor();
    await waitFor(() => expect(screen.getAllByText(/simulated native storage failure/i).length).toBeGreaterThan(0), { timeout: 15000 });
    expect(screen.getByDisplayValue('Draft Recipe')).toBeTruthy();
    expect(desktop.files.has('Draft Recipe.md')).toBe(false);
    expect(desktop.starterCount()).toBe(9);

    fail = false;
    await saveEditor();
    await waitFor(() => expect(desktop.files.has('Draft Recipe.md')).toBe(true), { timeout: 15000 });
    expect(desktop.starterCount()).toBe(9);
    expect(desktop.files.size).toBe(10);
  }, 60000);

  it('first action Save to My Vault on a built-in does not duplicate that starter', async () => {
    const desktop = makeFakeDesktop();
    (window as any).kitchenCodexDesktop = desktop.bridge;
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    const featured = [...document.querySelectorAll('button')].find((button) =>
      (button.textContent || '').trim() === 'Artisan Sourdough Boule'
    );
    expect(featured).toBeTruthy();
    fireEvent.click(featured!);
    await waitFor(() => expect(document.getElementById('recipe-detail-view')).toBeTruthy());
    fireEvent.click(screen.getByTestId('save-starter-to-vault-btn'));
    await waitFor(() => expect(desktop.files.size).toBe(9), { timeout: 20000 });
    expect(statusLine()).toMatch(/Vault linked · 9 recipes/i);
    expect(desktop.starterCount()).toBe(9);
    expect(desktop.files.size).toBe(9);
    expect(desktop.marker).toBe('complete');
  }, 45000);

  it('a rejected scan never becomes the active or remembered Vault', async () => {
    const desktop = makeFakeDesktop();
    (window as any).kitchenCodexDesktop = desktop.bridge;
    installDesktopRuntime();
    desktop.bridge.list = async () => {
      throw new Error('simulated Vault scan failure');
    };
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    const chip = document.getElementById('connect-vault-chip')
      || document.getElementById('vault-linked-chip');
    fireEvent.click(chip!);
    await waitFor(() => expect(document.getElementById('connect-vault-modal-overlay')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Live Directory Sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /Choose Local Obsidian Vault Folder/i }));

    await waitFor(
      () => expect(document.body.textContent || '').toMatch(/simulated Vault scan failure/i),
      { timeout: 15000 }
    );
    expect(desktop.setActiveVaultCalls).toEqual([]);
    expect(statusLine()).not.toMatch(/Vault linked/i);
    expect(desktop.files.size).toBe(0);
  }, 45000);

  it('surfaces a persistence failure without pretending the Vault was remembered', async () => {
    const desktop = makeFakeDesktop();
    (window as any).kitchenCodexDesktop = desktop.bridge;
    installDesktopRuntime();
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    // The accepted scan now finds a real recipe; only the restart-authority
    // write fails. The session connection itself is valid and stays open.
    desktop.files.set('Existing Recipe.md', new TextEncoder().encode('# Existing Recipe\n'));
    desktop.bridge.setActiveVault = (async (activeRoot: string) => {
      desktop.setActiveVaultCalls.push(activeRoot);
      throw new Error('simulated state write failure');
    }) as any;

    const chip = document.getElementById('connect-vault-chip')
      || document.getElementById('vault-linked-chip');
    fireEvent.click(chip!);
    await waitFor(() => expect(document.getElementById('connect-vault-modal-overlay')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Live Directory Sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /Choose Local Obsidian Vault Folder/i }));

    await waitFor(
      () =>
        expect(document.body.textContent || '').toMatch(
          /could not save it as the remembered Vault/i
        ),
      { timeout: 15000 }
    );
    expect(desktop.setActiveVaultCalls.length).toBe(1);
    expect(statusLine()).toMatch(/Vault linked · 1 recipe/i);
    expect(document.body.textContent || '').toContain('Existing Recipe');
  }, 45000);

  it('an existing disposable Vault opens without importing starters', async () => {
    const desktop = makeFakeDesktop({ 'Existing Recipe.md': '# Existing Recipe\n' }, true);
    (window as any).kitchenCodexDesktop = desktop.bridge;
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain('Existing Recipe'), { timeout: 15000 });
    expect(desktop.starterCount()).toBe(0);
    expect(desktop.files.size).toBe(1);
    expect(statusLine()).toMatch(/1 recipe/i);
  }, 30000);
});
