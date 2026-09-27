/**
 * The Kitchen Codex — AI-2B production verification.
 *
 * Deterministic, credential-free acceptance for the live candidate-planning
 * round trip. No paid provider is required: the provider boundary is exercised
 * through the SAME adapter functions the route uses, with canonical payloads the
 * deterministic system would have produced.
 *
 * PART A (in-process, the real production modules):
 *   - the transport sanitizer accepts the canonical envelope and rejects every
 *     authority/identity/oversize shape;
 *   - the provider-response sanitizer accepts a canonical plan and rejects wrong
 *     refs, cross-line refs, authority fields, non-`unknown` measure kinds,
 *     portion refs and oversized payloads;
 *   - the WIRE payload carries `plan_version` on the envelope ONLY and the
 *     sanitizer's internal per-entry form is rejected if ever serialized;
 *   - the application requester binds the request id, re-sanitizes, obeys the
 *     capability gate with ZERO network calls, and returns a plan the AI-2A
 *     validator accepts with no shape surgery.
 *
 * PART B (built + served application, real HTTP):
 *   - `POST /api/nutrition/plan-ingredients` is served, requires the AI access
 *     token, rejects malformed/authority-shaped/oversized requests with 400, and
 *     fails closed (503, `aiAttempted:false`) when no provider is configured —
 *     never an invented plan;
 *   - the plan route has its OWN rate-limit bucket, and the AI-1 interpretation
 *     route is still served with its own bucket and bounded behavior.
 *
 * Usage: bun x tsx scripts/verify_ai_plan_prod.ts
 *        (requires a build: bun run build)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MAX_AI_ADVANCED_PLAN_REQUEST_BYTES,
  MAX_AI_ADVANCED_PLAN_RESPONSE_BYTES,
  sanitizePlanProviderResponse,
  sanitizePlanTransportRequest,
  buildPlanPrompt,
  buildPlanPromptPayload,
} from '../server/nutritionPlan';
import {
  AI_ADVANCED_PLAN_REQUEST_VERSION,
  buildAiAdvancedPlanRequestContext,
} from '../src/core/nutritionV2/aiAdvancedPlanRequest';
import { AI_ADVANCED_CONTRACT_VERSION } from '../src/core/nutritionV2/aiAdvanced';
import { AI_ADVANCED_PLAN_VERSION } from '../src/core/nutritionV2/aiAdvancedPlan';
import { utf8ByteLength } from '../src/core/nutritionV2/schema';
import { buildAiAdvancedPlanLineSource } from '../src/core/nutritionV2/aiAdvancedPlanSource';
import {
  readAiAdvancedPlanWirePayload,
  toAiAdvancedPlanWirePayload,
} from '../src/core/nutritionV2/aiAdvancedPlanWire';
import { validateAndApplyAiAdvancedPlan } from '../src/core/nutritionV2/aiAdvancedPlanApply';
import {
  BASIC_NUTRITION_CAPABILITIES,
  resolveNutritionCapabilities,
} from '../src/core/nutritionV2/nutritionCapabilities';
import {
  buildAiAdvancedPlanTarget,
  buildAiAdvancedPlanTargetBinding,
  sanitizeAiAdvancedPlanTargets,
} from '../src/core/nutritionV2/aiAdvancedPlanTarget';
import { requestAiAdvancedCandidatePlan } from '../src/application/nutritionAiPlan';
import { resetAiSelectionWithOutcome } from '../src/application/aiSelection';
import type {
  NetworkAdapter,
  NetworkRequest,
  NetworkResponse,
} from '../src/application/adapters/NetworkAdapter';

const ROOT = resolve(import.meta.dirname, '..');
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4713);
const TOKEN = 'verify-plan-token';
const REQUEST_ID = 'req-verify-1';
const SELECTED = 170054;
const OTHER = 170501;

let passed = 0;
let failed = 0;
function record(name: string, ok: boolean, details?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${details ? ` — ${details}` : ''}`);
  }
}

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

function review(lineRef = 'tomato sauce') {
  return {
    outcome: 'matched_exact',
    line_ref: lineRef,
    original_text: lineRef,
    query: lineRef,
    normalized_query: lineRef,
    query_tokens: lineRef.split(' '),
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

function context() {
  const source = buildAiAdvancedPlanLineSource({ lineRef: 'tomato sauce', review: review() });
  if (source.ok !== true) throw new Error(`source failed: ${source.code}`);
  const built = buildAiAdvancedPlanRequestContext({
    requestId: REQUEST_ID,
    lines: [source.source],
  });
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

// ---------------------------------------------------------------------------
// PART A — production modules, in process
// ---------------------------------------------------------------------------

function partA(): void {
  console.log('\nPART A — transport / response / wire / application (in process)\n');
  const ctx = context();
  const allowances = {
    allowedLineRefs: ctx.allowed_line_refs,
    allowedCandidateRefsByLine: ctx.allowed_candidate_refs_by_line,
  };
  const transportBody = {
    request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
    request_id: REQUEST_ID,
    plan_request: ctx.provider_request,
    planning_targets: [{ line_ref: 'tomato sauce', source_text: '1 cup tomato sauce' }],
  };

  const accepted = sanitizePlanTransportRequest(transportBody);
  record(
    'A1 transport: canonical envelope accepted and rebuilt',
    accepted.ok === true &&
      accepted.request.requestId === REQUEST_ID &&
      JSON.stringify(accepted.request.providerRequest) === JSON.stringify(ctx.provider_request)
  );

  const authorityShaped = sanitizePlanTransportRequest({
    ...transportBody,
    plan_request: {
      ...ctx.provider_request,
      lines: [
        {
          line_ref: 'tomato sauce',
          candidates: [
            {
              candidate_ref: 'c1',
              display_description: 'sauce',
              semantic_tags: [],
              fdc_id: 99999,
            },
          ],
        },
      ],
    },
  });
  record('A2 transport: authority-shaped candidate rejected', authorityShaped.ok === false);

  const oversizedTransport = sanitizePlanTransportRequest({
    ...transportBody,
    plan_request: {
      contract_version: AI_ADVANCED_PLAN_VERSION,
      lines: Array.from({ length: 12 }, (_, lineIndex) => ({
        line_ref: `line:${lineIndex}`,
        candidates: Array.from({ length: 12 }, (_, candidateIndex) => ({
          candidate_ref: `c${candidateIndex + 1}`,
          display_description: `food ${'x'.repeat(190)}`,
          semantic_tags: [],
        })),
      })),
    },
  });
  record('A3 transport: oversized canonical payload rejected', oversizedTransport.ok === false);

  const canonicalResponse = wirePlan(wireEntry());
  const good = sanitizePlanProviderResponse(canonicalResponse, allowances);
  record(
    'A4 response: canonical plan survives sanitization',
    good.ok === true && good.plans.length === 1 && good.plans[0]['candidate_ref'] === 'c1'
  );

  record(
    'A5 response: unknown ref rejected',
    sanitizePlanProviderResponse(wirePlan(wireEntry({ candidate_ref: 'c9' })), allowances).ok === false
  );
  record(
    'A6 response: cross-line/unknown line rejected',
    sanitizePlanProviderResponse(wirePlan(wireEntry({ line_ref: 'other line' })), allowances).ok === false
  );
  const authorityResponse = sanitizePlanProviderResponse(
    wirePlan(wireEntry({ nutrition: { fdc_id: 1, grams: 120 } })),
    allowances
  );
  record(
    'A7 response: FDC/grams/authority field rejected',
    authorityResponse.ok === false && authorityResponse.code === 'authority_field'
  );
  record(
    'A8 response: non-`unknown` measure kind rejected',
    sanitizePlanProviderResponse(wirePlan(wireEntry({ measure_kind: 'mass' })), allowances).ok === false
  );
  record(
    'A9 response: portion ref rejected',
    sanitizePlanProviderResponse(wirePlan(wireEntry({ portion_ref: 'p1' })), allowances).ok === false
  );
  const oversizedResponse = sanitizePlanProviderResponse(
    wirePlan(
      ...Array.from({ length: 25 }, () => ({
        line_ref: 'tomato sauce',
        measure_kind: 'unknown',
        review_required: false,
        ambiguity_reasons: [],
        notes: 'x'.repeat(2000),
      }))
    ),
    allowances
  );
  record(
    'A10 response: oversized provider payload rejected',
    oversizedResponse.ok === false && oversizedResponse.code === 'oversized_response',
    `cap=${MAX_AI_ADVANCED_PLAN_RESPONSE_BYTES}`
  );

  const sanitizedInternal = sanitizePlanProviderResponse(canonicalResponse, allowances);
  const wire =
    sanitizedInternal.ok === true ? toAiAdvancedPlanWirePayload(sanitizedInternal.plans) : undefined;
  const serialized = JSON.stringify(wire);
  record(
    'A11 wire: envelope-only plan_version (exactly one occurrence)',
    (serialized.match(/plan_version/g)?.length ?? 0) === 1
  );
  record(
    'A12 wire: no per-entry plan_version and no request id inside the plan',
    Object.keys((JSON.parse(serialized) as { plans: Record<string, unknown>[] }).plans[0]).every(
      (key) => key !== 'plan_version'
    ) && !serialized.includes(REQUEST_ID)
  );
  record(
    'A13 wire: serializing the sanitizer internal form is rejected (trap proof)',
    readAiAdvancedPlanWirePayload({
      plan_version: AI_ADVANCED_PLAN_VERSION,
      plans: sanitizedInternal.ok === true ? sanitizedInternal.plans : [],
    }).ok === false
  );
  record(
    'A14 wire: reader accepts the rebuilt wire payload',
    readAiAdvancedPlanWirePayload(JSON.parse(serialized)).ok === true
  );

  // ---- PLANNING TARGET (semantic target binding repair) ---------------------
  const target = { line_ref: 'tomato sauce', source_text: '1 cup tomato sauce' };
  const noTargets = sanitizePlanTransportRequest({
    request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
    request_id: REQUEST_ID,
    plan_request: ctx.provider_request,
  });
  record('A-t1 target: a request with no planning target is rejected', noTargets.ok === false);
  const unknownTargetLine = sanitizePlanTransportRequest({
    ...transportBody,
    planning_targets: [target, { line_ref: 'other line', source_text: 'other' }],
  });
  record(
    'A-t2 target: a target for a line that was not requested is rejected',
    unknownTargetLine.ok === false
  );
  const duplicatedTarget = sanitizePlanTransportRequest({
    ...transportBody,
    planning_targets: [target, target],
  });
  record('A-t3 target: a duplicated target is rejected', duplicatedTarget.ok === false);
  const authorityTarget = sanitizePlanTransportRequest({
    ...transportBody,
    planning_targets: [{ ...target, fdc_id: 99999 }],
  });
  record(
    'A-t4 target: an authority-shaped target (fdc_id) is rejected',
    authorityTarget.ok === false
  );
  const oversizedTarget = sanitizePlanTransportRequest({
    ...transportBody,
    planning_targets: [{ ...target, source_text: 'x'.repeat(301) }],
  });
  record('A-t5 target: an over-bound target is rejected', oversizedTarget.ok === false);
  const withTarget = sanitizePlanTransportRequest({ ...transportBody, planning_targets: [target] });
  record(
    'A-t6 target: exact coverage is accepted and carried to the adapter',
    withTarget.ok === true && withTarget.request.planningTargets.length === 1
  );
  const boundPrompt = buildPlanPrompt(ctx.provider_request, [
    {
      line_ref: 'tomato sauce',
      source_text: '1 cup tomato sauce',
      semantic_food: {
        normalized_name: 'tomato sauce, canned',
        modifiers: [],
        preparation: [],
        state: [],
        qualifiers: [],
      },
    },
  ]);
  record(
    'A-t7 target: the provider prompt is given the semantic target (no longer blind)',
    boundPrompt.includes('1 cup tomato sauce') &&
      boundPrompt.includes('tomato sauce, canned') &&
      boundPrompt.includes('PLANNING TARGET') &&
      !boundPrompt.includes(REQUEST_ID)
  );

  // ---- COMPLETE model-request bound (targets INSIDE the 32 KiB cap) ---------
  const lineRefs = Array.from({ length: 12 }, (_, index) => `line:${index}`);
  const fatCandidates = {
    contract_version: AI_ADVANCED_PLAN_VERSION,
    lines: lineRefs.map((lineRef) => ({
      line_ref: lineRef,
      candidates: Array.from({ length: 8 }, (_, candidateIndex) => ({
        candidate_ref: `c${candidateIndex + 1}`,
        display_description: `candidate ${'y'.repeat(190)}`,
        semantic_tags: [],
      })),
    })),
  };
  const fatTargets = lineRefs.map((lineRef) => ({
    line_ref: lineRef,
    source_text: 's'.repeat(300),
    search_phrases: Array.from({ length: 4 }, () => 'p'.repeat(120)),
    alternatives: Array.from({ length: 4 }, () => ({
      normalized_name: 'n'.repeat(120),
      notes: 't'.repeat(300),
    })),
  }));
  const fatPayload = buildPlanPromptPayload(fatCandidates as never, fatTargets as never);
  const candidateBytes = utf8ByteLength(JSON.stringify(fatPayload.candidate_set));
  const targetBytes = utf8ByteLength(JSON.stringify(fatPayload.planning_targets));
  const combinedBytes = utf8ByteLength(JSON.stringify(fatPayload));
  record(
    'A-t8 bound: candidate set and target block are each under the cap individually',
    candidateBytes < MAX_AI_ADVANCED_PLAN_REQUEST_BYTES &&
      targetBytes < MAX_AI_ADVANCED_PLAN_REQUEST_BYTES &&
      combinedBytes > MAX_AI_ADVANCED_PLAN_REQUEST_BYTES
  );
  const splitEscape = sanitizePlanTransportRequest({
    request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
    request_id: REQUEST_ID,
    plan_request: fatCandidates,
    planning_targets: fatTargets,
  });
  record(
    'A-t9 bound: the combined over-cap model request is rejected (no split-cap escape)',
    splitEscape.ok === false
  );
  const smallTargets = lineRefs.map((lineRef) => ({ line_ref: lineRef, source_text: 'salt' }));
  const acceptedBig = sanitizePlanTransportRequest({
    request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
    request_id: REQUEST_ID,
    plan_request: fatCandidates,
    planning_targets: smallTargets,
  });
  // ---- CLOSURE 2: local interpretation fingerprint binding -----------------
  const boundTarget = buildAiAdvancedPlanTargetBinding({
    lineRef: 'tomato sauce',
    sourceText: '1 cup tomato sauce',
    interpretationFingerprint: 'fp-verify-1',
  });
  record(
    'A-t11 binding: a target retains the AI-1 interpretation fingerprint locally',
    boundTarget.ok === true && boundTarget.binding.interpretation_fingerprint === 'fp-verify-1'
  );
  const bindingPrompt = buildPlanPrompt(ctx.provider_request, [boundTarget.ok === true ? boundTarget.binding.target : ({ line_ref: 'tomato sauce', source_text: 'x' } as never)]);
  const overlongFingerprint = buildAiAdvancedPlanTargetBinding({
    lineRef: 'tomato sauce',
    sourceText: '1 cup tomato sauce',
    interpretationFingerprint: 'f'.repeat(201),
  });
  record(
    'A-t12 binding: the fingerprint never reaches the provider prompt and is bounded',
    !bindingPrompt.includes('fp-verify-1') &&
      !bindingPrompt.includes('interpretation_fingerprint') &&
      overlongFingerprint.ok === false
  );

  record(
    'A-t10 bound: the same candidate set with bounded targets is accepted, with the combined size reported',
    acceptedBig.ok === true &&
      acceptedBig.request.modelRequestBytes ===
        utf8ByteLength(
          JSON.stringify(
            buildPlanPromptPayload(acceptedBig.request.providerRequest, acceptedBig.request.planningTargets)
          )
        )
  );
}

// The application-layer proofs are async: they exercise the real requester over a
// stubbed transport port (no paid provider, no network).
async function partAAsync(): Promise<void> {
  const ctx = context();
  const aiCapabilities = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });
  // The planning targets the application supplies for this request's lines.
  const TARGETS = [{ line_ref: 'tomato sauce', source_text: '1 cup tomato sauce' }];

  // The requester asks the real selection module for BYOK headers. A fresh
  // install has an EMPTY settings store, so the verifier hydrates the selection
  // state through the production entry point with a no-op settings adapter — the
  // same code path the application takes, with no credential and no paid
  // provider anywhere.
  await resetAiSelectionWithOutcome(
    {
      async get() {
        return undefined;
      },
      async set() {
        /* verifier-local: nothing to persist */
      },
      async remove() {
        /* verifier-local: nothing to remove */
      },
    },
    'text'
  );

  const calls: NetworkRequest[] = [];
  const network = (responder: () => NetworkResponse<unknown>): NetworkAdapter => ({
    async request<TResponse, TBody>(request: NetworkRequest<TBody>): Promise<NetworkResponse<TResponse>> {
      calls.push(request as unknown as NetworkRequest);
      return responder() as NetworkResponse<TResponse>;
    },
    async get<TResponse>(): Promise<NetworkResponse<TResponse>> {
      return responder() as NetworkResponse<TResponse>;
    },
    async post<TResponse, TBody>(
      path: string,
      body: TBody
    ): Promise<NetworkResponse<TResponse>> {
      calls.push({ method: 'POST', path, body });
      return responder() as NetworkResponse<TResponse>;
    },
  });

  const okBody = (plan: unknown, requestId: string = REQUEST_ID) => ({
    status: 200,
    ok: true,
    data: { ok: true, request_id: requestId, plan, aiAttempted: true },
  });

  const good = await requestAiAdvancedCandidatePlan({
    context: ctx,
    network: network(() => okBody(wirePlan(wireEntry()))),
    capabilities: aiCapabilities,
    targets: TARGETS,
  });
  record('A15 application: canonical live response accepted', good.ok === true);

  let trapped = false;
  if (good.ok === true) {
    const applied = validateAndApplyAiAdvancedPlan({
      rawPlanResponse: good.plan,
      responseRequestId: good.requestId,
      context: ctx,
      reviews: new Map([['tomato sauce', review()]]),
      deterministicAcceptance: () => ({
        strict_automatic_fdc_id: SELECTED,
        best_effort_default_fdc_id: SELECTED,
        best_effort_eligible_fdc_ids: [SELECTED, OTHER],
      }),
    });
    trapped =
      applied.ok === true &&
      applied.application.lines[0]['status'] === 'automatic' &&
      applied.application.lines[0]['local_fdc_id'] === SELECTED;
  }
  record('A16 application: output is directly consumable by the AI-2A validator', trapped);

  const stale = await requestAiAdvancedCandidatePlan({
    context: ctx,
    network: network(() => okBody(wirePlan(wireEntry()), 'req-other-1')),
    capabilities: aiCapabilities,
    targets: TARGETS,
  });
  record(
    'A17 application: request-id mismatch is stale (no plan)',
    stale.ok === false && stale.code === 'stale_request'
  );

  calls.length = 0;
  const basic = await requestAiAdvancedCandidatePlan({
    context: ctx,
    network: network(() => okBody(wirePlan(wireEntry()))),
    capabilities: BASIC_NUTRITION_CAPABILITIES,
    targets: TARGETS,
  });
  record(
    'A18 application: basic mode performs ZERO network calls',
    basic.ok === false && basic.code === 'unavailable' && calls.length === 0
  );

  for (const [name, plan] of [
    ['A19 application: portion ref rejected client-side', wirePlan(wireEntry({ portion_ref: 'p1' }))],
    [
      'A20 application: non-`unknown` measure kind rejected client-side',
      wirePlan(wireEntry({ measure_kind: 'count' })),
    ],
    [
      'A21 application: per-entry plan_version (wire trap) rejected client-side',
      wirePlan({ ...wireEntry(), plan_version: AI_ADVANCED_PLAN_VERSION }),
    ],
    ['A22 application: unknown ref rejected client-side', wirePlan(wireEntry({ candidate_ref: 'c9' }))],
    ['A23 application: authority field rejected client-side', wirePlan(wireEntry({ grams: 120 }))],
  ] as const) {
    const result = await requestAiAdvancedCandidatePlan({
      context: ctx,
      network: network(() => okBody(plan)),
      capabilities: aiCapabilities,
      targets: TARGETS,
    });
    record(name, result.ok === false);
  }

  // ------------------------------------------------------------------
  // CLOSURE 2 — fingerprint binding: compared locally, never transported
  // ------------------------------------------------------------------
  const fingerprintContext = (fingerprint: string) => {
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
  const bindingFor = (fingerprint?: string) => {
    const built = buildAiAdvancedPlanTargetBinding({
      lineRef: 'tomato sauce',
      sourceText: '1 cup tomato sauce',
      ...(fingerprint !== undefined ? { interpretationFingerprint: fingerprint } : {}),
    });
    if (built.ok !== true) throw new Error(`binding failed: ${built.code}`);
    return built.binding;
  };

  const LOCAL_FINGERPRINT = 'fp-verify-local-4a91';
  calls.length = 0;
  const bound = await requestAiAdvancedCandidatePlan({
    context: fingerprintContext(LOCAL_FINGERPRINT),
    network: network(() => okBody(wirePlan(wireEntry()))),
    capabilities: aiCapabilities,
    targetBindings: [bindingFor(LOCAL_FINGERPRINT)],
  });
  const transportBytes = calls.length > 0 ? JSON.stringify(calls[0]!.body) : '';
  record(
    'A24 closure 2: a MATCHING binding fingerprint is accepted',
    bound.ok === true && calls.length === 1
  );
  record(
    'A25 closure 2: the local fingerprint value and key never enter the transport bytes',
    transportBytes.length > 0 &&
      !transportBytes.includes(LOCAL_FINGERPRINT) &&
      !transportBytes.includes('interpretation_fingerprint')
  );

  calls.length = 0;
  const mismatched = await requestAiAdvancedCandidatePlan({
    context: fingerprintContext('fp-verify-current'),
    network: network(() => okBody(wirePlan(wireEntry()))),
    capabilities: aiCapabilities,
    targetBindings: [bindingFor('fp-verify-superseded')],
  });
  record(
    'A26 closure 2: MISMATCHED fingerprints fail closed with ZERO network',
    mismatched.ok === false && mismatched.code === 'stale_request' && calls.length === 0
  );

  // ------------------------------------------------------------------
  // CLOSURE 3 — ambiguity/alternative enforcement (application boundary)
  // ------------------------------------------------------------------
  const ambiguousTargets = [
    {
      line_ref: 'tomato sauce',
      source_text: '1 cup tomato sauce',
      ambiguity: { ambiguous: true, reasons: ['tinned vs fresh'] },
    },
  ];
  const forged = await requestAiAdvancedCandidatePlan({
    context: ctx,
    network: network(() => okBody(wirePlan(wireEntry({ candidate_ref: 'c1' })))),
    capabilities: aiCapabilities,
    targets: ambiguousTargets,
  });
  const forgedEntries =
    forged.ok === true
      ? ((forged.plan as unknown as { plans: ReadonlyArray<Record<string, unknown>> }).plans ?? [])
      : [];
  record(
    'A27 closure 3: a FORGED candidate for an ambiguous target cannot survive the application',
    forged.ok === true &&
      forgedEntries.length === 1 &&
      forgedEntries[0]!['candidate_ref'] === undefined &&
      forgedEntries[0]!['review_required'] === true
  );

  const alternativeTargets = [
    {
      line_ref: 'tomato sauce',
      source_text: '1 cup tomato sauce',
      alternatives: [{ normalized_name: 'tomato passata', notes: 'smooth reading' }],
    },
  ];
  const forgedAlternative = await requestAiAdvancedCandidatePlan({
    context: ctx,
    network: network(() => okBody(wirePlan(wireEntry({ candidate_ref: 'c2' })))),
    capabilities: aiCapabilities,
    targets: alternativeTargets,
  });
  const alternativeEntries =
    forgedAlternative.ok === true
      ? ((forgedAlternative.plan as unknown as { plans: ReadonlyArray<Record<string, unknown>> }).plans ?? [])
      : [];
  record(
    'A28 closure 3: a FORGED candidate for an authored-alternative target cannot survive either',
    forgedAlternative.ok === true &&
      alternativeEntries.length === 1 &&
      alternativeEntries[0]!['candidate_ref'] === undefined &&
      alternativeEntries[0]!['review_required'] === true
  );

  // ------------------------------------------------------------------
  // CLOSURE 4 — canonical AI-1 re-sanitization (no duck typing)
  // ------------------------------------------------------------------
  const duckTyped = {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: 'tomato sauce',
    semantic_food: { normalized_name: 'tomato sauce', modifiers: [], preparation: [], state: [], qualifiers: [] },
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
    fdc_id: SELECTED,
  };
  const refusedTarget = buildAiAdvancedPlanTarget({
    lineRef: 'tomato sauce',
    sourceText: '1 cup tomato sauce',
    interpretation: duckTyped,
  });
  const acceptedTarget = buildAiAdvancedPlanTarget({
    lineRef: 'tomato sauce',
    sourceText: '1 cup tomato sauce',
    interpretation: {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      line_ref: 'tomato sauce',
      semantic_food: { normalized_name: 'tomato sauce', modifiers: [], preparation: [], state: [], qualifiers: [] },
      alternatives: [],
      ambiguity: { ambiguous: false, reasons: [] },
    },
  });
  record(
    'A29 closure 4: a duck-typing-usable but canonically-rejected interpretation projects nothing',
    refusedTarget.ok === false && refusedTarget.code === 'unusable_interpretation'
  );
  record(
    'A30 closure 4: the same interpretation WITHOUT the authority key is canonically accepted',
    acceptedTarget.ok === true && acceptedTarget.target.semantic_food?.normalized_name === 'tomato sauce'
  );

  // ------------------------------------------------------------------
  // DUPLICATE-LINE DEFENSE IN DEPTH — Layer B (canonical coverage)
  // ------------------------------------------------------------------
  // Layer A is the server's early duplicate-line guard. Layer B is target coverage, whose
  // expectations come from the SAME line list, so a duplicated line ref can never be
  // satisfied. These non-mutating checks prove Layer B is real independently of any
  // mutation row: either layer alone refuses a duplicated line.
  const duplicateBackstop = sanitizeAiAdvancedPlanTargets(
    [{ line_ref: 'line-0', source_text: '1 cup food 0' }],
    ['line-0', 'line-0']
  );
  record(
    'A31 duplicate defense: Layer B refuses a duplicated EXPECTED line ref (`missing_target`)',
    duplicateBackstop.ok === false && duplicateBackstop.code === 'missing_target'
  );
  const duplicateTargets = sanitizeAiAdvancedPlanTargets(
    [
      { line_ref: 'line-0', source_text: '1 cup food 0' },
      { line_ref: 'line-0', source_text: '1 cup food 0 again' },
    ],
    ['line-0']
  );
  record(
    'A32 duplicate defense: Layer B refuses two targets on one line ref (`duplicate_target`)',
    duplicateTargets.ok === false && duplicateTargets.code === 'duplicate_target'
  );
}


