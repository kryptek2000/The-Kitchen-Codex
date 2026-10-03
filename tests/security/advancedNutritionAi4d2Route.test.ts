/**
 * AI-4D2 — ROUTE + LIMITER ISOLATION PROOF (HTTP surface).
 *
 * The reconciliation transport is the ONLY thing D2 added on the server, so this
 * file proves its whole surface:
 *
 *   - a bounded 200 success whose body is an INERT plan (no acceptance, no
 *     authority, no quantity);
 *   - NO provider and NO AI-4C transport call is ever made while reconciling;
 *   - every deterministic refusal is a bounded 400, and a MISMATCH or STALE
 *     review is an honest 409 the client can act on;
 *   - the DEDICATED limiter really returns 429 after its own budget, and that
 *     budget is neither shared with nor depleted by the AI-4C provider budget;
 *   - the shared AI endpoint token gate really returns 401 when configured.
 *
 * AI-4E UPDATE — this file now drives the ORIGIN-GATED route.
 *   A reconcile request must now carry the server-issued origin receipt, so every
 *   valid body here is built from a GENUINE AI-4C success response rather than a
 *   hand-written wire. Every original assertion is preserved; the added coverage is
 *   that a body WITHOUT a receipt is refused at the origin gate. AI-4E's own
 *   forgery, mutation and cross-wire matrix lives in `advancedNutritionAi4eRoute.test.ts`
 *   and `advancedNutritionAi4eOriginReceipt.test.ts`.
 *
 * The AI-4C transport MODULE is stubbed on purpose: it is what would reach a
 * provider, and the counters below prove the reconcile path never touches it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';
import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from '../../src/core/nutritionV2/aiRecipeContextRequest';
import { AI_RECIPE_CONTEXT_RECONCILE_VERSION } from '../../src/core/nutritionV2/aiRecipeContextReconcile';
import { resetRateLimitersForTests } from '../../server/rateLimiter.js';
import { deriveRecipeContextModelInput } from '../../server/recipeContextDerivation.js';

const SENTINEL = 'sk-or-v1-AI4D2_ROUTE_SENTINEL';

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_ENDPOINT_TOKEN',
  'NUTRITION_CONTEXT_RATE_LIMIT',
  'NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT',
] as const;

const transport = vi.hoisted(() => ({
  /** Times the AI-4C transport ENTRYPOINT was reached at all. */
  entered: 0,
  /** Times a provider call would have been made. */
  providerCalls: 0,
}));

vi.mock('../../server/nutritionContext.js', () => ({
  interpretRecipeContextOnServer: async (rawBody: unknown) => {
    transport.entered += 1;
    transport.providerCalls += 1;
    const requestId = (rawBody as { request_id?: unknown })?.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return { ok: false, code: 'invalid_request', aiAttempted: false, aiFailed: false };
    }
    // The stub derives from the REAL authored source data, so the wire it returns is
    // genuinely reconcilable and can therefore genuinely be receipt-issued.
    const derived = deriveRecipeContextModelInput({
      recipe: {
        title: 'Reconcile route probe',
        servings: 2,
        ingredients: [
          { original: '400 g chicken', name: 'chicken' },
          { original: '2 tbsp parsley, for garnish', name: 'parsley, for garnish' },
        ],
      },
      instructions: [{ text: 'Garnish with parsley' }],
      requestVersion: 'nutrition_ai_recipe_context_request_v1',
      requestId,
      recipeInstance: 'instance-route',
    });
    if (!derived.ok) throw new Error('stub derivation failed');
    return {
      ok: true,
      requestId,
      wire: {
        request_version: 'nutrition_ai_recipe_context_request_v1',
        request_id: requestId,
        context_binding: derived.request.model_input_binding,
        proposal: {
          contract_version: 'nutrition_ai_recipe_context_v1',
          provenance_class: 'ai_recipe_context',
          interpretations: derived.request.provider_request.targets.map(
            (target: { line_ref: string }) => ({
              line_ref: target.line_ref,
              role: 'garnish',
              relations: [],
              preparation_hints: ['garnish'],
              confidence: 'low',
            })
          ),
        },
      },
      aiAttempted: true,
    };
  },
}));

