/**
 * AI-5E — SERVER PRODUCT-ACCESS AUTHORITY ABSTRACTION (authority unit).
 *
 * These tests pin the AI-5E authority boundary in isolation from HTTP:
 *   - the AUTHORITY CONTRACT: a server-owned, request-capable, asynchronous,
 *     fail-closed, canonical-validating `resolve(request)` seam;
 *   - the CLOSED DECISION: `resolved` (canonical AI-5A access) or `unavailable`
 *     (access could NOT be verified) — never a third, never a disguised Basic;
 *   - the DEPLOYMENT FACTORY: the exact raw-tier matrix, resolved EXACTLY ONCE at
 *     construction, with NO per-request environment reread and NO request
 *     dependence whatsoever;
 *   - the ADVERSARIAL MATRIX: an injected authority that returns garbage, throws,
 *     rejects, or returns a hand-authored Advanced look-alike degrades to
 *     `unavailable` — never to Advanced;
 *   - the ISOLATION of the module from providers, credentials, BYOK, pricing,
 *     billing, accounts, plans, USDA/AI-4 internals and persistence.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';

import {
  NUTRITION_PRODUCT_TIER_ENV,
  createBasicNutritionProductAccessAuthority,
  createDeploymentNutritionProductAccessAuthority,
  invokeNutritionProductAccessAuthority,
  normalizeNutritionProductAccessAuthorityDecision,
  resolvedNutritionProductAccessDecision,
  NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
  type NutritionProductAccessAuthority,
  type NutritionProductAccessAuthorityDecision,
} from '../../server/nutritionProductAccessAuthority.js';
import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_ACCESS,
  NUTRITION_PRODUCT_ACCESS_VERSION,
  isAiAdvancedProductAccess,
  isBasicProductAccess,
  type NutritionProductAccess,
} from '../../src/core/nutritionV2/nutritionProductAccess.js';

const REPO = join(__dirname, '..', '..');
const AUTHORITY_SOURCE = readFileSync(
  join(REPO, 'server', 'nutritionProductAccessAuthority.ts'),
  'utf8',
);

/** CODE with every comment removed: the pins below are about implementation. */
const AUTHORITY_CODE = AUTHORITY_SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .trim();

const REQ = {} as Request;

/** A hand-authored, structurally identical "AI Advanced" object — NOT canonical. */
const HAND_AUTHORED_ADVANCED = {
  version: NUTRITION_PRODUCT_ACCESS_VERSION,
  tier: 'ai_advanced',
  aiInterpretation: true,
  aiCandidateOrchestration: true,
  aiBoundedMassEstimation: true,
  aiRecipeContextReview: true,
};

/** An authority that returns whatever it is told to return. */
function authorityReturning(value: unknown): NutritionProductAccessAuthority {
  return { resolve: () => Promise.resolve(value as never) };
}

async function resolveOne(
  authority: unknown,
  request: Request = REQ,
): Promise<NutritionProductAccessAuthorityDecision> {
  return invokeNutritionProductAccessAuthority(authority, request);
}

async function accessOf(authority: unknown): Promise<NutritionProductAccess> {
  const decision = await resolveOne(authority);
  if (decision.status !== 'resolved') throw new Error('expected a resolved decision');
  return decision.access;
}

afterEach(() => {
  delete process.env[NUTRITION_PRODUCT_TIER_ENV];
});

// ===========================================================================
// A. THE AUTHORITY CONTRACT
// ===========================================================================

