/**
 * AI-5F — PRODUCT-ACCESS AUTHORITY EXCEPTION-TOTALITY HARDENING.
 *
 * AI-5E created the server-owned product-access authority abstraction and its own
 * review raised ONE non-blocking robustness NOTE: the invocation boundary was not
 * literally exception-total for two SERVER-INJECTED `Proxy`-shaped values.
 *
 *   1. an authority `Proxy` whose `resolve` property GETTER throws, because the read
 *      happened BEFORE the invocation `try`;
 *   2. a returned decision `Proxy` whose `status` or `access` property getter throws
 *      during normalization, which ran OUTSIDE that `try`.
 *
 * Neither shape is request-reachable today (the authority is composed by the server,
 * never selected by a client), neither is an entitlement bypass, and neither leaked —
 * but the boundary documents that it "never throws", and for property-access failures
 * that claim was false. These tests pin the repair, WITHOUT weakening anything:
 *
 *   - A. THE NORMALIZER IS EXCEPTION-TOTAL: every pathological raw value returns the
 *     canonical unavailable singleton and `normalize…` never throws.
 *   - B. THE INVOCATION BOUNDARY IS EXCEPTION-TOTAL: every pathological authority
 *     shape RESOLVES (never rejects) to the canonical unavailable singleton.
 *   - C. READ-ONCE: `status` and `access` are each sampled exactly ONCE, so a getter
 *     that changes its answer can never be sampled twice (no TOCTOU).
 *   - D. CANONICAL IDENTITY IS STILL LOAD-BEARING: read-once did not soften the
 *     AI-5A gate — forgeries, clones, prototype tricks and `Proxy` wrappers all still
 *     resolve to `unavailable`.
 *   - E. NO TIMEOUT, NO RETRY, EXACTLY ONCE: hardening added no deadline and no
 *     second attempt, and a never-settling authority still just leaves the request
 *     pending (an explicitly unchanged, still-open architecture question).
 *   - F. NO ENTITLEMENT EXPANSION: the module still knows nothing about providers,
 *     BYOK, pricing, accounts, billing, plans, principals, persistence or requests.
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

// ===========================================================================
// ADVERSARY BUILDERS — the pathological SERVER-INJECTED shapes AI-5F names.
// ===========================================================================

/** A `Proxy` whose `get('resolve')` throws — the AI-5E NOTE, case 1. */
function authorityWithThrowingResolveGetter(): unknown {
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'resolve') throw new Error('resolve getter exploded');
        return Reflect.get(target, prop);
      },
    },
  );
}

/** A `Proxy` whose `get('resolve')` returns a non-function — case 2. */
function authorityWithNonFunctionResolve(): unknown {
  return new Proxy({}, { get: () => 'not-a-function' });
}

/** An authority whose `resolve` is a `Proxy` function whose apply trap throws — case 3. */
function authorityWithApplyTrap(): NutritionProductAccessAuthority {
  const inner = () => Promise.resolve({ status: 'unavailable' });
  return new Proxy(inner, {
    apply() {
      throw new Error('apply trap exploded');
    },
  }) as unknown as NutritionProductAccessAuthority;
}

/** A returned decision `Proxy` whose `get('status')` throws — case 4. */
function decisionWithThrowingStatusGetter(): unknown {
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'status') throw new Error('status getter exploded');
        return Reflect.get(target, prop);
      },
    },
  );
}

/** `{ status: 'resolved', access: <getter throws> }` — case 5. */
function decisionWithThrowingAccessGetter(): unknown {
  return {
    status: 'resolved',
    get access(): unknown {
      throw new Error('access getter exploded');
    },
  };
}

/** A REVOKED `Proxy` authority — case 6. */
function revokedAuthority(): unknown {
  const { proxy, revoke } = Proxy.revocable(
    { resolve: () => Promise.resolve({ status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }) },
    {},
  );
  revoke();
  return proxy;
}

/** A REVOKED `Proxy` returned as the decision — case 7. */
function revokedDecision(): unknown {
  const { proxy, revoke } = Proxy.revocable(
    { status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS },
    {},
  );
  revoke();
  return proxy;
}

/** A returned thenable whose `then` GETTER throws — case 8. */
function thenableWithThrowingThenGetter(): unknown {
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'then') throw new Error('then getter exploded');
        return Reflect.get(target, prop);
      },
    },
  );
}

