/**
 * AN-WEB-1 — bounded external nutrition research.
 *
 * Offline only. The provider's grounded search and structured extraction are
 * mocked; the real request sanitizer, fetched-source allowlist, deterministic
 * scaling, contribution validator, and evidence classifier are exercised.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  registry: [] as any[],
  searchCalls: 0,
  extractionCalls: 0,
  extraction: null as null | ((prompt: string) => unknown),
  searchResults: [] as Array<{ url: string; title?: string; sourceName?: string }>,
  fetchCalls: 0,
  fetchHtml: '<html><body>Nutrition Facts: per 100 g calories 250, protein 10 g, fat 12 g, carbohydrate 20 g, sodium 400 mg.</body></html>',
}));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return { ...actual, getRegisteredProviders: () => state.registry };
});

vi.mock('../../server/ssrfGuard.js', () => ({
  safeFetchHtml: async (url: string) => {
    state.fetchCalls += 1;
    return { html: state.fetchHtml, finalUrl: url };
  },
}));

import { researchNutritionOnServer } from '../../server/nutritionResearch';
import type { AiCapabilities, AiJsonSchema, AiProvider, AiStructuredOptions } from '../../src/core/ai/types';

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'gemini',
    name: 'gemini',
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: true },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (_prompt: string, _schema: AiJsonSchema, _options?: AiStructuredOptions) => {
      state.extractionCalls += 1;
      return (state.extraction ? state.extraction(_prompt) : { evidence: [] }) as never;
    },
    searchWeb: async () => {
      state.searchCalls += 1;
      return state.searchResults;
    },
    ...overrides,
  } as AiProvider;
}

function target(overrides: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    line_ref: 'ing:0:abc',
    ingredient_text: '100 g Marmite',
    amount: 100,
    unit: 'g',
    measurement_kind: 'mass' as const,
    quantity_grams: 100,
    ambiguity: 'missing_information' as const,
    ...overrides,
  };
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function request(targets: unknown[]) {
  return { request_version: 'nutrition_ai_web_research_request_v1', targets };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    evidence: [
      {
        line_ref: 'ing:0:abc',
        source_url: 'https://example.com/marmite',
        source_title: 'Example Marmite label',
        food_identity: 'Marmite yeast extract',
        basis: { kind: 'per_100_g' },
        nutrients: [
          { id: 'calories', amount: 250, unit: 'kcal' },
          { id: 'protein', amount: 10, unit: 'g' },
          { id: 'fat', amount: 12, unit: 'g' },
          { id: 'carbohydrates', amount: 20, unit: 'g' },
          { id: 'sodium', amount: 400, unit: 'mg' },
        ],
        confidence: 'medium',
        assumptions: [],
        limitations: ['Label values; verify the exact product.'],
        ...overrides,
      },
    ],
  };
}

beforeEach(() => {
  state.registry = [{ provider: provider(), defaultCapabilities: { ...provider().capabilities } as AiCapabilities }];
  state.searchCalls = 0;
  state.extractionCalls = 0;
  state.extraction = () => evidence();
  state.searchResults = [{ url: 'https://example.com/marmite', title: 'Example Marmite label' }];
  state.fetchCalls = 0;
  state.fetchHtml = '<html><body><h1>Example Marmite label</h1><p>Nutrition Facts: per 100 g calories 250 kcal, protein 10 g, fat 12 g, carbohydrates 20 g, sodium 400 mg.</p><p>Serving: 1 tbsp (15 g): calories 30 kcal, sodium 500 mg.</p><p>Typical values are published by the manufacturer for the stated 100 g basis. This fixture intentionally contains enough readable text to pass the bounded page-content check.</p></body></html>';
});

describe('AN-WEB-1 — research contract and deterministic scaling', () => {
  it('retrieves grounded pages, extracts them, and scales per-100-g evidence for a mass target', async () => {
    const result = await researchNutritionOnServer(request([target()]));
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(state.searchCalls).toBe(1);
    expect(state.extractionCalls).toBe(1);
    expect(state.fetchCalls).toBe(1);
    expect(result.contributions).toHaveLength(1);
    const contribution = result.contributions[0];
    expect(contribution.classification).toBe('source_backed');
    expect(contribution.sources).toEqual([{ title: 'Example Marmite label', url: 'https://example.com/marmite' }]);
    expect(contribution.nutrients.calories?.amount).toBe(250);
    expect(contribution.nutrients.protein?.amount).toBe(10);
    expect(contribution.nutrients.sodium?.amount).toBe(400);
    expect(contribution.weight_grams).toBe(100);
    expect(result.evidence[0].source_url).toBe('https://example.com/marmite');
    expect(result.evidence[0].classification).toBe('source_backed');
  });

  it('scales a labeled serving by matching authored volume units', async () => {
    state.extraction = () => evidence({
      basis: { kind: 'per_serving', serving_amount: 1, serving_unit: 'tbsp' },
      nutrients: [{ id: 'calories', amount: 30, unit: 'kcal' }, { id: 'sodium', amount: 500, unit: 'mg' }],
    });
    const result = await researchNutritionOnServer(request([
      target({ ingredient_text: '2 tbsp Marmite', amount: 2, unit: 'tbsp', measurement_kind: 'volume', quantity_grams: undefined, quantity_ml: 30 }),
    ]));
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.contributions[0].nutrients.calories?.amount).toBe(60);
    expect(result.contributions[0].nutrients.sodium?.amount).toBe(1000);
  });

  it('rejects per-100-g claims copied from a different serving-basis section', async () => {
    // Both numbers genuinely appear on the page, but ONLY in the tablespoon
    // label. A real URL plus matching numbers is not proof of a per-100-g value.
    state.extraction = () => evidence({
      basis: { kind: 'per_100_g' },
      nutrients: [
        { id: 'calories', amount: 30, unit: 'kcal' },
        { id: 'sodium', amount: 500, unit: 'mg' },
      ],
    });
    const result = await researchNutritionOnServer(request([target()]));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('no_supported_evidence');
  });

  it('rejects serving-based claims copied from the per-100-g section', async () => {
    state.extraction = () => evidence({
      basis: { kind: 'per_serving', serving_amount: 1, serving_unit: 'tbsp' },
      nutrients: [
        { id: 'calories', amount: 250, unit: 'kcal' },
        { id: 'sodium', amount: 400, unit: 'mg' },
      ],
    });
    const result = await researchNutritionOnServer(request([
      target({ ingredient_text: '2 tbsp Marmite', amount: 2, unit: 'tbsp', measurement_kind: 'volume', quantity_grams: undefined, quantity_ml: 30 }),
    ]));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('no_supported_evidence');
  });

  it('refuses a per-100-g source for a volume target without a mass conversion', async () => {
    const result = await researchNutritionOnServer(request([
      target({ ingredient_text: '2 cups Marmite', amount: 2, unit: 'cups', measurement_kind: 'volume', quantity_grams: undefined, quantity_ml: 480 }),
    ]));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('no_supported_evidence');
    expect(state.extractionCalls).toBe(1);
  });

  it('never researches an identity-ambiguous target and never decides salted versus unsalted', async () => {
    const result = await researchNutritionOnServer(request([
      target({ ingredient_text: '1 cup passata', ambiguity: 'identity_ambiguous' }),
    ]));
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(state.searchCalls).toBe(0);
    expect(state.extractionCalls).toBe(0);
    expect(result.contributions).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('identity_ambiguous');
  });

  it('rejects a model-cited URL that the server did not retrieve', async () => {
    state.extraction = () => evidence({ source_url: 'https://invented.example/label' });
    const result = await researchNutritionOnServer(request([target()]));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('invalid_evidence');
  });

  it('fails clearly when the provider lacks grounded web search', async () => {
    const noWeb = provider({ capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false }, searchWeb: undefined });
    state.registry = [{ provider: noWeb, defaultCapabilities: { ...noWeb.capabilities } as AiCapabilities }];
    const result = await researchNutritionOnServer(request([target()]));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('web_unavailable');
    expect(state.searchCalls).toBe(0);
    expect(state.extractionCalls).toBe(0);
  });

  it('fails clearly when no grounded source can be retrieved', async () => {
    state.searchResults = [];
    const result = await researchNutritionOnServer(request([target()]));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('source_unavailable');
    expect(state.fetchCalls).toBe(0);
    expect(state.extractionCalls).toBe(0);
  });

  it('refuses to manufacture evidence when the source reports no usable basis', async () => {
    state.extraction = () => evidence({
      basis: { kind: 'per_serving', serving_unit: 'cup' },
      nutrients: [{ id: 'calories', amount: 100, unit: 'kcal' }],
    });
    const result = await researchNutritionOnServer(request([
      target({ ingredient_text: '1 cup Marmite', amount: 1, unit: 'cup', measurement_kind: 'volume', quantity_grams: undefined }),
    ]));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('no_supported_evidence');
  });
});
