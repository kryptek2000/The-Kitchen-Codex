/**
 * The Kitchen Codex — AI-2C (Slice B): pure plan reconciliation.
 *
 * Proves the deterministic bridge's core rules:
 *   - `automatic` is accepted only when it is provable at THIS boundary
 *     (independent port re-check) and the working state is safe to transition;
 *   - `offer`/`review`/abstention never mutate anything;
 *   - AI may spend deterministic authority but never user authority: an existing
 *     match choice (including `kind: 'none'`) or any stored mass source is never
 *     overwritten or cleared;
 *   - mid-flight user action wins, per line, without aborting the rest;
 *   - an identical current selection is `unchanged` (idempotent, no dispatch);
 *   - removed lines are never recreated; cross-line/unknown refs and stale
 *     identity fail closed with the EXISTING closed codes;
 *   - the result is frozen, inert, and carries no portion/gram/nutrient data.
 */

import { describe, it, expect } from 'vitest';

import { reconcileAiAdvancedCandidatePlan } from '../../src/core/nutritionV2/phase4/aiPlanReconcile';
import { deterministicAcceptanceView } from '../../src/core/nutritionV2/phase4/deterministicAcceptanceView';
import { buildAiAdvancedPlanLineSource } from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import { buildAiAdvancedPlanRequestContext } from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import { AI_ADVANCED_PLAN_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlan';
import { createReviewCatalog, reviewIngredient } from '../../src/core/nutritionV2/matching/review';
import type { IngredientReviewResult, ReviewCatalog } from '../../src/core/nutritionV2/matching/types';
import {
  buildMatchingBundle,
  DEFAULT_MATCHING_SPECS,
  type MatchingRecordSpec,
} from '../fixtures/usdaMatchingFixtures';

function makeCatalog(specs: ReadonlyArray<MatchingRecordSpec> = DEFAULT_MATCHING_SPECS): ReviewCatalog {
  const { manifest, records } = buildMatchingBundle(specs);
  const result = createReviewCatalog(manifest, records);
  if (!result.ok) throw new Error('catalog build failed');
  return result.catalog;
}

const CATALOG = makeCatalog();

/** A `review_required` review with a strict automatic candidate (sugar 2001/2002). */
function strictReview(): IngredientReviewResult {
  const result = reviewIngredient(CATALOG, { name: 'Sugar, granulated' });
  expect(result.outcome).toBe('review_required');
  return result;
}

/** A `review_required` review with a best-effort family but NO strict automatic (flour). */
function familyReview(): IngredientReviewResult {
  const result = reviewIngredient(CATALOG, { name: 'flour' });
  expect(result.outcome).toBe('review_required');
  return result;
}

/** Builds a canonical AI-2A request context + the reviews map for one line. */
function requestFor(
  lineRef: string,
  review: IngredientReviewResult,
  options: { readonly interpretationFingerprint?: string } = {}
): { context: unknown; reviews: Map<string, unknown> } {
  const source = buildAiAdvancedPlanLineSource({
    lineRef,
    review,
    ...(options.interpretationFingerprint !== undefined
      ? { interpretationFingerprint: options.interpretationFingerprint }
      : {}),
  });
  if (source.ok !== true) throw new Error(`source build failed: ${source.code}`);
  const context = buildAiAdvancedPlanRequestContext({ requestId: 'req-ai2c-1', lines: [source.source] });
  if (context.ok !== true) throw new Error(`context build failed: ${context.code}`);
  return { context: context.context, reviews: new Map([[lineRef, review]]) };
}

function plan(entry: Record<string, unknown>) {
  return {
    plan_version: AI_ADVANCED_PLAN_VERSION,
    plans: [
      {
        measure_kind: 'unknown',
        review_required: false,
        ambiguity_reasons: [],
        ...entry,
      },
    ],
  };
}

function call(input: Record<string, unknown>) {
  return reconcileAiAdvancedCandidatePlan(input as never);
}

// ---------------------------------------------------------------------------
// Automatic acceptance
// ---------------------------------------------------------------------------

describe('aiPlanReconcile — strict automatic acceptance', () => {
  it('accepts a strict automatic recommendation when the working state is untouched', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      currentLineRefs: ['sugar'],
      workingState: { matches: {}, portions: {}, countPortions: {}, userMasses: {}, householdPortions: {} },
      captured: { fingerprints: new Map([['sugar', 'fp-1']]), matches: {}, massSourceLineRefs: [] },
      currentFingerprints: new Map([['sugar', 'fp-1']]),
    });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.reconciliation.accepted_count).toBe(1);
    const accepted = result.reconciliation.accepted[0];
    const resolved = (context as { line(ref: string): { candidate_set: { resolve(ref: string): { fdc_id: number } | undefined } } | undefined })
      .line('sugar')
      ?.candidate_set.resolve('c1');
    expect(accepted.fdc_id).toBe(resolved?.fdc_id);
    expect(accepted.reason).toBe('deterministic_automatic');
    expect(accepted.review_digest).toBe(review.review_digest);
    // The working-state descriptor carries the honest provenance markers.
    expect(accepted.choice).toEqual({
      kind: 'candidate',
      fdc_id: accepted.fdc_id,
      review_digest: review.review_digest,
      automatic: true,
      aiAssisted: true,
      aiAccepted: true,
    });
    // The confirmation is the EXISTING Phase-2 selection shape (no extra keys).
    expect(accepted.confirmation).toEqual({
      kind: 'candidate',
      fdc_id: accepted.fdc_id,
      review_digest: review.review_digest,
    });
    // No portion/gram/nutrient data anywhere in the result.
    const serialized = JSON.stringify(result.reconciliation);
    for (const forbidden of ['portion_index', 'grams', 'nutrient', 'density', 'serving_weight', 'codex_nutrition']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('does NOT create any portion choice when a candidate is accepted', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      workingState: {},
      captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
      currentFingerprints: new Map([['sugar', 'fp-1']]),
    });
    if (result.ok !== true) throw new Error('expected ok');
    const accepted = result.reconciliation.accepted[0];
    for (const key of Object.keys(accepted.choice as unknown as Record<string, unknown>)) {
      expect(['kind', 'fdc_id', 'review_digest', 'automatic', 'aiAssisted', 'aiAccepted']).toContain(key);
    }
    expect(Object.keys(accepted.confirmation as Record<string, unknown>).sort()).toEqual([
      'fdc_id',
      'kind',
      'review_digest',
    ]);
    // The accepted ENTRY carries identity + binding only. Any portion/mass/gram
    // authority smuggled anywhere into the result fails here (the bridge is not a
    // mass authority): scan the WHOLE serialized reconciliation.
    expect(Object.keys(accepted as unknown as Record<string, unknown>).sort()).toEqual([
      'candidate_ref',
      'choice',
      'confirmation',
      'fdc_id',
      'line_ref',
      'reason',
      'review_digest',
    ]);
    const serialized = JSON.stringify(result.reconciliation);
    for (const forbidden of [
      'gram',
      'grams',
      'nutrient',
      'calorie',
      'protein_g',
      'portion_ref',
      'portion_index',
      'source_portion',
      'count_portion',
      'user_mass',
      'household_portion',
      'density',
      'serving_weight',
    ]) {
      expect({ forbidden, present: serialized.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  it('is NOT accepted when the acceptance port names a different candidate', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const mismatchingPort = () => ({ strict_automatic_fdc_id: 424242 });
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: mismatchingPort,
      workingState: {},
      captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
      currentFingerprints: new Map([['sugar', 'fp-1']]),
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    // AI-2A correctly refuses to call it automatic without the port's agreement.
    expect(result.reconciliation.classification.lines[0].status).not.toBe('automatic');
  });

  it('discards the whole plan when the port is missing (existing closed code)', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: 'not-a-function',
    });
    expect(result).toEqual({ ok: false, code: 'invalid_acceptance_port' });
  });

  it('is idempotent: an identical current selection is unchanged, not re-accepted', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const fdcId = (review.candidates as ReadonlyArray<{ fdc_id: number }>)[0].fdc_id;
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
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
      captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
      currentFingerprints: new Map([['sugar', 'fp-1']]),
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.unchanged).toEqual(['sugar']);
  });
});

