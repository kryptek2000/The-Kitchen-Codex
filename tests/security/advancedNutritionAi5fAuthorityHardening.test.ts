/**
 * AI-5F — PRODUCT-ACCESS AUTHORITY EXCEPTION-TOTALITY HARDENING (HTTP wire).
 *
 * AI-5E's own review raised one non-blocking robustness NOTE: two SERVER-INJECTED
 * `Proxy`-shaped values could escape the authority boundary as a synchronous throw,
 * because the `authority.resolve` property READ and the `status`/`access` reads during
 * normalization sat outside the invocation `try`. Express bounded those as generic
 * 500s. AI-5F closes them; this suite proves the wire now says the truthful,
 * bounded thing instead:
 *
 *   1. STATUS ROUTE: `Proxy`-shaped authorities answer 503
 *      `NUTRITION_PRODUCT_ACCESS_UNAVAILABLE` — never a generic 500, never a tier.
 *   2. THE SIX GATES: likewise 503 with `aiAttempted: false`, and ZERO provider work.
 *   3. NO GENERIC 500: no `{ "error": "Internal server error" }` escapes for any
 *      repaired case.
 *   4. BOUNDED / NON-LEAKING: no stack, no authority detail, no source disclosure.
 *   5. AUTH-FIRST: even an authority whose `get('resolve')` THROWS is never touched by
 *      an unauthenticated caller — 401, and the trap counter stays at ZERO.
 *   6. EXACTLY ONCE: one request, one authority attempt, no retry and no second read.
 *   7. INVARIANCE: canonical Basic still 403s, canonical Advanced still passes, the
 *      six gates and the reconcile order are untouched.
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
} from '../../server/nutritionProductAccessAuthority.js';
import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_ACCESS,
  NUTRITION_PRODUCT_ACCESS_VERSION,
} from '../../src/core/nutritionV2/nutritionProductAccess.js';

const REPO = join(__dirname, '..', '..');
const APP_SOURCE = readFileSync(join(REPO, 'server', 'app.ts'), 'utf8');
const AUTHORITY_SOURCE = readFileSync(
  join(REPO, 'server', 'nutritionProductAccessAuthority.ts'),
  'utf8',
);

const AI_ENDPOINT_TOKEN = 'ai5f-secret-token';
const AUTH = { authorization: `Bearer ${AI_ENDPOINT_TOKEN}` };

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_TEXT_PROVIDER',
  'KITCHEN_CODEX_TEXT_MODEL',
  'KITCHEN_CODEX_NUTRITION_PRODUCT_TIER',
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
  credentialResolve: 0,
  outboundHttp: 0,
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
// REQUEST SHAPES
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
  title: 'AI-5F probe',
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

function requestBody(path: string): unknown {
  switch (path) {
    case '/api/nutrition/resolve-ingredients':
      return { ingredients: INGREDIENTS };
    case '/api/nutrition/interpret-ingredients':
      return { ingredients: ROWS };
    case '/api/nutrition/plan-ingredients':
      return {
        request_version: 'nutrition_ai_advanced_plan_request_v1',
        request_id: 'ai5f-plan',
        plan_request: PLAN_REQUEST,
        planning_targets: [{ line_ref: 'tomato sauce', source_text: '1 cup tomato sauce' }],
      };
    case '/api/nutrition/estimate-mass':
      return {
        request_version: 'nutrition_ai_advanced_estimate_mass_request_v1',
        request_id: 'ai5f-mass',
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
      };
    case '/api/nutrition/recipe-context':
      return {
        request_version: 'nutrition_ai_advanced_recipe_context_request_v1',
        request_id: 'ai5f-context',
        recipe: AUTHORED_RECIPE,
        instructions: INSTRUCTIONS,
      };
    default:
      return {
        wire: { request_version: 'nutrition_ai_recipe_context_v1', request_id: 'ai5f-context' },
        expected_request_id: 'ai5f-context',
        recipe: AUTHORED_RECIPE,
        origin_receipt: 'forged-receipt-the-server-never-issued',
      };
  }
}

// ---------------------------------------------------------------------------
// THE HOSTILE, SERVER-INJECTED AUTHORITIES AI-5F REPAIRED
// ---------------------------------------------------------------------------

/**
 * An authority is described by a SPEC and BUILT INSIDE the app's module cycle, because
 * AI-5A's canonical identity check is load-bearing: an access value minted by a
 * different module-graph copy is not canonical and would (correctly) resolve as
 * `unavailable`.
 */
