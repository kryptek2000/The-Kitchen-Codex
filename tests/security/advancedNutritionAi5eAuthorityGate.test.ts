/**
 * AI-5E — SERVER PRODUCT-ACCESS AUTHORITY ABSTRACTION (HTTP authority gate).
 *
 * Boots the REAL Express app through the REAL authority seam to prove:
 *
 *   1. AUTH-FIRST: `requireAiAccessToken` runs before any authority invocation, so an
 *      unauthenticated caller gets 401 with the authority called ZERO times;
 *   2. EXACTLY-ONCE: one authority invocation per status request and per gated POST;
 *   3. STATUS SUCCESS: exactly `{ ok, version, tier }`, `Cache-Control: no-store`, and
 *      NO source disclosure of any kind;
 *   4. STATUS UNAVAILABLE: a bounded 503 with NO `tier` and NO `version`, still no-store;
 *   5. THE SIX GATES: Basic -> 403, unavailable -> 503, Advanced -> admitted to the
 *      route's EXISTING downstream semantics;
 *   6. ZERO PROVIDER WORK on every refusal, and no downstream paid-route limiter
 *      budget consumed by a refusal;
 *   7. RECONCILE ORDER: product access is decided BEFORE AI-4E receipt verification and
 *      before D1 currentness, so an unauthorized caller gets no receipt oracle;
 *   8. FORGED CLIENT INPUT has zero authority and cannot SELECT an authority;
 *   9. DEFAULT `createApp()` is canonical Basic, and one deployment authority governs
 *      the status route and all six gates identically.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'net';

import { resetRateLimitersForTests } from '../../server/rateLimiter.js';
import {
  NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
  NUTRITION_PRODUCT_ACCESS_STATUS_KEYS,
  NUTRITION_AI_NOT_ENTITLED_CODE,
  NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE,
} from '../../server/nutritionProductAccess.js';
import {
  createDeploymentNutritionProductAccessAuthority,
  type NutritionProductAccessAuthority,
  type NutritionProductAccessAuthorityDecision,
} from '../../server/nutritionProductAccessAuthority.js';
import { NUTRITION_PRODUCT_ACCESS_VERSION } from '../../src/core/nutritionV2/nutritionProductAccess.js';
import { BASIC_NUTRITION_PRODUCT_ACCESS } from '../../src/core/nutritionV2/nutritionProductAccess.js';

const REPO = join(__dirname, '..', '..');
const APP_SOURCE = readFileSync(join(REPO, 'server', 'app.ts'), 'utf8');
const SERVER_SOURCE = readFileSync(join(REPO, 'server.ts'), 'utf8');

const AI_ENDPOINT_TOKEN = 'ai5e-secret-token';
const AUTH = { authorization: `Bearer ${AI_ENDPOINT_TOKEN}` };

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

// ---------------------------------------------------------------------------
// COUNTERS: every way a refusal could consume work it must not.
// ---------------------------------------------------------------------------

const counters = vi.hoisted(() => ({
  /** Credential resolutions (server environment or a session-only BYOK lease). */
  credentialResolve: 0,
  /** Outbound HTTP to any non-localhost host: a provider, a license server, billing. */
  outboundHttp: 0,
  /** Route-bound AI transports reached. */
  transport: 0,
}));

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

/**
 * No provider is available, so the ADMITTED path fails fast at the existing
 * OPERATIONAL-readiness boundary. That is exactly what this suite wants: an admitted
 * request must reach its own downstream semantics, and an operationally unavailable
 * provider is NOT a product-access failure.
 */
vi.mock('../../server/geminiClient.js', () => ({
  getGemini: () => null,
  getGeminiImage: () => null,
  createGeminiClientWithKey: () => null,
}));

vi.mock('../../server/nutritionResolve.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/nutritionResolve.js');
  return {
    ...actual,
    resolveIngredientFoodsOnServer: (...args: unknown[]) => {
      counters.transport += 1;
      return (actual['resolveIngredientFoodsOnServer'] as (...a: unknown[]) => unknown)(...args);
    },
  };
});

