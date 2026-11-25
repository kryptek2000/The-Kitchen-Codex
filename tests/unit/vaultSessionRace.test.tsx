// @vitest-environment jsdom
/**
 * R2 — Vault session integrity under adversarial async races.
 *
 * Every write is measured against a disposable in-memory FSA tree. No test
 * touches the owner Vault, IndexedDB, or port 3040.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../src/App';

const idb = vi.hoisted(() => ({
  getHandle: vi.fn(),
  saveHandle: vi.fn(),
  clearHandle: vi.fn(),
}));

vi.mock('../../src/utils/vaultFileSystem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/vaultFileSystem')>();
  return {
    ...actual,
    getDirectoryHandleFromIDB: (...args: any[]) => idb.getHandle(...args),
    saveDirectoryHandleToIDB: (...args: any[]) => idb.saveHandle(...args),
    clearDirectoryHandleFromIDB: (...args: any[]) => idb.clearHandle(...args),
  };
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const RECIPE_MD = (title: string) => `---
title: ${title}
cuisine: Test
category: Dinner
tags:
  - food/recipes
---
# ${title}
## Ingredients
- 1 cup flour
## Instructions
1. Cook it.
`;

class Harness {
  root!: MockDir;
  writes: Array<{ path: string; content: string }> = [];
  scanStarted = 0;
  scanGate: Promise<void> | null = null;
  scanError: Error | null = null;
  writeGate: Promise<void> | null = null;
  shouldGateWrite: (path: string) => boolean = () => false;
  gateReached: (() => void) | null = null;
  permission: 'granted' | 'denied' | 'prompt' = 'granted';
  onWrite: ((path: string) => void) | null = null;
  signatureGateHits = 0;
}

class MockFile {
  kind = 'file' as const;
  content = '';
  constructor(
    private readonly harness: Harness,
    public name: string,
    public path: string
  ) {}
  async getFile() {
    return { text: async () => this.content };
  }
  async createWritable() {
    const self = this;
    return {
      write: async (data: string | Uint8Array) => {
        const text = String(data);
        self.harness.writes.push({ path: self.path, content: text });
        self.harness.onWrite?.(self.path);
        if (self.harness.writeGate && self.harness.shouldGateWrite(self.path)) {
          const gate = self.harness.writeGate;
          self.harness.writeGate = null;
          self.harness.gateReached?.();
          await gate;
        }
        self.content = text;
      },
      close: async () => {},
      abort: async () => {},
    };
  }
}

class MockDir {
  kind = 'directory' as const;
  children = new Map<string, MockDir | MockFile>();
  constructor(
    private readonly harness: Harness,
    public name: string,
    public path = ''
  ) {}
  async *values(): AsyncGenerator<MockDir | MockFile> {
    this.harness.scanStarted += 1;
    if (this.path === '' && this.harness.scanError) throw this.harness.scanError;
    if (this.path === '' && this.harness.scanGate) await this.harness.scanGate;
    for (const child of this.children.values()) yield child;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing) return existing;
    if (options?.create) {
      const file = new MockFile(this.harness, name, this.path ? `${this.path}/${name}` : name);
      this.children.set(name, file);
      return file;
    }
    const error = new Error('NotFoundError');
    error.name = 'NotFoundError';
    throw error;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing) return existing;
    if (options?.create) {
      const dir = new MockDir(this.harness, name, this.path ? `${this.path}/${name}` : name);
      this.children.set(name, dir);
      return dir;
    }
    const error = new Error('NotFoundError');
    error.name = 'NotFoundError';
    throw error;
  }
  async removeEntry(name: string) { this.children.delete(name); }
  async queryPermission() { return this.harness.permission; }
  async requestPermission() { return this.harness.permission; }
}

function makeVault(name: string, files: Record<string, string> = {}): Harness {
  const harness = new Harness();
  const root = new MockDir(harness, name);
  harness.root = root;
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.children.get(parts[i]);
      if (!(next instanceof MockDir)) {
        next = new MockDir(harness, parts[i], dir.path ? `${dir.path}/${parts[i]}` : parts[i]);
        dir.children.set(parts[i], next);
      }
      dir = next;
    }
    const fileName = parts[parts.length - 1];
    dir.children.set(fileName, new MockFile(harness, fileName, dir.path ? `${dir.path}/${fileName}` : fileName));
    const file = dir.children.get(fileName) as MockFile;
    file.content = content;
  }
  return harness;
}

function uploadFile(name: string, webkitRelativePath: string, content: string): File {
  return { name, webkitRelativePath, text: async () => content } as unknown as File;
}

function uploadFileDeferred(
  name: string,
  webkitRelativePath: string,
  text: () => Promise<string>
): File {
  return { name, webkitRelativePath, text } as unknown as File;
}

function droppedFileEntry(name: string, content: string) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (callback: (file: File) => void) =>
      callback({ name, text: async () => content } as unknown as File),
  };
}

function droppedFolderEntry(name: string, children: any[]) {
  let served = false;
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (callback: (entries: any[]) => void) => {
        if (!served) {
          served = true;
          callback(children);
        } else {
          callback([]);
        }
      },
    }),
  };
}

function statusLine(): string {
  return document.getElementById('sidenav-vault-status-line')?.textContent || '';
}

async function openVaultModal(): Promise<void> {
  const chip = document.getElementById('connect-vault-chip')
    || document.getElementById('vault-linked-chip');
  if (chip) {
    fireEvent.click(chip);
  } else {
    fireEvent.click(screen.getByRole('button', { name: /Connect Vault/i }));
  }
  await waitFor(() => expect(document.getElementById('connect-vault-modal-overlay')).toBeTruthy());
}

function openUploadTab(): void {
  const tab = screen.getByRole('tab', { name: /Import Folder \/ Files/i });
  fireEvent.click(tab);
}

function selectFolder(files: File[]): void {
  const input = document.querySelector('input[webkitdirectory]') as HTMLInputElement;
  expect(input).toBeTruthy();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

async function chooseDirectVault(harness: Harness): Promise<void> {
  (window as any).showDirectoryPicker = async () => harness.root;
  await openVaultModal();
  const tab = screen.getByRole('tab', { name: /Live Directory Sync/i });
  fireEvent.click(tab);
  fireEvent.click(screen.getByRole('button', { name: /Choose Local Obsidian Vault Folder/i }));
}

async function closeVaultModal(): Promise<void> {
  const close = document.querySelector('button[aria-label="Close Vault settings"]') as HTMLButtonElement | null;
  if (close) fireEvent.click(close);
  await waitFor(() => expect(document.getElementById('connect-vault-modal-overlay')).toBeNull());
}

async function connectDirect(harness: Harness): Promise<void> {
  await chooseDirectVault(harness);
  await waitFor(() => expect(statusLine()).toMatch(/Vault linked/i), { timeout: 15000 });
  await closeVaultModal();
}

beforeEach(() => {
  idb.getHandle.mockReset().mockResolvedValue(null);
  idb.saveHandle.mockReset().mockResolvedValue(true);
  idb.clearHandle.mockReset().mockResolvedValue(true);
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
  delete (window as any).showDirectoryPicker;
});

describe('R2 — folder replacement vs an older FSA scan', () => {
  it('keeps Folder B authoritative when a slow Vault A scan resolves later', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    const gate = deferred();
    a.scanGate = gate.promise;

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await chooseDirectVault(a);
    await waitFor(() => expect(a.scanStarted).toBeGreaterThan(0));

    openUploadTab();
    selectFolder([]);
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 0 recipes/i));

    gate.resolve();
    await waitFor(() => expect(screen.getByText(/newer Vault selection replaced this connection/i)).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(statusLine()).toMatch(/Recipes loaded · 0 recipes/i);
    expect(screen.queryByText('A Recipe')).toBeNull();
    expect(idb.saveHandle.mock.calls.some(([handle]: any[]) => handle === a.root)).toBe(false);
  }, 45000);

  it('does not let an old IndexedDB reconnect replace a newer read-only import', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    const gate = deferred<any>();
    idb.getHandle.mockReturnValue(gate.promise);

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await openVaultModal();
    openUploadTab();
    selectFolder([]);
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 0 recipes/i));

    gate.resolve(a.root);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(statusLine()).toMatch(/Recipes loaded · 0 recipes/i);
    expect(screen.queryByText('A Recipe')).toBeNull();
    expect(idb.saveHandle).not.toHaveBeenCalled();
  }, 45000);

  it('lets a later writable Vault A replace an earlier read-only import B', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();
    selectFolder([uploadFile('B Recipe.md', 'B/B Recipe.md', RECIPE_MD('B Recipe'))]);
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 1 recipe/i));

    await chooseDirectVault(a);
    await waitFor(() => expect(statusLine()).toMatch(/Vault linked · 1 recipe/i), { timeout: 15000 });
    await closeVaultModal();

    expect(document.body.textContent).toContain('A Recipe');
    expect(document.body.textContent).not.toContain('B Recipe');
  }, 45000);

  it('replaces one read-only import with the next when two are dispatched rapidly', async () => {
    const b = uploadFile('B Recipe.md', 'B/B Recipe.md', RECIPE_MD('B Recipe'));
    const c = uploadFile('C Recipe.md', 'C/C Recipe.md', RECIPE_MD('C Recipe'));

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();
    selectFolder([b]);
    selectFolder([c]);

    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 1 recipe/i), { timeout: 15000 });
    await waitFor(() => expect(document.getElementById('vault-recipe-count')?.textContent).toBe('1 recipe'));
    const body = document.body.textContent || '';
    expect(body).toContain('C Recipe');
    expect(body).not.toContain('B Recipe');
    expect(idb.clearHandle.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 45000);
});

describe('R3 — automatic reconnect arbitration', () => {
  it('does not let automatic reconnect start after an explicit folder intent is pending', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    const permission = deferred<any>();
    a.root.queryPermission = () => permission.promise;
    idb.getHandle.mockResolvedValue(a.root);

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.scanStarted).toBe(0);

    const slowB = deferred<string>();
    await openVaultModal();
    openUploadTab();
    selectFolder([uploadFileDeferred('B Recipe.md', 'B/B Recipe.md', () => slowB.promise)]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    permission.resolve('granted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The automatic A scan must never begin; B's parse intent owns ordering.
    expect(a.scanStarted).toBe(0);

    slowB.resolve(RECIPE_MD('B Recipe'));
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 1 recipe/i), { timeout: 15000 });
    expect(document.body.textContent).toContain('B Recipe');
    expect(document.body.textContent).not.toContain('A Recipe');
  }, 45000);

  it('aborts an automatic snapshot that resolves during a pending explicit folder selection', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    const scanGate = deferred();
    a.scanGate = scanGate.promise;
    idb.getHandle.mockResolvedValue(a.root);

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await waitFor(() => expect(a.scanStarted).toBeGreaterThan(0), { timeout: 15000 });

    const slowB = deferred<string>();
    await openVaultModal();
    openUploadTab();
    selectFolder([uploadFileDeferred('B Recipe.md', 'B/B Recipe.md', () => slowB.promise)]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    scanGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(document.body.textContent).not.toContain('A Recipe');

    slowB.resolve(RECIPE_MD('B Recipe'));
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 1 recipe/i), { timeout: 15000 });
    expect(document.body.textContent).toContain('B Recipe');
    expect(document.body.textContent).not.toContain('A Recipe');
  }, 45000);

  it('keeps automatic reconnect functional when no user intent exists', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    idb.getHandle.mockResolvedValue(a.root);

    render(<App />);
    await waitFor(() => expect(statusLine()).toMatch(/Vault linked · 1 recipe/i), { timeout: 15000 });
    expect(document.body.textContent).toContain('A Recipe');
    expect(a.scanStarted).toBeGreaterThan(0);
  }, 45000);
});

describe('R3 — latest-intent folder import ordering', () => {
  it('keeps the faster newer folder when an older parse resolves later', async () => {
    const slowA = deferred<string>();
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();

    selectFolder([uploadFileDeferred('A Recipe.md', 'A/A Recipe.md', () => slowA.promise)]);
    selectFolder([uploadFile('B Recipe.md', 'B/B Recipe.md', RECIPE_MD('B Recipe'))]);
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 1 recipe/i), { timeout: 15000 });
    expect(document.body.textContent).toContain('B Recipe');

    slowA.resolve(RECIPE_MD('A Recipe'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.body.textContent).toContain('B Recipe');
    expect(document.body.textContent).not.toContain('A Recipe');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('1 recipe');
  }, 45000);

  it('keeps the slower newer folder when the older parse resolves first', async () => {
    const slowB = deferred<string>();
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();

    selectFolder([uploadFile('A Recipe.md', 'A/A Recipe.md', RECIPE_MD('A Recipe'))]);
    await waitFor(() => expect(document.body.textContent).toContain('A Recipe'), { timeout: 15000 });

    selectFolder([uploadFileDeferred('B Recipe.md', 'B/B Recipe.md', () => slowB.promise)]);
    slowB.resolve(RECIPE_MD('B Recipe'));
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 1 recipe/i), { timeout: 15000 });
    await waitFor(() => expect(document.body.textContent).toContain('B Recipe'));
    expect(document.body.textContent).not.toContain('A Recipe');
  }, 45000);

  it('orders a picker parse and a later folder drop through the same intent authority', async () => {
    const slowPicker = deferred<string>();
    const { container } = render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();
    selectFolder([uploadFileDeferred('A Recipe.md', 'A/A Recipe.md', () => slowPicker.promise)]);

    const folder = droppedFolderEntry('B', [droppedFileEntry('B Recipe.md', RECIPE_MD('B Recipe'))]);
    fireEvent.drop(container.firstElementChild as Element, {
      dataTransfer: { items: [{ webkitGetAsEntry: () => folder }], files: [] },
    });
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 1 recipe/i), { timeout: 15000 });
    expect(document.body.textContent).toContain('B Recipe');

    slowPicker.resolve(RECIPE_MD('A Recipe'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.body.textContent).toContain('B Recipe');
    expect(document.body.textContent).not.toContain('A Recipe');
  }, 45000);

  it('does not resurrect an older parse when the newer intent is cancelled by failure', async () => {
    const slowA = deferred<string>();
    const failingB = deferred<string>();
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();

    selectFolder([uploadFileDeferred('A Recipe.md', 'A/A Recipe.md', () => slowA.promise)]);
    selectFolder([uploadFileDeferred('B Recipe.md', 'B/B Recipe.md', () => failingB.promise)]);
    failingB.reject(new Error('newest intent failed'));
    await waitFor(() => expect(screen.getByText(/newest intent failed/i)).toBeTruthy());

    slowA.resolve(RECIPE_MD('A Recipe'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.body.textContent).not.toContain('A Recipe');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 recipes');
  }, 45000);

  it('does not let a stale parse failure clear a newer successful import', async () => {
    const failingA = deferred<string>();
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();

    selectFolder([uploadFileDeferred('A Recipe.md', 'A/A Recipe.md', () => failingA.promise)]);
    selectFolder([uploadFile('B Recipe.md', 'B/B Recipe.md', RECIPE_MD('B Recipe'))]);
    await waitFor(() => expect(document.body.textContent).toContain('B Recipe'), { timeout: 15000 });

    failingA.reject(new Error('stale parse failed'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.body.textContent).toContain('B Recipe');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('1 recipe');
  }, 45000);
});

describe('R3 — Refresh preserves read-only uploaded collections', () => {
  it('preserves an uploaded Meal Plan instead of restoring the starter plan', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();
    selectFolder([uploadFile('Meal Plan.md', 'B/Meal Plan.md', '---\ntype: meal-plan\n---\n\n## Monday\n- **Dinner**: [[Imported Dinner]]\n')]);
    await waitFor(() => expect(document.getElementById('connect-vault-modal-overlay')).toBeTruthy());
    await closeVaultModal();

    fireEvent.click(document.getElementById('nav-meal-planner')!);
    await waitFor(() => expect(document.body.textContent).toContain('Imported Dinner'));
    fireEvent.click(document.getElementById('refresh-vault-btn')!);
    await waitFor(() => expect(screen.getByTestId('vault-notice').textContent).toMatch(/cannot be rescanned/i));
    expect(document.body.textContent).toContain('Imported Dinner');
    expect(document.body.textContent).not.toContain('Thai Green Coconut Curry');
  }, 45000);

  it('preserves a notes-only uploaded collection', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();
    selectFolder([uploadFile('Kitchen Notes.md', 'B/Kitchen Notes.md', '---\ntags:\n  - technique\n---\n# Kitchen Notes\nReference.\n')]);
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 0 recipes · 1 note/i));
    await closeVaultModal();

    fireEvent.click(document.getElementById('refresh-vault-btn')!);
    await waitFor(() => expect(screen.getByTestId('vault-notice').textContent).toMatch(/cannot be rescanned/i));
    expect(statusLine()).toMatch(/Recipes loaded · 0 recipes · 1 note/i);
  }, 45000);

  it('preserves a shopping-list-only uploaded collection', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await openVaultModal();
    openUploadTab();
    selectFolder([uploadFile('Shopping List.md', 'B/Shopping List.md', '---\ntype: shopping-list\n---\n\n## Produce\n- [ ] dragonfruit\n')]);
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 0 recipes/i));
    await closeVaultModal();

    fireEvent.click(document.getElementById('nav-shopping-list')!);
    await waitFor(() => expect(document.body.textContent).toContain('dragonfruit'));
    fireEvent.click(document.getElementById('refresh-vault-btn')!);
    await waitFor(() => expect(screen.getByTestId('vault-notice').textContent).toMatch(/cannot be rescanned/i));
    expect(document.body.textContent).toContain('dragonfruit');
    expect(document.body.textContent).not.toContain('Thai green curry paste');
  }, 45000);

  it('still performs the intended rescan for a writable Vault', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectDirect(a);
    const scansBefore = a.scanStarted;
    fireEvent.click(document.getElementById('refresh-vault-btn')!);
    await waitFor(() => expect(a.scanStarted).toBeGreaterThan(scansBefore), { timeout: 15000 });
    expect(statusLine()).toMatch(/Vault linked · 1 recipe/i);
    expect(document.body.textContent).toContain('A Recipe');
  }, 45000);

  it('still refreshes the actual Signature starter collection', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    fireEvent.click(document.getElementById('refresh-vault-btn')!);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 recipes');
    expect(document.body.textContent).toContain('Artisan Sourdough Boule');
  }, 45000);
});

describe('R2 — autosave and transition barrier', () => {
  it('waits for an already-started Meal Plan write before applying the new collection', async () => {
    const a = makeVault('Vault A', {
      'A Recipe.md': RECIPE_MD('A Recipe'),
      'Meal Plan.md': '---\ntype: meal-plan\n---\n\n## Monday\n- **Dinner**: [[A Recipe]]\n',
    });
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectDirect(a);

    const gate = deferred();
    const gateReached = deferred();
    a.writeGate = gate.promise;
    a.shouldGateWrite = (path) => path === 'Meal Plan.md';
    a.gateReached = () => gateReached.resolve();

    fireEvent.click(document.getElementById('nav-meal-planner')!);
    fireEvent.click(screen.getAllByText(/Add Breakfast/i)[0]);
    fireEvent.click(screen.getByRole('heading', { name: 'A Recipe' }));
    await gateReached.promise;
    expect(a.writes.some((write) => write.path === 'Meal Plan.md')).toBe(true);

    await openVaultModal();
    openUploadTab();
    selectFolder([]);
    await waitFor(() => expect(screen.getByTestId('vault-notice').textContent).toMatch(/Finishing the current Vault operation/i));
    const writesBeforeRelease = a.writes.length;
    expect(statusLine()).toMatch(/Vault linked · 1 recipe/i);
    expect(idb.clearHandle).not.toHaveBeenCalled();

    gate.resolve();
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 0 recipes/i), { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.writes.length).toBe(writesBeforeRelease);
    expect(a.writes.filter((write) => write.path === 'Meal Plan.md')).toHaveLength(1);
    expect(idb.clearHandle).toHaveBeenCalled();
  }, 45000);
});

describe('R2 — queued recipe writes stay on their original Vault', () => {
  it('does not run a queued Vault A favorite write against the new read-only collection', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectDirect(a);

    const gate = deferred();
    const gateReached = deferred();
    a.writeGate = gate.promise;
    a.shouldGateWrite = (path) => path === 'A Recipe.md';
    a.gateReached = () => gateReached.resolve();

    fireEvent.click(screen.getAllByRole('button', { name: /Add to favorites/i })[0]);
    await gateReached.promise;
    fireEvent.click(screen.getByRole('button', { name: /Remove from favorites/i }));

    await openVaultModal();
    openUploadTab();
    selectFolder([]);
    await waitFor(() => expect(screen.getByTestId('vault-notice').textContent).toMatch(/Finishing the current Vault operation/i));
    gate.resolve();

    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 0 recipes/i), { timeout: 15000 });
    expect(a.writes.filter((write) => write.path === 'A Recipe.md')).toHaveLength(1);
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('0 recipes');
  }, 45000);
});

describe('R2 — Signature import session binding', () => {
  it('stops writing Vault A after a switch to read-only Folder B and never merges into B', async () => {
    const a = makeVault('Vault A');
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectDirect(a);

    const gate = deferred();
    const gateReached = deferred();
    a.writeGate = gate.promise;
    a.shouldGateWrite = (path) => {
      if (!path.startsWith('Signature Collection/')) return false;
      a.signatureGateHits += 1;
      return a.signatureGateHits === 3;
    };
    a.gateReached = () => gateReached.resolve();

    await openVaultModal();
    fireEvent.click(screen.getByTestId('add-signature-nine'));
    await gateReached.promise;
    expect(a.signatureGateHits).toBe(3);

    openUploadTab();
    selectFolder([uploadFile('Kitchen Notes.md', 'B/Kitchen Notes.md', '---\ntags:\n  - technique\n---\n# Kitchen Notes\nReference.\n')]);
    expect(statusLine()).toMatch(/Vault linked · 0 recipes/i);

    gate.resolve();
    await waitFor(() => expect(statusLine()).toMatch(/Recipes loaded · 0 recipes/i), { timeout: 20000 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const signatureDir = a.root.children.get('Signature Collection') as MockDir | undefined;
    expect(signatureDir).toBeTruthy();
    expect(signatureDir!.children.size).toBe(3); // already-written files remain in A
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('0 recipes');
    expect(document.body.textContent).not.toContain('9 recipes added');
    expect(idb.clearHandle).toHaveBeenCalled();
  }, 60000);

  it('reports a permission revocation mid-import accurately and keeps only verified partial copies', async () => {
    const a = makeVault('Vault A');
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectDirect(a);

    const gate = deferred();
    const gateReached = deferred();
    a.writeGate = gate.promise;
    a.shouldGateWrite = (path) => {
      if (!path.startsWith('Signature Collection/')) return false;
      a.signatureGateHits += 1;
      return a.signatureGateHits === 2;
    };
    a.gateReached = () => gateReached.resolve();

    await openVaultModal();
    fireEvent.click(screen.getByTestId('add-signature-nine'));
    await gateReached.promise;
    a.permission = 'denied';
    gate.resolve();

    await waitFor(() => expect(screen.getByTestId('vault-notice').textContent).toMatch(/permission is no longer granted/i), { timeout: 20000 });
    await waitFor(() => expect(statusLine()).toMatch(/Vault linked · 2 recipes/i));
    const signatureDir = a.root.children.get('Signature Collection') as MockDir | undefined;
    expect(signatureDir).toBeTruthy();
    expect(signatureDir!.children.size).toBe(2);
    expect(document.body.textContent).toMatch(/2 recipes added/i);
    expect(document.body.textContent).toMatch(/7 cancelled before writing/i);
    const writeCount = a.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(a.writes.length).toBe(writeCount);
  }, 60000);

  it('stops launching new writes after unmount and leaves already-written files intact', async () => {
    const a = makeVault('Vault A');
    const view = render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectDirect(a);

    const gate = deferred();
    const gateReached = deferred();
    a.writeGate = gate.promise;
    a.shouldGateWrite = (path) => {
      if (!path.startsWith('Signature Collection/')) return false;
      a.signatureGateHits += 1;
      return a.signatureGateHits === 2;
    };
    a.gateReached = () => gateReached.resolve();

    await openVaultModal();
    fireEvent.click(screen.getByTestId('add-signature-nine'));
    await gateReached.promise;
    view.unmount();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const signatureDir = a.root.children.get('Signature Collection') as MockDir | undefined;
    expect(signatureDir).toBeTruthy();
    expect(signatureDir!.children.size).toBe(2);
  }, 60000);
});

describe('R2 — failed transitions preserve the previous valid session', () => {
  it('keeps Vault A when a later FSA scan fails', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectDirect(a);
    expect(statusLine()).toMatch(/Vault linked · 1 recipe/i);

    idb.saveHandle.mockClear();
    const b = makeVault('Vault B');
    b.scanError = new Error('scan failed');

    await openVaultModal();
    (window as any).showDirectoryPicker = async () => b.root;
    fireEvent.click(screen.getByRole('tab', { name: /Live Directory Sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /Choose Local Obsidian Vault Folder/i }));
    await waitFor(() => expect(screen.getByText(/scan failed/i)).toBeTruthy(), { timeout: 15000 });

    expect(statusLine()).toMatch(/Vault linked · 1 recipe/i);
    expect(document.body.textContent).toContain('A Recipe');
    expect(idb.saveHandle).not.toHaveBeenCalled();
  }, 45000);
});

describe('R6 — recovery/write and Refresh ordering', () => {
  it('blocks Refresh while a recipe write lease is active and does not start a stale scan', async () => {
    const a = makeVault('Vault A', { 'A Recipe.md': RECIPE_MD('A Recipe') });
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectDirect(a);

    const gate = deferred();
    const gateReached = deferred();
    a.writeGate = gate.promise;
    a.shouldGateWrite = (path) => path === 'A Recipe.md';
    a.gateReached = () => gateReached.resolve();

    fireEvent.click(await screen.findByRole('button', { name: 'A Recipe' }));
    await waitFor(() => expect(document.getElementById('recipe-detail-view')).toBeTruthy());
    fireEvent.click(document.getElementById('edit-recipe-btn')!);
    await waitFor(() => expect(document.body.textContent).toContain('Save Obsidian Note'));
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await gateReached.promise;

    const scansBefore = a.scanStarted;
    fireEvent.click(document.getElementById('refresh-vault-btn')!);
    await waitFor(() =>
      expect(screen.getByTestId('vault-notice').textContent).toMatch(/operation is in progress/i)
    );
    expect(a.scanStarted).toBe(scansBefore);

    gate.resolve();
    await waitFor(() => expect(a.writes.some((write) => write.path === 'A Recipe.md')).toBe(true));
  }, 45000);
});