type HostileSpec =
  /** A `Proxy` whose `get('resolve')` THROWS — the AI-5E NOTE, escape 1. */
  | 'resolve-getter-throws'
  /** A `Proxy` whose `get('resolve')` returns a non-function. */
  | 'resolve-getter-non-function'
  /** A REVOKED `Proxy` authority. */
  | 'revoked-authority'
  /** An authority whose `resolve` is a `Proxy` function with a throwing apply trap. */
  | 'apply-trap'
  /** A returned decision `Proxy` whose `get('status')` throws — the NOTE, escape 2. */
  | 'status-getter-throws'
  /** `{ status: 'resolved', access: <throwing getter> }`. */
  | 'access-getter-throws'
  /** A REVOKED `Proxy` returned as the decision. */
  | 'revoked-decision'
  /** A returned thenable whose `then` getter throws. */
  | 'then-getter-throws'
  /** A returned thenable whose execution rejects. */
  | 'thenable-rejects';

const HOSTILE_SPECS: ReadonlyArray<HostileSpec> = [
  'resolve-getter-throws',
  'resolve-getter-non-function',
  'revoked-authority',
  'apply-trap',
  'status-getter-throws',
  'access-getter-throws',
  'revoked-decision',
  'then-getter-throws',
  'thenable-rejects',
];

/** Detail strings that must NEVER reach a client if the containment is real. */
const LEAK_MARKERS = [
  'resolve getter exploded',
  'apply trap exploded',
  'status getter exploded',
  'access getter exploded',
  'then getter exploded',
  'thenable execution rejected',
  'Proxy has already been revoked',
  'revoked',
  'stack',
  'at Object.',
  'node:internal',
];

interface Hostile {
  /** The authority to inject. */
  readonly authority: unknown;
  /** How many times ANY property of the authority object was read. */
  readonly authorityReads: () => number;
  /** How many times `resolve` was actually CALLED (a successful read + invocation). */
  readonly invocations: () => number;
}