vi.mock('../../server/nutritionInterpret.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../server/nutritionInterpret.js',
  );
  return {
    ...actual,
    interpretIngredientsOnServer: (...args: unknown[]) => {
      counters.transport += 1;
      return (actual['interpretIngredientsOnServer'] as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// REQUEST SHAPES: valid enough to be ADMITTED, so a refusal is caused by product
// access alone and never by input validation.
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
  title: 'Authority probe',
  servings: 2,
  ingredients: [
    { original: '400 g chicken', name: 'chicken' },
    { original: '2 tbsp parsley, for garnish', name: 'parsley, for garnish' },
  ],
};
const INSTRUCTIONS = [{ text: 'Garnish with parsley' }];

/** The EXACT six AI-5B gates and nothing else. */
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
      return { ingredients: ROWS, ...overrides };
    case '/api/nutrition/plan-ingredients':
      return {
        request_version: 'nutrition_ai_advanced_plan_request_v1',
        request_id: 'ai5e-plan',
        plan_request: PLAN_REQUEST,
        planning_targets: [{ line_ref: 'tomato sauce', source_text: '1 cup tomato sauce' }],
        ...overrides,
      };
    case '/api/nutrition/estimate-mass':
      return {
        request_version: 'nutrition_ai_advanced_estimate_mass_request_v1',
        request_id: 'ai5e-mass',
        rows: [
          {
            row_ref: 'row:1',
            candidates: [
              {
                candidate_ref: 'c1',
                display_description: 'Chicken, broilers or fryers, breast, boneless',
                semantic_tags: ['chicken', 'breast'],
              },
            ],
            measurement_basis: { kind: 'direct_input', line_ref: 'row:1', mass_g: 400 },
          },
        ],
        ...overrides,
      };
    case '/api/nutrition/recipe-context':
      return {
        request_version: 'nutrition_ai_advanced_recipe_context_request_v1',
        request_id: 'ai5e-context',
        recipe: AUTHORED_RECIPE,
        instructions: INSTRUCTIONS,
        ...overrides,
      };
    default:
      // The reconcile route needs a receipt. This probe is shaped so that it gets ALL
      // the way to ORIGIN VERIFICATION and is refused there, which is the strongest
      // possible probe: a request whose ONLY remaining failure is the receipt. If
      // product access were decided later, the answer would be `origin_unverified`.
      return {
        wire: { request_version: 'nutrition_ai_recipe_context_v1', request_id: 'ai5e-context' },
        expected_request_id: 'ai5e-context',
        recipe: AUTHORED_RECIPE,
        origin_receipt: 'forged-receipt-the-server-never-issued',
        ...overrides,
      };
  }
}

// ---------------------------------------------------------------------------
// AUTHORITIES
//
// An authority is described by a SPEC, not by a pre-built object, because the app is
// re-imported after `vi.resetModules()` and AI-5A's canonical identity check is
// load-bearing: an access value minted by a different module-graph copy is not the
// canonical instance, and would (correctly) resolve as `unavailable`. Every authority
// here is therefore constructed inside the same module cycle as the app it serves.
// ---------------------------------------------------------------------------

type BrokenBehaviour = 'throw' | 'reject' | 'null' | 'hand-authored' | 'unknown-status';

type AuthoritySpec =
  /** No authority supplied at all: the exact production default. */
  | { readonly kind: 'default'; readonly count?: boolean }
  /** The REAL deployment authority, optionally invocation-counted. */
  | { readonly kind: 'deployment'; readonly tier?: unknown; readonly count?: boolean }
  /** A narrow, deliberately broken test authority, optionally counted. */
  | { readonly kind: 'broken'; readonly behaviour: BrokenBehaviour; readonly count?: boolean };

const HAND_AUTHORED_ADVANCED = {
  version: NUTRITION_PRODUCT_ACCESS_VERSION,
  tier: 'ai_advanced',
  aiInterpretation: true,
  aiCandidateOrchestration: true,
  aiBoundedMassEstimation: true,
  aiRecipeContextReview: true,
};

/** Wraps an authority so its invocation count is observable. */
function counted(
  inner: NutritionProductAccessAuthority,
): { authority: NutritionProductAccessAuthority; state: { calls: number } } {
  const state = { calls: 0 };
  return {
    state,
    authority: {
      resolve: (request) => {
        state.calls += 1;
        return inner.resolve(request);
      },
    },
  };
}

