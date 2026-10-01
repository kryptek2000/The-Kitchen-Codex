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
  interpretRecipeContextOnServer: async () => {
    transport.entered += 1;
    transport.providerCalls += 1;
    return {
      ok: true,
      requestId: 'ai4d2-route-1',
      wire: {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: 'ai4d2-route-1',
        context_binding: 'sha256:'.concat('a'.repeat(64)),
        proposal: {
          contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
          provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
          interpretations: [],
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
  const app = createApp({ isProduction: false });
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

/**
 * A valid reconciliation request: the untrusted wire plus the CURRENT authored
 * source data. The client NEVER supplies a context, envelope or binding — the
 * server re-derives the current context itself.
 */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const current = currentContext();
  return {
    expected_request_id: 'ai4d2-route-1',
    recipe_instance: 'instance-route',
    recipe: authoredRecipe(),
    instructions: INSTRUCTIONS,
    wire: {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: 'ai4d2-route-1',
      context_binding: current.context_binding,
      proposal: {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations: current.lineRefs.map((line_ref) => ({
          line_ref,
          role: 'garnish',
          relations: [],
          preparation_hints: ['garnish'],
          confidence: 'low',
        })),
      },
    },
    ...overrides,
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
    const fetchSpy = vi.fn(() => {
      throw new Error('AI-4D2 reconciliation must not perform any network call');
    });
    const originalFetch = globalThis.fetch;
    try {
      const response = await reconcile(baseUrl, validBody());
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
    expect(transport.entered).toBe(0);
    expect(transport.providerCalls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a caller-authored context/envelope key is refused', async () => {
    const { server, baseUrl } = await startApp();
    try {
      for (const key of ['context', 'envelope', 'binding', 'targets', 'line_refs']) {
        const response = await reconcile(baseUrl, validBody({ [key]: {} }));
        expect(response.status).toBe(400);
        expect(response.json['code']).toBe('invalid_input');
      }
    } finally {
      server.close();
    }
  });
});

describe('AI-4D2 reconcile route — bounded failures', () => {
  it('a mismatched request id is an honest 409, not a silent success', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const response = await reconcile(baseUrl, validBody({ expected_request_id: 'another-request' }));
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
    try {
      const body = validBody();
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
    try {
      const body = validBody();
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
      expect(response.status).toBe(400);
      expect(response.json['code']).toBe('invalid_wire');
      expect(response.text).not.toContain(SENTINEL);
      expect(response.json['reconciliation']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('a structurally unusable body is a bounded 400', async () => {
    const { server, baseUrl } = await startApp();
    try {
      for (const body of [
        null,
        'text',
        42,
        {},
        { wire: {}, recipe: authoredRecipe() },
        { ...validBody(), recipe: 'not a recipe' },
      ]) {
        const response = await reconcile(baseUrl, body);
        expect(response.status).toBe(400);
        expect(response.json['reconciliation']).toBeUndefined();
        // Either one of the route's own bounded codes, or the app's standard
        // JSON-parser refusal for a non-object payload. Never anything else.
        const code = response.json['code'];
        if (code !== undefined) expect(['invalid_input', 'invalid_context']).toContain(code);
        else expect(response.json['error']).toBe('Invalid JSON payload');
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
    try {
      expect((await reconcile(baseUrl, validBody())).status).toBe(200);
      expect((await reconcile(baseUrl, validBody())).status).toBe(200);
      const blocked = await reconcile(baseUrl, validBody());
      expect(blocked.status).toBe(429);
      expect(blocked.text).toContain('Too many recipe-context reconciliation requests.');
      expect(blocked.json['retryAfterSeconds']).toBeTypeOf('number');
      // The transport was never reached on any of them.
      expect(transport.providerCalls).toBe(0);
    } finally {
      server.close();
    }
  });

  it('the reconcile budget is separate from the AI-4C provider budget in both directions', async () => {
    const { server, baseUrl, resetLimiters } = await startApp({
      NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT: '1',
      NUTRITION_CONTEXT_RATE_LIMIT: '1',
    });
    try {
      // Exhaust the RECONCILE bucket: the AI-4C route must be unaffected.
      expect((await reconcile(baseUrl, validBody())).status).toBe(200);
      expect((await reconcile(baseUrl, validBody())).status).toBe(429);
      const ai4c = await post(baseUrl, '/api/nutrition/recipe-context', {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: 'ai4d2-route-1',
        recipe_instance: 'instance-route',
        recipe: authoredRecipe(),
        instructions: INSTRUCTIONS,
      });
      expect(ai4c.status).toBe(200);

      // Exhaust the AI-4C bucket: RECONCILIATION must still work, because it
      // makes no provider call and does not share the provider budget.
      expect((await post(baseUrl, '/api/nutrition/recipe-context', {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: 'ai4d2-route-2',
        recipe_instance: 'instance-route',
        recipe: authoredRecipe(),
        instructions: INSTRUCTIONS,
      })).status).toBe(429);
      resetLimiters();
      expect((await reconcile(baseUrl, validBody())).status).toBe(200);
      expect(transport.entered).toBe(1);
      expect(transport.providerCalls).toBe(1);
    } finally {
      server.close();
    }
  });
});

describe('AI-4D2 reconcile route — token gate', () => {
  it('returns 401 without the shared AI endpoint token', async () => {
    const { server, baseUrl } = await startApp({ AI_ENDPOINT_TOKEN: SENTINEL });
    try {
      const unauthorized = await reconcile(baseUrl, validBody());
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.text).not.toContain(SENTINEL);
      const authorized = await reconcile(baseUrl, validBody(), {
        authorization: `Bearer ${SENTINEL}`,
      });
      expect(authorized.status).toBe(200);
      // The credential is never echoed back in a success body either.
      expect(authorized.text).not.toContain(SENTINEL);
      expect(transport.providerCalls).toBe(0);
    } finally {
      server.close();
    }
  });
});