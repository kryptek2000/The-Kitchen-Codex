/**
 * Advanced Nutrition AI-5C — UNIT: the CLIENT reader, strict parser, and effective
 * capability composition.
 *
 * These tests cover the client half of AI-5C. The two things worth protecting are:
 *
 *   1. The transport response is UNTRUSTED. Only an exact
 *      `{ ok: true, version, tier }` body is accepted, and the canonical access
 *      value is always re-derived through the unchanged AI-5A resolver, so a client
 *      can never structurally mint an impossible product state.
 *
 *   2. Availability is an AND. `PRODUCT ENTITLED AND OPERATIONALLY READY`, per
 *      feature, never OR — and `unknown` is its own state, distinct from Basic, so
 *      the UI cannot claim a product fact the server never stated.
 */

import { describe, it, expect } from 'vitest';

import {
  NUTRITION_PRODUCT_ACCESS_ENDPOINT,
  NUTRITION_PRODUCT_ACCESS_UNAVAILABLE,
  isResolvedNutritionProductAccess,
  parseNutritionProductAccessStatus,
  readNutritionProductAccess,
} from '../../src/application/nutritionProductAccess';
import {
  composeNutritionAiClientState,
  isNutritionAiAvailable,
  nutritionAiUnavailableMessage,
  resolveNutritionAiClientState,
  unresolvedNutritionAiClientState,
} from '../../src/application/nutritionAiClientState';
import {
  BASIC_NUTRITION_CAPABILITIES,
  resolveNutritionCapabilities,
  type NutritionCapabilities,
} from '../../src/core/nutritionV2/nutritionCapabilities';
import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_ACCESS,
  NUTRITION_PRODUCT_ACCESS_VERSION,
  type NutritionProductAccess,
} from '../../src/core/nutritionV2/nutritionProductAccess';
import type { NetworkAdapter, NetworkResponse } from '../../src/application/adapters/NetworkAdapter';

const V = NUTRITION_PRODUCT_ACCESS_VERSION;

/** A fully operational readiness set (configured AND reachable provider). */
const READY: NutritionCapabilities = resolveNutritionCapabilities({
  aiConfigured: true,
  aiReachable: true,
});

/** Readiness with a configured-but-unreachable provider. */
const UNREADY: NutritionCapabilities = resolveNutritionCapabilities({
  aiConfigured: true,
  aiReachable: false,
});

function resolvedBasic(): { readonly status: 'resolved'; readonly access: NutritionProductAccess } {
  return { status: 'resolved', access: BASIC_NUTRITION_PRODUCT_ACCESS };
}

function resolvedAdvanced(): {
  readonly status: 'resolved';
  readonly access: NutritionProductAccess;
} {
  return { status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS };
}

/**
 * The ONE generic adapter factory. It satisfies the `NetworkAdapter` port exactly
 * (including its generic response parameter) and records every requested path so
 * tests can assert that no request was made, or that one was skipped.
 */
function makeAdapter(
  handler: (path: string) => NetworkResponse<unknown> | Promise<NetworkResponse<unknown>>,
): { network: NetworkAdapter; getCalls: string[] } {
  const getCalls: string[] = [];
  const network: NetworkAdapter = {
    request: async <TResponse = unknown,>(): Promise<NetworkResponse<TResponse>> => {
      const result = await handler('');
      return result as NetworkResponse<TResponse>;
    },
    get: async <TResponse = unknown,>(path: string): Promise<NetworkResponse<TResponse>> => {
      getCalls.push(path);
      return (await handler(path)) as NetworkResponse<TResponse>;
    },
    post: async <TResponse = unknown,>(): Promise<NetworkResponse<TResponse>> => {
      const result = await handler('');
      return result as NetworkResponse<TResponse>;
    },
  };
  return { network, getCalls };
}

/** Builds a NetworkAdapter returning one canned response. */
function adapterReturning(response: NetworkResponse<unknown>): {
  network: NetworkAdapter;
  getCalls: string[];
} {
  return makeAdapter(() => response);
}

