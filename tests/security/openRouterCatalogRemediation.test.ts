import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * v0.8.0 remediation — Terra audit security tests.
 *
 * Covers the BLOCKING/IMPORTANT findings: free-router fallback truth, FREE->PAID
 * spend protection, conservative pricing, normalization bounds, duplicate-ID
 * policy, strict structured compatibility, image transport compatibility, and
 * client-forgery resistance.
 */

const SENTINEL = 'sk-or-v1-REMEDIATION_SENTINEL';

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
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetchFn, calls };
}

async function fresh() {
  vi.resetModules();
  process.env.OPENROUTER_API_KEY = SENTINEL;
  const catalog = await import('../../server/ai/openRouterCatalog.js');
  const effective = await import('../../server/ai/effectiveSelection.js');
  const parse = await import('../../server/ai/parseSelectionMetadata.js');
  const registry = await import('../../server/ai/providerRegistry.js');
  const imageRegistry = await import('../../server/ai/imageProviderRegistry.js');
  return { catalog, effective, parse, registry, imageRegistry };
}

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('v0.8.0 remediation — openrouter/free fallback truth (BLOCKING-1)', () => {
  it('A. with no live record, openrouter/free is NOT verified FREE', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const snap = catalog.getOpenRouterCatalogSnapshot();
    expect(snap.source).toBe('curated_fallback');
    expect(snap.pricingFresh).toBe(false);
    const freeRouter = snap.textModels.find((m: any) => m.modelId === 'openrouter/free');
    expect(freeRouter).toBeUndefined();
    expect(snap.textModels.every((m: any) => m.isFree === false)).toBe(true);
  });

  it('B. fallback cannot dynamically select an unverified openrouter/free', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('openrouter/free');
    expect(catalog.openRouterSelectableTextModelIds()).toEqual(['openai/gpt-4o-mini']);
  });

  it('C. a live-verified free router is FREE only while the cache is fresh', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    const snap = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [
          rawModel({ id: 'openrouter/free', name: 'Free Models Router', pricing: { prompt: '0', completion: '0' } }),
        ],
      }).fetchFn,
    });
    const router = snap.textModels.find((m: any) => m.modelId === 'openrouter/free');
    expect(router.isFree).toBe(true);
    expect(router.pricingVerified).toBe(true);
    // Still NOT selectable (strict structured compatibility is not verified).
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('openrouter/free');
  });
});

describe('v0.8.0 remediation — conservative pricing (BLOCKING-3)', () => {
  it('G. auxiliary nonzero pricing prevents FREE', async () => {
    const { catalog } = await fresh();
    const model = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/aux', pricing: { prompt: '0', completion: '0', web_search: '0.014' } })
    );
    expect(model.isFree).toBe(false);
    expect(model.costClass).not.toBe('free');
  });

  it('H. an unknown price-bearing field prevents FREE', async () => {
    const { catalog } = await fresh();
    const model = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/unknown', pricing: { prompt: '0', completion: '0', mystery_tier: '0.5' } })
    );
    expect(model.isFree).toBe(false);
    expect(model.pricing.variable).toBe(true);
    expect(model.costClass).toBe('variable');
  });

  it('I. malformed / object pricing prevents FREE', async () => {
    const { catalog } = await fresh();
    const malformed = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/malformed', pricing: { prompt: '0', completion: '0', image_output: 'n/a' } })
    );
    expect(malformed.isFree).toBe(false);
    const objectPriced = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'a/object', pricing: { prompt: '0', completion: '0', tiered: { min: 1 } } })
    );
    expect(objectPriced.isFree).toBe(false);
    expect(objectPriced.pricing.variable).toBe(true);
  });

  it('J. Infinity / NaN / negative prevents FREE', async () => {
    const { catalog } = await fresh();
    for (const bad of ['Infinity', 'NaN', '-0.1', '']) {
      const model = catalog.normalizeOpenRouterModel(
        rawModel({ id: 'a/bad', pricing: { prompt: '0', completion: '0', audio: bad } })
      );
      expect(model.isFree).toBe(false);
    }
  });

  it('K. variable/override pricing classifies VARIABLE, never FREE', async () => {
    const { catalog } = await fresh();
    const model = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } })
    );
    expect(model.isFree).toBe(false);
    expect(model.pricing.variable).toBe(true);
    expect(model.costClass).toBe('variable');
  });

  it('X. free image classification is conservative (all components must be zero)', async () => {
    const { catalog } = await fresh();
    const imageArch = { input_modalities: ['text'], output_modalities: ['image'] };
    const trulyFree = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'img/free', architecture: imageArch, pricing: { prompt: '0', completion: '0', image_output: '0' } })
    );
    expect(trulyFree.isFree).toBe(true);
    const paidOutput = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'img/paid', architecture: imageArch, pricing: { prompt: '0', completion: '0', image_output: '0.00003' } })
    );
    expect(paidOutput.isFree).toBe(false);
    const missingOutput = catalog.normalizeOpenRouterModel(
      rawModel({ id: 'img/missing', architecture: imageArch, pricing: { prompt: '0', completion: '0' } })
    );
    expect(missingOutput.isFree).toBe(false);
  });
});

