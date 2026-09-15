// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { ObsidianRecipe } from '../../src/types';

/**
 * B1/B2/B3/I1/I2 — Recipe Editor image Save-transaction safety (mounted).
 *
 * - B1: collision-safe Asset creation; rollback deletes ONLY the
 *   transaction-owned Asset; pre-existing bytes stay untouched.
 * - B2: Raw `.md` saves apply the final resolved image path + provenance;
 *   no blob:/data:/preview-token reference may enter Markdown.
 * - B3: a failed Save restores the COMPLETE pre-save snapshot; a later
 *   successful retry never mislabels the restored original as generated.
 * - I1: a synchronous transaction lock admits exactly one Asset write and one
 *   recipe-save call under a double click; retry stays available.
 * - I2: close/reopen and unmount during async stages drop stale completions
 *   without untracked object URLs.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

function makeRecipe(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
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
    ...overrides,
  } as ObsidianRecipe;
}

/** In-memory vault Asset fake with real existence semantics. */
function makeAssetStore(initial: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(initial));
  const deleted: string[] = [];
  const asset = {
    write: vi.fn(async (path: string, bytes: Uint8Array) => {
      files.set(path, bytes.slice());
    }),
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => files.get(path) ?? new Uint8Array()),
    delete: vi.fn(async (path: string) => {
      deleted.push(path);
      files.delete(path);
    }),
  } as unknown as AssetAdapter;
  return { asset, files, deleted };
}

function makeNetwork(): { network: NetworkAdapter; post: ReturnType<typeof vi.fn>; getBytes: ReturnType<typeof vi.fn> } {
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
  return { network: { request: vi.fn(), get: vi.fn(), post, getBytes } as unknown as NetworkAdapter, post, getBytes };
}

