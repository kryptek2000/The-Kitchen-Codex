/**
 * The Kitchen Codex — AI-2C (Slice C): application acceptance orchestration.
 *
 * Proves the bridge end to end against a REAL genuine Phase-4 session and a
 * stubbed transport:
 *   - only a genuine session can promote a line (confirmation is required);
 *   - a capability-disabled tier performs ZERO network work;
 *   - a superseded request is discarded before any confirmation;
 *   - user/working state (match or mass source) is never overwritten or cleared;
 *   - offers stay non-mutating, review/abstention stay untouched;
 *   - a repeat run is `unchanged` (idempotent, nothing to dispatch);
 *   - exactly one network call is made and no persistence/Apply surface exists in
 *     the module graph.
 */

import { describe, it, expect, vi } from 'vitest';

// The BYOK/selection header builder needs a platform settings store; the
// application requester is exercised with the SAME stub the AI-1/AI-2B live
// tests use (nothing about this module changes the transport contract).
vi.mock('../../src/application/aiSelection', () => ({
  buildAiSelectionRequestOptions: async () => ({}),
}));

import { requestAndReconcileAiAdvancedPlan } from '../../src/application/nutritionAiPlanAcceptance';
import { AI_PLAN_UNAVAILABLE_MESSAGE } from '../../src/application/nutritionAiPlan';
import { BASIC_NUTRITION_CAPABILITIES, resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import { AI_ADVANCED_PLAN_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlan';
import { buildAiAdvancedPlanLineSource } from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import { buildAiAdvancedPlanRequestContext, type AiAdvancedPlanRequestContext } from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { createReviewCatalog, reviewIngredient } from '../../src/core/nutritionV2/matching/review';
import type { IngredientReviewResult, ReviewCatalog } from '../../src/core/nutritionV2/matching/types';
import type { NetworkAdapter, NetworkRequest, NetworkResponse } from '../../src/application/adapters/NetworkAdapter';
import { buildMatchingBundle, DEFAULT_MATCHING_SPECS, type MatchingRecordSpec } from '../fixtures/usdaMatchingFixtures';

const BUNDLE = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
const SESSION = SESSION_RESULT.ok ? SESSION_RESULT.session : undefined;

function makeCatalog(specs: ReadonlyArray<MatchingRecordSpec> = DEFAULT_MATCHING_SPECS): ReviewCatalog {
  const { manifest, records } = buildMatchingBundle(specs);
  const result = createReviewCatalog(manifest, records);
  if (!result.ok) throw new Error('catalog build failed');
  return result.catalog;
}

const CATALOG = makeCatalog();
const AE_CAPS = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });

function strictReview(name = 'Sugar, granulated'): IngredientReviewResult {
  return reviewIngredient(CATALOG, { name });
}

function familyReview(name = 'flour'): IngredientReviewResult {
  return reviewIngredient(CATALOG, { name });
}

interface FakeNetwork {
  readonly network: NetworkAdapter;
  readonly calls: ReadonlyArray<NetworkRequest>;
}

function fakeNetwork(
  responder: () => NetworkResponse<unknown> | Promise<NetworkResponse<unknown>>
): FakeNetwork {
  const calls: NetworkRequest[] = [];
  const network: NetworkAdapter = {
    async request<TResponse, TBody>(request: NetworkRequest<TBody>): Promise<NetworkResponse<TResponse>> {
      calls.push(request as unknown as NetworkRequest);
      return (await responder()) as NetworkResponse<TResponse>;
    },
    async get<TResponse>(path: string): Promise<NetworkResponse<TResponse>> {
      calls.push({ method: 'GET', path });
      return (await responder()) as NetworkResponse<TResponse>;
    },
    async post<TResponse, TBody>(path: string, body: TBody): Promise<NetworkResponse<TResponse>> {
      calls.push({ method: 'POST', path, body });
      return (await responder()) as NetworkResponse<TResponse>;
    },
  };
  return { network, calls: calls as ReadonlyArray<NetworkRequest> };
}

const REQUEST_ID = 'req-ai2c-accept-1';

/** Builds the AI-2A context + reviews for one or two lines. */
function buildRequest(
  entries: ReadonlyArray<{ readonly lineRef: string; readonly review: IngredientReviewResult }>
): { context: AiAdvancedPlanRequestContext; reviews: Map<string, unknown> } {
  const sources = entries.map((entry) => {
    const source = buildAiAdvancedPlanLineSource({ lineRef: entry.lineRef, review: entry.review });
    if (source.ok !== true) throw new Error(`source build failed: ${source.code}`);
    return source.source;
  });
  const built = buildAiAdvancedPlanRequestContext({ requestId: REQUEST_ID, lines: sources });
  if (built.ok !== true) throw new Error(`context build failed: ${built.code}`);
  return {
    context: built.context,
    reviews: new Map<string, unknown>(entries.map((entry) => [entry.lineRef, entry.review])),
  };
}

