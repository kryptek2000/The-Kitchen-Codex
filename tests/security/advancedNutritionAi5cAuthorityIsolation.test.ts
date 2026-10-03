/**
 * Advanced Nutrition AI-5C — SECURITY: authority isolation.
 *
 * The single rule this file exists to defend:
 *
 *     CLIENT AWARENESS != SERVER AUTHORITY
 *
 * The client learns the server-owned product-access decision so the UI can be
 * truthful. It must never become a source of that decision. These tests prove it
 * from both directions:
 *
 *   - FORWARD: a client that believes `ai_advanced` cannot make a Basic deployment
 *     run any gated Advanced Nutrition route, no matter which channel it forges.
 *   - BACKWARD: the client reader cannot invent an access value the AI-5A contract
 *     does not sanction, and cannot be turned into a persistence channel.
 *
 * It also pins that AI-5B and AI-4E behaviour is untouched by this phase.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'net';

import { resetRateLimitersForTests } from '../../server/rateLimiter.js';
import {
  NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
  NUTRITION_PRODUCT_ACCESS_STATUS_KEYS,
  buildNutritionAiNotEntitledBody,
} from '../../server/nutritionProductAccess.js';
import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_ACCESS,
  NUTRITION_PRODUCT_ACCESS_VERSION,
} from '../../src/core/nutritionV2/nutritionProductAccess';
import {
  NUTRITION_PRODUCT_ACCESS_ENDPOINT,
  NUTRITION_PRODUCT_ACCESS_UNAVAILABLE,
  parseNutritionProductAccessStatus,
  readNutritionProductAccess,
} from '../../src/application/nutritionProductAccess';
import {
  composeNutritionAiClientState,
  resolveNutritionAiClientState,
} from '../../src/application/nutritionAiClientState';
import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import type { NetworkAdapter, NetworkResponse } from '../../src/application/adapters/NetworkAdapter';

const AI_ENDPOINT_TOKEN = 'ai5c-authority-isolation-token';
const AUTH = `Bearer ${AI_ENDPOINT_TOKEN}`;
const VERSION = NUTRITION_PRODUCT_ACCESS_VERSION;

const ENV_KEYS = [
  'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_NUTRITION_PRODUCT_TIER',
  'GEMINI_API_KEY',
  'NUTRITION_RESOLVE_RATE_LIMIT',
  'NUTRITION_INTERPRET_RATE_LIMIT',
  'NUTRITION_PLAN_RATE_LIMIT',
  'NUTRITION_ESTIMATE_RATE_LIMIT',
  'NUTRITION_CONTEXT_RATE_LIMIT',
  'NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT',
] as const;

const GATED_ROUTES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['/api/nutrition/resolve-ingredients', { ingredients: [] }],
  ['/api/nutrition/interpret-ingredients', { ingredients: [] }],
  ['/api/nutrition/plan-ingredients', { target: {} }],
  ['/api/nutrition/estimate-mass', { request_id: 'ai5c-iso', estimates: [] }],
  ['/api/nutrition/recipe-context', { recipe: {} }],
  ['/api/nutrition/recipe-context/reconcile', { wire: { rctx: 'forged' } }],
];

/** Every channel a client might try to smuggle a forged entitlement through. */
function forgedClientHeaders(): Record<string, string> {
  return {
    Authorization: AUTH,
    'x-product-tier': 'ai_advanced',
    'x-entitlement': 'ai_advanced',
    'x-kitchen-nutrition-tier': 'ai_advanced',
    'x-ai-product-access': JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS),
    'x-nutrition-product-access': VERSION,
    'cookie': `tier=ai_advanced; entitlement=ai_advanced`,
  };
}

function forgedClientBody(): Record<string, unknown> {
  return {
    tier: 'ai_advanced',
    productTier: 'ai_advanced',
    entitled: true,
    productAccess: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    capabilities: {
      aiInterpretation: true,
      aiCandidateOrchestration: true,
      aiBoundedMassEstimation: true,
      aiRecipeContextReview: true,
    },
  };
}