/** Builds a NetworkAdapter whose every call throws. */
function throwingAdapter(): NetworkAdapter {
  return makeAdapter(() => {
    throw new Error('offline');
  }).network;
}

// ===========================================================================
describe('AI-5C — strict status parser', () => {
  it('accepts the exact Basic body', () => {
    expect(parseNutritionProductAccessStatus({ ok: true, version: V, tier: 'basic' })).toBe('basic');
  });

  it('accepts the exact AI Advanced body', () => {
    expect(parseNutritionProductAccessStatus({ ok: true, version: V, tier: 'ai_advanced' })).toBe(
      'ai_advanced',
    );
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'basic'],
    ['a number', 1],
    ['a boolean', true],
    ['an array', [{ ok: true, version: V, tier: 'basic' }]],
    ['an empty array', []],
  ])('rejects %s', (_label, payload) => {
    expect(parseNutritionProductAccessStatus(payload)).toBeUndefined();
  });

  it('rejects ok:false', () => {
    expect(
      parseNutritionProductAccessStatus({ ok: false, version: V, tier: 'basic' }),
    ).toBeUndefined();
  });

  it('rejects a missing ok', () => {
    expect(parseNutritionProductAccessStatus({ version: V, tier: 'basic' })).toBeUndefined();
  });

  it('rejects a missing version', () => {
    expect(parseNutritionProductAccessStatus({ ok: true, tier: 'basic' })).toBeUndefined();
  });

  it('rejects a missing tier', () => {
    expect(parseNutritionProductAccessStatus({ ok: true, version: V })).toBeUndefined();
  });

  it('rejects an unsupported/future contract version instead of coercing it', () => {
    expect(
      parseNutritionProductAccessStatus({
        ok: true,
        version: 'nutrition_product_access_v2',
        tier: 'ai_advanced',
      }),
    ).toBeUndefined();
  });

  it('rejects a wrong-case version', () => {
    expect(
      parseNutritionProductAccessStatus({
        ok: true,
        version: 'NUTRITION_PRODUCT_ACCESS_V1',
        tier: 'basic',
      }),
    ).toBeUndefined();
  });

  // The important one: a bad tier must be REJECTED, not silently coerced to Basic.
  it.each([
    ['wrong case', 'AI_ADVANCED'],
    ['mixed case', 'Ai_Advanced'],
    ['leading whitespace', ' ai_advanced'],
    ['trailing whitespace', 'ai_advanced '],
    ['whitespace only', '   '],
    ['empty', ''],
    ['alias pro', 'pro'],
    ['alias premium', 'premium'],
    ['alias paid', 'paid'],
    ['alias free', 'free'],
    ['alias subscription', 'subscription'],
    ['boolean alias', 'true'],
    ['numeric alias', '1'],
    ['unknown word', 'premium_tier'],
    ['null', null],
    ['undefined', undefined],
    ['number', 1],
    ['boolean', true],
    ['array', ['ai_advanced']],
    ['object', { tier: 'ai_advanced' }],
  ])('REJECTS a %s tier rather than reporting it as Basic', (_label, tier) => {
    // If this returned 'basic', the UI would claim a server-stated Basic tier the
    // server never stated.
    expect(parseNutritionProductAccessStatus({ ok: true, version: V, tier })).toBeUndefined();
  });

  it.each([
    ['an extra field', { ok: true, version: V, tier: 'basic', source: 'env' }],
    ['a feature payload', { ok: true, version: V, tier: 'basic', features: ['ai_interpretation'] }],
    [
      'a feature boolean map',
      { ok: true, version: V, tier: 'basic', aiInterpretation: true },
    ],
    ['a feature array', { ok: true, version: V, tier: 'basic', features: [] }],
    ['provider-shaped data', { ok: true, version: V, tier: 'basic', provider: 'openrouter' }],
    ['billing-shaped data', { ok: true, version: V, tier: 'basic', billing: { plan: 'pro' } }],
    ['credential data', { ok: true, version: V, tier: 'basic', apiKey: 'sk-x' }],
    ['account data', { ok: true, version: V, tier: 'basic', account: 'me' }],
  ])('rejects %s', (_label, payload) => {
    expect(parseNutritionProductAccessStatus(payload)).toBeUndefined();
  });

  it('rejects a hand-authored NutritionProductAccess instead of structurally accepting it', () => {
    // The impossible product state: Basic tier with an enabled feature.
    expect(
      parseNutritionProductAccessStatus({
        ok: true,
        version: V,
        tier: 'basic',
        access: {
          version: V,
          tier: 'basic',
          aiInterpretation: true,
          aiCandidateOrchestration: true,
          aiBoundedMassEstimation: true,
          aiRecipeContextReview: true,
        },
      }),
    ).toBeUndefined();
  });

  it('rejects a nested access object under an accepted key set', () => {
    expect(
      parseNutritionProductAccessStatus({
        ok: true,
        version: V,
        tier: { version: V, tier: 'ai_advanced' },
      }),
    ).toBeUndefined();
  });
});

