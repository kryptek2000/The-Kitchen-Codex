import { describe, it, expect } from 'vitest';
import {
  MATCHING_CATALOG_VERSION,
  MATCHING_CONFIRMATION_VERSION,
  MATCHING_NORMALIZATION_VERSION,
  MATCHING_RANKING_VERSION,
} from '../../src/core/nutritionV2/matching/types';
import { QUERY_PROJECTION_VERSION } from '../../src/core/nutritionV2/matching/query';
import { ELIGIBILITY_POLICY_VERSION } from '../../src/core/nutritionV2/matching/eligibility';
import {
  CALCULATION_CONTEXT_VERSION,
  CALCULATION_VERSION,
} from '../../src/core/nutritionV2/calculation/types';
import { PORTION_SEMANTICS_VERSION } from '../../src/core/nutritionV2/calculation/portionSemantics';
import {
  PHASE4_SESSION_VERSION,
  PHASE4_STATE_VERSION,
} from '../../src/core/nutritionV2/phase4/types';
import {
  confirmIngredientReview,
  createReviewCatalog,
  reviewIngredient,
} from '../../src/core/nutritionV2/matching/review';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

/**
 * Phase 4.5D — versioning and stale-state invalidation.
 */

describe('phase 4.5d versioning — explicit bumps', () => {
  it('bumps every affected matching/calculation/phase version', () => {
    expect(MATCHING_NORMALIZATION_VERSION).toBe('usda_match_normalize_v2');
    expect(MATCHING_RANKING_VERSION).toBe('usda_match_rank_v2');
    expect(MATCHING_CATALOG_VERSION).toBe('usda_review_catalog_v2');
    expect(MATCHING_CONFIRMATION_VERSION).toBe('usda_match_confirm_v2');
    expect(QUERY_PROJECTION_VERSION).toBe('usda_query_projection_v1');
    expect(ELIGIBILITY_POLICY_VERSION).toBe('usda_home_recipe_eligibility_v1');
    expect(CALCULATION_VERSION).toBe('usda_advisory_calc_v3');
    expect(CALCULATION_CONTEXT_VERSION).toBe('usda_calc_context_v2');
    expect(PHASE4_SESSION_VERSION).toBe('usda_phase4_session_v2');
    expect(PHASE4_STATE_VERSION).toBe('usda_phase4_state_v3');
  });

  it('leaves the Phase 4.5C portion-semantics version unchanged', () => {
    expect(PORTION_SEMANTICS_VERSION).toBe('usda_portion_semantics_v1');
  });
});

describe('phase 4.5d versioning — stale rejection', () => {
  const { manifest, records } = buildMatchingBundle([
    { fdcId: 5001, dataType: 'fndds', description: 'Milk, whole' },
    { fdcId: 5002, dataType: 'fndds', description: 'Milk, skim' },
  ]);
  const catalogResult = createReviewCatalog(manifest, records);
  if (!catalogResult.ok) throw new Error('catalog failed');
  const catalog = catalogResult.catalog;
  const review = reviewIngredient(catalog, { name: 'milk' });
  if (review.outcome !== 'review_required') throw new Error('expected review');
  const digest = review.review_digest as string;

  it('rejects a pre-4.5D normalization/ranking version as stale', () => {
    const stale = JSON.parse(JSON.stringify(review));
    stale.normalization_version = 'usda_match_normalize_v1';
    const result = confirmIngredientReview(catalog, stale, {
      kind: 'candidate',
      fdc_id: 5001,
      review_digest: stale.review_digest,
    });
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') expect(result.failure.code).toBe('stale_review');
  });

  it('rejects a stale candidate digest', () => {
    const result = confirmIngredientReview(catalog, review, {
      kind: 'candidate',
      fdc_id: 5001,
      review_digest: 'f'.repeat(64),
    });
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') expect(result.failure.code).toBe('stale_review');
  });

  it('rejects a stale selected food not in the reconstructed set', () => {
    const result = confirmIngredientReview(catalog, review, {
      kind: 'candidate',
      fdc_id: 999999,
      review_digest: digest,
    });
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') expect(result.failure.code).toBe('candidate_not_in_review_set');
  });
});