/** An authority that always fails in the named way. */
function broken(behaviour: BrokenBehaviour): NutritionProductAccessAuthority {
  return {
    resolve: async () => {
      switch (behaviour) {
        case 'throw':
          throw new Error('authority exploded: /etc/secret/path detail');
        case 'reject':
          return Promise.reject(new Error('remote entitlement unavailable'));
        case 'null':
          return null as unknown as NutritionProductAccessAuthorityDecision;
        case 'hand-authored':
          return {
            status: 'resolved',
            access: HAND_AUTHORED_ADVANCED,
          } as unknown as NutritionProductAccessAuthorityDecision;
        default:
          return { status: 'granted' } as unknown as NutritionProductAccessAuthorityDecision;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------

interface Running {
  readonly server: http.Server;
  readonly baseUrl: string;
  /** Authority invocations observed, when the spec asked to be counted. */
  readonly authorityCalls: () => number;
}

async function startApp(spec: AuthoritySpec = { kind: 'default' }, env: Record<string, string> = {}): Promise<Running> {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  process.env.NUTRITION_RESOLVE_RATE_LIMIT = '1000';
  process.env.NUTRITION_INTERPRET_RATE_LIMIT = '1000';
  process.env.NUTRITION_PLAN_RATE_LIMIT = '1000';
  process.env.NUTRITION_ESTIMATE_RATE_LIMIT = '1000';
  process.env.NUTRITION_CONTEXT_RATE_LIMIT = '1000';
  process.env.NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT = '1000';
  Object.assign(process.env, env);
  resetRateLimitersForTests();

  const { createApp } = await import('../../server/app.js');
  const { createDeploymentNutritionProductAccessAuthority } = await import(
    '../../server/nutritionProductAccessAuthority.js'
  );

  let built: NutritionProductAccessAuthority | undefined;
  let calls = 0;
  if (spec.kind === 'deployment') {
    built = createDeploymentNutritionProductAccessAuthority(spec.tier);
  } else if (spec.kind === 'broken') {
    built = broken(spec.behaviour);
  }

  if (built && spec.count) {
    const inner = built;
    built = {
      resolve: (request) => {
        calls += 1;
        return inner.resolve(request);
      },
    };
  }

  const app = createApp({
    isProduction: false,
    ...(built ? { nutritionProductAccessAuthority: built } : {}),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, authorityCalls: () => calls };
}

async function stop({ server }: Running): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

interface HttpResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly raw: string;
  readonly headers: Headers;
}

async function get(baseUrl: string, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json, raw, headers: response.headers };
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json, raw, headers: response.headers };
}

const UNAVAILABLE_BODY = {
  ok: false,
  code: 'NUTRITION_PRODUCT_ACCESS_UNAVAILABLE',
  error: 'AI Advanced Nutrition access could not be verified.',
};

function expectEntitlementDenial(result: HttpResult) {
  expect(result.status).toBe(403);
  expect(result.json).toEqual({
    ok: false,
    code: NUTRITION_AI_NOT_ENTITLED_CODE,
    error: 'AI Advanced Nutrition is not available for this product access.',
    aiAttempted: false,
  });
}

function expectAuthorityUnavailable(result: HttpResult) {
  expect(result.status).toBe(503);
  expect(result.json).toEqual({ ...UNAVAILABLE_BODY, aiAttempted: false });
  expect(result.json['aiAttempted']).toBe(false);
}

function expectZeroWork() {
  expect({
    credentialResolve: counters.credentialResolve,
    outboundHttp: counters.outboundHttp,
    transport: counters.transport,
  }).toEqual({ credentialResolve: 0, outboundHttp: 0, transport: 0 });
}

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string })?.url ?? '');
    if (typeof url === 'string' && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
      counters.outboundHttp += 1;
    }
    return originalFetch(input as never, init as never);
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  counters.credentialResolve = 0;
  counters.outboundHttp = 0;
  counters.transport = 0;
});

// ===========================================================================
// 1. AUTH-FIRST
// ===========================================================================

describe('AI-5E — AUTH runs before the authority, always', () => {
  it('the product status route answers 401 with the authority invoked ZERO times', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'ai_advanced', count: true });
    try {
      const result = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT);
      expect(result.status).toBe(401);
      expect(result.json['code']).toBe('UNAUTHORIZED');
      // No tier, no version, no source, no contract version.
      expect(result.json).not.toHaveProperty('tier');
      expect(result.json).not.toHaveProperty('version');
      expect(result.raw).not.toContain('ai_advanced');
      expect(result.raw).not.toContain(NUTRITION_PRODUCT_ACCESS_VERSION);
      expect(app.authorityCalls()).toBe(0);
      // Even an UNAVAILABLE authority is never consulted for an anonymous caller.
      const brokenApp = await startApp({ kind: 'broken', behaviour: 'throw', count: true });
      try {
        expect((await get(brokenApp.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT)).status).toBe(401);
        expect(brokenApp.authorityCalls()).toBe(0);
      } finally {
        await stop(brokenApp);
      }
    } finally {
      await stop(app);
    }
  });

  it('every gated POST answers 401 with the authority invoked ZERO times', async () => {
    for (const [path] of GATED_ROUTES) {
      const app = await startApp({ kind: 'deployment', tier: 'ai_advanced', count: true });
      try {
        const result = await post(app.baseUrl, path, requestBody(path));
        expect(result.status, `${path} must answer 401 unauthenticated`).toBe(401);
        expect(result.json['code']).toBe('UNAUTHORIZED');
        // The entitlement classes must NOT leak to an unauthenticated caller.
        expect(result.json['code']).not.toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
        expect(result.json['code']).not.toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
        expect(result.raw).not.toContain('AI Advanced Nutrition');
        expect(app.authorityCalls(), `${path} must not invoke the authority unauthenticated`).toBe(0);
      } finally {
        await stop(app);
      }
    }
    expectZeroWork();
  });
});

