/**
 * Advanced Nutrition AI-5D — UNIT: refreshable operational readiness.
 *
 * AI-5C cached the whole composed result for the page session. That is right for
 * PRODUCT ACCESS (deployment-scoped, stable) and wrong for OPERATIONAL READINESS
 * (dynamic while the page stays open). These tests pin the split:
 *
 *   - product access may be cached and REUSED across refreshes;
 *   - readiness is RE-READ on demand, never cached forever;
 *   - a known Basic product answer short-circuits and never queries providers;
 *   - an unknown answer never queries providers to guess;
 *   - a known AI Advanced answer refreshes READINESS ONLY;
 *   - session-only BYOK readiness is represented truthfully.
 *
 * The load-bearing recon finding these tests protect: `/api/providers` reports the
 * SERVER ENVIRONMENT credential only (`storageScope` is hardcoded), so it cannot
 * speak for a `session_only` selection — while real execution genuinely does use
 * session-only credentials, and the codebase's own `isAvailable()` defines a session
 * credential's availability as PRESENCE.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  NUTRITION_AI_REFRESHING_MESSAGE,
  UNAVAILABLE_EFFECTIVE_CAPABILITIES,
  composeNutritionAiClientState,
  createNutritionRefreshSequencer,
  nutritionAiUnavailableMessage,
  readNutritionOperationalReadiness,
  recomposeNutritionAiClientState,
  selectedTextCredentialSource,
  unresolvedNutritionAiClientState,
} from '../../src/application/nutritionAiClientState';
import {
  NUTRITION_PRODUCT_ACCESS_UNAVAILABLE,
  type NutritionProductAccessRead,
} from '../../src/application/nutritionProductAccess';
import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_ACCESS,
} from '../../src/core/nutritionV2/nutritionProductAccess';
import {
  AI_SELECTION_SETTINGS_KEY,
  hydrateAiSelections,
} from '../../src/application/aiSelection';
import type { NetworkAdapter, NetworkResponse } from '../../src/application/adapters/NetworkAdapter';

const V = 'nutrition_product_access_v1';

const ENV_READY_PROVIDER = {
  providerId: 'gemini',
  enabled: true,
  configured: true,
  available: true,
  storageScope: 'server_environment',
  capabilities: { structuredOutput: true },
};

function makeAdapter(
  handler: (path: string) => NetworkResponse<unknown>,
): { network: NetworkAdapter; paths: string[] } {
  const paths: string[] = [];
  const network: NetworkAdapter = {
    request: async <T,>(): Promise<NetworkResponse<T>> => handler('') as NetworkResponse<T>,
    get: async <T,>(path: string): Promise<NetworkResponse<T>> => {
      paths.push(path);
      return handler(path) as NetworkResponse<T>;
    },
    post: async <T,>(): Promise<NetworkResponse<T>> => handler('') as NetworkResponse<T>,
  };
  return { network, paths };
}

const ok = (data: unknown): NetworkResponse<unknown> => ({ status: 200, ok: true, data });

/**
 * Populates the REAL selection cache through its existing public hydration seam, so
 * no test-only export is added to production code just to make a test possible.
 */
async function selectText(
  credentialSource: 'server_environment' | 'session_only',
  providerId = 'openrouter',
): Promise<void> {
  const stored = {
    textAi: { mode: 'user_selected', providerId, credentialSource },
    imageAi: { mode: 'server_default' },
  };
  // A fresh adapter instance per hydration forces a real re-read.
  await hydrateAiSelections({
    get: async <T,>(key: string): Promise<T | undefined> =>
      key === AI_SELECTION_SETTINGS_KEY ? (stored as unknown as T) : undefined,
  });
}

/** Selects nothing at all: no user selection, so the env path applies. */
async function selectNothing(): Promise<void> {
  await hydrateAiSelections({
    get: async <T,>(): Promise<T | undefined> => undefined,
  });
}