// ===========================================================================
describe('AI-5C — client reader', () => {
  it('uses the documented read-only endpoint', () => {
    expect(NUTRITION_PRODUCT_ACCESS_ENDPOINT).toBe('/api/nutrition/product-access');
  });

  it('resolves to the canonical AI-5A Basic instance', async () => {
    const { network } = adapterReturning({
      status: 200,
      ok: true,
      data: { ok: true, version: V, tier: 'basic' },
    });
    const read = await readNutritionProductAccess(network);
    expect(isResolvedNutritionProductAccess(read)).toBe(true);
    if (!isResolvedNutritionProductAccess(read)) throw new Error('expected resolved');
    // Canonical identity, not a structurally-similar clone.
    expect(read.access).toBe(BASIC_NUTRITION_PRODUCT_ACCESS);
  });

  it('resolves to the canonical AI-5A AI Advanced instance', async () => {
    const { network } = adapterReturning({
      status: 200,
      ok: true,
      data: { ok: true, version: V, tier: 'ai_advanced' },
    });
    const read = await readNutritionProductAccess(network);
    if (!isResolvedNutritionProductAccess(read)) throw new Error('expected resolved');
    expect(read.access).toBe(AI_ADVANCED_NUTRITION_PRODUCT_ACCESS);
  });

  it.each([
    ['a non-2xx', { status: 401, ok: false, data: undefined }],
    ['an auth failure body', { status: 401, ok: false, data: { error: 'unauthorized' } }],
    ['a 403', { status: 403, ok: false, data: { code: 'NUTRITION_AI_NOT_ENTITLED' } }],
    ['a missing body', { status: 200, ok: true, data: undefined }],
    ['a malformed body', { status: 200, ok: true, data: { ok: true } }],
    ['a wrong version', { status: 200, ok: true, data: { ok: true, version: 'v2', tier: 'basic' } }],
    ['an aliased tier', { status: 200, ok: true, data: { ok: true, version: V, tier: 'pro' } }],
    ['provider-shaped data', { status: 200, ok: true, data: { providers: [] } }],
  ])('fails safe to unavailable on %s', async (_label, response) => {
    const { network } = adapterReturning(response as NetworkResponse<unknown>);
    expect(await readNutritionProductAccess(network)).toEqual(
      NUTRITION_PRODUCT_ACCESS_UNAVAILABLE,
    );
  });

  it('fails safe to unavailable on a transport error', async () => {
    expect(await readNutritionProductAccess(throwingAdapter())).toEqual(
      NUTRITION_PRODUCT_ACCESS_UNAVAILABLE,
    );
  });

  it('does NOT send any entitlement header or parameter back to the server', async () => {
    const { network, getCalls } = adapterReturning({
      status: 200,
      ok: true,
      data: { ok: true, version: V, tier: 'ai_advanced' },
    });
    await readNutritionProductAccess(network);
    expect(getCalls).toEqual(['/api/nutrition/product-access']);
    // The convenience GET takes only a path: there is no place to smuggle a tier,
    // and the adapter was never handed headers at all.
  });
});