// ---------------------------------------------------------------------------
// Offer / review / abstention never mutate
// ---------------------------------------------------------------------------

describe('aiPlanReconcile — offer/review/abstention stay non-mutating', () => {
  it('keeps a best-effort (OFFER) recommendation as an offer, never a mutation', () => {
    const review = familyReview();
    const { context, reviews } = requestFor('flour', review);
    const result = call({
      plan: plan({ line_ref: 'flour', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      workingState: {},
      captured: { fingerprints: new Map([['flour', 'fp-1']]) },
      currentFingerprints: new Map([['flour', 'fp-1']]),
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.offer_count).toBe(1);
    const offer = result.reconciliation.offers[0];
    expect(offer.reason).toBe('deterministic_best_effort_only');
    // An offer carries NO acceptance marker: "Use this match" must stay a genuine
    // user confirmation.
    expect(offer.choice.aiAccepted).toBeUndefined();
    expect(offer.choice.automatic).toBeUndefined();
    expect(offer.choice.aiAssisted).toBe(true);
  });

  it('cannot launder a `review_suggested` line into an automatic acceptance', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      issueKinds: { sugar: 'review_suggested' },
      workingState: {},
      captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
      currentFingerprints: new Map([['sugar', 'fp-1']]),
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.offers[0].reason).toBe('review_suggested_issue_kind');
  });

  it('cannot launder a declared review requirement into an automatic acceptance', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1', review_required: true }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      workingState: {},
      captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
      currentFingerprints: new Map([['sugar', 'fp-1']]),
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.offers[0].reason).toBe('review_required_declared');
  });

  it('preserves abstention (no candidate proposed) with no mutation', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      workingState: {},
      captured: { fingerprints: new Map([['sugar', 'fp-1']]) },
      currentFingerprints: new Map([['sugar', 'fp-1']]),
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.offer_count).toBe(0);
    expect(result.reconciliation.preserved).toEqual([{ line_ref: 'sugar', reason: 'no_candidate_proposed' }]);
  });

  it('never recreates a line that no longer exists', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      currentLineRefs: ['another-line'],
      workingState: {},
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.offers).toEqual([]);
    expect(result.reconciliation.preserved).toEqual([{ line_ref: 'sugar', reason: 'line_missing' }]);
  });
});