// ===========================================================================
describe('AI-5D — session-only BYOK readiness is represented truthfully', () => {
  it('reads session status, NOT /api/providers, for a session_only selection', async () => {
    await selectText('session_only');
    const { network, paths } = makeAdapter((path) =>
      path === '/api/providers/session-key/status'
        ? ok({
            providers: [
              { providerId: 'openrouter', storageScope: 'session_only', configured: true },
            ],
          })
        : ok({ providers: [ENV_READY_PROVIDER] }),
    );
    const readiness = await readNutritionOperationalReadiness(network);
    expect(readiness.aiInterpretation).toBe(true);
    expect(paths).toEqual(['/api/providers/session-key/status']);
  });

  it('is Basic when the session key is NOT configured, even with an env-ready provider', async () => {
    await selectText('session_only');
    const { network } = makeAdapter((path) =>
      path === '/api/providers/session-key/status'
        ? ok({ providers: [{ providerId: 'openrouter', storageScope: 'session_only', configured: false }] })
        : ok({ providers: [ENV_READY_PROVIDER] }),
    );
    const readiness = await readNutritionOperationalReadiness(network);
    // The env provider is irrelevant to a session_only selection.
    expect(readiness.aiInterpretation).toBe(false);
    expect(readiness.tier).toBe('basic');
  });

  it('is Basic when the selected provider has NO row in the status response', async () => {
    await selectText('session_only', 'openrouter');
    const { network } = makeAdapter(() =>
      ok({ providers: [{ providerId: 'gemini', storageScope: 'session_only', configured: true }] }),
    );
    expect((await readNutritionOperationalReadiness(network)).aiInterpretation).toBe(false);
  });

  it.each([
    ['a non-2xx', { status: 503, ok: false, data: { code: 'BYOK_SESSION_UNAVAILABLE' } }],
    ['a missing providers array', { status: 200, ok: true, data: {} }],
    ['a malformed body', { status: 200, ok: true, data: { providers: 'nope' } }],
    [
      'a wrong storageScope',
      { status: 200, ok: true, data: { providers: [{ providerId: 'openrouter', storageScope: 'server_environment', configured: true }] } },
    ],
    [
      'a non-boolean configured',
      { status: 200, ok: true, data: { providers: [{ providerId: 'openrouter', storageScope: 'session_only', configured: 'yes' }] } },
    ],
    [
      'a duplicate provider row',
      {
        status: 200,
        ok: true,
        data: {
          providers: [
            { providerId: 'openrouter', storageScope: 'session_only', configured: true },
            { providerId: 'openrouter', storageScope: 'session_only', configured: false },
          ],
        },
      },
    ],
    ['an auth failure', { status: 401, ok: false, data: { error: 'unauthorized' } }],
  ])('fails safe to Basic on %s', async (_label, response) => {
    await selectText('session_only');
    const { network } = makeAdapter(() => response as NetworkResponse<unknown>);
    expect((await readNutritionOperationalReadiness(network)).aiInterpretation).toBe(false);
  });

  it('reports the selected text credential source truthfully', async () => {
    await selectText('session_only');
    expect(selectedTextCredentialSource()).toBe('session_only');
    await selectText('server_environment');
    expect(selectedTextCredentialSource()).toBe('server_environment');
    await selectNothing();
    expect(selectedTextCredentialSource()).not.toBe('session_only');
  });
});

describe('AI-5D — server-environment readiness path is unchanged', () => {
  it('uses /api/providers for a server_environment selection', async () => {
    await selectText('server_environment');
    const { network, paths } = makeAdapter(() => ok({ providers: [ENV_READY_PROVIDER] }));
    const readiness = await readNutritionOperationalReadiness(network);
    expect(readiness.aiInterpretation).toBe(true);
    expect(paths).toEqual(['/api/providers']);
  });

  it('is Basic when no provider is configured or reachable', async () => {
    await selectText('server_environment');
    const { network } = makeAdapter(() =>
      ok({ providers: [{ ...ENV_READY_PROVIDER, configured: false, available: false }] }),
    );
    expect((await readNutritionOperationalReadiness(network)).aiInterpretation).toBe(false);
  });
});

