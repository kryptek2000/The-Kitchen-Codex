import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * v0.8.0 — OpenRouter dynamic catalog: normalization, pricing, free detection,
 * free-first behavior, compatibility filtering, cache/timeout fallback, and the
 * selection/connection-test integration. Hermetic: every network call uses an
 * injected fetch seam; the default fetch is disabled under NODE_ENV=test.
 */

const SENTINEL = 'sk-or-v1-CATALOG_SECURITY_SENTINEL';

const DEFAULT_PARAMS = ['temperature', 'max_tokens', 'response_format', 'structured_outputs'];

function rawModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vendor/model',
    name: 'Vendor: Model',
    context_length: 8192,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.0000001', completion: '0.0000004' },
    supported_parameters: DEFAULT_PARAMS,
    ...overrides,
  };
}

function jsonFetch(payload: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, text: async () => text };
  };
  return { fetchFn, calls };
}

function streamResponse(obj: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => {
            if (sent) return { done: true as const };
            sent = true;
            return { done: false as const, value: bytes };
          },
          cancel: async () => {},
          releaseLock: () => {},
        };
      },
    },
  };
}

async function fresh() {
  vi.resetModules();
  process.env.OPENROUTER_API_KEY = SENTINEL;
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  const effective = await import('../../server/ai/effectiveSelection.js');
  const registry = await import('../../server/ai/providerRegistry.js');
  const imageRegistry = await import('../../server/ai/imageProviderRegistry.js');
  const connectionTest = await import('../../server/ai/connectionTest.js');
  return { catalog, effective, registry, imageRegistry, connectionTest };
}

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('v0.8.0 OpenRouter catalog — normalization', () => {
  it('A. normalizes free / budget / paid / router / image rows from live-shape entries', async () => {
    const { catalog } = await fresh();
    const payload = {
      data: [
        rawModel({ id: 'free/one:free', name: 'Free One', pricing: { prompt: '0', completion: '0' } }),
        rawModel({ id: 'cheap/two', pricing: { prompt: '0.0000001', completion: '0.0000004' } }),
        rawModel({ id: 'pricey/three', pricing: { prompt: '0.00001', completion: '0.00003' } }),
        rawModel({
          id: 'openrouter/free',
          name: 'Free Models Router',
          pricing: { prompt: '0', completion: '0' },
        }),
        rawModel({
          id: 'img/one',
          name: 'Image One',
          architecture: { input_modalities: ['text'], output_modalities: ['image'] },
          pricing: { prompt: '0.0000003', completion: '0.0000025', image_output: '0.00003' },
        }),
      ],
    };
    const { textModels, imageModels } = catalog.normalizeOpenRouterCatalogPayload(payload);
    const byId = new Map(textModels.map((m: any) => [m.modelId, m]));
    expect(byId.get('free/one:free').isFree).toBe(true);
    expect(byId.get('free/one:free').costClass).toBe('free');
    expect(byId.get('cheap/two').costClass).toBe('budget');
    expect(byId.get('pricey/three').costClass).toBe('paid');
    expect(byId.get('openrouter/free').isRouter).toBe(true);
    expect(byId.get('openrouter/free').isFree).toBe(true);
    expect(textModels.some((m: any) => m.modelId === 'img/one')).toBe(false);
    expect(imageModels.map((m: any) => m.modelId)).toEqual(['img/one']);
    expect(imageModels[0].pricing.imageOutputPerToken).toBeCloseTo(0.00003, 10);
    expect(imageModels[0].isFree).toBe(false);
  });

  it('B. malformed upstream entries are ignored (fail safe)', async () => {
    const { catalog } = await fresh();
    const payload = {
      data: [
        null,
        42,
        {},
        { id: '' },
        { id: 'no-architecture' },
        rawModel({ id: 'good/one' }),
      ],
    };
    const { textModels } = catalog.normalizeOpenRouterCatalogPayload(payload);
    expect(textModels.map((m: any) => m.modelId)).toEqual(['good/one']);
  });

  it('malformed top-level payload throws (caller falls back)', async () => {
    const { catalog } = await fresh();
    expect(() => catalog.normalizeOpenRouterCatalogPayload({ data: 'nope' })).toThrow();
    expect(() => catalog.normalizeOpenRouterCatalogPayload(null)).toThrow();
  });

  it('excludes alias redirects and :online web-plugin models', async () => {
    const { catalog } = await fresh();
    const payload = {
      data: [rawModel({ id: '~openai/alias' }), rawModel({ id: 'x/y:online' }), rawModel({ id: 'ok/one' })],
    };
    const { textModels } = catalog.normalizeOpenRouterCatalogPayload(payload);
    expect(textModels.map((m: any) => m.modelId)).toEqual(['ok/one']);
  });
});