// ===========================================================================
// 2. EXACTLY ONCE
// ===========================================================================

describe('AI-5E — exactly ONE authority resolution per request', () => {
  it('the status route resolves the authority exactly once', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'ai_advanced', count: true });
    try {
      await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, AUTH);
      expect(app.authorityCalls()).toBe(1);
      await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, AUTH);
      expect(app.authorityCalls()).toBe(2);
    } finally {
      await stop(app);
    }
  });

  it('each gated POST resolves the authority exactly once — never again in the handler', async () => {
    for (const [path] of GATED_ROUTES) {
      const app = await startApp({ kind: 'deployment', tier: 'ai_advanced', count: true });
      try {
        await post(app.baseUrl, path, requestBody(path), AUTH);
        expect(app.authorityCalls(), `${path} must resolve the authority exactly once`).toBe(1);
      } finally {
        await stop(app);
      }
    }
  });
});

// ===========================================================================
// 3./4. THE STATUS ROUTE
// ===========================================================================

describe('AI-5E — the status route under a resolved authority', () => {
  it('reports Basic as exactly { ok, version, tier } and never discloses a source', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'basic' });
    try {
      const result = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, AUTH);
      expect(result.status).toBe(200);
      expect(Object.keys(result.json).sort()).toEqual([...NUTRITION_PRODUCT_ACCESS_STATUS_KEYS].sort());
      expect(result.json).toEqual({
        ok: true,
        version: NUTRITION_PRODUCT_ACCESS_VERSION,
        tier: 'basic',
      });
      expect(result.headers.get('cache-control')).toBe('no-store');
      // No source disclosure of any kind.
      for (const forbidden of [
        'KITCHEN_CODEX_NUTRITION_PRODUCT_TIER',
        'deployment',
        'env',
        'authority',
        'account',
        'plan',
        'billing',
        'stripe',
        'paddle',
        'source',
        'provider',
        'model',
      ]) {
        expect(result.raw.toLowerCase(), `must not disclose ${forbidden}`).not.toContain(forbidden);
      }
    } finally {
      await stop(app);
    }
  });

  it('reports AI Advanced as exactly the same three keys', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'ai_advanced' });
    try {
      const result = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, AUTH);
      expect(result.status).toBe(200);
      expect(Object.keys(result.json).sort()).toEqual(['ok', 'tier', 'version']);
      expect(result.json).toEqual({
        ok: true,
        version: NUTRITION_PRODUCT_ACCESS_VERSION,
        tier: 'ai_advanced',
      });
      expect(result.headers.get('cache-control')).toBe('no-store');
    } finally {
      await stop(app);
    }
  });

  it('an UNAVAILABLE authority is a bounded 503 with NO tier and NO version', async () => {
    for (const behaviour of ['throw', 'reject', 'null', 'hand-authored', 'unknown-status'] as const) {
      const app = await startApp({ kind: 'broken', behaviour, count: true });
      try {
        const result = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, AUTH);
        expect(result.status, behaviour).toBe(503);
        expect(result.json).toEqual(UNAVAILABLE_BODY);
        expect(result.json).not.toHaveProperty('tier');
        expect(result.json).not.toHaveProperty('version');
        expect(result.json).not.toHaveProperty('aiAttempted');
        expect(result.headers.get('cache-control')).toBe('no-store');
        // No raw exception, no authority-source detail, no account/billing detail.
        expect(result.raw).not.toContain('authority exploded');
        expect(result.raw).not.toContain('/etc/secret/path');
        expect(result.raw).not.toContain('remote entitlement unavailable');
        expect(app.authorityCalls()).toBe(1);
        expectZeroWork();
      } finally {
        await stop(app);
      }
    }
  });

  it('a 503 status body composes to the AI-5C reader\'s `unavailable`, never a fake Basic', async () => {
    // The UNCHANGED production client reader is the proof: a non-2xx, a body with no
    // `tier`/`version`, and a transport failure all fail SAFE to `unavailable`.
    const { parseNutritionProductAccessStatus, readNutritionProductAccess } = await import(
      '../../src/application/nutritionProductAccess.js'
    );
    const { composeNutritionAiClientState, resolveNutritionAiClientState } = await import(
      '../../src/application/nutritionAiClientState.js'
    );
    expect(parseNutritionProductAccessStatus(UNAVAILABLE_BODY)).toBeUndefined();

    const network = {
      request: async () => ({ status: 503, ok: false, data: UNAVAILABLE_BODY }),
      get: async () => ({ status: 503, ok: false, data: UNAVAILABLE_BODY }),
      post: async () => ({ status: 503, ok: false, data: UNAVAILABLE_BODY }),
    } as never;

    const read = await readNutritionProductAccess(network);
    expect(read.status).toBe('unavailable');

    // The full production resolution path composes to `product_access_unverified`,
    // never to `product_not_enabled`.
    const state = await resolveNutritionAiClientState(network);
    expect(state.availability).toBe('product_access_unverified');
    expect(state.productAccessStatus.status).toBe('unavailable');
    expect(state.productAccess).toBeNull();
    expect(state.productAccessIsBasic).toBe(false);
    expect(state.productAccessIsAiAdvanced).toBe(false);
    expect(state.available).toBe(false);

    // A transport failure is identical from the client's point of view.
    const thrown = await resolveNutritionAiClientState({
      get: async () => {
        throw new Error('network down');
      },
    } as never);
    expect(thrown.availability).toBe('product_access_unverified');

    // ...and a genuine Basic read is still reported as Basic, not unverified.
    const basicRead = composeNutritionAiClientState({
      productAccess: { status: 'resolved', access: BASIC_NUTRITION_PRODUCT_ACCESS },
      operational: null,
    });
    expect(basicRead.availability).toBe('product_not_enabled');
    expect(basicRead.productAccessIsBasic).toBe(true);
  });
});

