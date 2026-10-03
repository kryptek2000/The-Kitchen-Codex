/**
 * AI-5B — SERVER-AUTHORITATIVE ENTITLEMENT BOUNDARY (server-authority unit).
 *
 * These tests pin the AI-5B server module in isolation from HTTP:
 *   - the ONE server-owned source resolves fail-closed through the unchanged AI-5A
 *     contract, for every malformed/absent/aliased/wrong-case/coercible input;
 *   - the closed feature gate authorizes only a canonical AI-5A access value and fails
 *     closed for a hand-authored look-alike or an unknown feature name;
 *   - the denial is ONE bounded class that leaks no pricing, plan, subscription,
 *     billing, configured tier, account identity, credential, provider or raw config;
 *   - the module is narrow: it reads NO environment state, imports NO provider,
 *     credential, billing or account layer, and performs NO persistence or network I/O.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  NUTRITION_PRODUCT_TIER_ENV,
  NUTRITION_AI_NOT_ENTITLED_CODE,
  NUTRITION_AI_NOT_ENTITLED_ERROR,
  NUTRITION_PRODUCT_ACCESS_BOUND_VERSION,
  buildNutritionAiNotEntitledBody,
  requireNutritionProductFeature,
  resolveServerNutritionProductAccess,
} from '../../server/nutritionProductAccess.js';
import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_ACCESS,
  NUTRITION_PRODUCT_ACCESS_VERSION,
  isAiAdvancedProductAccess,
  isBasicProductAccess,
  type NutritionProductAiFeature,
} from '../../src/core/nutritionV2/nutritionProductAccess.js';

const REPO = join(__dirname, '..', '..');
const MODULE_SOURCE = readFileSync(join(REPO, 'server', 'nutritionProductAccess.ts'), 'utf8');

/**
 * The module's CODE with every comment removed. The invariants below are about the
 * implementation, not the documentation: the module's header deliberately NAMES the
 * layers it must stay ignorant of, so a raw-source assertion would prove nothing.
 */
const MODULE_CODE = MODULE_SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .trim();

/** A minimal Express-shaped req/res pair; the gate reads NOTHING from `req`. */
function harness() {
  const calls = {
    next: 0,
    status: 0 as number,
    body: undefined as unknown,
  };
  const res = {
    status(code: number) {
      calls.status = code;
      return res;
    },
    json(payload: unknown) {
      calls.body = payload;
      return res;
    },
  };
  const req = {} as Record<string, unknown>;
  return { calls, res, req };
}

function runGate(
  access: unknown,
  feature: NutritionProductAiFeature,
  req: Record<string, unknown> = {},
) {
  const { calls, res } = harness();
  const handler = requireNutritionProductFeature(
    access as typeof BASIC_NUTRITION_PRODUCT_ACCESS,
    feature,
  ) as unknown as (r: unknown, s: unknown, n: () => void) => void;
  handler(req, res, () => {
    calls.next += 1;
  });
  return calls;
}

afterEach(() => {
  delete process.env[NUTRITION_PRODUCT_TIER_ENV];
});

