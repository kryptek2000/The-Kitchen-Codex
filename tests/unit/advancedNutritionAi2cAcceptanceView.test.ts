/**
 * The Kitchen Codex — AI-2C (Slice A): deterministic acceptance port +
 * genuine-session confirmation helper.
 *
 * Proves:
 *   - `deterministicAcceptanceView` reports EXACTLY what the existing Phase 2
 *     predicates decided (parity, not a re-derivation) and invents nothing;
 *   - it never manufactures a strict automatic id, never widens the eligible
 *     family, never mutates the review it inspects, and returns `undefined` for
 *     anything unusable (which can only REMOVE authority);
 *   - `confirmAdvancedNutritionMatch` reaches the existing Phase-2
 *     `confirmIngredientReview` ONLY through the module-private session
 *     authority registry: structural fakes, clones, spreads, proxies, inherited
 *     objects and primitives fail closed.
 */

import { describe, it, expect } from 'vitest';

import { deterministicAcceptanceView } from '../../src/core/nutritionV2/phase4/deterministicAcceptanceView';
import {
  confirmAdvancedNutritionMatch,
  createAdvancedNutritionSession,
  selectionFromMatchChoice,
} from '../../src/core/nutritionV2/phase4';
import {
  bestEffortDefaultCandidates,
  selectAutomaticMatch,
  selectBestEffortMatch,
} from '../../src/core/nutritionV2/matching/confidence';
import { createReviewCatalog, reviewIngredient } from '../../src/core/nutritionV2/matching/review';
import type { ConfirmationResult, IngredientReviewResult, ReviewCatalog } from '../../src/core/nutritionV2/matching/types';
import { buildMatchingBundle, DEFAULT_MATCHING_SPECS, type MatchingRecordSpec } from '../fixtures/usdaMatchingFixtures';

const BUNDLE = buildMatchingBundle(DEFAULT_MATCHING_SPECS);

function makeCatalog(specs: ReadonlyArray<MatchingRecordSpec> = DEFAULT_MATCHING_SPECS): ReviewCatalog {
  const { manifest, records } = buildMatchingBundle(specs);
  const result = createReviewCatalog(manifest, records);
  if (!result.ok) throw new Error('catalog build failed');
  return result.catalog;
}

const CATALOG = makeCatalog();

function review(name: string): IngredientReviewResult {
  return reviewIngredient(CATALOG, { name });
}

function failureOf(result: ConfirmationResult): string | undefined {
  return result.outcome === 'invalid'
    ? (result as { outcome: 'invalid'; failure: { code: string } }).failure.code
    : undefined;
}

// ---------------------------------------------------------------------------
// The port reports EXISTING decisions (parity with the Phase 2 predicates)
// ---------------------------------------------------------------------------