// ---------------------------------------------------------------------------
// Identity / binding failures (existing closed codes)
// ---------------------------------------------------------------------------

describe('aiPlanReconcile — stale or foreign identity fails closed', () => {
  it('discards a plan answering a different request', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-other',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
    });
    expect(result).toEqual({ ok: false, code: 'stale_request' });
  });

  it('rejects an unknown candidate ref for the line (whole plan, existing code)', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c9' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown line ref (whole plan, existing code)', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review);
    const result = call({
      plan: plan({ line_ref: 'not-a-line', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
    });
    expect(result.ok).toBe(false);
  });

  it('preserves the line when the current review digest no longer matches', () => {
    const review = strictReview();
    const { context } = requestFor('sugar', review);
    const staleReview = { ...(review as unknown as Record<string, unknown>), review_digest: 'a'.repeat(64) };
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews: new Map([['sugar', staleReview]]),
      deterministicAcceptance: deterministicAcceptanceView,
      workingState: {},
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.preserved).toEqual([{ line_ref: 'sugar', reason: 'stale_review' }]);
  });

  it('preserves the line when the interpretation fingerprint no longer matches', () => {
    const review = strictReview();
    const { context, reviews } = requestFor('sugar', review, { interpretationFingerprint: 'fp-ai1-bound' });
    const result = call({
      plan: plan({ line_ref: 'sugar', candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      interpretationFingerprints: { sugar: 'fp-ai1-different' },
      workingState: {},
    });
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.preserved).toEqual([{ line_ref: 'sugar', reason: 'stale_interpretation' }]);
  });
});

// ---------------------------------------------------------------------------
// User authority is never spent
// ---------------------------------------------------------------------------