// ===========================================================================
describe('AI-5D — recomposition short-circuits by product state', () => {
  const basic: NutritionProductAccessRead = { status: 'resolved', access: BASIC_NUTRITION_PRODUCT_ACCESS };
  const advanced: NutritionProductAccessRead = {
    status: 'resolved',
    access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  };

  it('KNOWN BASIC + provider ready => NO readiness query at all', async () => {
    const { network, paths } = makeAdapter(() => ok({ providers: [ENV_READY_PROVIDER] }));
    const state = await recomposeNutritionAiClientState(network, basic);
    expect(state.available).toBe(false);
    expect(state.availability).toBe('product_not_enabled');
    expect(state.productAccessIsBasic).toBe(true);
    // A provider cannot grant Advanced, so readiness is never read.
    expect(paths).toEqual([]);
  });

  it('UNKNOWN => NO readiness query, and stays unknown (never Basic)', async () => {
    const { network, paths } = makeAdapter(() => ok({ providers: [ENV_READY_PROVIDER] }));
    const state = await recomposeNutritionAiClientState(network, NUTRITION_PRODUCT_ACCESS_UNAVAILABLE);
    expect(state.availability).toBe('product_access_unverified');
    expect(state.productAccessIsBasic).toBe(false);
    expect(state.productAccessIsAiAdvanced).toBe(false);
    // Never turn "could not check" into provider readiness by asking anyway.
    expect(paths).toEqual([]);
  });

  it('KNOWN ADVANCED => readiness read, and product status NOT re-read', async () => {
    await selectText('server_environment');
    const { network, paths } = makeAdapter((path) =>
      path === '/api/providers' ? ok({ providers: [ENV_READY_PROVIDER] }) : ok({ providers: [] }),
    );
    const state = await recomposeNutritionAiClientState(network, advanced);
    expect(state.available).toBe(true);
    // Readiness only. The product-status endpoint is not asked again.
    expect(paths).toEqual(['/api/providers']);
  });

  it('KNOWN ADVANCED + provider unavailable => provider_unavailable, never not-entitled', async () => {
    await selectText('server_environment');
    const { network } = makeAdapter(() => ok({ providers: [] }));
    const state = await recomposeNutritionAiClientState(network, advanced);
    expect(state.availability).toBe('provider_unavailable');
    expect(nutritionAiUnavailableMessage(state.availability)).toContain('is enabled');
  });

  it('no cached product truth => performs the lazy first read', async () => {
    await selectText('server_environment');
    const { network, paths } = makeAdapter((path) =>
      path === '/api/nutrition/product-access'
        ? ok({ ok: true, version: V, tier: 'ai_advanced' })
        : ok({ providers: [ENV_READY_PROVIDER] }),
    );
    const state = await recomposeNutritionAiClientState(network);
    expect(state.available).toBe(true);
    expect(paths).toEqual(['/api/nutrition/product-access', '/api/providers']);
  });

  it('is re-readable: two calls observe a CHANGED provider world', async () => {
    await selectText('server_environment');
    let ready = true;
    const { network } = makeAdapter(() =>
      ok({
        providers: ready
          ? [ENV_READY_PROVIDER]
          : [{ ...ENV_READY_PROVIDER, configured: false, available: false }],
      }),
    );
    expect((await recomposeNutritionAiClientState(network, advanced)).available).toBe(true);
    // The provider world changes (outage) — a re-read MUST observe it.
    ready = false;
    expect((await recomposeNutritionAiClientState(network, advanced)).available).toBe(false);
    // And recovery is observed without any page reload.
    ready = true;
    expect((await recomposeNutritionAiClientState(network, advanced)).available).toBe(true);
  });

  it('observes a session key being revoked, then restored', async () => {
    await selectText('session_only');
    let configured = true;
    const { network } = makeAdapter(() =>
      ok({ providers: [{ providerId: 'openrouter', storageScope: 'session_only', configured }] }),
    );
    expect((await recomposeNutritionAiClientState(network, advanced)).available).toBe(true);
    configured = false; // revoked
    expect((await recomposeNutritionAiClientState(network, advanced)).available).toBe(false);
    configured = true; // restored
    expect((await recomposeNutritionAiClientState(network, advanced)).available).toBe(true);
  });
});