/** A returned thenable whose `then` execution REJECTS — case 9. */
function thenableThatRejects(): unknown {
  return {
    then(_resolve: unknown, reject: (reason: unknown) => void): void {
      reject(new Error('thenable execution rejected'));
    },
  };
}

/**
 * Case 10: a decision whose `status` getter CHANGES VALUE ACROSS READS.
 *
 * The first sampled answer is deliberately not `resolved`, so the single sample the
 * normalizer takes fails closed — and the read count proves the second, different
 * answer was never even asked for.
 */
function decisionWithFlippingStatus(): { decision: unknown; statusReads: () => number } {
  let reads = 0;
  return {
    statusReads: () => reads,
    decision: {
      get status(): unknown {
        reads += 1;
        return reads === 1 ? 'unavailable' : 'resolved';
      },
      access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    },
  };
}

// ===========================================================================
// A. THE NORMALIZER IS EXCEPTION-TOTAL
// ===========================================================================

describe('AI-5F — the normalizer never throws', () => {
  const PATHOLOGICAL_RAW: ReadonlyArray<readonly [string, unknown]> = [
    ['a `Proxy` whose `get(status)` throws', decisionWithThrowingStatusGetter()],
    ['a `Proxy` whose `get(access)` throws', new Proxy({ status: 'resolved' }, {
      get(target, prop) {
        if (prop === 'access') throw new Error('access getter exploded');
        return Reflect.get(target, prop);
      },
    })],
    ['a `Proxy` whose `get(status)` throws and whose `get(access)` throws', new Proxy({ status: 'resolved' }, {
      get() {
        throw new Error('every getter exploded');
      },
    })],
    ['`{ status: resolved, access: <throwing getter> }`', decisionWithThrowingAccessGetter()],
    ['a REVOKED `Proxy` decision', revokedDecision()],
    ['a thenable whose `then` getter throws', thenableWithThrowingThenGetter()],
    ['a thenable whose execution rejects', thenableThatRejects()],
    ['a `Proxy` array-shaped decision', new Proxy([], { get: () => 'resolved' })],
    ['a `Proxy` with a hostile `has` trap', new Proxy({ status: 'resolved' }, {
      has() {
        throw new Error('has trap exploded');
      },
    })],
    ['a primitive boxed `Proxy`', new Proxy(Object(1), {
      get() {
        throw new Error('boxed getter exploded');
      },
    })],
  ];

  for (const [label, raw] of PATHOLOGICAL_RAW) {
    it(`returns the canonical unavailable singleton for ${label} — and does not throw`, () => {
      let result: NutritionProductAccessAuthorityDecision | undefined;
      expect(() => {
        result = normalizeNutritionProductAccessAuthorityDecision(raw);
      }).not.toThrow();
      expect(result).toBe(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE);
    });
  }

  it('is exception-total for EVERY value the AI-5E matrix already refused', () => {
    // Regression guard: AI-5F must not have narrowed or reordered the existing
    // validation. Every pre-existing refusal is still the same frozen singleton.
    const garbage: ReadonlyArray<unknown> = [
      null,
      undefined,
      true,
      false,
      0,
      1,
      '',
      'ai_advanced',
      [],
      {},
      { status: 'resolved' },
      { status: 'resolved', access: null },
      { status: 'resolved', access: HAND_AUTHORED_ADVANCED },
      { status: 'resolved', access: { ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS } },
      { status: 'resolved', access: { ...BASIC_NUTRITION_PRODUCT_ACCESS, aiInterpretation: true } },
      { status: 'unavailable' },
      { status: 'unavailable', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS },
      { status: 'advanced', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS },
      { access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS },
      { status: 1 },
      { status: null },
      { status: 'RESOLVED' },
      { status: ' resolved ' },
      AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
      BASIC_NUTRITION_PRODUCT_ACCESS,
    ];
    for (const raw of garbage) {
      expect(() => normalizeNutritionProductAccessAuthorityDecision(raw)).not.toThrow();
      expect(normalizeNutritionProductAccessAuthorityDecision(raw)).toEqual({
        status: 'unavailable',
      });
    }
  });

  it('still accepts EXACTLY the two canonical decisions', () => {
    expect(
      normalizeNutritionProductAccessAuthorityDecision({
        status: 'resolved',
        access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
      }),
    ).toEqual({ status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS });
    expect(
      normalizeNutritionProductAccessAuthorityDecision({
        status: 'resolved',
        access: BASIC_NUTRITION_PRODUCT_ACCESS,
      }),
    ).toEqual({ status: 'resolved', access: BASIC_NUTRITION_PRODUCT_ACCESS });
    expect(normalizeNutritionProductAccessAuthorityDecision({ status: 'unavailable' })).toEqual({
      status: 'unavailable',
    });
  });
});

