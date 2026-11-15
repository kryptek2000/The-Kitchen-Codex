// @vitest-environment jsdom
/**
 * R3 — Recipe Grabber composite image + recipe save is session-bound.
 *
 * The Grabber must use the runner's session-bound deps (not a newer rendered
 * imageService) for the Asset write, and it must not close as though the recipe
 * was saved when the recipe save is superseded.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecipeGrabberModal } from '../../src/components/RecipeGrabberModal';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { ObsidianRecipe } from '../../src/types';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function makeAsset(): { asset: AssetAdapter; writes: Array<{ path: string; bytes: Uint8Array }>; files: Map<string, Uint8Array> } {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const files = new Map<string, Uint8Array>();
  return {
    writes,
    files,
    asset: {
      write: vi.fn(async (path: string, bytes: Uint8Array) => { writes.push({ path, bytes: bytes.slice() }); files.set(path, bytes.slice()); }),
      read: vi.fn(async (path: string) => files.get(path) ?? new Uint8Array()),
      exists: vi.fn(async (path: string) => files.has(path)),
      delete: vi.fn(async (path: string) => { files.delete(path); }),
    } as unknown as AssetAdapter,
  };
}

function makeNetwork(): NetworkAdapter {
  return {
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        success: true,
        recipe: {
          title: 'Grabbed Soup',
          description: 'A soup.',
          cuisine: 'Test',
          category: 'Dinner',
          difficulty: 'Easy',
          prepTime: '5 mins',
          cookTime: '20 mins',
          totalTime: '25 mins',
          servings: 4,
          rating: 5,
          source: 'Example',
          image: 'https://example.com/soup.jpg',
          tags: ['food/recipes'],
          ingredients: [{ original: '1 cup stock', name: 'stock' }],
          instructions: [{ stepNumber: 1, text: 'Cook.' }],
          callouts: [],
          notes: '',
          rawMarkdown: '',
        },
      },
    })),
    postBytes: vi.fn(),
    getBytes: vi.fn(),
  } as unknown as NetworkAdapter;
}

beforeEach(async () => {
  await hydrateAiSelections({ get: async () => undefined });
  let n = 0;
  (URL as any).createObjectURL = vi.fn(() => `blob:grab-${(n += 1)}`);
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R3 — Recipe Grabber session-bound image save', () => {
  it('uses the runner deps for the Asset write and saves the recipe with that path', async () => {
    const { asset, writes } = makeAsset();
    const runner = vi.fn(async (operation: any) => operation({
      asset,
      downloadRemoteImage: { downloadRemoteImage: async () => ({ bytes: PNG_BYTES, contentType: 'image/png' }) },
    }));
    const onSaveRecipe = vi.fn(async (_recipe: ObsidianRecipe) => {});
    render(
      <RecipeGrabberModal
        isOpen
        onClose={() => {}}
        onSaveRecipe={onSaveRecipe}
        network={makeNetwork()}
        runSessionAsset={runner}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/seriouseats/i), { target: { value: 'https://example.com/soup' } });
    fireEvent.click(screen.getByRole('button', { name: /Grab & Import Recipe/i }));
    await waitFor(() => expect(screen.getByText('Save Note to Vault')).toBeTruthy());
    fireEvent.click(screen.getByText('Save Note to Vault'));

    await waitFor(() => expect(onSaveRecipe).toHaveBeenCalledTimes(1));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    const saved = onSaveRecipe.mock.calls[0][0] as any;
    expect(saved.image).toBe(writes[0].path);
  });

  it('blocks a stale Vault-local image path that does not exist in the destination Vault', async () => {
    const { asset } = makeAsset(); // exists('Assets/only-a.png') === false
    const runner = vi.fn(async (operation: any) => operation({ asset }));
    const onSaveRecipe = vi.fn(async (_recipe: ObsidianRecipe) => {});
    render(
      <RecipeGrabberModal
        isOpen
        onClose={() => {}}
        onSaveRecipe={onSaveRecipe}
        network={makeNetwork()}
        runSessionAsset={runner}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/seriouseats/i), { target: { value: 'https://example.com/soup' } });
    fireEvent.click(screen.getByRole('button', { name: /Grab & Import Recipe/i }));
    await waitFor(() => expect(screen.getByText('Save Note to Vault')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/Image URL or Assets\/filename\.jpg/i), { target: { value: 'Assets/only-a.png' } });
    fireEvent.click(screen.getByText('Save Note to Vault'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not present in the active Vault/i));
    expect(onSaveRecipe).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing same-name asset; it allocates a collision-safe path', async () => {
    const { asset, writes, files } = makeAsset();
    const originalBytes = new Uint8Array([9, 9, 9, 9]);
    files.set('Assets/Grabbed Soup.png', originalBytes.slice());
    const runner = vi.fn(async (operation: any) => operation({
      asset,
      downloadRemoteImage: { downloadRemoteImage: async () => ({ bytes: PNG_BYTES, contentType: 'image/png' }) },
    }));
    const onSaveRecipe = vi.fn(async (_recipe: ObsidianRecipe) => {});
    render(
      <RecipeGrabberModal
        isOpen
        onClose={() => {}}
        onSaveRecipe={onSaveRecipe}
        network={makeNetwork()}
        runSessionAsset={runner}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/seriouseats/i), { target: { value: 'https://example.com/soup' } });
    fireEvent.click(screen.getByRole('button', { name: /Grab & Import Recipe/i }));
    await waitFor(() => expect(screen.getByText('Save Note to Vault')).toBeTruthy());
    fireEvent.click(screen.getByText('Save Note to Vault'));

    await waitFor(() => expect(onSaveRecipe).toHaveBeenCalledTimes(1));
    const saved = onSaveRecipe.mock.calls[0][0] as ObsidianRecipe;
    expect(saved.image).toBeDefined();
    expect(saved.image).not.toBe('Assets/Grabbed Soup.png');
    expect(saved.image).toMatch(/^Assets\/Grabbed Soup \(1\)\.png$/);
    expect(files.get('Assets/Grabbed Soup.png')).toEqual(originalBytes);
    expect(files.get(saved.image as string)).toEqual(PNG_BYTES);
    expect(writes).toHaveLength(1);
  });

  it('rejects a foreign blob preview instead of persisting it', async () => {
    const { asset } = makeAsset(); // exists() false for every path
    const runner = vi.fn(async (operation: any) => operation({ asset }));
    const onSaveRecipe = vi.fn(async (_recipe: ObsidianRecipe) => {});
    render(
      <RecipeGrabberModal
        isOpen
        onClose={() => {}}
        onSaveRecipe={onSaveRecipe}
        network={makeNetwork()}
        runSessionAsset={runner}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/seriouseats/i), { target: { value: 'https://example.com/soup' } });
    fireEvent.click(screen.getByRole('button', { name: /Grab & Import Recipe/i }));
    await waitFor(() => expect(screen.getByText('Save Note to Vault')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/Image URL or Assets\/filename\.jpg/i), {
      target: { value: 'blob:foreign-preview' },
    });
    fireEvent.click(screen.getByText('Save Note to Vault'));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/preview|not owned by the active Vault/i)
    );
    expect(onSaveRecipe).not.toHaveBeenCalled();
  });

  it('reports a superseded recipe save instead of closing as success', async () => {
    const runner = vi.fn(async (operation: any) => operation({
      asset: makeAsset().asset,
      downloadRemoteImage: { downloadRemoteImage: async () => ({ bytes: PNG_BYTES, contentType: 'image/png' }) },
    }));
    const onSaveRecipe = vi.fn(async () => {
      const error = new Error('superseded');
      Object.defineProperty(error, 'name', { value: 'VaultSessionSupersededError' });
      throw error;
    });
    const onClose = vi.fn();
    render(
      <RecipeGrabberModal
        isOpen
        onClose={onClose}
        onSaveRecipe={onSaveRecipe}
        network={makeNetwork()}
        runSessionAsset={runner}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/seriouseats/i), { target: { value: 'https://example.com/soup' } });
    fireEvent.click(screen.getByRole('button', { name: /Grab & Import Recipe/i }));
    await waitFor(() => expect(screen.getByText('Save Note to Vault')).toBeTruthy());
    fireEvent.click(screen.getByText('Save Note to Vault'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Vault changed before this operation completed/i));
    expect(onClose).not.toHaveBeenCalled();
  });
});