// ===========================================================================
describe('AI-5C — effective capability composition', () => {
  it('A. Basic + provider READY -> effective AI OFF', () => {
    const state = composeNutritionAiClientState({
      productAccess: resolvedBasic(),
      operational: READY,
    });
    // The load-bearing truth: a configured, reachable provider does not grant AI.
    expect(state.available).toBe(false);
    expect(state.availability).toBe('product_not_enabled');
    expect(state.effectiveCapabilities.aiInterpretation).toBe(false);
    expect(state.effectiveCapabilities.aiCandidateOrchestration).toBe(false);
    expect(state.effectiveCapabilities.aiBoundedMassEstimation).toBe(false);
    expect(state.effectiveCapabilities.aiRecipeContextReview).toBe(false);
    expect(state.recipeContextReviewAvailable).toBe(false);
  });

  it('B. AI Advanced + provider UNAVAILABLE -> effective AI OFF', () => {
    const state = composeNutritionAiClientState({
      productAccess: resolvedAdvanced(),
      operational: UNREADY,
    });
    expect(state.productAccessIsAiAdvanced).toBe(true);
    expect(state.available).toBe(false);
    // Entitled, so the reason is the provider — NOT a product denial.
    expect(state.availability).toBe('provider_unavailable');
  });

  it('B2. AI Advanced + no operational read at all -> effective AI OFF', () => {
    const state = composeNutritionAiClientState({
      productAccess: resolvedAdvanced(),
      operational: null,
    });
    expect(state.available).toBe(false);
    expect(state.availability).toBe('provider_unavailable');
    expect(state.effectiveCapabilities.aiInterpretation).toBe(false);
  });

  it('C. AI Advanced + provider READY -> effective AI ON', () => {
    const state = composeNutritionAiClientState({
      productAccess: resolvedAdvanced(),
      operational: READY,
    });
    expect(state.available).toBe(true);
    expect(state.availability).toBe('available');
    expect(state.effectiveCapabilities).toEqual({
      aiInterpretation: true,
      aiCandidateOrchestration: true,
      aiBoundedMassEstimation: true,
      aiRecipeContextReview: true,
    });
    expect(state.recipeContextReviewAvailable).toBe(true);
    expect(nutritionAiUnavailableMessage(state.availability)).toBeNull();
  });

  it('D. product status UNAVAILABLE -> effective AI OFF, and UNKNOWN not Basic', () => {
    const state = composeNutritionAiClientState({
      productAccess: NUTRITION_PRODUCT_ACCESS_UNAVAILABLE,
      operational: READY,
    });
    expect(state.available).toBe(false);
    expect(state.availability).toBe('product_access_unverified');
    // Critically: NOT reported as Basic, even with a perfectly ready provider.
    expect(state.productAccessIsBasic).toBe(false);
    expect(state.productAccessIsAiAdvanced).toBe(false);
    expect(state.productAccess).toBeNull();
    expect(state.effectiveCapabilities.aiInterpretation).toBe(false);
  });

  it('E. the pre-read state is unknown, never Basic', () => {
    const state = unresolvedNutritionAiClientState();
    expect(state.availability).toBe('product_access_unverified');
    expect(state.productAccessIsBasic).toBe(false);
    expect(state.available).toBe(false);
  });

  it('never turns availability on through OR logic', () => {
    // Every combination: only advanced+ready is ever on.
    const accesses = [resolvedBasic(), resolvedAdvanced(), NUTRITION_PRODUCT_ACCESS_UNAVAILABLE];
    const operationals: ReadonlyArray<NutritionCapabilities | null> = [
      READY,
      UNREADY,
      BASIC_NUTRITION_CAPABILITIES,
      null,
    ];
    for (const access of accesses) {
      for (const operational of operationals) {
        const state = composeNutritionAiClientState({ productAccess: access, operational });
        const entitled = isResolvedNutritionProductAccess(access) && access.access.aiInterpretation;
        const ready = operational !== null && operational.aiInterpretation === true;
        expect(state.available).toBe(entitled && ready);
        expect(state.effectiveCapabilities.aiInterpretation).toBe(entitled && ready);
      }
    }
  });
});