describe('deterministicAcceptanceView — parity with the existing Phase 2 predicates', () => {
  it('reports the strict automatic id exactly as selectAutomaticMatch decides it', () => {
    const exact = review('Milk, whole');
    expect(exact.outcome).toBe('matched_exact');
    const view = deterministicAcceptanceView(exact);
    expect(view).toBeDefined();
    const strict = selectAutomaticMatch(exact);
    expect(view?.strict_automatic_fdc_id).toBe(strict?.fdc_id);
    // An exact match carries NO best-effort family (the family is defined for
    // review_required reviews only): the port must not invent one.
    expect(bestEffortDefaultCandidates(exact)).toEqual([]);
    expect(view?.best_effort_eligible_fdc_ids).toBeUndefined();
    expect(view?.best_effort_default_fdc_id).toBeUndefined();
  });

  it('reports the FULL best-effort eligible family and its default for a review', () => {
    const ambiguousFamily = review('flour');
    expect(ambiguousFamily.outcome).toBe('review_required');
    const view = deterministicAcceptanceView(ambiguousFamily);
    const family = bestEffortDefaultCandidates(ambiguousFamily);
    expect(family.length).toBeGreaterThan(1);
    expect(view?.best_effort_eligible_fdc_ids).toEqual(family.map((entry) => entry.fdc_id));
    // The reported default is a MEMBER of the reported family (invariant), and
    // equals the canonical first eligible family member.
    expect(view?.best_effort_default_fdc_id).toBe(family[0].fdc_id);
    expect(view?.best_effort_eligible_fdc_ids).toContain(view?.best_effort_default_fdc_id);
    // No strict authority is manufactured for this review.
    expect(selectAutomaticMatch(ambiguousFamily)).toBeUndefined();
    expect(view?.strict_automatic_fdc_id).toBeUndefined();
  });

  it('reports the existing decision for a duplicate-description review without re-deriving it', () => {
    // The audited deterministic contract itself decides this fixture (the two
    // identical descriptions form ONE best-effort family and the top candidate is
    // the strict automatic). The port's only job is PARITY with those decisions —
    // never a re-derivation, and never authority the predicates did not grant.
    const duplicate = review('Sugar, granulated');
    expect(duplicate.outcome).toBe('review_required');
    const strict = selectAutomaticMatch(duplicate);
    const family = bestEffortDefaultCandidates(duplicate);
    expect(family.length).toBe(2);
    const view = deterministicAcceptanceView(duplicate);
    expect(view?.strict_automatic_fdc_id).toBe(strict?.fdc_id);
    expect(view?.best_effort_eligible_fdc_ids).toEqual(family.map((entry) => entry.fdc_id));
    expect(view?.best_effort_default_fdc_id).toBe(family[0].fdc_id);
  });

  it('reports the strict id even when the broader best-effort selector would also answer', () => {
    // `selectBestEffortMatch` echoes the STRICT choice when one exists; the port
    // must therefore take its default from the eligible FAMILY instead, which is
    // why the default is absent whenever the family is empty.
    const exact = review('Milk, whole');
    expect(selectBestEffortMatch(exact)?.fdc_id).toBe(selectAutomaticMatch(exact)?.fdc_id);
    expect(deterministicAcceptanceView(exact)?.best_effort_default_fdc_id).toBeUndefined();
  });

  it('is pure: frozen result, stable across calls, and the review is never mutated', () => {
    const subject = review('flour');
    const before = JSON.stringify(subject);
    const first = deterministicAcceptanceView(subject);
    const second = deterministicAcceptanceView(subject);
    expect(JSON.stringify(subject)).toBe(before);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.best_effort_eligible_fdc_ids)).toBe(true);
  });
});