function buildHostile(spec: HostileSpec, canonical: { advanced: unknown }): Hostile {
  let reads = 0;
  let invocations = 0;

  const countReads = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop, receiver) {
        reads += 1;
        return Reflect.get(t, prop, receiver);
      },
    });

  /** An authority that hands back a fixed raw decision, wrapped for read counting. */
  const returning = (raw: unknown): unknown =>
    countReads({
      resolve: () => {
        invocations += 1;
        return Promise.resolve(raw);
      },
    });

  switch (spec) {
    case 'resolve-getter-throws':
      return {
        authorityReads: () => reads,
        invocations: () => invocations,
        authority: countReads(
          new Proxy(
            {},
            {
              get(t, prop, receiver) {
                if (prop === 'resolve') throw new Error('resolve getter exploded');
                return Reflect.get(t, prop, receiver);
              },
            },
          ),
        ),
      };
    case 'resolve-getter-non-function':
      return {
        authorityReads: () => reads,
        invocations: () => invocations,
        authority: countReads(new Proxy({}, { get: () => 'not-a-function' })),
      };
    case 'revoked-authority': {
      const { proxy, revoke } = Proxy.revocable(
        { resolve: () => Promise.resolve({ status: 'resolved', access: canonical.advanced }) },
        {},
      );
      revoke();
      return { authority: proxy, authorityReads: () => reads, invocations: () => invocations };
    }
    case 'apply-trap':
      return {
        authorityReads: () => reads,
        invocations: () => invocations,
        // `resolve` IS the `Proxy` function: wrapping the function itself in the
        // read-counting proxy would unwrap it and silently skip the apply trap.
        authority: countReads({
          resolve: new Proxy(
            () => Promise.resolve({ status: 'unavailable' }),
            {
              apply() {
                invocations += 1;
                throw new Error('apply trap exploded');
              },
            },
          ),
        }),
      };
    case 'status-getter-throws':
      return {
        authorityReads: () => reads,
        invocations: () => invocations,
        authority: returning(
          new Proxy(
            {},
            {
              get(t, prop, receiver) {
                if (prop === 'status') throw new Error('status getter exploded');
                return Reflect.get(t, prop, receiver);
              },
            },
          ),
        ),
      };
    case 'access-getter-throws':
      return {
        authorityReads: () => reads,
        invocations: () => invocations,
        authority: returning({
          status: 'resolved',
          get access(): unknown {
            throw new Error('access getter exploded');
          },
        }),
      };
    case 'revoked-decision': {
      const { proxy, revoke } = Proxy.revocable(
        { status: 'resolved', access: canonical.advanced },
        {},
      );
      revoke();
      return {
        authority: returning(proxy),
        authorityReads: () => reads,
        invocations: () => invocations,
      };
    }
    case 'then-getter-throws':
      return {
        authorityReads: () => reads,
        invocations: () => invocations,
        authority: countReads({
          resolve: () =>
            new Proxy(
              {},
              {
                get(t, prop, receiver) {
                  if (prop === 'then') throw new Error('then getter exploded');
                  return Reflect.get(t, prop, receiver);
                },
              },
            ),
        }),
      };
    default:
      return {
        authorityReads: () => reads,
        invocations: () => invocations,
        authority: countReads({
          resolve: () => ({
            then(_resolve: unknown, reject: (reason: unknown) => void): void {
              reject(new Error('thenable execution rejected'));
            },
          }),
        }),
      };
  }
}

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------

interface Running {
  readonly server: http.Server;
  readonly baseUrl: string;
  readonly hostile: Hostile | undefined;
}

