// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserNetworkAdapter } from '../../src/platform/browser/BrowserNetworkAdapter';
import { ObsidianNetworkAdapter } from '../../src/platform/obsidian/ObsidianNetworkAdapter';
import {
  setEndpointAccessToken,
  clearEndpointAccessToken,
  isEndpointAccessConfigured,
  getEndpointAccessHeaders,
} from '../../src/application/endpointAccess';
import {
  fetchGeneratedPreviewBytes,
  requestImageGenerationQuote,
  requestGeneratedRecipeImage,
  recipeImagePreviewPath,
  mapRecipeImageRecoveryError,
  RecipeImageRecoveryController,
} from '../../src/application/recipeImageRecovery';
import { findRepresentativeImages, selectRepresentativeImage } from '../../src/application/representativeImage';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import { RecipeImageFindingView } from '../../src/components/VaultIntelligenceModal';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { ObsidianRecipe } from '../../src/types';

/**
 * Protected image-preview authentication wiring (remediation integration suite).
 *
 * There is NO user-facing Unlock control in this repository: no component calls
 * `setEndpointAccessToken`, and no settings/secret store persists the endpoint
 * token. The authoritative lifecycle is therefore the in-memory
 * `endpointAccess` module itself, read live by both production adapters via the
 * `authorizationHeaders: getEndpointAccessHeaders` provider (browser shell in
 * `src/App.tsx`, Obsidian shell in `plugin/main.ts`). These tests exercise that
 * exact wiring end to end: the in-memory token reaches JSON and binary
 * requests identically, replacement/clear take effect immediately, startup is
 * empty, and nothing persists or leaks the secret.
 */

const ENDPOINT_TOKEN = 'test-endpoint-token-alpha';
const ENDPOINT_TOKEN_B = 'test-endpoint-token-beta';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

const REP_CANDIDATE = {
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

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect?: string;
  body?: unknown;
}

function makeRouter(opts: { requiresConfirmation?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers = { ...((init?.headers as Record<string, string>) || {}) };
    const method = (init?.method || 'GET').toUpperCase();
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, method, headers, redirect: (init as { redirect?: string } | undefined)?.redirect, body });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/providers/catalog') return json(CATALOG);
    if (url === '/api/recipes/image/quote' && method === 'POST')
      return json({
        ok: true,
        provider: { id: 'gemini-image', name: 'Google Gemini Image' },
        model: 'gemini-2.5-flash-image',
        credentialSource: 'server_environment',
        costClass: 'variable',
        costLabel: 'Variable pricing — determined by your Google account',
        requiresConfirmation: opts.requiresConfirmation !== false,
        confirmationToken: 'tok-1',
        confirmationExpiresAt: Date.now() + 300000,
      });
    if (url === '/api/recipes/image/generate' && method === 'POST')
      return json({
        token: 'preview-1',
        contentType: 'image/png',
        provider: 'gemini-image',
        model: 'gemini-2.5-flash-image',
        recipeContentHash: '',
        vaultSessionId: '',
        expiresAt: Date.now() + 300000,
      });
    if (url.startsWith('/api/recipes/image/preview/') && method === 'GET')
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.startsWith('/api/recipes/image/representative-thumbnail/') && method === 'GET')
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.startsWith('/api/recipes/image/preview/') && method === 'DELETE') return json({ ok: true });
    if (url === '/api/recipes/image/find-representative' && method === 'POST')
      return json({ query: 'blue cheese smashburgers ground beef', candidates: [REP_CANDIDATE] });
    if (url === '/api/recipes/image/select-representative' && method === 'POST')
      return json({ token: 'tok-1', contentType: 'image/png', expiresAt: 1, provenance: REP_PROVENANCE });
    return json({ error: 'not found' }, 404);
  }) as never;
  return { calls, fetchFn };
}

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

function makeAsset() {
  return {
    write: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    read: vi.fn(async () => new Uint8Array()),
    delete: vi.fn(async () => {}),
  } as unknown as AssetAdapter;
}

function authOf(calls: RecordedCall[], url: string, method?: string): string | undefined {
  const found = calls.find((c) => c.url === url && (!method || c.method === method));
  return found?.headers?.Authorization;
}

function storageDump(): string {
  let out = '';
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i) || '';
    out += `${k}=${localStorage.getItem(k) || ''};`;
  }
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const k = sessionStorage.key(i) || '';
    out += `${k}=${sessionStorage.getItem(k) || ''};`;
  }
  return out;
}