// ===========================================================================
describe('AI-5C — feature-by-feature AND mapping', () => {
  it.each([
    ['aiInterpretation'],
    ['aiCandidateOrchestration'],
    ['aiBoundedMassEstimation'],
    ['aiRecipeContextReview'],
  ] as const)('%s: Basic product + ready provider is FALSE', (effectiveKey) => {
    const state = composeNutritionAiClientState({
      productAccess: resolvedBasic(),
      operational: READY,
    });
    expect(state.effectiveCapabilities[effectiveKey]).toBe(false);
  });

  it.each([
    ['aiInterpretation'],
    ['aiCandidateOrchestration'],
    ['aiBoundedMassEstimation'],
    ['aiRecipeContextReview'],
  ] as const)('%s: AI Advanced product + unavailable provider is FALSE', (effectiveKey) => {
    const state = composeNutritionAiClientState({
      productAccess: resolvedAdvanced(),
      operational: UNREADY,
    });
    expect(state.effectiveCapabilities[effectiveKey]).toBe(false);
  });

  it.each([
    ['aiInterpretation'],
    ['aiCandidateOrchestration'],
    ['aiBoundedMassEstimation'],
    ['aiRecipeContextReview'],
  ] as const)('%s: AI Advanced product + ready provider is TRUE', (effectiveKey) => {
    const state = composeNutritionAiClientState({
      productAccess: resolvedAdvanced(),
      operational: READY,
    });
    expect(state.effectiveCapabilities[effectiveKey]).toBe(true);
  });

  it('bounded mass estimation uses the AI-3 availability signal, not interpretation', () => {
    // A readiness set with interpretation available but estimation disabled must
    // not report mass estimation as effective.
    const interpretationOnly: NutritionCapabilities = Object.freeze({
      tier: 'ai_advanced',
      deterministicReview: true,
      manualEditing: true,
      aiInterpretation: true,
      aiCandidateOrchestration: true,
      aiEstimation: 'disabled',
    });
    const state = composeNutritionAiClientState({
      productAccess: resolvedAdvanced(),
      operational: interpretationOnly,
    });
    expect(state.effectiveCapabilities.aiInterpretation).toBe(true);
    expect(state.effectiveCapabilities.aiBoundedMassEstimation).toBe(false);
  });

  it('recipe-context review requires compatible TEXT-AI readiness', () => {
    const textless: NutritionCapabilities = Object.freeze({
      tier: 'ai_advanced',
      deterministicReview: true,
      manualEditing: true,
      aiInterpretation: false,
      aiCandidateOrchestration: false,
      aiEstimation: 'available',
    });
    const state = composeNutritionAiClientState({
      productAccess: resolvedAdvanced(),
      operational: textless,
    });
    expect(state.effectiveCapabilities.aiRecipeContextReview).toBe(false);
    expect(state.effectiveCapabilities.aiBoundedMassEstimation).toBe(true);
  });
});

