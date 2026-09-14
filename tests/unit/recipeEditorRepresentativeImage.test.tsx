// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { ObsidianRecipe } from '../../src/types';

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

const PROVENANCE = {
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

function makeNetwork(): { network: NetworkAdapter; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async (path: string) => {
    if (path === '/api/recipes/image/find-representative') {
      return { ok: true, status: 200, data: { query: 'blue cheese smashburgers ground beef', candidates: [CANDIDATE] } };
    }
    if (path === '/api/recipes/image/select-representative') {
      return { ok: true, status: 200, data: { token: 'tok-1', contentType: 'image/png', expiresAt: 1, provenance: PROVENANCE } };
    }
    return { ok: false, status: 404, data: {} };
  });
  return { network: { request: vi.fn(), get: vi.fn(), post } as unknown as NetworkAdapter, post };
}

function makeAsset() {
  return {
    write: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    read: vi.fn(async () => new Uint8Array()),
    delete: vi.fn(async () => {}),
  } as unknown as AssetAdapter;
}

beforeEach(async () => {
  await hydrateAiSelections({ get: async () => undefined });
  (URL as any).createObjectURL = vi.fn(() => 'blob:test');
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function selectFirstCandidate() {
  fireEvent.click(screen.getByTestId('find-representative-image'));
  await waitFor(() => expect(screen.getByText('Choose a Representative Recipe Image')).toBeTruthy());
  await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
  fireEvent.click(screen.getByTestId('use-representative-image'));
  // Wait for the async selection handler to finish (chooser closes on success).
  await waitFor(() => expect(screen.queryByText('Choose a Representative Recipe Image')).toBeNull());
}

describe('RecipeEditorModal — explicit representative image flow (deferred save)', () => {
  it('loads thumbnails only from the app-local route and writes NO asset before Save', async () => {
    const { network, post } = makeNetwork();
    const asset = makeAsset();
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={vi.fn()} onClose={() => {}} />);

    expect(post).not.toHaveBeenCalled();

    // Open the chooser and inspect thumbnails WHILE it is open.
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getByText('Choose a Representative Recipe Image')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
    const thumbs = Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('src') || '');
    expect(thumbs.some((src) => src.startsWith('/api/recipes/image/representative-thumbnail/'))).toBe(true);
    for (const src of thumbs) expect(src).not.toMatch(/^https?:\/\//);
    // No external thumbnail host was requested by the browser.
    for (const call of fetchMock.mock.calls as unknown[][]) {
      expect(String(call[0])).not.toMatch(/^https?:\/\//);
    }

    fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
    fireEvent.click(screen.getByTestId('use-representative-image'));
    await waitFor(() => expect(screen.queryByText('Choose a Representative Recipe Image')).toBeNull());

    // The only network fetch is the app-local preview route.
    for (const call of fetchMock.mock.calls as unknown[][]) {
      expect(String(call[0])).toMatch(/^\/api\/recipes\/image\/preview\//);
    }

    // DEFERRED: no asset written before Save.
    expect(asset.write).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/api/recipes/image/select-representative', { candidateId: 'opaque-1' });
    expect(post).not.toHaveBeenCalledWith('/api/recipes/image/generate', expect.anything());
  });

  it('writes exactly one asset during Save and persists the local path + provenance', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), { status: 200, headers: { 'content-type': 'image/png' } })));

    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await selectFirstCandidate();
    expect(asset.write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(asset.write).toHaveBeenCalledTimes(1);
    const call = (asset.write as any).mock.calls[0] as any[];
    const [path, , contentType] = call;
    expect(String(path)).toMatch(/^Assets\//);
    expect(contentType).toBe('image/png');

    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(saved.image).toMatch(/^Assets\//);
    expect(saved.image).not.toContain('http');
    const prov = (saved.frontmatter as any)?.codex_representative_image;
    expect(prov).toMatchObject({ kind: 'representative', license: 'cc_by', localAssetPath: saved.image });
  });

  it('Cancel before Save writes nothing; reselection before Save creates no duplicate', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), { status: 200, headers: { 'content-type': 'image/png' } })));

    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);

    // Cancel the chooser before selecting.
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getByText('Choose a Representative Recipe Image')).toBeTruthy());
    fireEvent.click(screen.getByText('Keep Current Image'));
    await waitFor(() => expect(screen.queryByText('Choose a Representative Recipe Image')).toBeNull());
    expect(asset.write).not.toHaveBeenCalled();

    // Reselect twice, then Save once -> exactly one asset write.
    await selectFirstCandidate();
    await selectFirstCandidate();
    expect(asset.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(asset.write).toHaveBeenCalledTimes(1);
  });

  it('manual replacement clears representative provenance (stale-attribution regression)', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn();
    const recipe = makeRecipe({
      image: 'Assets/Old.jpg',
      frontmatter: { codex_representative_image: PROVENANCE },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), { status: 200, headers: { 'content-type': 'image/png' } })));

    render(<RecipeEditorModal initialRecipe={recipe} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);

    // Manually replace the image via the URL input, then Save.
    const imageInput = screen.getByPlaceholderText(/Assets\/filename\.jpg/) as HTMLInputElement;
    fireEvent.change(imageInput, { target: { value: 'Assets/Manual.jpg' } });
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(saved.image).toBe('Assets/Manual.jpg');
    expect((saved.frontmatter as any)?.codex_representative_image).toBeUndefined();
  });

  it('no-results shows ONE message + suggestions; suggestions never auto-search and the image is kept', async () => {
    const post = vi.fn(async (path: string) => {
      if (path === '/api/recipes/image/find-representative') {
        return { ok: true, status: 200, data: { query: 'blue cheese smashburger', candidates: [] } };
      }
      return { ok: false, status: 404, data: {} };
    });
    const network = { request: vi.fn(), get: vi.fn(), post } as unknown as NetworkAdapter;
    const asset = makeAsset();
    const onSave = vi.fn();
    render(
      <RecipeEditorModal
        initialRecipe={makeRecipe({ image: 'Assets/Old.jpg' })}
        imageService={{ asset }}
        network={network}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getAllByText(/No reusable representative images were found/)).toHaveLength(1));
    // The duplicate "placeholder" variant is gone.
    expect(screen.queryByText(/current image \(or placeholder\) was kept/)).toBeNull();

    const suggestions = screen.getAllByTestId('representative-suggestion');
    expect(suggestions.length).toBeGreaterThan(0);

    const before = post.mock.calls.length;
    fireEvent.click(suggestions[0]);
    // Clicking a suggestion fills the input ONLY — no automatic retry.
    expect(post.mock.calls.length).toBe(before);

    // Explicitly searching the suggestion performs exactly one more request.
    fireEvent.click(screen.getByTestId('representative-search-button'));
    await waitFor(() => expect(post.mock.calls.length).toBe(before + 1));

    // The current image is untouched; nothing is written or saved.
    expect(asset.write).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalledWith('/api/recipes/image/generate', expect.anything());
  });
});

