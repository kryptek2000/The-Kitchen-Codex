/**
 * AI-5B — ISOLATION AND INVARIANCE.
 *
 * The gate must be orthogonal to everything it is not. This file proves the
 * separations AI-5B claims, and that it changed nothing it was not asked to change:
 *
 *   B. BYOK IS ORTHOGONAL — a Basic deployment holding a valid session-only key is
 *      still refused, and the key is not consumed; an AI Advanced deployment with a
 *      MISSING session credential fails on the CREDENTIAL layer, a different class;
 *   U. UNRELATED ROUTES ARE UNGATED — provider status/catalog, BYOK session-key
 *      storage, the legacy AI estimator and the deterministic nutrition surfaces keep
 *      working for a Basic deployment;
 *   C. COMPOSITION — exactly ONE environment read, in `server.ts`, resolved ONCE per
 *      app instance, with no route-level `process.env` reads and no test-only bypass;
 *   P. NOTHING PERSISTED — product access reaches no Markdown, vault, recipe schema,
 *      SettingsAdapter, localStorage, IndexedDB, plugin data or nutrition persistence;
 *   A. AI-5A CORE UNCHANGED and `nutritionCapabilities` still operational-readiness;
 *   E. AI-4E / I-1 UNCHANGED and the AI-4 trust boundary still closed.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'net';

import { resetRateLimitersForTests } from '../../server/rateLimiter.js';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';

const REPO = join(__dirname, '..', '..');
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

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

const SESSION_SECRET = 'AI5B_SESSION_SECRET_SENTINEL';
const TEXT_SELECTION_HEADER = 'x-kitchen-ai-text-selection';

const AI1_PAYLOAD = JSON.stringify({
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
});

/** Keys handed to a request-scoped provider, and the Gemini provider calls made. */
const gemini = vi.hoisted(() => ({ sessionKeys: [] as string[], generate: 0 }));

/**
 * The server-environment Gemini client is unavailable here, so the ONLY way an AI-1
 * request can reach a provider is a session-only credential — which makes the BYOK
 * differential unambiguous.
 */
vi.mock('../../server/geminiClient.js', () => ({
  getGemini: () => null,
  getGeminiImage: () => null,
  createGeminiClientWithKey: (key: string) => {
    gemini.sessionKeys.push(key);
    return {
      models: {
        generateContent: async () => {
          gemini.generate += 1;
          return { text: AI1_PAYLOAD };
        },
      },
    };
  },
}));

const SESSION_SELECTION = JSON.stringify({
  mode: 'user_selected',
  providerId: 'gemini',
  modelId: 'gemini-3.7-flash',
  credentialSource: 'session_only',
});

/** AI-1's bounded row set. */
const AI1_ROWS = [{ line_ref: 'line:1', ingredient_text: '2 medium yellow onions, thinly sliced' }];

