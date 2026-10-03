/**
 * AI-5B — SERVER-AUTHORITATIVE ENTITLEMENT BOUNDARY (HTTP route gate).
 *
 * Boots the REAL Express app and drives the REAL AI Advanced Nutrition routes to
 * prove the server is the authority:
 *
 *   M. the ROUTE MATRIX: every one of the six paid AI Advanced Nutrition routes
 *      refuses a Basic deployment with 403 `NUTRITION_AI_NOT_ENTITLED` and
 *      `aiAttempted: false`;
 *   Z. ZERO PROVIDER WORK on that refusal: no transport entrypoint, no provider
 *      transport call, no credential resolution, no HTTP provider call, and no
 *      session-credential consumption — proven by counters, not by response shape;
 *   F. CLIENT FORGERY has ZERO authority: no body field, header, cookie or query
 *      value unlocks a route, and a configured provider does not either;
 *   A. AUTHENTICATION ORDER: endpoint auth stays FIRST, so an unauthenticated
 *      caller learns nothing about product access;
 *   O. MIDDLEWARE ORDER: entitlement precedes pricing, rate limiting and selection;
 *   P. the ADVANCED POSITIVE PATH is unchanged and entitlement is NOT sufficient
 *      for success (provider readiness still decides);
 *   R. RECONCILE requires CURRENT entitlement AND a genuine origin receipt.
 *
 * The AI pipeline counters wrap the REAL modules with a counting passthrough, so the
 * admitted path exercises production code unchanged.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'net';

import { resetRateLimitersForTests } from '../../server/rateLimiter.js';
import { deriveRecipeContextModelInput } from '../../server/recipeContextDerivation.js';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';
import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from '../../src/core/nutritionV2/aiRecipeContextRequest';

const REPO = join(__dirname, '..', '..');
const APP_SOURCE = readFileSync(join(REPO, 'server', 'app.ts'), 'utf8');

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_TEXT_PROVIDER',
  'KITCHEN_CODEX_TEXT_MODEL',
  'NUTRITION_RESOLVE_RATE_LIMIT',
  'NUTRITION_INTERPRET_RATE_LIMIT',
  'NUTRITION_PLAN_RATE_LIMIT',
  'NUTRITION_ESTIMATE_RATE_LIMIT',
  'NUTRITION_CONTEXT_RATE_LIMIT',
  'NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT',
] as const;

/**
 * Every way a caller could reach provider work. All must stay at zero for a Basic
 * denial: this is the behavioural counterpart to the response assertions.
 */
const counters = vi.hoisted(() => ({
  /** Route-bound AI transport entrypoints reached (AI-1..AI-4 + reconcile). */
  transport: 0,
  /** Gemini SDK `generateContent` invocations. */
  geminiGenerate: 0,
  /** Credential resolutions (server_environment / session_only lease). */
  credentialResolve: 0,
  /** Outbound HTTP calls to a provider host (never localhost test traffic). */
  providerHttp: 0,
}));

/** Per-route transport entry, so a refusal can be attributed precisely. */
const transportEntries = vi.hoisted(() => [] as string[]);

/**
 * The REAL AI-1..AI-4 transports, wrapped in a counting passthrough. The
 * implementation still runs unchanged on the entitled path; only entry is counted.
 */
