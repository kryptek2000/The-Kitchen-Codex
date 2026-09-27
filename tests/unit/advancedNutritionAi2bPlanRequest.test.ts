/**
 * The Kitchen Codex — AI-2B application candidate-planning requester.
 *
 * Proves the CLIENT-side rules of the live round trip:
 *   - Basic/manual mode performs ZERO plan network calls (capability gate first);
 *   - the transport body carries the AI-2A provider request and a request id, and
 *     nothing else (no local candidate map, no identity, no acceptance values);
 *   - a missing/wrong/replayed request id is rejected as stale;
 *   - the response is RE-sanitized locally against this request's allowances, so
 *     an unknown/cross-line ref, a portion ref, a non-`unknown` measure kind, a
 *     per-entry `plan_version`, or any authority field yields NO plan;
 *   - the returned value is the canonical WIRE form and is directly consumable by
 *     the AI-2A validator (`validateAndApplyAiAdvancedPlan`) with no shape surgery
 *     — while the production requester itself never applies anything.
 */

import { describe, it, expect, vi } from 'vitest';

// The BYOK/selection header builder needs a platform settings store; the
// application requester is exercised with the SAME stub AI-1's live tests use.
// `reject` lets one test prove the requester fails closed (no network at all)
// when the selection context cannot be built.
const selectionMock = vi.hoisted(() => ({ reject: false }));
vi.mock('../../src/application/aiSelection', () => ({
  buildAiSelectionRequestOptions: async () => {
    if (selectionMock.reject) throw new Error('no settings store available');
    return {};
  },
}));

import {
  AI_PLAN_FINGERPRINT_MESSAGE,
  AI_PLAN_INVALID_MESSAGE,
  AI_PLAN_STALE_MESSAGE,
  AI_PLAN_TARGET_MESSAGE,
  AI_PLAN_UNAVAILABLE_MESSAGE,
  NUTRITION_PLAN_ENDPOINT,
  isAiCandidatePlanAvailable,
  requestAiAdvancedCandidatePlan,
  type AiAdvancedCandidatePlanArgs,
} from '../../src/application/nutritionAiPlan';
import type {
  NetworkAdapter,
  NetworkRequest,
  NetworkResponse,
} from '../../src/application/adapters/NetworkAdapter';
import {
  BASIC_NUTRITION_CAPABILITIES,
  resolveNutritionCapabilities,
  type NutritionCapabilities,
} from '../../src/core/nutritionV2/nutritionCapabilities';
import {
  AI_ADVANCED_PLAN_REQUEST_VERSION,
  buildAiAdvancedPlanRequestContext,
  type AiAdvancedPlanRequestContext,
} from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import { AI_ADVANCED_PLAN_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlan';
import { buildAiAdvancedPlanLineSource } from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import { validateAndApplyAiAdvancedPlan } from '../../src/core/nutritionV2/aiAdvancedPlanApply';
import {
  buildAiAdvancedPlanTargetBinding,
  type AiAdvancedPlanTarget,
  type AiAdvancedPlanTargetBinding,
} from '../../src/core/nutritionV2/aiAdvancedPlanTarget';

const REQUEST_ID = 'req-ai2b-app-1';
const SELECTED = 170054;
const OTHER = 170501;

const AI_CAPABILITIES = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });

function candidate(fdcId: number, description: string) {
  return {
    fdc_id: fdcId,
    data_type: 'sr_legacy_food',
    description,
    normalized_description: description.toLowerCase(),
    record_digest: `digest-${fdcId}`,
    match_class: 'all_query_tokens_present',
    evidence: {
      exact_phrase: false,
      exact_token_multiset: false,
      matched_query_token_count: 2,
      missing_query_token_count: 0,
      extra_candidate_token_count: 1,
      order_agreement: 1,
    },
  };
}

function review() {
  return {
    outcome: 'matched_exact',
    line_ref: 'tomato sauce',
    original_text: 'tomato sauce',
    query: 'tomato sauce',
    normalized_query: 'tomato sauce',
    query_tokens: ['tomato', 'sauce'],
    bundle_release: 'usda_fdc_87c5408a3e98838944a87be74824761e',
    catalog_digest: 'catalog-digest',
    normalization_version: 'n1',
    ranking_version: 'r1',
    result_limit: 10,
    selected_fdc_id: SELECTED,
    candidates: [
      candidate(SELECTED, 'Tomato products, canned, sauce'),
      candidate(OTHER, 'Tomatoes, crushed, canned'),
    ],
    review_digest: 'review-digest-1',
  };
}