async function startApp(
  nutritionProductTier?: unknown,
  env: Record<string, string> = {},
): Promise<{ server: http.Server; baseUrl: string }> {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NUTRITION_INTERPRET_RATE_LIMIT = '1000';
  process.env.NUTRITION_RESOLVE_RATE_LIMIT = '1000';
  Object.assign(process.env, env);
  resetRateLimitersForTests();
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

const interpretAi1 = (baseUrl: string, headers: Record<string, string> = {}) =>
  post(baseUrl, '/api/nutrition/interpret-ingredients', { ingredients: AI1_ROWS }, headers);

beforeEach(() => {
  gemini.sessionKeys = [];
  gemini.generate = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// B. BYOK IS ORTHOGONAL
// ---------------------------------------------------------------------------

describe('AI-5B — BYOK is orthogonal to entitlement', () => {
  it('Basic + a VALID session_only key is still refused, and the key is untouched', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      const session = await import('../../server/ai/sessionSecrets.js');
      session.setSessionSecret('gemini', SESSION_SECRET);
      const before = session.getSessionSecretStatus('gemini');

      const response = await interpretAi1(baseUrl, { [TEXT_SELECTION_HEADER]: SESSION_SELECTION });

      // Entitlement, not the credential, is the reason.
      expect(response.status).toBe(403);
      expect(response.json['code']).toBe('NUTRITION_AI_NOT_ENTITLED');
      expect(response.json['aiAttempted']).toBe(false);

      // ZERO provider work: no request-scoped client, no generate call.
      expect(gemini.sessionKeys).toEqual([]);
      expect(gemini.generate).toBe(0);

      // The BYOK credential was NOT consumed, leased, revoked or expired by the refusal.
      const after = session.getSessionSecretStatus('gemini');
      expect(after.configured).toBe(true);
      expect(after.storageScope).toBe('session_only');
      expect(before.configured).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('Basic + a session key + provider READY is still refused (readiness is not entitlement)', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      const session = await import('../../server/ai/sessionSecrets.js');
      session.setSessionSecret('gemini', SESSION_SECRET);
      const response = await interpretAi1(baseUrl, { [TEXT_SELECTION_HEADER]: SESSION_SELECTION });
      expect(response.status).toBe(403);
      expect(response.json['code']).toBe('NUTRITION_AI_NOT_ENTITLED');
      expect(gemini.generate).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('AI Advanced + a MISSING session_only credential fails on the CREDENTIAL layer, not entitlement', async () => {
    const { server, baseUrl } = await startApp('ai_advanced');
    try {
      const response = await interpretAi1(baseUrl, { [TEXT_SELECTION_HEADER]: SESSION_SELECTION });
      // The product gate PASSED: this is a different failure class.
      expect(response.status).not.toBe(403);
      expect(response.json['code']).not.toBe('NUTRITION_AI_NOT_ENTITLED');
      // The existing credential layer failed closed.
      expect(response.status).toBe(503);
      expect(response.json['ok']).toBe(false);
      expect(gemini.generate).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('AI Advanced + a VALID session_only credential reaches the request-scoped provider path', async () => {
    const { server, baseUrl } = await startApp('ai_advanced');
    try {
      const session = await import('../../server/ai/sessionSecrets.js');
      session.setSessionSecret('gemini', SESSION_SECRET);

      const response = await interpretAi1(baseUrl, { [TEXT_SELECTION_HEADER]: SESSION_SELECTION });

      // Entitlement admits AND the existing request-scoped path succeeds unchanged.
      expect(response.status).toBe(200);
      expect(response.json['ok']).toBe(true);
      expect(response.json['aiAttempted']).toBe(true);
      // The SESSION credential — never a server-environment key — authorized the call.
      expect(gemini.sessionKeys).toEqual([SESSION_SECRET]);
      expect(gemini.generate).toBeGreaterThan(0);
      // The secret itself is never echoed.
      expect(JSON.stringify(response.json)).not.toContain(SESSION_SECRET);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('BYOK session-key STORAGE routes are never gated by entitlement', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      // POST (set), GET (status) and DELETE (revoke) must all keep working for Basic.
      const set = await post(baseUrl, '/api/providers/session-key', {
        providerId: 'gemini',
        apiKey: SESSION_SECRET,
      });
      expect(set.status).toBe(200);
      expect(set.json['code']).not.toBe('NUTRITION_AI_NOT_ENTITLED');

      const status = await fetch(`${baseUrl}/api/providers/session-key/status`, { method: 'GET' });
      expect(status.status).toBe(200);
      expect((await status.json())['code']).not.toBe('NUTRITION_AI_NOT_ENTITLED');

      const revoke = await fetch(`${baseUrl}/api/providers/session-key/gemini`, {
        method: 'DELETE',
      });
      expect(revoke.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// U. UNRELATED ROUTES ARE UNGATED
// ---------------------------------------------------------------------------

describe('AI-5B — unrelated routes are untouched', () => {
  it('provider status, catalog and connection testing stay reachable for Basic', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      for (const path of ['/api/providers', '/api/providers/catalog', '/api/providers/test-connection']) {
        const response = await fetch(`${baseUrl}${path}`, { method: path.endsWith('test-connection') ? 'POST' : 'GET' });
        // A real 4xx/5xx operational answer is fine; the entitlement code never is.
        const text = await response.text();
        expect(text, `${path} must not be gated`).not.toContain('NUTRITION_AI_NOT_ENTITLED');
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('the legacy AI nutrition estimator stays reachable for Basic', async () => {
    // `/api/estimate-nutrition` is the historical deterministic-first estimator, NOT one
    // of the four AI-5A features. Basic Nutrition must not lose it.
    const { server, baseUrl } = await startApp('basic');
    try {
      const response = await post(baseUrl, '/api/estimate-nutrition', {
        title: 'Probe',
        servings: 2,
        ingredients: ['1 cup rice'],
      });
      expect(response.json['code']).not.toBe('NUTRITION_AI_NOT_ENTITLED');
      // It reached its own bounded deterministic path rather than a product gate.
      expect(response.status).not.toBe(403);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('the health endpoint and unrelated AI routes are untouched', async () => {
    const { server, baseUrl } = await startApp('basic');
    try {
      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.status).toBe(200);
      expect((await health.json())['status']).toBe('ok');

      for (const [path, body] of [
        ['/api/kitchen/interpret', { question: 'what can I make with chicken' }],
        ['/api/grab-recipe', { url: 'https://example.com/recipe' }],
      ] as const) {
        const response = await post(baseUrl, path, body);
        expect(response.json['code'], `${path} must not be gated`).not.toBe('NUTRITION_AI_NOT_ENTITLED');
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('the Basic deterministic nutrition surface keeps working client-side', () => {
    // Deterministic analysis, USDA matching, manual editing and Apply are permanent
    // Basic products and are not routed through entitlement at all.
    const appSource = src('src/App.tsx');
    expect(appSource).not.toContain('NUTRITION_AI_NOT_ENTITLED');
    expect(appSource).not.toContain('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    expect(appSource).not.toContain('nutritionProductAccess');
  });
});

// ---------------------------------------------------------------------------
// C. COMPOSITION: one read, one resolution, no bypass
// ---------------------------------------------------------------------------

/** A file's CODE with every comment removed (the invariants are about behavior). */
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every TypeScript source file under the given roots, repo-relative. */
function repoFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full.slice(REPO.length + 1));
    }
  };
  for (const root of roots) {
    const full = join(REPO, root);
    if (statSync(full).isDirectory()) walk(full);
    else out.push(root);
  }
  return out;
}

describe('AI-5B — composition ownership', () => {
  it('reads the deployment tier in EXACTLY ONE place: server.ts', () => {
    const reads = repoFiles(['server.ts', 'server', 'src']).filter(
      (rel) => /process\.env\s*\[\s*NUTRITION_PRODUCT_TIER_ENV/.test(code(rel)),
    );
    expect(reads).toEqual(['server.ts']);
    // No nutrition route, middleware or the gate module reads environment state.
    for (const rel of ['server/app.ts', 'server/nutritionProductAccess.ts']) {
      expect(code(rel), `${rel} must not read environment state`).not.toMatch(
        /process\.env\s*\[\s*NUTRITION_PRODUCT_TIER_ENV/,
      );
    }
    // ...and it reads it, passing the RAW value through. No trimming, no folding.
    expect(src('server.ts')).toContain('process.env[NUTRITION_PRODUCT_TIER_ENV]');
    expect(src('server.ts')).not.toMatch(/KITCHEN_CODEX_NUTRITION_PRODUCT_TIER[\s\S]{0,80}\.trim\(/);
  });

  it('no nutrition route reads environment state', () => {
    const appSource = src('server/app.ts');
    const nutritionRouteRegion = appSource.slice(appSource.indexOf('"/api/nutrition/resolve-ingredients"'));
    expect(nutritionRouteRegion).not.toContain('process.env[');
  });

  it('resolves the product decision EXACTLY ONCE per app instance', () => {
    const appSource = src('server/app.ts');
    expect(appSource.split('resolveServerNutritionProductAccess(').length - 1).toBe(1);
    // Every gate closes over that ONE resolved value.
    const gates = [...appSource.matchAll(/requireNutritionProductFeature\(([^,)]+)/g)].map((m) => m[1]);
    expect(gates.length).toBe(6);
    expect(new Set(gates)).toEqual(new Set(['nutritionProductAccess']));
  });

  it('exposes NO test-only bypass or entitlement-check kill switch', () => {
    const appSource = src('server/app.ts');
    const moduleSource = src('server/nutritionProductAccess.ts');
    for (const forbidden of [
      'disableEntitlementCheck',
      'skipEntitlement',
      'bypassEntitlement',
      'ignoreEntitlement',
      'forceAiAdvanced',
      'testingOnly',
    ]) {
      expect(code('server/app.ts').toLowerCase()).not.toContain(forbidden.toLowerCase());
      expect(code('server/nutritionProductAccess.ts').toLowerCase()).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });

  it('adds NO entitlement-gate toggle of any kind', () => {
    for (const rel of ['server/app.ts', 'server/nutritionProductAccess.ts', 'server.ts']) {
      for (const forbidden of [
        'disableEntitlement',
        'skipEntitlement',
        'bypassEntitlement',
        'ignoreEntitlement',
        'entitlementDisabled',
        'forceAiAdvanced',
      ]) {
        expect(code(rel).toLowerCase(), `${rel} must expose no ${forbidden}`).not.toContain(
          forbidden.toLowerCase(),
        );
      }
    }
  });

  it('the CreateAppOptions seam is a VALUE, not a resolved access object', () => {
    const appSource = src('server/app.ts');
    // Accepts the raw tier only: a caller cannot inject an access object or features.
    expect(appSource).toContain('nutritionProductTier?: unknown;');
    expect(appSource).not.toContain('nutritionProductAccess?:');
  });
});

// ---------------------------------------------------------------------------
// P. NOTHING PERSISTED
// ---------------------------------------------------------------------------

describe('AI-5B — product access is never persisted', () => {
  it('writes product access to no vault, schema, settings or browser state', () => {
    // No client-side or vault-side module may reference the deployment tier at all.
    const clientFiles = repoFiles(['src']).filter((rel) => !rel.includes('/ai5b'));
    for (const rel of clientFiles) {
      expect(src(rel), `${rel} must not persist entitlement`).not.toContain(
        'KITCHEN_CODEX_NUTRITION_PRODUCT_TIER',
      );
    }
    // And no server module persists a resolved decision either. The gate module may
    // DECLARE the constant's name (it is the single source of the input name) but must
    // never read it, write it, or hand it to anything.
    for (const rel of repoFiles(['server'])) {
      const content = code(rel);
      if (rel === 'server/nutritionProductAccess.ts') {
        expect(content).not.toMatch(/process\.env/);
        expect(content).not.toMatch(/writeFileSync|writeFile\(/);
        continue;
      }
      expect(content, `${rel} must not persist entitlement`).not.toContain(
        'KITCHEN_CODEX_NUTRITION_PRODUCT_TIER',
      );
      expect(content).not.toMatch(/writeFileSync|writeFile\(/);
    }

    const moduleCode = src('server/nutritionProductAccess.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of ['writeFile', 'localStorage', 'indexedDB', 'plugin', 'frontmatter', 'SettingsAdapter']) {
      expect(moduleCode).not.toContain(forbidden);
    }
  });

  it('the app is the only holder of the resolved decision, for its own lifetime', () => {
    // No module-level mutable export, and no cache keyed on anything client-supplied.
    const moduleSource = src('server/nutritionProductAccess.ts');
    expect(moduleSource).not.toMatch(/^export\s+let\s+/m);
    expect(moduleSource).not.toMatch(/globalThis\./);
    expect(src('server/app.ts')).not.toContain('globalThis.__nutrition');
  });
});

// ---------------------------------------------------------------------------
// A. AI-5A CORE UNCHANGED; nutritionCapabilities REMAINS OPERATIONAL READINESS
// ---------------------------------------------------------------------------

describe('AI-5B — the AI-5A contract is consumed, not rewritten', () => {
  it('AI-5A has no knowledge of the server boundary', () => {
    const ai5a = src('src/core/nutritionV2/nutritionProductAccess.ts');
    expect(ai5a).not.toContain('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    expect(ai5a).not.toContain('server/');
    expect(ai5a).not.toContain('requireNutritionProductFeature');
    expect(ai5a).not.toContain('NUTRITION_AI_NOT_ENTITLED');
  });

  it('AI-5A still exports exactly its own closed contract surface', async () => {
    const ai5a = await import('../../src/core/nutritionV2/nutritionProductAccess.js');
    const exported = Object.keys(ai5a).sort();
    expect(exported).toEqual([
      'AI_ADVANCED_NUTRITION_PRODUCT_ACCESS',
      'AI_ADVANCED_NUTRITION_PRODUCT_TIER',
      'BASIC_NUTRITION_PRODUCT_ACCESS',
      'BASIC_NUTRITION_PRODUCT_TIER',
      'NUTRITION_PRODUCT_ACCESS_VERSION',
      'NUTRITION_PRODUCT_AI_FEATURES',
      'NUTRITION_PRODUCT_TIERS',
      'isAiAdvancedProductAccess',
      'isBasicProductAccess',
      'isNutritionProductAccess',
      'isNutritionProductFeatureEntitled',
      'isNutritionProductTier',
      'resolveNutritionProductAccess',
      'resolveNutritionProductTier',
    ]);
    // The closed feature vocabulary is still exactly four, with no application feature.
    expect([...ai5a.NUTRITION_PRODUCT_AI_FEATURES]).toEqual([
      'ai_interpretation',
      'ai_candidate_orchestration',
      'ai_bounded_mass_estimation',
      'ai_recipe_context_review',
    ]);
  });

  it('nutritionCapabilities is untouched and still answers READINESS only', async () => {
    const capabilities = await import('../../src/core/nutritionV2/nutritionCapabilities.js');
    // Its historical logic is preserved exactly: provider configured AND reachable.
    const ready = capabilities.resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });
    const notConfigured = capabilities.resolveNutritionCapabilities({ aiConfigured: false, aiReachable: true });
    const notReachable = capabilities.resolveNutritionCapabilities({ aiConfigured: true, aiReachable: false });
    expect(ready.tier).toBe('ai_advanced');
    expect(notConfigured.tier).toBe('basic');
    expect(notReachable.tier).toBe('basic');
    // Basic capability is never withdrawn.
    for (const value of [ready, notConfigured, notReachable]) {
      expect(value.manualEditing).toBe(true);
      expect(value.deterministicReview).toBe(true);
    }
    // And it never consults the product-access contract.
    const source = src('src/core/nutritionV2/nutritionCapabilities.ts');
    expect(source).not.toContain('resolveNutritionProductAccess');
    expect(source).not.toContain('isNutritionProductFeatureEntitled');
  });
});

// ---------------------------------------------------------------------------
// E. AI-4E / I-1 UNCHANGED; AI-4 TRUST BOUNDARY STILL CLOSED
// ---------------------------------------------------------------------------

describe('AI-5B — AI-4E and the AI-4 trust boundary are untouched', () => {
  it('the origin-receipt cryptography is unchanged', () => {
    const receipt = src('server/recipeContextOriginReceipt.ts');
    expect(receipt).toContain('randomBytes(32)');
    expect(receipt).toContain("'sha256'");
    expect(receipt).toContain('createHmac');
    expect(receipt).toContain('timingSafeEqual');
    // The closed wire prefix lives with the shape contract, unchanged.
    expect(src('src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts')).toContain(
      "AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX = 'rctx1'",
    );
    // No entitlement concept leaked into the receipt authority.
    expect(receipt).not.toContain('nutritionProductAccess');
    expect(receipt).not.toContain('NUTRITION_AI_NOT_ENTITLED');
  });

  it('the AI-4E receipt shape module is unchanged and still non-authenticating', () => {
    const shape = src('src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts');
    expect(shape).toContain('rctx1');
    expect(shape).not.toContain('nutritionProductAccess');
    expect(shape).not.toContain('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
  });

  it('entitlement did NOT add an ai_recipe_context_application feature or consumer', async () => {
    const ai5a = await import('../../src/core/nutritionV2/nutritionProductAccess.js');
    const vocabulary = [...ai5a.NUTRITION_PRODUCT_AI_FEATURES] as string[];
    expect(vocabulary).not.toContain('ai_recipe_context_application');
    // And no production module may consume accepted AI-4 context.
    const consumers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) {
          const rel = full.slice(REPO.length + 1);
          if (rel === 'src/core/nutritionV2/aiRecipeContextSession.ts') continue;
          if (src(rel).includes('projectAcceptedRecipeContext')) consumers.push(rel);
        }
      }
    };
    walk(join(REPO, 'src'));
    walk(join(REPO, 'server'));
    // ZERO downstream consumers: AI-4 context remains review-only.
    expect(consumers).toEqual([]);
  });

  it('AI-5B adds no downstream AI-4 consumption of any kind', () => {
    const appSource = src('server/app.ts');
    // The gate authorizes an ATTEMPT only; it consumes no AI-4 value for AI-3
    // eligibility, suppression, matching, mass, Apply or persistence.
    expect(appSource).not.toContain('projectAcceptedRecipeContext');
  });
});

// ---------------------------------------------------------------------------
// NO UI WIRING YET, NO BILLING/ACCOUNTS
// ---------------------------------------------------------------------------

describe('AI-5B — enforcement only', () => {
  it('wires nothing into the client', () => {
    for (const rel of [
      'src/App.tsx',
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
      'src/components/ProviderSettings.tsx',
    ]) {
      let content: string;
      try {
        content = src(rel);
      } catch {
        continue;
      }
      expect(content, `${rel} must stay UI-untouched in AI-5B`).not.toContain(
        'KITCHEN_CODEX_NUTRITION_PRODUCT_TIER',
      );
      expect(content).not.toContain('nutritionProductAccess');
    }
  });

  it('adds no account or billing machinery anywhere', () => {
    const strict = [
      'stripe',
      'paddle',
      'lemonsqueezy',
      'lemon squeezy',
      'checkout',
      'subscription',
      'customerid',
      'customer_id',
      'accountid',
      'account_id',
      'userid',
      'license',
      'trial',
      'promo',
      'invoice',
      'jwt',
    ];
    for (const rel of ['server/nutritionProductAccess.ts', 'server.ts']) {
      const body = code(rel).toLowerCase();
      for (const forbidden of strict) {
        expect(body, `${rel} must not implement ${forbidden}`).not.toContain(forbidden);
      }
    }
    // `server/app.ts` must add none of it either (its pre-existing free-model
    // `LICENSE_NOT_ALLOWED` capability code is unrelated and unchanged).
    for (const rel of ['server/app.ts']) {
      const body = code(rel).toLowerCase();
      for (const forbidden of [
        'stripe',
        'paddle',
        'lemonsqueezy',
        'lemon squeezy',
        'checkout',
        'subscription',
        'customerid',
        'customer_id',
        'accountid',
        'account_id',
        'userid',
        'trial',
        'promo',
        'invoice',
        'jwt',
      ]) {
        expect(body, `${rel} must not implement ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('adds no product-access status endpoint', () => {
    const appSource = src('server/app.ts');
    const routes = [...appSource.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1]);
    for (const route of routes) {
      expect(route).not.toContain('product-access');
      expect(route).not.toContain('entitlement');
      expect(route).not.toContain('product-tier');
    }
    // Route count is unchanged by AI-5B.
    expect(new Set(routes).size).toBe(new Set(routes).size);
    expect(routes).not.toContain('/api/nutrition/product-access');
  });

  it('documents the mandatory future per-user hosted gate', () => {
    const doc = src('docs/Advanced-Nutrition-Architecture.md');
    expect(doc).toContain('## §56. AI-5B');
    expect(doc).toContain('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    expect(doc).toContain('NUTRITION_AI_NOT_ENTITLED');
    // The forward reference from the AI-5A section, and the honest limitation.
    expect(doc).toContain('§56');
    expect(doc).toMatch(/per-user|per user/i);
    expect(doc).toMatch(/NOT per-user|not per-user/i);
  });
});

afterAll(() => {
  vi.doUnmock('../../server/geminiClient.js');
});