describe('AI-5B — the one server-owned product-access source', () => {
  it('names exactly one non-secret server-owned configuration input', () => {
    expect(NUTRITION_PRODUCT_TIER_ENV).toBe('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    // The name is a deployment setting, never a secret: nothing about it is a key.
    expect(/KEY|TOKEN|SECRET|PASSWORD/i.test(NUTRITION_PRODUCT_TIER_ENV)).toBe(false);
  });

  it('binds the same closed AI-5A contract version the product layer uses', () => {
    expect(NUTRITION_PRODUCT_ACCESS_BOUND_VERSION).toBe(NUTRITION_PRODUCT_ACCESS_VERSION);
  });

  // -------------------------------------------------------------------------
  // FAIL-CLOSED SOURCE RESOLUTION. Every value below must land on BASIC.
  // -------------------------------------------------------------------------
  const resolvesToBasic: ReadonlyArray<readonly [string, unknown]> = [
    ['missing (no argument)', undefined],
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['exact basic', 'basic'],
    ['uppercase AI_ADVANCED', 'AI_ADVANCED'],
    ['mixed case Ai_Advanced', 'Ai_Advanced'],
    ['leading whitespace', ' ai_advanced'],
    ['trailing whitespace', 'ai_advanced '],
    ['newline padded', '\nai_advanced\n'],
    ['tab padded', '\tai_advanced'],
    ['hyphen spelling', 'ai-advanced'],
    ['camel spelling', 'aiAdvanced'],
    ['alias: pro', 'pro'],
    ['alias: premium', 'premium'],
    ['alias: paid', 'paid'],
    ['alias: free', 'free'],
    ['alias: subscription', 'subscription'],
    ['alias: enterprise', 'enterprise'],
    ['alias: lifetime', 'lifetime'],
    ['boolean true', true],
    ['boolean false', false],
    ['string boolean', 'true'],
    ['string boolean on', 'on'],
    ['number 1', 1],
    ['number 0', 0],
    ['number NaN', Number.NaN],
    ['string number 1', '1'],
    ['plain object', {}],
    ['array', ['ai_advanced']],
    ['feature-shaped object', { tier: 'ai_advanced', aiInterpretation: true }],
    ['features array object', { features: ['ai_interpretation'] }],
    ['String wrapper', new String('ai_advanced')],
    ['symbol', Symbol('ai_advanced')],
  ];

  for (const [label, value] of resolvesToBasic) {
    it(`resolves ${label} to BASIC (fail closed, no coercion)`, () => {
      const access = resolveServerNutritionProductAccess(value);
      expect(access).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
      expect(access.tier).toBe('basic');
      expect(isBasicProductAccess(access)).toBe(true);
      expect(isAiAdvancedProductAccess(access)).toBe(false);
    });
  }

  it('resolves ONLY the exact string "ai_advanced" to AI ADVANCED', () => {
    const access = resolveServerNutritionProductAccess('ai_advanced');
    expect(access).toBe(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    expect(access.tier).toBe('ai_advanced');
    expect(isAiAdvancedProductAccess(access)).toBe(true);
    expect(access.aiInterpretation).toBe(true);
    expect(access.aiCandidateOrchestration).toBe(true);
    expect(access.aiBoundedMassEstimation).toBe(true);
    expect(access.aiRecipeContextReview).toBe(true);
  });

  it('returns the CANONICAL frozen instances, never a fresh copy', () => {
    const a = resolveServerNutritionProductAccess('ai_advanced');
    const b = resolveServerNutritionProductAccess('ai_advanced');
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    const basic = resolveServerNutritionProductAccess();
    expect(Object.isFrozen(basic)).toBe(true);
    expect(basic).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
  });

  it('is NOT influenced by credentials, provider config or the endpoint token', () => {
    // Operational state must never become product access: a fully configured,
    // credential-bearing deployment with a bogus tier is still Basic.
    process.env.GEMINI_API_KEY = 'configured';
    process.env.OPENROUTER_API_KEY = 'configured';
    process.env.DEEPSEEK_API_KEY = 'configured';
    process.env.AI_ENDPOINT_TOKEN = 'token';
    process.env.KITCHEN_CODEX_TEXT_PROVIDER = 'openrouter';
    try {
      expect(resolveServerNutritionProductAccess(undefined)).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
      expect(resolveServerNutritionProductAccess('basic')).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
      expect(resolveServerNutritionProductAccess('ai_advanced')).toBe(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    } finally {
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.AI_ENDPOINT_TOKEN;
      delete process.env.KITCHEN_CODEX_TEXT_PROVIDER;
    }
  });

  it('never normalizes: a near-miss value is never trimmed into entitlement', () => {
    // The load-bearing rule: an invalid value must not be "repaired" into AI Advanced.
    for (const near of [' ai_advanced', 'ai_advanced ', 'Ai_Advanced', 'ai-advanced']) {
      expect(resolveServerNutritionProductAccess(near).tier).toBe('basic');
    }
  });
});

describe('AI-5B — the closed feature gate', () => {
  const features: ReadonlyArray<NutritionProductAiFeature> = [
    'ai_interpretation',
    'ai_candidate_orchestration',
    'ai_bounded_mass_estimation',
    'ai_recipe_context_review',
  ];

  for (const feature of features) {
    it(`denies ${feature} under BASIC with the bounded 403`, () => {
      const calls = runGate(BASIC_NUTRITION_PRODUCT_ACCESS, feature);
      expect(calls.next).toBe(0);
      expect(calls.status).toBe(403);
      expect(calls.body).toEqual({
        ok: false,
        code: 'NUTRITION_AI_NOT_ENTITLED',
        error: 'AI Advanced Nutrition is not available for this product access.',
        aiAttempted: false,
      });
    });

    it(`admits ${feature} under AI ADVANCED`, () => {
      const calls = runGate(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, feature);
      expect(calls.next).toBe(1);
      expect(calls.status).toBe(0);
      expect(calls.body).toBeUndefined();
    });
  }

  it('fails closed for a hand-authored look-alike access object', () => {
    // AI-5A refuses structurally correct non-canonical values by identity; the server
    // gate inherits that, so a caller cannot mint an accepted access value.
    const forged = {
      version: NUTRITION_PRODUCT_ACCESS_VERSION,
      tier: 'ai_advanced',
      aiInterpretation: true,
      aiCandidateOrchestration: true,
      aiBoundedMassEstimation: true,
      aiRecipeContextReview: true,
    };
    const calls = runGate(forged, 'ai_interpretation');
    expect(calls.next).toBe(0);
    expect(calls.status).toBe(403);
    expect((calls.body as { code: string }).code).toBe(NUTRITION_AI_NOT_ENTITLED_CODE);
  });

  it('fails closed for an impossible product state (basic + AI feature booleans)', () => {
    const impossible = {
      ...BASIC_NUTRITION_PRODUCT_ACCESS,
      aiInterpretation: true,
    };
    const calls = runGate(impossible, 'ai_interpretation');
    expect(calls.next).toBe(0);
    expect(calls.status).toBe(403);
  });

  it('fails closed for an unknown feature name', () => {
    const calls = runGate(
      AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
      'ai_recipe_context_application' as NutritionProductAiFeature,
    );
    expect(calls.next).toBe(0);
    expect(calls.status).toBe(403);
  });

  it('fails closed for a completely absent access value', () => {
    for (const bad of [undefined, null, 'ai_advanced', 1, {}]) {
      const calls = runGate(bad, 'ai_interpretation');
      expect(calls.next).toBe(0);
      expect(calls.status).toBe(403);
    }
  });

  it('ignores the request entirely: no field, header or cookie can admit a gate', () => {
    const forgedRequests: ReadonlyArray<Record<string, unknown>> = [
      { body: { tier: 'ai_advanced' } },
      { body: { productTier: 'ai_advanced' } },
      { body: { entitled: true } },
      { headers: { 'x-kitchen-nutrition-tier': 'ai_advanced' } },
      { headers: { 'x-product-tier': 'ai_advanced' } },
      { headers: { 'x-entitlement': 'ai_advanced' } },
      { headers: { authorization: 'Bearer anything' } },
      { cookies: { tier: 'ai_advanced' } },
      { query: { tier: 'ai_advanced' } },
    ];
    for (const req of forgedRequests) {
      const calls = runGate(BASIC_NUTRITION_PRODUCT_ACCESS, 'ai_interpretation', req);
      expect(calls.next).toBe(0);
      expect(calls.status).toBe(403);
    }
  });
});

describe('AI-5B — bounded denial contract', () => {
  it('exposes exactly ONE machine code and ONE message', () => {
    expect(NUTRITION_AI_NOT_ENTITLED_CODE).toBe('NUTRITION_AI_NOT_ENTITLED');
    expect(NUTRITION_AI_NOT_ENTITLED_ERROR).toBe(
      'AI Advanced Nutrition is not available for this product access.',
    );
  });

  it('carries no pricing, plan, subscription, billing, tier, identity or provider detail', () => {
    const body = buildNutritionAiNotEntitledBody() as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['aiAttempted', 'code', 'error', 'ok']);
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of [
      'price',
      'pricing',
      'plan',
      'tier',
      'subscription',
      'billing',
      'checkout',
      'customer',
      'account',
      'user',
      'token',
      'apikey',
      'api_key',
      'api key',
      'credential',
      'key',
      'provider',
      'gemini',
      'openrouter',
      'deepseek',
      'env',
      'process.env',
      'model',
      'session',
      'license',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('always reports aiAttempted:false, because the gate runs before any AI work', () => {
    expect(buildNutritionAiNotEntitledBody().aiAttempted).toBe(false);
  });
});

describe('AI-5B — server-authority module design', () => {
  it('reads NO environment state itself', () => {
    // `process.env` is read exactly once, by server.ts, and handed in as a value.
    expect(MODULE_CODE).not.toContain('process.env');
    expect(MODULE_CODE).not.toContain('dotenv');
  });

  it('never mutates process.env', () => {
    expect(MODULE_CODE).not.toMatch(/process\.env\s*\[/);
    expect(MODULE_CODE).not.toMatch(/delete\s+process\.env/);
    expect(MODULE_CODE).not.toMatch(/process\.env\.[A-Z_]+\s*=/);
  });

  it('imports ONLY the AI-5A product contract and the express request type', () => {
    const sources = [...MODULE_CODE.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(sources).toEqual([
      'express',
      '../src/core/nutritionV2/nutritionProductAccess.js',
    ]);
  });

  it('knows nothing about providers, credentials, sessions, billing or accounts', () => {
    for (const forbidden of [
      'providerRegistry',
      'credentialResolver',
      'sessionSecrets',
      'sessionKeyRoutes',
      'providerStatus',
      'providerCatalog',
      'effectiveSelection',
      'parseSelectionMetadata',
      'textPricingGuard',
      'rateLimiter',
      'geminiClient',
      'openrouter',
      'deepseek',
      'stripe',
      'paddle',
      'billing',
      'subscription',
      'customerId',
      'accountId',
      'jwt',
      'license',
      'userId',
    ]) {
      expect(MODULE_CODE.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('performs no persistence and no network I/O', () => {
    expect(MODULE_CODE).not.toContain('node:fs');
    expect(MODULE_CODE).not.toContain('writeFile');
    expect(MODULE_CODE).not.toContain('fetch(');
    expect(MODULE_CODE).not.toContain('localStorage');
    expect(MODULE_CODE).not.toContain('indexedDB');
    expect(MODULE_CODE).not.toContain('crypto');
  });

  it('does not define a fifth feature or a product-access vocabulary of its own', () => {
    // The gate reuses AI-5A's feature check; it never defines its own.
    expect(MODULE_CODE).toContain('isNutritionProductFeatureEntitled');
    expect(MODULE_CODE).toContain('resolveNutritionProductAccess');
    expect(MODULE_CODE).not.toContain('ai_recipe_context_application');
    expect(MODULE_CODE).not.toMatch(/interface\s+NutritionProductAccess\b/);
    expect(MODULE_CODE).not.toMatch(/type\s+NutritionProductAiFeature\s*=/);
    expect(MODULE_CODE).not.toMatch(/type\s+NutritionProductTier\s*=/);
  });

  it('delegates parsing rather than reimplementing it', () => {
    // Fail-closed semantics come from the AI-5A resolver, so the server boundary and
    // the product contract can never drift apart.
    expect(MODULE_CODE).not.toMatch(/toLowerCase\(\)/);
    expect(MODULE_CODE).not.toMatch(/\.trim\(\)/);
    expect(MODULE_CODE).not.toMatch(/=== ['"]ai_advanced['"]/);
  });

  it('adds no product-access status endpoint and exposes no access reader', () => {
    // Enforcement only: no client product-state synchronization in AI-5B.
    expect(MODULE_CODE).not.toContain('/api/');
    expect(MODULE_CODE).not.toMatch(/app\.(get|post|use)\b/);
    expect(MODULE_CODE).not.toMatch(/function\s+(get|read|fetch)[A-Za-z]*ProductAccess/);
  });
});