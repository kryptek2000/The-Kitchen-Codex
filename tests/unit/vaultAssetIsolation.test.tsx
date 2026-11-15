// @vitest-environment jsdom
/**
 * R4 — Vault-local asset isolation through the real App composition.
 *
 * These tests use disposable FSA trees and the real provider/registry. They
 * verify observable behavior (preview bytes, picker entries, write counts), not
 * merely the presence of a session id.
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
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const A_BYTES = new TextEncoder().encode('A photo bytes');
const B_BYTES = new TextEncoder().encode('B photo bytes');
const LATE_BYTES = new TextEncoder().encode('late A photo bytes');

class Harness {
  root!: MockDir;
  writes: Array<{ path: string; content: any }> = [];
  imageGatePath: string | null = null;
  imageGate: Promise<void> | null = null;
  imageGateStarted: (() => void) | null = null;
  permission: 'granted' | 'denied' | 'prompt' = 'granted';
}

class MockFile {
  kind = 'file' as const;
  content: any;
  constructor(
    private readonly harness: Harness,
    public name: string,
    public path: string,
    content: any = ''
  ) {
    this.content = content;
  }
  async getFile() {
    if (this.harness.imageGatePath === this.path && this.harness.imageGate) {
      this.harness.imageGateStarted?.();
      await this.harness.imageGate;
    }
    const type = /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(this.name) ? 'image/png' : 'text/markdown';
    return new File([this.content as BlobPart], this.name, { type });
  }
  async createWritable() {
    const self = this;
    return {
      write: async (data: string | Uint8Array) => {
        self.content = data;
        self.harness.writes.push({ path: self.path, content: typeof data === 'string' ? data : data.slice() });
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
  async *values() { for (const child of this.children.values()) yield child; }
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

function recipeMarkdown(title: string, image: string): string {
  return `---
title: ${title}
image: ${image}
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
}

function recipeMarkdownWithBody(title: string, image: string | null, body: string): string {
  const imageLine = image ? `image: ${image}\n` : '';
  return `---
title: ${title}
${imageLine}cuisine: Test
category: Dinner
tags:
  - food/recipes
---
# ${title}
${body}
## Ingredients
- 1 cup flour
## Instructions
1. Cook it.
`;
}

function makeVault(
  name: string,
  recipes: Record<string, { image: string; bytes: Uint8Array }>
): { harness: Harness; root: MockDir } {
  const harness = new Harness();
  const root = new MockDir(harness, name);
  harness.root = root;
  const assets = new MockDir(harness, 'Assets', 'Assets');
  root.children.set('Assets', assets);
  for (const [title, data] of Object.entries(recipes)) {
    const fileName = `${title}.md`;
    root.children.set(fileName, new MockFile(harness, fileName, fileName, recipeMarkdown(title, data.image)));
    const imageName = data.image.split('/').pop()!;
    assets.children.set(imageName, new MockFile(harness, imageName, data.image, data.bytes));
  }
  return { harness, root };
}

function addLateImage(harness: Harness): { gate: ReturnType<typeof deferred>; started: ReturnType<typeof deferred> } {
  const gate = deferred();
  const started = deferred();
  const assets = harness.root.children.get('Assets') as MockDir;
  assets.children.set('late.png', new MockFile(harness, 'late.png', 'Assets/late.png', LATE_BYTES));
  harness.imageGatePath = 'Assets/late.png';
  harness.imageGate = gate.promise;
  harness.imageGateStarted = () => started.resolve(undefined);
  return { gate, started };
}

const blobObjects = new Map<string, Blob>();
let revokedUrls: string[] = [];
let createCount = 0;

function installObjectUrlDoubles() {
  blobObjects.clear();
  revokedUrls = [];
  createCount = 0;
  (URL as any).createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:vault-asset-${++createCount}`;
    blobObjects.set(url, blob);
    return url;
  });
  (URL as any).revokeObjectURL = vi.fn((url: string) => { revokedUrls.push(url); });
}

async function textFor(url: string): Promise<string> {
  const blob = blobObjects.get(url);
  return blob ? await blob.text() : '';
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

function droppedDeferredRecipeEntry(name: string, text: () => Promise<string>) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (callback: (file: File) => void) =>
      callback({ name, text } as unknown as File),
  };
}

function droppedImageEntry(name: string, bytes: Uint8Array) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (callback: (file: File) => void) =>
      callback(new File([bytes as unknown as BlobPart], name, { type: 'image/png' })),
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
  if (chip) fireEvent.click(chip);
  else fireEvent.click(screen.getByRole('button', { name: /Connect Vault/i }));
  await waitFor(() => expect(document.getElementById('connect-vault-modal-overlay')).toBeTruthy());
}

async function closeVaultModal(): Promise<void> {
  const close = document.querySelector('button[aria-label="Close Vault settings"]') as HTMLButtonElement | null;
  if (close) fireEvent.click(close);
  await waitFor(() => expect(document.getElementById('connect-vault-modal-overlay')).toBeNull());
}

async function connectRoot(root: MockDir, expectedRecipes: number): Promise<void> {
  (window as any).showDirectoryPicker = async () => root;
  await openVaultModal();
  const tab = screen.getByRole('tab', { name: /Live Directory Sync/i });
  fireEvent.click(tab);
  fireEvent.click(screen.getByRole('button', { name: /Choose Local Obsidian Vault Folder/i }));
  await waitFor(() => expect(statusLine()).toMatch(new RegExp(`Vault linked · ${expectedRecipes} recipe`)), { timeout: 15000 });
  await closeVaultModal();
}

async function openEditor(title: string): Promise<void> {
  const titleButton = await screen.findByRole('button', { name: title });
  fireEvent.click(titleButton);
  await waitFor(() => expect(document.getElementById('recipe-detail-view')).toBeTruthy());
  fireEvent.click(document.getElementById('edit-recipe-btn')!);
  await waitFor(() => expect(document.body.textContent).toContain('Save Obsidian Note'));
}

function editorPreviewSrc(): string {
  const preview = screen.getByAltText('Preview') as HTMLImageElement;
  return preview.getAttribute('src') || '';
}

beforeEach(() => {
  idb.getHandle.mockReset().mockResolvedValue(null);
  idb.saveHandle.mockReset().mockResolvedValue(true);
  idb.clearHandle.mockReset().mockResolvedValue(true);
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
  installObjectUrlDoubles();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
  delete (window as any).showDirectoryPicker;
  vi.restoreAllMocks();
});

describe('R4 — App-level Vault asset isolation', () => {
  it('T1/T2/T4/T7/T8: same-path assets resolve only their own Vault and old URLs are revoked', async () => {
    const a = makeVault('Vault A', { 'A Recipe': { image: 'Assets/photo.png', bytes: A_BYTES } });
    const b = makeVault('Vault B', { 'B Recipe': { image: 'Assets/photo.png', bytes: B_BYTES } });

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectRoot(a.root, 1);
    await openEditor('A Recipe');
    const aUrl = editorPreviewSrc();
    expect(aUrl).toMatch(/^blob:/);
    expect(await textFor(aUrl)).toBe('A photo bytes');
    expect(screen.getByText(/Vault Assets \(1\)/)).toBeTruthy();

    // Switch to B while the A editor is still open. The transition closes the
    // editor, deactivates A's scope, and revokes A's owned URL.
    await connectRoot(b.root, 1);
    await waitFor(() => expect(statusLine()).toMatch(/Vault linked · 1 recipe/i));
    expect(revokedUrls).toContain(aUrl);

    await openEditor('B Recipe');
    const bUrl = editorPreviewSrc();
    expect(bUrl).toMatch(/^blob:/);
    expect(bUrl).not.toBe(aUrl);
    expect(await textFor(bUrl)).toBe('B photo bytes');
    expect(screen.getByText(/Vault Assets \(1\)/)).toBeTruthy();

    // A → B → A: B's URL is revoked and A reloads its own bytes/URL.
    await connectRoot(a.root, 1);
    expect(revokedUrls).toContain(bUrl);
    await openEditor('A Recipe');
    const aReloadedUrl = editorPreviewSrc();
    expect(aReloadedUrl).not.toBe(bUrl);
    expect(await textFor(aReloadedUrl)).toBe('A photo bytes');
  }, 60000);

  it('T3/T10: a late A asset scan cannot repopulate B after the switch', async () => {
    const a = makeVault('Vault A', { 'A Recipe': { image: 'Assets/photo.png', bytes: A_BYTES } });
    const b = makeVault('Vault B', { 'B Recipe': { image: 'Assets/photo.png', bytes: B_BYTES } });

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectRoot(a.root, 1);

    // Add the late image AFTER A is connected, then start a focus rescan that
    // pauses while reading it.
    const late = addLateImage(a.harness);
    window.dispatchEvent(new Event('focus'));
    await late.started.promise;

    await connectRoot(b.root, 1);
    const createdBeforeRelease = createCount;
    late.gate.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The late scan must not create or register anything in B's scope.
    expect(createCount).toBe(createdBeforeRelease);
    await openEditor('B Recipe');
    expect(screen.getByText(/Vault Assets \(1\)/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('late.png');
    expect(await textFor(editorPreviewSrc())).toBe('B photo bytes');
  }, 60000);

  it('T10: a pending second folder import does not deactivate the active uploaded scope', async () => {
    const gate = deferred<string>();
    const { container } = render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    const folderA = droppedFolderEntry('A', [
      droppedFileEntry('A Recipe.md', recipeMarkdown('A Recipe', 'Assets/photo.png')),
      droppedImageEntry('photo.png', A_BYTES),
    ]);
    fireEvent.drop(container.firstElementChild as Element, {
      dataTransfer: { items: [{ webkitGetAsEntry: () => folderA }], files: [] },
    });
    await waitFor(() => expect(statusLine()).toMatch(/1 recipe/i), { timeout: 15000 });

    await openEditor('A Recipe');
    const aUrl = editorPreviewSrc();
    expect(aUrl).toMatch(/^blob:/);
    expect(await textFor(aUrl)).toBe('A photo bytes');

    // A second folder import starts its provisional scope before its first
    // await. That must not deactivate the ACTIVE uploaded scope.
    let secondParseStarted = false;
    const folderB = droppedFolderEntry('B', [
      droppedDeferredRecipeEntry('B Recipe.md', () => {
        secondParseStarted = true;
        return gate.promise;
      }),
    ]);
    fireEvent.drop(container.firstElementChild as Element, {
      dataTransfer: { items: [{ webkitGetAsEntry: () => folderB }], files: [] },
    });
    await waitFor(() => expect(secondParseStarted).toBe(true));

    const stillActiveUrl = editorPreviewSrc();
    expect(stillActiveUrl).toBe(aUrl);
    expect(stillActiveUrl).toMatch(/^blob:/);
    expect(await textFor(stillActiveUrl)).toBe('A photo bytes');

    gate.resolve(recipeMarkdown('B Recipe', ''));
    await waitFor(() => expect(screen.getByText('B Recipe')).toBeTruthy(), { timeout: 15000 });
  }, 60000);

  it('T6b: an A-only image reference in the Markdown body is blocked in B with zero writes', async () => {
    const a = makeVault('Vault A', { 'A Recipe': { image: 'Assets/only-a.png', bytes: A_BYTES } });
    const b = makeVault('Vault B', { 'B Recipe': { image: 'Assets/photo.png', bytes: B_BYTES } });
    const bodyName = 'Body Foreign.md';
    b.root.children.set(
      bodyName,
      new MockFile(
        b.harness,
        bodyName,
        bodyName,
        recipeMarkdownWithBody('Body Foreign', null, '![A only](Assets/only-a.png)')
      )
    );

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectRoot(a.root, 1);
    await connectRoot(b.root, 2);

    await openEditor('Body Foreign');
    const writesBefore = b.harness.writes.length;
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(screen.getByText(/not present in the active Vault/i)).toBeTruthy());
    expect(b.harness.writes.length).toBe(writesBefore);
    expect(b.harness.writes.filter((write) => write.path === bodyName)).toHaveLength(0);
  }, 60000);

  it('T6c: a valid B-local Markdown body image still saves', async () => {
    const b = makeVault('Vault B', { 'B Recipe': { image: 'Assets/photo.png', bytes: B_BYTES } });
    const bodyName = 'Body Valid.md';
    b.root.children.set(
      bodyName,
      new MockFile(
        b.harness,
        bodyName,
        bodyName,
        recipeMarkdownWithBody('Body Valid', null, '![B local](Assets/photo.png)')
      )
    );

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectRoot(b.root, 2);

    await openEditor('Body Valid');
    const writesBefore = b.harness.writes.length;
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(b.harness.writes.length).toBeGreaterThan(writesBefore));
    expect(b.harness.writes.filter((write) => write.path === bodyName)).toHaveLength(1);
    expect(String(b.harness.writes.find((write) => write.path === bodyName)?.content)).toContain(
      '![B local](Assets/photo.png)'
    );
  }, 60000);

  it('T7: an unrelated editor save preserves custom Markdown sections and prose', async () => {
    const b = makeVault('Vault B', { 'B Recipe': { image: 'Assets/photo.png', bytes: B_BYTES } });
    const customName = 'Custom Recipe.md';
    const customMarkdown = `---
title: Custom Recipe
cuisine: Test
custom_flag: keep-me
---
# Custom Recipe

Intro prose that must survive.

## Ingredients
- 1 cup flour

## Equipment
- Dutch oven

## Instructions
1. Cook it.

## Custom Footer
Arbitrary **rich** content that must survive.
`;
    b.root.children.set(customName, new MockFile(b.harness, customName, customName, customMarkdown));

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectRoot(b.root, 2);

    await openEditor('Custom Recipe');
    const writesBefore = b.harness.writes.length;
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(b.harness.writes.length).toBeGreaterThan(writesBefore));
    const written = String(b.harness.writes.find((write) => write.path === customName)?.content || '');
    expect(written).toContain('custom_flag: keep-me');
    expect(written).toContain('Intro prose that must survive.');
    expect(written).toContain('## Equipment');
    expect(written).toContain('- Dutch oven');
    expect(written).toContain('## Custom Footer');
    expect(written).toContain('Arbitrary **rich** content that must survive.');
  }, 60000);

  it('T6d: a blob image reference cannot be persisted into B', async () => {
    const b = makeVault('Vault B', { 'B Recipe': { image: 'Assets/photo.png', bytes: B_BYTES } });
    const blobName = 'Blob Recipe.md';
    b.root.children.set(
      blobName,
      new MockFile(
        b.harness,
        blobName,
        blobName,
        recipeMarkdownWithBody('Blob Recipe', 'blob:foreign-preview', '')
      )
    );

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectRoot(b.root, 2);

    await openEditor('Blob Recipe');
    const writesBefore = b.harness.writes.length;
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(screen.getByText(/preview|not owned by the active Vault/i)).toBeTruthy());
    expect(b.harness.writes.length).toBe(writesBefore);
    expect(b.harness.writes.filter((write) => write.path === blobName)).toHaveLength(0);
  }, 60000);

  it('T6: a stale A-only image path cannot be saved into B', async () => {
    const a = makeVault('Vault A', { 'A Recipe': { image: 'Assets/only-a.png', bytes: A_BYTES } });
    const b = makeVault('Vault B', {
      'B Recipe': { image: 'Assets/photo.png', bytes: B_BYTES },
    });
    // Give B a recipe that references A's path, but no such asset in B.
    const staleName = 'Stale Recipe.md';
    b.root.children.set(staleName, new MockFile(b.harness, staleName, staleName, recipeMarkdown('Stale Recipe', 'Assets/only-a.png')));

    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await connectRoot(a.root, 1);
    await connectRoot(b.root, 2);

    await openEditor('Stale Recipe');
    const writesBefore = b.harness.writes.length;
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(screen.getByText(/not present in the active Vault/i)).toBeTruthy());
    expect(b.harness.writes.length).toBe(writesBefore);
    expect(b.harness.writes.filter((write) => write.path === staleName)).toHaveLength(0);
  }, 60000);
});
