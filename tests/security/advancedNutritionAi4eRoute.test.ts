/**
 * AI-4E — ORIGIN RECEIPT OVER THE REAL HTTP SURFACE.
 *
 * `advancedNutritionAi4eOriginReceipt.test.ts` proves the authority in isolation.
 * This file proves the CHAIN, end to end, through the actual Express routes:
 *
 *   L. the LEGITIMATE two-step flow: AI-4C issues a receipt, the client transports
 *      it unchanged, the reconcile route verifies it, and D1 then proves currentness;
 *   C. the FORGED I-1 wire is refused at the public route and CURRENT is unreachable;
 *   S. the token gate still applies to BOTH routes, and the receipt does not replace
 *      endpoint auth;
 *   O. reconciliation still performs ZERO provider calls, and works with the
 *      provider layer made unavailable;
 *   N. the Basic/non-entitled path obtains zero receipts;
 *   R. every origin failure is one bounded public class with no internal detail.
 *
 * The AI-4C transport MODULE is stubbed so the provider is never contacted; the stub
 * returns a wire built from the REAL server derivation, which is the only way a
 * legitimate reconcile can reach CURRENT.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

const SENTINEL = 'sk-or-v1-AI4E_ROUTE_SENTINEL';

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_ENDPOINT_TOKEN',
  'NUTRITION_CONTEXT_RATE_LIMIT',
  'NUTRITION_CONTEXT_RECONCILE_RATE_LIMIT',
] as const;

const transport = vi.hoisted(() => ({ entered: 0, providerCalls: 0, reject: false }));

/**
 * The REAL current context for the authored probe. The stubbed AI-4C route returns
 * a wire built from exactly this derivation, which is what makes a genuine receipt
 * and a CURRENT reconciliation possible.
 */