function contextFor(): AiAdvancedPlanRequestContext {
  const source = buildAiAdvancedPlanLineSource({ lineRef: 'tomato sauce', review: review() });
  if (source.ok !== true) throw new Error(`source failed: ${source.code}`);
  const built = buildAiAdvancedPlanRequestContext({ requestId: REQUEST_ID, lines: [source.source] });
  if (built.ok !== true) throw new Error(`context failed: ${built.code}`);
  return built.context;
}

function wireEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    line_ref: 'tomato sauce',
    candidate_ref: 'c1',
    measure_kind: 'unknown',
    review_required: false,
    ambiguity_reasons: [],
    confidence: 'high',
    ...overrides,
  };
}

function wirePlan(...entries: ReadonlyArray<Record<string, unknown>>) {
  return { plan_version: AI_ADVANCED_PLAN_VERSION, plans: entries };
}

interface FakeNetwork {
  readonly network: NetworkAdapter;
  readonly calls: NetworkRequest[];
}

function fakeNetwork(responder: () => Promise<NetworkResponse<unknown>> | NetworkResponse<unknown>): FakeNetwork {
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
    async post<TResponse, TBody>(
      path: string,
      body: TBody,
      options?: { headers?: Record<string, string> }
    ): Promise<NetworkResponse<TResponse>> {
      calls.push({ method: 'POST', path, body, ...(options ? { headers: options.headers } : {}) });
      return (await responder()) as NetworkResponse<TResponse>;
    },
  };
  return { network, calls };
}

function okEnvelope(plan: unknown, requestId: string = REQUEST_ID) {
  return { status: 200, ok: true, data: { ok: true, request_id: requestId, plan, aiAttempted: true } };
}

/** Planning targets for a context (one per requested line). */
function targetsFor(context: AiAdvancedPlanRequestContext): ReadonlyArray<AiAdvancedPlanTarget> {
  return context.allowed_line_refs.map((lineRef) => ({
    line_ref: lineRef,
    source_text: `wording for ${lineRef}`,
  })) as unknown as ReadonlyArray<AiAdvancedPlanTarget>;
}

/**
 * The requester with default target coverage supplied, so each test only has to
 * state what it is actually testing.
 */
function requestPlan(
  args: Omit<AiAdvancedCandidatePlanArgs, 'targets'> & {
    targets?: ReadonlyArray<AiAdvancedPlanTarget>;
  }
) {
  // When bindings are supplied they carry the targets; supplying both is an error the
  // requester must refuse, so the helper passes exactly one.
  return requestAiAdvancedCandidatePlan({
    ...(args.targetBindings !== undefined ? {} : { targets: targetsFor(args.context) }),
    ...args,
  });
}