// ===========================================================================
// B. THE INVOCATION BOUNDARY IS EXCEPTION-TOTAL
// ===========================================================================

describe('AI-5F — the invocation boundary never rejects', () => {
  const PATHOLOGICAL_AUTHORITIES: ReadonlyArray<readonly [string, unknown]> = [
    ['a `Proxy` whose `get(resolve)` throws', authorityWithThrowingResolveGetter()],
    ['a `Proxy` whose `get(resolve)` returns a non-function', authorityWithNonFunctionResolve()],
    ['a REVOKED `Proxy` authority', revokedAuthority()],
    ['an authority whose `resolve` is a `Proxy` function with a throwing apply trap', authorityWithApplyTrap()],
    ['an authority returning a decision `Proxy` whose `get(status)` throws', authorityReturning(decisionWithThrowingStatusGetter())],
    ['an authority returning `{ status: resolved, access: <throwing getter> }`', authorityReturning(decisionWithThrowingAccessGetter())],
    ['an authority returning a REVOKED `Proxy` decision', authorityReturning(revokedDecision())],
    ['an authority returning a thenable whose `then` getter throws', { resolve: () => thenableWithThrowingThenGetter() }],
    ['an authority returning a thenable whose execution rejects', { resolve: () => thenableThatRejects() }],
    ['an authority returning an unresolvable thenable (a Promise subclass proxy)', { resolve: () => thenableThatRejects() }],
    ['an authority that is itself a revoked `Proxy` FUNCTION', (() => {
      const { proxy, revoke } = Proxy.revocable(() => Promise.resolve({ status: 'unavailable' }), {});
      revoke();
      return proxy;
    })()],
    ['an authority whose `resolve` throws while reading its own `then`', { resolve: () => ({ get then(): unknown { throw new Error('nested then exploded'); } }) }],
  ];

  for (const [label, authority] of PATHOLOGICAL_AUTHORITIES) {
    it(`RESOLVES to the canonical unavailable singleton for ${label}`, async () => {
      let promise: Promise<NutritionProductAccessAuthorityDecision>;
      expect(() => {
        promise = invokeNutritionProductAccessAuthority(authority, REQ);
      }).not.toThrow();
      // Not merely "does not throw": the promise RESOLVES. No rejection escapes.
      await expect(promise!).resolves.toBe(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE);
    });
  }

  it('a status getter that flips across reads fails closed on ONE sample', async () => {
    const { decision, statusReads } = decisionWithFlippingStatus();
    await expect(invokeNutritionProductAccessAuthority(authorityReturning(decision), REQ)).resolves.toBe(
      NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
    );
    // The second, different answer was never requested.
    expect(statusReads()).toBe(1);
  });

  it('never fabricates Basic or Advanced from a hostile authority', async () => {
    const decisions: NutritionProductAccessAuthorityDecision[] = [];
    for (const [, authority] of PATHOLOGICAL_AUTHORITIES) {
      decisions.push(await invokeNutritionProductAccessAuthority(authority, REQ));
    }
    for (const decision of decisions) {
      expect(decision.status).toBe('unavailable');
      expect(decision.status === 'resolved' && isAiAdvancedProductAccess(decision.access)).toBe(false);
    }
  });

  it('still resolves a NORMAL authority to its canonical decision', async () => {
    for (const [tier, expected] of [
      ['basic', BASIC_NUTRITION_PRODUCT_ACCESS],
      ['ai_advanced', AI_ADVANCED_NUTRITION_PRODUCT_ACCESS],
    ] as ReadonlyArray<readonly [string, NutritionProductAccess]>) {
      const decision = await invokeNutritionProductAccessAuthority(
        createDeploymentNutritionProductAccessAuthority(tier),
        REQ,
      );
      expect(decision).toEqual({ status: 'resolved', access: expected });
    }
    expect(await invokeNutritionProductAccessAuthority(null, REQ)).toBe(
      NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
    );
    expect(await invokeNutritionProductAccessAuthority(undefined, REQ)).toBe(
      NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
    );
    expect(await invokeNutritionProductAccessAuthority({}, REQ)).toBe(
      NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
    );
    expect(await invokeNutritionProductAccessAuthority({ resolve: 7 }, REQ)).toBe(
      NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
    );
    expect(await invokeNutritionProductAccessAuthority({ resolve: () => ({ status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }) }, REQ)).toEqual({
      status: 'resolved',
      access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    });
  });

  it('hands the authority the very request it is serving, and reads `resolve` ONCE', async () => {
    let seen: unknown = 'not-called';
    let resolveReads = 0;
    const request = { marker: 'req' } as unknown as Request;
    const authority = {
      get resolve() {
        resolveReads += 1;
        return (r: Request): Promise<NutritionProductAccessAuthorityDecision> => {
          seen = r;
          return Promise.resolve(
            resolvedNutritionProductAccessDecision(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS),
          );
        };
      },
    } as unknown as NutritionProductAccessAuthority;
    const decision = await invokeNutritionProductAccessAuthority(authority, request);
    expect(seen).toBe(request);
    expect(decision.status).toBe('resolved');
    // One request, one authority attempt, ONE property read.
    expect(resolveReads).toBe(1);
  });
});