function countedPassthrough<T extends Record<string, unknown>>(actual: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    wrapped[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            counters.transport += 1;
            transportEntries.push(name);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return wrapped as T;
}

vi.mock('../../server/nutritionResolve.js', async () =>
  countedPassthrough(await vi.importActual<Record<string, unknown>>('../../server/nutritionResolve.js')),
);
vi.mock('../../server/nutritionInterpret.js', async () =>
  countedPassthrough(await vi.importActual<Record<string, unknown>>('../../server/nutritionInterpret.js')),
);
vi.mock('../../server/nutritionPlan.js', async () =>
  countedPassthrough(await vi.importActual<Record<string, unknown>>('../../server/nutritionPlan.js')),
);
vi.mock('../../server/nutritionEstimate.js', async () =>
  countedPassthrough(await vi.importActual<Record<string, unknown>>('../../server/nutritionEstimate.js')),
);
vi.mock('../../server/recipeContextReconcile.js', async () =>
  countedPassthrough(await vi.importActual<Record<string, unknown>>('../../server/recipeContextReconcile.js')),
);

/**
 * The AI-4C transport is stubbed against the REAL server-side derivation so a genuine
 * origin receipt (and therefore a genuine CURRENT reconciliation) is reachable without
 * contacting a provider. `transport.providerCalls` is the provider-call counter for
 * AI-4; `transport.entered` is its transport-entry counter.
 */
const ai4 = vi.hoisted(() => ({ entered: 0, providerCalls: 0 }));

vi.mock('../../server/nutritionContext.js', () => ({
  interpretRecipeContextOnServer: async (rawBody: unknown) => {
    counters.transport += 1;
    transportEntries.push('interpretRecipeContextOnServer');
    ai4.entered += 1;
    const requestId = (rawBody as { request_id?: unknown })?.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return { ok: false, code: 'invalid_request', aiAttempted: false, aiFailed: false };
    }
    ai4.providerCalls += 1;
    const derived = deriveRecipeContextModelInput({
      recipe: {
        title: 'Entitlement probe',
        servings: 2,
        ingredients: [
          { original: '400 g chicken', name: 'chicken' },
          { original: '2 tbsp parsley, for garnish', name: 'parsley, for garnish' },
        ],
      },
      instructions: [{ text: 'Garnish with parsley' }],
      requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      requestId,
      recipeInstance: 'instance-ai5b',
    });
    if (!derived.ok) throw new Error('stub derivation failed');
    const targets = derived.request.provider_request.targets;
    return {
      ok: true,
      requestId,
      wire: {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: requestId,
        context_binding: derived.request.model_input_binding,
        proposal: {
          contract_version: 'nutrition_ai_recipe_context_v1',
          provenance_class: 'ai_recipe_context',
          interpretations: targets.map((target: { line_ref: string }) => ({
            line_ref: target.line_ref,
            role: 'garnish',
            relations: [],
            preparation_hints: ['garnish'],
            confidence: 'low',
          })),
        },
      },
    };
  },
}));

/** Provider availability, so readiness can be varied independently of entitlement. */
const geminiControl = vi.hoisted(() => ({ available: true }));

/** The Gemini transport, counted. Returns a contract-valid AI-1 payload. */
vi.mock('../../server/geminiClient.js', () => ({
  getGemini: () => {
    if (!geminiControl.available) return null;
    return {
    models: {
      generateContent: async () => {
        counters.geminiGenerate += 1;
        return {
          text: JSON.stringify({
            contract_version: AI_ADVANCED_CONTRACT_VERSION,
            interpretations: [
              {
                contract_version: AI_ADVANCED_CONTRACT_VERSION,
                line_ref: 'line:1',
                semantic_food: {
                  normalized_name: 'yellow onion',
                  modifiers: ['yellow'],
                  preparation: [],
                  state: [],
                  qualifiers: [],
                },
                search_phrases: ['yellow onion'],
                amount_semantics: { kind: 'exact', echoed_value: 2 },
                unit_semantics: { family: 'count', interpreted_unit: 'onion' },
                count_semantics: { noun: 'onion', size: 'medium' },
                alternatives: [],
                ambiguity: { ambiguous: false, reasons: [] },
                confidence: 'high',
              },
            ],
          }),
        };
      },
      list: async () => ({}),
    },
    };
  },
  getGeminiImage: () => null,
  createGeminiClientWithKey: () => null,
}));