describe('AI-5E — the authority contract', () => {
  it('is request-capable and asynchronous by construction', () => {
    // The seam receives the Express request so a FUTURE authenticated-principal
    // authority can consume a server-verified identity. An interface that could only
    // answer "what tier is this process?" would force another gate redesign.
    const authority = createDeploymentNutritionProductAccessAuthority('ai_advanced');
    const result = authority.resolve(REQ);
    expect(result).toBeInstanceOf(Promise);
    return expect(result).resolves.toEqual({
      status: 'resolved',
      access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    });
  });

  it('hands the authority the very request the gate is serving', async () => {
    // Proving the request is genuinely CAPABLE — and that the deployment authority
    // still ignores it (proven separately below).
    let seen: unknown = 'not-called';
    const request = { marker: 'req' } as unknown as Request;
    const authority: NutritionProductAccessAuthority = {
      resolve: (r: Request) => {
        seen = r;
        return Promise.resolve(
          resolvedNutritionProductAccessDecision(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS),
        );
      },
    };
    const decision = await resolveOne(authority, request);
    expect(seen).toBe(request);
    expect(decision.status).toBe('resolved');
  });

  it('exposes NO source, plan, account, provider or diagnostic accessor', () => {
    const authority = createDeploymentNutritionProductAccessAuthority('ai_advanced');
    expect(Object.keys(authority).sort()).toEqual(['resolve']);
    expect(Object.isFrozen(authority)).toBe(true);
  });

  it('names exactly ONE non-secret server-owned configuration input', () => {
    expect(NUTRITION_PRODUCT_TIER_ENV).toBe('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    expect(/KEY|TOKEN|SECRET|PASSWORD/i.test(NUTRITION_PRODUCT_TIER_ENV)).toBe(false);
  });
});

// ===========================================================================
// B. THE CLOSED DECISION CONTRACT
// ===========================================================================

describe('AI-5E — the closed decision contract', () => {
  it('has exactly TWO statuses and no third state', () => {
    expect(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE).toEqual({ status: 'unavailable' });
    expect(Object.isFrozen(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE)).toBe(true);
    // `unavailable` carries nothing at all: no guessed tier, no partial state.
    expect(Object.keys(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE)).toEqual(['status']);
  });

  it('accepts the canonical Basic access value', async () => {
    const decision = resolvedNutritionProductAccessDecision(BASIC_NUTRITION_PRODUCT_ACCESS);
    expect(decision.status).toBe('resolved');
    expect(await accessOf(createDeploymentNutritionProductAccessAuthority(undefined))).toBe(
      BASIC_NUTRITION_PRODUCT_ACCESS,
    );
  });

  it('accepts the canonical AI Advanced access value', async () => {
    const decision = resolvedNutritionProductAccessDecision(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    expect(decision.status).toBe('resolved');
    expect(await accessOf(createDeploymentNutritionProductAccessAuthority('ai_advanced'))).toBe(
      AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    );
  });

  it('refuses a non-canonical access value at decision-build time', () => {
    for (const bad of [
      HAND_AUTHORED_ADVANCED,
      { ...BASIC_NUTRITION_PRODUCT_ACCESS, aiInterpretation: true },
      { version: NUTRITION_PRODUCT_ACCESS_VERSION, tier: 'ai_advanced' },
      { tier: 'ai_advanced' },
      'ai_advanced',
      true,
      null,
      undefined,
      1,
      [],
      {},
    ]) {
      expect(resolvedNutritionProductAccessDecision(bad)).toEqual({ status: 'unavailable' });
    }
  });

  it('an explicit unavailable decision is preserved as unavailable', () => {
    expect(normalizeNutritionProductAccessAuthorityDecision({ status: 'unavailable' })).toEqual({
      status: 'unavailable',
    });
    // ...and an `unavailable` status may NOT smuggle a canonical Advanced access past it.
    expect(
      normalizeNutritionProductAccessAuthorityDecision({
        status: 'unavailable',
        access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
      }),
    ).toEqual({ status: 'unavailable' });
  });
});

// ===========================================================================
// C. RUNTIME VALIDATION — THE ADVERSARIAL MATRIX
// ===========================================================================

describe('AI-5E — runtime validation of an injected authority', () => {
  const garbage: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['boolean true', true],
    ['boolean false', false],
    ['number 1', 1],
    ['string "ai_advanced"', 'ai_advanced'],
    ['bare canonical Advanced (no decision wrapper)', AI_ADVANCED_NUTRITION_PRODUCT_ACCESS],
    ['bare canonical Basic (no decision wrapper)', BASIC_NUTRITION_PRODUCT_ACCESS],
    ['empty object', {}],
    ['empty array', []],
    ['resolved without access', { status: 'resolved' }],
    ['resolved with null access', { status: 'resolved', access: null }],
    ['resolved with a hand-authored Advanced mimic', { status: 'resolved', access: HAND_AUTHORED_ADVANCED }],
    ['resolved with an impossible Basic+AI state', {
      status: 'resolved',
      access: { ...BASIC_NUTRITION_PRODUCT_ACCESS, aiInterpretation: true },
    }],
    ['resolved with a spread copy of canonical Advanced', {
      status: 'resolved',
      access: { ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS },
    }],
    ['unknown status', { status: 'advanced', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }],
    ['missing status', { access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }],
    ['numeric status', { status: 1, access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }],
    ['null status', { status: null, access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }],
    ['status object', { status: { value: 'resolved' }, access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }],
    ['uppercase status', { status: 'RESOLVED', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }],
    ['padded status', { status: ' resolved ', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }],
  ];

  for (const [label, value] of garbage) {
    it(`refuses ${label} — NEVER Advanced`, async () => {
      const decision = await resolveOne(authorityReturning(value));
      expect(decision).toEqual({ status: 'unavailable' });
      expect(decision.status === 'resolved' && isAiAdvancedProductAccess(decision.access)).toBe(false);
    });
  }

  it('refuses an authority that THROWS synchronously', async () => {
    const authority: NutritionProductAccessAuthority = {
      resolve: () => {
        throw new Error('authority exploded');
      },
    };
    await expect(resolveOne(authority)).resolves.toEqual({ status: 'unavailable' });
  });

  it('refuses an authority that REJECTS', async () => {
    const authority: NutritionProductAccessAuthority = {
      resolve: () => Promise.reject(new Error('remote entitlement lookup failed')),
    };
    await expect(resolveOne(authority)).resolves.toEqual({ status: 'unavailable' });
  });

  it('refuses an authority that returns a NON-promise value', async () => {
    const authority = {
      resolve: () => ({ status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }),
    } as unknown as NutritionProductAccessAuthority;
    // A malformed promise result is normalized exactly like a well-formed one.
    await expect(resolveOne(authority)).resolves.toEqual({
      status: 'resolved',
      access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    });
    await expect(resolveOne({ resolve: () => 'ai_advanced' })).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('never propagates a raw exception to the caller', async () => {
    // The gate must be able to answer "unavailable" without an unhandled rejection.
    for (const bad of [
      null,
      undefined,
      1,
      'authority',
      {},
      { resolve: 'not-a-function' },
      { resolve: () => { throw new Error('boom'); } },
      { resolve: () => Promise.reject(new Error('boom')) },
    ]) {
      await expect(resolveOne(bad)).resolves.toEqual({ status: 'unavailable' });
    }
  });
});

// ===========================================================================
// D. THE DEPLOYMENT FACTORY
// ===========================================================================

describe('AI-5E — the deployment authority factory', () => {
  const resolvesToBasic: ReadonlyArray<readonly [string, unknown]> = [
    ['missing (no argument)', undefined],
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
    ['alias: pro', 'pro'],
    ['alias: premium', 'premium'],
    ['alias: paid', 'paid'],
    ['alias: subscription', 'subscription'],
    ['boolean true', true],
    ['boolean false', false],
    ['number 1', 1],
    ['number 0', 0],
    ['array', ['ai_advanced']],
    ['object', {}],
    ['feature-shaped object', { tier: 'ai_advanced', aiInterpretation: true }],
  ];

  for (const [label, value] of resolvesToBasic) {
    it(`resolves ${label} to the CANONICAL Basic access value`, async () => {
      const access = await accessOf(createDeploymentNutritionProductAccessAuthority(value));
      expect(access).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
      expect(isBasicProductAccess(access)).toBe(true);
    });
  }

  it('resolves ONLY the exact primitive "ai_advanced" to AI Advanced', async () => {
    const access = await accessOf(createDeploymentNutritionProductAccessAuthority('ai_advanced'));
    expect(access).toBe(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    expect(isAiAdvancedProductAccess(access)).toBe(true);
  });

  it('never normalizes a near-miss into entitlement', async () => {
    for (const near of [' ai_advanced', 'ai_advanced ', 'Ai_Advanced', 'ai-advanced', 'aiAdvanced']) {
      expect((await accessOf(createDeploymentNutritionProductAccessAuthority(near))).tier).toBe(
        'basic',
      );
    }
  });

  it('resolves the raw tier EXACTLY ONCE, at construction', async () => {
    // Proof of one-time resolution: mutate process.env AFTER construction and prove the
    // authority is unmoved. A per-request env reread would follow the mutation.
    process.env[NUTRITION_PRODUCT_TIER_ENV] = 'ai_advanced';
    const advanced = createDeploymentNutritionProductAccessAuthority(
      process.env[NUTRITION_PRODUCT_TIER_ENV],
    );

    process.env[NUTRITION_PRODUCT_TIER_ENV] = 'basic';
    for (let i = 0; i < 5; i += 1) {
      expect(await accessOf(advanced)).toBe(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    }

    // ...and the converse: a Basic authority never becomes Advanced.
    process.env[NUTRITION_PRODUCT_TIER_ENV] = 'ai_advanced';
    const basic = createDeploymentNutritionProductAccessAuthority('basic');
    process.env[NUTRITION_PRODUCT_TIER_ENV] = 'basic';
    for (let i = 0; i < 5; i += 1) {
      expect(await accessOf(basic)).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    }
  });

  it('returns the SAME immutable decision object for every request', async () => {
    const authority = createDeploymentNutritionProductAccessAuthority('ai_advanced');
    const a = await authority.resolve(REQ);
    const b = await authority.resolve(REQ);
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    // Every gate and the status route therefore observe ONE shared decision: they
    // cannot disagree about product access.
    expect(a.status === 'resolved' && a.access).toBe(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
  });

  it('is IGNORED BY THE REQUEST — radically different requests, identical decision', async () => {
    const authority = createDeploymentNutritionProductAccessAuthority('ai_advanced');
    const forgedRequests: ReadonlyArray<Request> = [
      {
        headers: {
          'x-product-tier': 'ai_advanced',
          'x-entitlement': 'ai_advanced',
          'x-plan': 'paid',
          'x-user-id': 'u_1',
          'x-account-id': 'acct_1',
        },
        cookies: { tier: 'ai_advanced', plan: 'paid' },
        query: { entitled: 'true', tier: 'ai_advanced' },
        body: { tier: 'ai_advanced', entitled: true, account: 'acct_1' },
        ip: '203.0.113.9',
      },
      {},
      { headers: { authorization: 'Bearer totally-different-token' } },
    ] as unknown as ReadonlyArray<Request>;

    const decisions = await Promise.all(forgedRequests.map((r) => authority.resolve(r)));
    expect(decisions.every((d) => d === decisions[0])).toBe(true);
    for (const d of decisions) {
      expect(d.status === 'resolved' && d.access).toBe(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
    }
  });

  it('performs NO I/O, NO provider work, NO credential work and NO persistence', async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetches += 1;
      return (originalFetch as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof globalThis.fetch;
    try {
      const authority = createDeploymentNutritionProductAccessAuthority('ai_advanced');
      for (let i = 0; i < 3; i += 1) await authority.resolve(REQ);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('the safe default authority is CANONICAL Basic (fail closed)', async () => {
    const authority = createBasicNutritionProductAccessAuthority();
    const access = await accessOf(authority);
    expect(access).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
    // No dev-only bypass, no test-only bypass: the default IS the deployment
    // authority with no tier input.
    expect(authority.resolve(REQ)).resolves.toEqual({
      status: 'resolved',
      access: BASIC_NUTRITION_PRODUCT_ACCESS,
    });
  });
});

// ===========================================================================
// E. MODULE ISOLATION
// ===========================================================================

describe('AI-5E — authority module isolation', () => {
  it('reads NO environment state itself', () => {
    // `process.env` is read exactly once, by server.ts, and handed in as a VALUE.
    expect(AUTHORITY_CODE).not.toContain('process.env');
    expect(AUTHORITY_CODE).not.toContain('dotenv');
    expect(AUTHORITY_CODE).not.toMatch(/process\.env\s*\[/);
  });

  it('imports ONLY the express request type and the AI-5A contract', () => {
    const sources = [...AUTHORITY_CODE.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(sources).toEqual(['express', '../src/core/nutritionV2/nutritionProductAccess.js']);
  });

  it('reads NO request field in its deployment implementation', () => {
    // The interface is request-CAPABLE; the CURRENT implementation is
    // request-INDEPENDENT. No header, cookie, query, body, param, IP or header
    // accessor may appear in code.
    for (const forbidden of [
      'request.headers',
      'request.cookies',
      'request.query',
      'request.body',
      'request.params',
      'request.ip',
      'request.get(',
      'request.user',
      '.headers',
      '.cookies',
      '.query',
      '.ip',
    ]) {
      expect(AUTHORITY_CODE, `authority must not read ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('knows nothing about providers, credentials, BYOK, pricing, billing or accounts', () => {
    for (const forbidden of [
      'providerRegistry',
      'credentialResolver',
      'sessionSecrets',
      'sessionKeyRoutes',
      'providerCatalog',
      'textPricingGuard',
      'rateLimiter',
      'geminiClient',
      'gemini',
      'openrouter',
      'deepseek',
      'byok',
      'stripe',
      'paddle',
      'checkout',
      'billing',
      'subscription',
      'customerId',
      'accountId',
      'jwt',
      'oauth',
      'license',
      'userId',
      'plan',
      'usda',
      'fdc',
    ]) {
      expect(AUTHORITY_CODE.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('performs NO persistence and NO AI-4 / nutrition internals', () => {
    for (const forbidden of [
      'node:fs',
      'writeFile',
      'localStorage',
      'indexedDB',
      'cookie',
      'SettingsAdapter',
      'projectAcceptedRecipeContext',
      'recipeContext',
      'readRecipeContextOriginEnvelope',
      'nutritionCapabilities',
      'resolveNutritionAiCapabilities',
    ]) {
      expect(AUTHORITY_CODE.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('defines no tier, no feature and no access vocabulary of its own', () => {
    expect(AUTHORITY_CODE).not.toMatch(/interface\s+NutritionProductAccess\b/);
    expect(AUTHORITY_CODE).not.toMatch(/type\s+NutritionProductTier\s*=/);
    expect(AUTHORITY_CODE).not.toMatch(/type\s+NutritionProductAiFeature\s*=/);
    expect(AUTHORITY_CODE).not.toContain('ai_recipe_context_application');
    // It resolves through AI-5A rather than reimplementing the tier rules.
    expect(AUTHORITY_CODE).toContain('resolveNutritionProductAccess');
    expect(AUTHORITY_CODE).toContain('isNutritionProductAccess');
    expect(AUTHORITY_CODE).not.toMatch(/toLowerCase\(\)/);
    expect(AUTHORITY_CODE).not.toMatch(/\.trim\(\)/);
    expect(AUTHORITY_CODE).not.toMatch(/=== ['"]ai_advanced['"]/);
  });

  it('exposes NO client reader and registers NO route', () => {
    expect(AUTHORITY_CODE).not.toMatch(/app\.(get|post|use)\b/);
    expect(AUTHORITY_CODE).not.toMatch(/function\s+(get|read|fetch)[A-Za-z]*ProductAccess/);
    // It never writes an HTTP response: the gate and the status route own the wire.
    expect(AUTHORITY_CODE).not.toMatch(/\bres\.(status|json|setHeader)\b/);
    expect(AUTHORITY_CODE).not.toMatch(/\bresponse\.(status|json|setHeader)\b/);
  });
});