// ===========================================================================
// 5. THE SIX GATES
// ===========================================================================

describe('AI-5E — the six gates follow the authority decision', () => {
  it('Basic denies all six with the bounded 403 and ZERO provider work', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'basic' });
    try {
      for (const [path] of GATED_ROUTES) {
        expectEntitlementDenial(await post(app.baseUrl, path, requestBody(path), AUTH));
      }
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it('an UNAVAILABLE authority fails all six closed with the bounded 503', async () => {
    for (const behaviour of ['throw', 'reject', 'null', 'hand-authored', 'unknown-status'] as const) {
      const app = await startApp({ kind: 'broken', behaviour, count: true });
      try {
        for (const [path] of GATED_ROUTES) {
          expectAuthorityUnavailable(await post(app.baseUrl, path, requestBody(path), AUTH));
        }
        expect(app.authorityCalls()).toBe(GATED_ROUTES.length);
        expectZeroWork();
      } finally {
        await stop(app);
      }
    }
  });

  it('an UNAVAILABLE authority is NEVER reported as Basic, and never as Advanced', async () => {
    const app = await startApp({ kind: 'broken', behaviour: 'hand-authored' });
    try {
      for (const [path] of GATED_ROUTES) {
        const result = await post(app.baseUrl, path, requestBody(path), AUTH);
        expect(result.json['code']).toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
        expect(result.json['code']).not.toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
        expect(result.raw).not.toContain('"tier"');
      }
    } finally {
      await stop(app);
    }
  });

  it('AI Advanced passes the product gate on all six to their EXISTING downstream semantics', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'ai_advanced' });
    try {
      for (const [path] of GATED_ROUTES) {
        const result = await post(app.baseUrl, path, requestBody(path), AUTH);
        expect(result.status, `${path} must not be refused by the product gate`).not.toBe(403);
        expect(result.json['code']).not.toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
        expect(result.json['code']).not.toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
      }
    } finally {
      await stop(app);
    }
  });

  it('there is no SEVENTH gate: the historical estimate-nutrition route stays outside', async () => {
    const gateCalls = [...APP_SOURCE.matchAll(/requireNutritionProductFeature\([^)]*\)/g)].map(
      (m) => m[0],
    );
    expect(gateCalls).toHaveLength(6);
    for (const [path, feature] of GATED_ROUTES) {
      expect(
        APP_SOURCE.includes(
          `requireNutritionProductFeature(nutritionProductAccessAuthority, "${feature}")`,
        ),
        path,
      ).toBe(true);
    }
    expect(APP_SOURCE).not.toContain('"ai_recipe_context_application"');
    // `/api/estimate-nutrition` remains outside all four AI-5A features.
    const estimateAt = APP_SOURCE.indexOf('app.post("/api/estimate-nutrition"');
    expect(estimateAt).toBeGreaterThan(-1);
    expect(
      APP_SOURCE.slice(estimateAt, APP_SOURCE.indexOf(');', estimateAt)),
    ).not.toContain('requireNutritionProductFeature');
  });
});

// ===========================================================================
// 6. MIDDLEWARE ORDER
// ===========================================================================