/**
 * The ONE generic adapter factory, satisfying the `NetworkAdapter` port exactly
 * (including its generic response parameter) while recording requested paths.
 */
function makeAdapter(
  handler: (path: string) => NetworkResponse<unknown>,
): { network: NetworkAdapter; getCalls: string[] } {
  const getCalls: string[] = [];
  const network: NetworkAdapter = {
    request: async <TResponse = unknown,>(): Promise<NetworkResponse<TResponse>> =>
      handler('') as NetworkResponse<TResponse>,
    get: async <TResponse = unknown,>(path: string): Promise<NetworkResponse<TResponse>> => {
      getCalls.push(path);
      return handler(path) as NetworkResponse<TResponse>;
    },
    post: async <TResponse = unknown,>(): Promise<NetworkResponse<TResponse>> =>
      handler('') as NetworkResponse<TResponse>,
  };
  return { network, getCalls };
}

interface Running {
  readonly server: http.Server;
  readonly baseUrl: string;
}

async function startApp(tier?: unknown): Promise<Running> {
  const { createApp } = await import('../../server/app.js');
  const app = createApp({
    isProduction: false,
    ...(tier === undefined ? {} : { nutritionProductTier: tier }),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

/**
 * Strips comments so a source scan tests real CODE, not prose.
 *
 * These modules deliberately *document* the things they must not do ("no
 * `process.env`", "no localStorage"), so a naive substring scan would flag its own
 * documentation. Stripping block and line comments keeps the assertion honest.
 */
function executableSource(relative: string): string {
  const raw = readFileSync(join(process.cwd(), relative), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('AI-5C — awareness is never authority (server side)', () => {
  let basicApp: Running;

  beforeAll(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
    resetRateLimitersForTests();
    basicApp = await startApp('basic');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => basicApp.server.close(() => resolve()));
    delete process.env.AI_ENDPOINT_TOKEN;
  });

  beforeEach(() => {
    process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  });

  afterEach(() => {
    resetRateLimitersForTests();
  });

  it('denies every gated route for a Basic deployment despite a forged AI-Advanced client', async () => {
    for (const [route, body] of GATED_ROUTES) {
      const response = await fetch(
        `${basicApp.baseUrl}${route}?entitled=true&tier=ai_advanced&productTier=ai_advanced`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...forgedClientHeaders() },
          body: JSON.stringify({ ...body, ...forgedClientBody() }),
        },
      );
      const json = (await response.json()) as Record<string, unknown>;
      expect(response.status, `${route} must stay denied`).toBe(403);
      expect(json).toEqual(buildNutritionAiNotEntitledBody());
      // No provider work was attempted, whatever the client claimed.
      expect(json.aiAttempted).toBe(false);
    }
  });

  it('denies a forged client even when it echoes the exact canonical access object', async () => {
    const response = await fetch(`${basicApp.baseUrl}/api/nutrition/interpret-ingredients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...forgedClientHeaders() },
      body: JSON.stringify({
        ingredients: [],
        product_access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
        access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
        ...forgedClientBody(),
      }),
    });
    expect(response.status).toBe(403);
  });

  it('still requires endpoint auth before it even considers entitlement', async () => {
    const response = await fetch(`${basicApp.baseUrl}/api/nutrition/interpret-ingredients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...forgedClientHeaders(), Authorization: '' },
      body: JSON.stringify(forgedClientBody()),
    });
    // 401, not 403: the client learns nothing about product state by probing.
    expect(response.status).toBe(401);
  });

  it('the status endpoint reports Basic no matter what the client asserts', async () => {
    const response = await fetch(
      `${basicApp.baseUrl}${NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT}?entitled=true`,
      { headers: forgedClientHeaders() },
    );
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.tier).toBe('basic');
  });

  it('an AI-Advanced client belief does not unlock the ungated estimator either', async () => {
    // /api/estimate-nutrition was never an AI-5A feature. AI-5C must not have gated
    // it, and must equally not have "ungated" anything else.
    const response = await fetch(`${basicApp.baseUrl}/api/estimate-nutrition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...forgedClientHeaders() },
      body: JSON.stringify({ ingredients: [] }),
    });
    expect(response.status).not.toBe(403);
  });
});

describe('AI-5C — awareness is never authority (client side)', () => {
  it('cannot mint an impossible product state through the parser', () => {
    // Basic tier carrying enabled features must never survive parsing.
    expect(
      parseNutritionProductAccessStatus({ ok: true, version: VERSION, tier: 'basic', aiInterpretation: true }),
    ).toBeUndefined();
  });

  it('a client-authored AI-Advanced access object is not accepted as transport data', async () => {
    // The server "helpfully" returns the full canonical access object.
    const { network } = makeAdapter(() => ({
      status: 200,
      ok: true,
      data: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    }));
    expect(await readNutritionProductAccess(network)).toEqual(
      NUTRITION_PRODUCT_ACCESS_UNAVAILABLE,
    );
  });

  it('never produces anything but the two canonical frozen instances', async () => {
    for (const tier of ['basic', 'ai_advanced'] as const) {
      const { network } = makeAdapter(() => ({
        status: 200,
        ok: true,
        data: { ok: true, version: VERSION, tier },
      }));
      const read = await readNutritionProductAccess(network);
      expect(
        read.status === 'resolved' &&
          (read.access === BASIC_NUTRITION_PRODUCT_ACCESS ||
            read.access === AI_ADVANCED_NUTRITION_PRODUCT_ACCESS),
      ).toBe(true);
    }
  });

  it('a forged client belief cannot turn effective availability on for a Basic read', () => {
    // Even if some caller hands the composition a hand-built "advanced" object, the
    // composition reads the canonical identity through AI-5A.
    const state = composeNutritionAiClientState({
      productAccess: {
        status: 'resolved',
        access: {
          ...BASIC_NUTRITION_PRODUCT_ACCESS,
          aiInterpretation: true,
          aiCandidateOrchestration: true,
          aiBoundedMassEstimation: true,
          aiRecipeContextReview: true,
        } as never,
      },
      operational: resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }),
    });
    // AI-5A's identity check treats a hand-authored object as non-canonical, so the
    // composition must not read any feature bit off it.
    expect(state.productAccessIsAiAdvanced).toBe(false);
    expect(state.available).toBe(false);
  });

  it('sends no entitlement information back to the server on any path', async () => {
    const { network, getCalls: requestedPaths } = makeAdapter(() => ({
      status: 200,
      ok: true,
      data: { ok: true, version: VERSION, tier: 'ai_advanced' },
    }));
    await resolveNutritionAiClientState(network);
    // Exactly two bare paths, no parameters and no tier echoed anywhere.
    expect(requestedPaths).toEqual([
      '/api/nutrition/product-access',
      '/api/providers',
    ]);
    for (const path of requestedPaths) {
      expect(path).not.toContain('?');
      expect(path).not.toContain('tier');
      expect(path).not.toContain('entitle');
    }
  });

  it('the client reader module references no entitlement, billing or account storage', () => {
    const source = executableSource('src/application/nutritionProductAccess.ts');
    for (const banned of [
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'document.cookie',
      'SettingsAdapter',
    ]) {
      expect(source, `client reader must not use ${banned}`).not.toContain(banned);
    }
    // It must not reach the environment or the server layer either.
    expect(source).not.toContain('process.env');
    expect(source).not.toContain("from '../../server");
    // Nor may it know anything about billing or account identity.
    for (const banned of ['stripe', 'paddle', 'checkout', 'subscription', 'customerId']) {
      expect(source.toLowerCase(), `client reader must not know ${banned}`).not.toContain(
        banned.toLowerCase(),
      );
    }
  });

  it('the composition module persists nothing', () => {
    const source = executableSource('src/application/nutritionAiClientState.ts');
    for (const banned of [
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'document.cookie',
      'SettingsAdapter',
      'process.env',
    ]) {
      expect(source, `composition must not use ${banned}`).not.toContain(banned);
    }
  });

  it('neither AI-5C client module touches any persistence API in code', () => {
    for (const relative of [
      'src/application/nutritionProductAccess.ts',
      'src/application/nutritionAiClientState.ts',
    ]) {
      const source = executableSource(relative);
      const persistence =
        /localStorage\.|sessionStorage\.|indexedDB\.|document\.cookie|SettingsAdapter|writeFile|writeFileSync/;
      expect(
        persistence.test(source),
        `${relative} must not persist product awareness`,
      ).toBe(false);
    }
  });

  it('App.tsx persists product awareness nowhere', () => {
    // App.tsx legitimately uses browser storage for unrelated features, so this is
    // scoped: no storage call may be fed the product-access state, and no storage
    // key may be derived from the product tier.
    const source = executableSource('src/App.tsx');
    expect(source).not.toMatch(
      /(localStorage|sessionStorage|indexedDB)\.[a-zA-Z]+\([^)]*productAccess/i,
    );
    expect(source).not.toMatch(/(localStorage|sessionStorage)\.[a-zA-Z]+\([^)]*nutritionAiClientState/i);
    expect(source).not.toMatch(/(localStorage|sessionStorage)\.[a-zA-Z]+\([^)]*availability\.tier/i);
    // And it stores no tier string under any key.
    expect(source).not.toMatch(/(localStorage|sessionStorage)\.setItem\(\s*['"`][^'"`]*tier/i);
  });
});