describe('aiPlanReconcile — user/working authority is never overwritten', () => {
  function stateFor(lineRef: string, overrides: Record<string, unknown>) {
    return {
      plan: plan({ line_ref: lineRef, candidate_ref: 'c1' }),
      responseRequestId: 'req-ai2c-1',
      requestContext: requestFor(lineRef, strictReview()).context,
      reviews: new Map([[lineRef, strictReview()]]),
      deterministicAcceptance: deterministicAcceptanceView,
      currentLineRefs: [lineRef],
      captured: { fingerprints: new Map([[lineRef, 'fp-1']]), matches: {}, massSourceLineRefs: [] },
      currentFingerprints: new Map([[lineRef, 'fp-1']]),
      ...overrides,
    };
  }

  it('skips a line the user acted on during the flight (fingerprint changed)', () => {
    const result = call(
      stateFor('sugar', { currentFingerprints: new Map([['sugar', 'fp-2']]) })
    );
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.offers).toEqual([]);
    expect(result.reconciliation.conflicts).toEqual([
      { line_ref: 'sugar', kind: 'fingerprint_changed', reason: 'deterministic_automatic' },
    ]);
  });

  it('refuses to touch a line it could not fingerprint at request start', () => {
    const result = call(
      stateFor('sugar', { captured: { fingerprints: new Map(), matches: {}, massSourceLineRefs: [] } })
    );
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.conflicts).toEqual([
      { line_ref: 'sugar', kind: 'no_capture', reason: 'deterministic_automatic' },
    ]);
  });

  it('never overwrites a pre-existing explicit match decision', () => {
    const review = strictReview();
    const result = call(
      stateFor('sugar', {
        workingState: {
          matches: {
            sugar: { kind: 'candidate', fdc_id: 2002, review_digest: review.review_digest },
          },
        },
      })
    );
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.conflicts[0].kind).toBe('pre_existing_match');
  });

  it('never overwrites a pre-existing `kind: none` decision', () => {
    const review = strictReview();
    const result = call(
      stateFor('sugar', {
        workingState: { matches: { sugar: { kind: 'none', review_digest: review.review_digest } } },
      })
    );
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.conflicts[0].kind).toBe('pre_existing_match');
  });

  it('never overwrites a match decision that existed when the request started', () => {
    const review = strictReview();
    const result = call(
      stateFor('sugar', {
        workingState: { matches: {} },
        captured: {
          fingerprints: new Map([['sugar', 'fp-1']]),
          matches: { sugar: { kind: 'none', review_digest: review.review_digest } },
          massSourceLineRefs: [],
        },
      })
    );
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.conflicts[0].kind).toBe('pre_existing_match');
  });

  const massSources: ReadonlyArray<[string, string]> = [
    ['source portion', 'portions'],
    ['count portion', 'countPortions'],
    ['user mass', 'userMasses'],
    ['household portion', 'householdPortions'],
  ];

  for (const [label, key] of massSources) {
    it(`forbids automatic acceptance over a pre-existing ${label}`, () => {
      const result = call(
        stateFor('sugar', {
          workingState: { [key]: { sugar: { kind: 'candidate', fdc_id: 2002 } } },
        })
      );
      if (result.ok !== true) throw new Error('expected ok');
      expect(result.reconciliation.accepted_count, label).toBe(0);
      expect(result.reconciliation.conflicts[0].kind, label).toBe('pre_existing_mass_source');
    });
  }

  it('forbids automatic acceptance over a mass source captured at request start', () => {
    const result = call(
      stateFor('sugar', {
        captured: {
          fingerprints: new Map([['sugar', 'fp-1']]),
          matches: {},
          massSourceLineRefs: ['sugar'],
        },
      })
    );
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted_count).toBe(0);
    expect(result.reconciliation.conflicts[0].kind).toBe('pre_existing_mass_source');
  });
});

// ---------------------------------------------------------------------------
// Mixed result + purity
// ---------------------------------------------------------------------------