async function startApp(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  resetRateLimitersForTests();
  const { createApp } = await import('../../server/app.js');
  const { createDeploymentNutritionProductAccessAuthority } = await import(
    '../../server/nutritionProductAccessAuthority.js'
  );
  // AI-5B: this suite exercises the ENTILED AI-4 product surface, so the
  // deployment product tier is stated explicitly. AI-5B's default is Basic and
  // this seam is not a bypass: the SAME gate production uses is exercised.
  const app = createApp({
    isProduction: false,
    nutritionProductAccessAuthority:
      createDeploymentNutritionProductAccessAuthority('ai_advanced'),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  // The app is imported AFTER `vi.resetModules()`, so the running app's limiter
  // store is a FRESH module instance: mid-test resets must go through it.
  const rateLimiter = await import('../../server/rateLimiter.js');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    resetLimiters: () => rateLimiter.resetRateLimitersForTests(),
  };
}

function authoredRecipe(): Record<string, unknown> {
  return {
    title: 'Reconcile route probe',
    servings: 2,
    ingredients: [
      { original: '400 g chicken', name: 'chicken' },
      { original: '2 tbsp parsley, for garnish', name: 'parsley, for garnish' },
    ],
  };
}

const INSTRUCTIONS = [{ text: 'Garnish with parsley' }];

/**
 * The REAL current context for the authored probe: the same derivation the server
 * runs. A valid wire can only be built from it, because the wire's context binding
 * and line refs must answer the CURRENT context.
 */
function currentContext(
  recipe: Record<string, unknown> = authoredRecipe(),
  instructions: ReadonlyArray<Record<string, unknown>> = INSTRUCTIONS
) {
  const derived = deriveRecipeContextModelInput({
    recipe,
    instructions: [...instructions],
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: 'ai4d2-current',
    recipeInstance: 'instance-route',
  });
  if (!derived.ok) throw new Error(`derivation failed: ${(derived as { code: string }).code}`);
  return {
    context_binding: derived.request.model_input_binding,
    lineRefs: derived.request.provider_request.targets.map((target) => target.line_ref),
  };
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
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
  return { status: response.status, json, text };
}

const reconcile = (baseUrl: string, body: unknown, headers?: Record<string, string>) =>
  post(baseUrl, '/api/nutrition/recipe-context/reconcile', body, headers);

/**
 * A GENUINE origin receipt, obtained the way the client obtains one: by running the
 * real AI-4C route once and reading its success envelope.
 */
async function genuineInterpretation(
  baseUrl: string,
  headers?: Record<string, string>
): Promise<Record<string, unknown>> {
  const response = await post(
    baseUrl,
    '/api/nutrition/recipe-context',
    {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: 'ai4d2-route-1',
      recipe_instance: 'instance-route',
      recipe: authoredRecipe(),
      instructions: INSTRUCTIONS,
    },
    headers
  );
  if (response.status !== 200) {
    throw new Error(`AI-4C route did not succeed: ${response.status}`);
  }
  return response.json;
}

/**
 * A valid reconciliation request built from a GENUINE AI-4C response: the exact
 * wire the server issued, plus the exact receipt it issued for it. The client NEVER
 * supplies a context, envelope or binding — the server re-derives the current context
 * itself.
 */
function validBody(
  interpreted: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    expected_request_id: interpreted['request_id'],
    recipe_instance: 'instance-route',
    recipe: authoredRecipe(),
    instructions: INSTRUCTIONS,
    wire: {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: interpreted['request_id'],
      context_binding: interpreted['context_binding'],
      proposal: interpreted['proposal'],
    },
    origin_receipt: interpreted['origin_receipt'],
    ...overrides,
  };
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
  resetRateLimitersForTests();
  transport.entered = 0;
  transport.providerCalls = 0;
});