describe('AI-5C — the status endpoint stays minimal and non-authoritative', () => {
  it('declares exactly three response keys', () => {
    expect([...NUTRITION_PRODUCT_ACCESS_STATUS_KEYS]).toEqual(['ok', 'version', 'tier']);
  });

  it('mints no authorization artifact: the response is three informational fields', async () => {
    const app = await startApp('ai_advanced');
    try {
      process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
      const response = await fetch(`${app.baseUrl}${NUTRITION_PRODUCT_ACCESS_ENDPOINT}`, {
        headers: { Authorization: AUTH },
      });
      const json = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(json).sort()).toEqual(['ok', 'tier', 'version']);
      // Nothing reusable, nothing signable.
      expect(json).toEqual({
        ok: true,
        version: VERSION,
        tier: 'ai_advanced',
      });
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });

  it('AI-5B gate module semantics are unchanged by AI-5C', async () => {
    // The status builder is additive; the gate function and denial body are untouched.
    const module = readFileSync(join(process.cwd(), 'server/nutritionProductAccess.ts'), 'utf8');
    expect(module).toContain('res.status(403).json(buildNutritionAiNotEntitledBody())');
    expect(module).toContain('export const NUTRITION_AI_NOT_ENTITLED_CODE = "NUTRITION_AI_NOT_ENTITLED"');
    expect(buildNutritionAiNotEntitledBody()).toEqual({
      ok: false,
      code: 'NUTRITION_AI_NOT_ENTITLED',
      error: 'AI Advanced Nutrition is not available for this product access.',
      aiAttempted: false,
    });
  });

  it('AI-4E receipt crypto and origin verification are untouched', () => {
    const receipt = readFileSync(join(process.cwd(), 'server/recipeContextOriginReceipt.ts'), 'utf8');
    expect(receipt).toContain('randomBytes(32)');
    expect(receipt).toContain('createHmac');
    expect(receipt).toContain('timingSafeEqual');
    // AI-5C introduces no entitlement receipt of any kind.
    expect(receipt.toLowerCase()).not.toContain('entitlement');
  });
});