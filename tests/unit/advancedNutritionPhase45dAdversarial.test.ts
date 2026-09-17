import { describe, it, expect } from 'vitest';
import {
  ELIGIBILITY_POLICY_VERSION,
  computeEligibilityPolicyDigest,
  evaluateEligibility,
} from '../../src/core/nutritionV2/matching/eligibility';
import {
  confirmIngredientReview,
  createReviewCatalog,
  reviewIngredient,
} from '../../src/core/nutritionV2/matching/review';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import {
  buildMatchingBundle,
  type MatchingRecordSpec,
} from '../fixtures/usdaMatchingFixtures';

/**
 * Phase 4.5D — adversarial eligibility / catalog-authority coverage.
 * Every forged, excluded, or synthetic case must fail closed.
 */

const SPECS: ReadonlyArray<MatchingRecordSpec> = [
  { fdcId: 7001, dataType: 'sr_legacy', description: 'Cheese, cheddar', foodCategory: 'Dairy and Egg Products' },
  { fdcId: 7002, dataType: 'sr_legacy', description: 'Bacon, cooked', foodCategory: 'Pork Products' },
  { fdcId: 7003, dataType: 'fndds', description: "McDONALD'S, Hamburger", foodCategory: 'Burgers' },
  { fdcId: 7004, dataType: 'fndds', description: 'Ketchup, restaurant', foodCategory: 'Vegetables and Vegetable Products' },
];

function build(specs: ReadonlyArray<MatchingRecordSpec> = SPECS) {
  const { manifest, records } = buildMatchingBundle(specs);
  const result = createReviewCatalog(manifest, records);
  if (!result.ok) {
    throw new Error(`catalog failed: ${(result as { failure: { code: string } }).failure.code}`);
  }
  return result.catalog;
}

describe('phase 4.5d adversarial — forged category and description', () => {
  it('excludes a record whose category is forged to a retail category but whose description is a chain', () => {
    const decision = evaluateEligibility({
      description: "McDONALD'S, Hamburger",
      food_category: 'Dairy and Egg Products',
    });
    expect(decision).toEqual({ eligible: false, reason: 'restaurant_chain_marker', marker: 'mcdonald' });
  });

  it('excludes a record whose description is forged to a generic food but whose category is excluded', () => {
    const decision = evaluateEligibility({
      description: 'Cheese, cheddar',
      food_category: 'Fast Foods',
    });
    expect(decision).toEqual({ eligible: false, reason: 'fast_food_category', marker: null });
  });

  it('never resurrects an excluded record through an explicit restaurant-name query', () => {
    const catalog = build();
    for (const query of ["McDonald's", 'restaurant', 'Burger King', 'fast food']) {
      const ids = catalog.search(normalizeQuery(query), 25).map((c) => c.fdc_id);
      expect(ids, query).not.toContain(7003);
      expect(ids, query).not.toContain(7004);
    }
  });

  it('cannot resurrect an excluded record by manipulating the result limit', () => {
    const catalog = build();
    const ids = catalog.search(normalizeQuery('hamburger ketchup restaurant'), 9999).map((c) => c.fdc_id);
    expect(ids).not.toContain(7003);
    expect(ids).not.toContain(7004);
  });
});

describe('phase 4.5d adversarial — synthetic catalog and empty eligible set', () => {
  it('rejects a synthetic structural catalog object (no private authority)', () => {
    const catalog = build();
    const review = reviewIngredient(catalog, { name: 'bacon' });
    const synthetic = {
      metadata: () => ({ ...catalog.metadata() }),
      size: () => 2,
      search: () => [],
      exactPhraseCount: () => 0,
    };
    const result = confirmIngredientReview(synthetic, review, {
      kind: 'candidate',
      fdc_id: 7002,
      review_digest: (review as { review_digest: string }).review_digest,
    });
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') expect(result.failure.code).toBe('invalid_catalog');
  });

  it('fails closed when every source record is excluded (no eligible catalog)', () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7101, dataType: 'fndds', description: 'Fast foods, hamburger', foodCategory: 'Fast Foods' },
      { fdcId: 7102, dataType: 'fndds', description: 'Ham, sliced, restaurant', foodCategory: 'Pork Products' },
    ]);
    const result = createReviewCatalog(manifest, records);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { failure: { code: string } }).failure.code).toBe('empty_catalog');
    }
  });
});

describe('phase 4.5d adversarial — eligibility binding and stale rejection', () => {
  it('binds the eligibility policy version and digest into catalog metadata', () => {
    const metadata = build().metadata();
    expect(metadata.eligibility_version).toBe(ELIGIBILITY_POLICY_VERSION);
    expect(metadata.eligibility_digest).toBe(computeEligibilityPolicyDigest());
  });

  it('rejects a stale pre-4.5D catalog digest on confirmation', () => {
    const catalog = build();
    const review = reviewIngredient(catalog, { name: 'bacon' });
    if (review.outcome !== 'review_required') throw new Error('expected review');
    const stale = JSON.parse(JSON.stringify(review));
    stale.catalog_digest = '0'.repeat(64);
    const result = confirmIngredientReview(catalog, stale, {
      kind: 'candidate',
      fdc_id: 7002,
      review_digest: stale.review_digest,
    });
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') expect(result.failure.code).toBe('stale_review');
  });

  it('rejects an excluded record supplied as a forged selected food', () => {
    const catalog = build();
    const review = reviewIngredient(catalog, { name: 'bacon' });
    if (review.outcome !== 'review_required') throw new Error('expected review');
    const result = confirmIngredientReview(catalog, review, {
      kind: 'candidate',
      fdc_id: 7003,
      review_digest: review.review_digest,
    });
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') expect(result.failure.code).toBe('candidate_not_in_review_set');
  });
});
