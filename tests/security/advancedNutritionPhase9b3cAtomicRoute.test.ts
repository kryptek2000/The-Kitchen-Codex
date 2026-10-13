/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-3C.
 * ATOMIC AUTHENTICATED WHOLE-RECOIPE RESOLUTION ROUTE.
 *
 * This suite exercises the ACTUAL Express route over a real HTTP server. Real:
 *   - endpoint authentication, the AI-5 entitlement gate, the text pricing guard
 *     and the shared semantic rate limiter;
 *   - whole-recipe request materialization and server-owned context derivation;
 *   - the whole-recipe semantic operation and its provider fallback chain;
 *   - the strict semantic sanitizer, target reconciliation and canonical ordering;
 *   - GENUINE `wsem1` receipt issuance;
 *   - the Phase 9B-3A same-process MAC verification (NOT mocked);
 *   - the Phase 9B-3B advisory bridge and the released adapter/withholding;
 *   - the closed HTTP transport projection.
 *
 * The ONLY substitution is the provider REGISTRY, which is the existing provider
 * test facility. Receipt verification and the bridge are real.
 *
 * `/api/nutrition/interpret-whole-recipe` must remain unchanged; that is asserted.
 * No real provider key and no network access are used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NutritionProductAccessAuthority } from '../../server/nutritionProductAccessAuthority.js';
import type { AiCandidate, RegisteredProvider } from '../../server/ai/providerRegistry';
import { ProviderOperationError } from '../../server/ai/providerErrors';
import type { AiCapabilities, AiJsonSchema, AiProvider, AiStructuredOptions } from '../../src/core/ai/types';

const REPO = process.cwd();
const ROUTE = '/api/nutrition/resolve-whole-recipe';
const LEGACY_ROUTE = '/api/nutrition/interpret-whole-recipe';
const APP_SOURCE = readFileSync(join(REPO, 'server', 'app.ts'), 'utf8');
const AI_ENDPOINT_TOKEN = '9b3c-secret-token';
const AUTH = { authorization: `Bearer ${AI_ENDPOINT_TOKEN}` };
const V = 'nutrition_ai_whole_recipe_interpretation_request_v1';
const ADVISORY_V = 'nutrition_ai_authenticated_advisory_suggestions_v1';

const LINES = ['4 eggs, separated', '1 cup whole milk', '2 cups all-purpose flour', '6 tbsp unsalted butter', '1 tsp sea salt'];
const INSTRUCTIONS = [
  { text: 'Separate the whites from the yolks.' },
  { text: 'Beat the whites until stiff peaks.' },
  { text: 'Fold the whites back into the yolks.' },
];
const EGG_REF = 'ing:0:20e4077fc89a';

// ---------------------------------------------------------------------------
// PROVIDER REGISTRY MOCK — the ONLY substitution
// ---------------------------------------------------------------------------

const prov = vi.hoisted(() => ({
  prompts: [] as string[],
  calls: 0,
  throwAll: false,
  override: null as null | ((prompt: string) => unknown),
  seenProviderId: null as string | null,
}));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return {
    ...actual,
    getRegisteredProviders: () =>
      (globalThis as never as { __AI3C_REGISTRY?: RegisteredProvider[] }).__AI3C_REGISTRY ?? [],
  };
});

function parsePayload(prompt: string): { requested_targets: Array<{ line_ref: string }> } {
  const at = prompt.indexOf('RECIPE DATA');
  const data = prompt.slice(at);
  return JSON.parse(data.slice(data.indexOf('\n') + 1)) as { requested_targets: Array<{ line_ref: string }> };
}

/** The P5B-observed authentic whole-egg semantics. */
function goodRow(line_ref: string) {
  return {
    contract_version: 'nutrition_ai_advanced_interpretation_v1',
    line_ref,
    semantic_food: {
      normalized_name: 'whole egg',
      modifiers: ['separated', 'recombined'],
      preparation: ['beaten'],
      state: ['raw'],
      qualifiers: [],
    },
    search_phrases: ['whole egg'],
    amount_semantics: { kind: 'exact', echoed_value: 4, phrasing: '4' },
    unit_semantics: { family: 'count', raw: 'eggs', interpreted_unit: 'count' },
    count_semantics: { noun: 'eggs' },
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
  };
}