describe('v0.8.0 OpenRouter catalog — pricing + free detection', () => {
  it('C. parses per-token pricing and converts to per-million correctly', async () => {
    const { catalog } = await fresh();
    expect(catalog.parsePerTokenPrice('0.00000015')).toBeCloseTo(1.5e-7, 12);
    expect(catalog.parsePerTokenPrice('0')).toBe(0);
    expect(catalog.parsePerTokenPrice('-1')).toBeNull();
    expect(catalog.parsePerTokenPrice('abc')).toBeNull();
    expect(catalog.perTokenToPerMillion(0.00000015)).toBeCloseTo(0.15, 10);
    expect(catalog.perTokenToPerMillion(null)).toBeNull();
    expect(catalog.formatPerMillionUsd(0.0000001)).toBe('$0.100');
    expect(catalog.formatPerMillionUsd(null)).toBe('Variable');
  });

  it('D. free is proven by zero cost, never by a name or the :free suffix alone', async () => {
    const { catalog } = await fresh();
    const trulyFree = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/truly:free', name: 'Anything', pricing: { prompt: '0', completion: '0' } })
    );
    expect(trulyFree.isFree).toBe(true);
    const namedFreeButPaid = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/named', name: 'Free Model', pricing: { prompt: '0.000001', completion: '0.000002' } })
    );
    expect(namedFreeButPaid.isFree).toBe(false);
    const suffixFreeButPaid = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/suffix:free', pricing: { prompt: '0.000001', completion: '0' } })
    );
    expect(suffixFreeButPaid.isFree).toBe(false);
  });

  it('E. openrouter/free is a first-class free, structured-capable router', async () => {
    const { catalog } = await fresh();
    const model = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'openrouter/free', name: 'Free Models Router', pricing: { prompt: '0', completion: '0' } })
    );
    expect(model.isRouter).toBe(true);
    expect(model.isFree).toBe(true);
    expect(model.capabilities.structuredOutput).toBe(true);
  });
});

describe('v0.8.0 OpenRouter catalog — compatibility + capability filtering', () => {
  it('H. only text-output models enter the text list', async () => {
    const { catalog } = await fresh();
    const payload = {
      data: [
        rawModel({ id: 'text/one' }),
        rawModel({
          id: 'image/one',
          architecture: { input_modalities: ['text'], output_modalities: ['image'] },
        }),
      ],
    };
    const { textModels } = catalog.normalizeOpenRouterCatalogPayload(payload);
    expect(textModels.map((m: any) => m.modelId)).toEqual(['text/one']);
  });

  it('I. structured output CANDIDATE requires BOTH params, but only the verified allowlist is selectable', async () => {
    const { catalog } = await fresh();
    const onlyFormat = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/one', supported_parameters: ['temperature', 'response_format'] })
    );
    expect(onlyFormat.capabilities.structuredOutput).toBe(false);
    const onlyStructured = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/two', supported_parameters: ['temperature', 'structured_outputs'] })
    );
    expect(onlyStructured.capabilities.structuredOutput).toBe(false);
    const both = catalog.normalizeOpenRouterModel(rawModel({ id: 'a/three' }));
    // A catalog CANDIDATE is not automatically trusted for strict structured output.
    expect(both.capabilities.structuredOutput).toBe(true);
    expect(both.structuredVerified).toBe(false);
    expect(catalog.isSelectableOpenRouterTextModel(onlyFormat)).toBe(false);
    expect(catalog.isSelectableOpenRouterTextModel(both)).toBe(false);
    // Only the server-owned verified allowlist is selectable.
    const verified = catalog.normalizeOpenRouterModel(rawModel({ id: 'openai/gpt-4o-mini' }));
    expect(verified.structuredVerified).toBe(true);
    expect(catalog.isSelectableOpenRouterTextModel(verified)).toBe(true);
  });

  it('derives vision / large-context / reasoning badges only from metadata', async () => {
    const { catalog } = await fresh();
    const model = catalog.normalizeOpenRouterModel(
      rawModel({
        id: 'a/vision',
        context_length: 262144,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        supported_parameters: [...DEFAULT_PARAMS, 'reasoning'],
      })
    );
    expect(model.capabilities.vision).toBe(true);
    expect(model.capabilities.largeContext).toBe(true);
    expect(model.capabilities.reasoning).toBe(true);
  });
});

