import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { ModelPicker } from '../../src/application-ui/ModelPicker.js';
import {
  normalizeProviderCatalog,
  fetchProviderCatalog,
  PROVIDER_CATALOG_API_PATH,
} from '../../src/application-ui/providerCatalog.js';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter.js';
import type { SurfaceModelOption } from '../../src/application-ui/modelPicker.js';
import {
  OPENROUTER_MODELS_ENDPOINT,
  normalizeOpenRouterCatalogPayload,
  refreshOpenRouterCatalog,
  resetOpenRouterCatalogForTests,
} from '../../server/ai/openRouterCatalog.js';

const SENTINEL = 'sk-or-v1-DYNAMIC_CATALOG_SECURITY_SENTINEL';

const MODELS: SurfaceModelOption[] = [
  {
    id: 'vendor/free:free',
    default: false,
    displayName: 'Vendor Free',
    isFree: true,
    costClass: 'free',
    capabilities: { reasoning: false, structuredOutput: true, recipeGeneration: false, webSearch: false },
    pricing: { promptPerToken: 0, completionPerToken: 0, imageOutputPerToken: null, variable: false },
  },
  {
    id: 'vendor/paid',
    default: true,
    displayName: 'Vendor Paid',
    isFree: false,
    costClass: 'paid',
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    pricing: { promptPerToken: 0.00001, completionPerToken: 0.00003, imageOutputPerToken: null, variable: false },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  resetOpenRouterCatalogForTests();
});

describe('v0.8.0 OpenRouter catalog — security boundaries', () => {
  it('uses ONLY the fixed trusted catalog endpoint (no client-controlled URL)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    resetOpenRouterCatalogForTests();
    await refreshOpenRouterCatalog({
      force: true,
      fetchFn: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
      },
    });
    expect(calls[0].url).toBe(OPENROUTER_MODELS_ENDPOINT);
    expect(calls[0].init.redirect).toBe('error');
    expect(JSON.stringify(calls[0].init.headers ?? {}).toLowerCase()).not.toContain('authorization');
  });

  it('normalized catalog data never carries a secret or secret-shaped field', () => {
    const payload = {
      data: [
        {
          id: 'vendor/leaky',
          name: 'Leaky',
          context_length: 8192,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['temperature', 'max_tokens', 'response_format', 'structured_outputs'],
          apiKey: SENTINEL,
          secret: SENTINEL,
          authorization: SENTINEL,
        },
      ],
    };
    const { textModels } = normalizeOpenRouterCatalogPayload(payload);
    const serialized = JSON.stringify(textModels);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('authorization');
  });

  it('opening/rendering the model picker performs NO network call and NO image generation', () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('no network expected from the picker');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const html = renderToString(
      React.createElement(ModelPicker, {
        kind: 'text',
        models: MODELS,
        value: 'vendor/paid',
        onChange: () => {},
        defaultOpen: true,
      })
    );
    expect(html).toContain('data-model-picker-panel="text"');
    expect(html).toContain('FREE');
    expect(html).toContain('Vendor Free');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the image picker truthfully shows no free image models and performs no generation', () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('no network expected');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const html = renderToString(
      React.createElement(ModelPicker, {
        kind: 'image',
        models: [
          {
            id: 'img/paid',
            default: true,
            displayName: 'Paid Image',
            isFree: false,
            costClass: 'paid',
            pricing: { promptPerToken: 0.000002, completionPerToken: 0.000012, imageOutputPerToken: 0.00012, variable: false },
          },
        ],
        onChange: () => {},
        defaultOpen: true,
      })
    );
    expect(html).toContain('No free image-generation models currently available.');
    expect(html).not.toContain('FREE');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the catalog fetch uses the NetworkAdapter path and never a direct browser fetch', async () => {
    const calls: string[] = [];
    const adapter = {
      get: async (path: string) => {
        calls.push(path);
        return {
          status: 200,
          ok: true,
          data: {
            catalog: {
              textProviders: [
                {
                  providerId: 'openrouter',
                  name: 'OpenRouter',
                  configured: true,
                  enabled: true,
                  available: true,
                  storageScope: 'server_environment',
                  supportsSecretWrites: false,
                  connectionTest: 'network_probe',
                  selectable: true,
                  sessionKeySupported: true,
                  models: [
                    {
                      id: 'vendor/free:free',
                      default: false,
                      capabilities: { reasoning: false, structuredOutput: true, recipeGeneration: false, webSearch: false },
                      displayName: 'Vendor Free',
                      isFree: true,
                      costClass: 'free',
                      pricing: { promptPerToken: 0, completionPerToken: 0, imageOutputPerToken: null, variable: false },
                    },
                  ],
                },
              ],
              imageProviders: [],
              selection: {
                text: { selectionMode: 'server_default', valid: true },
                image: { selectionMode: 'server_default', valid: true },
                userSelectionAllowed: { text: true, image: true },
                executable: { text: true, image: false },
              },
              dynamicCatalog: {
                source: 'live',
                fetchedAt: 1,
                textModelCount: 1,
                freeTextModelCount: 1,
                imageModelCount: 0,
                freeImageModelCount: 0,
                freeRouterAvailable: true,
              },
            },
          },
        };
      },
      post: async () => ({ status: 200, ok: true, data: undefined }),
      request: async () => ({ status: 200, ok: true, data: undefined }),
    };
    const globalFetch = vi.fn(async () => {
      throw new Error('no direct fetch expected');
    });
    vi.stubGlobal('fetch', globalFetch);
    const view = await fetchProviderCatalog(adapter as unknown as NetworkAdapter);
    expect(calls).toEqual([PROVIDER_CATALOG_API_PATH]);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(view.dynamicCatalog?.freeTextModelCount).toBe(1);
    expect(view.textProviders[0].models[0].isFree).toBe(true);
    expect(view.textProviders[0].models[0].displayName).toBe('Vendor Free');
  });

  it('normalizes away secret-shaped model fields', () => {
    const view = normalizeProviderCatalog({
      catalog: {
        textProviders: [
          {
            providerId: 'openrouter',
            name: 'OpenRouter',
            configured: true,
            enabled: true,
            available: true,
            storageScope: 'server_environment',
            supportsSecretWrites: false,
            connectionTest: 'network_probe',
            selectable: true,
            sessionKeySupported: true,
            models: [
              {
                id: 'vendor/one',
                default: false,
                capabilities: { structuredOutput: true },
                apiKey: SENTINEL,
                pricing: { promptPerToken: 0, completionPerToken: 0, imageOutputPerToken: null, variable: false, secret: SENTINEL },
              },
            ],
          },
        ],
        imageProviders: [],
        selection: {
          text: { selectionMode: 'server_default', valid: true },
          image: { selectionMode: 'server_default', valid: true },
          userSelectionAllowed: { text: true, image: true },
          executable: { text: true, image: false },
        },
      },
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('apiKey');
  });
});