describe('v0.8.0 remediation — normalization bounds (IMPORTANT-1)', () => {
  it('N. caps the model count deterministically', async () => {
    const { catalog } = await fresh();
    const max = catalog.OPENROUTER_CATALOG_BOUNDS.maxModels;
    const data = Array.from({ length: max + 50 }, (_, i) => rawModel({ id: `v/m${i}` }));
    const { textModels } = catalog.normalizeOpenRouterCatalogPayload({ data });
    expect(textModels.length).toBeLessThanOrEqual(max);
    expect(textModels.length).toBe(max);
  });

  it('O. rejects overlong / malformed model ids', async () => {
    const { catalog } = await fresh();
    const tooLong = 'a'.repeat(catalog.OPENROUTER_CATALOG_BOUNDS.maxIdLength + 1);
    const payload = {
      data: [
        rawModel({ id: tooLong }),
        rawModel({ id: 'has space' }),
        rawModel({ id: 'has\tcontrol' }),
        rawModel({ id: 'ok/good' }),
      ],
    };
    const { textModels } = catalog.normalizeOpenRouterCatalogPayload(payload);
    expect(textModels.map((m: any) => m.modelId)).toEqual(['ok/good']);
  });

  it('P. caps the display-name length', async () => {
    const { catalog } = await fresh();
    const longName = 'x'.repeat(catalog.OPENROUTER_CATALOG_BOUNDS.maxNameLength + 500);
    const model = catalog.normalizeOpenRouterModel(rawModel({ id: 'a/name', name: longName }));
    expect(model.displayName.length).toBe(catalog.OPENROUTER_CATALOG_BOUNDS.maxNameLength);
  });

  it('Q. caps parameter and modality list lengths', async () => {
    const { catalog } = await fresh();
    const params = Array.from({ length: 500 }, (_, i) => `p${i}`);
    const modalities = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const model = catalog.normalizeOpenRouterModel(
      rawModel({
        id: 'a/lists',
        supported_parameters: params,
        architecture: { input_modalities: modalities, output_modalities: ['text'] },
      })
    );
    expect(model.supportedParameters.length).toBe(catalog.OPENROUTER_CATALOG_BOUNDS.maxSupportedParameters);
    expect(model.inputModalities.length).toBe(catalog.OPENROUTER_CATALOG_BOUNDS.maxModalities);
  });
});

describe('v0.8.0 remediation — duplicate-ID policy (IMPORTANT-1)', () => {
  it('L. identical duplicates de-dupe; conflicting duplicates reject the id', async () => {
    const { catalog } = await fresh();
    const identical = catalog.normalizeOpenRouterCatalogPayload({
      data: [rawModel({ id: 'dup/same' }), rawModel({ id: 'dup/same' })],
    });
    expect(identical.textModels.filter((m: any) => m.modelId === 'dup/same')).toHaveLength(1);

    const conflicting = catalog.normalizeOpenRouterCatalogPayload({
      data: [
        rawModel({ id: 'dup/conflict', pricing: { prompt: '0', completion: '0' } }),
        rawModel({ id: 'dup/conflict', pricing: { prompt: '0.00001', completion: '0.00003' } }),
      ],
    });
    expect(conflicting.textModels.some((m: any) => m.modelId === 'dup/conflict')).toBe(false);
  });

  it('M. a conflicting FREE vs PAID duplicate never becomes FREE', async () => {
    const { catalog } = await fresh();
    const { textModels } = catalog.normalizeOpenRouterCatalogPayload({
      data: [
        rawModel({ id: 'dup/freepaid', pricing: { prompt: '0', completion: '0' } }),
        rawModel({ id: 'dup/freepaid', pricing: { prompt: '0.00001', completion: '0.00003' } }),
      ],
    });
    expect(textModels.some((m: any) => m.isFree)).toBe(false);
    expect(textModels.some((m: any) => m.modelId === 'dup/freepaid')).toBe(false);
  });
});