describe('RecipeEditorModal — rollback surfacing, object-URL lifecycle, Escape', () => {
  const okFetch = () =>
    vi.fn(async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    );
  const revokeMock = () => URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;

  it('rolls back the newly created asset on recipe-save failure (normal bounded failure shown)', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn(async () => {
      throw new Error('vault write failed');
    });
    vi.stubGlobal('fetch', okFetch());
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await selectFirstCandidate();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(asset.delete).toHaveBeenCalledTimes(1));
    const created = (asset.write as any).mock.calls[0][0];
    expect((asset.delete as any).mock.calls[0][0]).toBe(created);
    await waitFor(() => expect(screen.getByText(/vault write failed/i)).toBeTruthy());
    expect(screen.queryByText(/may remain in Assets/)).toBeNull();
  });

  it('shows the orphan warning when the delete adapter is unavailable', async () => {
    const { network } = makeNetwork();
    const asset = {
      write: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      read: vi.fn(async () => new Uint8Array()),
    } as unknown as AssetAdapter;
    const onSave = vi.fn(async () => {
      throw new Error('vault write failed');
    });
    vi.stubGlobal('fetch', okFetch());
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await selectFirstCandidate();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(screen.getByText(/may remain in Assets/)).toBeTruthy());
    expect((asset as any).delete).toBeUndefined();
  });

  it('shows the orphan warning when rollback deletion fails', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    (asset.delete as any).mockRejectedValue(new Error('delete failed'));
    const onSave = vi.fn(async () => {
      throw new Error('vault write failed');
    });
    vi.stubGlobal('fetch', okFetch());
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await selectFirstCandidate();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(screen.getByText(/may remain in Assets/)).toBeTruthy());
    expect(asset.delete).toHaveBeenCalledTimes(1);
  });

  it('never attempts deletion for an existing image (no asset created during this Save)', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn(async () => {
      throw new Error('vault write failed');
    });
    render(
      <RecipeEditorModal
        initialRecipe={makeRecipe({ image: 'Assets/Old.jpg' })}
        imageService={{ asset }}
        network={network}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/Assets\/filename\.jpg/), { target: { value: 'Assets/Manual.jpg' } });
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(asset.write).not.toHaveBeenCalled();
    expect(asset.delete).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/vault write failed/i)).toBeTruthy());
  });

  it('revokes the preview object URL after Save (never while active)', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn();
    vi.stubGlobal('fetch', okFetch());
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await selectFirstCandidate();
    expect(revokeMock()).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(revokeMock()).toHaveBeenCalledWith('blob:test'));
  });

  it('revokes the preview object URL when switching to a manual image', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    vi.stubGlobal('fetch', okFetch());
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={vi.fn()} onClose={() => {}} />);
    await selectFirstCandidate();
    fireEvent.change(screen.getByPlaceholderText(/Assets\/filename\.jpg/), { target: { value: 'Assets/Manual.jpg' } });
    await waitFor(() => expect(revokeMock()).toHaveBeenCalledWith('blob:test'));
  });

  it('revokes the preview object URL on unmount', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    vi.stubGlobal('fetch', okFetch());
    const { unmount } = render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={vi.fn()} onClose={() => {}} />);
    await selectFirstCandidate();
    unmount();
    expect(revokeMock()).toHaveBeenCalledWith('blob:test');
  });

  it('Escape closes the chooser without selecting, saving, or writing an asset', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn();
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(asset.write).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stale-selection invalidation + search-generation authority
// ---------------------------------------------------------------------------

const FIND_PATH = '/api/recipes/image/find-representative';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function candidateWith(id: string, title: string) {
  return { ...CANDIDATE, id, title, thumbnailPath: `/api/recipes/image/representative-thumbnail/${id}` };
}

function queuedNetwork(responses: Array<Promise<unknown> | unknown>) {
  let index = 0;
  const post = vi.fn((path: string) => {
    if (path === FIND_PATH) {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve(response);
    }
    return Promise.resolve({ ok: false, status: 404, data: {} });
  });
  return { network: { request: vi.fn(), get: vi.fn(), post } as unknown as NetworkAdapter, post };
}

function useButton(): HTMLButtonElement {
  return screen.getByTestId('use-representative-image') as HTMLButtonElement;
}

describe('RecipeEditorModal — stale selection is invalidated by a new search', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  async function previewFirstResult() {
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
    expect(useButton().disabled).toBe(false);
  }

  function startSecondSearch() {
    fireEvent.change(screen.getByTestId('representative-search-input'), { target: { value: 'cheeseburger' } });
    fireEvent.click(screen.getByTestId('representative-search-button'));
  }

  it('BLOCKING: search B success immediately clears preview A and cannot confirm A', async () => {
    const second = deferred<unknown>();
    const { network, post } = queuedNetwork([
      { ok: true, status: 200, data: { query: 'blue cheese smashburger', candidates: [candidateWith('cand-A', 'Candidate A')] } },
      second.promise,
    ]);
    const asset = makeAsset();
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={vi.fn()} onClose={() => {}} />);
    await previewFirstResult();

    startSecondSearch();
    // Immediately (while B is in flight): preview gone, confirmation disabled.
    await waitFor(() => expect(useButton().disabled).toBe(true));
    expect(screen.queryByText(/Preview:/)).toBeNull();

    second.resolve({ ok: true, status: 200, data: { query: 'cheeseburger', candidates: [candidateWith('cand-B', 'Candidate B')] } });
    await waitFor(() => expect(screen.getByText('Candidate B')).toBeTruthy());
    expect(screen.queryByText('Candidate A')).toBeNull();
    expect(useButton().disabled).toBe(true);
    // No asset written merely because a search ran.
    expect(asset.write).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('search B no-results cannot confirm candidate A and keeps the current image', async () => {
    const { network, post } = queuedNetwork([
      { ok: true, status: 200, data: { query: 'blue cheese smashburger', candidates: [candidateWith('cand-A', 'Candidate A')] } },
      { ok: true, status: 200, data: { query: 'cheeseburger', candidates: [] } },
    ]);
    const asset = makeAsset();
    const onSave = vi.fn();
    render(<RecipeEditorModal initialRecipe={makeRecipe({ image: 'Assets/Old.jpg' })} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    await previewFirstResult();

    startSecondSearch();
    await waitFor(() => expect(screen.getAllByText(/No reusable representative images were found/)).toHaveLength(1));
    expect(useButton().disabled).toBe(true);
    expect(screen.queryByText('Candidate A')).toBeNull();
    expect(asset.write).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('search B IMAGE_QUERY_UNSAFE cannot confirm candidate A', async () => {
    const { network } = queuedNetwork([
      { ok: true, status: 200, data: { query: 'blue cheese smashburger', candidates: [candidateWith('cand-A', 'Candidate A')] } },
      { ok: false, status: 422, data: { code: 'IMAGE_QUERY_UNSAFE', error: 'unsafe' } },
    ]);
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />);
    await previewFirstResult();

    startSecondSearch();
    await waitFor(() => expect(screen.getByText(/does not contain safe visual search terms/)).toBeTruthy());
    expect(useButton().disabled).toBe(true);
    expect(screen.queryByText('Candidate A')).toBeNull();
  });

  it('search B network failure cannot confirm candidate A', async () => {
    const { network } = queuedNetwork([
      { ok: true, status: 200, data: { query: 'blue cheese smashburger', candidates: [candidateWith('cand-A', 'Candidate A')] } },
      { ok: false, status: 502, data: { code: 'IMAGE_SEARCH_UNAVAILABLE', error: 'down' } },
    ]);
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />);
    await previewFirstResult();

    startSecondSearch();
    await waitFor(() => expect(screen.getByText(/temporarily unavailable/)).toBeTruthy());
    expect(useButton().disabled).toBe(true);
    expect(screen.queryByText('Candidate A')).toBeNull();
  });

  it('a slow OLDER response cannot overwrite a newer search (generation guard)', async () => {
    const slowA = deferred<unknown>();
    const fastB = deferred<unknown>();
    let findCalls = 0;
    const post = vi.fn((path: string) => {
      if (path === FIND_PATH) {
        findCalls += 1;
        return findCalls === 1 ? slowA.promise : fastB.promise;
      }
      return Promise.resolve({ ok: false, status: 404, data: {} });
    });
    const network = { request: vi.fn(), get: vi.fn(), post } as unknown as NetworkAdapter;
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />);

    // Induce overlapping requests within one batched event (button not yet disabled).
    const findButton = screen.getByTestId('find-representative-image') as HTMLButtonElement;
    await act(async () => {
      findButton.click();
      findButton.click();
    });
    expect(findCalls).toBe(2);

    // B (the newer search) resolves first with Candidate B.
    fastB.resolve({ ok: true, status: 200, data: { query: 'B', candidates: [candidateWith('cand-B', 'Candidate B')] } });
    await waitFor(() => expect(screen.getByText('Candidate B')).toBeTruthy());

    // The slow OLDER A resolves last and must NOT overwrite B.
    slowA.resolve({ ok: true, status: 200, data: { query: 'A', candidates: [candidateWith('cand-A', 'Candidate A')] } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Candidate B')).toBeTruthy();
    expect(screen.queryByText('Candidate A')).toBeNull();
    expect(screen.queryByText(/Search: A/)).toBeNull();
  });
});