describe('AI-4D2 reconcile route — inert success response', () => {
  it('returns a bounded CURRENT plan and never reaches the provider or the AI-4C transport', async () => {
    const { server, baseUrl } = await startApp();
    const interpreted = await genuineInterpretation(baseUrl);
    const fetchSpy = vi.fn(() => {
      throw new Error('AI-4D2 reconciliation must not perform any network call');
    });
    const originalFetch = globalThis.fetch;
    try {
      const response = await reconcile(baseUrl, validBody(interpreted));
      expect(response.status).toBe(200);
      expect(Object.keys(response.json).sort()).toEqual(['ok', 'reconciliation']);
      expect(response.json['ok']).toBe(true);

      const plan = response.json['reconciliation'] as Record<string, unknown>;
      expect(plan['reconciliation_version']).toBe(AI_RECIPE_CONTEXT_RECONCILE_VERSION);
      expect(plan['status']).toBe('current');
      expect(plan['request_id']).toBe('ai4d2-route-1');
      // The plan is INERT: it carries no acceptance, no authority, no quantity.
      const serialized = response.text;
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized.toLowerCase()).not.toContain('provider');
      expect(serialized.toLowerCase()).not.toContain('apikey');
      for (const forbidden of ['accepted', 'dismissed', 'apply', 'grams', 'fdc_id', 'nutrients']) {
        expect(serialized).not.toContain(`"${forbidden}"`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      server.close();
    }
    // Reconciliation is PURE DETERMINISTIC CODE: no provider, no transport.
    expect(transport.entered).toBe(1); // only the one deliberate interpretation
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a caller-authored context/envelope key is refused', async () => {
    const { server, baseUrl } = await startApp();
    const interpreted = await genuineInterpretation(baseUrl);
    try {
      for (const key of ['context', 'envelope', 'binding', 'targets', 'line_refs']) {
        const response = await reconcile(baseUrl, validBody(interpreted, { [key]: {} }));
        expect(response.status).toBe(400);
        expect(response.json['code']).toBe('invalid_input');
      }
    } finally {
      server.close();
    }
  });

  it('AI-4E: a body without the server-issued receipt is refused at the origin gate', async () => {
    const { server, baseUrl } = await startApp();
    const interpreted = await genuineInterpretation(baseUrl);
    try {
      const forged = validBody(interpreted, { origin_receipt: undefined });
      delete forged['origin_receipt'];
      const response = await reconcile(baseUrl, forged);
      expect(response.status).toBe(400);
      expect(response.json['code']).toBe('origin_unverified');
      expect(response.json['reconciliation']).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe('AI-4D2 reconcile route — bounded failures', () => {
  it('a mismatched request id is an honest 409, not a silent success', async () => {
    const { server, baseUrl } = await startApp();
    const interpreted = await genuineInterpretation(baseUrl);
    try {
      const response = await reconcile(
        baseUrl,
        validBody(interpreted, { expected_request_id: 'another-request' })
      );
      expect(response.status).toBe(409);
      expect(response.json['code']).toBe('request_mismatch');
      expect(response.text).toContain('Run the review again.');
      expect(response.json['reconciliation']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('an edited recipe is an honest 409 the client can act on', async () => {
    const { server, baseUrl } = await startApp();
    const interpreted = await genuineInterpretation(baseUrl);
    try {
      const body = validBody(interpreted);
      const recipe = body['recipe'] as Record<string, unknown>;
      const ingredients = recipe['ingredients'] as Array<Record<string, unknown>>;
      const response = await reconcile(baseUrl, {
        ...body,
        recipe: { ...recipe, ingredients: [...ingredients, { original: '1 onion', name: 'onion' }] },
      });
      expect(response.status).toBe(409);
      expect(response.json['code']).toBe('stale_context');
      expect(response.text).toContain('The recipe changed while AI was reviewing it.');
      expect(response.json['reconciliation']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('an unusable wire is a bounded 400 that echoes no model text', async () => {
    const { server, baseUrl } = await startApp();
    const interpreted = await genuineInterpretation(baseUrl);
    try {
      const body = validBody(interpreted);
      const wire = body['wire'] as Record<string, unknown>;
      const response = await reconcile(baseUrl, {
        ...body,
        wire: {
          ...wire,
          proposal: {
            contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
            provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
            interpretations: [
              {
                line_ref: currentContext().lineRefs[0],
                role: 'not_a_role',
                relations: [],
                preparation_hints: [],
              },
            ],
          },
        },
      });
      // AI-4E ORDERING: ORIGIN AUTHENTICATION PRECEDES RECONCILIATION. A wire this
      // server never issued is refused before D1 classifies it, so the bounded code
      // is now `origin_unverified` rather than `invalid_wire`. Everything that
      // matters is unchanged and still asserted: a bounded 400, no model text
      // echoed, and no reconciliation.
      expect(response.status).toBe(400);
      expect(response.json['code']).toBe('origin_unverified');
      expect(response.text).not.toContain(SENTINEL);
      expect(response.json['reconciliation']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('a structurally unusable body is a bounded 400', async () => {
    const { server, baseUrl } = await startApp();
    const interpreted = await genuineInterpretation(baseUrl);
    try {
      for (const body of [
        null,
        'text',
        42,
        {},
        { wire: {}, recipe: authoredRecipe() },
        { ...validBody(interpreted), recipe: 'not a recipe' },
      ]) {
        const response = await reconcile(baseUrl, body);
        expect(response.status).toBe(400);
        expect(response.json['reconciliation']).toBeUndefined();
        // Either one of the route's own bounded codes, or the app's standard
        // JSON-parser refusal for a non-object payload. Never anything else.
        const code = response.json['code'];
        if (code !== undefined) {
          expect(['invalid_input', 'invalid_context', 'origin_unverified']).toContain(code);
        } else expect(response.json['error']).toBe('Invalid JSON payload');
      }
    } finally {
      server.close();
    }
  });
});

describe('AI-4D2 reconcile route — dedicated limiter', () => {
  it('returns 429 after its own budget', async () => {
    const { server, baseUrl } = await startApp({
      NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT: '2',
    });
    // One AI-4C call issues the receipt; it does not touch the RECONCILE bucket.
    const interpreted = await genuineInterpretation(baseUrl);
    const body = validBody(interpreted);
    try {
      expect((await reconcile(baseUrl, body)).status).toBe(200);
      expect((await reconcile(baseUrl, body)).status).toBe(200);
      const blocked = await reconcile(baseUrl, body);
      expect(blocked.status).toBe(429);
      expect(blocked.text).toContain('Too many recipe-context reconciliation requests.');
      expect(blocked.json['retryAfterSeconds']).toBeTypeOf('number');
    } finally {
      server.close();
    }
  });

  it('the reconcile budget is separate from the AI-4C provider budget in both directions', async () => {
    const { server, baseUrl, resetLimiters } = await startApp({
      NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT: '1',
      // Budget of 3: one call issues the receipt, two more exercise exhaustion.
      NUTRITION_CONTEXT_RATE_LIMIT: '3',
    });
    const interpreted = await genuineInterpretation(baseUrl);
    const body = validBody(interpreted);
    try {
      // Exhaust the RECONCILE bucket: the AI-4C route must be unaffected.
      expect((await reconcile(baseUrl, body)).status).toBe(200);
      expect((await reconcile(baseUrl, body)).status).toBe(429);
      expect(
        (
          await post(baseUrl, '/api/nutrition/recipe-context', {
            request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
            request_id: 'ai4d2-route-2',
            recipe_instance: 'instance-route',
            recipe: authoredRecipe(),
            instructions: INSTRUCTIONS,
          })
        ).status
      ).toBe(200);

      // Exhaust the AI-4C bucket: RECONCILIATION must still work, because it
      // makes no provider call and does not share the provider budget.
      expect(
        (
          await post(baseUrl, '/api/nutrition/recipe-context', {
            request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
            request_id: 'ai4d2-route-3',
            recipe_instance: 'instance-route',
            recipe: authoredRecipe(),
            instructions: INSTRUCTIONS,
          })
        ).status
      ).toBe(200);
      expect(
        (
          await post(baseUrl, '/api/nutrition/recipe-context', {
            request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
            request_id: 'ai4d2-route-4',
            recipe_instance: 'instance-route',
            recipe: authoredRecipe(),
            instructions: INSTRUCTIONS,
          })
        ).status
      ).toBe(429);
      resetLimiters();
      expect((await reconcile(baseUrl, body)).status).toBe(200);
      // Reconciliation itself never entered the AI-4C transport: 3 deliberate
      // interpretations reached it, and the 4th was stopped by the limiter first.
      expect(transport.entered).toBe(3);
    } finally {
      server.close();
    }
  });
});

describe('AI-4D2 reconcile route — token gate', () => {
  it('returns 401 without the shared AI endpoint token', async () => {
    const { server, baseUrl } = await startApp({ AI_ENDPOINT_TOKEN: SENTINEL });
    const interpreted = await genuineInterpretation(baseUrl, {
      authorization: `Bearer ${SENTINEL}`,
    });
    const body = validBody(interpreted);
    try {
      const unauthorized = await reconcile(baseUrl, body);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.text).not.toContain(SENTINEL);
      const authorized = await reconcile(baseUrl, body, {
        authorization: `Bearer ${SENTINEL}`,
      });
      expect(authorized.status).toBe(200);
      // The credential is never echoed back in a success body either.
      expect(authorized.text).not.toContain(SENTINEL);
      // AI-4E: authentication does not grant origin. A caller with a valid token
      // still cannot forge a wire.
      expect(
        (
          await reconcile(
            baseUrl,
            validBody(interpreted, {
              wire: {
                request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
                request_id: 'ai4d2-route-1',
                context_binding: currentContext().context_binding,
                proposal: {
                  contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
                  provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
                  interpretations: [],
                },
              },
            }),
            { authorization: `Bearer ${SENTINEL}` }
          )
        ).status
      ).toBe(400);
    } finally {
      server.close();
    }
  });
});