describe('v0.8.0 remediation — strict structured + image transport (IMPORTANT-2/3)', () => {
  it('R/S. an unverified dynamic structured model is NOT selectable/executable', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({ data: [rawModel({ id: 'dynamic/structured' })] }).fetchFn,
    });
    const model = catalog.findOpenRouterCatalogModel('dynamic/structured')!;
    expect(model.capabilities.structuredOutput).toBe(true);
    expect(model.structuredVerified).toBe(false);
    expect(model.executionCompatible).toBe(false);
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('dynamic/structured');
    expect(catalog.openRouterDynamicCapabilities('dynamic/structured')).toMatchObject({
      structuredOutput: false,
    });
  });

  it('T. openrouter/free cannot bypass the strict structured rule', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [rawModel({ id: 'openrouter/free', pricing: { prompt: '0', completion: '0' } })],
      }).fetchFn,
    });
    expect(catalog.openRouterDynamicCapabilities('openrouter/free')).toMatchObject({ structuredOutput: false });
    expect(catalog.openRouterSelectableTextModelIds()).not.toContain('openrouter/free');
  });

  it('V. a generic image-output model is NOT automatically `/images` compatible', async () => {
    const { catalog, imageRegistry } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [
          rawModel({
            id: 'generic/image',
            architecture: { input_modalities: ['text'], output_modalities: ['image'] },
            pricing: { prompt: '0.0000003', completion: '0.0000025', image_output: '0.00003' },
          }),
        ],
      }).fetchFn,
    });
    expect(catalog.openRouterImageModelIds()).toContain('generic/image');
    expect(catalog.openRouterSelectableImageModelIds()).not.toContain('generic/image');
    const registered = imageRegistry.findRegisteredImageProvider('openrouter-image')!;
    expect(imageRegistry.selectableImageModels(registered)).not.toContain('generic/image');
  });

  it('W. the curated image model remains valid/selectable', async () => {
    const { imageRegistry } = await fresh();
    const registered = imageRegistry.findRegisteredImageProvider('openrouter-image')!;
    const selectable = imageRegistry.selectableImageModels(registered);
    expect(selectable).toContain('google/gemini-2.5-flash-image');
    expect(selectable).toContain('bytedance-seed/seedream-4.5');
  });

  it('U. recipeGeneration is never claimed for dynamic models', async () => {
    const { catalog } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({ data: [rawModel({ id: 'dynamic/one' })] }).fetchFn,
    });
    expect(catalog.openRouterDynamicCapabilities('dynamic/one')).toMatchObject({
      recipeGeneration: false,
      webSearch: false,
    });
  });
});