// ===========================================================================
// C. READ-ONCE SEMANTICS
// ===========================================================================

describe('AI-5F — each authority field is sampled exactly once', () => {
  it('samples `status` exactly once, even on the refusal path', () => {
    let statusReads = 0;
    let accessReads = 0;
    const decision = {
      get status(): unknown {
        statusReads += 1;
        return 'unavailable';
      },
      get access(): unknown {
        accessReads += 1;
        return AI_ADVANCED_NUTRITION_PRODUCT_ACCESS;
      },
    };
    expect(normalizeNutritionProductAccessAuthorityDecision(decision)).toEqual({
      status: 'unavailable',
    });
    expect(statusReads).toBe(1);
    // Status wins, so `access` is never even touched.
    expect(accessReads).toBe(0);
  });

  it('samples `access` exactly once on the resolved path', () => {
    let statusReads = 0;
    let accessReads = 0;
    const decision = {
      get status(): unknown {
        statusReads += 1;
        return 'resolved';
      },
      get access(): unknown {
        accessReads += 1;
        return AI_ADVANCED_NUTRITION_PRODUCT_ACCESS;
      },
    };
    expect(normalizeNutritionProductAccessAuthorityDecision(decision)).toEqual({
      status: 'resolved',
      access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    });
    expect(statusReads).toBe(1);
    expect(accessReads).toBe(1);
  });

  it('samples `access` at most once when it is NOT canonical', () => {
    let accessReads = 0;
    const decision = {
      status: 'resolved',
      get access(): unknown {
        accessReads += 1;
        return HAND_AUTHORED_ADVANCED;
      },
    };
    expect(normalizeNutritionProductAccessAuthorityDecision(decision)).toEqual({
      status: 'unavailable',
    });
    expect(accessReads).toBe(1);
  });

  it('a `Proxy` decision is sampled through the trap exactly once per field', () => {
    const reads: string[] = [];
    const decision = new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        reads.push(String(prop));
        if (prop === 'status') return 'resolved';
        if (prop === 'access') return AI_ADVANCED_NUTRITION_PRODUCT_ACCESS;
        return undefined;
      },
    });
    expect(normalizeNutritionProductAccessAuthorityDecision(decision)).toEqual({
      status: 'resolved',
      access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    });
    // Exactly one `status` read and one `access` read — no re-validation round trip.
    expect(reads.filter((p) => p === 'status')).toHaveLength(1);
    expect(reads.filter((p) => p === 'access')).toHaveLength(1);
  });
});

// ===========================================================================
// D. CANONICAL IDENTITY IS STILL LOAD-BEARING
// ===========================================================================