function mockProvider(id: string): AiProvider {
  return {
    id,
    name: id,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (prompt: string, _s: AiJsonSchema, _o?: AiStructuredOptions) => {
      prov.prompts.push(prompt);
      prov.calls += 1;
      prov.seenProviderId = id;
      if (prov.throwAll) throw new ProviderOperationError('UNAVAILABLE', 'provider unavailable', {});
      if (prov.override) return prov.override(prompt) as never;
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: parsePayload(prompt).requested_targets.map((t) => goodRow(t.line_ref)),
      } as never;
    },
  };
}

function setRegistry(models: string[]): void {
  const provider = mockProvider('gemini');
  const candidates: AiCandidate[] = models.map((model) => ({ provider, model }));
  const registry: RegisteredProvider[] = [
    { provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities },
  ];
  (globalThis as never as { __AI3C_REGISTRY?: RegisteredProvider[] }).__AI3C_REGISTRY = registry;
  (globalThis as never as { __AI3C_CANDIDATES?: AiCandidate[] }).__AI3C_CANDIDATES = candidates;
}

// ---------------------------------------------------------------------------
// HARNESS — the real Express app over a real HTTP server
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'AI_ENDPOINT_TOKEN',
  'KITCHEN_CODEX_TEXT_PROVIDER', 'KITCHEN_CODEX_TEXT_MODEL',
  'NUTRITION_RESOLVE_RATE_LIMIT', 'NUTRITION_INTERPRET_RATE_LIMIT',
] as const;

interface Running { server: http.Server; baseUrl: string }

async function startApp(tier: 'ai_advanced' | 'basic' | 'broken' = 'ai_advanced'): Promise<Running> {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AI_ENDPOINT_TOKEN = AI_ENDPOINT_TOKEN;
  process.env.NUTRITION_INTERPRET_RATE_LIMIT = '1000';

  const { createApp } = await import('../../server/app.js');
  const { resetRateLimitersForTests } = await import('../../server/rateLimiter.js');
  const authorityModule = await import('../../server/nutritionProductAccessAuthority.js');
  resetRateLimitersForTests();

  let authority: NutritionProductAccessAuthority | undefined;
  if (tier === 'broken') authority = { resolve: async () => { throw new Error('authority down'); } };
  else authority = authorityModule.createDeploymentNutritionProductAccessAuthority(tier);

  const app = createApp({ isProduction: false, ...(authority ? { nutritionProductAccessAuthority: authority } : {}) });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

const stop = ({ server }: Running) => new Promise<void>((r) => server.close(() => r()));

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_version: V,
    recipe: { ingredients: LINES.map((name) => ({ name })) },
    instructions: INSTRUCTIONS,
    targets: [{ line_ref: EGG_REF }],
    ...overrides,
  };
}

async function post(baseUrl: string, payload: unknown, headers: Record<string, string> = {}, path = ROUTE) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(raw) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: response.status, json, raw, headers: response.headers };
}

// ---------------------------------------------------------------------------
// §16 — THE ATOMIC PATH
// ---------------------------------------------------------------------------