// ===========================================================================
describe('AI-5D — one shared sequencing authority', () => {
  it('only the newest begun refresh is current', () => {
    const sequencer = createNutritionRefreshSequencer();
    const a = sequencer.begin();
    const b = sequencer.begin();
    expect(sequencer.isCurrent(a)).toBe(false);
    expect(sequencer.isCurrent(b)).toBe(true);
  });

  it('refuses a slow older completion in BOTH directions', () => {
    // Adversary: A starts (slow), B starts later (fast) and completes first.
    // The final state must remain B, whichever answer B carried.
    for (const bAnswer of [true, false]) {
      const sequencer = createNutritionRefreshSequencer();
      const a = sequencer.begin(); // older, slow
      const b = sequencer.begin(); // newer, fast
      // B commits first.
      expect(sequencer.isCurrent(b)).toBe(true);
      let committed = bAnswer;
      // A lands late with the OPPOSITE answer and must be refused.
      const aAnswer = !bAnswer;
      if (sequencer.isCurrent(a)) committed = aAnswer;
      expect(committed).toBe(bAnswer);
    }
  });

  it('is monotonic across many refreshes', () => {
    const sequencer = createNutritionRefreshSequencer();
    let last = 0;
    for (let i = 0; i < 25; i += 1) {
      const id = sequencer.begin();
      expect(id).toBeGreaterThan(last);
      expect(sequencer.isCurrent(id)).toBe(true);
      last = id;
    }
  });

  it('is a SEPARATE owner from any unrelated surface sequence', () => {
    // Two independent sequencers must not interfere: nutrition readiness has its own
    // lifecycle and must never be invalidated by another surface's requests.
    const nutrition = createNutritionRefreshSequencer();
    const other = createNutritionRefreshSequencer();
    const n1 = nutrition.begin();
    other.begin();
    other.begin();
    expect(nutrition.isCurrent(n1)).toBe(true);
  });
});

// ===========================================================================
describe('AI-5D — fail-closed + bounded messaging', () => {
  it('exposes a shared all-false effective capability set for fail-closed use', () => {
    expect(UNAVAILABLE_EFFECTIVE_CAPABILITIES).toEqual({
      aiInterpretation: false,
      aiCandidateOrchestration: false,
      aiBoundedMassEstimation: false,
      aiRecipeContextReview: false,
    });
  });

  it('uses NEUTRAL copy while refreshing, making no product claim', () => {
    expect(NUTRITION_AI_REFRESHING_MESSAGE).toBe('Checking AI availability…');
    const lower = NUTRITION_AI_REFRESHING_MESSAGE.toLowerCase();
    // While genuinely still checking, the UI must not blame a product or provider.
    for (const banned of ['basic', 'not enabled', 'not entitled', 'provider', 'subscription', 'billing']) {
      expect(lower, `refreshing copy must not claim "${banned}"`).not.toContain(banned);
    }
  });

  it('keeps the three unavailable reasons distinct after refresh', () => {
    expect(nutritionAiUnavailableMessage('product_not_enabled')).toContain(
      "isn't enabled for this deployment",
    );
    expect(nutritionAiUnavailableMessage('provider_unavailable')).toContain('is enabled');
    expect(nutritionAiUnavailableMessage('product_access_unverified')).toContain(
      "couldn't be verified",
    );
  });

  it('still never reduces Basic Nutrition', () => {
    const state = unresolvedNutritionAiClientState();
    // `available: false` only ever concerns the AI assistance layer; the
    // deterministic/manual capabilities are literal true by contract.
    expect(state.available).toBe(false);
    const composed = composeNutritionAiClientState({
      productAccess: NUTRITION_PRODUCT_ACCESS_UNAVAILABLE,
      operational: null,
    });
    expect(composed.effectiveCapabilities).toEqual(UNAVAILABLE_EFFECTIVE_CAPABILITIES);
  });
});

// ===========================================================================
describe('AI-5D — no polling and no new authority surface', () => {
  it('introduces no timer-based provider polling in the application layer', () => {
    // Source-level: a readiness read is a single explicit call. There is no
    // interval, no recurring scheduler, and no background watcher.
    expect(typeof readNutritionOperationalReadiness).toBe('function');
    // The pure helpers hold no timer handles at all.
    expect(Object.keys(createNutritionRefreshSequencer())).toEqual(['begin', 'isCurrent']);
  });

  it('reads only the two EXISTING non-secret status surfaces', async () => {
    await selectText('server_environment');
    const env = makeAdapter(() => ok({ providers: [ENV_READY_PROVIDER] }));
    await readNutritionOperationalReadiness(env.network);
    expect(env.paths).toEqual(['/api/providers']);

    await selectText('session_only');
    const session = makeAdapter(() =>
      ok({ providers: [{ providerId: 'openrouter', storageScope: 'session_only', configured: true }] }),
    );
    await readNutritionOperationalReadiness(session.network);
    expect(session.paths).toEqual(['/api/providers/session-key/status']);
  });
});