describe('AI-5F — read-once did not soften the AI-5A canonical gate', () => {
  it('refuses every non-canonical access value, including `Proxy` wrappers', async () => {
    const nonCanonical: ReadonlyArray<readonly [string, unknown]> = [
      ['hand-authored Advanced mimic', HAND_AUTHORED_ADVANCED],
      ['spread clone of canonical Advanced', { ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }],
      ['spread clone of canonical Basic', { ...BASIC_NUTRITION_PRODUCT_ACCESS }],
      ['structural clone (JSON round trip)', JSON.parse(JSON.stringify(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS))],
      ['Basic with AI flags altered', { ...BASIC_NUTRITION_PRODUCT_ACCESS, aiInterpretation: true }],
      ['Advanced with AI flags cleared', { ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, aiRecipeContextReview: false }],
      ['forged version', { ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, version: 'nutrition_product_access_v2' }],
      ['forged tier', { ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, tier: 'ai_advanced_pro' }],
      ['forged feature vocabulary', { ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, ai_recipe_context_application: true }],
      ['`Proxy` around a canonical Advanced', new Proxy(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS, {})],
      ['`Proxy` around a spread clone', new Proxy({ ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }, {})],
      ['object with a poisoned prototype', Object.assign(Object.create(null), { ...AI_ADVANCED_NUTRITION_PRODUCT_ACCESS })],
      ['`Object.create(canonical)` prototype trick', Object.create(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)],
      ['a `Proxy` whose `get(version)` throws', new Proxy(HAND_AUTHORED_ADVANCED, {
        get(target, prop) {
          if (prop === 'version') throw new Error('version getter exploded');
          return Reflect.get(target, prop);
        },
      })],
    ];
    for (const [label, access] of nonCanonical) {
      expect(
        resolvedNutritionProductAccessDecision(access),
        label,
      ).toBe(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE);
      expect(
        normalizeNutritionProductAccessAuthorityDecision({ status: 'resolved', access }),
        label,
      ).toBe(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE);
      // ...and end to end, through the boundary.
      await expect(invokeNutritionProductAccessAuthority(authorityReturning({ status: 'resolved', access }), REQ)).resolves.toBe(
        NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
      );
    }
  });

  it('still accepts only the two frozen AI-5A instances', () => {
    expect(resolvedNutritionProductAccessDecision(BASIC_NUTRITION_PRODUCT_ACCESS)).toEqual({
      status: 'resolved',
      access: BASIC_NUTRITION_PRODUCT_ACCESS,
    });
    expect(resolvedNutritionProductAccessDecision(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS)).toEqual({
      status: 'resolved',
      access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
    });
  });
});

// ===========================================================================
// E. NO TIMEOUT, NO RETRY, EXACTLY ONCE
// ===========================================================================