describe('9B-3C — atomic authenticated whole-recipe resolution', () => {
  let app: Running;
  beforeEach(async () => {
    prov.prompts = []; prov.calls = 0; prov.throwAll = false; prov.override = null;
    setRegistry(['gemini-3.1-flash-lite']);
    app = await startApp('ai_advanced');
  });
  afterEach(async () => { await stop(app); delete (globalThis as never as { __AI3C_REGISTRY?: unknown }).__AI3C_REGISTRY; });

  it('one request returns bounded ADVISORY suggestions after REAL issuance + MAC verification', async () => {
    const r = await post(app.baseUrl, body(), AUTH);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.json.ok).toBe(true);
    expect(r.json.contract_version).toBe(ADVISORY_V);

    // Genuine wsem1 issuance happened server-side and was verified in-process.
    // Every IDENTITY/AUTHORITY field stays INSIDE the server (§6): the receipt
    // MAC, the context binding, the operation id, the provider id, the model id
    // and the request id are ALL absent from the public wire.
    for (const internal of [
      'origin_receipt', 'context_binding', 'operation_id',
      'provider_id', 'model_id', 'request_id',
    ]) {
      expect(r.json[internal], `${internal} must not be public`).toBeUndefined();
    }

    // The REAL curated candidate path ran and its PRIMARY won. The injected
    // registry supplies the provider, and it is the one actually called. Model
    // identity is resolved server-side from the released role models and is
    // proven internally by the 9B-3B bridge suite; with the ids off the wire
    // there is nothing left for the browser to lean on.
    expect(prov.calls).toBe(1);
    expect(prov.seenProviderId).toBe('gemini');

    const suggestions = r.json.suggestions as Array<Record<string, unknown>>;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].line_ref).toBe(EGG_REF);
    expect(suggestions[0].interpreted_food_name).toBe('whole egg');

    // Exactly ONE provider call for one user action.
    expect(prov.calls).toBe(1);

    // The WHOLE recipe — including instructions — was sent.
    const prompt = prov.prompts[0] as string;
    for (const line of LINES) expect(prompt).toContain(line);
    for (const step of INSTRUCTIONS) expect(prompt).toContain(step.text);
  });

  it('the response carries NO USDA, mass, nutrient or persistence authority', async () => {
    const r = await post(app.baseUrl, body(), AUTH);
    expect(r.status).toBe(200);
    for (const forbidden of ['fdc_id', 'fdcId', 'record_digest', 'catalog_digest', 'grams', 'nutrients', 'calories', 'portion_grams', 'apply', 'persist', 'origin_receipt', 'receipt']) {
      expect(new RegExp(`"${forbidden}"`, 'i').test(r.raw), `leaked ${forbidden}`).toBe(false);
    }
    // The wire key set is closed and bounded.
    expect(Object.keys(r.json).sort()).toEqual([
      'aiAttempted', 'contract_version', 'contradicted', 'inadaptable',
      'ok', 'request_version', 'suggestions', 'withheld',
    ]);
  });

  it('never returns internal MAC, provider, or receipt detail on failure', async () => {
    prov.throwAll = true;
    const r = await post(app.baseUrl, body(), AUTH);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('WHOLE_RECIPE_RESOLUTION_UNAVAILABLE');
    for (const leak of ['wsem1', 'mac', 'hmac', 'DEADLINE', 'ProviderOperationError', 'GEMINI_API_KEY', 'quota']) {
      expect(r.raw.toLowerCase(), `leaked ${leak}`).not.toContain(leak.toLowerCase());
    }
    expect(r.raw).not.toContain(EGG_REF);
  });

  it('an ambiguous interpretation yields ZERO suggestions and a withheld record', async () => {
    prov.override = (prompt) => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: parsePayload(prompt).requested_targets.map((t) => ({
        ...goodRow(t.line_ref),
        ambiguity: { ambiguous: true, reasons: ['yolk or white'] },
      })),
    });
    const r = await post(app.baseUrl, body(), AUTH);
    expect(r.status).toBe(200);
    expect(r.json.suggestions).toHaveLength(0);
    expect(r.json.withheld).toEqual([{ line_ref: EGG_REF, reason: 'ambiguous' }]);
  });

  it('a SANITIZER-REJECTED provider output yields no suggestions', async () => {
    prov.override = (prompt) => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: parsePayload(prompt).requested_targets.map((t) => ({
        ...goodRow(t.line_ref),
        search_phrases: ['a', 'b', 'c', 'd', 'e'],
      })),
    });
    const r = await post(app.baseUrl, body(), AUTH);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('WHOLE_RECIPE_RESOLUTION_UNAVAILABLE');
  });

  it('authoritativeByLineRef is NOT accepted from an HTTP client', async () => {
    const r = await post(app.baseUrl, body({ authoritativeByLineRef: { [EGG_REF]: { amount: 999 } } }), AUTH);
    // The closed request sanitizer refuses the unknown key outright.
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('INVALID_WHOLE_RECIPE_RESOLUTION_REQUEST');
    expect(prov.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §7 — AUTHENTICATION AND ENTITLEMENT
// ---------------------------------------------------------------------------

describe('9B-3C — authentication and entitlement precede any provider work', () => {
  afterEach(() => { delete (globalThis as never as { __AI3C_REGISTRY?: unknown }).__AI3C_REGISTRY; });

  it('a missing token is refused with ZERO provider calls', async () => {
    prov.calls = 0; setRegistry(['gemini-3.1-flash-lite']);
    const app = await startApp('ai_advanced');
    try {
      const r = await post(app.baseUrl, body(), {});
      expect(r.status).toBe(401);
      expect(prov.calls).toBe(0);
    } finally { await stop(app); }
  });

  it('a wrong token is refused with ZERO provider calls', async () => {
    prov.calls = 0; setRegistry(['gemini-3.1-flash-lite']);
    const app = await startApp('ai_advanced');
    try {
      const r = await post(app.baseUrl, body(), { authorization: 'Bearer wrong' });
      expect(r.status).toBe(401);
      expect(prov.calls).toBe(0);
    } finally { await stop(app); }
  });

  it('Basic Nutrition is refused with ZERO provider calls (no pricing, no Gemini)', async () => {
    prov.calls = 0; setRegistry(['gemini-3.1-flash-lite']);
    const app = await startApp('basic');
    try {
      const r = await post(app.baseUrl, body(), AUTH);
      expect(r.status).toBe(403);
      expect(r.json.code).toBe('NUTRITION_AI_NOT_ENTITLED');
      expect(prov.calls).toBe(0);
      expect(r.json.suggestions).toBeUndefined();
    } finally { await stop(app); }
  });

  it('an UNKNOWN product-access status fails CLOSED with ZERO provider calls', async () => {
    prov.calls = 0; setRegistry(['gemini-3.1-flash-lite']);
    const app = await startApp('broken');
    try {
      const r = await post(app.baseUrl, body(), AUTH);
      expect(r.status).toBe(503);
      expect(r.json.code).toBe('NUTRITION_PRODUCT_ACCESS_UNAVAILABLE');
      expect(prov.calls).toBe(0);
    } finally { await stop(app); }
  });

  it('no client-authored tier/entitlement field can authorize execution', async () => {
    prov.calls = 0; setRegistry(['gemini-3.1-flash-lite']);
    const app = await startApp('basic');
    try {
      for (const forged of [
        { productTier: 'ai_advanced' },
        { tier: 'ai_advanced' },
        { entitled: true },
        { subscription: 'paid' },
        { authoritativeByLineRef: {} },
      ]) {
        const r = await post(app.baseUrl, body(forged), {
          ...AUTH,
          'x-kitchen-nutrition-tier': 'ai_advanced',
          'x-product-tier': 'ai_advanced',
        });
        expect(r.status, JSON.stringify(forged)).toBe(403);
      }
      expect(prov.calls).toBe(0);
    } finally { await stop(app); }
  });
});

// ---------------------------------------------------------------------------
// §19 — ADVERSARIAL INPUT
// ---------------------------------------------------------------------------

describe('9B-3C — hostile request input fails closed', () => {
  let app: Running;
  beforeEach(async () => {
    prov.prompts = []; prov.calls = 0; prov.throwAll = false; prov.override = null;
    setRegistry(['gemini-3.1-flash-lite']);
    app = await startApp('ai_advanced');
  });
  afterEach(async () => { await stop(app); delete (globalThis as never as { __AI3C_REGISTRY?: unknown }).__AI3C_REGISTRY; });

  it('rejects unknown, duplicate, extra, missing and non-object bodies', async () => {
    const cases: unknown[] = [
      body({ surprise: 1 }),
      body({ targets: [{ line_ref: EGG_REF }, { line_ref: EGG_REF }] }),
      body({ targets: [{ line_ref: EGG_REF }, { line_ref: 'ing:9:deadbeefcafe' }] }),
      body({ targets: [] }),
      body({ origin_receipt: 'wsem1.' + 'A'.repeat(43) }),
      body({ context_binding: 'sha256:' + '0'.repeat(64) }),
      null, 'string', 42, [],
    ];
    for (const payload of cases) {
      const r = await post(app.baseUrl, payload, AUTH);
      expect(r.status, JSON.stringify(payload)?.slice(0, 60)).toBe(400);
    }
    // No provider work for a refused request.
    expect(prov.calls).toBe(0);
  });

  it('an unknown line_ref is refused before any provider call', async () => {
    const r = await post(app.baseUrl, body({ targets: [{ line_ref: 'ing:9:deadbeefcafe' }] }), AUTH);
    expect(r.status).toBe(400);
    expect(prov.calls).toBe(0);
  });

  it('FDC-ID and nutrient injection in the request is refused', async () => {
    const r = await post(
      app.baseUrl,
      body({ recipe: { ingredients: [{ name: '4 eggs, separated', fdc_id: 1, grams: 50 }] } }),
      AUTH
    );
    expect(r.status).toBe(400);
    expect(prov.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §6 — BACKWARD COMPATIBILITY AND STRUCTURE
// ---------------------------------------------------------------------------

describe('9B-3C — the existing signed-semantics route is unchanged', () => {
  let app: Running;
  beforeEach(async () => {
    prov.calls = 0; setRegistry(['gemini-3.1-flash-lite']);
    app = await startApp('ai_advanced');
  });
  afterEach(async () => { await stop(app); delete (globalThis as never as { __AI3C_REGISTRY?: unknown }).__AI3C_REGISTRY; });

  it('/api/nutrition/interpret-whole-recipe still returns the raw signed semantics', async () => {
    const r = await post(app.baseUrl, body(), AUTH, LEGACY_ROUTE);
    expect(r.status).toBe(200);
    // Its ORIGINAL wire contract is untouched.
    expect(Object.keys(r.json).sort()).toEqual([
      'aiAttempted', 'context_binding', 'contract_version', 'model_id', 'ok', 'operation_id',
      'origin_receipt', 'provider_id', 'request_id', 'request_version', 'semantic_response',
    ]);
    expect(r.json.origin_receipt).toMatch(/^wsem1\./);
    expect(r.json.context_binding).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The new advisory field does NOT leak into it.
    expect(r.json.suggestions).toBeUndefined();
  });
});

describe('9B-3C — FINAL TRANSPORT: the six internal fields can never leak', () => {
  let app: Running;
  beforeEach(async () => {
    prov.prompts = []; prov.calls = 0; prov.throwAll = false; prov.override = null;
    prov.seenProviderId = null;
    setRegistry(['gemini-3.1-flash-lite']);
    app = await startApp('ai_advanced');
  });
  afterEach(async () => { await stop(app); delete (globalThis as never as { __AI3C_REGISTRY?: unknown }).__AI3C_REGISTRY; });

  // The exact public allowlist. Anything outside this set is a regression.
  const PUBLIC_ALLOWLIST = [
    'aiAttempted', 'contract_version', 'contradicted', 'inadaptable',
    'ok', 'request_version', 'suggestions', 'withheld',
  ].sort();
  const INTERNAL_ONLY = [
    'context_binding', 'operation_id', 'origin_receipt',
    'provider_id', 'model_id', 'request_id',
  ];

  it('the success response is EXACTLY the closed allowlist', async () => {
    const r = await post(app.baseUrl, body(), AUTH);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(PUBLIC_ALLOWLIST);
    // Nothing extra, nothing fewer.
    expect(Object.keys(r.json).length).toBe(PUBLIC_ALLOWLIST.length);
  }, 30000);

  it('none of the six internal fields is present on the wire', async () => {
    const r = await post(app.baseUrl, body(), AUTH);
    expect(r.status).toBe(200);
    for (const field of INTERNAL_ONLY) {
      expect(Object.prototype.hasOwnProperty.call(r.json, field), `${field} present`).toBe(false);
      expect(JSON.stringify(r.json)).not.toContain(field);
    }
    // And no receipt-shaped or binding-shaped VALUE survives under another name.
    const serialized = JSON.stringify(r.json);
    expect(serialized).not.toMatch(/wsem1\./);
    expect(serialized).not.toMatch(/wsemo1\./);
    expect(serialized).not.toMatch(/sha256:[0-9a-f]{64}/);
  }, 30000);

  it('no raw provider payload, FDC id, nutrient or gram authority is exposed', async () => {
    const r = await post(app.baseUrl, body(), AUTH);
    expect(r.status).toBe(200);
    const serialized = JSON.stringify(r.json);
    for (const forbidden of [
      'fdc_id', 'fdcId', 'nutrient', 'calories', 'grams', 'quantity_grams',
      'catalog_digest', 'record_digest', 'acceptance', 'autoAccept', 'apply_token',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The advisory wording the browser DOES receive is preserved.
    expect(r.json.suggestions[0].interpreted_food_name).toBe('whole egg');
  }, 30000);

  it('the allowlist is enforced structurally — no spread of the bridge result', () => {
    const at = APP_SOURCE.indexOf('const publicAdvisoryResolution');
    expect(at).toBeGreaterThan(-1);
    const literal = APP_SOURCE.slice(at, APP_SOURCE.indexOf('});', at));
    // The public literal must never spread the bridge or the issued envelope.
    expect(literal).not.toMatch(/\.\.\./);
    for (const field of INTERNAL_ONLY) {
      expect(literal, `${field} assigned into the public literal`).not.toMatch(
        new RegExp(`^\\s*${field}:`, 'm')
      );
    }
    // The whole route handler must still gate before building the literal.
    const route = APP_SOURCE.slice(
      APP_SOURCE.indexOf('async (req, res)', at - 4000),
      APP_SOURCE.indexOf('// AI-2B', at)
    );
    expect(route).not.toMatch(/\.\.\.bridge\b/);
    expect(route).not.toMatch(/\.\.\.issued\b/);
    expect(route).not.toMatch(/\.\.\.result\b/);
    expect(route.indexOf('bridgeAuthenticatedSemanticsToAdvisorySuggestions')).toBeLessThan(at);
  });

  it('the internal ids are STILL produced by the bridge for server use', async () => {
    // Minimising the public transport must not weaken internal authority: the
    // bridge still hands the server the ids it needs to authenticate,
    // reconcile, log and diagnose.
    const { bridgeAuthenticatedSemanticsToAdvisorySuggestions } = await import(
      '../../server/wholeRecipeSemanticUsdaBridge.js'
    );
    expect(typeof bridgeAuthenticatedSemanticsToAdvisorySuggestions).toBe('function');
    const BRIDGE_SOURCE = readFileSync(
      new URL('../../server/wholeRecipeSemanticUsdaBridge.ts', import.meta.url), 'utf8'
    );
    for (const field of ['context_binding', 'operation_id', 'provider_id', 'model_id', 'request_id']) {
      expect(BRIDGE_SOURCE, `bridge lost ${field}`).toContain(`readonly ${field}:`);
    }
  });

  it('origin_receipt is verified-and-CONSUMED by the real MAC check, never carried', async () => {
    // The sixth field is stronger still: it is deliberately absent from the
    // bridge contract because `consumeAuthenticatedWholeRecipeSemantics`
    // verifies it and discards it in-process. Genuine verification therefore
    // still gates the route, and the MAC can never be forwarded anywhere.
    const CONSUMPTION_SOURCE = readFileSync(
      new URL('../../server/wholeRecipeSemanticConsumption.ts', import.meta.url), 'utf8'
    );
    expect(CONSUMPTION_SOURCE).toContain('getProcessSemanticOriginAuthority');
    expect(CONSUMPTION_SOURCE).toMatch(/authority\.verify\(\s*dataProperty\(issuedEnvelope, 'origin_receipt'\)/);
    const BRIDGE_SOURCE = readFileSync(
      new URL('../../server/wholeRecipeSemanticUsdaBridge.ts', import.meta.url), 'utf8'
    );
    expect(BRIDGE_SOURCE).not.toMatch(/origin_receipt:\s*/);
    expect(BRIDGE_SOURCE).toContain('consumeAuthenticatedWholeRecipeSemantics');
  });
});

describe('9B-3C — structural guarantees of the new route', () => {
  it('is registered with the released middleware chain and the shared semantic limiter', () => {
    const at = APP_SOURCE.indexOf('"/api/nutrition/resolve-whole-recipe"');
    expect(at).toBeGreaterThan(-1);
    // Capture the WHOLE registration line, not a truncated prefix.
    const start = APP_SOURCE.lastIndexOf('app.post(', at);
    const line = APP_SOURCE.slice(start, APP_SOURCE.indexOf('async (req, res)', at));
    expect(line).toContain('requireAiAccessToken');
    expect(line).toContain('requireNutritionProductFeature(nutritionProductAccessAuthority, "ai_interpretation")');
    expect(line).toContain('textPricingGuard');
    expect(line).toContain('nutritionInterpretRateLimiter');
  });

  it('sets Cache-Control: no-store before any work', () => {
    const at = APP_SOURCE.indexOf('"/api/nutrition/resolve-whole-recipe"');
    const body = APP_SOURCE.slice(at, at + 700);
    expect(body).toContain('res.setHeader("Cache-Control", "no-store");');
  });

  it('never accepts caller-supplied verified observations as authority', () => {
    const at = APP_SOURCE.indexOf('"/api/nutrition/resolve-whole-recipe"');
    const end = APP_SOURCE.indexOf('app.post(', at + 40);
    const body = APP_SOURCE.slice(at, end === -1 ? at + 6000 : end);
    expect(body).not.toMatch(/verified\s*===\s*true/);
    expect(body).not.toContain('authoritativeByLineRef');
    // It performs REAL verification through the 3A consumer, not a boolean gate.
    expect(body).toContain('bridgeAuthenticatedSemanticsToAdvisorySuggestions');
    expect(body).toContain('interpretWholeRecipeSemantics');
  });
});