describe('v0.8.0 OpenRouter catalog — fetch, cache, timeout, fallback', () => {
  it('uses the FIXED endpoint, GET, no redirects, and NEVER attaches a credential', async () => {
    const { catalog } = await fresh();
    const { fetchFn, calls } = jsonFetch({ data: [rawModel({ id: 'a/one' })] });
    await catalog.refreshOpenRouterCatalog({ force: true, fetchFn });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(catalog.OPENROUTER_MODELS_ENDPOINT);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.redirect).toBe('error');
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('authorization');
    expect(JSON.stringify(headers)).not.toContain(SENTINEL);
  });

  it('R. falls back to the curated baseline on network failure and never throws', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const snap = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => {
        throw new Error('network down');
      },
    });
    expect(snap.source).toBe('curated_fallback');
    // BLOCKING-1: openrouter/free is NOT advertised on fallback.
    expect(snap.textModels.map((m: any) => m.modelId)).not.toContain('openrouter/free');
    expect(snap.textModels.map((m: any) => m.modelId)).toContain('openai/gpt-4o-mini');
    expect(snap.textModels.every((m: any) => m.isFree === false && m.pricingVerified === false)).toBe(true);
  });

  it('R. keeps the last-known live snapshot when a later refresh fails', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const good = jsonFetch({ data: [rawModel({ id: 'a/one' })] });
    await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: good.fetchFn });
    const afterFail = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => {
        throw new Error('down');
      },
    });
    // The last-known data is retained but its price truth is marked NOT fresh.
    expect(afterFail.source).toBe('cached');
    expect(afterFail.pricingFresh).toBe(false);
    expect(afterFail.textModels.map((m: any) => m.modelId)).toContain('a/one');
  });

  it('falls back on a non-2xx, unreadable, or oversized body', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const nonOk = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
    });
    expect(nonOk.source).toBe('curated_fallback');

    catalog.resetOpenRouterCatalogForTests();
    const oversized = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => 'x'.repeat(catalog.OPENROUTER_CATALOG_LIMITS.maxBytes + 1),
      }),
    });
    expect(oversized.source).toBe('curated_fallback');
  });

  it('S. caches within the TTL and only refetches when forced', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const first = jsonFetch({ data: [rawModel({ id: 'a/one' })] });
    await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: first.fetchFn });
    const second = jsonFetch({ data: [rawModel({ id: 'b/two' })] });
    const cached = await catalog.refreshOpenRouterCatalog({ fetchFn: second.fetchFn });
    expect(second.calls).toHaveLength(0);
    expect(cached.source).toBe('cached');
    expect(cached.textModels.map((m: any) => m.modelId)).toContain('a/one');
    await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: second.fetchFn });
    expect(second.calls).toHaveLength(1);
  });
});