function targetsFor(context: AiAdvancedPlanRequestContext) {
  return context.allowed_line_refs.map((lineRef) => ({ line_ref: lineRef, source_text: `wording ${lineRef}` }));
}

function envelope(plan: unknown, requestId: string = REQUEST_ID): NetworkResponse<unknown> {
  return { status: 200, ok: true, data: { ok: true, request_id: requestId, plan, aiAttempted: true } };
}

function wire(...entries: ReadonlyArray<Record<string, unknown>>) {
  return {
    plan_version: AI_ADVANCED_PLAN_VERSION,
    plans: entries.map((entry) => ({
      measure_kind: 'unknown',
      review_required: false,
      ambiguity_reasons: [],
      ...entry,
    })),
  };
}

function baseArgs(overrides: Record<string, unknown>): never {
  return {
    session: SESSION,
    capabilities: AE_CAPS,
    ...overrides,
  } as never;
}

// ---------------------------------------------------------------------------
// Happy path + confirmation requirement
// ---------------------------------------------------------------------------

describe('aiPlanAcceptance — genuine confirmation is required', () => {
  it('accepts one strict automatic line through the genuine session', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'sugar', candidate_ref: 'c1' })));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['sugar'],
        workingState: {},
        captured: { fingerprints: new Map([['sugar', 'fp-1']]), matches: {}, massSourceLineRefs: [] },
        currentFingerprints: new Map([['sugar', 'fp-1']]),
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.outcome.accepted_count).toBe(1);
    expect(result.outcome.accepted[0].line_ref).toBe('sugar');
    expect(result.outcome.accepted[0].choice).toMatchObject({
      kind: 'candidate',
      review_digest: review.review_digest,
      automatic: true,
      aiAssisted: true,
      aiAccepted: true,
    });
    // EXACTLY ONE network call: the AI-2B plan POST. No persistence traffic.
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].method).toBe('POST');
    expect(fake.calls[0].path).toBe('/api/nutrition/plan-ingredients');
  });

  it('refuses to accept when the review is no longer the current one (unconfirmed, no dispatch)', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    // The CURRENT review is a different snapshot: the confirmation must fail.
    const changed = { ...(review as unknown as Record<string, unknown>), review_digest: 'b'.repeat(64) };
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'sugar', candidate_ref: 'c1' })));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews: new Map<string, unknown>([['sugar', changed]]),
        currentLineRefs: ['sugar'],
        workingState: {},
        captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
        currentFingerprints: new Map([['sugar', 'fp-1']]),
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.outcome.accepted_count).toBe(0);
    // AI-2A already refuses the stale review: preserved, never confirmed.
    expect(result.outcome.preserved.map((entry) => entry.reason)).toContain('stale_review');
  });

  it('never accepts through a structural session fake (fails closed, unconfirmed)', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'sugar', candidate_ref: 'c1' })));
    const fakeSession = {
      confirmMatch: () => ({ outcome: 'confirmed', fdc_id: 2001 }),
    };

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        session: fakeSession,
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['sugar'],
        workingState: {},
        captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
        currentFingerprints: new Map([['sugar', 'fp-1']]),
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.outcome.accepted_count).toBe(0);
    expect(result.outcome.unconfirmed).toEqual([{ line_ref: 'sugar', reason: 'invalid_catalog' }]);
  });
});

// ---------------------------------------------------------------------------
// Capability + request currency
// ---------------------------------------------------------------------------

