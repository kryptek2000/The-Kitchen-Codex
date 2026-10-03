/**
 * Advanced Nutrition AI-5C — SECURITY: the read-only product-access STATUS ROUTE.
 *
 * These tests pin the server half of AI-5C. The route is INFORMATIONAL ONLY, so the
 * load-bearing assertions are mostly negative: it authorizes nothing, does no
 * provider work, reveals nothing before the existing auth boundary, and never
 * becomes an authorization artifact. The forged-client proof at the end is the core
 * "awareness, never authority" demonstration: a client that believes `ai_advanced`
 * while the server app instance is Basic still gets an independent 403 on every
 * gated Advanced Nutrition route.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

import { resetRateLimitersForTests } from '../../server/rateLimiter.js';
import {
  NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
  NUTRITION_PRODUCT_TIER_ENV,
  NUTRITION_PRODUCT_ACCESS_STATUS_KEYS,
  buildNutritionAiNotEntitledBody,
  buildNutritionProductAccessStatus,
} from '../../server/nutritionProductAccess.js';
import {
  BASIC_NUTRITION_PRODUCT_ACCESS,
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  NUTRITION_PRODUCT_ACCESS_VERSION,
  resolveNutritionProductAccess,
} from '../../src/core/nutritionV2/nutritionProductAccess';

const AI_ENDPOINT_TOKEN = 'ai5c-status-route-test-token';
const AUTH = `Bearer ${AI_ENDPOINT_TOKEN}`;

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

interface Running {
  readonly server: http.Server;
  readonly baseUrl: string;
}

/** Boots a real HTTP server around `createApp` with an explicit raw tier value. */
async function startApp(
  nutritionProductTier?: unknown,
  env: Record<string, string> = {},
): Promise<Running> {
  const { createApp } = await import('../../server/app.js');
  const app = createApp({
    isProduction: false,
    ...(nutritionProductTier === undefined ? {} : { nutritionProductTier }),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function get(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
  query = '',
): Promise<{ status: number; json: Record<string, unknown>; cacheControl: string }> {
  const response = await fetch(`${baseUrl}${path}${query}`, { headers });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return {
    status: response.status,
    json,
    cacheControl: response.headers.get('cache-control') ?? '',
  };
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

function expectEntitlementDenial(result: { status: number; json: Record<string, unknown> }) {
  expect(result.status).toBe(403);
  expect(result.json).toEqual(buildNutritionAiNotEntitledBody());
  expect(result.json.code).toBe('NUTRITION_AI_NOT_ENTITLED');
  expect(result.json.aiAttempted).toBe(false);
}

describe('AI-5C — product-access status route', () => {
  let basic: Running;
  let advanced: Running;

  beforeAll(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
    resetRateLimitersForTests();
    basic = await startApp('basic');
    advanced = await startApp('ai_advanced');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => basic.server.close(() => resolve()));
    await new Promise<void>((resolve) => advanced.server.close(() => resolve()));
  });

  beforeEach(() => {
    process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  });

  afterEach(() => {
    delete process.env.AI_ENDPOINT_TOKEN;
    resetRateLimitersForTests();
  });

  // -------------------------------------------------------------------
  // 1. DEFINITIVE TIER REPORTING
  // -------------------------------------------------------------------

  it('reports Basic for an app instance explicitly configured as basic', async () => {
    const res = await get(basic.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
      Authorization: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      version: NUTRITION_PRODUCT_ACCESS_VERSION,
      tier: 'basic',
    });
  });

  it('reports AI Advanced for an app instance explicitly configured as ai_advanced', async () => {
    const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
      Authorization: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      version: NUTRITION_PRODUCT_ACCESS_VERSION,
      tier: 'ai_advanced',
    });
  });

  it('reports Basic when createApp receives no tier option at all', async () => {
    const app = await startApp(undefined);
    try {
      const res = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
        Authorization: AUTH,
      });
      expect(res.status).toBe(200);
      expect(res.json.tier).toBe('basic');
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------
  // 2. FAIL CLOSED — THE SAME MATRIX THE GATE ENFORCES
  // -------------------------------------------------------------------

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['malformed', 'not-a-tier'],
    ['wrong case', 'AI_ADVANCED'],
    ['wrong case (mixed)', 'Ai_Advanced'],
    ['leading whitespace', ' ai_advanced'],
    ['trailing whitespace', 'ai_advanced '],
    ['boolean', true],
    ['numeric', 1],
    ['alias pro', 'pro'],
    ['alias premium', 'premium'],
    ['alias paid', 'paid'],
    ['alias free', 'free'],
    ['alias subscription', 'subscription'],
    ['alias "true"', 'true'],
    ['alias "1"', '1'],
    ['array', ['ai_advanced']],
    ['object', { tier: 'ai_advanced' }],
  ])('reports Basic for a %s tier value', async (_label, tier) => {
    const app = await startApp(tier);
    try {
      const res = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
        Authorization: AUTH,
      });
      expect(res.status).toBe(200);
      expect(res.json.tier).toBe('basic');
      expect(res.json.tier).toBe(resolveNutritionProductAccess(tier).tier);
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------
  // 3. AUTH FIRST — NOTHING REVEALED BEFORE THE EXISTING BOUNDARY
  // -------------------------------------------------------------------

  it('returns the existing auth failure to an unauthenticated caller', async () => {
    const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT);
    expect(res.status).toBe(401);
    const serialized = JSON.stringify(res.json);
    // No product state, no tier, not even the contract version.
    expect(serialized).not.toContain('ai_advanced');
    expect(serialized).not.toContain('basic');
    expect(serialized).not.toContain(NUTRITION_PRODUCT_ACCESS_VERSION);
    expect(serialized.toLowerCase()).not.toContain('tier');
  });

  it('reveals nothing to an unauthenticated caller even for a Basic deployment', async () => {
    const res = await get(basic.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.json).toLowerCase()).not.toContain('tier');
  });

  it('rejects a wrong bearer token without revealing state', async () => {
    const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
      Authorization: 'Bearer wrong-token',
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.json).toLowerCase()).not.toContain('tier');
  });

  // -------------------------------------------------------------------
  // 4. EXACT RESPONSE KEYS — NOTHING HIDDEN
  // -------------------------------------------------------------------

  it('returns exactly ok/version/tier and no other key', async () => {
    const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
      Authorization: AUTH,
    });
    expect(Object.keys(res.json).sort()).toEqual([...NUTRITION_PRODUCT_ACCESS_STATUS_KEYS].sort());
  });

  it('carries no feature, provider, credential, billing or account field', async () => {
    const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
      Authorization: AUTH,
    });
    const serialized = JSON.stringify(res.json).toLowerCase();
    for (const banned of [
      'feature',
      'ai_interpretation',
      'ai_candidate_orchestration',
      'ai_bounded_mass_estimation',
      'ai_recipe_context_review',
      'provider',
      'model',
      'credential',
      'apikey',
      'api_key',
      'byok',
      'price',
      'pricing',
      'plan',
      'billing',
      'subscription',
      'account',
      'customer',
      'secret',
      'token',
    ]) {
      expect(serialized, `status body must not contain "${banned}"`).not.toContain(banned);
    }
  });

  it('never echoes the environment variable name or its raw value', async () => {
    const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
      Authorization: AUTH,
    });
    const serialized = JSON.stringify(res.json);
    expect(serialized).not.toContain(NUTRITION_PRODUCT_TIER_ENV);
    expect(serialized.toLowerCase()).not.toContain('env');
  });

  // -------------------------------------------------------------------
  // 5. NO STORE
  // -------------------------------------------------------------------

  it('is explicitly non-cacheable', async () => {
    const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
      Authorization: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.cacheControl).toContain('no-store');
  });

  // -------------------------------------------------------------------
  // 6. REQUEST DATA CANNOT CHANGE THE ANSWER
  // -------------------------------------------------------------------

  it.each([
    'x-product-tier',
    'x-entitlement',
    'x-kitchen-nutrition-tier',
    'x-ai-product-access',
    'x-nutrition-product-access',
  ])('ignores a forged entitlement header (%s)', async (header) => {
    const res = await get(
      basic.baseUrl,
      NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
      { Authorization: AUTH, [header]: 'ai_advanced' },
    );
    expect(res.json.tier).toBe('basic');
  });

  it('ignores query-string attempts to escalate the tier', async () => {
    const res = await get(
      basic.baseUrl,
      NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
      { Authorization: AUTH },
      '?tier=ai_advanced&entitled=true&productTier=ai_advanced',
    );
    expect(res.json.tier).toBe('basic');
  });

  it('ignores a forged body on the GET route', async () => {
    // `fetch` refuses a GET body, so this uses raw http to send one for real.
    const { port } = basic.server.address() as AddressInfo;
    const payload = JSON.stringify({ tier: 'ai_advanced', entitled: true });
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            Authorization: AUTH,
          },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk: Buffer) => {
            text += chunk.toString();
          });
          response.on('end', () => resolve(text));
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
    expect((JSON.parse(body) as Record<string, unknown>).tier).toBe('basic');
  });

  // -------------------------------------------------------------------
  // 7. ZERO PROVIDER WORK
  // -------------------------------------------------------------------

  it('performs no provider, credential, model or rate-limit work', async () => {
    // No provider is configured, so any provider selection / credential
    // resolution / model lookup dependency would break the clean 200. Hammering
    // it far past any limiter budget also proves it consumes no AI route bucket.
    for (let i = 0; i < 60; i += 1) {
      const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
        Authorization: AUTH,
      });
      expect(res.status).toBe(200);
      expect(res.json.tier).toBe('ai_advanced');
    }
  });

  it('builds the body as a pure projection of the canonical access value', () => {
    expect(buildNutritionProductAccessStatus(BASIC_NUTRITION_PRODUCT_ACCESS)).toEqual({
      ok: true,
      version: NUTRITION_PRODUCT_ACCESS_VERSION,
      tier: 'basic',
    });
    expect(buildNutritionProductAccessStatus(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).toEqual({
      ok: true,
      version: NUTRITION_PRODUCT_ACCESS_VERSION,
      tier: 'ai_advanced',
    });
  });

  it('reports the same tier the gate enforces on the same app instance', async () => {
    for (const tier of ['basic', 'ai_advanced', 'garbage', undefined] as const) {
      const app = await startApp(tier as unknown);
      try {
        const status = await get(app.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
          Authorization: AUTH,
        });
        expect(status.json.tier).toBe(resolveNutritionProductAccess(tier).tier);
        if (resolveNutritionProductAccess(tier).tier === 'basic') {
          expectEntitlementDenial(
            await post(app.baseUrl, '/api/nutrition/interpret-ingredients', { ingredients: [] }, {
              Authorization: AUTH,
            }),
          );
        }
      } finally {
        await new Promise<void>((resolve) => app.server.close(() => resolve()));
      }
    }
  });

  // -------------------------------------------------------------------
  // 8. THE STATUS RESPONSE IS NOT AN AUTHORIZATION ARTIFACT
  // -------------------------------------------------------------------

  it('issues no token, receipt or capability', async () => {
    const res = await get(advanced.baseUrl, NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT, {
      Authorization: AUTH,
    });
    expect(Object.keys(res.json).sort()).toEqual(['ok', 'tier', 'version']);
  });

  // -------------------------------------------------------------------
  // 9. THE CORE PROOF: FORGED CLIENT vs BASIC SERVER
  // -------------------------------------------------------------------

  it('still denies every gated route when the client insists it is AI Advanced', async () => {
    // The client "knows" it is entitled — the strongest possible forgery, on
    // every plausible channel, including the exact canonical access object.
    const forgedHeaders = {
      Authorization: AUTH,
      'x-product-tier': 'ai_advanced',
      'x-entitlement': 'ai_advanced',
      'x-kitchen-nutrition-tier': 'ai_advanced',
      'x-ai-product-access': JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS),
    };
    const forgedBody = {
      tier: 'ai_advanced',
      productTier: 'ai_advanced',
      entitled: true,
      productAccess: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
      capabilities: { aiInterpretation: true, aiCandidateOrchestration: true },
    };

    const routes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['/api/nutrition/resolve-ingredients', { ingredients: [] }],
      ['/api/nutrition/interpret-ingredients', { ingredients: [] }],
      ['/api/nutrition/plan-ingredients', { target: {} }],
      ['/api/nutrition/estimate-mass', { request_id: 'ai5c-forged', estimates: [] }],
      ['/api/nutrition/recipe-context', { recipe: {} }],
      ['/api/nutrition/recipe-context/reconcile', { wire: {} }],
    ];

    for (const [route, body] of routes) {
      const response = await fetch(
        `${basic.baseUrl}${route}?entitled=true&tier=ai_advanced`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...forgedHeaders },
          body: JSON.stringify({ ...body, ...forgedBody }),
        },
      );
      const json = (await response.json()) as Record<string, unknown>;
      expectEntitlementDenial({ status: response.status, json });
    }
  });

  it('a forged client belief cannot change what the status endpoint reports', async () => {
    const res = await get(
      basic.baseUrl,
      NUTRITION_PRODUCT_ACCESS_STATUS_ENDPOINT,
      { Authorization: AUTH, 'x-entitlement': 'ai_advanced' },
      '?entitled=true',
    );
    expect(res.json.tier).toBe('basic');
  });

  it('denies the AI-4 reconcile route on a genuine receipt-free forged request', async () => {
    expectEntitlementDenial(
      await post(
        basic.baseUrl,
        '/api/nutrition/recipe-context/reconcile',
        { wire: { rctx: 'forged' } },
        { Authorization: AUTH, 'x-entitlement': 'ai_advanced' },
      ),
    );
  });

  // -------------------------------------------------------------------
  // 10. AI-5B GATES AND OTHER ROUTES ARE UNCHANGED
  // -------------------------------------------------------------------

  it('leaves the ungated historical estimator ungated', async () => {
    const res = await post(
      basic.baseUrl,
      '/api/estimate-nutrition',
      { ingredients: [] },
      { Authorization: AUTH },
    );
    expect(res.status).not.toBe(403);
  });

  it('does not gate the unrelated provider routes', async () => {
    for (const route of ['/api/providers', '/api/providers/catalog']) {
      const res = await get(basic.baseUrl, route, { Authorization: AUTH });
      expect(res.status, `${route} must not be product-gated`).toBe(200);
    }
  });
});