describe('AI-5E — middleware order is structural, not incidental', () => {
  function registrationOf(path: string): string {
    const index = APP_SOURCE.indexOf(`"${path}"`);
    expect(index, `route ${path} must be registered`).toBeGreaterThan(-1);
    const rest = APP_SOURCE.slice(index);
    const handlerAt = rest.search(/\basync\s*\(/);
    expect(handlerAt, `${path} must have a route handler`).toBeGreaterThan(-1);
    return rest.slice(0, handlerAt);
  }

  it.each(GATED_ROUTES)('%s: auth -> AUTHORITY -> pricing -> limiter -> handler', (path) => {
    const chain = registrationOf(path);
    const at = (needle: string) => {
      const index = chain.indexOf(needle);
      expect(index, `${needle} must be registered on ${path}`).toBeGreaterThan(-1);
      return index;
    };
    expect(at('requireAiAccessToken')).toBeLessThan(at('requireNutritionProductFeature'));
    expect(at('requireNutritionProductFeature')).toBeLessThan(at('RateLimiter'));
    if (path !== '/api/nutrition/recipe-context/reconcile') {
      expect(at('requireNutritionProductFeature')).toBeLessThan(at('textPricingGuard'));
      expect(at('textPricingGuard')).toBeLessThan(at('RateLimiter'));
    }
  });

  it('the status route also runs auth before the authority', () => {
    const at = APP_SOURCE.indexOf(`app.get(\n    NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,`);
    expect(at).toBeGreaterThan(-1);
    const chain = APP_SOURCE.slice(at, APP_SOURCE.indexOf('// AI-assisted USDA resolution', at));
    expect(chain).toContain('requireAiAccessToken');
    expect(chain).toContain('resolveNutritionProductAccessDecision');
    expect(chain.indexOf('requireAiAccessToken')).toBeLessThan(
      chain.indexOf('resolveNutritionProductAccessDecision'),
    );
  });

  it('a refusal consumes NO downstream paid-route limiter budget', async () => {
    // Six Basic refusals against a limit of 2, then an Advanced app on the same
    // process is still admissible: a refusal never enters the limiter.
    const basic = await startApp({ kind: 'deployment', tier: 'basic' }, {
      NUTRITION_INTERPRET_RATE_LIMIT: '2',
    });
    try {
      for (let i = 0; i < 6; i += 1) {
        expectEntitlementDenial(
          await post(
            basic.baseUrl,
            '/api/nutrition/interpret-ingredients',
            requestBody('/api/nutrition/interpret-ingredients'),
            AUTH,
          ),
        );
      }
      expectZeroWork();
    } finally {
      await stop(basic);
    }

    // An UNAVAILABLE authority is equally frugal with the bucket.
    const unavailable = await startApp(
      { kind: 'broken', behaviour: 'reject' },
      { NUTRITION_INTERPRET_RATE_LIMIT: '2' },
    );
    try {
      for (let i = 0; i < 6; i += 1) {
        expectAuthorityUnavailable(
          await post(
            unavailable.baseUrl,
            '/api/nutrition/interpret-ingredients',
            requestBody('/api/nutrition/interpret-ingredients'),
            AUTH,
          ),
        );
      }
      expectZeroWork();
    } finally {
      await stop(unavailable);
    }
  });
});

// ===========================================================================
// 7. RECONCILE ORDER
// ===========================================================================

describe('AI-5E — product access precedes AI-4E receipt verification and D1', () => {
  it('Basic stops BEFORE the receipt: no origin oracle for an unauthorized caller', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'basic' });
    try {
      // A request with NO receipt would earn `400 origin_unverified` if the gate did
      // not fire first. The bounded 403 proves the gate ran first.
      const result = await post(
        app.baseUrl,
        '/api/nutrition/recipe-context/reconcile',
        requestBody('/api/nutrition/recipe-context/reconcile'),
        AUTH,
      );
      expectEntitlementDenial(result);
      expect(result.json['code']).not.toBe('origin_unverified');
      expect(result.raw).not.toContain('origin_unverified');
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it('an UNAVAILABLE authority also stops BEFORE the receipt', async () => {
    const app = await startApp({ kind: 'broken', behaviour: 'throw' });
    try {
      const result = await post(
        app.baseUrl,
        '/api/nutrition/recipe-context/reconcile',
        requestBody('/api/nutrition/recipe-context/reconcile'),
        AUTH,
      );
      expectAuthorityUnavailable(result);
      expect(result.raw).not.toContain('origin_unverified');
      expect(result.raw).not.toContain('stale_context');
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it('AI Advanced reaches the receipt gate: the existing origin-before-D1 chain is unchanged', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'ai_advanced' });
    try {
      const result = await post(
        app.baseUrl,
        '/api/nutrition/recipe-context/reconcile',
        requestBody('/api/nutrition/recipe-context/reconcile'),
        AUTH,
      );
      // Unverified receipt -> the pre-existing bounded origin class, not a product class.
      expect(result.status).toBe(400);
      expect(result.json['code']).toBe('origin_unverified');
    } finally {
      await stop(app);
    }
  });

  it('the structural order is still gate -> reconcile limiter -> receipt -> D1', () => {
    const registration = APP_SOURCE.indexOf('"/api/nutrition/recipe-context/reconcile"');
    expect(registration).toBeGreaterThan(-1);
    const chain = APP_SOURCE.slice(registration);
    const gateAt = chain.indexOf(
      'requireNutritionProductFeature(nutritionProductAccessAuthority, "ai_recipe_context_review")',
    );
    const limiterAt = chain.indexOf('nutritionContextReconcileRateLimiter');
    const originAt = chain.indexOf('readRecipeContextOriginEnvelope(req.body, recipeContextOriginReceipts)');
    const d1At = chain.indexOf('reconcileRecipeContextOnServer(envelope.body)');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(limiterAt);
    expect(limiterAt).toBeLessThan(originAt);
    expect(originAt).toBeLessThan(d1At);
  });
});

// ===========================================================================
// 8. FORGED CLIENT INPUT
// ===========================================================================

describe('AI-5E — the client cannot select an authority, a source, a tier or a decision', () => {
  const FORGED_HEADERS: Record<string, string> = {
    'x-product-tier': 'ai_advanced',
    'x-entitlement': 'ai_advanced',
    'x-kitchen-nutrition-tier': 'ai_advanced',
    'x-ai-product-access': 'ai_advanced',
    'x-nutrition-product-access': 'ai_advanced',
    'x-user-id': 'u_admin',
    'x-account-id': 'acct_lifetime',
    'x-plan': 'paid',
    'x-nutrition-product-tier': 'ai_advanced',
    'x-authority': 'account',
    'x-authority-source': 'account',
    'x-product-access-source': 'account',
  };

  const FORGED_COOKIE = 'tier=ai_advanced; entitlement=ai_advanced; plan=paid; account=acct_1';
  const FORGED_QUERY = '?entitled=true&tier=ai_advanced&productTier=ai_advanced&plan=paid';

  const FORGED_BODY: Record<string, unknown> = {
    tier: 'ai_advanced',
    productTier: 'ai_advanced',
    entitled: true,
    productAccess: { tier: 'ai_advanced' },
    capabilities: ['ai_interpretation', 'ai_recipe_context_review'],
    account: 'acct_1',
    userId: 'u_admin',
    subscription: { plan: 'paid', status: 'active' },
  };

  it('a Basic deployment authority stays Basic under EVERY forged channel', async () => {
    const app = await startApp({ kind: 'deployment', tier: 'basic' });
    try {
      const headers = { ...AUTH, ...FORGED_HEADERS, cookie: FORGED_COOKIE };
      const result = await get(
        app.baseUrl,
        `${NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT}${FORGED_QUERY}`,
        headers,
      );
      expect(result.status).toBe(200);
      expect(result.json['tier']).toBe('basic');
      expect(result.json).not.toHaveProperty('source');

      for (const [path] of GATED_ROUTES) {
        const denied = await post(
          app.baseUrl,
          `${path}${FORGED_QUERY}`,
          { ...(requestBody(path) as Record<string, unknown>), ...FORGED_BODY },
          headers,
        );
        expectEntitlementDenial(denied);
        expect(denied.json['aiAttempted']).toBe(false);
      }
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it('NO request field can select the authority implementation, source, raw tier or access', async () => {
    // Two apps, same process, same request shape: the Basic one stays Basic and the
    // Advanced one stays Advanced. Authority selection is composition-only.
    const basic = await startApp({ kind: 'deployment', tier: 'basic' });
    const advanced = await startApp({ kind: 'deployment', tier: 'ai_advanced' });
    try {
      const attempts: ReadonlyArray<Record<string, unknown>> = [
        { authority: 'account' },
        { authoritySource: 'account' },
        { productAccessSource: 'account' },
        { productAccessTier: 'ai_advanced' },
        { nutritionProductTier: 'ai_advanced' },
        { authorityImpl: 'deployment' },
        { source: 'deployment' },
      ];
      for (const attempt of attempts) {
        const onBasic = await post(
          basic.baseUrl,
          '/api/nutrition/interpret-ingredients',
          {
            ...(requestBody('/api/nutrition/interpret-ingredients') as Record<string, unknown>),
            ...attempt,
          },
          { ...AUTH, ...FORGED_HEADERS },
        );
        expectEntitlementDenial(onBasic);

        const onAdvanced = await post(
          advanced.baseUrl,
          '/api/nutrition/interpret-ingredients',
          {
            ...(requestBody('/api/nutrition/interpret-ingredients') as Record<string, unknown>),
            ...attempt,
          },
          { ...AUTH, ...FORGED_HEADERS },
        );
        expect(onAdvanced.json['code']).not.toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
        expect(onAdvanced.json['code']).not.toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
      }
    } finally {
      await stop(basic);
      await stop(advanced);
    }
  });
});

// ===========================================================================
// 9. DEFAULTS, COMPOSITION AND CONSISTENCY
// ===========================================================================

describe('AI-5E — defaults, composition and single-authority consistency', () => {
  it('createApp() with NO authority is CANONICAL Basic — never an implicit Advanced', async () => {
    const app = await startApp();
    try {
      const result = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, AUTH);
      expect(result.status).toBe(200);
      expect(result.json['tier']).toBe('basic');
      for (const [path] of GATED_ROUTES) {
        expectEntitlementDenial(await post(app.baseUrl, path, requestBody(path), AUTH));
      }
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it('ONE deployment authority governs the status route and all six gates identically', async () => {
    for (const tier of ['basic', 'ai_advanced'] as const) {
      const app = await startApp({ kind: 'deployment', tier, count: true });
      try {
        const result = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, AUTH);
        const reported = result.json['tier'];
        let admitted = 0;
        let denied = 0;
        for (const [path] of GATED_ROUTES) {
          const gated = await post(app.baseUrl, path, requestBody(path), AUTH);
          if (gated.status === 403) denied += 1;
          else admitted += 1;
        }
        expect(app.authorityCalls()).toBe(1 + GATED_ROUTES.length);
        if (tier === 'basic') {
          expect(reported).toBe('basic');
          expect(denied).toBe(GATED_ROUTES.length);
          expect(admitted).toBe(0);
        } else {
          expect(reported).toBe('ai_advanced');
          expect(admitted).toBe(GATED_ROUTES.length);
          expect(denied).toBe(0);
        }
      } finally {
        await stop(app);
      }
    }
  });

  it('server.ts performs ONE raw env read and injects the composed authority', () => {
    expect(SERVER_SOURCE.match(/process\.env\[NUTRITION_PRODUCT_TIER_ENV\]/g)).toHaveLength(1);
    expect(SERVER_SOURCE).toContain('createDeploymentNutritionProductAccessAuthority(process.env[NUTRITION_PRODUCT_TIER_ENV])');
    expect(SERVER_SOURCE).toContain('nutritionProductAccessAuthority,');
    // The raw tier is NEVER passed separately alongside the authority.
    expect(SERVER_SOURCE).not.toContain('nutritionProductTier');
    // And no route or middleware reads it a second time.
    expect(APP_SOURCE).not.toMatch(/process\.env\s*\[\s*NUTRITION_PRODUCT_TIER_ENV/);
    expect(APP_SOURCE).not.toContain('nutritionProductTier');
  });

  it('there is NO dual authority seam in the production tree', () => {
    for (const file of ['server.ts', 'server/app.ts', 'server/nutritionProductAccess.ts', 'server/nutritionProductAccessAuthority.ts']) {
      const source = readFileSync(join(REPO, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source, `${file} must not carry the retired raw-tier seam`).not.toContain(
        'nutritionProductTier',
      );
      if (file !== 'server/nutritionProductAccessAuthority.ts') {
        // Only the authority factory may resolve a raw tier, and it does so ONCE at
        // construction. No route, no gate and no composition point may resolve one.
        expect(source, `${file} must not resolve a raw tier`).not.toContain(
          'resolveNutritionProductAccess(',
        );
      }
    }
    // Exactly ONE `createApp` entitlement option exists.
    const options = APP_SOURCE.split('nutritionProductAccessAuthority?:').length - 1;
    expect(options).toBe(1);
    // No precedence/fallback chain between two entitlement sources: the ONLY fallback is
    // the fail-closed Basic deployment authority, never a raw tier or a second source.
    const fallbacks = [...APP_SOURCE.matchAll(/nutritionProductAccessAuthority\s*\?\?\s*([A-Za-z0-9_]+)/g)].map(
      (m) => m[1],
    );
    expect(fallbacks).toEqual(['createBasicNutritionProductAccessAuthority']);
  });

  it('product access is never derived from provider, BYOK or pricing state', async () => {
    // A fully configured provider, a session-only BYOK credential and an acknowledged
    // paid selection change NOTHING about a Basic deployment.
    const app = await startApp({ kind: 'deployment', tier: 'basic' }, {
      GEMINI_API_KEY: 'configured',
      OPENROUTER_API_KEY: 'configured',
      KITCHEN_CODEX_TEXT_PROVIDER: 'openrouter',
      KITCHEN_CODEX_TEXT_MODEL: 'openai/gpt-4o-mini',
    });
    try {
      const result = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
        ...AUTH,
        'x-kitchen-ai-selection': JSON.stringify({
          provider: 'openrouter',
          model: 'openai/gpt-4o-mini',
          pricing_ack: 'free',
        }),
      });
      expect(result.json['tier']).toBe('basic');
      expectEntitlementDenial(
        await post(
          app.baseUrl,
          '/api/nutrition/interpret-ingredients',
          requestBody('/api/nutrition/interpret-ingredients'),
          AUTH,
        ),
      );
    } finally {
      await stop(app);
    }
  });
});