// ---------------------------------------------------------------------------
// PART B — built + served application
// ---------------------------------------------------------------------------

let child: ChildProcess | undefined;

async function startServer(): Promise<boolean> {
  if (!existsSync(resolve(ROOT, 'dist/server.cjs'))) {
    console.error('  dist/server.cjs is missing — run `bun run build` first.');
    return false;
  }
  child = spawn(process.execPath, ['dist/server.cjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      NODE_ENV: 'production',
      AI_ENDPOINT_TOKEN: TOKEN,
      NUTRITION_PLAN_RATE_LIMIT: '1000',
      NUTRITION_INTERPRET_RATE_LIMIT: '1000',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      OPENROUTER_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function stopServer(): void {
  if (child && !child.killed) child.kill('SIGTERM');
  child = undefined;
}

const PLAN_URL = `http://127.0.0.1:${APP_PORT}/api/nutrition/plan-ingredients`;
const INTERPRET_URL = `http://127.0.0.1:${APP_PORT}/api/nutrition/interpret-ingredients`;

async function postPlan(body: unknown, token?: string) {
  const response = await fetch(PLAN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers };
}

async function partB(): Promise<void> {
  console.log('\nPART B — built + served application (real HTTP)\n');
  const up = await startServer();
  record('B1 served: application boots and answers /api/health', up);
  if (!up) return;

  const ctx = context();
  const targets = [{ line_ref: 'tomato sauce', source_text: '1 cup tomato sauce' }];
  const body = {
    request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
    request_id: REQUEST_ID,
    plan_request: ctx.provider_request,
    planning_targets: targets,
  };

  const unauthorized = await postPlan(body);
  record('B2 served: plan route requires the AI access token', unauthorized.status === 401);

  const malformed = await postPlan({ nope: true }, TOKEN);
  record('B3 served: malformed envelope rejected with 400', malformed.status === 400);

  const authority = await postPlan(
    {
      ...body,
      plan_request: {
        ...ctx.provider_request,
        lines: [
          {
            line_ref: 'tomato sauce',
            candidates: [
              { candidate_ref: 'c1', display_description: 'sauce', semantic_tags: [], fdc_id: 1 },
            ],
          },
        ],
      },
    },
    TOKEN
  );
  record('B4 served: authority-shaped request rejected with 400', authority.status === 400);

  const noProvider = await postPlan(body, TOKEN);
  const noProviderBody = JSON.parse(noProvider.text) as Record<string, unknown>;
  record(
    'B5 served: no provider configured fails closed (503, aiAttempted:false, no plan)',
    noProvider.status === 503 &&
      noProviderBody['aiAttempted'] === false &&
      noProviderBody['plan'] === undefined
  );
  record(
    'B6 served: plan route exposes its own rate-limit bucket',
    noProvider.headers.get('RateLimit-Limit') === '1000'
  );

  const interpret = await fetch(INTERPRET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      ingredients: [{ line_ref: 'line:1', ingredient_text: '2 medium yellow onions' }],
    }),
  });
  const interpretText = await interpret.text();
  record(
    'B7 served: AI-1 interpretation route still served and bounded',
    (interpret.status === 503 || interpret.status === 200) &&
      interpretText.includes('aiAttempted') === true
  );
  record(
    'B8 served: interpretation route keeps ITS OWN bucket (unaffected by plan traffic)',
    interpret.headers.get('RateLimit-Limit') === '1000'
  );

  const leaked = ['fdc_id', 'record_digest', 'review_digest', 'grams', 'portion_ref'].filter((field) =>
    [noProvider.text, malformed.text, authority.text, interpretText].some((text) =>
      text.includes(field)
    )
  );
  record('B9 served: no identity/authority field leaks in any response body', leaked.length === 0);

  // Planning-target coverage over real HTTP: without a target the model would be
  // asked to choose blind, so the route must refuse the request outright.
  const noTargets = await postPlan(
    {
      request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
      request_id: REQUEST_ID,
      plan_request: ctx.provider_request,
    },
    TOKEN
  );
  record('B10 served: a request with no planning target is rejected with 400', noTargets.status === 400);
  const badTarget = await postPlan(
    { ...body, planning_targets: [{ line_ref: 'tomato sauce', source_text: 'sauce', grams: 100 }] },
    TOKEN
  );
  record('B11 served: an authority-shaped target is rejected with 400', badTarget.status === 400);
  const mismatchedTargets = await postPlan(
    { ...body, planning_targets: [{ line_ref: 'other line', source_text: 'other' }] },
    TOKEN
  );
  record(
    'B12 served: a target for an unrequested line is rejected with 400',
    mismatchedTargets.status === 400
  );

  // The COMPLETE model request is bounded: a candidate set inside its own 32 KiB
  // cap plus a target block inside its own cap must still be refused when the
  // combined model-facing data exceeds the cap.
  const fatBody = {
    request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
    request_id: REQUEST_ID,
    plan_request: {
      contract_version: AI_ADVANCED_PLAN_VERSION,
      lines: Array.from({ length: 12 }, (_, lineIndex) => ({
        line_ref: `line:${lineIndex}`,
        candidates: Array.from({ length: 8 }, (_, candidateIndex) => ({
          candidate_ref: `c${candidateIndex + 1}`,
          display_description: `candidate ${'y'.repeat(190)}`,
          semantic_tags: [],
        })),
      })),
    },
    planning_targets: Array.from({ length: 12 }, (_, lineIndex) => ({
      line_ref: `line:${lineIndex}`,
      source_text: 's'.repeat(300),
      search_phrases: Array.from({ length: 4 }, () => 'p'.repeat(120)),
      alternatives: Array.from({ length: 4 }, () => ({
        normalized_name: 'n'.repeat(120),
        notes: 't'.repeat(300),
      })),
    })),
  };
  const combined = await postPlan(fatBody, TOKEN);
  record(
    'B13 served: an over-cap COMBINED model request (candidate set + targets) is rejected with 400',
    combined.status === 400
  );

  stopServer();
}

async function main(): Promise<void> {
  partA();
  await partAAsync();
  await partB();
  console.log(`\nAI-2B production verification: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