/** Credential resolution is counted so a BYOK lease on the denial path is visible. */
vi.mock('../../server/ai/credentialResolver.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../server/ai/credentialResolver.js',
  );
  return {
    ...actual,
    resolveCredential: (...args: unknown[]) => {
      counters.credentialResolve += 1;
      return (actual['resolveCredential'] as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// REQUEST SHAPES. Each is valid enough to be ADMITTED and reach the AI pipeline, so
// a Basic refusal is caused by entitlement alone and never by input validation.
// ---------------------------------------------------------------------------

const INGREDIENTS = ['2 medium yellow onions, thinly sliced'];
const ROWS = [{ line_ref: 'line:1', ingredient_text: INGREDIENTS[0] }];

const PLAN_REQUEST = {
  request_version: 'nutrition_ai_advanced_plan_request_v1',
  rows: [
    {
      row_ref: 'row:1',
      candidates: [
        {
          candidate_ref: 'c1',
          display_description: 'Tomato products, canned, sauce',
          semantic_tags: ['tomato', 'canned'],
        },
      ],
    },
  ],
};

const AUTHORED_RECIPE = {
  title: 'Entitlement probe',
  servings: 2,
  ingredients: [
    { original: '400 g chicken', name: 'chicken' },
    { original: '2 tbsp parsley, for garnish', name: 'parsley, for garnish' },
  ],
};
const INSTRUCTIONS = [{ text: 'Garnish with parsley' }];

/** Route path -> the four AI-5A product features it is gated by. */
const GATED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['/api/nutrition/resolve-ingredients', 'ai_interpretation'],
  ['/api/nutrition/interpret-ingredients', 'ai_interpretation'],
  ['/api/nutrition/plan-ingredients', 'ai_candidate_orchestration'],
  ['/api/nutrition/estimate-mass', 'ai_bounded_mass_estimation'],
  ['/api/nutrition/recipe-context', 'ai_recipe_context_review'],
  ['/api/nutrition/recipe-context/reconcile', 'ai_recipe_context_review'],
];

function requestBody(path: string, overrides: Record<string, unknown> = {}): unknown {
  switch (path) {
    case '/api/nutrition/resolve-ingredients':
      return { ingredients: INGREDIENTS, ...overrides };
    case '/api/nutrition/interpret-ingredients':
      // AI-1 takes the bounded row objects directly as `ingredients`.
      return { ingredients: ROWS, ...overrides };
    case '/api/nutrition/plan-ingredients':
      return {
        request_version: 'nutrition_ai_advanced_plan_request_v1',
        request_id: 'ai5b-plan',
        plan_request: PLAN_REQUEST,
        planning_targets: [{ line_ref: 'tomato sauce', source_text: '1 cup tomato sauce' }],
        ...overrides,
      };
    case '/api/nutrition/estimate-mass':
      return {
        request_version: 'nutrition_ai_advanced_mass_request_v1',
        request_id: 'ai5b-mass',
        lines: [{ line_ref: 'line:1', source_text: '2 medium onions' }],
        ...overrides,
      };
    case '/api/nutrition/recipe-context':
      return {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: 'ai5b-context',
        recipe_instance: 'instance-ai5b',
        recipe: AUTHORED_RECIPE,
        instructions: INSTRUCTIONS,
        ...overrides,
      };
    default:
      // The reconcile route needs a receipt; a request WITHOUT one is still the
      // strongest probe, because the gate must fire before the receipt is examined.
      return { expected_request_id: 'ai5b-context', ...overrides };
  }
}

async function startApp(
  nutritionProductTier?: unknown,
  env: Record<string, string> = {},
): Promise<{ server: http.Server; baseUrl: string }> {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NUTRITION_RESOLVE_RATE_LIMIT = '1000';
  process.env.NUTRITION_INTERPRET_RATE_LIMIT = '1000';
  process.env.NUTRITION_PLAN_RATE_LIMIT = '1000';
  process.env.NUTRITION_ESTIMATE_RATE_LIMIT = '1000';
  process.env.NUTRITION_CONTEXT_RATE_LIMIT = '1000';
  process.env.NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT = '1000';
  Object.assign(process.env, env);
  resetRateLimitersForTests();
  const { createApp } = await import('../../server/app.js');
  const app = createApp({
    isProduction: false,
    // `undefined` here is meaningful: it is the PRODUCTION default and must be Basic.
    ...(nutritionProductTier === undefined ? {} : { nutritionProductTier }),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

function expectEntitlementDenial(response: { status: number; json: Record<string, unknown> }) {
  expect(response.status).toBe(403);
  expect(response.json).toEqual({
    ok: false,
    code: 'NUTRITION_AI_NOT_ENTITLED',
    error: 'AI Advanced Nutrition is not available for this product access.',
    aiAttempted: false,
  });
}

/** Every counter that must be untouched by a Basic refusal. */
function expectZeroProviderWork() {
  expect({
    transport: counters.transport,
    geminiGenerate: counters.geminiGenerate,
    credentialResolve: counters.credentialResolve,
    providerHttp: counters.providerHttp,
    ai4ProviderCalls: ai4.providerCalls,
  }).toEqual({
    transport: 0,
    geminiGenerate: 0,
    credentialResolve: 0,
    providerHttp: 0,
    ai4ProviderCalls: 0,
  });
}

const originalFetch = globalThis.fetch;

beforeAll(() => {
  // Count only OUTBOUND provider traffic; the suite's own localhost calls pass through.
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string })?.url ?? '');
    if (typeof url === 'string' && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
      counters.providerHttp += 1;
    }
    return originalFetch(input as never, init as never);
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  counters.transport = 0;
  counters.geminiGenerate = 0;
  counters.credentialResolve = 0;
  counters.providerHttp = 0;
  ai4.entered = 0;
  ai4.providerCalls = 0;
  transportEntries.length = 0;
  geminiControl.available = true;
});

/** Clears the counters so a later step in a test is measured on its own. */
function resetCounters() {
  counters.transport = 0;
  counters.geminiGenerate = 0;
  counters.credentialResolve = 0;
  counters.providerHttp = 0;
  ai4.entered = 0;
  ai4.providerCalls = 0;
  transportEntries.length = 0;
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

// ---------------------------------------------------------------------------

describe('AI-5B — route matrix under the FAIL-CLOSED Basic default', () => {
  it('refuses all six paid AI Advanced Nutrition routes when product access is ABSENT', async () => {
    // No `nutritionProductTier` at all: the exact production default.
    const { server, baseUrl } = await startApp(undefined);
    try {
      for (const [path] of GATED_ROUTES) {
        const response = await post(baseUrl, path, requestBody(path));
        expectEntitlementDenial(response);
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refuses all six when product access is exactly "basic"', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      for (const [path] of GATED_ROUTES) {
        expectEntitlementDenial(await post(baseUrl, path, requestBody(path)));
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it.each(GATED_ROUTES)('refuses %s even with a fully READY provider (zero provider calls)', async (path) => {
    // The load-bearing case: entitlement, NOT readiness, is what denies. A configured,
    // reachable provider and a real key are present, so only the product decision can
    // be responsible for the refusal.
    const { server, baseUrl } = await startApp('basic', {
      GEMINI_API_KEY: 'configured-but-never-used',
      OPENROUTER_API_KEY: 'configured-but-never-used',
    });
    try {
      expectEntitlementDenial(await post(baseUrl, path, requestBody(path)));
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it.each(GATED_ROUTES)('refuses %s even for an INVALID body (entitlement precedes validation)', async (path) => {
    const { server, baseUrl } = await startApp('basic');
    try {
      expectEntitlementDenial(await post(baseUrl, path, { not_a_valid_request: true }));
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it.each(GATED_ROUTES.map(([path]) => path))('resolves %s to Basic for a malformed server tier', async (path) => {
    for (const malformed of ['AI_ADVANCED', ' ai_advanced', 'ai-advanced', 'pro', 'paid', 'true', '1', '']) {
      const { server, baseUrl } = await startApp(malformed);
      try {
        expectEntitlementDenial(await post(baseUrl, path, requestBody(path)));
        expectZeroProviderWork();
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
  });
});

describe('AI-5B — client input has ZERO authority', () => {
  it('ignores every entitlement-like body field', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      const forgeries = [
        { tier: 'ai_advanced' },
        { productTier: 'ai_advanced' },
        { nutritionProductTier: 'ai_advanced' },
        { entitled: true },
        { productAccess: { tier: 'ai_advanced' } },
        { access: { tier: 'ai_advanced', aiInterpretation: true } },
        { version: 'nutrition_product_access_v1', tier: 'ai_advanced' },
      ];
      for (const forgery of forgeries) {
        for (const [path] of GATED_ROUTES) {
          const response = await post(baseUrl, path, requestBody(path, forgery));
          expectEntitlementDenial(response);
        }
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('ignores every entitlement-like, selection or provider header', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      const headerSets: ReadonlyArray<Record<string, string>> = [
        { 'x-kitchen-nutrition-tier': 'ai_advanced' },
        { 'x-product-tier': 'ai_advanced' },
        { 'x-entitlement': 'ai_advanced' },
        { 'x-nutrition-product-access': 'ai_advanced' },
        { 'x-tier': 'ai_advanced' },
        { 'x-kitchen-ai-text-selection': JSON.stringify({ mode: 'user_selected', providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }) },
        { 'x-kitchen-ai-image-selection': JSON.stringify({ mode: 'user_selected', providerId: 'openrouter-image' }) },
        { 'x-api-key': 'ai_advanced' },
        { 'x-forwarded-for': '127.0.0.1' },
      ];
      for (const headers of headerSets) {
        for (const [path] of GATED_ROUTES) {
          expectEntitlementDenial(await post(baseUrl, path, requestBody(path), headers));
        }
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('ignores a query-string entitlement attempt', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      const response = await fetch(
        `${baseUrl}/api/nutrition/interpret-ingredients?tier=ai_advanced&entitled=true`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody('/api/nutrition/interpret-ingredients')),
        },
      );
      expect(response.status).toBe(403);
      expect((await response.json())['code']).toBe('NUTRITION_AI_NOT_ENTITLED');
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('ignores a cookie-carried entitlement attempt', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      expectEntitlementDenial(
        await post(baseUrl, '/api/nutrition/interpret-ingredients', requestBody('/api/nutrition/interpret-ingredients'), {
          cookie: 'tier=ai_advanced; product_tier=ai_advanced',
        }),
      );
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('is NOT unlocked by a configured provider or a server-environment credential', async () => {
    const { server, baseUrl } = await startApp('basic', {
      GEMINI_API_KEY: 'server-environment-credential',
      KITCHEN_CODEX_TEXT_PROVIDER: 'gemini',
      KITCHEN_CODEX_TEXT_MODEL: 'gemini-3.7-flash',
    });
    try {
      for (const [path] of GATED_ROUTES) {
        expectEntitlementDenial(await post(baseUrl, path, requestBody(path)));
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('exposes NO OTHER product-state surface beyond the AI-5C read-only status route', async () => {
    // AI-5B deliberately had none; AI-5C (authorized separately) adds exactly ONE
    // read-only informational route. No alternate, differently-named, or
    // authorization-flavoured product-state surface may appear, and the one route
    // that does exist must not authorize anything.
    const { server, baseUrl } = await startApp('ai_advanced');
    try {
      for (const path of [
        '/api/nutrition/entitlement',
        '/api/nutrition/product-tier',
        '/api/nutrition/access',
        '/api/nutrition/product-access/status',
        '/api/nutrition/entitlements',
      ]) {
        const response = await fetch(`${baseUrl}${path}`, { method: 'GET' });
        expect(response.status).toBe(404);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('the AI-5C status route is informational only and never authorizes', async () => {
    // Awareness, never authority: reporting AI Advanced must not unlock anything, and
    // a Basic deployment must still be denied on every gated route afterwards.
    const advanced = await startApp('ai_advanced');
    try {
      const status = await fetch(`${advanced.baseUrl}/api/nutrition/product-access`, {
        method: 'GET',
        headers: { authorization: 'Bearer ai5b-secret-token' },
      });
      expect(status.status).toBe(200);
      const json = (await status.json()) as Record<string, unknown>;
      expect(json.tier).toBe('ai_advanced');
      // It mints nothing reusable.
      expect(Object.keys(json).sort()).toEqual(['ok', 'tier', 'version']);
    } finally {
      await new Promise<void>((r) => advanced.server.close(() => r()));
    }

    const basic = await startApp('basic', { AI_ENDPOINT_TOKEN: 'ai5b-secret-token' });
    try {
      const status = await fetch(`${basic.baseUrl}/api/nutrition/product-access`, {
        method: 'GET',
        headers: { authorization: 'Bearer ai5b-secret-token' },
      });
      expect(((await status.json()) as Record<string, unknown>).tier).toBe('basic');
      // Reading the status changed nothing about the gate.
      for (const [path] of GATED_ROUTES) {
        expectEntitlementDenial(
          await post(basic.baseUrl, path, requestBody(path), {
            authorization: 'Bearer ai5b-secret-token',
          }),
        );
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => basic.server.close(() => r()));
    }
  });
});

describe('AI-5B — authentication order', () => {
  it('fails at endpoint auth FIRST, so an unauthenticated probe learns nothing', async () => {
    const { server, baseUrl } = await startApp('basic', { AI_ENDPOINT_TOKEN: 'ai5b-secret-token' });
    try {
      for (const [path] of GATED_ROUTES) {
        const response = await post(baseUrl, path, requestBody(path));
        // 401 at the EXISTING auth boundary — never the entitlement code.
        expect(response.status).toBe(401);
        expect(response.json['code']).toBe('UNAUTHORIZED');
        expect(response.json['code']).not.toBe('NUTRITION_AI_NOT_ENTITLED');
        expect(JSON.stringify(response.json)).not.toContain('AI Advanced Nutrition');
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('reveals the denial only once the caller is authenticated', async () => {
    const { server, baseUrl } = await startApp('basic', { AI_ENDPOINT_TOKEN: 'ai5b-secret-token' });
    try {
      const response = await post(baseUrl, '/api/nutrition/interpret-ingredients', requestBody('/api/nutrition/interpret-ingredients'), {
        authorization: 'Bearer ai5b-secret-token',
      });
      expectEntitlementDenial(response);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('AI-5B — middleware order is structural, not incidental', () => {
  /** The middleware list of a single `app.post("<path>", ...)` registration. */
  function registrationOf(path: string): string {
    const index = APP_SOURCE.indexOf(`"${path}"`);
    expect(index, `route ${path} must be registered`).toBeGreaterThan(-1);
    const rest = APP_SOURCE.slice(index);
    // The registration's middleware list ends exactly where the handler begins.
    const handlerAt = rest.search(/\basync\s*\(/);
    expect(handlerAt, `${path} must have a route handler`).toBeGreaterThan(-1);
    return rest.slice(0, handlerAt);
  }

  it.each(GATED_ROUTES)('%s is gated by its closed AI-5A feature', (path, feature) => {
    expect(registrationOf(path)).toContain(`requireNutritionProductFeature(nutritionProductAccess, "${feature}")`);
  });

  it.each(GATED_ROUTES)('%s order: auth -> entitlement -> pricing -> limiter -> handler', (path) => {
    const chain = registrationOf(path);
    const at = (needle: string) => {
      const index = chain.indexOf(needle);
      expect(index, `${needle} must be registered on ${path}`).toBeGreaterThan(-1);
      return index;
    };
    expect(at('requireAiAccessToken')).toBeLessThan(at('requireNutritionProductFeature'));
    expect(at('requireNutritionProductFeature')).toBeLessThan(at('RateLimiter'));
    // The reconcile route legitimately has no pricing guard (no model, no spend).
    if (path !== '/api/nutrition/recipe-context/reconcile') {
      expect(at('requireNutritionProductFeature')).toBeLessThan(at('textPricingGuard'));
      expect(at('textPricingGuard')).toBeLessThan(at('RateLimiter'));
    }
  });

  it('gates exactly the four AI-5A features and nothing else', () => {
    const gateCalls = [...APP_SOURCE.matchAll(/requireNutritionProductFeature\([^)]*\)/g)].map((m) => m[0]);
    expect(gateCalls).toHaveLength(6);
    const features = new Set(gateCalls.map((call) => /"([a-z_]+)"\)$/.exec(call)![1]));
    expect([...features].sort()).toEqual([
      'ai_bounded_mass_estimation',
      'ai_candidate_orchestration',
      'ai_interpretation',
      'ai_recipe_context_review',
    ]);
  });

  it('does not add an entitlement gate to any unrelated route', () => {
    // Basic/deterministic nutrition, the legacy AI estimator, provider surfaces,
    // BYOK session-key storage and recipe AI stay ungated.
    for (const unrelated of [
      '/api/estimate-nutrition',
      '/api/grab-recipe',
      '/api/recover-metadata',
      '/api/kitchen/interpret',
      '/api/kitchen/rank',
      '/api/kitchen/discover',
      '/api/providers',
      '/api/providers/catalog',
      '/api/providers/test-connection',
      '/api/recipes/generate',
      '/api/recipes/image/generate',
    ]) {
      expect(registrationOf(unrelated)).not.toContain('requireNutritionProductFeature');
    }
  });
});

describe('AI-5B — a Basic denial does not consume the paid rate-limit bucket', () => {
  it('exhausts no limiter: many Basic refusals, then the entitled path is unaffected', async () => {
    const { server, baseUrl } = await startApp('basic', {
      NUTRITION_INTERPRET_RATE_LIMIT: '2',
    });
    try {
      for (let i = 0; i < 6; i += 1) {
        expectEntitlementDenial(
          await post(baseUrl, '/api/nutrition/interpret-ingredients', requestBody('/api/nutrition/interpret-ingredients')),
        );
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('AI-5B — the ADVANCED POSITIVE PATH is unchanged', () => {
  it('admits every gated route and reaches the existing pipeline on the exact string ai_advanced', async () => {
    const { server, baseUrl } = await startApp('ai_advanced');
    try {
      for (const [path] of GATED_ROUTES) {
        const response = await post(baseUrl, path, requestBody(path));
        // The gate admitted it: never the entitlement denial.
        expect(response.status, `${path} must not be refused by AI-5B`).not.toBe(403);
        expect(response.json['code']).not.toBe('NUTRITION_AI_NOT_ENTITLED');
      }
      // All FIVE provider/derivation transports were actually entered. The reconcile
      // transport is deliberately absent here: this probe carries no origin receipt, so
      // the route legitimately stops at AI-4E receipt verification BEFORE D1. That
      // reaching `origin_unverified` is itself proof the entitlement gate ran first.
      expect(transportEntries.sort()).toEqual([
        'estimateMassOnServer',
        'interpretIngredientsOnServer',
        'interpretRecipeContextOnServer',
        'planIngredientsOnServer',
        'resolveIngredientFoodsOnServer',
      ]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('reaches the REAL AI pipeline end to end for AI-1 (existing success path intact)', async () => {
    const { server, baseUrl } = await startApp('ai_advanced');
    try {
      const response = await post(
        baseUrl,
        '/api/nutrition/interpret-ingredients',
        requestBody('/api/nutrition/interpret-ingredients'),
      );
      expect(response.status).toBe(200);
      expect(response.json['ok']).toBe(true);
      expect(response.json['contract_version']).toBe(AI_ADVANCED_CONTRACT_VERSION);
      expect(response.json['aiAttempted']).toBe(true);
      expect(Array.isArray(response.json['interpretations'])).toBe(true);
      // A genuine provider call happened: entitlement permitted the ATTEMPT.
      expect(counters.geminiGenerate).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('entitlement is NOT sufficient for success: an unavailable provider still fails operationally', async () => {
    // AI Advanced + NO provider at all. The product gate passes and the EXISTING
    // operational layer produces its own bounded unavailable behavior — a DIFFERENT
    // failure class from the entitlement denial.
    geminiControl.available = false;
    const { server, baseUrl } = await startApp('ai_advanced');
    try {
      const response = await post(
        baseUrl,
        '/api/nutrition/interpret-ingredients',
        requestBody('/api/nutrition/interpret-ingredients'),
      );
      expect(response.status).not.toBe(403);
      expect(response.json['code']).not.toBe('NUTRITION_AI_NOT_ENTITLED');
      // Existing bounded degraded-service behavior, unchanged by AI-5B.
      expect(response.status).toBe(503);
      expect(response.json['ok']).toBe(false);
      expect(response.json['aiAttempted']).toBe(false);
      expect(String(response.json['error'])).toContain('AI assistance is unavailable');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('AI-5B — reconcile needs CURRENT entitlement AND a genuine receipt', () => {
  const RECONCILE = '/api/nutrition/recipe-context/reconcile';

  /** Drives the real AI-4C route and returns its success body (carrying a receipt). */
  async function genuineInterpretation(baseUrl: string) {
    return post(baseUrl, '/api/nutrition/recipe-context', requestBody('/api/nutrition/recipe-context'));
  }

  function legitimateReconcileBody(interpretation: Record<string, unknown>): Record<string, unknown> {
    return {
      expected_request_id: interpretation['request_id'],
      recipe_instance: 'instance-ai5b',
      recipe: AUTHORED_RECIPE,
      instructions: INSTRUCTIONS,
      wire: {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: interpretation['request_id'],
        context_binding: interpretation['context_binding'],
        proposal: interpretation['proposal'],
      },
      origin_receipt: interpretation['origin_receipt'],
    };
  }

  it('a receipt from an earlier ENTITLED request is not a bypass once product access is absent', async () => {
    // Step 1: obtain a genuine receipt under AI Advanced.
    const entitled = await startApp('ai_advanced');
    let reconcileBody: Record<string, unknown>;
    try {
      const interpretation = await genuineInterpretation(entitled.baseUrl);
      expect(interpretation.status).toBe(200);
      expect(typeof interpretation.json['origin_receipt']).toBe('string');
      reconcileBody = legitimateReconcileBody(interpretation.json);
    } finally {
      await new Promise<void>((r) => entitled.server.close(() => r()));
    }

    // Step 2: the SAME body, including the GENUINE receipt, under Basic. The counters
    // are reset so the refusal is measured on its own.
    resetCounters();
    const basic = await startApp('basic');
    try {
      const response = await post(basic.baseUrl, RECONCILE, reconcileBody);
      expectEntitlementDenial(response);
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => basic.server.close(() => r()));
    }
  });

  it('still reconciles successfully under AI Advanced with a genuine receipt', async () => {
    const { server, baseUrl } = await startApp('ai_advanced');
    try {
      const interpretation = await genuineInterpretation(baseUrl);
      expect(interpretation.status).toBe(200);
      resetCounters();
      const response = await post(baseUrl, RECONCILE, legitimateReconcileBody(interpretation.json));
      expect(response.status).toBe(200);
      expect(response.json['ok']).toBe(true);
      // Reconciliation is pure deterministic code: entitlement permits it and it
      // performs no provider work at all.
      expect(ai4.providerCalls).toBe(0);
      expect(counters.geminiGenerate).toBe(0);
      expect(transportEntries).toContain('reconcileRecipeContextOnServer');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a genuine receipt is NOT honoured under Basic even with no further provider work', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      const forgedReceipts = [
        'rctx1.' + 'z'.repeat(43),
        'not-a-receipt',
      ];
      for (const origin_receipt of forgedReceipts) {
        expectEntitlementDenial(
          await post(baseUrl, RECONCILE, requestBody(RECONCILE, { origin_receipt })),
        );
      }
      expectZeroProviderWork();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('entitlement does NOT make a forged receipt valid (I-1 stays closed)', async () => {
    const { server, baseUrl } = await startApp('ai_advanced');
    try {
      for (const origin_receipt of [
        undefined,
        'rctx1.' + 'z'.repeat(43),
        'rctx1.' + '0'.repeat(43),
        '',
        'not-a-receipt',
      ]) {
        const response = await post(
          baseUrl,
          RECONCILE,
          requestBody(RECONCILE, {
            expected_request_id: 'ai5b-context',
            recipe_instance: 'instance-ai5b',
            recipe: AUTHORED_RECIPE,
            instructions: INSTRUCTIONS,
            wire: {
              request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
              request_id: 'ai5b-context',
              context_binding: 'sha256:' + 'a'.repeat(64),
              proposal: {
                contract_version: 'nutrition_ai_recipe_context_v1',
                provenance_class: 'ai_recipe_context',
                interpretations: [],
              },
            },
            ...(origin_receipt === undefined ? {} : { origin_receipt }),
          }),
        );
        // Entitled, yet the forged/absent receipt is still refused: origin
        // authentication is an INDEPENDENT gate.
        expect(response.status).toBe(400);
        expect(response.status).not.toBe(403);
        expect(response.json['ok']).toBe(false);
        // And no reconciliation transport is ever reached with an unverified receipt.
        expect(transportEntries).not.toContain('reconcileRecipeContextOnServer');
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('verifies the receipt BEFORE D1 reconciliation, and entitlement before both', () => {
    const gateAt = APP_SOURCE.indexOf('requireNutritionProductFeature(nutritionProductAccess, "ai_recipe_context_review"),\n    nutritionContextReconcileRateLimiter');
    const originAt = APP_SOURCE.indexOf('readRecipeContextOriginEnvelope(req.body, recipeContextOriginReceipts)');
    const reconcileAt = APP_SOURCE.indexOf('reconcileRecipeContextOnServer(envelope.body)');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(originAt);
    expect(originAt).toBeLessThan(reconcileAt);
    // The adapter is still never handed the raw body.
    expect(APP_SOURCE).not.toContain('reconcileRecipeContextOnServer(req.body)');
  });
});