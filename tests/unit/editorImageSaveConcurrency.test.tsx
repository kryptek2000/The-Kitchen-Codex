// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import { resetVaultAssetAllocationForTests } from '../../src/utils/vaultAssets';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { ObsidianRecipe } from '../../src/types';

/**
 * B1 (re-clearance) — collision-safe Asset creation across TWO independent
 * Recipe Editor component instances. The shared, module-level reservation (not
 * a per-component ref) guarantees distinct final paths and transaction-owned
 * rollback when one Save fails.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const CANDIDATE = {
  id: 'opaque-1',
  source: 'openverse',
  title: 'Blue Cheese Burger',
  thumbnailPath: '/api/recipes/image/representative-thumbnail/opaque-1',
  sourcePageUrl: 'https://www.flickr.com/photos/example/123',
  creator: 'Chef Example',
  license: 'cc_by',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  licenseVersion: '4.0',
};

const REP_PROVENANCE = {
  kind: 'representative',
  provenanceVersion: 'representative_v1',
  source: 'openverse',
  sourcePageUrl: 'https://www.flickr.com/photos/example/123',
  creator: 'Chef Example',
  license: 'cc_by',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  licenseVersion: '4.0',
  selectedAt: '2026-01-01T00:00:00.000Z',
};

function makeRecipe(): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '---\ntitle: Blue Cheese Smashburgers\n---\n# Blue Cheese Smashburgers',
    title: 'Blue Cheese Smashburgers',
    tags: ['food/recipes'],
    category: 'Main Course',
    cuisine: 'American',
    prepTime: '',
    cookTime: '',
    servings: 4,
    difficulty: 'Easy',
    rating: 5,
    image: undefined,
    ingredients: [{ original: '454 g ground beef', name: 'ground beef' }],
    instructions: [{ stepNumber: 1, text: 'Cook.' }],
    callouts: [],
    wikilinks: [],
    dataviewFields: {},
    frontmatter: {},
  } as ObsidianRecipe;
}

function makeNetwork(): NetworkAdapter {
  const post = vi.fn(async (path: string) => {
    if (path === '/api/recipes/image/find-representative') {
      return { ok: true, status: 200, data: { query: 'blue cheese smashburgers', candidates: [CANDIDATE] } };
    }
    if (path === '/api/recipes/image/select-representative') {
      return { ok: true, status: 200, data: { token: 'tok-1', contentType: 'image/png', expiresAt: 1, provenance: REP_PROVENANCE } };
    }
    return { ok: false, status: 404, data: {} };
  });
  const getBytes = vi.fn(async () => ({ status: 200, ok: true, bytes: PNG_BYTES, contentType: 'image/png' }));
  return { request: vi.fn(), get: vi.fn(), post, getBytes } as unknown as NetworkAdapter;
}

function makeGatedAsset() {
  const files = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writeCount = 0;
  const asset = {
    exists: vi.fn(async (path: string) => files.has(path)),
    write: vi.fn(async (path: string, data: Uint8Array) => {
      writeCount += 1;
      if (writeCount === 1) await gate;
      files.set(path, data.slice());
    }),
    read: vi.fn(async (path: string) => files.get(path) ?? new Uint8Array()),
    delete: vi.fn(async (path: string) => {
      deleted.push(path);
      files.delete(path);
    }),
  } as unknown as AssetAdapter;
  return { asset, files, deleted, releaseFirstWrite: release };
}

beforeEach(async () => {
  resetVaultAssetAllocationForTests();
  await hydrateAiSelections({ get: async () => undefined });
  let n = 0;
  (URL as any).createObjectURL = vi.fn(() => `blob:concurrency-${(n += 1)}`);
  (URL as any).revokeObjectURL = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('bare preview fetch must not occur');
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function acceptRepresentative(container: HTMLElement): Promise<void> {
  fireEvent.click(within(container).getByTestId('find-representative-image'));
  await waitFor(() => expect(within(container).getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
  fireEvent.click(within(container).getAllByTestId('representative-candidate')[0]);
  fireEvent.click(within(container).getByTestId('use-representative-image'));
  await waitFor(() => expect(within(container).queryByText('Choose a Representative Recipe Image')).toBeNull());
}

describe('B1 — two independent editors: atomic collision-safe Asset creation', () => {
  it('1-8. concurrent saves get distinct paths; one failure rolls back only its own Asset', async () => {
    const network = makeNetwork();
    const { asset, files, deleted, releaseFirstWrite } = makeGatedAsset();
    const imageService = { asset };
    const savedA: ObsidianRecipe[] = [];
    const savedB: ObsidianRecipe[] = [];
    const onSaveA = vi.fn(async (recipe: ObsidianRecipe) => {
      savedA.push(recipe);
    });
    const onSaveB = vi.fn(async (recipe: ObsidianRecipe) => {
      savedB.push(recipe);
      throw new Error('vault write failed');
    });

    const a = render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={imageService} network={network} onSave={onSaveA} onClose={() => {}} />
    );
    const b = render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={imageService} network={network} onSave={onSaveB} onClose={() => {}} />
    );
    await acceptRepresentative(a.container);
    await acceptRepresentative(b.container);
    expect(asset.write).not.toHaveBeenCalled();

    // Start A's save: it claims a path and pauses mid-write.
    fireEvent.click(within(a.container).getByText('Save Obsidian Note'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Start B's save while A is paused: B must select the NEXT suffix.
    fireEvent.click(within(b.container).getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSaveB).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(deleted.length).toBe(1));

    const pathA = (asset.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const pathB = (asset.write as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    // 5. distinct final Asset paths.
    expect(pathA).not.toBe(pathB);
    expect(pathA).toBe('Assets/Blue Cheese Smashburgers.png');
    expect(pathB).toBe('Assets/Blue Cheese Smashburgers (1).png');

    // 7. B's rollback deleted ONLY B's owned Asset.
    expect(deleted).toEqual([pathB]);

    // Release A and let it complete.
    releaseFirstWrite();
    await waitFor(() => expect(onSaveA).toHaveBeenCalledTimes(1));

    // 6+8. A's bytes and Markdown remain intact; B's asset is gone.
    expect(Array.from(files.get(pathA)!)).toEqual(Array.from(PNG_BYTES));
    expect(files.has(pathB)).toBe(false);
    expect(savedA).toHaveLength(1);
    expect(savedA[0].image).toBe(pathA);
    expect(savedA[0].rawMarkdown).toContain(pathA);
    expect(savedA[0].rawMarkdown).not.toContain('blob:');
    expect(savedB).toHaveLength(1);

    // 9+10. B's failure released the reservation; a later retry succeeds.
    (onSaveB as ReturnType<typeof vi.fn>).mockImplementation(async (recipe: ObsidianRecipe) => {
      savedB.push(recipe);
    });
    fireEvent.click(within(b.container).getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSaveB).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(savedB.length).toBe(2));
    expect(savedB[1].image).toMatch(/^Assets\/Blue Cheese Smashburgers( \(\d+\))?\.png$/);
    expect(savedB[1].image).not.toBe(pathA);
  });
});