beforeEach(async () => {
  clearEndpointAccessToken();
  await hydrateAiSelections({ get: async () => undefined });
  (URL as any).createObjectURL = vi.fn(() => 'blob:protected-preview');
  (URL as any).revokeObjectURL = vi.fn();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  clearEndpointAccessToken();
  vi.restoreAllMocks();
});

describe('endpoint-access lifecycle — the authoritative in-memory token (no Unlock UI exists)', () => {
  it('1. setting the in-memory token marks the endpoint configured with a Bearer header', () => {
    expect(isEndpointAccessConfigured()).toBe(false);
    setEndpointAccessToken(ENDPOINT_TOKEN);
    expect(isEndpointAccessConfigured()).toBe(true);
    expect(getEndpointAccessHeaders()).toEqual({ Authorization: `Bearer ${ENDPOINT_TOKEN}` });
  });

  it('2. a protected JSON quote request receives the Authorization header (same mechanism as the app)', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    const quote = await requestImageGenerationQuote(adapter);
    expect(quote.model).toBe('gemini-2.5-flash-image');
    expect(authOf(calls, '/api/recipes/image/quote', 'POST')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
  });

  it('3. a protected binary preview request receives the SAME current header', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    const bytes = await fetchGeneratedPreviewBytes(adapter, 'preview-1');
    expect(bytes?.bytes.length).toBeGreaterThan(0);
    expect(authOf(calls, '/api/recipes/image/preview/preview-1', 'GET')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
  });

  it('4. token replacement updates BOTH JSON and binary requests immediately', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    await requestImageGenerationQuote(adapter);
    await fetchGeneratedPreviewBytes(adapter, 'preview-1');
    setEndpointAccessToken(ENDPOINT_TOKEN_B);
    await requestImageGenerationQuote(adapter);
    await fetchGeneratedPreviewBytes(adapter, 'preview-1');
    const jsonHeaders = calls.filter((c) => c.url === '/api/recipes/image/quote').map((c) => c.headers.Authorization);
    const binHeaders = calls
      .filter((c) => c.url === '/api/recipes/image/preview/preview-1')
      .map((c) => c.headers.Authorization);
    expect(jsonHeaders).toEqual([`Bearer ${ENDPOINT_TOKEN}`, `Bearer ${ENDPOINT_TOKEN_B}`]);
    expect(binHeaders).toEqual([`Bearer ${ENDPOINT_TOKEN}`, `Bearer ${ENDPOINT_TOKEN_B}`]);
  });

  it('5. lock/revoke/clear removes the header immediately from JSON and binary', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    await requestImageGenerationQuote(adapter);
    clearEndpointAccessToken();
    expect(isEndpointAccessConfigured()).toBe(false);
    await requestImageGenerationQuote(adapter);
    await fetchGeneratedPreviewBytes(adapter, 'preview-1');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(calls[2].headers.Authorization).toBeUndefined();
  });

  it('6. app startup with no token sends NO Authorization header', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    expect(isEndpointAccessConfigured()).toBe(false);
    await requestImageGenerationQuote(adapter);
    await fetchGeneratedPreviewBytes(adapter, 'preview-1');
    for (const call of calls) expect(call.headers.Authorization).toBeUndefined();
  });

  it('Obsidian parity — JSON and binary use the same current access header on the resolved origin', async () => {
    const seen: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: { ...((init.headers as Record<string, string>) || {}) }, redirect: (init as { redirect?: string }).redirect });
      if (String(url).endsWith('/api/recipes/image/preview/preview-1')) {
        return { status: 200, ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG_BYTES.buffer };
      }
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    });
    const adapter = new ObsidianNetworkAdapter({
      baseUrl: 'https://app.example',
      fetchFn: fetchMock as never,
      authorizationHeaders: getEndpointAccessHeaders,
    });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    await adapter.get('/api/providers');
    await adapter.getBytes('/api/recipes/image/preview/preview-1');
    expect(seen[0].url).toBe('https://app.example/api/providers');
    expect(seen[0].headers.Authorization).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(seen[1].url).toBe('https://app.example/api/recipes/image/preview/preview-1');
    expect(seen[1].headers.Authorization).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(seen[1].redirect).toBe('error');
    clearEndpointAccessToken();
    await adapter.get('/api/providers');
    expect(seen[2].headers.Authorization).toBeUndefined();
  });
});