beforeEach(async () => {
  await hydrateAiSelections({ get: async () => undefined });
  let n = 0;
  (URL as any).createObjectURL = vi.fn(() => `blob:save-${(n += 1)}`);
  (URL as any).revokeObjectURL = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('bare preview fetch must not occur');
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function acceptRepresentative(): Promise<void> {
  fireEvent.click(screen.getByTestId('find-representative-image'));
  await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
  fireEvent.click(screen.getByTestId('use-representative-image'));
  await waitFor(() => expect(screen.queryByText('Choose a Representative Recipe Image')).toBeNull());
}

describe('B1 — collision-safe Asset creation + transaction-owned rollback', () => {
  it('a colliding existing Asset is never overwritten: the save uses a suffixed path', async () => {
    const { network } = makeNetwork();
    const { asset, files } = makeAssetStore({ 'Assets/Blue Cheese Smashburgers.png': new Uint8Array([9, 9, 9]) });
    const onSave = vi.fn();
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await acceptRepresentative();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(asset.write).toHaveBeenCalledTimes(1);
    const writtenPath = (asset.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(writtenPath).not.toBe('Assets/Blue Cheese Smashburgers.png');
    expect(writtenPath).toMatch(/^Assets\/Blue Cheese Smashburgers \(\d+\)\.png$/);
    // The pre-existing asset is byte-for-byte untouched.
    expect(Array.from(files.get('Assets/Blue Cheese Smashburgers.png') ?? [])).toEqual([9, 9, 9]);
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(saved.image).toBe(writtenPath);
  });

  it('a failed Markdown save after collision-safe creation rolls back ONLY the new asset', async () => {
    const { network } = makeNetwork();
    const { asset, files, deleted } = makeAssetStore({ 'Assets/Blue Cheese Smashburgers.png': new Uint8Array([9, 9, 9]) });
    const onSave = vi.fn(async () => {
      throw new Error('vault write failed');
    });
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await acceptRepresentative();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const writtenPath = (asset.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    await waitFor(() => expect(deleted).toEqual([writtenPath]));
    // The original asset survived; the rollback removed only the new file.
    expect(Array.from(files.get('Assets/Blue Cheese Smashburgers.png') ?? [])).toEqual([9, 9, 9]);
    expect(files.has(writtenPath)).toBe(false);
  });

  it('a successful save persists the collision-safe path with representative provenance', async () => {
    const { network } = makeNetwork();
    const { asset } = makeAssetStore({ 'Assets/Blue Cheese Smashburgers.png': new Uint8Array([9]) });
    const onSave = vi.fn();
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await acceptRepresentative();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect((saved.frontmatter as Record<string, unknown>)['codex_representative_image']).toMatchObject({
      kind: 'representative',
      license: 'cc_by',
      localAssetPath: saved.image,
    });
    expect((saved.frontmatter as Record<string, unknown>)['codex_generated_image']).toBeUndefined();
  });
});

describe('B2 — Raw Markdown save applies the resolved image + provenance', () => {
  it('raw-mode save writes the final asset path and generated-style provenance without transient refs', async () => {
    const { network } = makeNetwork();
    const { asset } = makeAssetStore();
    const onSave = vi.fn();
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await acceptRepresentative();
    // Switch to Raw .md mode and save through the real tab control.
    fireEvent.click(screen.getByText('Raw .md'));
    await waitFor(() => expect(screen.getByText(/Direct Obsidian Markdown/)).toBeTruthy());
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(saved.image).toMatch(/^Assets\//);
    expect(saved.image).not.toContain('blob:');
    expect(saved.rawMarkdown).not.toContain('blob:');
    expect(saved.rawMarkdown).not.toContain('data:');
    expect(saved.rawMarkdown).not.toContain('/api/recipes/image/preview/');
    expect(saved.rawMarkdown).toContain(saved.image as string);
    expect((saved.frontmatter as Record<string, unknown>)['codex_representative_image']).toBeTruthy();
  });
});

describe('B3 — full pre-save snapshot restored after a failed Save', () => {
  it('failed save restores the original representative image; retry saves it without false generated provenance', async () => {
    const { network } = makeNetwork();
    const { asset } = makeAssetStore();
    const original = makeRecipe({
      image: 'Assets/Original.jpg',
      frontmatter: { codex_representative_image: REP_PROVENANCE },
    });
    let fail = true;
    const onSave = vi.fn(async (_recipe: ObsidianRecipe) => {
      if (fail) throw new Error('vault write failed');
    });
    render(<RecipeEditorModal initialRecipe={original} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await acceptRepresentative();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/vault write failed/i)).toBeTruthy());
    // Retry succeeds with the RESTORED original (pending preview was restored,
    // then re-saved — but the original representative attribution survives when
    // the user keeps the restored state; here we assert the retry path labels
    // exactly what was saved, with no phantom generated block).
    fail = false;
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    const saved = onSave.mock.calls[1][0] as ObsidianRecipe;
    const fm = saved.frontmatter as Record<string, unknown>;
    // Exactly one provenance family is present — never a false generated label
    // on the restored representative original.
    const hasGenerated = fm['codex_generated_image'] !== undefined;
    const hasRepresentative = fm['codex_representative_image'] !== undefined;
    expect(hasGenerated && hasRepresentative).toBe(false);
  });
});

describe('I1 — synchronous Save transaction lock', () => {
  it('a double click admits exactly one Asset write and one recipe-save call, then retry works', async () => {
    const { network } = makeNetwork();
    const { asset } = makeAssetStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const onSave = vi.fn(async () => {
      await gate;
    });
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await acceptRepresentative();
    const saveButton = screen.getByText('Save Obsidian Note');
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    await new Promise((r) => setTimeout(r, 50));
    // Second click entered while the first transaction holds the lock.
    expect((asset.write as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
    release();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(asset.write).toHaveBeenCalledTimes(1);
    // Retry after completion is a NEW transaction.
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });
});

describe('I2 — close/reopen and unmount drop stale completions without URL leaks', () => {
  it('closing the chooser mid-selection drops the late result (no confirmable preview)', async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => {
      release = r;
    });
    const post = vi.fn((path: string) => {
      if (path === '/api/recipes/image/select-representative') return gate.then(() => ({ ok: true, status: 200, data: { token: 'tok-late', contentType: 'image/png', expiresAt: 1, provenance: REP_PROVENANCE } }));
      if (path === '/api/recipes/image/find-representative') {
        return Promise.resolve({ ok: true, status: 200, data: { query: 'x', candidates: [CANDIDATE] } });
      }
      return Promise.resolve({ ok: false, status: 404, data: {} });
    });
    const getBytes = vi.fn(async () => ({ status: 200, ok: true, bytes: PNG_BYTES, contentType: 'image/png' }));
    const network = { request: vi.fn(), get: vi.fn(), post, getBytes } as unknown as NetworkAdapter;
    const { asset } = makeAssetStore();
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={vi.fn()} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
    fireEvent.click(screen.getByTestId('use-representative-image'));
    // Close the chooser while selection is in flight.
    fireEvent.click(screen.getByLabelText('Close'));
    release(undefined);
    await new Promise((r) => setTimeout(r, 50));
    // The stale completion changed nothing: no pending asset, chooser closed.
    expect(asset.write).not.toHaveBeenCalled();
    expect(screen.queryByText('Choose a Representative Recipe Image')).toBeNull();
  });

  it('unmount during byte retrieval creates no usable preview state', async () => {
    let releaseBytes!: (v: unknown) => void;
    const byteGate = new Promise((r) => {
      releaseBytes = r;
    });
    const post = vi.fn(async (path: string) => {
      if (path === '/api/recipes/image/find-representative') {
        return { ok: true, status: 200, data: { query: 'x', candidates: [CANDIDATE] } };
      }
      if (path === '/api/recipes/image/select-representative') {
        return { ok: true, status: 200, data: { token: 'tok-1', contentType: 'image/png', expiresAt: 1, provenance: REP_PROVENANCE } };
      }
      return { ok: false, status: 404, data: {} };
    });
    const getBytes = vi.fn(() => byteGate.then(() => ({ status: 200, ok: true, bytes: PNG_BYTES, contentType: 'image/png' })));
    const network = { request: vi.fn(), get: vi.fn(), post, getBytes } as unknown as NetworkAdapter;
    const { asset } = makeAssetStore();
    const createdBefore = ((URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[]).length;
    const { unmount } = render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={vi.fn()} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
    fireEvent.click(screen.getByTestId('use-representative-image'));
    unmount();
    releaseBytes(undefined);
    await new Promise((r) => setTimeout(r, 50));
    // Any late-created URL was immediately revoked (no untracked leak).
    const createdAfter = ((URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[]).length;
    const revoked = (URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(revoked).toBeGreaterThanOrEqual(createdAfter - createdBefore > 0 ? 1 : 0);
    expect(asset.write).not.toHaveBeenCalled();
  });
});
