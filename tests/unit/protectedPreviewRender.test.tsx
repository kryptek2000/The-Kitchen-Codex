// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { BrowserNetworkAdapter } from '../../src/platform/browser/BrowserNetworkAdapter';
import {
  setEndpointAccessToken,
  clearEndpointAccessToken,
  getEndpointAccessHeaders,
} from '../../src/application/endpointAccess';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import { VaultIntelligenceModal } from '../../src/components/VaultIntelligenceModal';
import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { ObsidianRecipe } from '../../src/types';

/**
 * F1 — protected preview RENDERING (mounted).
 *
 * Vault Intelligence AI previews and licensed candidate thumbnails render ONLY
 * through managed object URLs built from authenticated `NetworkAdapter.getBytes`
 * bytes (same current endpoint token as JSON). No plain protected-route
 * `<img src>` remains; unprotected deployments work unchanged (no header, same
 * path); missing binary support fails closed with a bounded placeholder.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ENDPOINT_TOKEN = 'f1-render-token';

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

interface SeenCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeRouter() {
  const seen: SeenCall[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, method: (init?.method || 'GET').toUpperCase(), headers: { ...((init?.headers as Record<string, string>) || {}) } });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/recipes/image/quote' && (init?.method || '').toUpperCase() === 'POST') {
      return json({
        ok: true,
        provider: { id: 'gemini-image', name: 'Google Gemini Image' },
        model: 'gemini-2.5-flash-image',
        credentialSource: 'server_environment',
        costClass: 'zero',
        costLabel: 'Verified zero price',
        requiresConfirmation: false,
      });
    }
    if (url === '/api/recipes/image/generate') {
      return json({
        token: 'preview-1',
        contentType: 'image/png',
        provider: 'gemini-image',
        model: 'gemini-2.5-flash-image',
        recipeContentHash: 'a'.repeat(64),
        vaultSessionId: 'vault-session-abc',
        expiresAt: Date.now() + 300000,
      });
    }
    if (url.startsWith('/api/recipes/image/preview/') || url.startsWith('/api/recipes/image/representative-thumbnail/')) {
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url === '/api/recipes/image/find-representative') {
      return json({ query: 'blue cheese', candidates: [CANDIDATE] });
    }
    if (url === '/api/recipes/image/select-representative') {
      return json({ token: 'tok-1', contentType: 'image/png', expiresAt: 1, provenance: REP_PROVENANCE });
    }
    return json({ error: 'not found' }, 404);
  }) as never;
  return { seen, fetchFn };
}

function makeRecipe(): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'Soup.md',
    filePath: 'Soup.md',
    rawMarkdown: '---\ntitle: Soup\n---\n\n# Soup\n',
    title: 'Soup',
    category: 'Soup',
    cuisine: 'French',
    prepTime: '',
    cookTime: '',
    servings: 2,
    difficulty: 'Easy',
    rating: 4,
    image: undefined,
    ingredients: [{ original: '1 potato', name: 'potato' }],
    instructions: [{ stepNumber: 1, text: 'Cook.' }],
    callouts: [],
    wikilinks: [],
    dataviewFields: {},
    frontmatter: {},
  } as ObsidianRecipe;
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
  clearEndpointAccessToken();
  await hydrateAiSelections({ get: async () => undefined });
  let n = 0;
  (URL as any).createObjectURL = vi.fn(() => `blob:f1-${(n += 1)}`);
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearEndpointAccessToken();
  vi.restoreAllMocks();
});

describe('F1 — Vault Intelligence secure preview (mounted)', () => {
  it('renders the AI preview from a managed blob URL fetched with the endpoint header', async () => {
    const { seen, fetchFn } = makeRouter();
    const network = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    const asset = makeAsset();
    render(
      <VaultIntelligenceModal
        isOpen
        onClose={() => {}}
        recipes={[makeRecipe()]}
        onSaveRecipe={async () => {}}
        network={network}
        imageRecovery={{
          vaultSessionId: 'vault-session-abc',
          asset,
          computeContentHash: async () => 'a'.repeat(64),
          saveImage: async () => ({ imagePath: 'Assets/Soup.png', provider: 'p', model: 'm', generatedAt: 't' }),
        }}
        onRecipeImageSaved={vi.fn()}
      />
    );
    // Open the recovery queue and generate for the missing-image recipe.
    fireEvent.click(screen.getByText('Review & Recovery Queue'));
    await waitFor(() => expect(screen.getByTestId('generate-image')).toBeTruthy());
    fireEvent.click(screen.getByTestId('generate-image'));
    await waitFor(() => expect(screen.getByTestId('recipe-image-preview')).toBeTruthy());
    const img = screen.getByTestId('recipe-image-preview') as HTMLImageElement;
    expect(img.src.startsWith('blob:')).toBe(true);
    expect(img.src).not.toContain('/api/recipes/image/preview/');
    // The preview bytes traveled the authenticated binary path.
    const previewCall = seen.find((c) => c.url === '/api/recipes/image/preview/preview-1');
    expect(previewCall?.headers.Authorization).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    // And the JSON quote/generate used the same header.
    expect(seen.find((c) => c.url === '/api/recipes/image/quote')?.headers.Authorization).toBe(
      `Bearer ${ENDPOINT_TOKEN}`
    );
    expect(seen.find((c) => c.url === '/api/recipes/image/generate')?.headers.Authorization).toBe(
      `Bearer ${ENDPOINT_TOKEN}`
    );
  });

  it('fails closed with a bounded placeholder when the adapter has no binary path', async () => {
    const post = vi.fn(async (path: string) => {
      if (path === '/api/recipes/image/quote') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            provider: { id: 'gemini-image', name: 'Google Gemini Image' },
            model: 'm',
            credentialSource: 'server_environment',
            costClass: 'zero',
            costLabel: 'Verified zero price',
            requiresConfirmation: false,
          },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { token: 'preview-1', contentType: 'image/png', provider: 'p', model: 'm', recipeContentHash: 'b'.repeat(64), vaultSessionId: 's', expiresAt: 1 },
      };
    });
    const network = { post, get: vi.fn(async () => ({ ok: true, status: 200 })), request: vi.fn(async () => ({ ok: true, status: 200 })) } as never;
    render(
      <VaultIntelligenceModal
        isOpen
        onClose={() => {}}
        recipes={[makeRecipe()]}
        onSaveRecipe={async () => {}}
        network={network}
        imageRecovery={{
          vaultSessionId: 'vault-session-abc',
          asset: makeAsset(),
          computeContentHash: async () => 'a'.repeat(64),
          saveImage: async () => ({ imagePath: 'Assets/Soup.png', provider: 'p', model: 'm', generatedAt: 't' }),
        }}
        onRecipeImageSaved={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Review & Recovery Queue'));
    await waitFor(() => expect(screen.getByTestId('generate-image')).toBeTruthy());
    fireEvent.click(screen.getByTestId('generate-image'));
    await waitFor(() => expect(screen.getByTestId('recipe-image-preview-loading')).toBeTruthy());
    expect(screen.queryByTestId('recipe-image-preview')).toBeNull();
  });
});

describe('F1 — licensed thumbnails through the authenticated binary path (mounted editor)', () => {
  it('thumbnail bytes carry the endpoint header and render as blob URLs (never upstream)', async () => {
    const { seen, fetchFn } = makeRouter();
    const network = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    const globalFetch = vi.fn(async () => {
      throw new Error('upstream fetch must not occur');
    });
    vi.stubGlobal('fetch', globalFetch);
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
    const thumbCall = seen.find((c) => c.url === '/api/recipes/image/representative-thumbnail/opaque-1');
    expect(thumbCall?.headers.Authorization).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    await waitFor(() => {
      const thumbImg = document.querySelector('[data-testid="representative-candidate"] img') as HTMLImageElement;
      expect(thumbImg.src.startsWith('blob:')).toBe(true);
    });
    expect(globalFetch).not.toHaveBeenCalled();
    // No upstream Openverse/Wikimedia URL was ever requested.
    for (const call of seen) expect(call.url).not.toMatch(/^https?:\/\//);
  });

  it('unprotected deployments render identically with no Authorization header', async () => {
    const { seen, fetchFn } = makeRouter();
    const network = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
    const thumbCall = seen.find((c) => c.url === '/api/recipes/image/representative-thumbnail/opaque-1');
    expect(thumbCall).toBeTruthy();
    expect(thumbCall?.headers.Authorization).toBeUndefined();
    await waitFor(() => {
      const thumbImg = document.querySelector('[data-testid="representative-candidate"] img') as HTMLImageElement;
      expect(thumbImg.src.startsWith('blob:')).toBe(true);
    });
  });
});