describe('deterministicAcceptanceView — unusable input yields NO authority', () => {
  const unusable: ReadonlyArray<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['primitive', 42],
    ['string', 'review'],
    ['array', []],
    ['empty object', {}],
    ['unknown outcome', { outcome: 'unmatched', candidates: [], normalized_query: 'x' }],
    ['candidates not an array', { outcome: 'review_required', candidates: {}, normalized_query: 'x' }],
    ['missing normalized query', { outcome: 'review_required', candidates: [] }],
    [
      'oversized candidate list',
      {
        outcome: 'review_required',
        normalized_query: 'x',
        candidates: Array.from({ length: 65 }, (_value, index) => ({ fdc_id: index + 1 })),
      },
    ],
  ];

  for (const [label, value] of unusable) {
    it(`returns undefined for ${label}`, () => {
      expect(deterministicAcceptanceView(value)).toBeUndefined();
    });
  }

  it('returns undefined when a getter throws (never throws at a trust boundary)', () => {
    const hostile = {
      outcome: 'review_required',
      normalized_query: 'x',
      candidates: [],
      get something(): number {
        throw new Error('boom');
      },
    };
    expect(deterministicAcceptanceView(hostile)).toBeDefined();
    const trapped = new Proxy(
      { outcome: 'review_required', normalized_query: 'x', candidates: [] },
      {
        get(target, key) {
          if (key === 'outcome') throw new Error('boom');
          return Reflect.get(target, key);
        },
      }
    );
    expect(deterministicAcceptanceView(trapped)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Genuine-session confirmation
// ---------------------------------------------------------------------------

describe('confirmAdvancedNutritionMatch — genuine session authority only', () => {
  const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
  const session = SESSION_RESULT.ok ? SESSION_RESULT.session : undefined;

  /** A confirmable review: a `review_required` review whose candidates are known. */
  function confirmableReview(): IngredientReviewResult {
    const result = review('flour');
    expect(result.outcome).toBe('review_required');
    return result;
  }

  it('confirms through the genuine session, via the existing Phase-2 confirmation', () => {
    if (session === undefined) throw new Error('session build failed');
    const subject = confirmableReview();
    const fdcId = (subject.candidates as ReadonlyArray<{ fdc_id: number }>)[0].fdc_id;
    const selection = selectionFromMatchChoice(
      {
        kind: 'candidate',
        fdc_id: fdcId,
        review_digest: subject.review_digest,
        aiAssisted: true,
        aiAccepted: true,
      },
      'flour'
    );
    const result = confirmAdvancedNutritionMatch(session, subject, selection);
    expect(result.outcome).toBe('confirmed');
    expect((result as { fdc_id?: number }).fdc_id).toBe(fdcId);
    // PARITY: the same call through the session method returns the same decision.
    const viaMethod = session.confirmMatch(subject, selection);
    expect(viaMethod.outcome).toBe(result.outcome);
  });

  it('fails closed for structural fakes, clones, spreads, proxies, inherited and primitive receivers', () => {
    if (session === undefined) throw new Error('session build failed');
    const subject = confirmableReview();
    const fdcId = (subject.candidates as ReadonlyArray<{ fdc_id: number }>)[0].fdc_id;
    const selection = selectionFromMatchChoice(
      { kind: 'candidate', fdc_id: fdcId, review_digest: subject.review_digest },
      'flour'
    );

    const fakes: ReadonlyArray<[string, unknown]> = [
      ['plain structural object', { confirmMatch: () => ({ outcome: 'confirmed', fdc_id: fdcId }) }],
      ['spread clone', { ...session }],
      ['object create', Object.create(session)],
      ['proxy wrapper', new Proxy(session as object, {})],
      ['frozen clone', Object.freeze(Object.assign({}, session))],
      ['null', null],
      ['undefined', undefined],
      ['number', 7],
      ['function', () => ({ outcome: 'confirmed' })],
    ];

    for (const [label, receiver] of fakes) {
      const result = confirmAdvancedNutritionMatch(receiver, subject, selection);
      expect(result.outcome, label).toBe('invalid');
      expect(failureOf(result), label).toBe('invalid_catalog');
    }
  });

  it('fails closed even for a receiver carrying a functional equivalent catalog', () => {
    // The strongest forgery shape: a structural object holding a REAL catalog
    // (same digests, different instance) plus the genuine method copied onto it.
    // Authority lives in the module-private registry, not in the shape or in the
    // catalog instance, so this must still fail closed.
    const created = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
    if (!created.ok) throw new Error('session failed');
    const genuine = created.session;
    const equivalent = makeCatalog();
    const equivalentReview = reviewIngredient(equivalent, { name: 'Sugar, granulated' });
    const fdcId = (equivalentReview.candidates ?? [])[0]?.fdc_id as number;
    const selection = {
      kind: 'candidate',
      fdc_id: fdcId,
      review_digest: equivalentReview.review_digest,
    };

    // The GENUINE session confirms the equivalent catalog's review...
    const ok = confirmAdvancedNutritionMatch(genuine, equivalentReview, selection);
    expect(ok.outcome).toBe('confirmed');

    // ...and no structural receiver does, however convincing.
    const forged = { confirmMatch: genuine.confirmMatch, catalog: equivalent, equivalentReview };
    const result = confirmAdvancedNutritionMatch(forged, equivalentReview, selection);
    expect(result.outcome).toBe('invalid');
    expect(failureOf(result)).toBe('invalid_catalog');
  });

  it('rejects a selection that is not bound to the current review digest', () => {
    if (session === undefined) throw new Error('session build failed');
    const subject = confirmableReview();
    const fdcId = (subject.candidates as ReadonlyArray<{ fdc_id: number }>)[0].fdc_id;
    const forged = { kind: 'candidate', fdc_id: fdcId, review_digest: 'f'.repeat(64) };
    const result = confirmAdvancedNutritionMatch(session, subject, forged);
    expect(result.outcome).toBe('invalid');
    expect(failureOf(result)).toBe('stale_review');
  });

  it('rejects a candidate that is not in the reconstructed review set', () => {
    if (session === undefined) throw new Error('session build failed');
    const subject = confirmableReview();
    const selection = {
      kind: 'candidate',
      fdc_id: 999999,
      review_digest: subject.review_digest,
    };
    const result = confirmAdvancedNutritionMatch(session, subject, selection);
    expect(result.outcome).toBe('invalid');
    expect(failureOf(result)).toBe('candidate_not_in_review_set');
  });

  it('rejects smuggled AI/authority fields in the selection (closed key set)', () => {
    if (session === undefined) throw new Error('session build failed');
    const subject = confirmableReview();
    const fdcId = (subject.candidates as ReadonlyArray<{ fdc_id: number }>)[0].fdc_id;
    const result = confirmAdvancedNutritionMatch(session, subject, {
      kind: 'candidate',
      fdc_id: fdcId,
      review_digest: subject.review_digest,
      aiAccepted: true,
      automatic: true,
      grams: 100,
    });
    expect(result.outcome).toBe('invalid');
    expect(failureOf(result)).toBe('unknown_field');
  });
});