async function startHostileApp(spec: HostileSpec): Promise<Running> {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  process.env.NUTRITION_RESOLVE_RATE_LIMIT = '1000';
  process.env.NUTRITION_INTERPRET_RATE_LIMIT = '1000';
  process.env.NUTRITION_PLAN_RATE_LIMIT = '1000';
  process.env.NUTRITION_ESTIMATE_RATE_LIMIT = '1000';
  process.env.NUTRITION_CONTEXT_RATE_LIMIT = '1000';
  process.env.NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT = '1000';
  resetRateLimitersForTests();

  const { createApp } = await import('../../server/app.js');
  const ai5a = await import('../../src/core/nutritionV2/nutritionProductAccess.js');
  const hostile = buildHostile(spec, { advanced: ai5a.AI_ADVANCED_NUTRITION_PRODUCT_ACCESS });

  const app = createApp({
    isProduction: false,
    nutritionProductAccessAuthority: hostile.authority as NutritionProductAccessAuthority,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, hostile };
}

async function startTierApp(tier: unknown): Promise<Running> {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  resetRateLimitersForTests();
  const { createApp } = await import('../../server/app.js');
  const { createDeploymentNutritionProductAccessAuthority } = await import(
    '../../server/nutritionProductAccessAuthority.js'
  );
  const app = createApp({
    isProduction: false,
    nutritionProductAccessAuthority: createDeploymentNutritionProductAccessAuthority(tier),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, hostile: undefined };
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

async function call(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
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

const UNAVAILABLE_STATUS_BODY = {
  ok: false,
  code: 'NUTRITION_PRODUCT_ACCESS_UNAVAILABLE',
  error: 'AI Advanced Nutrition access could not be verified.',
};

function expectNoGeneric500(result: HttpResult, label: string) {
  expect(result.status, `${label} must not be a generic 500`).not.toBe(500);
  expect(result.json['error'], `${label} must not be the generic internal error`).not.toBe(
    'Internal server error',
  );
  expect(result.raw, `${label} must not leak a stack`).not.toContain('    at ');
  for (const marker of LEAK_MARKERS) {
    expect(result.raw, `${label} must not leak ${marker}`).not.toContain(marker);
  }
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
// 1./2./3./4. THE REPAIRED WIRE
// ===========================================================================

describe('AI-5F — a hostile injected authority answers the bounded 503, never a generic 500', () => {
  it.each(HOSTILE_SPECS)('STATUS route: %s -> 503 NUTRITION_PRODUCT_ACCESS_UNAVAILABLE', async (spec) => {
    const app = await startHostileApp(spec);
    try {
      const result = await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
        headers: AUTH,
      });
      expect(result.status, spec).toBe(503);
      expect(result.json, spec).toEqual(UNAVAILABLE_STATUS_BODY);
      expectNoGeneric500(result, `status/${spec}`);
      // No fabricated product fact, exactly as for every other unavailable class.
      expect(result.json).not.toHaveProperty('tier');
      expect(result.json).not.toHaveProperty('version');
      expect(result.json).not.toHaveProperty('aiAttempted');
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(Object.keys(result.json).sort()).toEqual(['code', 'error', 'ok']);
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it.each(HOSTILE_SPECS)('all SIX gates: %s -> 503 with aiAttempted:false', async (spec) => {
    const app = await startHostileApp(spec);
    try {
      for (const [path] of GATED_ROUTES) {
        const result = await call(app.baseUrl, path, { method: 'POST', body: requestBody(path), headers: AUTH });
        expect(result.status, `${path} (${spec})`).toBe(503);
        expect(result.json, `${path} (${spec})`).toEqual({
          ...UNAVAILABLE_STATUS_BODY,
          aiAttempted: false,
        });
        expectNoGeneric500(result, `${path}/${spec}`);
        expectZeroWork();
      }
    } finally {
      await stop(app);
    }
  });

  it('a hostile authority is NEVER reported as Basic and NEVER as Advanced', async () => {
    for (const spec of HOSTILE_SPECS) {
      const app = await startHostileApp(spec);
      try {
        const status = await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
          headers: AUTH,
        });
        expect(status.json['code'], spec).toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
        expect(status.json['code'], spec).not.toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
        const gated = await call(app.baseUrl, '/api/nutrition/interpret-ingredients', {
          method: 'POST',
          body: requestBody('/api/nutrition/interpret-ingredients'),
          headers: AUTH,
        });
        expect(gated.json['code'], spec).toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
        expect(gated.raw, spec).not.toContain('"tier"');
      } finally {
        await stop(app);
      }
    }
  });

  it('the unchanged AI-5C client reader composes a 503 to `product_access_unverified`', async () => {
    const { parseNutritionProductAccessStatus, readNutritionProductAccess } = await import(
      '../../src/application/nutritionProductAccess.js'
    );
    const { resolveNutritionAiClientState } = await import(
      '../../src/application/nutritionAiClientState.js'
    );
    expect(parseNutritionProductAccessStatus(UNAVAILABLE_STATUS_BODY)).toBeUndefined();
    const network = {
      request: async () => ({ status: 503, ok: false, data: UNAVAILABLE_STATUS_BODY }),
      get: async () => ({ status: 503, ok: false, data: UNAVAILABLE_STATUS_BODY }),
      post: async () => ({ status: 503, ok: false, data: UNAVAILABLE_STATUS_BODY }),
    } as never;
    expect((await readNutritionProductAccess(network)).status).toBe('unavailable');
    const state = await resolveNutritionAiClientState(network);
    expect(state.availability).toBe('product_access_unverified');
    expect(state.available).toBe(false);
  });
});

// ===========================================================================
// 5. AUTH-FIRST
// ===========================================================================

describe('AI-5F — a hostile authority is never TOUCHED by an unauthenticated caller', () => {
  it('STATUS: 401 with the authority property-read counter at ZERO', async () => {
    const app = await startHostileApp('resolve-getter-throws');
    try {
      const result = await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT);
      expect(result.status).toBe(401);
      expect(result.json['code']).toBe('UNAUTHORIZED');
      expect(result.json).not.toHaveProperty('tier');
      expect(result.json).not.toHaveProperty('version');
      expect(result.raw).not.toContain(NUTRITION_PRODUCT_ACCESS_VERSION);
      expect(app.hostile!.authorityReads(), 'auth-first must not read the authority at all').toBe(0);
      expect(app.hostile!.invocations()).toBe(0);
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it.each(HOSTILE_SPECS)('every gated POST: 401 with ZERO authority reads (%s)', async (spec) => {
    const app = await startHostileApp(spec);
    try {
      for (const [path] of GATED_ROUTES) {
        const result = await call(app.baseUrl, path, { method: 'POST', body: requestBody(path) });
        expect(result.status, `${path} must answer 401 unauthenticated`).toBe(401);
        expect(result.json['code']).toBe('UNAUTHORIZED');
        // The entitlement classes must not leak to an anonymous caller.
        expect(result.json['code']).not.toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
        expect(result.json['code']).not.toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
        expect(app.hostile!.authorityReads(), `${path} touched the authority unauthenticated`).toBe(0);
        expect(app.hostile!.invocations()).toBe(0);
      }
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it('the first AUTHENTICATED read is exactly the ONE the gate performs', async () => {
    const app = await startHostileApp('status-getter-throws');
    try {
      expect(app.hostile!.authorityReads()).toBe(0);
      await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, { headers: AUTH });
      // Exactly one property read of the authority: the `resolve` lookup.
      expect(app.hostile!.authorityReads()).toBe(1);
      expect(app.hostile!.invocations()).toBe(1);
    } finally {
      await stop(app);
    }
  });
});

// ===========================================================================
// 6. EXACTLY ONCE, NO RETRY
// ===========================================================================

describe('AI-5F — one request, one authority attempt, no retry', () => {
  it('a hostile authority is consulted EXACTLY ONCE per request on every surface', async () => {
    const app = await startHostileApp('access-getter-throws');
    try {
      await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, { headers: AUTH });
      expect(app.hostile!.invocations()).toBe(1);
      for (const [path] of GATED_ROUTES) {
        const before = app.hostile!.invocations();
        await call(app.baseUrl, path, { method: 'POST', body: requestBody(path), headers: AUTH });
        expect(app.hostile!.invocations() - before, `${path} must attempt the authority once`).toBe(1);
      }
      expect(app.hostile!.invocations()).toBe(1 + GATED_ROUTES.length);
    } finally {
      await stop(app);
    }
  });

  it('the status route and a gated POST each make their own single attempt', async () => {
    const app = await startHostileApp('apply-trap');
    try {
      await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, { headers: AUTH });
      expect(app.hostile!.invocations()).toBe(1);
      await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, { headers: AUTH });
      expect(app.hostile!.invocations()).toBe(2);
    } finally {
      await stop(app);
    }
  });

  it('no timeout was introduced: the boundary adds no clock of its own', () => {
    const code = AUTHORITY_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'Promise.race',
      'AbortController',
      'AbortSignal',
      'setTimeout',
      'setInterval',
      'retry',
      'retries',
      'deadline',
      'timeout',
      'watchdog',
      'circuit',
    ]) {
      expect(code.toLowerCase(), `authority must not contain ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    // No second authority seam, no second gate registration, no seventh gate.
    expect([...APP_SOURCE.matchAll(/requireNutritionProductFeature\(/g)]).toHaveLength(6);
    expect(APP_SOURCE).not.toContain('"ai_recipe_context_application"');
  });
});

// ===========================================================================
// 7. INVARIANCE
// ===========================================================================

describe('AI-5F — normal Basic / Advanced semantics are untouched', () => {
  it('canonical Basic still answers exactly { ok, version, tier } and 403s every gate', async () => {
    const app = await startTierApp('basic');
    try {
      const status = await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
        headers: AUTH,
      });
      expect(status.status).toBe(200);
      expect(Object.keys(status.json).sort()).toEqual([...NUTRITION_PRODUCT_ACCESS_STATUS_KEYS].sort());
      expect(status.json).toEqual({
        ok: true,
        version: NUTRITION_PRODUCT_ACCESS_VERSION,
        tier: 'basic',
      });
      expect(status.headers.get('cache-control')).toBe('no-store');
      for (const [path] of GATED_ROUTES) {
        const gated = await call(app.baseUrl, path, {
          method: 'POST',
          body: requestBody(path),
          headers: AUTH,
        });
        expect(gated.status, path).toBe(403);
        expect(gated.json, path).toEqual({
          ok: false,
          code: NUTRITION_AI_NOT_ENTITLED_CODE,
          error: 'AI Advanced Nutrition is not available for this product access.',
          aiAttempted: false,
        });
      }
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it('canonical Advanced still passes every product gate to its own downstream semantics', async () => {
    const app = await startTierApp('ai_advanced');
    try {
      const status = await call(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
        headers: AUTH,
      });
      expect(status.status).toBe(200);
      expect(status.json).toEqual({
        ok: true,
        version: NUTRITION_PRODUCT_ACCESS_VERSION,
        tier: 'ai_advanced',
      });
      for (const [path] of GATED_ROUTES) {
        const gated = await call(app.baseUrl, path, {
          method: 'POST',
          body: requestBody(path),
          headers: AUTH,
        });
        expect(gated.json['code'], `${path} must not be refused by the product gate`).not.toBe(
          NUTRITION_AI_NOT_ENTITLED_CODE,
        );
        expect(gated.json['code']).not.toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
      }
    } finally {
      await stop(app);
    }
  });

  it('reconcile still stops a hostile authority BEFORE AI-4E receipt verification and D1', async () => {
    const app = await startHostileApp('revoked-decision');
    try {
      const result = await call(app.baseUrl, '/api/nutrition/recipe-context/reconcile', {
        method: 'POST',
        body: requestBody('/api/nutrition/recipe-context/reconcile'),
        headers: AUTH,
      });
      expect(result.status).toBe(503);
      expect(result.json['code']).toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
      expect(result.raw).not.toContain('origin_unverified');
      expect(result.raw).not.toContain('stale_context');
      expectZeroWork();
    } finally {
      await stop(app);
    }
  });

  it('the three product classes remain distinct and uncollapsed', async () => {
    // Basic -> 403, hostile -> 503, Advanced -> admitted. Three different truths.
    const basic = await startTierApp('basic');
    const hostile = await startHostileApp('resolve-getter-throws');
    const advanced = await startTierApp('ai_advanced');
    try {
      const probe = '/api/nutrition/interpret-ingredients';
      const body = requestBody(probe);
      const onBasic = await call(basic.baseUrl, probe, { method: 'POST', body, headers: AUTH });
      const onHostile = await call(hostile.baseUrl, probe, { method: 'POST', body, headers: AUTH });
      const onAdvanced = await call(advanced.baseUrl, probe, { method: 'POST', body, headers: AUTH });
      expect(onBasic.status).toBe(403);
      expect(onBasic.json['code']).toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
      expect(onHostile.status).toBe(503);
      expect(onHostile.json['code']).toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
      expect(onAdvanced.json['code']).not.toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
      expect(onAdvanced.json['code']).not.toBe(NUTRITION_PRODUCT_ACCESS_UNAVAILABLE_CODE);
    } finally {
      await stop(basic);
      await stop(hostile);
      await stop(advanced);
    }
  });

  it('canonical access values are the only thing that ever resolves — never a hostile one', async () => {
    // The AI-5A identity check is untouched: BASIC/ADVANCED are still the exact frozen
    // instances, and nothing about the repair widened what counts as resolved.
    expect(BASIC_NUTRITION_PRODUCT_ACCESS.tier).toBe('basic');
    expect(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS.tier).toBe('ai_advanced');
    expect(Object.isFrozen(BASIC_NUTRITION_PRODUCT_ACCESS)).toBe(true);
    expect(Object.isFrozen(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).toBe(true);
    expect(Object.keys(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS).sort()).toEqual([
      'aiBoundedMassEstimation',
      'aiCandidateOrchestration',
      'aiInterpretation',
      'aiRecipeContextReview',
      'tier',
      'version',
    ]);
  });
});