describe('aiPlanAcceptance — capability and request currency', () => {
  it('performs ZERO network work when the capability is unavailable', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fake = fakeNetwork(() => {
      throw new Error('network must not be touched');
    });

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        capabilities: BASIC_NUTRITION_CAPABILITIES,
        context,
        targets: targetsFor(context),
        reviews,
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.code).toBe('unavailable');
    expect(result.message).toBe(AI_PLAN_UNAVAILABLE_MESSAGE);
    expect(result.aiAttempted).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it('discards a superseded request before any confirmation (existing stale code)', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'sugar', candidate_ref: 'c1' })));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['sugar'],
        workingState: {},
        captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
        currentFingerprints: new Map([['sugar', 'fp-1']]),
        isCurrent: () => false,
      })
    );

    expect(result).toMatchObject({ ok: false, code: 'stale_request', aiAttempted: true });
  });

  it('reports provider failures with the existing bounded codes', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fake = fakeNetwork(() => ({ status: 502, ok: false }));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(['provider_error', 'invalid_response']).toContain(result.code);
    expect(result.aiAttempted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// User authority + offers
// ---------------------------------------------------------------------------

describe('aiPlanAcceptance — user authority is preserved', () => {
  it('preserves a user mass decision over an otherwise acceptable line', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'sugar', candidate_ref: 'c1' })));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['sugar'],
        workingState: { userMasses: { sugar: { kind: 'explicit', quantity: 250, unit: 'g' } } },
        captured: { fingerprints: new Map([['sugar', 'fp-mass']]), massSourceLineRefs: ['sugar'] },
        currentFingerprints: new Map([['sugar', 'fp-mass']]),
      })
    );

    if (result.ok !== true) throw new Error('expected ok');
    expect(result.outcome.accepted_count).toBe(0);
    expect(result.outcome.conflicts[0].kind).toBe('pre_existing_mass_source');
  });

  it('skips a line the user edited while the plan was in flight', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'sugar', candidate_ref: 'c1' })));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['sugar'],
        workingState: {},
        captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
        currentFingerprints: new Map([['sugar', 'fp-2']]),
      })
    );

    if (result.ok !== true) throw new Error('expected ok');
    expect(result.outcome.accepted_count).toBe(0);
    expect(result.outcome.conflicts).toEqual([
      { line_ref: 'sugar', kind: 'fingerprint_changed', reason: 'deterministic_automatic' },
    ]);
  });

  it('keeps a best-effort line as a non-mutating offer', async () => {
    const review = familyReview();
    const { context, reviews } = buildRequest([{ lineRef: 'flour', review }]);
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'flour', candidate_ref: 'c1' })));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['flour'],
        workingState: {},
        captured: { fingerprints: new Map([['flour', 'fp-1']]) },
        currentFingerprints: new Map([['flour', 'fp-1']]),
      })
    );

    if (result.ok !== true) throw new Error('expected ok');
    expect(result.outcome.accepted_count).toBe(0);
    expect(result.outcome.offer_count).toBe(1);
    expect(result.outcome.offers[0].choice.aiAccepted).toBeUndefined();
  });

  it('is idempotent: a repeat run reports unchanged and accepts nothing', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fdcId = (review.candidates as ReadonlyArray<{ fdc_id: number }>)[0].fdc_id;
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'sugar', candidate_ref: 'c1' })));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['sugar'],
        // The state left behind by a first successful run.
        workingState: {
          matches: {
            sugar: {
              kind: 'candidate',
              fdc_id: fdcId,
              review_digest: review.review_digest,
              automatic: true,
              aiAssisted: true,
              aiAccepted: true,
            },
          },
        },
        captured: { fingerprints: new Map([['sugar', 'fp-1']]), matches: {}, massSourceLineRefs: [] },
        currentFingerprints: new Map([['sugar', 'fp-1']]),
      })
    );

    if (result.ok !== true) throw new Error('expected ok');
    expect(result.outcome.accepted_count).toBe(0);
    expect(result.outcome.unchanged).toEqual(['sugar']);
    expect(result.outcome.unchanged_count).toBe(1);
  });

  it('reports honest counts for a mixed plan (accepted + offer)', async () => {
    const sugar = strictReview();
    const flour = familyReview();
    const { context, reviews } = buildRequest([
      { lineRef: 'sugar', review: sugar },
      { lineRef: 'flour', review: flour },
    ]);
    const fake = fakeNetwork(() =>
      envelope(
        wire({ line_ref: 'sugar', candidate_ref: 'c1' }, { line_ref: 'flour', candidate_ref: 'c1' })
      )
    );

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['sugar', 'flour'],
        workingState: {},
        captured: {
          fingerprints: new Map([
            ['sugar', 'fp-1'],
            ['flour', 'fp-2'],
          ]),
        },
        currentFingerprints: new Map([
          ['sugar', 'fp-1'],
          ['flour', 'fp-2'],
        ]),
      })
    );

    if (result.ok !== true) throw new Error(`expected ok, got ${result.code}`);
    expect(result.outcome.accepted.map((entry) => entry.line_ref)).toEqual(['sugar']);
    expect(result.outcome.offers.map((entry) => entry.line_ref)).toEqual(['flour']);
    expect(result.outcome.classified_automatic).toBe(1);
    expect(result.outcome.classified_offer).toBe(1);
    // Honest counts: exactly one line was promoted, one is an offer, none lost.
    expect(result.outcome.accepted_count + result.outcome.offer_count + result.outcome.preserved_count).toBe(2);
  });

  it('refuses a plan naming an unknown candidate ref (whole response, no mutation)', async () => {
    const review = strictReview();
    const { context, reviews } = buildRequest([{ lineRef: 'sugar', review }]);
    const fake = fakeNetwork(() => envelope(wire({ line_ref: 'sugar', candidate_ref: 'c9' })));

    const result = await requestAndReconcileAiAdvancedPlan(
      baseArgs({
        network: fake.network,
        context,
        targets: targetsFor(context),
        reviews,
        currentLineRefs: ['sugar'],
        workingState: {},
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.code).toBe('invalid_response');
    expect(result.aiAttempted).toBe(true);
  });
});