describe('aiPlanReconcile — mixed multi-line result', () => {
  it('reconciles an automatic, an offer, a review and a conflict in ONE plan', () => {
    const sugar = strictReview();
    const flour = familyReview();

    const sugarSource = buildAiAdvancedPlanLineSource({ lineRef: 'sugar', review: sugar });
    const flourSource = buildAiAdvancedPlanLineSource({ lineRef: 'flour', review: flour });
    if (sugarSource.ok !== true || flourSource.ok !== true) throw new Error('source build failed');
    const context = buildAiAdvancedPlanRequestContext({
      requestId: 'req-ai2c-mixed',
      lines: [sugarSource.source, flourSource.source],
    });
    if (context.ok !== true) throw new Error('context build failed');

    const result = call({
      plan: {
        plan_version: AI_ADVANCED_PLAN_VERSION,
        plans: [
          { line_ref: 'sugar', candidate_ref: 'c1', measure_kind: 'unknown', review_required: false, ambiguity_reasons: [] },
          { line_ref: 'flour', candidate_ref: 'c1', measure_kind: 'unknown', review_required: false, ambiguity_reasons: [] },
        ],
      },
      responseRequestId: 'req-ai2c-mixed',
      requestContext: context.context,
      reviews: new Map<string, unknown>([
        ['sugar', sugar],
        ['flour', flour],
      ]),
      deterministicAcceptance: deterministicAcceptanceView,
      currentLineRefs: ['sugar', 'flour', 'salt'],
      workingState: {
        matches: {},
        portions: {},
        countPortions: {},
        userMasses: {},
        householdPortions: {},
      },
      captured: {
        fingerprints: new Map([
          ['sugar', 'fp-sugar'],
          ['flour', 'fp-flour-changed'],
        ]),
        matches: {},
        massSourceLineRefs: [],
      },
      currentFingerprints: new Map([
        ['sugar', 'fp-sugar'],
        // The user edited the flour line while the plan was in flight.
        ['flour', 'fp-flour-now-different'],
      ]),
    });

    if (result.ok !== true) throw new Error('expected ok');
    expect(result.reconciliation.accepted.map((entry) => entry.line_ref)).toEqual(['sugar']);
    expect(result.reconciliation.offers).toEqual([]);
    expect(result.reconciliation.conflicts.map((entry) => [entry.line_ref, entry.kind])).toEqual([
      ['flour', 'fingerprint_changed'],
    ]);
    expect(result.reconciliation.preserved).toEqual([]);
    // The classification record is the frozen AI-2A one (never re-derived).
    expect(result.reconciliation.classification.automatic_count).toBe(1);
    expect(result.reconciliation.classification.offer_count).toBe(1);
    expect(Object.isFrozen(result.reconciliation)).toBe(true);
    expect(Object.isFrozen(result.reconciliation.accepted)).toBe(true);
  });

  it('accepts a line while a second automatic line with user state is left untouched', () => {
    const sugar = strictReview();
    const sugarWithMass = strictReview();
    const firstSource = buildAiAdvancedPlanLineSource({ lineRef: 'sugar', review: sugar });
    const secondSource = buildAiAdvancedPlanLineSource({ lineRef: 'sugar-mass', review: sugarWithMass });
    if (firstSource.ok !== true || secondSource.ok !== true) throw new Error('source build failed');
    const context = buildAiAdvancedPlanRequestContext({
      requestId: 'req-ai2c-partial',
      lines: [firstSource.source, secondSource.source],
    });
    if (context.ok !== true) throw new Error('context build failed');

    const result = call({
      plan: {
        plan_version: AI_ADVANCED_PLAN_VERSION,
        plans: [
          { line_ref: 'sugar', candidate_ref: 'c1', measure_kind: 'unknown', review_required: false, ambiguity_reasons: [] },
          { line_ref: 'sugar-mass', candidate_ref: 'c1', measure_kind: 'unknown', review_required: false, ambiguity_reasons: [] },
        ],
      },
      responseRequestId: 'req-ai2c-partial',
      requestContext: context.context,
      reviews: new Map<string, unknown>([
        ['sugar', sugar],
        ['sugar-mass', sugarWithMass],
      ]),
      deterministicAcceptance: deterministicAcceptanceView,
      currentLineRefs: ['sugar', 'sugar-mass'],
      workingState: {
        matches: {},
        portions: {},
        countPortions: {},
        userMasses: { 'sugar-mass': { kind: 'explicit', quantity: 250, unit: 'g' } },
        householdPortions: {},
      },
      captured: {
        fingerprints: new Map([
          ['sugar', 'fp-sugar'],
          ['sugar-mass', 'fp-mass'],
        ]),
        matches: {},
        massSourceLineRefs: ['sugar-mass'],
      },
      currentFingerprints: new Map([
        ['sugar', 'fp-sugar'],
        ['sugar-mass', 'fp-mass'],
      ]),
    });

    if (result.ok !== true) throw new Error('expected ok');
    // BOTH lines classify automatic; only the clean one may transition.
    expect(result.reconciliation.classification.automatic_count).toBe(2);
    expect(result.reconciliation.accepted.map((entry) => entry.line_ref)).toEqual(['sugar']);
    expect(result.reconciliation.conflicts.map((entry) => [entry.line_ref, entry.kind])).toEqual([
      ['sugar-mass', 'pre_existing_mass_source'],
    ]);
  });
  it('rejects a CROSS-LINE candidate ref (whole plan, no namespace leakage)', () => {
    // Two lines with DIFFERENT candidate sets: `sugar` has c1+c2, `mystery` has
    // only c1. Naming c2 for `mystery` is a cross-line reference and must
    // withdraw the whole plan — the candidate namespace is per-line.
    const crossCatalog = makeCatalog([
      {
        fdcId: 2001,
        dataType: 'sr_legacy',
        description: 'Sugar, granulated',
        proteinAmount: 0,
        portions: [{ amount: 1, measure: 'tsp', gram_weight: 4.2, sequence: 1 }],
      },
      {
        fdcId: 2002,
        dataType: 'sr_legacy',
        description: 'Sugar, granulated',
        proteinAmount: 0,
        portions: [{ amount: 1, measure: 'tsp', gram_weight: 4.0, sequence: 1 }],
      },
      {
        fdcId: 7002,
        dataType: 'foundation',
        description: 'Mystery, raw',
        proteinAmount: 1,
        portions: [{ amount: 1, measure: 'cup', gram_weight: 100, sequence: 1 }],
      },
    ]);
    const sugarReview = reviewIngredient(crossCatalog, { name: 'Sugar, granulated' });
    const singleReview = reviewIngredient(crossCatalog, { name: 'Mystery, raw' });
    expect(sugarReview.outcome).toBe('review_required');
    expect(singleReview.candidates).toHaveLength(1);

    const sugarSource = buildAiAdvancedPlanLineSource({ lineRef: 'sugar', review: sugarReview });
    const singleSource = buildAiAdvancedPlanLineSource({ lineRef: 'mystery', review: singleReview });
    if (sugarSource.ok !== true || singleSource.ok !== true) throw new Error('source failed');
    expect(sugarSource.source.candidate_set.views.map((view) => view.candidate_ref)).toEqual(['c1', 'c2']);
    expect(singleSource.source.candidate_set.views.map((view) => view.candidate_ref)).toEqual(['c1']);

    const built = buildAiAdvancedPlanRequestContext({
      requestId: 'req-ai2c-cross',
      lines: [sugarSource.source, singleSource.source],
    });
    if (built.ok !== true) throw new Error('context failed');

    const result = call({
      plan: {
        plan_version: AI_ADVANCED_PLAN_VERSION,
        plans: [
          {
            line_ref: 'sugar',
            candidate_ref: 'c1',
            measure_kind: 'unknown',
            review_required: false,
            ambiguity_reasons: [],
          },
          {
            // c2 exists for `sugar`, never for `mystery`.
            line_ref: 'mystery',
            candidate_ref: 'c2',
            measure_kind: 'unknown',
            review_required: false,
            ambiguity_reasons: [],
          },
        ],
      },
      responseRequestId: 'req-ai2c-cross',
      requestContext: built.context,
      reviews: new Map([
        ['sugar', sugarReview],
        ['mystery', singleReview],
      ]),
      deterministicAcceptance: deterministicAcceptanceView,
    });
    expect(result.ok).toBe(false);
  });

});
