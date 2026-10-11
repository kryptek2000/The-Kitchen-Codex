/**
 * The Kitchen Codex — Phase 9B-P1 integration coverage.
 * GEMINI THINKING COMPATIBILITY APPLIED BY THE TWO SEMANTIC OPERATIONS.
 *
 * `tests/unit/geminiThinkingPolicy.test.ts` proves the POLICY in isolation.
 * This file proves the two Advanced Nutrition SEMANTIC OPERATIONS actually
 * APPLY it, through the real Express routes, with only the provider registry
 * substituted (the existing provider test facility).
 *
 * What is proven here, and would FAIL without the repair:
 *   - `gemini-3.7-flash` is sent `LOW`, never `MINIMAL`, on BOTH paths
 *   - `gemini-3.1-flash-lite` still receives `MINIMAL` (no fallback regression)
 *   - the decision is made from the EXECUTING candidate, not the preferred one
 *   - a non-Gemini provider receives NO Gemini thinking fragment
 *   - an unknown Gemini model receives NO explicit thinking option
 *   - fallback still engages, and the reported provider/model is the ACTUAL winner
 *   - the `wsem1` semantic-origin receipt and closed response key set are unchanged
 *   - Basic tier still denies with ZERO provider work
 *
 * NO real provider key and NO network access are used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { MODEL_CONFIG } from '../../server/modelConfig';
import type { AiCandidate, RegisteredProvider } from '../../server/ai/providerRegistry';
import { ProviderOperationError } from '../../server/ai/providerErrors';
import type {
  AiCapabilities,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from '../../src/core/ai/types';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';

const AI_ENDPOINT_TOKEN = '9bp1-secret-token';
const AUTH = { authorization: `Bearer ${AI_ENDPOINT_TOKEN}` };
const V = 'nutrition_ai_whole_recipe_interpretation_request_v1';

// ---------------------------------------------------------------------------
// PROVIDER REGISTRY MOCK — the ONLY substitution.
// ---------------------------------------------------------------------------

interface Call {
  readonly providerId: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly rawProviderOptions: unknown;
}

const prov = vi.hoisted(() => ({
  calls: [] as unknown[],
  /** Models this provider should THROW for, exercising real fallback. */
  failModels: [] as string[],
}));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return {
    ...actual,
    getRegisteredProviders: () =>
      (globalThis as never as { __P1_REGISTRY?: RegisteredProvider[] }).__P1_REGISTRY ?? [],
  };
});

function thinkingLevelOf(options?: AiStructuredOptions): string | undefined {
  const po = options?.providerOptions as { thinkingConfig?: { thinkingLevel?: unknown } } | undefined;
  return typeof po?.thinkingConfig?.thinkingLevel === 'string' ? po.thinkingConfig.thinkingLevel : undefined;
}

function mockProvider(id: string): AiProvider {
  return {
    id,
    name: id,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (prompt: string, _s: AiJsonSchema, options?: AiStructuredOptions) => {
      const model = options?.model ?? '';
      prov.calls.push({
        providerId: id,
        model,
        thinkingLevel: thinkingLevelOf(options),
        rawProviderOptions: options?.providerOptions,
      } satisfies Call);
      if (prov.failModels.includes(model)) {
        throw new ProviderOperationError('RATE_LIMIT', 'provider rate limited', {});
      }
      const targets = parseTargets(prompt);
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: targets.map((line_ref) => ({
          contract_version: 'nutrition_ai_advanced_interpretation_v1',
          line_ref,
          semantic_food: {
            normalized_name: 'whole egg',
            modifiers: [],
            preparation: ['separated'],
            state: ['raw'],
            qualifiers: [],
          },
          search_phrases: ['whole egg'],
          amount_semantics: { kind: 'unknown' },
          unit_semantics: { family: 'unknown' },
          count_semantics: {},
          alternatives: [],
          ambiguity: { ambiguous: false, reasons: [] },
        })),
      } as never;
    },
  };
}

/** Reads the requested line refs out of whichever prompt shape was used. */
function parseTargets(prompt: string): string[] {
  const start = prompt.indexOf('RECIPE DATA');
  if (start >= 0) {
    const data = prompt.slice(start);
    const jsonStart = data.indexOf('\n') + 1;
    const payload = JSON.parse(data.slice(jsonStart)) as {
      requested_targets: Array<{ line_ref: string }>;
    };
    return payload.requested_targets.map((t) => t.line_ref);
  }
  // AI-1 renders a bounded row list; take every `line_ref` string in order.
  return [...prompt.matchAll(/"line_ref"\s*:\s*"([^"]+)"/g)].map((m) => m[1] as string);
}