describe('secret containment — the endpoint token never leaks', () => {
  it('7+8. token never appears in URL/query/image src, DOM, errors, logs, state, Markdown, provenance, or browser storage', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await requestImageGenerationQuote(adapter);
    await requestGeneratedRecipeImage(adapter, { title: 'Soup' }, 'tok-1');
    await fetchGeneratedPreviewBytes(adapter, 'preview-1');

    // No request URL, query, or body carries the endpoint token.
    for (const call of calls) {
      expect(call.url).not.toContain(ENDPOINT_TOKEN);
      expect(call.url).not.toContain('token=');
      expect(JSON.stringify(call.body ?? {})).not.toContain(ENDPOINT_TOKEN);
    }

    // Mounted editor: DOM and image sources carry no endpoint token.
    const asset = makeAsset();
    const onSave = vi.fn();
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={adapter} onSave={onSave} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    await waitFor(() => expect(screen.getByTestId('ai-image-preview')).toBeTruthy());
    const html = document.documentElement.outerHTML;
    expect(html).not.toContain(ENDPOINT_TOKEN);
    for (const img of Array.from(document.querySelectorAll('img'))) {
      expect(img.getAttribute('src') || '').not.toContain(ENDPOINT_TOKEN);
    }

    // Bounded errors and logs carry no secret.
    const mapped = mapRecipeImageRecoveryError(new Error(`boom ${ENDPOINT_TOKEN}`));
    expect(JSON.stringify(mapped)).not.toContain(ENDPOINT_TOKEN);
    for (const call of [...warn.mock.calls, ...error.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(ENDPOINT_TOKEN);
    }

    // Save writes canonical state only: no token in the recipe, Markdown, or provenance.
    fireEvent.click(screen.getByTestId('ai-image-use'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(JSON.stringify(saved)).not.toContain(ENDPOINT_TOKEN);
    expect(saved.rawMarkdown || '').not.toContain(ENDPOINT_TOKEN);

    // No browser storage holds the token.
    expect(storageDump()).not.toContain(ENDPOINT_TOKEN);
  });

  it('no persistence — settings/secret surfaces hold no endpoint token', () => {
    setEndpointAccessToken(ENDPOINT_TOKEN);
    expect(storageDump()).not.toContain(ENDPOINT_TOKEN);
    expect(getEndpointAccessHeaders()).toEqual({ Authorization: `Bearer ${ENDPOINT_TOKEN}` });
    clearEndpointAccessToken();
    expect(getEndpointAccessHeaders()).toEqual({});
  });
});

describe('transport guards — same-origin binary transport only', () => {
  it('9. external and absolute binary URLs are rejected BEFORE fetch', async () => {
    const { fetchFn } = makeRouter();
    const seen: string[] = [];
    const spy = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      return (fetchFn as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as never;
    const adapter = new BrowserNetworkAdapter({ fetchFn: spy, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    await expect(adapter.getBytes('https://evil.example/preview/tok')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getBytes('http://evil.example/x.png')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getBytes('//evil.example/x.png')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getBytes('/other/x.png')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getBytes('/api/../secret')).rejects.toMatchObject({ status: 400 });
    expect(seen).toEqual([]);
  });

  it('10. redirects remain rejected (redirect:error on every binary request)', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    await fetchGeneratedPreviewBytes(adapter, 'preview-1');
    expect(calls[0].redirect).toBe('error');
  });

  it('11. an adapter WITHOUT getBytes fails closed with bounded IMAGE_PREVIEW_UNAVAILABLE', async () => {
    const bare = { post: vi.fn(), get: vi.fn(), request: vi.fn() } as never;
    expect(await fetchGeneratedPreviewBytes(bare, 'preview-1')).toBeUndefined();
  });

  it('12. no unauthenticated AI preview fallback remains in production sources', async () => {
    const root = join(process.cwd(), 'src');
    const files = [
      'platform/browser/createBrowserAppServices.ts',
      'platform/browser/index.ts',
      'platform/browser/downloadImageViaBackend.ts',
      'components/RecipeEditorModal.tsx',
      'components/VaultIntelligenceModal.tsx',
      'App.tsx',
      'application/recipeImageRecovery.ts',
    ];
    for (const rel of files) {
      const content = await readFile(join(root, rel), 'utf8');
      expect(content).not.toContain('fetchRecipeImagePreviewBytes');
      expect(content).not.toContain('fetchAppPreviewBlob');
    }
    const editor = await readFile(join(root, 'components/RecipeEditorModal.tsx'), 'utf8');
    expect(editor).not.toMatch(/await fetch\(/);
    const app = await readFile(join(root, 'App.tsx'), 'utf8');
    expect(app).not.toMatch(/fetch\(`\/api\/recipes\/image\/preview/);
  });
});

describe('Recipe Editor — protected preview and Save through the authenticated adapter (mounted)', () => {
  it('13+17+18+20. quote->confirm->preview->Save uses auth on every call, one provider call, no auto-generation, URLs revoked', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    const asset = makeAsset();
    const onSave = vi.fn();
    const globalFetch = vi.fn(async () => {
      throw new Error('bare preview fetch must not occur');
    });
    vi.stubGlobal('fetch', globalFetch);

    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={adapter} onSave={onSave} onClose={() => {}} />
    );
    // 20. No automatic generation: mount + mode switch + catalog read make zero image POSTs and zero binary GETs.
    expect(calls.filter((c) => c.url.startsWith('/api/recipes/image/')).length).toBe(0);
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/recipes/image/')).length).toBe(0);

    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-confirm')).toBeTruthy());
    expect(calls.filter((c) => c.url === '/api/recipes/image/quote').length).toBe(1);
    // 17. Quote is zero-inference: exactly one quote POST, zero generate POSTs so far.
    expect(calls.filter((c) => c.url === '/api/recipes/image/generate').length).toBe(0);

    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    await waitFor(() => expect(screen.getByTestId('ai-image-preview')).toBeTruthy());
    const generateCalls = calls.filter((c) => c.url === '/api/recipes/image/generate');
    expect(generateCalls.length).toBe(1);
    expect((generateCalls[0].body as Record<string, unknown>)['confirmationToken']).toBe('tok-1');
    // Protected JSON + binary share the current header.
    expect(authOf(calls, '/api/recipes/image/quote', 'POST')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(authOf(calls, '/api/recipes/image/generate', 'POST')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(authOf(calls, '/api/recipes/image/preview/preview-1', 'GET')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    // 17. Preview fetching made no additional provider (POST) call.
    expect(calls.filter((c) => c.method === 'POST').length).toBe(2);
    // No bare fetch to the preview route.
    expect(globalFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('ai-image-use'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(asset.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(asset.write).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect((saved.frontmatter as Record<string, unknown>)['codex_generated_image']).toMatchObject({
      generated: true,
      provider: 'gemini-image',
    });
    // 18. Object URLs revoked after Save replaced the transient preview.
    await waitFor(() => expect(URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled());
  });

  it('missing binary path fails closed in the mounted editor (no bare fetch, bounded message)', async () => {
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
            costLabel: 'Variable pricing',
            requiresConfirmation: true,
            confirmationToken: 'tok-1',
          },
        };
      }
      if (path === '/api/recipes/image/generate') {
        return {
          ok: true,
          status: 200,
          data: { token: 'preview-1', contentType: 'image/png', provider: 'p', model: 'm', recipeContentHash: '', vaultSessionId: '', expiresAt: 1 },
        };
      }
      return { ok: false, status: 404, data: {} };
    });
    const network = {
      post,
      get: vi.fn(async () => ({ ok: true, status: 200, data: CATALOG })),
      request: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
    } as never;
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset: makeAsset() }} network={network} onSave={vi.fn()} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('generate-image-ai'));
    await waitFor(() => expect(screen.getByTestId('ai-image-generate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-image-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    await waitFor(() => expect(screen.getByText(/image preview could not be loaded/i)).toBeTruthy());
    expect(screen.queryByTestId('ai-image-preview')).toBeNull();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('Vault Intelligence — protected preview/save through the same authenticated path', () => {
  it('14. generate->save resolves preview bytes via the authenticated adapter with the current header', async () => {
    const { calls, fetchFn } = makeRouter({ requiresConfirmation: false });
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    await hydrateAiSelections({ get: async () => undefined });

    const states: { phase: string }[] = [];
    const saved: { imagePath: string }[] = [];
    const controller = new RecipeImageRecoveryController({
      network: adapter,
      support: {
        vaultSessionId: 'vault-session-abc',
        asset: { write: async () => {}, exists: async () => false } as unknown as AssetAdapter,
        computeContentHash: async () => 'a'.repeat(64),
        // App-shell save wiring: bytes ONLY via the authenticated adapter path.
        saveImage: (async () => {
          const viaAdapter = await fetchGeneratedPreviewBytes(adapter, 'preview-1');
          if (!viaAdapter) throw new Error('preview unavailable');
          saved.push({ imagePath: 'Assets/Test Soup.png' });
          return { imagePath: 'Assets/Test Soup.png', provider: 'gemini-image', model: 'm', generatedAt: 't' };
        }) as never,
      },
      onState: (s) => states.push({ phase: s.phase }),
      onSaved: (r) => saved.push(r),
    });
    await controller.generate(makeRecipe());
    expect(states[states.length - 1].phase).toBe('preview');
    await controller.save(makeRecipe());
    expect(saved.length).toBeGreaterThan(0);
    expect(authOf(calls, '/api/recipes/image/quote', 'POST')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(authOf(calls, '/api/recipes/image/generate', 'POST')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(authOf(calls, '/api/recipes/image/preview/preview-1', 'GET')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    // Preview bytes are transient metadata only: no base64/data-URL channel,
    // and the render uses a managed secure URL (never a plain protected src).
    const html = renderToString(
      <RecipeImageFindingView
        health={{ kind: 'missing', deterministic: true, reason: 'No image.' }}
        canGenerate
        previewUrl="blob:secure-preview"
        recoveryState={{
          phase: 'preview',
          preview: {
            token: 'preview-1',
            contentType: 'image/png',
            provider: 'gemini-image',
            model: 'gemini-2.5-flash-image',
            recipeContentHash: 'b'.repeat(64),
            vaultSessionId: 'vault-session-abc',
          },
          message: 'AI-generated preview — nothing is saved yet.',
          messageKind: 'info',
        }}
        busy={false}
        onGenerate={() => {}}
        onSave={() => {}}
        onRegenerate={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('base64');
    expect(html).not.toContain('/api/recipes/image/preview/');
    expect(html).not.toContain(ENDPOINT_TOKEN);
  });
});

describe('licensed representative images — protected selected-preview, free search', () => {
  it('15+16. search+select+preview share the endpoint header; search needs no provider key; no upstream URL is fetched', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    await hydrateAiSelections({ get: async () => undefined });
    const globalFetch = vi.fn(async () => {
      throw new Error('upstream fetch must not occur');
    });
    vi.stubGlobal('fetch', globalFetch);

    const found = await findRepresentativeImages(adapter, { query: 'blue cheese burger' });
    expect(found.candidates.length).toBe(1);
    const selected = await selectRepresentativeImage(adapter, found.candidates[0].id);
    const bytes = await fetchGeneratedPreviewBytes(adapter, selected.token);
    expect(bytes?.bytes.length).toBeGreaterThan(0);
    expect(authOf(calls, '/api/recipes/image/find-representative', 'POST')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(authOf(calls, '/api/recipes/image/select-representative', 'POST')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(authOf(calls, '/api/recipes/image/preview/tok-1', 'GET')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    // 16. Licensed search is provider-key independent: payloads carry no key material.
    for (const call of calls) {
      expect(JSON.stringify(call.body ?? {})).not.toMatch(/api[_-]?key|BEGIN [A-Z ]*PRIVATE KEY/i);
      expect(call.url).not.toMatch(/^https?:\/\//);
    }
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('mounted representative selection in the editor uses the authenticated binary path with the current header', async () => {
    const { calls, fetchFn } = makeRouter();
    const adapter = new BrowserNetworkAdapter({ fetchFn, authorizationHeaders: getEndpointAccessHeaders });
    setEndpointAccessToken(ENDPOINT_TOKEN);
    const asset = makeAsset();
    const onSave = vi.fn();
    render(
      <RecipeEditorModal initialRecipe={makeRecipe()} imageService={{ asset }} network={adapter} onSave={onSave} onClose={() => {}} />
    );
    fireEvent.click(screen.getByTestId('find-representative-image'));
    await waitFor(() => expect(screen.getAllByTestId('representative-candidate').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
    fireEvent.click(screen.getByTestId('use-representative-image'));
    await waitFor(() => expect(screen.queryByText('Choose a Representative Recipe Image')).toBeNull());
    expect(authOf(calls, '/api/recipes/image/select-representative', 'POST')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(authOf(calls, '/api/recipes/image/preview/tok-1', 'GET')).toBe(`Bearer ${ENDPOINT_TOKEN}`);
    expect(asset.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect((saved.frontmatter as Record<string, unknown>)['codex_representative_image']).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain(ENDPOINT_TOKEN);
  });

  it('representative thumbnails stay requester-bound AND endpoint-protected (no secret in the img URL by design)', async () => {
    const app = await readFile(join(process.cwd(), 'server/app.ts'), 'utf8');
    const thumbSection = app.slice(app.indexOf('/api/recipes/image/representative-thumbnail'));
    expect(thumbSection).toContain('requireAiAccessToken');
    expect(thumbSection).toContain('representativeRequesterId');
  });
});
