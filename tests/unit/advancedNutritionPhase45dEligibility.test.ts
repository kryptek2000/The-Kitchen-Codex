import { describe, it, expect } from 'vitest';
import {
  ELIGIBILITY_POLICY_VERSION,
  RESTAURANT_CHAIN_MARKERS,
  computeEligibilityPolicyDigest,
  evaluateEligibility,
  isExcludedCategory,
} from '../../src/core/nutritionV2/matching/eligibility';
import {
  createReviewCatalog,
  confirmIngredientReview,
  reviewIngredient,
} from '../../src/core/nutritionV2/matching/review';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import {
  buildMatchingBundle,
  type MatchingRecordSpec,
} from '../fixtures/usdaMatchingFixtures';

/**
 * Phase 4.5D — home-recipe catalog eligibility policy.
 */

function eligible(description: string, foodCategory?: string): boolean {
  return evaluateEligibility({ description, ...(foodCategory !== undefined ? { food_category: foodCategory } : {}) })
    .eligible;
}

describe('phase 4.5d eligibility — excluded categories', () => {
  it('excludes every exact Fast Foods / Restaurant Foods record', () => {
    expect(evaluateEligibility({ description: 'Anything', food_category: 'Fast Foods' })).toEqual({
      eligible: false,
      reason: 'fast_food_category',
      marker: null,
    });
    expect(
      evaluateEligibility({ description: 'Anything', food_category: 'Restaurant Foods' })
    ).toEqual({ eligible: false, reason: 'restaurant_food_category', marker: null });
    expect(isExcludedCategory('Fast Foods')).toBe(true);
    expect(isExcludedCategory('Restaurant Foods')).toBe(true);
    expect(isExcludedCategory('Baked Products')).toBe(false);
  });

  it('treats an unknown or absent category as eligible (unless a marker matches)', () => {
    expect(eligible('Cheese, cheddar')).toBe(true);
    expect(eligible('Cheese, cheddar', 'Some Future Category')).toBe(true);
    expect(eligible('Ham, sliced, restaurant')).toBe(false);
  });
});

describe('phase 4.5d eligibility — chain and context markers', () => {
  it('excludes the pinned chain-marker forms (case, punctuation, possessive)', () => {
    const chainDescriptions = [
      "McDONALD'S, Hamburger",
      'McDonald\u2019s, Big Mac',
      'BURGER KING, Hamburger',
      "WENDY'S, CLASSIC SINGLE Hamburger",
      'KFC, biscuit',
      'TACO BELL, Soft Taco',
      'PIZZA HUT 14" Cheese Pizza',
      "DOMINO'S 14\" Pepperoni Pizza",
      'SUBWAY, SUBWAY CLUB sub',
      'CHICK-FIL-A, chicken sandwich',
      'POPEYES, Fried Chicken',
      "ARBY'S, roast beef sandwich",
      'LITTLE CAESARS 14" Cheese Pizza',
      "PAPA JOHN'S 14\" Cheese Pizza",
      'CRACKER BARREL, steak fries',
      "T.G.I. FRIDAY'S, mozzarella sticks",
      'ON THE BORDER, soft taco',
      'OLIVE GARDEN, spaghetti',
      "CARRABBA'S ITALIAN GRILL, spaghetti",
      "APPLEBEE'S, french fries",
      "DENNY'S, french fries",
      'Cheeseburger (McDonalds)',
      'Hamburger (Burger King)',
      'Beverages, WENDY\u2019S, tea',
    ];
    for (const description of chainDescriptions) {
      const decision = evaluateEligibility({ description, food_category: 'Burgers' });
      expect(decision.eligible, description).toBe(false);
      expect(decision.reason, description).toBe('restaurant_chain_marker');
    }
  });

  it('excludes restaurant-context descriptors', () => {
    for (const description of [
      'Ham, sliced, restaurant',
      'Ketchup, restaurant',
      'Pizza, cheese, from restaurant or fast food',
      'Shake, fast food, vanilla',
    ]) {
      const decision = evaluateEligibility({ description, food_category: 'Snacks' });
      expect(decision.eligible, description).toBe(false);
      expect(decision.reason, description).toBe('restaurant_context_marker');
    }
  });

  it('does not use an uppercase or apostrophe rule', () => {
    // A retail brand in uppercase with an apostrophe stays eligible.
    expect(eligible("CAMPBELL'S, Chicken Noodle Soup, condensed", 'Soups, Sauces, and Gravies')).toBe(
      true
    );
    expect(eligible('HERSHEY\u2019S, MILK CHOCOLATE', 'Sweets')).toBe(true);
  });

  it('keeps the policy closed, versioned, and deterministic', () => {
    expect(ELIGIBILITY_POLICY_VERSION).toBe('usda_home_recipe_eligibility_v1');
    expect(computeEligibilityPolicyDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEligibilityPolicyDigest()).toBe(computeEligibilityPolicyDigest());
    expect(RESTAURANT_CHAIN_MARKERS.length).toBeGreaterThan(10);
  });
});

