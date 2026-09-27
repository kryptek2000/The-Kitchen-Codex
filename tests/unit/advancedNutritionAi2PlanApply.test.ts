/**
 * The Kitchen Codex — AI-2A deterministic plan validator (auto/offer/review).
 *
 * Proves the authoritative rules of the slice:
 *   - a plan is discarded WHOLE on request-identity, namespace or sanitizer
 *     failure, and PER LINE on any staleness/binding failure;
 *   - `automatic` is returned ONLY where the existing deterministic rule already
 *     auto-accepts the SAME candidate;
 *   - AI confidence is SUBTRACTIVE ONLY (medium/low force an offer; high never
 *     promotes); `review_required`, ambiguity and `review_suggested` force an
 *     offer (anti-laundering);
 *   - portion refs and provider-authored authority fail closed;
 *   - `measure_kind` is advisory and changes nothing.
 */

import { describe, it, expect } from 'vitest';

import {
  AI_ADVANCED_PLAN_APPLY_VERSION,
  validateAndApplyAiAdvancedPlan,
} from '../../src/core/nutritionV2/aiAdvancedPlanApply';
import { buildAiAdvancedPlanLineSource } from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import {
  buildAiAdvancedPlanRequestContext,
  type AiAdvancedPlanRequestContext,
} from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import { AI_ADVANCED_PLAN_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlan';
import {
  isDeterministicBestEffortSelection,
  selectAutomaticMatch,
  selectBestEffortMatch,
} from '../../src/core/nutritionV2/matching/confidence';

/**
 * The Phase 4 boundary port (see AI-2C). Tests inject the genuine predicates;
 * AI-2A itself stays out of Phase 2 to respect the audited matching isolation
 * rule, and without this port it can never grant `automatic`.
 */
function deterministicAcceptance(review: unknown) {
  const strict = selectAutomaticMatch(review as never);
  const bestEffortDefault = selectBestEffortMatch(review as never);
  // The FULL eligible family (every safe same-family sibling), not just the
  // default: `isDeterministicBestEffortSelection` is the existing predicate.
  const candidates =
    (review as { candidates?: ReadonlyArray<{ fdc_id: number }> } | undefined)?.candidates ?? [];
  const eligible = candidates
    .filter((candidate) => isDeterministicBestEffortSelection(review as never, candidate.fdc_id))
    .map((candidate) => candidate.fdc_id);
  return Object.freeze({
    ...(strict !== undefined ? { strict_automatic_fdc_id: strict.fdc_id } : {}),
    ...(bestEffortDefault !== undefined
      ? { best_effort_default_fdc_id: bestEffortDefault.fdc_id }
      : {}),
    best_effort_eligible_fdc_ids: eligible,
  });
}

function apply(
  input: Omit<Parameters<typeof validateAndApplyAiAdvancedPlan>[0], 'deterministicAcceptance'>
) {
  return validateAndApplyAiAdvancedPlan({ ...input, deterministicAcceptance });
}

const SELECTED = 170054;
const OTHER = 170501;

function candidate(fdcId: number, description: string, recordDigest = `digest-${fdcId}`) {
  return {
    fdc_id: fdcId,
    data_type: 'sr_legacy_food',
    description,
    normalized_description: description.toLowerCase(),
    record_digest: recordDigest,
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

function exactReview(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

const REQUEST_ID = 'req-ai2a-1';

function contextFor(input: {
  readonly reviews: ReadonlyArray<[{ lineRef: string; review: unknown }] | unknown>;
}): AiAdvancedPlanRequestContext {
  const sources = (input.reviews as ReadonlyArray<{ lineRef: string; review: unknown }>).map((entry) => {
    const built = buildAiAdvancedPlanLineSource({ lineRef: entry.lineRef, review: entry.review });
    if (built.ok !== true) throw new Error(`source failed: ${built.code}`);
    return built.source;
  });
  const context = buildAiAdvancedPlanRequestContext({ requestId: REQUEST_ID, lines: sources });
  if (context.ok !== true) throw new Error(`context failed: ${context.code}`);
  return context.context;
}

function planFor(lineRef: string, overrides: Record<string, unknown> = {}) {
  // NOTE: `plan_version` belongs to the ENVELOPE only; an entry carrying it is an
  // unknown entry key and is rejected wholesale by the frozen sanitizer.
  return {
    line_ref: lineRef,
    candidate_ref: 'c1',
    measure_kind: 'source_portion',
    review_required: false,
    ambiguity_reasons: [],
    confidence: 'high',
    ...overrides,
  };
}

function envelope(...plans: ReadonlyArray<Record<string, unknown>>) {
  return { plan_version: AI_ADVANCED_PLAN_VERSION, plans };
}

describe('AI-2A plan apply — automatic only where determinism already authorizes', () => {
  it('returns automatic for the SAME candidate the deterministic rule selects', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const result = apply({
      rawPlanResponse: envelope(planFor('tomato sauce')),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.application.apply_version).toBe(AI_ADVANCED_PLAN_APPLY_VERSION);
    expect(result.application.automatic_count).toBe(1);
    expect(result.application.lines[0]).toMatchObject({
      line_ref: 'tomato sauce',
      status: 'automatic',
      reason: 'deterministic_automatic',
      candidate_ref: 'c1',
      local_fdc_id: SELECTED,
      matches_strict_automatic: true,
    });
    expect(Object.isFrozen(result.application)).toBe(true);
    expect(Object.isFrozen(result.application.lines)).toBe(true);
  });

  it('never promotes a candidate the deterministic rule did not select', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const result = apply({
      rawPlanResponse: envelope(planFor('tomato sauce', { candidate_ref: 'c2' })),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.application.lines[0]).toMatchObject({
      status: 'offer',
      reason: 'below_deterministic_threshold',
      local_fdc_id: OTHER,
      matches_strict_automatic: false,
    });
  });

  it('BEST-EFFORT MEMBERSHIP: classification follows the eligible FAMILY, not the default', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    // The port reports the eligible family containing ONLY the sibling c2.
    const result = validateAndApplyAiAdvancedPlan({
      rawPlanResponse: envelope(planFor('tomato sauce', { candidate_ref: 'c2' })),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
      deterministicAcceptance: () => ({ best_effort_eligible_fdc_ids: [OTHER] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.application.lines[0]).toMatchObject({
      status: 'offer',
      reason: 'deterministic_best_effort_only',
      candidate_ref: 'c2',
      local_fdc_id: OTHER,
      matches_strict_automatic: false,
      matches_best_effort_eligible: true,
    });
  });

  it('reports below_deterministic_threshold only when the candidate is in NO set', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    // The port reports the strict selection and an eligible family that both
    // exclude c2: nothing authorizes it and nothing labels it best-effort.
    const result = validateAndApplyAiAdvancedPlan({
      rawPlanResponse: envelope(planFor('tomato sauce', { candidate_ref: 'c2' })),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
      deterministicAcceptance: () => ({
        strict_automatic_fdc_id: SELECTED,
        best_effort_default_fdc_id: SELECTED,
        best_effort_eligible_fdc_ids: [SELECTED],
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.application.lines[0]).toMatchObject({
      status: 'offer',
      reason: 'below_deterministic_threshold',
      candidate_ref: 'c2',
      local_fdc_id: OTHER,
      matches_strict_automatic: false,
      matches_best_effort_eligible: false,
    });
  });

  it('a port reporting ONLY the best-effort default cannot label a non-default sibling', () => {
    // Fail-closed surface: the old single-value shape can never gain authority,
    // and it can only under-label (never mis-label as best-effort).
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const result = validateAndApplyAiAdvancedPlan({
      rawPlanResponse: envelope(planFor('tomato sauce', { candidate_ref: 'c2' })),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
      deterministicAcceptance: () => ({ best_effort_default_fdc_id: OTHER }),
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.application.lines[0]).toMatchObject({
      status: 'offer',
      reason: 'below_deterministic_threshold',
      matches_strict_automatic: false,
      matches_best_effort_eligible: false,
    });
  });

  it('CONFIDENCE IS SUBTRACTIVE ONLY: medium/low force an offer, high never promotes', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const run = (confidence: unknown) =>
      apply({
        rawPlanResponse: envelope(planFor('tomato sauce', confidence === 'omit' ? {} : { confidence })),
        responseRequestId: REQUEST_ID,
        context,
        reviews: new Map([['tomato sauce', review]]),
      });
    for (const confidence of ['medium', 'low']) {
      const result = run(confidence);
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      expect(result.application.lines[0]).toMatchObject({ status: 'offer', reason: 'confidence_not_high' });
    }
    // Abstaining (no confidence field) does not subtract authority either way.
    const abstained = run('omit');
    expect(abstained.ok).toBe(true);
    if (abstained.ok !== true) return;
    expect(abstained.application.lines[0]!.status).toBe('automatic');
  });

  it('ANTI-LAUNDERING: a review_suggested row can never become automatic', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const result = apply({
      rawPlanResponse: envelope(planFor('tomato sauce')),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
      issueKinds: { 'tomato sauce': 'review_suggested' },
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.application.automatic_count).toBe(0);
    expect(result.application.lines[0]).toMatchObject({
      status: 'offer',
      reason: 'review_suggested_issue_kind',
    });
  });

  it('declared review_required and ambiguity force an offer even for an automatic candidate', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const declared = apply({
      rawPlanResponse: envelope(planFor('tomato sauce', { review_required: true })),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
    });
    expect(declared.ok).toBe(true);
    if (declared.ok !== true) return;
    expect(declared.application.lines[0]).toMatchObject({ status: 'offer', reason: 'review_required_declared' });

    const ambiguous = apply({
      rawPlanResponse: envelope(planFor('tomato sauce', { ambiguity_reasons: ['two sauces fit'] })),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
    });
    expect(ambiguous.ok).toBe(true);
    if (ambiguous.ok !== true) return;
    expect(ambiguous.application.lines[0]).toMatchObject({ status: 'offer', reason: 'ambiguity_declared' });
  });

  it('reports review for no plan, no candidate and unusable current reviews', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });

    const empty = apply({
      rawPlanResponse: envelope(),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
    });
    expect(empty.ok).toBe(true);
    if (empty.ok !== true) return;
    expect(empty.application.lines[0]).toMatchObject({ status: 'review', reason: 'no_plan' });
    expect(empty.application.review_count).toBe(1);

    const planWithoutCandidate = planFor('tomato sauce');
    delete (planWithoutCandidate as Record<string, unknown>)['candidate_ref'];
    const noCandidate = apply({
      rawPlanResponse: envelope(planWithoutCandidate),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', review]]),
    });
    expect(noCandidate.ok).toBe(true);
    if (noCandidate.ok !== true) return;
    expect(noCandidate.application.lines[0]).toMatchObject({
      status: 'review',
      reason: 'no_candidate_proposed',
    });

    const unusable = apply({
      rawPlanResponse: envelope(planFor('tomato sauce')),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', exactReview({ outcome: 'unmatched' })]]),
    });
    expect(unusable.ok).toBe(true);
    if (unusable.ok !== true) return;
    expect(unusable.application.lines[0]).toMatchObject({ status: 'review', reason: 'unusable_review' });
  });
});

describe('AI-2A plan apply — whole-response discard and per-line binding', () => {
  it('discards the WHOLE response for a stale/absent request id', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    for (const responseRequestId of ['req-other', undefined, 7, '']) {
      expect(
        apply({
          rawPlanResponse: envelope(planFor('tomato sauce')),
          responseRequestId,
          context,
          reviews: new Map([['tomato sauce', review]]),
        })
      ).toEqual({ ok: false, code: 'stale_request' });
    }
  });

  it('reports review for a stale review digest or a changed interpretation fingerprint', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const staleReview = apply({
      rawPlanResponse: envelope(planFor('tomato sauce')),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([['tomato sauce', exactReview({ review_digest: 'review-digest-2' })]]),
    });
    expect(staleReview.ok).toBe(true);
    if (staleReview.ok !== true) return;
    expect(staleReview.application.lines[0]).toMatchObject({ status: 'review', reason: 'stale_review' });

    const built = buildAiAdvancedPlanLineSource({
      lineRef: 'tomato sauce',
      review,
      interpretationFingerprint: 'fp-1',
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    const context2 = buildAiAdvancedPlanRequestContext({ requestId: REQUEST_ID, lines: [built.source] });
    expect(context2.ok).toBe(true);
    if (context2.ok !== true) return;
    const missingFingerprint = apply({
      rawPlanResponse: envelope(planFor('tomato sauce')),
      responseRequestId: REQUEST_ID,
      context: context2.context,
      reviews: new Map([['tomato sauce', review]]),
    });
    expect(missingFingerprint.ok).toBe(true);
    if (missingFingerprint.ok !== true) return;
    expect(missingFingerprint.application.lines[0]).toMatchObject({
      status: 'review',
      reason: 'stale_interpretation',
    });
    const matching = apply({
      rawPlanResponse: envelope(planFor('tomato sauce')),
      responseRequestId: REQUEST_ID,
      context: context2.context,
      reviews: new Map([['tomato sauce', review]]),
      interpretationFingerprints: { 'tomato sauce': 'fp-1' },
    });
    expect(matching.ok).toBe(true);
    if (matching.ok !== true) return;
    expect(matching.application.lines[0]!.status).toBe('automatic');
  });

  it('reports review when the candidate left the bound review or its digest changed', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });

    const droppedCandidate = apply({
      rawPlanResponse: envelope(planFor('tomato sauce')),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([
        [
          'tomato sauce',
          exactReview({ candidates: [candidate(OTHER, 'Tomatoes, crushed, canned')] }),
        ],
      ]),
    });
    expect(droppedCandidate.ok).toBe(true);
    if (droppedCandidate.ok !== true) return;
    expect(droppedCandidate.application.lines[0]).toMatchObject({
      status: 'review',
      reason: 'candidate_not_in_review',
    });

    const tampered = apply({
      rawPlanResponse: envelope(planFor('tomato sauce')),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([
        [
          'tomato sauce',
          exactReview({
            candidates: [
              candidate(SELECTED, 'Tomato products, canned, sauce', 'tampered-digest'),
              candidate(OTHER, 'Tomatoes, crushed, canned'),
            ],
          }),
        ],
      ]),
    });
    expect(tampered.ok).toBe(true);
    if (tampered.ok !== true) return;
    expect(tampered.application.lines[0]).toMatchObject({
      status: 'review',
      reason: 'record_digest_mismatch',
    });
  });
});

describe('AI-2A plan apply — refs, namespace, portion firewall and authority', () => {
  it('rejects unknown and cross-line candidate refs and duplicate lines', () => {
    const first = exactReview();
    // Line 2 is issued exactly ONE ref (`c1`), while `c2` was issued for line 1.
    const second = exactReview({
      line_ref: 'canned tomatoes',
      review_digest: 'review-digest-2',
      candidates: [candidate(OTHER, 'Tomatoes, crushed, canned')],
    });
    const context = contextFor({
      reviews: [
        { lineRef: 'tomato sauce', review: first },
        { lineRef: 'canned tomatoes', review: second },
      ],
    });
    const reviews = new Map<string, unknown>([
      ['tomato sauce', first],
      ['canned tomatoes', second],
    ]);
    const base = { responseRequestId: REQUEST_ID, context, reviews } as const;

    // `c2` was issued for line 1 but never for line 2.
    expect(
      apply({
        ...base,
        rawPlanResponse: envelope(planFor('canned tomatoes', { candidate_ref: 'c2' })),
      })
    ).toEqual({ ok: false, code: 'unknown_candidate_ref' });
    expect(
      apply({ ...base, rawPlanResponse: envelope(planFor('tomato sauce', { candidate_ref: 'c9' })) })
    ).toEqual({ ok: false, code: 'unknown_candidate_ref' });
    expect(
      apply({
        ...base,
        rawPlanResponse: envelope(planFor('tomato sauce'), planFor('tomato sauce')),
      })
    ).toEqual({ ok: false, code: 'duplicate_line_ref' });
    expect(
      apply({ ...base, rawPlanResponse: envelope(planFor('some other line')) })
    ).toEqual({ ok: false, code: 'unknown_line_ref' });
  });

  it('PORTION FIREWALL: any portion ref fails closed', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    expect(
      apply({
        rawPlanResponse: envelope(planFor('tomato sauce', { portion_ref: 'p1' })),
        responseRequestId: REQUEST_ID,
        context,
        reviews: new Map([['tomato sauce', review]]),
      })
    ).toEqual({ ok: false, code: 'unknown_portion_ref' });
  });

  it('REF NAMESPACE: candidate refs must be c-refs and portion refs must not be', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const run = (plan: Record<string, unknown>) =>
      apply({
        rawPlanResponse: envelope(plan),
        responseRequestId: REQUEST_ID,
        context,
        reviews: new Map([['tomato sauce', review]]),
      });
    expect(run(planFor('tomato sauce', { candidate_ref: 'p1' }))).toEqual({
      ok: false,
      code: 'ref_namespace',
    });
    expect(run(planFor('tomato sauce', { portion_ref: 'c1' }))).toEqual({
      ok: false,
      code: 'ref_namespace',
    });
    expect(run(planFor('tomato sauce', { candidate_ref: 'fdc-170054' }))).toEqual({
      ok: false,
      code: 'ref_namespace',
    });
  });

  it('rejects provider-authored authority, unsupported versions and prototype shapes', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const run = (raw: unknown) =>
      apply({
        rawPlanResponse: raw,
        responseRequestId: REQUEST_ID,
        context,
        reviews: new Map([['tomato sauce', review]]),
      });

    expect(run(envelope(planFor('tomato sauce', { gram_weight: 100 })))).toEqual({
      ok: false,
      code: 'authority_field',
    });
    expect(run(envelope(planFor('tomato sauce', { nutrients: { kcal: 20 } })))).toEqual({
      ok: false,
      code: 'authority_field',
    });
    expect(
      run(envelope(planFor('tomato sauce', { persistence: 'apply_and_save' })))
    ).toMatchObject({ ok: false });
    expect(
      run({ plan_version: 'nutrition_ai_advanced_plan_v2', plans: [planFor('tomato sauce')] })
    ).toEqual({ ok: false, code: 'unsupported_plan_version' });
    expect(run({ plan_version: AI_ADVANCED_PLAN_VERSION, plans: [planFor('tomato sauce')], extra: 1 })).toEqual({
      ok: false,
      code: 'invalid_response',
    });
    class PlanLike {
      plan_version = AI_ADVANCED_PLAN_VERSION;
      plans = [planFor('tomato sauce')];
    }
    expect(run(new PlanLike())).toMatchObject({ ok: false });
  });

  it('measure_kind is ADVISORY ONLY and cannot change the outcome', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    const outcomes = ['source_portion', 'count', 'household', 'mass', 'unknown'].map((measure_kind) => {
      const result = apply({
        rawPlanResponse: envelope(planFor('tomato sauce', { measure_kind })),
        responseRequestId: REQUEST_ID,
        context,
        reviews: new Map([['tomato sauce', review]]),
      });
      expect(result.ok).toBe(true);
      if (result.ok !== true) throw new Error('expected ok');
      return result.application.lines[0]!;
    });
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('automatic');
      expect(outcome.reason).toBe('deterministic_automatic');
    }
    expect(outcomes.map((entry) => entry.advisory_measure_kind)).toEqual([
      'source_portion',
      'count',
      'household',
      'mass',
      'unknown',
    ]);
    // No portion/gram authority is exposed anywhere on the result.
    for (const outcome of outcomes) {
      expect(Object.keys(outcome)).not.toContain('gram_weight');
      expect(Object.keys(outcome)).not.toContain('portion_ref');
      expect(Object.keys(outcome)).not.toContain('gram');
    }
  });

  it('validates its context and review input shapes', () => {
    const review = exactReview();
    const context = contextFor({ reviews: [{ lineRef: 'tomato sauce', review }] });
    expect(
      apply({
        rawPlanResponse: envelope(planFor('tomato sauce')),
        responseRequestId: REQUEST_ID,
        context: null,
        reviews: new Map(),
      })
    ).toEqual({ ok: false, code: 'invalid_context' });
    expect(
      apply({
        rawPlanResponse: envelope(planFor('tomato sauce')),
        responseRequestId: REQUEST_ID,
        context,
        reviews: 42,
      })
    ).toEqual({ ok: false, code: 'invalid_reviews' });
    // NO PORT, NO AUTOMATIC: without the deterministic acceptance port the whole
    // response is discarded, so AI can never grant authority on its own.
    expect(
      validateAndApplyAiAdvancedPlan({
        rawPlanResponse: envelope(planFor('tomato sauce')),
        responseRequestId: REQUEST_ID,
        context,
        reviews: new Map([['tomato sauce', review]]),
      } as never)
    ).toEqual({ ok: false, code: 'invalid_acceptance_port' });
  });
});