// ===========================================================================
describe('AI-5C — lazy resolution and the provider short-circuit', () => {
  it('issues exactly ONE request when the server definitively says Basic', async () => {
    const { network, getCalls } = adapterReturning({
      status: 200,
      ok: true,
      data: { ok: true, version: V, tier: 'basic' },
    });
    const state = await resolveNutritionAiClientState(network);
    expect(state.available).toBe(false);
    expect(state.availability).toBe('product_not_enabled');
    // The provider-status surface must NOT be consulted once Basic is definitive:
    // no provider configuration can change the answer.
    expect(getCalls).toEqual(['/api/nutrition/product-access']);
  });

  it('issues exactly ONE request when product access cannot be verified', async () => {
    const { network, getCalls } = adapterReturning({
      status: 500,
      ok: false,
      data: undefined,
    });
    const state = await resolveNutritionAiClientState(network);
    expect(state.availability).toBe('product_access_unverified');
    // The client will not turn "I could not check" into provider readiness by
    // asking a second question it also cannot answer.
    expect(getCalls).toEqual(['/api/nutrition/product-access']);
  });

  it('consults operational readiness ONLY after AI Advanced is confirmed', async () => {
    const { network, getCalls: paths } = makeAdapter((path) => {
      if (path === '/api/nutrition/product-access') {
        return { status: 200, ok: true, data: { ok: true, version: V, tier: 'ai_advanced' } };
      }
      return {
        status: 200,
        ok: true,
        data: {
          providers: [
            { enabled: true, configured: true, available: true, capabilities: { structuredOutput: true } },
          ],
        },
      };
    });
    const state = await resolveNutritionAiClientState(network);
    expect(state.available).toBe(true);
    expect(paths).toEqual([
      '/api/nutrition/product-access',
      '/api/providers',
    ]);
  });

  it('reports provider_unavailable when AI Advanced is confirmed but no provider is', async () => {
    const { network, getCalls: paths } = makeAdapter((path) => {
      if (path === '/api/nutrition/product-access') {
        return { status: 200, ok: true, data: { ok: true, version: V, tier: 'ai_advanced' } };
      }
      return { status: 200, ok: true, data: { providers: [] } };
    });
    const state = await resolveNutritionAiClientState(network);
    expect(state.productAccessIsAiAdvanced).toBe(true);
    expect(state.availability).toBe('provider_unavailable');
    expect(paths).toHaveLength(2);
  });

  it('never requests the product status implicitly — only when called', () => {
    // The composition is a pure function; nothing happens until it is invoked.
    const before = unresolvedNutritionAiClientState();
    expect(before.available).toBe(false);
  });
});

// ===========================================================================
describe('AI-5C — bounded truthful messaging', () => {
  it('states a Basic product fact only for a server-reported Basic', () => {
    const message = nutritionAiUnavailableMessage('product_not_enabled');
    expect(message).toContain("isn't enabled for this deployment");
    expect(message).toContain('Basic manual review and correction are still available');
  });

  it('says the feature IS enabled when only the provider is missing', () => {
    const message = nutritionAiUnavailableMessage('provider_unavailable');
    expect(message).toContain('is enabled');
    expect(message).toContain('no compatible AI provider is currently available');
    // Must NOT imply the user lacks entitlement.
    expect(message?.toLowerCase()).not.toContain("isn't enabled for this deployment");
    expect(message?.toLowerCase()).not.toContain('not enabled');
  });

  it('says access could not be verified when the status is unknown', () => {
    const message = nutritionAiUnavailableMessage('product_access_unverified');
    expect(message).toContain("couldn't be verified");
    expect(message).toContain('Basic manual review and correction are still available');
    // Must NOT claim Basic, and must NOT blame billing or the provider.
    expect(message?.toLowerCase()).not.toContain('isn\'t enabled for this deployment');
    expect(message?.toLowerCase()).not.toContain('provider');
    expect(message?.toLowerCase()).not.toContain('billing');
    expect(message?.toLowerCase()).not.toContain('subscription');
  });

  it('offers no reason copy when AI is available', () => {
    expect(nutritionAiUnavailableMessage('available')).toBeNull();
    expect(isNutritionAiAvailable('available')).toBe(true);
  });

  it('contains NO billing, upgrade, paywall or product-sales language anywhere', () => {
    const all = [
      nutritionAiUnavailableMessage('product_not_enabled') ?? '',
      nutritionAiUnavailableMessage('provider_unavailable') ?? '',
      nutritionAiUnavailableMessage('product_access_unverified') ?? '',
    ].join(' ');
    for (const banned of [
      'subscribe',
      'subscription',
      'upgrade',
      'pay',
      'purchase',
      'premium',
      'pro ',
      'trial',
      'checkout',
      'billing',
      'plan',
      'license',
      'unlock',
    ]) {
      expect(all.toLowerCase(), `message must not contain "${banned}"`).not.toContain(banned);
    }
  });
});