vi.mock('../../server/nutritionContext.js', () => ({
  interpretRecipeContextOnServer: async (rawBody: unknown) => {
    transport.entered += 1;
    // The real transport echoes the SERVER-VALIDATED request id; so does the stub, so
    // two different requests genuinely produce two different wires.
    const requestId = (rawBody as { request_id?: unknown })?.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return { ok: false, code: 'invalid_request', aiAttempted: false, aiFailed: false };
    }
    if (transport.reject) {
      return { ok: false, code: 'provider_error', aiAttempted: true, aiFailed: true };
    }
    transport.providerCalls += 1;
    const derived = deriveRecipeContextModelInput({
      recipe: {
        title: 'Origin receipt probe',
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
    const targets = derived.request.provider_request.targets;
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
          interpretations: targets.map((target: { line_ref: string }) => ({
            line_ref: target.line_ref,
            role: 'garnish',
            relations: [],
            preparation_hints: ['garnish'],
            confidence: 'low',
          })),
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

const AUTHORED = {
  title: 'Origin receipt probe',
  servings: 2,
  ingredients: [
    { original: '400 g chicken', name: 'chicken' },
    { original: '2 tbsp parsley, for garnish', name: 'parsley, for garnish' },
  ],
};
const INSTRUCTIONS = [{ text: 'Garnish with parsley' }];

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

/** Calls the AI-4C route and returns its success body (which carries the receipt). */
async function interpret(
  baseUrl: string,
  headers?: Record<string, string>,
  requestId = 'ai4e-route-1'
) {
  return post(
    baseUrl,
    '/api/nutrition/recipe-context',
    {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: requestId,
      recipe_instance: 'instance-route',
      recipe: AUTHORED,
      instructions: INSTRUCTIONS,
    },
    headers
  );
}

/** The legitimate reconcile body built from a GENUINE AI-4C success response. */
function legitimateBody(
  response: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    expected_request_id: response['request_id'],
    recipe_instance: 'instance-route',
    recipe: AUTHORED,
    instructions: INSTRUCTIONS,
    wire: {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: response['request_id'],
      context_binding: response['context_binding'],
      proposal: response['proposal'],
    },
    origin_receipt: response['origin_receipt'],
    ...overrides,
  };
}

/** The FORGED I-1 shape: a contract-valid wire built with NO provider execution. */
function forgedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const derived = deriveRecipeContextModelInput({
    recipe: AUTHORED,
    instructions: INSTRUCTIONS,
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: 'ai4e-forged',
    recipeInstance: 'instance-route',
  });
  if (!derived.ok) throw new Error('forgery derivation failed');
  return {
    expected_request_id: 'ai4e-forged',
    recipe_instance: 'instance-route',
    recipe: AUTHORED,
    instructions: INSTRUCTIONS,
    wire: {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: 'ai4e-forged',
      // The attacker can reproduce this deterministically: it is a content hash.
      context_binding: derived.request.model_input_binding,
      proposal: {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations: derived.request.provider_request.targets.map(
          (target: { line_ref: string }) => ({
            line_ref: target.line_ref,
            role: 'main',
            relations: [],
            preparation_hints: ['divided'],
            confidence: 'high',
          })
        ),
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  transport.entered = 0;
  transport.providerCalls = 0;
  transport.reject = false;
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
  resetRateLimitersForTests();
});

// ---------------------------------------------------------------------------
// A/L. ISSUE + LEGITIMATE TWO-STEP FLOW
// ---------------------------------------------------------------------------

describe('AI-4E legitimate flow — issue, transport, verify, reconcile', () => {
  it('a genuine AI-4C success carries exactly one receipt and reaches CURRENT', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const interpreted = await interpret(baseUrl);
      expect(interpreted.status).toBe(200);
      expect(interpreted.json['ok']).toBe(true);
      // The closed success envelope gained exactly one field, and nothing else.
      expect(Object.keys(interpreted.json).sort()).toEqual([
        'aiAttempted',
        'context_binding',
        'ok',
        'origin_receipt',
        'proposal',
        'request_id',
      ]);
      const receipt = interpreted.json['origin_receipt'];
      expect(typeof receipt).toBe('string');
      expect(String(receipt).startsWith('rctx1.')).toBe(true);

      const reconciled = await reconcile(baseUrl, legitimateBody(interpreted.json));
      expect(reconciled.status).toBe(200);
      const plan = reconciled.json['reconciliation'] as Record<string, unknown>;
      expect(plan['status']).toBe('current');
      expect(plan['reconciliation_version']).toBe(AI_RECIPE_CONTEXT_RECONCILE_VERSION);
      expect(plan['request_id']).toBe('ai4e-route-1');
      // Exactly one provider operation for the whole legitimate flow.
      expect(transport.providerCalls).toBe(1);
    } finally {
      server.close();
    }
  });

  it('a FAILED AI-4C result receives NO receipt', async () => {
    const { server, baseUrl } = await startApp();
    transport.reject = true;
    try {
      const failed = await interpret(baseUrl);
      expect(failed.status).toBe(503);
      expect(failed.json['origin_receipt']).toBeUndefined();
      expect(failed.text).not.toContain('rctx1');
      expect(transport.entered).toBe(1);
    } finally {
      server.close();
    }
  });

  it('a receipt issued by a DIFFERENT app instance (restart) is refused', async () => {
    const first = await startApp();
    const receipt = (await interpret(first.baseUrl)).json['origin_receipt'];
    first.server.close();
    // A brand new application instance has a brand new key.
    const second = await startApp();
    try {
      const interpreted = await interpret(second.baseUrl);
      expect(interpreted.status).toBe(200);
      const body = legitimateBody(interpreted.json, { origin_receipt: receipt });
      const response = await reconcile(second.baseUrl, body);
      expect(response.status).toBe(400);
      expect(response.json['code']).toBe('origin_unverified');
    } finally {
      second.server.close();
    }
  });

  it('D1 still proves currentness AFTER origin passes (an edited recipe is 409)', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const interpreted = await interpret(baseUrl);
      const edited = {
        ...AUTHORED,
        ingredients: [...AUTHORED.ingredients, { original: '1 onion', name: 'onion' }],
      };
      const response = await reconcile(
        baseUrl,
        legitimateBody(interpreted.json, { recipe: edited })
      );
      expect(response.status).toBe(409);
      expect(response.json['code']).toBe('stale_context');
      expect(response.json['reconciliation']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('a receipt cannot be moved to a different request id (correlation is still D1\'s)', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const interpreted = await interpret(baseUrl);
      // The receipt is bound to request_id `ai4e-route-1`, so renaming the wire's
      // request id breaks the MAC and origin fails BEFORE D1 correlation.
      const body = legitimateBody(interpreted.json);
      const wire = body['wire'] as Record<string, unknown>;
      const renamed = await reconcile(baseUrl, {
        ...body,
        wire: { ...wire, request_id: 'ai4e-renamed' },
      });
      expect(renamed.status).toBe(400);
      expect(renamed.json['code']).toBe('origin_unverified');

      // A genuine receipt is bound to its OWN wire. Request B is a real, separate
      // AI-4C execution with a real receipt; swapping in A's receipt must fail, and
      // the ONLY thing that can catch it is the origin MAC (D1 correlation would pass,
      // because B's own request id is consistent within B's body).
      const other = await interpret(baseUrl, undefined, 'ai4e-route-2');
      expect(other.status).toBe(200);
      expect(other.json['origin_receipt']).not.toBe(interpreted.json['origin_receipt']);
      const crossed = await reconcile(
        baseUrl,
        legitimateBody(other.json, { origin_receipt: interpreted.json['origin_receipt'] })
      );
      expect(crossed.status).toBe(400);
      expect(crossed.json['code']).toBe('origin_unverified');
      // And B's own receipt works, proving B's wire was genuinely issued.
      expect((await reconcile(baseUrl, legitimateBody(other.json))).status).toBe(200);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// C. FORGED I-1 REPRODUCTION AT THE PUBLIC ROUTE
// ---------------------------------------------------------------------------

describe('AI-4E forged wire — I-1 is closed at the public route', () => {
  it('a fabricated contract-valid wire WITHOUT provider execution cannot reach CURRENT', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const response = await reconcile(baseUrl, forgedBody());
      expect(response.status).toBe(400);
      expect(response.json['code']).toBe('origin_unverified');
      expect(response.json['reconciliation']).toBeUndefined();
      // No provider was involved anywhere in the attempt.
      expect(transport.entered).toBe(0);
      expect(transport.providerCalls).toBe(0);
    } finally {
      server.close();
    }
  });

  it('the same forged wire is refused with a random, malformed or foreign receipt', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const forged = forgedBody();
      const foreign = (await interpret(baseUrl)).json['origin_receipt'];
      for (const origin_receipt of [
        undefined,
        '',
        'nope',
        'rctx1.',
        'rctx1.tooshort',
        `rctx1.${'A'.repeat(43)}`,
        `rctx0.${'A'.repeat(43)}`,
        `${'A'.repeat(50)}`,
        foreign,
        { not: 'a string' },
        12345,
        ['rctx1.' + 'A'.repeat(43)],
      ]) {
        const response = await reconcile(
          baseUrl,
          origin_receipt === undefined ? forged : { ...forged, origin_receipt }
        );
        expect(response.status, `receipt ${String(origin_receipt)} must be refused`).toBe(400);
        if (response.json['code'] !== undefined) {
          expect(
            ['origin_unverified', 'invalid_input'],
            `unexpected code for ${String(origin_receipt)}`
          ).toContain(response.json['code']);
        }
        expect(response.json['reconciliation']).toBeUndefined();
      }
    } finally {
      server.close();
    }
  });

  it('a genuine receipt is useless against a DIFFERENT wire', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const genuine = (await interpret(baseUrl)).json['origin_receipt'];
      // Swap the wire but keep the receipt: origin must fail.
      const response = await reconcile(baseUrl, forgedBody({ origin_receipt: genuine }));
      expect(response.status).toBe(400);
      expect(response.json['code']).toBe('origin_unverified');
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// R. PUBLIC ERROR BOUNDARY
// ---------------------------------------------------------------------------

describe('AI-4E origin failure — one bounded public class', () => {
  it('a missing receipt and a wrong receipt are indistinguishable to the caller', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const interpreted = await interpret(baseUrl);
      const body = legitimateBody(interpreted.json);

      const missing = await reconcile(baseUrl, { ...body, origin_receipt: undefined });
      const wrong = await reconcile(baseUrl, {
        ...body,
        origin_receipt: `rctx1.${'z'.repeat(43)}`,
      });
      expect(missing.status).toBe(wrong.status);
      expect(missing.json['code']).toBe('origin_unverified');
      expect(wrong.json['code']).toBe(missing.json['code']);
      expect(wrong.json['error']).toBe(missing.json['error']);
      // No MAC, secret, hash, payload or parser detail anywhere in the response.
      for (const response of [missing, wrong]) {
        expect(response.text).not.toContain(SENTINEL);
        expect(response.text.toLowerCase()).not.toContain('hmac');
        expect(response.text.toLowerCase()).not.toContain('secret');
        expect(response.text.toLowerCase()).not.toContain('sha256');
        expect(response.text).not.toContain('rctx1.');
        expect(response.text).not.toContain('timing');
        expect(response.text).not.toMatch(/[A-Za-z]:\\|\/home\/|\.ts:\d+/);
        expect(response.text).not.toContain('Error:');
      }
    } finally {
      server.close();
    }
  });

  it('origin failure never masquerades as staleness', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const response = await reconcile(baseUrl, forgedBody());
      expect(response.json['code']).not.toBe('stale_context');
      expect(response.json['code']).not.toBe('request_mismatch');
      expect(response.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('a caller-authored context/envelope/binding key is still refused by name', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const interpreted = await interpret(baseUrl);
      const body = legitimateBody(interpreted.json);
      for (const key of ['context', 'envelope', 'binding', 'targets', 'line_refs']) {
        const response = await reconcile(baseUrl, { ...body, [key]: {} });
        expect(response.status, `key ${key} must be refused`).toBe(400);
        expect(response.json['code']).toBe('invalid_input');
      }
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// S. ROUTE AUTH
// ---------------------------------------------------------------------------

describe('AI-4E token gate — the receipt does NOT replace endpoint auth', () => {
  it('returns 401 without the shared AI endpoint token on BOTH routes', async () => {
    const { server, baseUrl } = await startApp({ AI_ENDPOINT_TOKEN: SENTINEL });
    try {
      const forged = forgedBody();
      const unauthorizedReconcile = await reconcile(baseUrl, forged);
      expect(unauthorizedReconcile.status).toBe(401);
      expect(unauthorizedReconcile.text).not.toContain(SENTINEL);

      const unauthorizedInterpret = await interpret(baseUrl);
      expect(unauthorizedInterpret.status).toBe(401);
      expect(unauthorizedInterpret.text).not.toContain(SENTINEL);

      const headers = { authorization: `Bearer ${SENTINEL}` };
      const interpreted = await interpret(baseUrl, headers);
      expect(interpreted.status).toBe(200);
      const authorized = await reconcile(baseUrl, legitimateBody(interpreted.json), headers);
      expect(authorized.status).toBe(200);
      // The credential is never echoed, and no receipt is leaked with it.
      expect(authorized.text).not.toContain(SENTINEL);
      expect(interpreted.text).not.toContain(SENTINEL);
      // Auth does not grant origin: an unauthorized caller still cannot forge.
      expect((await reconcile(baseUrl, forgedBody(), headers)).status).toBe(400);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// O. PROVIDER ISOLATION + N. BASIC TIER
// ---------------------------------------------------------------------------

describe('AI-4E reconcile route stays provider-free and Basic stays zero-receipt', () => {
  it('receipt verification plus D1 reconciliation works with the provider unavailable', async () => {
    const { server, baseUrl } = await startApp();
    // Obtain a GENUINE receipt first, then make the whole AI-4C path unavailable.
    const interpreted = await interpret(baseUrl);
    expect(interpreted.status).toBe(200);
    const receipt = interpreted.json['origin_receipt'];

    transport.reject = true;
    const enteredBefore = transport.entered;
    const providerCallsBefore = transport.providerCalls;

    // Record every outbound URL. Reconciliation is LOCAL CRYPTOGRAPHY plus pure
    // deterministic code: it may talk to the app itself and to nothing else.
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
      urls.push(url);
      return originalFetch(input as never, init as never);
    }) as never;
    try {
      const reconciled = await reconcile(baseUrl, legitimateBody(interpreted.json));
      expect(reconciled.status).toBe(200);
      expect((reconciled.json['reconciliation'] as Record<string, unknown>)['status']).toBe('current');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The AI-4C transport was never re-entered, so verification + D1 reconciliation
    // needed no provider: origin authentication is LOCAL CRYPTOGRAPHY.
    expect(transport.entered).toBe(enteredBefore);
    expect(transport.providerCalls).toBe(providerCallsBefore);
    // And nothing left the machine.
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(`http://127.0.0.1:`), `unexpected outbound request: ${url}`).toBe(true);
    }
    server.close();
  });

  it('a caller with no issued receipt can never reach CURRENT from deterministic endpoints alone', async () => {
    const { server, baseUrl } = await startApp();
    try {
      // Simulate a Basic / non-entitled / unavailable-capability world: the AI-4C
      // path fails, so NO receipt exists anywhere.
      transport.reject = true;
      const interpreted = await interpret(baseUrl);
      expect(interpreted.status).toBe(503);
      expect(interpreted.json['origin_receipt']).toBeUndefined();
      expect(interpreted.text).not.toContain('rctx1');
      expect(transport.providerCalls).toBe(0);

      // Hitting the deterministic reconcile endpoint alone gets nothing.
      const response = await reconcile(baseUrl, forgedBody());
      expect(response.status).toBe(400);
      expect(response.json['code']).toBe('origin_unverified');
      expect(JSON.stringify(response.json)).not.toContain('rctx1');
      expect(transport.entered).toBe(1); // only the failed AI-4C attempt
      expect(transport.providerCalls).toBe(0);
    } finally {
      server.close();
    }
  });

});

// ---------------------------------------------------------------------------
// T. RECEIPT IS NOT NUTRITION PROVENANCE
// ---------------------------------------------------------------------------

describe('AI-4E receipt is not nutrition provenance', () => {
  it('the receipt never appears in the inert plan or the response beyond the field itself', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const interpreted = await interpret(baseUrl);
      const reconciled = await reconcile(baseUrl, legitimateBody(interpreted.json));
      expect(reconciled.status).toBe(200);
      // The plan is INERT: no receipt, no MAC, no authority, no quantity.
      expect(Object.keys(reconciled.json).sort()).toEqual(['ok', 'reconciliation']);
      expect(reconciled.text).not.toContain('rctx1.');
      expect(reconciled.text).not.toContain('hmac');
      const plan = JSON.stringify(reconciled.json['reconciliation']);
      for (const forbidden of [
        'origin_receipt',
        'receipt',
        'provenance_class',
        'fdc_id',
        'grams',
        'nutrients',
        'authenticated',
      ]) {
        expect(plan.toLowerCase()).not.toContain(forbidden);
      }
      // The provenance class is still the NON-authenticated one.
      expect(AI_RECIPE_CONTEXT_PROVENANCE_CLASS).toBe('ai_recipe_context');
      const proposal = interpreted.json['proposal'] as Record<string, unknown>;
      expect(proposal['provenance_class']).toBe('ai_recipe_context');
      // The receipt is NOT inside the AI-4A proposal.
      expect(JSON.stringify(proposal)).not.toContain('origin_receipt');
    } finally {
      server.close();
    }
  });
});