describe('AI-5F — hardening added no timeout, no retry and no second attempt', () => {
  it('the boundary contains NO deadline, abort, watchdog or retry machinery', () => {
    for (const forbidden of [
      'Promise.race',
      'AbortController',
      'AbortSignal',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'queueMicrotask',
      'while (',
      'for (;;)',
      'retry',
      'retries',
      'attempt',
      'fallback',
      'deadline',
      'timeout',
      'watchdog',
      'circuit',
    ]) {
      expect(AUTHORITY_CODE.toLowerCase(), `authority must not contain ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    // Exactly ONE containment for the whole synchronous path, and no loop of any kind.
    expect([...AUTHORITY_CODE.matchAll(/\}\s*catch\s*\{/g)]).toHaveLength(3);
    expect(AUTHORITY_CODE).not.toMatch(/\bfor\b|\bwhile\b|\bdo\b/);
  });

  it('a failing authority is attempted EXACTLY ONCE — no second read, no second call', async () => {
    let reads = 0;
    let calls = 0;
    const authority = {
      get resolve(): unknown {
        reads += 1;
        throw new Error('resolve getter exploded');
      },
    };
    await expect(invokeNutritionProductAccessAuthority(authority, REQ)).resolves.toBe(
      NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
    );
    expect(reads).toBe(1);

    const throwing = {
      resolve: () => {
        calls += 1;
        throw new Error('authority exploded');
      },
    };
    await expect(invokeNutritionProductAccessAuthority(throwing, REQ)).resolves.toBe(
      NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
    );
    expect(calls).toBe(1);
  });

  it('a never-settling authority is UNCHANGED: no timeout, request simply stays pending', async () => {
    // The honest, unchanged boundary: AI-5F closes EXCEPTIONS only. A promise that
    // never settles still leaves the request pending, and AI-5F invents no duration.
    const neverSettles = { resolve: () => new Promise<NutritionProductAccessAuthorityDecision>(() => {}) };
    const marker = Symbol('ai5f-still-pending');
    const outcome = await Promise.race([
      invokeNutritionProductAccessAuthority(neverSettles, REQ).then(() => 'settled'),
      new Promise<string>((resolve) => {
        setImmediate(() => resolve(marker as unknown as string));
      }),
    ]);
    expect(outcome).toBe(marker);
  }, 5000);
});

// ===========================================================================
// F. NO ENTITLEMENT EXPANSION
// ===========================================================================

describe('AI-5F — the hardening introduced no new product or commercial concept', () => {
  it('still imports ONLY the express request type and the AI-5A contract', () => {
    const sources = [...AUTHORITY_CODE.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(sources).toEqual(['express', '../src/core/nutritionV2/nutritionProductAccess.js']);
  });

  it('still reads NO environment state and NO request field', () => {
    expect(AUTHORITY_CODE).not.toContain('process.env');
    for (const forbidden of [
      'request.headers',
      'request.cookies',
      'request.query',
      'request.body',
      'request.params',
      'request.ip',
      'request.user',
      '.headers',
      '.cookies',
      '.query',
      '.ip',
    ]) {
      expect(AUTHORITY_CODE, `authority must not read ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('still knows nothing about providers, credentials, BYOK, pricing, plans, accounts or billing', () => {
    for (const forbidden of [
      'providerRegistry',
      'credentialResolver',
      'sessionKey',
      'providerCatalog',
      'textPricingGuard',
      'rateLimiter',
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
      'principal',
      'jwt',
      'oauth',
      'license',
      'userId',
      'plan',
      'principal',
      'usda',
      'fdc',
      'entitlement service',
    ]) {
      expect(AUTHORITY_CODE.toLowerCase(), `authority must not mention ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });

  it('still performs NO persistence and touches NO AI-4 / nutrition internals', () => {
    for (const forbidden of [
      'node:fs',
      'writeFile',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'cookie',
      'SettingsAdapter',
      'projectAcceptedRecipeContext',
      'recipeContext',
      'nutritionCapabilities',
    ]) {
      expect(AUTHORITY_CODE.toLowerCase(), `authority must not mention ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });

  it('still defines no tier, feature or access vocabulary of its own', () => {
    expect(AUTHORITY_CODE).not.toMatch(/interface\s+NutritionProductAccess\b/);
    expect(AUTHORITY_CODE).not.toMatch(/type\s+NutritionProductTier\s*=/);
    expect(AUTHORITY_CODE).not.toMatch(/type\s+NutritionProductAiFeature\s*=/);
    expect(AUTHORITY_CODE).not.toContain('ai_recipe_context_application');
    expect(AUTHORITY_CODE).toContain('resolveNutritionProductAccess');
    expect(AUTHORITY_CODE).toContain('isNutritionProductAccess');
    // No manual tier comparison, no trimming, no case folding: the AI-5A resolver and
    // canonical-identity check remain the ONLY authorities on product access.
    expect(AUTHORITY_CODE).not.toMatch(/=== ['"]ai_advanced['"]/);
    expect(AUTHORITY_CODE).not.toMatch(/\.trim\(\)/);
    expect(AUTHORITY_CODE).not.toMatch(/toLowerCase\(\)/);
    expect(AUTHORITY_CODE).not.toMatch(/\.tier\b/);
  });

  it('still emits exactly ONE failure class, from ONE frozen singleton', () => {
    expect(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE).toEqual({ status: 'unavailable' });
    expect(Object.isFrozen(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE)).toBe(true);
    expect(Object.keys(NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE)).toEqual(['status']);
    // Every hostile outcome above is that SAME object, never a copy.
    expect(normalizeNutritionProductAccessAuthorityDecision(decisionWithThrowingStatusGetter())).toBe(
      NUTRITION_PRODUCT_ACCESS_AUTHORITY_UNAVAILABLE,
    );
  });

  it('leaves the DEPLOYMENT authority behaviourally unchanged', async () => {
    expect(NUTRITION_PRODUCT_TIER_ENV).toBe('KITCHEN_CODEX_NUTRITION_PRODUCT_TIER');
    const advanced = createDeploymentNutritionProductAccessAuthority('ai_advanced');
    const first = await advanced.resolve(REQ);
    const second = await advanced.resolve(REQ);
    // One shared immutable decision: the gates and the status route cannot disagree.
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(advanced)).toBe(true);
    expect(Object.keys(advanced)).toEqual(['resolve']);
    // ...and the safe default is still canonical Basic.
    expect((await createBasicNutritionProductAccessAuthority().resolve(REQ))).toEqual({
      status: 'resolved',
      access: BASIC_NUTRITION_PRODUCT_ACCESS,
    });
  });
});

afterEach(() => {
  delete process.env[NUTRITION_PRODUCT_TIER_ENV];
});