describe('v0.8.0 remediation — FREE -> PAID spend protection (BLOCKING-2)', () => {
  it('D. a FREE-acknowledged model that became PAID blocks text execution', async () => {
    const { catalog, effective, registry, parse } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    // First observed as FREE...
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [rawModel({ id: 'openai/gpt-4o-mini', pricing: { prompt: '0', completion: '0' } })],
      }).fetchFn,
    });
    // ...then the current trusted catalog reports it PAID.
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [
          rawModel({ id: 'openai/gpt-4o-mini', pricing: { prompt: '0.00001', completion: '0.00003' } }),
        ],
      }).fetchFn,
    });
    const regs = registry.getRegisteredProviders();
    const intent = parse.parseTextSelectionHeader({
      'x-kitchen-ai-text-selection': JSON.stringify({
        mode: 'user_selected',
        providerId: 'openrouter',
        modelId: 'openai/gpt-4o-mini',
        selectedCostClass: 'free',
      }),
    });
    const result = effective.resolveTextCandidateContext('kitchenInterpret', regs, intent);
    expect(result.candidates).toEqual([]);
    expect(result.pricingBlocked).toBe('MODEL_PRICING_CHANGED');
  });

  it('E. re-selection acknowledging the current paid state proceeds', async () => {
    const { catalog, effective, registry, parse } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [
          rawModel({ id: 'openai/gpt-4o-mini', pricing: { prompt: '0.00001', completion: '0.00003' } }),
        ],
      }).fetchFn,
    });
    const regs = registry.getRegisteredProviders();
    const intent = parse.parseTextSelectionHeader({
      'x-kitchen-ai-text-selection': JSON.stringify({
        mode: 'user_selected',
        providerId: 'openrouter',
        modelId: 'openai/gpt-4o-mini',
        selectedCostClass: 'paid',
      }),
    });
    const result = effective.resolveTextCandidateContext('kitchenInterpret', regs, intent);
    expect(result.pricingBlocked).toBeUndefined();
    expect(result.candidates.map((c: any) => c.model)).toContain('openai/gpt-4o-mini');
  });

  it('F. an expired FREE cache + refresh failure blocks execution', async () => {
    const { catalog, effective, registry, parse } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [rawModel({ id: 'openai/gpt-4o-mini', pricing: { prompt: '0', completion: '0' } })],
      }).fetchFn,
    });
    // Force a stale reuse: refresh failure retains last-known but NOT pricing-fresh.
    const stale = await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: async () => {
        throw new Error('network down');
      },
    });
    expect(stale.pricingFresh).toBe(false);
    const regs = registry.getRegisteredProviders();
    const intent = parse.parseTextSelectionHeader({
      'x-kitchen-ai-text-selection': JSON.stringify({
        mode: 'user_selected',
        providerId: 'openrouter',
        modelId: 'openai/gpt-4o-mini',
        selectedCostClass: 'free',
      }),
    });
    const result = effective.resolveTextCandidateContext('kitchenInterpret', regs, intent);
    expect(result.candidates).toEqual([]);
    expect(result.pricingBlocked).toBe('MODEL_PRICING_UNVERIFIED');
  });

  it('D/Z. a stale browser FREE claim cannot cause paid image execution', async () => {
    const { catalog, effective, parse } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [
          rawModel({
            id: 'google/gemini-2.5-flash-image',
            architecture: { input_modalities: ['text'], output_modalities: ['image'] },
            pricing: { prompt: '0.00001', completion: '0.00003', image_output: '0.00006' },
          }),
        ],
      }).fetchFn,
    });
    const intent = parse.parseImageSelectionHeader({
      'x-kitchen-ai-image-selection': JSON.stringify({
        mode: 'user_selected',
        providerId: 'openrouter-image',
        modelId: 'google/gemini-2.5-flash-image',
        selectedCostClass: 'free',
      }),
    });
    const result = effective.resolveEffectiveImageSelection(intent);
    expect(result.provider).toBeNull();
    expect(result.pricingBlocked).toBe('MODEL_PRICING_CHANGED');
  });

  it('Y. a client cannot forge a FREE acknowledgement for a paid model', async () => {
    const { catalog, effective, registry, parse } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [
          rawModel({ id: 'openai/gpt-4o-mini', pricing: { prompt: '0.00001', completion: '0.00003' } }),
        ],
      }).fetchFn,
    });
    const regs = registry.getRegisteredProviders();
    // Forged FREE claim for a paid model.
    const intent = parse.parseTextSelectionHeader({
      'x-kitchen-ai-text-selection': JSON.stringify({
        mode: 'user_selected',
        providerId: 'openrouter',
        modelId: 'openai/gpt-4o-mini',
        selectedCostClass: 'free',
      }),
    });
    const result = effective.resolveTextCandidateContext('kitchenInterpret', regs, intent);
    expect(result.candidates).toEqual([]);
    expect(result.pricingBlocked).toBe('MODEL_PRICING_CHANGED');
  });

  it('rejects a malformed selectedCostClass in the header (fail closed)', async () => {
    const { parse } = await fresh();
    const intent = parse.parseTextSelectionHeader({
      'x-kitchen-ai-text-selection': JSON.stringify({
        mode: 'user_selected',
        providerId: 'openrouter',
        modelId: 'openai/gpt-4o-mini',
        selectedCostClass: 'totally-free',
      }),
    });
    expect(intent.kind).toBe('INVALID');
  });
});