describe('AI-2B application requester — capability boundary', () => {
  it('performs ZERO network calls in Basic/manual mode', async () => {
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const result = await requestPlan({
      context: contextFor(),
      network,
      capabilities: BASIC_NUTRITION_CAPABILITIES,
    });
    expect(result).toEqual({
      ok: false,
      code: 'unavailable',
      message: AI_PLAN_UNAVAILABLE_MESSAGE,
      aiAttempted: false,
    });
    expect(calls).toHaveLength(0);
    expect(isAiCandidatePlanAvailable(BASIC_NUTRITION_CAPABILITIES)).toBe(false);
  });

  it('fails closed for an AI-advanced tier that has not enabled orchestration', async () => {
    const gated: NutritionCapabilities = Object.freeze({
      ...AI_CAPABILITIES,
      aiCandidateOrchestration: false,
    });
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const result = await requestPlan({
      context: contextFor(),
      network,
      capabilities: gated,
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('never mutates the deterministic/manual workflow on failure', async () => {
    const { network } = fakeNetwork(() => ({ status: 503, ok: false, data: { ok: false } }));
    const context = contextFor();
    const before = JSON.stringify(context.provider_request);
    const result = await requestPlan({
      context,
      network,
      capabilities: AI_CAPABILITIES,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(context.provider_request)).toBe(before);
  });
});

describe('AI-2B application requester — transport body and request identity', () => {
  it('sends ONLY the transport envelope around the AI-2A provider request', async () => {
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const context = contextFor();
    const result = await requestPlan({
      context,
      network,
      capabilities: AI_CAPABILITIES,
    });
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.path).toBe(NUTRITION_PLAN_ENDPOINT);
    expect(call.method).toBe('POST');
    const body = call.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'plan_request',
      'planning_targets',
      'request_id',
      'request_version',
    ]);
    // The target rides in the TRANSPORT only: the provider request is unchanged.
    expect(body['planning_targets']).toEqual([
      { line_ref: 'tomato sauce', source_text: 'wording for tomato sauce' },
    ]);
    expect(body['request_version']).toBe(AI_ADVANCED_PLAN_REQUEST_VERSION);
    expect(body['request_id']).toBe(REQUEST_ID);
    expect(body['plan_request']).toEqual(context.provider_request);

    // No identity, digest, gram, nutrient, portion, or acceptance surface leaks.
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'fdc_id',
      'record_digest',
      'review_digest',
      'catalog_digest',
      'bundle_release',
      'grams',
      'nutrients',
      'portion_ref',
      'strict_automatic_fdc_id',
      'best_effort',
      'local_candidate',
      '170054',
    ]) {
      expect({ forbidden, present: serialized.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  it('rejects a missing, wrong, empty, or replayed request id', async () => {
    const context = contextFor();
    const data = (requestId: unknown) => ({
      ok: true,
      ...(requestId === 'OMITTED' ? {} : { request_id: requestId }),
      plan: wirePlan(wireEntry()),
      aiAttempted: true,
    });
    for (const badId of ['OMITTED', '', 'req-other-999', 12345, null]) {
      const { network } = fakeNetwork(() => ({ status: 200, ok: true, data: data(badId) }));
      const result = await requestPlan({
        context,
        network,
        capabilities: AI_CAPABILITIES,
      });
      expect(result).toEqual({
        ok: false,
        code: 'stale_request',
        message: AI_PLAN_STALE_MESSAGE,
        aiAttempted: true,
      });
    }
  });

  it('fails closed with NO request when the selection context cannot be built', async () => {
    selectionMock.reject = true;
    try {
      const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
      const result = await requestPlan({
        context: contextFor(),
        network,
        capabilities: AI_CAPABILITIES,
      });
      expect(result).toEqual({
        ok: false,
        code: 'provider_error',
        message: AI_PLAN_UNAVAILABLE_MESSAGE,
        aiAttempted: true,
      });
      expect(calls).toHaveLength(0);
    } finally {
      selectionMock.reject = false;
    }
  });

  it('rejects transport failures and non-success server bodies with a bounded failure', async () => {
    const context = contextFor();
    const throwing = fakeNetwork(() => {
      throw new Error('network down');
    });
    expect(
      await requestPlan({
        context,
        network: throwing.network,
        capabilities: AI_CAPABILITIES,
      })
    ).toEqual({
      ok: false,
      code: 'provider_error',
      message: AI_PLAN_UNAVAILABLE_MESSAGE,
      aiAttempted: true,
    });

    for (const response of [
      { status: 503, ok: false, data: { ok: false } } as NetworkResponse<unknown>,
      { status: 200, ok: true, data: 'not an object' } as NetworkResponse<unknown>,
      { status: 200, ok: true, data: { ok: false, request_id: REQUEST_ID } } as NetworkResponse<unknown>,
      { status: 200, ok: true } as NetworkResponse<unknown>,
    ]) {
      const { network } = fakeNetwork(() => response);
      const result = await requestPlan({
        context,
        network,
        capabilities: AI_CAPABILITIES,
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe('provider_error');
    }
  });
});

describe('AI-2B application requester — planning target coverage (semantic binding)', () => {
  it('sends the targets in the transport envelope and never inside the provider request', async () => {
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const context = contextFor();
    const target = {
      line_ref: 'tomato sauce',
      source_text: '1 cup tomato sauce',
      semantic_food: {
        normalized_name: 'tomato sauce',
        modifiers: [],
        preparation: [],
        state: [],
        qualifiers: [],
      },
    };
    const result = await requestPlan({
      context,
      network,
      capabilities: AI_CAPABILITIES,
      targets: [target] as unknown as ReadonlyArray<AiAdvancedPlanTarget>,
    });
    expect(result.ok).toBe(true);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body['planning_targets']).toEqual([target]);
    // The AI-2A provider request is untouched by the target.
    expect(body['plan_request']).toEqual(context.provider_request);
    expect(JSON.stringify(body['plan_request'])).not.toContain('source_text');
    // The request identity remains transport-only.
    expect(body['request_id']).toBe(REQUEST_ID);
  });

  it('fails closed with ZERO network calls when target coverage is not exact', async () => {
    const cases: ReadonlyArray<ReadonlyArray<AiAdvancedPlanTarget>> = [
      [] as never,
      [{ line_ref: 'some other line', source_text: 'other' }] as never,
      [
        { line_ref: 'tomato sauce', source_text: 'sauce' },
        { line_ref: 'tomato sauce', source_text: 'sauce again' },
      ] as never,
      [{ line_ref: 'tomato sauce', source_text: '' }] as never,
      [{ line_ref: 'tomato sauce', source_text: 'x'.repeat(301) }] as never,
      [{ line_ref: 'tomato sauce', source_text: 'sauce', fdc_id: 170054 }] as never,
    ];
    for (const targets of cases) {
      const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
      const result = await requestPlan({
        context: contextFor(),
        network,
        capabilities: AI_CAPABILITIES,
        targets,
      });
      expect({ targets: JSON.stringify(targets), calls: calls.length }).toEqual({
        targets: JSON.stringify(targets),
        calls: 0,
      });
      expect(result).toEqual({
        ok: false,
        code: 'invalid_response',
        message: AI_PLAN_TARGET_MESSAGE,
        aiAttempted: false,
      });
    }
  });

  it("a bound target's fingerprint never enters the provider-facing transport", async () => {
    // CORRECTED RULE: the application layer is NOT banned from handling a fingerprint —
    // it may carry one locally as binding metadata. What must never happen is a
    // fingerprint reaching the provider-facing transport, and that is what is pinned
    // here at runtime (a static "the requester must not mention it" rule was too strict
    // and would have blocked the very retention closure 2 requires).
    const bound = buildAiAdvancedPlanTargetBinding({
      lineRef: 'tomato sauce',
      sourceText: '1 cup tomato sauce',
      interpretationFingerprint: 'fp-local-1',
    });
    expect(bound.ok).toBe(true);
    if (bound.ok !== true) return;

    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const result = await requestPlan({
      context: contextFor(),
      network,
      capabilities: AI_CAPABILITIES,
      targets: [bound.binding.target],
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(calls[0]!.body)).not.toContain('fp-local-1');
    expect(JSON.stringify(calls[0]!.body)).not.toContain('interpretation_fingerprint');

    // And a BINDING handed in where a TARGET is expected is refused outright — its
    // extra key is not a target key, so the fingerprint cannot ride along by accident.
    const { network: strictNetwork, calls: strictCalls } = fakeNetwork(() =>
      okEnvelope(wirePlan(wireEntry()))
    );
    const asTarget = await requestPlan({
      context: contextFor(),
      network: strictNetwork,
      capabilities: AI_CAPABILITIES,
      targets: [bound.binding as unknown as AiAdvancedPlanTarget],
    });
    expect(asTarget.ok).toBe(false);
    expect(strictCalls).toHaveLength(0);
  });

  it('re-reads (re-sanitizes) caller-supplied targets instead of trusting them', async () => {
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    // A hand-forged frozen-looking target carrying an authority field is rejected
    // before the network: the requester re-reads every target itself.
    const forged = Object.freeze({
      line_ref: 'tomato sauce',
      source_text: '1 cup tomato sauce',
      nutrient_profile: { calories: 1 },
    });
    const result = await requestPlan({
      context: contextFor(),
      network,
      capabilities: AI_CAPABILITIES,
      targets: [forged] as unknown as ReadonlyArray<AiAdvancedPlanTarget>,
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('AI-2B application requester — local re-sanitization and live policy', () => {
  const context = contextFor();

  async function attempt(plan: unknown, requestId: string = REQUEST_ID) {
    const { network } = fakeNetwork(() => okEnvelope(plan, requestId));
    return requestPlan({ context, network, capabilities: AI_CAPABILITIES });
  }

  it('accepts a canonical wire plan and returns the frozen wire form', async () => {
    const result = await attempt(wirePlan(wireEntry()));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.requestId).toBe(REQUEST_ID);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.plans)).toBe(true);
    expect(result.plan.plan_version).toBe(AI_ADVANCED_PLAN_VERSION);
    expect(Object.keys(JSON.parse(JSON.stringify(result.plan.plans[0])) as object).sort()).toEqual([
      'ambiguity_reasons',
      'candidate_ref',
      'confidence',
      'line_ref',
      'measure_kind',
      'review_required',
    ]);
    expect(JSON.stringify(result.plan).match(/plan_version/g)?.length).toBe(1);
  });

  it('rejects a malformed or trapped envelope, including per-entry plan_version', async () => {
    const cases: unknown[] = [
      undefined,
      'plan',
      [],
      { plans: [wireEntry()] },
      { plan_version: 'other', plans: [wireEntry()] },
      // The trap: a server that serialized the sanitizer's INTERNAL plans.
      {
        plan_version: AI_ADVANCED_PLAN_VERSION,
        plans: [{ ...wireEntry(), plan_version: AI_ADVANCED_PLAN_VERSION }],
      },
      // A request id embedded inside the plan.
      { plan_version: AI_ADVANCED_PLAN_VERSION, plans: [wireEntry()], request_id: REQUEST_ID },
    ];
    for (const plan of cases) {
      const result = await attempt(plan);
      expect(result).toEqual({
        ok: false,
        code: 'invalid_response',
        message: AI_PLAN_INVALID_MESSAGE,
        aiAttempted: true,
      });
    }
  });

  it('rejects unknown, cross-line, and out-of-namespace candidate refs client-side', async () => {
    for (const ref of ['c9', 'p1', '9', 'czzz']) {
      const result = await attempt(wirePlan(wireEntry({ candidate_ref: ref })));
      expect(result.ok).toBe(false);
    }
    const unknownLine = await attempt(wirePlan(wireEntry({ line_ref: 'other line' })));
    expect(unknownLine.ok).toBe(false);
  });

  it('rejects a portion ref, a non-`unknown` measure kind, and authority fields', async () => {
    // NOTE for auditors: the portion surface is closed by TWO independent layers —
    // the canonical sanitizer's frozen EMPTY portion allowance and the explicit
    // local live-policy check below. Either layer alone rejects a portion ref, so
    // only a mutation that disables BOTH is observable through this path (verified
    // in the AI-2B mutation battery).
    expect((await attempt(wirePlan(wireEntry({ portion_ref: 'p1' })))).ok).toBe(false);
    for (const measureKind of ['source_portion', 'count', 'household', 'mass']) {
      const result = await attempt(wirePlan(wireEntry({ measure_kind: measureKind })));
      expect(result.ok).toBe(false);
    }
    for (const authority of [
      { fdc_id: 1 },
      { grams: 120 },
      { nutrients: { calories: 10 } },
      { apply: true },
      { authorization: 'granted' },
      { persisted: true },
    ]) {
      const result = await attempt(wirePlan(wireEntry(authority)));
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a duplicated line ref and an over-cap plan list', async () => {
    expect((await attempt(wirePlan(wireEntry(), wireEntry()))).ok).toBe(false);
    const overCap = wirePlan(
      ...Array.from({ length: 13 }, () => wireEntry())
    );
    expect((await attempt(overCap)).ok).toBe(false);
  });

  it('PROOF: requester output is directly consumable by the AI-2A validator', async () => {
    const reviews = new Map([['tomato sauce', review()]]);
    const result = await attempt(wirePlan(wireEntry()));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;

    // The production requester itself never applies: this call is the CALLER's
    // (AI-2C's) future job, and here it runs only in the test harness.
    const applied = validateAndApplyAiAdvancedPlan({
      rawPlanResponse: result.plan,
      responseRequestId: result.requestId,
      context,
      reviews,
      deterministicAcceptance: () => ({
        strict_automatic_fdc_id: SELECTED,
        best_effort_default_fdc_id: SELECTED,
        best_effort_eligible_fdc_ids: [SELECTED, OTHER],
      }),
    });
    expect(applied.ok).toBe(true);
    if (applied.ok !== true) return;
    expect(applied.application.lines[0]).toMatchObject({
      line_ref: 'tomato sauce',
      status: 'automatic',
      reason: 'deterministic_automatic',
      candidate_ref: 'c1',
      local_fdc_id: SELECTED,
      matches_strict_automatic: true,
    });
  });

  it('PROOF: a below-threshold AI selection survives the round trip as an offer', async () => {
    const reviews = new Map([['tomato sauce', review()]]);
    const result = await attempt(wirePlan(wireEntry({ candidate_ref: 'c2' })));
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const applied = validateAndApplyAiAdvancedPlan({
      rawPlanResponse: result.plan,
      responseRequestId: result.requestId,
      context,
      reviews,
      deterministicAcceptance: () => ({
        strict_automatic_fdc_id: SELECTED,
        best_effort_eligible_fdc_ids: [SELECTED],
      }),
    });
    expect(applied.ok).toBe(true);
    if (applied.ok !== true) return;
    expect(applied.application.lines[0]).toMatchObject({
      status: 'offer',
      reason: 'below_deterministic_threshold',
      local_fdc_id: OTHER,
      matches_strict_automatic: false,
    });
  });

  it('PROOF: an abstaining plan applies as review, never as a selection', async () => {
    const reviews = new Map([['tomato sauce', review()]]);
    const abstain = wirePlan({
      line_ref: 'tomato sauce',
      measure_kind: 'unknown',
      review_required: true,
      ambiguity_reasons: ['ambiguous'],
    });
    const result = await attempt(abstain);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const applied = validateAndApplyAiAdvancedPlan({
      rawPlanResponse: result.plan,
      responseRequestId: result.requestId,
      context,
      reviews,
      deterministicAcceptance: () => ({ strict_automatic_fdc_id: SELECTED }),
    });
    expect(applied.ok).toBe(true);
    if (applied.ok !== true) return;
    expect(applied.application.lines[0]['status']).toBe('review');
    expect(applied.application.lines[0]['candidate_ref']).toBeUndefined();
  });


describe('AI-2B application requester — CLOSURE 2 fingerprint binding check', () => {
  /** A context whose AI-2A line source carries an interpretation fingerprint. */
  const contextWithFingerprint = (fingerprint: unknown) => {
    const source = buildAiAdvancedPlanLineSource({
      lineRef: 'tomato sauce',
      review: review(),
      interpretationFingerprint: fingerprint,
    });
    if (source.ok !== true) throw new Error(`source failed: ${source.code}`);
    const built = buildAiAdvancedPlanRequestContext({ requestId: REQUEST_ID, lines: [source.source] });
    if (built.ok !== true) throw new Error(`context failed: ${built.code}`);
    return built.context;
  };

  /** A canonical binding for the requested line, optionally carrying a local fingerprint. */
  const bindingFor = (fingerprint?: string): AiAdvancedPlanTargetBinding => {
    const built = buildAiAdvancedPlanTargetBinding({
      lineRef: 'tomato sauce',
      sourceText: 'wording for tomato sauce',
      ...(fingerprint !== undefined ? { interpretationFingerprint: fingerprint } : {}),
    });
    if (built.ok !== true) throw new Error(`binding failed: ${built.code}`);
    return built.binding;
  };

  it('accepts a binding whose fingerprint MATCHES the AI-2A source, and keeps it out of the transport', async () => {
    const FINGERPRINT = 'fp-ai1-local-9f4c1e';
    const context = contextWithFingerprint(FINGERPRINT);
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const result = await requestPlan({
      context,
      network,
      capabilities: AI_CAPABILITIES,
      targetBindings: [bindingFor(FINGERPRINT)],
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);

    // DYNAMIC PROOF (Closure 2): the real local fingerprint value — and the key that
    // names it — never appear in the transport bytes. The fingerprint is local binding
    // metadata, not request content.
    const transportBytes = JSON.stringify(calls[0]!.body);
    expect(transportBytes).not.toContain(FINGERPRINT);
    expect(transportBytes).not.toContain('interpretation_fingerprint');
    // …and the session must not have registered the fingerprint somewhere else either:
    // the target that rides in the transport carries only its canonical keys.
    const body = calls[0]!.body as Record<string, unknown>;
    const targets = body['planning_targets'] as ReadonlyArray<Record<string, unknown>>;
    expect(Object.keys(targets[0]!)).not.toContain('interpretation_fingerprint');
  });

  it('FAILS CLOSED with ZERO network calls when the fingerprints DIFFER', async () => {
    const context = contextWithFingerprint('fp-ai1-current');
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const result = await requestPlan({
      context,
      network,
      capabilities: AI_CAPABILITIES,
      targetBindings: [bindingFor('fp-ai1-superseded')],
    });
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.code).toBe('stale_request');
    expect(result.message).toBe(AI_PLAN_FINGERPRINT_MESSAGE);
    expect(result.aiAttempted).toBe(false);
    // ZERO NETWORK — the whole point of a pre-flight binding check.
    expect(calls).toHaveLength(0);
  });

  it('does NOT invent a fingerprint, and does not fail when only one side carries one', async () => {
    // Source has one, binding does not.
    const withSource = contextWithFingerprint('fp-ai1-source-only');
    const first = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const a = await requestPlan({
      context: withSource,
      network: first.network,
      capabilities: AI_CAPABILITIES,
      targetBindings: [bindingFor()],
    });
    expect(a.ok).toBe(true);
    expect(first.calls).toHaveLength(1);

    // Binding has one, source does not.
    const bare = contextFor();
    const second = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const b = await requestPlan({
      context: bare,
      network: second.network,
      capabilities: AI_CAPABILITIES,
      targetBindings: [bindingFor('fp-ai1-binding-only')],
    });
    expect(b.ok).toBe(true);
    expect(second.calls).toHaveLength(1);
  });

  it('refuses BOTH targets and targetBindings (ambiguous input) with zero network', async () => {
    const context = contextFor();
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry())));
    const result = await requestPlan({
      context,
      network,
      capabilities: AI_CAPABILITIES,
      targets: targetsFor(context),
      targetBindings: [bindingFor('fp-ai1-local')],
    });
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.code).toBe('invalid_response');
    expect(result.message).toBe(AI_PLAN_TARGET_MESSAGE);
    expect(calls).toHaveLength(0);
  });
});

describe('AI-2B application requester — CLOSURE 3 ambiguity/alternative enforcement', () => {
  const ambiguousTarget = (context: AiAdvancedPlanRequestContext): ReadonlyArray<AiAdvancedPlanTarget> => [
    {
      ...(targetsFor(context)[0] as unknown as Record<string, unknown>),
      ambiguity: { ambiguous: true, reasons: ['cream could mean heavy cream or cream cheese'] },
    } as unknown as AiAdvancedPlanTarget,
  ];

  const alternativeTarget = (context: AiAdvancedPlanRequestContext): ReadonlyArray<AiAdvancedPlanTarget> => [
    {
      ...(targetsFor(context)[0] as unknown as Record<string, unknown>),
      alternatives: [{ normalized_name: 'cream cheese', notes: 'savoury reading' }],
    } as unknown as AiAdvancedPlanTarget,
  ];

  it('strips candidate authority from a FORGED response for an AMBIGUOUS target', async () => {
    const context = contextFor();
    // A forged/crafted server response: a candidate for a line whose target is ambiguous.
    const { network, calls } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry({ candidate_ref: 'c1' }))));
    const result = await requestPlan({
      context,
      network,
      capabilities: AI_CAPABILITIES,
      targets: ambiguousTarget(context),
    });
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const entries = (result.plan as unknown as { plans: ReadonlyArray<Record<string, unknown>> }).plans;
    expect(entries).toHaveLength(1);
    // The provider selection did NOT survive: no candidate authority, explicit review.
    expect(entries[0]!['candidate_ref']).toBeUndefined();
    expect(entries[0]!['review_required']).toBe(true);
  });

  it('strips candidate authority from a FORGED response for an AUTHORED-ALTERNATIVE target', async () => {
    const context = contextFor();
    const { network } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry({ candidate_ref: 'c2' }))));
    const result = await requestPlan({
      context,
      network,
      capabilities: AI_CAPABILITIES,
      targets: alternativeTarget(context),
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const entries = (result.plan as unknown as { plans: ReadonlyArray<Record<string, unknown>> }).plans;
    expect(entries[0]!['candidate_ref']).toBeUndefined();
    expect(entries[0]!['review_required']).toBe(true);
  });

  it('CONTROL: an unambiguous target with no alternatives keeps the candidate', async () => {
    const context = contextFor();
    const { network } = fakeNetwork(() => okEnvelope(wirePlan(wireEntry({ candidate_ref: 'c1' }))));
    const result = await requestPlan({ context, network, capabilities: AI_CAPABILITIES });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const entries = (result.plan as unknown as { plans: ReadonlyArray<Record<string, unknown>> }).plans;
    expect(entries[0]!['candidate_ref']).toBe('c1');
  });
});

});