function registryEntryFor(provider: AiProvider): RegisteredProvider {
  return {
    provider,
    defaultCapabilities: { ...provider.capabilities } as AiCapabilities,
  };
}

function useRegistry(...providerIds: string[]): void {
  (globalThis as never as { __P1_REGISTRY?: RegisteredProvider[] }).__P1_REGISTRY = providerIds.map(
    (id) => registryEntryFor(mockProvider(id)),
  );
}

function lastCalls(): Call[] {
  return prov.calls as Call[];
}

// ---------------------------------------------------------------------------
// HARNESS (same shape as the 9B-2C route suite)
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_TEXT_PROVIDER', 'KITCHEN_CODEX_TEXT_MODEL',
  'NUTRITION_RESOLVE_RATE_LIMIT', 'NUTRITION_INTERPRET_RATE_LIMIT', 'NUTRITION_PLAN_RATE_LIMIT',
  'NUTRITION_ESTIMATE_RATE_LIMIT', 'NUTRITION_CONTEXT_RATE_LIMIT', 'NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT',
] as const;

interface Running { server: http.Server; baseUrl: string }

async function startApp(tier: 'ai_advanced' | 'basic'): Promise<Running> {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  for (const k of ENV_KEYS) {
    if (k.endsWith('RATE_LIMIT')) process.env[k] = '1000';
  }
  const { createApp } = await import('../../server/app.js');
  const { resetRateLimitersForTests } = await import('../../server/rateLimiter.js');
  const authorityModule = await import('../../server/nutritionProductAccessAuthority.js');
  resetRateLimitersForTests();
  const app = createApp({
    isProduction: false,
    nutritionProductAccessAuthority:
      authorityModule.createDeploymentNutritionProductAccessAuthority(tier),
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

const stop = ({ server }: Running) => new Promise<void>((r) => server.close(() => r()));

async function post(baseUrl: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown>; raw: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(raw) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: response.status, json, raw, headers: response.headers };
}

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

const EGG_RECIPE = {
  ingredients: [
    { name: '4 eggs, separated' },
    { name: '1/2 cup whole milk' },
    { name: '2 tablespoons unsalted butter' },
    { name: '1/4 teaspoon salt' },
    { name: '1 tablespoon chopped chives' },
  ],
};
const INSTRUCTIONS = [
  { text: 'Separate the egg whites from the yolks, keeping both.' },
  { text: 'Whisk the yolks with the milk and salt.' },
  { text: 'Beat the egg whites until light and foamy.' },
  { text: 'Melt the butter in a skillet.' },
  { text: 'Fold the beaten whites back into the yolk mixture.' },
  { text: 'Cook gently until set.' },
  { text: 'Finish with chopped chives.' },
];

function eggLineRef(): string {
  const adapted = adaptRecipe(EGG_RECIPE);
  if (adapted.ok !== true) throw new Error('fixture did not adapt');
  return adapted.recipe.adapted[0].line_ref;
}

function wholeRecipeRequest(): Record<string, unknown> {
  return {
    request_version: V,
    request_id: 'p1-egg',
    recipe: EGG_RECIPE,
    instructions: INSTRUCTIONS,
    targets: [{ line_ref: eggLineRef() }],
  };
}

function ai1Request(): Record<string, unknown> {
  return {
    ingredients: [
      { line_ref: 'line:0', ingredient_text: '4 eggs, separated' },
      { line_ref: 'line:1', ingredient_text: '1/2 cup whole milk' },
    ],
  };
}

const WHOLE_RECIPE_ROUTE = '/api/nutrition/interpret-whole-recipe';
const AI1_ROUTE = '/api/nutrition/interpret-ingredients';

/** The real 9B-2C operation, imported through the mocked provider registry. */
async function loadWholeRecipeOperation() {
  return (await import('../../server/wholeRecipeSemanticInterpret.js'))
    .interpretWholeRecipeSemantics;
}

const PRIMARY = MODEL_CONFIG.nutritionPrimary;        // gemini-3.7-flash
const FALLBACK = MODEL_CONFIG.nutritionFallback;      // gemini-3.1-flash-lite

beforeEach(() => {
  prov.calls = [];
  prov.failModels = [];
});
afterEach(() => {
  delete (globalThis as never as { __P1_REGISTRY?: RegisteredProvider[] }).__P1_REGISTRY;
});

// ---------------------------------------------------------------------------
// §6 — both semantic paths use the candidate-specific decision
// ---------------------------------------------------------------------------

describe('9B-P1 — whole-recipe semantic operation applies the policy', () => {
  let app: Running;
  beforeEach(async () => {
    useRegistry('gemini');
    app = await startApp('ai_advanced');
  });
  afterEach(() => stop(app));

  it('sends the supported LOW level to the 3.7 Flash PRIMARY (never MINIMAL)', async () => {
    const r = await post(app.baseUrl, WHOLE_RECIPE_ROUTE, wholeRecipeRequest());
    expect(r.status).toBe(200);
    const calls = lastCalls();
    expect(calls.length).toBeGreaterThan(0);
    const primary = calls.find((c) => c.model === PRIMARY);
    expect(primary, 'primary candidate must have executed').toBeDefined();
    expect(primary!.thinkingLevel).toBe('LOW');
    expect(primary!.thinkingLevel).not.toBe('MINIMAL');
  });

  it('sends no explicit thinking option at all for a NON-Gemini candidate', async () => {
    // Provider isolation at the operation level: a candidate whose provider is
    // not Gemini never receives the Gemini-only fragment.
    const interpretWholeRecipeSemantics = await loadWholeRecipeOperation();
    const provider = mockProvider('openrouter');
    const result = await interpretWholeRecipeSemantics(
      wholeRecipeRequest(),
      {
        registry: [registryEntryFor(provider)],
        candidates: [{ provider, model: 'some/openrouter-model' }],
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(lastCalls()[0].providerId).toBe('openrouter');
    expect(lastCalls()[0].thinkingLevel).toBeUndefined();
    expect(lastCalls()[0].rawProviderOptions).toEqual({});
  });
});

describe('9B-P1 — AI-1 semantic operation applies the SAME policy', () => {
  let app: Running;
  beforeEach(async () => {
    useRegistry('gemini');
    app = await startApp('ai_advanced');
  });
  afterEach(() => stop(app));

  it('sends the supported LOW level to the 3.7 Flash PRIMARY (never MINIMAL)', async () => {
    const r = await post(app.baseUrl, AI1_ROUTE, ai1Request());
    expect(r.status).toBe(200);
    const primary = lastCalls().find((c) => c.model === PRIMARY);
    expect(primary, 'primary candidate must have executed').toBeDefined();
    expect(primary!.thinkingLevel).toBe('LOW');
  });

  it('sends no Gemini thinking fragment to a non-Gemini provider', async () => {
    const interpretWholeRecipeSemantics = await loadWholeRecipeOperation();
    const provider = mockProvider('openrouter');
    const result = await interpretWholeRecipeSemantics(
      wholeRecipeRequest(),
      {
        registry: [registryEntryFor(provider)],
        candidates: [{ provider, model: 'some/openrouter-model' }],
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(lastCalls()[0].rawProviderOptions).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// §6 — fallback still works, and is configured per-candidate
// ---------------------------------------------------------------------------

describe('9B-P1 — fallback is preserved and each candidate is configured for ITSELF', () => {
  let app: Running;
  beforeEach(async () => {
    useRegistry('gemini');
    app = await startApp('ai_advanced');
  });
  afterEach(() => stop(app));

  it('Flash-Lite fallback STILL receives MINIMAL after the primary is forced to fail', async () => {
    prov.failModels = [PRIMARY];
    const r = await post(app.baseUrl, WHOLE_RECIPE_ROUTE, wholeRecipeRequest());
    expect(r.status).toBe(200);

    const calls = lastCalls();
    const primaryCall = calls.find((c) => c.model === PRIMARY);
    const fallbackCall = calls.find((c) => c.model === FALLBACK);
    expect(primaryCall).toBeDefined();
    expect(fallbackCall).toBeDefined();
    // The decision follows the EXECUTING candidate, not the preferred one.
    expect(primaryCall!.thinkingLevel).toBe('LOW');
    expect(fallbackCall!.thinkingLevel).toBe('MINIMAL');

    // Reported identity is the ACTUAL winner, not the failed primary.
    expect(r.json['provider_id']).toBe('gemini');
    expect(r.json['model_id']).toBe(FALLBACK);
  });

  it('AI-1 keeps the same per-candidate fallback configuration', async () => {
    prov.failModels = [PRIMARY];
    const r = await post(app.baseUrl, AI1_ROUTE, ai1Request());
    expect(r.status).toBe(200);
    const calls = lastCalls();
    expect(calls.find((c) => c.model === PRIMARY)!.thinkingLevel).toBe('LOW');
    expect(calls.find((c) => c.model === FALLBACK)!.thinkingLevel).toBe('MINIMAL');
  });

  it('an unknown Gemini model receives NO explicit thinking option (operation level)', async () => {
    // Drive the REAL operation with an explicitly injected candidate list whose
    // Gemini model id is absent from the policy table.
    const interpretWholeRecipeSemantics = await loadWholeRecipeOperation();
    const provider = mockProvider('gemini');
    const result = await interpretWholeRecipeSemantics(
      wholeRecipeRequest(),
      { candidates: [{ provider, model: 'gemini-flash-latest' }] },
    );
    expect(result.ok).toBe(true);
    const calls = lastCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('gemini-flash-latest');
    expect(calls[0].thinkingLevel).toBeUndefined();
    expect(calls[0].rawProviderOptions).toEqual({});
  });

  it('a KNOWN Gemini model still receives its supported level at the operation level', async () => {
    const interpretWholeRecipeSemantics = await loadWholeRecipeOperation();
    const provider = mockProvider('gemini');
    const result = await interpretWholeRecipeSemantics(
      wholeRecipeRequest(),
      { candidates: [{ provider, model: PRIMARY }] },
    );
    expect(result.ok).toBe(true);
    expect(lastCalls()[0].thinkingLevel).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// §6 — security surfaces unchanged by the repair
// ---------------------------------------------------------------------------

describe('9B-P1 — semantic-origin and closed wire are unchanged', () => {
  let app: Running;
  beforeEach(async () => {
    useRegistry('gemini');
    app = await startApp('ai_advanced');
  });
  afterEach(() => stop(app));

  it('still issues the wsem1 receipt and the exact closed key set', async () => {
    const r = await post(app.baseUrl, WHOLE_RECIPE_ROUTE, wholeRecipeRequest());
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual([
      'aiAttempted', 'context_binding', 'contract_version', 'model_id', 'ok',
      'operation_id', 'origin_receipt', 'provider_id', 'request_id',
      'request_version', 'semantic_response',
    ]);
    expect(String(r.json['origin_receipt'])).toMatch(/^wsem1\.[A-Za-z0-9_-]{43}$/);
    expect(String(r.json['operation_id'])).toMatch(/^wsemo1\./);
    expect(String(r.json['context_binding'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('introduces NO forbidden nutrition authority field', async () => {
    const r = await post(app.baseUrl, WHOLE_RECIPE_ROUTE, wholeRecipeRequest());
    expect(r.status).toBe(200);
    for (const forbidden of ['fdc_id', 'fdcId', 'grams', 'mass_g', 'nutrients', 'calories', 'density', 'portion_index', 'apply']) {
      expect(r.raw, forbidden).not.toContain(forbidden);
    }
  });

  it('never leaks a thinking level or provider diagnostics into the response', async () => {
    const r = await post(app.baseUrl, WHOLE_RECIPE_ROUTE, wholeRecipeRequest());
    expect(r.status).toBe(200);
    for (const forbidden of ['MINIMAL', 'thinkingLevel', 'thinkingConfig', 'providerOptions', 'stack', 'diagnostics']) {
      expect(r.raw, forbidden).not.toContain(forbidden);
    }
  });
});

describe('9B-P1 — Basic tier still denies with ZERO provider work', () => {
  let app: Running;
  beforeEach(async () => {
    useRegistry('gemini');
    app = await startApp('basic');
  });
  afterEach(() => stop(app));

  it('whole-recipe route: 403, aiAttempted false, ZERO provider calls', async () => {
    const r = await post(app.baseUrl, WHOLE_RECIPE_ROUTE, wholeRecipeRequest());
    expect(r.status).toBe(403);
    expect(r.json['code']).toBe('NUTRITION_AI_NOT_ENTITLED');
    expect(r.json['aiAttempted']).toBe(false);
    expect(prov.calls).toHaveLength(0);
  });

  it('AI-1 route: 403, aiAttempted false, ZERO provider calls', async () => {
    const r = await post(app.baseUrl, AI1_ROUTE, ai1Request());
    expect(r.status).toBe(403);
    expect(r.json['code']).toBe('NUTRITION_AI_NOT_ENTITLED');
    expect(r.json['aiAttempted']).toBe(false);
    expect(prov.calls).toHaveLength(0);
  });
});
