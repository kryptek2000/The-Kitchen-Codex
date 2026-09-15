import { describe, it, expect } from 'vitest';
import { createReviewCatalog } from '../../src/core/nutritionV2/matching/review';
import {
  computeReviewDigest,
  confirmIngredientReview,
  reviewIngredient,
} from '../../src/core/nutritionV2/matching/review';
import type {
  ConfirmationResult,
  IngredientReviewResult,
  ReviewCatalog,
} from '../../src/core/nutritionV2/matching/types';
import {
  buildMatchingBundle,
  buildMatchingBundleWithGenerator,
  DEFAULT_MATCHING_SPECS,
  type MatchingRecordSpec,
} from '../fixtures/usdaMatchingFixtures';

/**
 * Phase 2 — review outcome and explicit confirmation/rejection against genuine
 * current-catalog authority.
 */

function makeCatalog(specs: ReadonlyArray<MatchingRecordSpec> = DEFAULT_MATCHING_SPECS): ReviewCatalog {
  const { manifest, records } = buildMatchingBundle(specs);
  const result = createReviewCatalog(manifest, records);
  if (!result.ok) {
    throw new Error(`catalog build failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  }
  return result.catalog;
}

function outcomeOf(review: IngredientReviewResult): string {
  return review.outcome;
}

function selectedOf(review: IngredientReviewResult): number | undefined {
  return review.outcome === 'matched_exact'
    ? (review as { selected_fdc_id: number }).selected_fdc_id
    : undefined;
}

function failureOf(result: ConfirmationResult): string | undefined {
  return result.outcome === 'invalid'
    ? (result as { outcome: 'invalid'; failure: { code: string } }).failure.code
    : undefined;
}

function recomputeDigest(review: Record<string, any>): string {
  return computeReviewDigest({
    line_ref: review.line_ref,
    original_text: review.original_text,
    query: review.query,
    normalized_query: review.normalized_query,
    query_tokens: review.query_tokens,
    bundle_release: review.bundle_release,
    catalog_digest: review.catalog_digest,
    normalization_version: review.normalization_version,
    ranking_version: review.ranking_version,
    result_limit: review.result_limit,
    candidates: review.candidates,
  });
}

/** A mutable, JSON-cloned copy of a frozen review (for tamper tests). */
function cloneReview(review: unknown): Record<string, any> {
  return JSON.parse(JSON.stringify(review));
}

function reseal(review: Record<string, any>): Record<string, any> {
  review.review_digest = recomputeDigest(review);
  return review;
}

const CATALOG = makeCatalog();

describe('phase 2 review — automatic vs reviewed outcomes', () => {
  it('auto-matches a unique exact normalized phrase', () => {
    const review = reviewIngredient(CATALOG, { name: 'Milk, whole', amount: 1, unit: 'cup' });
    expect(outcomeOf(review)).toBe('matched_exact');
    expect(selectedOf(review)).toBe(1003);
  });

  it('requires review when multiple records share the exact normalized phrase', () => {
    const review = reviewIngredient(CATALOG, { name: 'Sugar, granulated' });
    expect(outcomeOf(review)).toBe('review_required');
    expect(selectedOf(review)).toBeUndefined();
  });

  it('requires review for token-multiset, reordered, subset, and partial matches', () => {
    expect(outcomeOf(reviewIngredient(CATALOG, { name: 'ground beef' }))).toBe('review_required');
    expect(outcomeOf(reviewIngredient(CATALOG, { name: 'raw ground beef' }))).toBe('review_required');
    expect(outcomeOf(reviewIngredient(CATALOG, { name: 'milk' }))).toBe('review_required');
    expect(outcomeOf(reviewIngredient(CATALOG, { name: 'butter' }))).toBe('review_required');
  });

  it('returns unmatched/invalid correctly', () => {
    expect(outcomeOf(reviewIngredient(CATALOG, { name: 'zzz nonexistent food' }))).toBe('unmatched');
    expect(outcomeOf(reviewIngredient(CATALOG, ''))).toBe('invalid');
  });

  it('never auto-matches across nutritionally significant qualifiers', () => {
    const cases: ReadonlyArray<[string, number]> = [
      ['Butter, salted', 1001],
      ['Butter, unsalted', 1002],
      ['Beef, ground, raw', 1009],
      ['Beef, ground, cooked', 1010],
      ['Milk, whole', 1003],
      ['Milk, skim', 1004],
      ['Milk, sweetened', 1005],
      ['Milk, unsweetened', 1006],
      ['Flour, enriched', 1007],
      ['Flour, unenriched', 1008],
      ['Tomatoes, canned, drained', 1011],
      ['Tomatoes, canned, undrained', 1012],
    ];
    for (const [name, fdcId] of cases) {
      const review = reviewIngredient(CATALOG, { name });
      expect(outcomeOf(review), name).toBe('matched_exact');
      expect(selectedOf(review), name).toBe(fdcId);
    }
  });

  it('returns immutable, explainable results including the effective limit', () => {
    const review = reviewIngredient(CATALOG, { name: 'milk' });
    expect(Object.isFrozen(review)).toBe(true);
    expect(review.review_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(review.result_limit).toBe(10);
    expect(review.normalized_query).toBe('milk');
  });
});

describe('phase 2 confirmation — genuine catalog authority', () => {
  const review = reviewIngredient(CATALOG, { name: 'milk' });
  const digest = review.review_digest as string;
  const candidateId = review.candidates[0].fdc_id;

  it('accepts a genuine catalog and confirms a reviewed candidate', () => {
    const result = confirmIngredientReview(CATALOG, review, {
      kind: 'candidate',
      fdc_id: candidateId,
      review_digest: digest,
    });
    expect(result.outcome).toBe('confirmed');
    if (result.outcome === 'confirmed') {
      expect(result.fdc_id).toBe(candidateId);
      expect(result.result_limit).toBe(review.result_limit);
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/codex_nutrition|apply|calories|amount_per_100g/i);
    }
  });

  it('rejects a structurally identical fake catalog', () => {
    const fake = {
      metadata: () => CATALOG.metadata(),
      size: () => CATALOG.size(),
      search: (q: unknown, l: number) => CATALOG.search(q as never, l),
      exactPhraseCount: (q: unknown) => CATALOG.exactPhraseCount(q as never),
    };
    expect(failureOf(confirmIngredientReview(fake, review, { kind: 'none', review_digest: digest }))).toBe('invalid_catalog');
  });

  it('rejects a cloned catalog, a proxy, arbitrary objects, and primitives', () => {
    expect(failureOf(confirmIngredientReview({ ...CATALOG }, review, { kind: 'none', review_digest: digest }))).toBe('invalid_catalog');
    expect(failureOf(confirmIngredientReview(new Proxy(CATALOG, {}), review, { kind: 'none', review_digest: digest }))).toBe('invalid_catalog');
    expect(failureOf(confirmIngredientReview({}, review, { kind: 'none', review_digest: digest }))).toBe('invalid_catalog');
    expect(failureOf(confirmIngredientReview(null, review, { kind: 'none', review_digest: digest }))).toBe('invalid_catalog');
    expect(failureOf(confirmIngredientReview(42, review, { kind: 'none', review_digest: digest }))).toBe('invalid_catalog');
    expect(failureOf(confirmIngredientReview('catalog', review, { kind: 'none', review_digest: digest }))).toBe('invalid_catalog');
  });

  it('does not invoke getters on an untrusted catalog-shaped object', () => {
    let getterCalled = false;
    const evil = {
      get metadata() {
        getterCalled = true;
        throw new Error('boom');
      },
    };
    const result = confirmIngredientReview(evil, review, { kind: 'none', review_digest: digest });
    expect(failureOf(result)).toBe('invalid_catalog');
    expect(getterCalled).toBe(false);
  });

  it('does not expose the private authority capability', () => {
    expect(Object.keys(CATALOG).sort()).toEqual(['exactPhraseCount', 'metadata', 'search', 'size']);
    expect((CATALOG as unknown as Record<string, unknown>).authority).toBeUndefined();
    expect((CATALOG as unknown as Record<string, unknown>).entries).toBeUndefined();
  });
});

describe('phase 2 confirmation — authoritative reconstruction', () => {
  const review = reviewIngredient(CATALOG, { name: 'milk' }) as Record<string, any>;
  const digest = review.review_digest as string;
  const candidateId = review.candidates[0].fdc_id as number;
  const select = (r: unknown, fdcId = candidateId) => ({ kind: 'candidate' as const, fdc_id: fdcId, review_digest: (r as any).review_digest });

  it('confirms a genuine untouched review', () => {
    expect(confirmIngredientReview(CATALOG, review, select(review)).outcome).toBe('confirmed');
  });

  it('recomputes the review digest (self-inconsistent digest fails)', () => {
    const tampered = cloneReview(review);
    tampered.query = 'butter';
    expect(failureOf(confirmIngredientReview(CATALOG, tampered, select(review)))).toBe('invalid_review');
  });

  it('rejects an altered raw query even with a recomputed digest', () => {
    const tampered = reseal(cloneReview(review));
    tampered.query = 'butter';
    reseal(tampered);
    expect(failureOf(confirmIngredientReview(CATALOG, tampered, select(tampered)))).toBe('stale_review');
  });

  it('rejects removed, added, substituted, reordered, or altered candidates with recomputed digests', () => {
    const removed = cloneReview(review);
    removed.candidates = removed.candidates.slice(1);
    reseal(removed);
    expect(failureOf(confirmIngredientReview(CATALOG, removed, select(removed)))).toBe('stale_review');

    const added = cloneReview(review);
    added.candidates = [...added.candidates, { ...added.candidates[0], fdc_id: 999999 }];
    reseal(added);
    expect(failureOf(confirmIngredientReview(CATALOG, added, select(added)))).toBe('stale_review');

    const substituted = cloneReview(review);
    substituted.candidates[0].fdc_id = 999999;
    reseal(substituted);
    expect(failureOf(confirmIngredientReview(CATALOG, substituted, select(substituted)))).toBe('stale_review');

    const recordDigest = cloneReview(review);
    recordDigest.candidates[0].record_digest = 'f'.repeat(64);
    reseal(recordDigest);
    expect(failureOf(confirmIngredientReview(CATALOG, recordDigest, select(recordDigest)))).toBe('stale_review');

    const matchClass = cloneReview(review);
    matchClass.candidates[0].match_class = 'exact_phrase';
    reseal(matchClass);
    expect(failureOf(confirmIngredientReview(CATALOG, matchClass, select(matchClass)))).toBe('stale_review');

    const evidence = cloneReview(review);
    evidence.candidates[0].evidence.missing_query_token_count += 1;
    reseal(evidence);
    expect(failureOf(confirmIngredientReview(CATALOG, evidence, select(evidence)))).toBe('stale_review');

    const reordered = cloneReview(review);
    reordered.candidates = [...reordered.candidates].reverse();
    reseal(reordered);
    expect(failureOf(confirmIngredientReview(CATALOG, reordered, select(reordered)))).toBe('stale_review');
  });

  it('binds the effective result limit in the snapshot digest', () => {
    const wide = reviewIngredient(CATALOG, { name: 'milk' }, { limit: 25 });
    const narrow = reviewIngredient(CATALOG, { name: 'milk' }, { limit: 10 });
    // Same candidate set, different effective limit -> different digest.
    expect(wide.candidates.map((c) => c.fdc_id)).toEqual(narrow.candidates.map((c) => c.fdc_id));
    expect(wide.result_limit).toBe(25);
    expect(narrow.result_limit).toBe(10);
    expect(wide.review_digest).not.toBe(narrow.review_digest);
  });

  it('rejects a changed effective result limit that changes the candidate set', () => {
    const limited = reviewIngredient(CATALOG, { name: 'milk' }, { limit: 2 }) as Record<string, any>;
    const tampered = cloneReview(limited);
    tampered.result_limit = 25;
    reseal(tampered);
    expect(failureOf(confirmIngredientReview(CATALOG, tampered, select(tampered)))).toBe('stale_review');
  });

  it('rejects a review whose bundle release or catalog digest differs from the current catalog', () => {
    const bundle = cloneReview(review);
    bundle.bundle_release = 'usda_fdc_otherbundle';
    reseal(bundle);
    expect(failureOf(confirmIngredientReview(CATALOG, bundle, select(bundle)))).toBe('stale_review');

    const catalogDigest = cloneReview(review);
    catalogDigest.catalog_digest = 'f'.repeat(64);
    reseal(catalogDigest);
    expect(failureOf(confirmIngredientReview(CATALOG, catalogDigest, select(catalogDigest)))).toBe('stale_review');
  });

  it('rejects changed normalization or ranking versions', () => {
    const norm = cloneReview(review);
    norm.normalization_version = 'other';
    reseal(norm);
    expect(failureOf(confirmIngredientReview(CATALOG, norm, select(norm)))).toBe('stale_review');

    const rank = cloneReview(review);
    rank.ranking_version = 'other';
    reseal(rank);
    expect(failureOf(confirmIngredientReview(CATALOG, rank, select(rank)))).toBe('stale_review');
  });

  it('rejects a fully synthetic never-reviewed candidate set', () => {
    const synthetic = cloneReview(review);
    synthetic.candidates = [
      {
        fdc_id: 777777,
        data_type: 'foundation',
        description: 'Synthetic',
        normalized_description: 'synthetic',
        record_digest: 'a'.repeat(64),
        match_class: 'exact_phrase',
        evidence: {
          exact_phrase: true,
          exact_token_multiset: true,
          matched_query_token_count: 1,
          missing_query_token_count: 0,
          extra_candidate_token_count: 0,
          order_agreement: true,
        },
      },
    ];
    reseal(synthetic);
    expect(failureOf(confirmIngredientReview(CATALOG, synthetic, select(synthetic, 777777)))).toBe('stale_review');
  });

  it('rejects a candidate absent from the reconstructed set', () => {
    expect(failureOf(confirmIngredientReview(CATALOG, review, select(review, 999999)))).toBe('candidate_not_in_review_set');
  });

  it('rejects a non-review-required outcome', () => {
    const matched = reviewIngredient(CATALOG, { name: 'Milk, whole' });
    expect(failureOf(confirmIngredientReview(CATALOG, matched, { kind: 'none', review_digest: '0'.repeat(64) }))).toBe('not_reviewable');
  });

  it('supports an explicit none rejection', () => {
    const result = confirmIngredientReview(CATALOG, review, { kind: 'none', review_digest: digest });
    expect(result.outcome).toBe('rejected');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('fails closed on unknown, unsafe, malformed, or contradictory input', () => {
    expect(failureOf(confirmIngredientReview(CATALOG, { ...review, evil: 1 }, select(review)))).toBe('unknown_field');
    expect(failureOf(confirmIngredientReview(CATALOG, review, { kind: 'candidate', fdc_id: candidateId, review_digest: 'xyz' }))).toBe('malformed_digest');
    expect(failureOf(confirmIngredientReview(CATALOG, review, { kind: 'candidate', fdc_id: candidateId, review_digest: digest, normalized_query: 'butter' }))).toBe('binding_mismatch');
    expect(failureOf(confirmIngredientReview(CATALOG, review, { kind: 'candidate', fdc_id: candidateId, review_digest: digest, bundle_release: 'usda_fdc_other' }))).toBe('binding_mismatch');
    expect(failureOf(confirmIngredientReview(CATALOG, review, { kind: 'candidate', fdc_id: candidateId, review_digest: digest, line_ref: 'other-line' }))).toBe('binding_mismatch');
    expect(failureOf(confirmIngredientReview(CATALOG, review, { kind: 'candidate', fdc_id: candidateId, review_digest: digest, evil: 1 }))).toBe('unknown_field');
    const accessor: Record<string, unknown> = { kind: 'none' };
    Object.defineProperty(accessor, 'review_digest', { enumerable: true, get: () => digest });
    expect(failureOf(confirmIngredientReview(CATALOG, review, accessor))).toBe('unsafe_selection');
  });
});

describe('phase 2 confirmation — stale current catalog', () => {
  const catalogA = makeCatalog();
  const reviewA = reviewIngredient(catalogA, { name: 'milk' }) as Record<string, any>;
  const selectA = { kind: 'candidate' as const, fdc_id: reviewA.candidates[0].fdc_id, review_digest: reviewA.review_digest };

  it('still confirms against the same catalog when untouched', () => {
    expect(confirmIngredientReview(catalogA, reviewA, selectA).outcome).toBe('confirmed');
  });

  it('fails against a catalog with a changed bundle release', () => {
    const variant = buildMatchingBundleWithGenerator(DEFAULT_MATCHING_SPECS, 'other-generator');
    const catalogB = createReviewCatalog(variant.manifest, variant.records);
    expect(catalogB.ok).toBe(true);
    if (!catalogB.ok) return;
    expect(failureOf(confirmIngredientReview(catalogB.catalog, reviewA, selectA))).toBe('stale_review');
  });

  it('fails against a catalog with an added record (changed content digest)', () => {
    const catalogB = makeCatalog([...DEFAULT_MATCHING_SPECS, { fdcId: 9001, dataType: 'fndds', description: 'Milk, whole, extra' }]);
    expect(failureOf(confirmIngredientReview(catalogB, reviewA, selectA))).toBe('stale_review');
  });

  it('fails against a catalog with a removed candidate', () => {
    const catalogB = makeCatalog(DEFAULT_MATCHING_SPECS.filter((spec) => spec.fdcId !== 1003));
    expect(failureOf(confirmIngredientReview(catalogB, reviewA, selectA))).toBe('stale_review');
  });

  it('fails against a catalog with a changed authoritative record digest', () => {
    const catalogB = makeCatalog(
      DEFAULT_MATCHING_SPECS.map((spec) =>
        spec.fdcId === 1003 ? { ...spec, proteinAmount: 2 } : spec
      )
    );
    expect(failureOf(confirmIngredientReview(catalogB, reviewA, selectA))).toBe('stale_review');
  });

  it('fails against a catalog with a changed candidate description/ranking', () => {
    const catalogB = makeCatalog(
      DEFAULT_MATCHING_SPECS.map((spec) =>
        spec.fdcId === 1003 ? { ...spec, description: 'Milk, whole, 3.25% milkfat' } : spec
      )
    );
    expect(failureOf(confirmIngredientReview(catalogB, reviewA, selectA))).toBe('stale_review');
  });
});