describe('phase 4.5d eligibility — retail-brand retention', () => {
  it('retains ordinary packaged grocery products', () => {
    const retail: ReadonlyArray<[string, string]> = [
      ['Pillsbury Golden Layer Buttermilk Biscuits, Artificial Flavor, refrigerated dough', 'Baked Products'],
      ['Nabisco, Nabisco Snackwell\u2019s Fat Free Devil\u2019s Food Cookie Cakes', 'Baked Products'],
      ['Snacks, KRAFT, CORNNUTS, plain', 'Snacks'],
      ["CAMPBELL'S, Chicken Noodle Soup, condensed", 'Soups, Sauces, and Gravies'],
      ["HERSHEY'S GOLDEN ALMOND SOLITAIRES", 'Sweets'],
      ['Cereals ready-to-eat, QUAKER, CAP\u2019N CRUNCH', 'Breakfast Cereals'],
      ['Pepperidge Farm, Goldfish, Baked Snack Crackers, Cheddar', 'Baked Products'],
      ['HORMEL Canadian Style Bacon', 'Pork Products'],
    ];
    for (const [description, category] of retail) {
      expect(eligible(description, category), description).toBe(true);
    }
  });
});

describe('phase 4.5d eligibility — catalog authority', () => {
  const specs: ReadonlyArray<MatchingRecordSpec> = [
    { fdcId: 4001, dataType: 'sr_legacy', description: 'Cheese, cheddar', foodCategory: 'Dairy and Egg Products' },
    { fdcId: 4002, dataType: 'sr_legacy', description: 'Bacon, cooked', foodCategory: 'Pork Products' },
    { fdcId: 4003, dataType: 'fndds', description: 'BURGER KING, Hamburger', foodCategory: 'Burgers' },
    { fdcId: 4004, dataType: 'sr_legacy', description: "McDONALD'S, Hamburger", foodCategory: 'Burgers' },
    { fdcId: 4005, dataType: 'sr_legacy', description: 'Fast foods, hamburger', foodCategory: 'Fast Foods' },
    { fdcId: 4006, dataType: 'sr_legacy', description: 'Ham, sliced, restaurant', foodCategory: 'Pork Products' },
  ];

  function build() {
    const { manifest, records } = buildMatchingBundle(specs);
    const result = createReviewCatalog(manifest, records);
    if (!result.ok) throw new Error('catalog failed');
    return { catalog: result.catalog, manifest, records };
  }

  it('authenticates the complete source, then indexes only eligible records', () => {
    const { catalog } = build();
    const metadata = catalog.metadata();
    expect(metadata.source_record_count).toBe(specs.length);
    expect(metadata.eligible_record_count).toBe(2);
    expect(metadata.excluded_record_count).toBe(4);
    expect(metadata.record_count).toBe(2);
    expect(metadata.eligibility_version).toBe(ELIGIBILITY_POLICY_VERSION);
    expect(metadata.eligibility_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(catalog.size()).toBe(2);
  });

  it('never returns an excluded record in search results', () => {
    const { catalog } = build();
    const ids = catalog.search(normalizeQuery('hamburger'), 25).map((c) => c.fdc_id);
    expect(ids).not.toContain(4003);
    expect(ids).not.toContain(4004);
    expect(ids).not.toContain(4005);
    const restaurant = catalog.search(normalizeQuery('restaurant'), 25);
    expect(restaurant).toEqual([]);
  });

  it('cannot confirm an excluded FDC id via direct caller construction', () => {
    const { catalog } = build();
    const review = reviewIngredient(catalog, { name: 'bacon' });
    if (review.outcome !== 'review_required') throw new Error('expected review');
    const result = confirmIngredientReview(catalog, review, {
      kind: 'candidate',
      fdc_id: 4003,
      review_digest: review.review_digest,
    });
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') expect(result.failure.code).toBe('candidate_not_in_review_set');
  });

  it('rejects a forged review whose candidate is an excluded record', () => {
    const { catalog } = build();
    const review = JSON.parse(JSON.stringify(reviewIngredient(catalog, { name: 'bacon' })));
    review.candidates = [
      {
        fdc_id: 4003,
        data_type: 'fndds',
        description: 'BURGER KING, Hamburger',
        normalized_description: 'burger king hamburger',
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
    const result = confirmIngredientReview(catalog, review, {
      kind: 'candidate',
      fdc_id: 4003,
      review_digest: review.review_digest,
    });
    expect(result.outcome).toBe('invalid');
  });

  it('binds eligibility into the catalog digest (any excluded set change changes it)', () => {
    const a = build().catalog.metadata().catalog_digest;
    const { manifest, records } = buildMatchingBundle(
      specs.map((s) => (s.fdcId === 4001 ? { ...s, description: 'Cheese, cheddar, sharp' } : s))
    );
    const b = createReviewCatalog(manifest, records);
    if (!b.ok) throw new Error('catalog failed');
    expect(b.catalog.metadata().catalog_digest).not.toBe(a);
  });
});