describe('v0.8.0 OpenRouter catalog — selection integration', () => {
  const payloadWithDynamic = {
    data: [
      rawModel({ id: 'free/dynamic:free', name: 'Dynamic Free', pricing: { prompt: '0', completion: '0' } }),
      rawModel({ id: 'paid/dynamic', name: 'Dynamic Paid', pricing: { prompt: '0.00001', completion: '0.00003' } }),
      rawModel({ id: 'nostruct/dynamic', supported_parameters: ['temperature', 'max_tokens'] }),
    ],
  };

  it('K. dynamic models are NOT selectable; the curated verified model stays selectable and disappears closed', async () => {
    const { catalog, effective, registry } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: jsonFetch(payloadWithDynamic).fetchFn });
    const regs = registry.getRegisteredProviders();
    // The verified curated model is selectable.
    expect(
      effective.validateUserTextSelection({ providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }, regs)
    ).toEqual({ providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' });
    // An arbitrary dynamic model is NOT (strict structured compatibility unproven).
    expect(
      effective.validateUserTextSelection({ providerId: 'openrouter', modelId: 'paid/dynamic' }, regs)
    ).toBeNull();
  });

  it('M. an arbitrary client-supplied model id is rejected', async () => {
    const { catalog, effective, registry } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: jsonFetch(payloadWithDynamic).fetchFn });
    const regs = registry.getRegisteredProviders();
    expect(
      effective.validateUserTextSelection(
        { providerId: 'openrouter', modelId: 'totally/arbitrary-not-in-catalog' },
        regs
      )
    ).toBeNull();
  });

  it('N. a free model later reported paid is no longer labeled FREE', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const freeSnap = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [rawModel({ id: 'was/free', pricing: { prompt: '0', completion: '0' } })],
      }).fetchFn,
    });
    expect(freeSnap.textModels.find((m: any) => m.modelId === 'was/free').isFree).toBe(true);
    const paidSnap = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [rawModel({ id: 'was/free', pricing: { prompt: '0.00001', completion: '0.00003' } })],
      }).fetchFn,
    });
    const model = paidSnap.textModels.find((m: any) => m.modelId === 'was/free');
    expect(model.isFree).toBe(false);
    expect(model.costClass).not.toBe('free');
  });

  it('O/P/Q. image discovery surfaces compatible image models and never fakes free', async () => {
    const { catalog, imageRegistry } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const snap = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [
          rawModel({
            id: 'img/paid',
            architecture: { input_modalities: ['text'], output_modalities: ['image'] },
            pricing: { prompt: '0.0000003', completion: '0.0000025', image_output: '0.00003' },
          }),
          // prompt/completion zero but image output paid -> NOT free.
          rawModel({
            id: 'img/not-really-free',
            architecture: { input_modalities: ['text'], output_modalities: ['image'] },
            pricing: { prompt: '0', completion: '0', image_output: '0.00003' },
          }),
        ],
      }).fetchFn,
    });
    expect(snap.imageModels.map((m: any) => m.modelId)).toEqual(['img/paid', 'img/not-really-free']);
    expect(snap.imageModels.find((m: any) => m.modelId === 'img/not-really-free').isFree).toBe(false);
    // Dynamic image-output models are DISCOVERED but NOT executable/selectable
    // (IMPORTANT-3: no proof of `/api/v1/images` compatibility).
    expect(catalog.openRouterImageModelIds()).toContain('img/paid');
    expect(catalog.openRouterSelectableImageModelIds()).not.toContain('img/paid');
    const registered = imageRegistry.findRegisteredImageProvider('openrouter-image')!;
    const selectable = imageRegistry.selectableImageModels(registered);
    expect(selectable).not.toContain('img/paid');
    expect(selectable).toContain('google/gemini-2.5-flash-image');
  });

  it('T. text and image model spaces never cross; provider ids stay distinct', async () => {
    const { catalog, imageRegistry } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [
          rawModel({ id: 'text/only' }),
          rawModel({
            id: 'img/only',
            architecture: { input_modalities: ['text'], output_modalities: ['image'] },
          }),
        ],
      }).fetchFn,
    });
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('img/only');
    const registered = imageRegistry.findRegisteredImageProvider('openrouter-image')!;
    expect(imageRegistry.selectableImageModels(registered)).not.toContain('text/only');
    expect(registered.provider.id).toBe('openrouter-image');
  });

  it('U. Test Connection allows the verified model and rejects unverified dynamic ids', async () => {
    const { catalog, connectionTest } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({ force: true, fetchFn: jsonFetch(payloadWithDynamic).fetchFn });
    const allowlist = connectionTest.curatedConnectionTestModels('openrouter', 'text');
    expect(allowlist).toContain('openai/gpt-4o-mini');
    expect(allowlist).not.toContain('paid/dynamic');

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return streamResponse({ data: { label: 'test', usage: 0, limit: null, is_free_tier: false } });
    });
    connectionTest.resetConnectionTestConcurrencyForTests();
    const ok = await connectionTest.runConnectionTest({
      providerId: 'openrouter',
      kind: 'text',
      modelId: 'openai/gpt-4o-mini',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.model).toBe('openai/gpt-4o-mini');

    const callsBefore = calls.length;
    const rejected = await connectionTest.runConnectionTest({
      providerId: 'openrouter',
      kind: 'text',
      modelId: 'paid/dynamic',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected).toMatchObject({ ok: false, code: 'INVALID_MODEL' });
    expect(calls.length).toBe(callsBefore);
  });
});

describe('v0.8.0 OpenRouter catalog — secret boundary', () => {
  it('V. normalized snapshots and catalog payloads never contain a secret', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const snap = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [rawModel({ id: 'a/one', apiKey: SENTINEL, secret: SENTINEL })],
      }).fetchFn,
    });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('Authorization');
  });

  it('dynamic capability truth never claims recipe generation or web search', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({ data: [rawModel({ id: 'a/one' })] }).fetchFn,
    });
    const caps = catalog.openRouterDynamicCapabilities('a/one');
    // An arbitrary catalog candidate is NOT trusted for strict structured output.
    expect(caps).toMatchObject({ structuredOutput: false, recipeGeneration: false, webSearch: false });
  });
});
