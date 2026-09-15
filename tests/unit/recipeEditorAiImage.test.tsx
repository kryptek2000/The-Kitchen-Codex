// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { ObsidianRecipe } from '../../src/types';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

const CATALOG = {
  catalog: {
    textProviders: [],
    imageProviders: [
      {
        providerId: 'gemini-image',
        name: 'Google Gemini Image',
        configured: true,
        enabled: true,
        available: true,
        connectionTest: 'credential_check',
        selectable: true,
        sessionKeySupported: false,
        imageGeneration: true,
        formats: ['image/png'],
        maxBytes: 4194304,
        models: [{ id: 'gemini-2.5-flash-image', default: true }],
      },
    ],
    selection: {
      text: { selectionMode: 'server_default', valid: true },
      image: { selectionMode: 'server_default', valid: true },
      userSelectionAllowed: { text: true, image: true },
      executable: { text: false, image: true },
    },
    sessionByokSupported: false,
  },
};

function makeNetwork(opts: { requiresConfirmation?: boolean } = {}) {
  const post = vi.fn(async (path: string) => {
    if (path === '/api/recipes/image/quote') {
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          provider: { id: 'gemini-image', name: 'Google Gemini Image' },
          model: 'gemini-2.5-flash-image',
          credentialSource: 'server_environment',
          costClass: 'variable',
          costLabel: 'Variable pricing — determined by your Google account',
          requiresConfirmation: opts.requiresConfirmation !== false,
          confirmationToken: 'tok-1',
          confirmationExpiresAt: Date.now() + 300000,
        },
      };
    }
    if (path === '/api/recipes/image/generate') {
      return {
        ok: true,
        status: 200,
        data: {
          token: 'preview-1',
          contentType: 'image/png',
          provider: 'gemini-image',
          model: 'gemini-2.5-flash-image',
          recipeContentHash: '',
          vaultSessionId: '',
          expiresAt: Date.now() + 300000,
        },
      };
    }
    return { ok: false, status: 404, data: {} };
  });
  const get = vi.fn(async (path: string) => {
    if (path === '/api/providers/catalog') return { ok: true, status: 200, data: CATALOG };
    return { ok: false, status: 404, data: {} };
  });
  const getBytes = vi.fn(async () => ({ status: 200, ok: true, bytes: PNG_BYTES, contentType: 'image/png' }));
  const request = vi.fn(async () => ({ status: 200, ok: true, data: { ok: true } }));
  const network = { post, get, getBytes, request } as unknown as NetworkAdapter;
  return { network, post, get, getBytes, request };
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
  (URL as any).createObjectURL = vi.fn(() => 'blob:ai-preview');
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RecipeEditorModal — Generate with AI (explicit, confirmed, deferred save)', () => {
  it('makes ZERO provider calls on mount and on switching to AI mode', async () => {
    const { network, post } = makeNetwork();
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />
    );
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    // The catalog read is not a provider call.
    await waitFor(() => expect(screen.getByTestId('ai-image-panel')).toBeTruthy());
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-image-generate')).toBeTruthy();
  });

  it('quotes (zero inference), shows provider/model/pricing, then confirms exactly one generation', async () => {
    const { network, post, getBytes } = makeNetwork();
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());

    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-quote')).toBeTruthy());
    const quoteText = screen.getByTestId('ai-image-quote').textContent || '';
    expect(quoteText).toContain('Google Gemini Image');
    expect(quoteText).toContain('gemini-2.5-flash-image');
    expect(quoteText).toContain('Variable pricing');
    // No provider call until the explicit confirmation.
    expect(post).toHaveBeenCalledTimes(1); // the quote only
    expect(post.mock.calls[0][0]).toBe('/api/recipes/image/quote');

    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    await waitFor(() => expect(screen.getByTestId('ai-image-preview')).toBeTruthy());
    expect(post).toHaveBeenCalledTimes(2);
    const generateCall = post.mock.calls[1] as unknown[];
    expect(generateCall[0]).toBe('/api/recipes/image/generate');
    expect((generateCall[1] as Record<string, unknown>)['confirmationToken']).toBe('tok-1');
    // Preview bytes fetched through the authenticated adapter binary path.
    expect(getBytes).toHaveBeenCalledTimes(1);
  });

  it('accepts a generated preview and writes exactly one asset + generated provenance on Save', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn();
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    await waitFor(() => expect(screen.getByTestId('ai-image-preview')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-use'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Deferred: no asset before Save.
    expect(asset.write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(asset.write).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect((saved.frontmatter as Record<string, unknown>)['codex_generated_image']).toMatchObject({
      generated: true,
      provider: 'gemini-image',
      model: 'gemini-2.5-flash-image',
    });
    expect((saved.frontmatter as Record<string, unknown>)['codex_representative_image']).toBeUndefined();
    // The preview object URL is revoked after Save replaced it with the asset path.
    await waitFor(() => expect(URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('blob:ai-preview'));
  });

  it('an AI image replaces existing representative provenance (no stale attribution)', async () => {
    const { network } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn();
    const recipe = makeRecipe({
      image: 'Assets/Old.jpg',
      frontmatter: {
        codex_representative_image: {
          kind: 'representative',
          provenanceVersion: 'representative_v1',
          source: 'openverse',
          sourcePageUrl: 'https://example.com/a',
          license: 'cc_by',
          licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        },
      },
    });
    render(<RecipeEditorModal initialRecipe={recipe} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    await waitFor(() => expect(screen.getByTestId('ai-image-preview')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-use'));
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect((saved.frontmatter as Record<string, unknown>)['codex_generated_image']).toBeTruthy();
    expect((saved.frontmatter as Record<string, unknown>)['codex_representative_image']).toBeUndefined();
  });

  it('a manual image replacement clears generated provenance', async () => {
    const { network } = makeNetwork();
    const onSave = vi.fn();
    const recipe = makeRecipe({
      image: 'Assets/AI.jpg',
      frontmatter: {
        codex_generated_image: {
          generated: true,
          provider: 'gemini-image',
          model: 'gemini-2.5-flash-image',
          generated_at: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    render(
      <RecipeEditorModal initialRecipe={recipe} imageService={{ asset: makeAsset() }} network={network} onSave={onSave} onClose={() => {}} />
    );
    fireEvent.change(screen.getByPlaceholderText(/Assets\/filename\.jpg/), {
      target: { value: 'Assets/Manual.jpg' },
    });
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(saved.image).toBe('Assets/Manual.jpg');
    expect((saved.frontmatter as Record<string, unknown>)['codex_generated_image']).toBeUndefined();
  });

  it('cancelling a quote makes zero provider calls and writes nothing', async () => {
    const { network, post } = makeNetwork();
    const asset = makeAsset();
    const onSave = vi.fn();
    render(<RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={network} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-cancel'));
    await waitFor(() => expect(screen.queryByTestId('ai-image-confirm')).toBeNull());
    expect(post).toHaveBeenCalledTimes(1); // quote only, no generate
    expect(asset.write).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('an adapter WITHOUT an authenticated binary path fails closed (no bare unauthenticated fetch)', async () => {
    const { network } = makeNetwork();
    // Remove the authenticated binary path: the preview must NOT fall back to a
    // direct fetch.
    delete (network as { getBytes?: unknown }).getBytes;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <RecipeEditorModal
        initialRecipe={makeRecipe()}
        imageService={{ asset: makeAsset() }}
        network={network}
        onSave={vi.fn()}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    await waitFor(() => expect(screen.getByText(/image preview could not be loaded/i)).toBeTruthy());
    expect(screen.queryByTestId('ai-image-preview')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('invalidates the server preview token when the generated preview is accepted', async () => {
    const { network, request } = makeNetwork();
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    await waitFor(() => expect(screen.getByTestId('ai-image-preview')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-use'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(request).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/recipes/image/preview/preview-1',
    });
  });

  it('a late quote result after the dialog closes is DROPPED (no stale confirmation)', async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((r) => { release = r; });
    const post = vi.fn((path: string) => {
      if (path === '/api/recipes/image/quote') {
        return gate.then(() => ({
          ok: true,
          status: 200,
          data: {
            ok: true,
            provider: { id: 'gemini-image', name: 'Google Gemini Image' },
            model: 'gemini-2.5-flash-image',
            credentialSource: 'server_environment',
            costClass: 'variable',
            costLabel: 'Variable pricing — determined by your Google account',
            requiresConfirmation: true,
            confirmationToken: 'tok-late',
          },
        }));
      }
      return Promise.resolve({ ok: false, status: 404, data: {} });
    });
    const network = {
      post,
      get: vi.fn(async () => ({ ok: true, status: 200, data: CATALOG })),
      getBytes: vi.fn(),
      request: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
    } as unknown as NetworkAdapter;
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-generate')); // quote in flight
    // Close the dialog BEFORE the quote resolves.
    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    release(undefined);
    await new Promise((r) => setTimeout(r, 25));
    // Reopen: the stale quote must NOT be shown.
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    expect(screen.queryByTestId('ai-image-confirm')).toBeNull();
  });

  it('shows the Set up image AI state when no provider is configured', async () => {
    const { network } = makeNetwork();
    // Catalog with NO usable image provider (a text provider keeps the payload
    // structurally valid; no image provider is selectable).
    (network.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        catalog: {
          ...CATALOG.catalog,
          imageProviders: [],
          textProviders: [
            {
              providerId: 'gemini',
              name: 'Google Gemini',
              configured: true,
              enabled: true,
              available: true,
              storageScope: 'server_environment',
              supportsSecretWrites: false,
              connectionTest: 'network_probe',
              selectable: true,
              sessionKeySupported: false,
              models: [],
            },
          ],
        },
      },
    });
    const onOpenAiSettings = vi.fn();
    render(
      <RecipeEditorModal
        initialRecipe={makeRecipe()}
        imageService={{ asset: makeAsset() }}
        network={network}
        onSave={vi.fn()}
        onClose={() => {}}
        onOpenAiSettings={onOpenAiSettings}
      />
    );
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-unconfigured')).toBeTruthy());
    expect(screen.queryByTestId('ai-image-generate')).toBeNull();
    fireEvent.click(screen.getByTestId('open-ai-settings'));
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
  });
});
