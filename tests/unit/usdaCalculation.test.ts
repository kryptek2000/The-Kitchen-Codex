import { describe, it, expect } from 'vitest';
import {
  createNutritionCalculationContext,
  calculateRecipeNutrition,
  reviewFoodPortions,
} from '../../src/core/nutritionV2/calculation/context';
import {
  derivePerServing,
  deriveRequestedServing,
  isValidStrictServingCount,
} from '../../src/core/nutritionV2/calculation/servings';
import { deriveDailyValue } from '../../src/core/nutritionV2/calculation/dailyValues';
import { roundCanonicalTotal } from '../../src/core/nutritionV2/calculation/numeric';
import { createReviewCatalog, reviewIngredient } from '../../src/core/nutritionV2/matching/review';
import type { ReviewCatalog } from '../../src/core/nutritionV2/matching/types';
import {
  buildCalculationBundle,
  CALC_FOODS,
  type CalcRecordSpec,
} from '../fixtures/usdaCalculationFixtures';

function buildContext(specs: ReadonlyArray<CalcRecordSpec> = CALC_FOODS) {
  const bundle = buildCalculationBundle(specs);
  const result = createNutritionCalculationContext(bundle.manifest, bundle.records);
  if (!result.ok) {
    throw new Error(`context failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  }
  return { ...bundle, context: result.context };
}

function phase2Catalog(bundle: ReturnType<typeof buildCalculationBundle>): ReviewCatalog {
  const result = createReviewCatalog(bundle.manifest, bundle.records);
  if (!result.ok) throw new Error('catalog failed');
  return result.catalog;
}

function codeOf(result: ReturnType<typeof calculateRecipeNutrition>): string | undefined {
  return result.ok ? undefined : (result as { ok: false; failure: { code: string } }).failure.code;
}

const SCOPE = ['calories', 'protein', 'carbohydrates', 'fat', 'sodium', 'fiber'] as const;

describe('phase 3 context — authority and construction', () => {
  it('builds a genuine context with bounded metadata', () => {
    const { context } = buildContext();
    const metadata = context.metadata();
    expect(metadata.calculation_version).toBe('usda_advisory_calc_v2');
    expect(metadata.bundle_release).toMatch(/^usda_fdc_/);
    expect(metadata.catalog_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.record_count).toBe(CALC_FOODS.length);
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it('rejects structural fakes, clones, proxies, and inherited objects', () => {
    const { context } = buildContext();
    const request = {
      servings: 1,
      nutrient_scope: ['protein'],
      ingredients: [{ line_ref: 'a', ingredient: '100 g Flour, wheat, white' }],
    };
    expect(codeOf(calculateRecipeNutrition({ metadata: () => context.metadata() }, request))).toBe(
      'invalid_context'
    );
    expect(codeOf(calculateRecipeNutrition({ ...context }, request))).toBe('invalid_context');
    expect(codeOf(calculateRecipeNutrition(new Proxy(context, {}), request))).toBe('invalid_context');
    expect(codeOf(calculateRecipeNutrition(Object.create(context), request))).toBe('invalid_context');
    expect(codeOf(calculateRecipeNutrition(null, request))).toBe('invalid_context');
    expect(codeOf(calculateRecipeNutrition(42, request))).toBe('invalid_context');
  });

  it('rejects invalid manifests, one bad record, duplicate ids, and mismatches', () => {
    const bundle = buildCalculationBundle(CALC_FOODS);
    expect(createNutritionCalculationContext({ ...bundle.manifest, extra: true }, bundle.records).ok).toBe(false);
    expect(createNutritionCalculationContext(bundle.manifest, [null]).ok).toBe(false);
    expect(createNutritionCalculationContext(bundle.manifest, []).ok).toBe(false);

    const tampered = JSON.parse(JSON.stringify(bundle.records[0]));
    tampered.description = 'Tampered without digest update';
    expect(createNutritionCalculationContext(bundle.manifest, [tampered, ...bundle.records.slice(1)]).ok).toBe(false);

    const wrongCount = { ...bundle.manifest, canonical_record_count: bundle.records.length + 1 };
    expect(createNutritionCalculationContext(wrongCount, bundle.records).ok).toBe(false);
    const wrongDigest = { ...bundle.manifest, canonical_content_digest: 'f'.repeat(64) };
    expect(createNutritionCalculationContext(wrongDigest, bundle.records).ok).toBe(false);
  });

  it('does not expose the private record index or authority', () => {
    const { context } = buildContext();
    expect(Object.keys(context)).toEqual(['metadata']);
    expect((context as unknown as Record<string, unknown>).records).toBeUndefined();
    expect((context as unknown as Record<string, unknown>).catalog).toBeUndefined();
    expect(JSON.stringify(context)).not.toMatch(/amount_per_100g|nutrients|record_digest/);
  });
});

describe('phase 3 calculation — golden totals and coverage', () => {
  it('computes hand-checked entire-recipe totals and nutrient-specific coverage', () => {
    const { context } = buildContext();
    const result = calculateRecipeNutrition(context, {
      servings: 4,
      nutrient_scope: [...SCOPE],
      ingredients: [
        { line_ref: 'flour', ingredient: '200 g Flour, wheat, white' },
        { line_ref: 'butter', ingredient: { name: 'Butter, salted', amount: 50, unit: 'g' } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const totals = result.preview.totals;
    expect(totals.calories?.amount).toBeCloseTo(1086.5, 6);
    expect(totals.protein?.amount).toBeCloseTo(21.025, 6);
    expect(totals.carbohydrates?.amount).toBeCloseTo(152.63, 6);
    expect(totals.fat?.amount).toBeCloseTo(42.55, 6);
    expect(totals.sodium?.amount).toBeCloseTo(321.5, 6);
    expect(totals.fiber?.amount).toBeCloseTo(5.4, 6);
    expect(totals.sodium?.coverage).toBe(0.5);
    expect(totals.sodium?.status).toBe('partial');
    expect(totals.calories?.status).toBe('complete');
    expect(result.preview.basis).toBe('total');
    expect(result.preview.status).toBe('partial');
    expect(result.preview.advisory_only).toBe(true);
    expect(result.preview.application_authorized).toBe(false);
  });

  it('omits a nutrient entirely when covered is zero (missing stays absent)', () => {
    const { context } = buildContext();
    const result = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories', 'sodium'],
      ingredients: [{ line_ref: 'flour', ingredient: '100 g Flour, wheat, white' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('sodium' in result.preview.totals).toBe(false);
    expect(result.preview.totals.calories?.status).toBe('complete');
    expect(result.preview.status).toBe('partial');
  });

  it('preserves an explicit USDA zero as a present contribution', () => {
    const { context } = buildContext([
      { fdcId: 4001, dataType: 'foundation', description: 'Water, tap', nutrients: { calories: 0, sodium: 0 } },
    ]);
    const result = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories', 'sodium'],
      ingredients: [{ line_ref: 'w', ingredient: '250 g Water, tap' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.totals.calories?.amount).toBe(0);
    expect(result.preview.totals.sodium?.amount).toBe(0);
    expect(result.preview.totals.calories?.status).toBe('complete');
    expect(result.preview.status).toBe('complete');
  });

  it('reduces coverage for an unmatched and a no-mass ingredient', () => {
    const { context } = buildContext();
    const result = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        { line_ref: 'flour', ingredient: '100 g Flour, wheat, white' },
        { line_ref: 'mystery', ingredient: '100 g Unobtainium powder' },
        { line_ref: 'vol', ingredient: '1 cup Flour, wheat, white' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.totals.calories?.measurable_ingredient_count).toBe(3);
    expect(result.preview.totals.calories?.covered_ingredient_count).toBe(1);
    expect(result.preview.totals.calories?.coverage).toBeCloseTo(1 / 3, 12);
    expect(result.preview.status).toBe('partial');
    const outcomes = result.preview.ingredients.map((i) => i.outcome);
    expect(outcomes).toEqual(['calculated', 'no_match', 'no_mass']);
    expect(result.preview.unresolved.map((u) => u.outcome).sort()).toEqual(['no_mass', 'no_match']);
  });

  it('handles qualitative ingredients without entering the denominator', () => {
    const { context } = buildContext();
    const result = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        { line_ref: 'flour', ingredient: '100 g Flour, wheat, white' },
        { line_ref: 'salt', ingredient: 'salt to taste' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.totals.calories?.measurable_ingredient_count).toBe(1);
    expect(result.preview.totals.calories?.coverage).toBe(1);
    expect(result.preview.status).toBe('complete');
    expect(result.preview.ingredients[1].outcome).toBe('qualitative');
    expect(result.preview.unresolved).toHaveLength(0);
  });

  it('treats a quantified ingredient containing a qualitative phrase as material', () => {
    const { context } = buildContext();
    const result = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: 'b',
          ingredient: { name: 'Butter, salted', amount: 50, unit: 'g', original: 'Butter, salted, as needed' },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].qualitative).toBe(false);
    expect(result.preview.ingredients[0].outcome).toBe('calculated');
    expect(result.preview.totals.calories?.measurable_ingredient_count).toBe(1);
  });
});

describe('phase 3 calculation — match rebinding', () => {
  it('uses an automatic unique-exact identity without claiming user confirmation', () => {
    const { context } = buildContext();
    const result = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['protein'],
      ingredients: [{ line_ref: 'a', ingredient: '100 g Flour, wheat, white' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].match_status).toBe('unique_exact');
    expect(result.preview.ingredients[0].user_confirmed).toBe(false);
  });

  it('requires a genuine confirmation for an ambiguous match and rebinds it', () => {
    const bundle = buildCalculationBundle(CALC_FOODS);
    const contextResult = createNutritionCalculationContext(bundle.manifest, bundle.records);
    if (!contextResult.ok) throw new Error('context failed');
    const catalog = phase2Catalog(bundle);

    const ingredient = { name: 'flour wheat' };
    const review = reviewIngredient(catalog, ingredient);
    expect(review.outcome).toBe('review_required');
    const fdcId = review.candidates.find((c) => c.fdc_id === 3001)?.fdc_id as number;
    const selection = { kind: 'candidate' as const, fdc_id: fdcId, review_digest: review.review_digest as string };

    const result = calculateRecipeNutrition(contextResult.context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient, review, selection }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].match_status).toBe('user_confirmed');
    expect(result.preview.ingredients[0].user_confirmed).toBe(true);
    expect(result.preview.ingredients[0].fdc_id).toBe(3001);
  });

  it('treats a rejected, missing, forged, stale, or wrong-id confirmation as unresolved', () => {
    const bundle = buildCalculationBundle(CALC_FOODS);
    const contextResult = createNutritionCalculationContext(bundle.manifest, bundle.records);
    if (!contextResult.ok) throw new Error('context failed');
    const catalog = phase2Catalog(bundle);
    const ingredient = { name: 'flour wheat' };
    const review = reviewIngredient(catalog, ingredient);
    const digest = review.review_digest as string;

    const cases: unknown[] = [
      undefined, // missing
      { kind: 'none', review_digest: digest }, // rejected
      { kind: 'candidate', fdc_id: 3001, review_digest: 'f'.repeat(64) }, // stale digest
      { kind: 'candidate', fdc_id: 999999, review_digest: digest }, // wrong id
      { kind: 'candidate', fdc_id: 3001, review_digest: 'not-a-digest' }, // malformed
    ];
    for (const selection of cases) {
      const result = calculateRecipeNutrition(contextResult.context, {
        servings: 1,
        nutrient_scope: ['calories'],
        ingredients: [{ line_ref: 'a', ingredient, review, ...(selection ? { selection } : {}) }],
      });
      expect(result.ok, JSON.stringify(selection)).toBe(true);
      if (!result.ok) continue;
      expect(result.preview.ingredients[0].outcome).toBe('ambiguous');
      expect(result.preview.ingredients[0].fdc_id).toBeUndefined();
    }
  });

  it('treats a review for a different ingredient as stale (unresolved)', () => {
    const bundle = buildCalculationBundle(CALC_FOODS);
    const contextResult = createNutritionCalculationContext(bundle.manifest, bundle.records);
    if (!contextResult.ok) throw new Error('context failed');
    const catalog = phase2Catalog(bundle);
    const review = reviewIngredient(catalog, { name: 'flour wheat' });
    const selection = { kind: 'candidate' as const, fdc_id: 3001, review_digest: review.review_digest as string };
    const result = calculateRecipeNutrition(contextResult.context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: { name: 'butter salted' }, review, selection }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The current ingredient ("butter salted") is a unique exact match, so the
    // automatic identity wins; the stale confirmation is irrelevant.
    expect(result.preview.ingredients[0].fdc_id).toBe(3002);
    expect(result.preview.ingredients[0].user_confirmed).toBe(false);
  });

  it('rejects a hostile selection (unsafe) as invalid input', () => {
    const bundle = buildCalculationBundle(CALC_FOODS);
    const contextResult = createNutritionCalculationContext(bundle.manifest, bundle.records);
    if (!contextResult.ok) throw new Error('context failed');
    const catalog = phase2Catalog(bundle);
    const review = reviewIngredient(catalog, { name: 'flour wheat' });
    const accessor: Record<string, unknown> = { kind: 'candidate' };
    Object.defineProperty(accessor, 'review_digest', { enumerable: true, get: () => review.review_digest });
    const result = calculateRecipeNutrition(contextResult.context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: { name: 'flour wheat' }, review, selection: accessor }],
    });
    // The whole-request materialization rejects the hostile accessor first.
    expect(codeOf(result)).toBe('unsafe_request');
  });
});

describe('phase 3 mass — direct mass and source portions', () => {
  function calc(context: unknown, ingredient: unknown, scope: readonly string[] = ['calories']) {
    return calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: [...scope],
      ingredients: [{ line_ref: 'a', ingredient }],
    });
  }

  it('resolves g/kg/oz/lb direct mass', () => {
    const { context } = buildContext();
    const grams = (ingredient: unknown): number | undefined => {
      const result = calc(context, ingredient);
      if (!result.ok) throw new Error('failed');
      return result.preview.ingredients[0].resolved_grams;
    };
    expect(grams('100 g Flour, wheat, white')).toBe(100);
    expect(grams('1 kg Flour, wheat, white')).toBe(1000);
    expect(grams('1 oz Flour, wheat, white')).toBeCloseTo(28.349523125, 9);
    expect(grams('1 lb Flour, wheat, white')).toBeCloseTo(453.59237, 9);
  });

  it('resolves explicit zero and rejects missing/negative/-0 amounts', () => {
    const { context } = buildContext();
    const zero = calc(context, { name: 'Flour, wheat, white', amount: 0, unit: 'g' });
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(zero.preview.ingredients[0].resolved_grams).toBe(0);

    const missing = calc(context, { name: 'Flour, wheat, white', unit: 'g' });
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.preview.ingredients[0].outcome).toBe('no_mass');

    expect(codeOf(calc(context, { name: 'Flour, wheat, white', amount: -5, unit: 'g' }))).toBe(
      'invalid_ingredient_input'
    );
    expect(codeOf(calc(context, { name: 'Flour, wheat, white', amount: -0, unit: 'g' }))).toBe(
      'invalid_ingredient_input'
    );
  });

  it('does not convert volume or count to mass without a selected portion', () => {
    const { context } = buildContext();
    for (const ingredient of ['2 cups Flour, wheat, white', '3 Flour, wheat, white']) {
      const result = calc(context, ingredient);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.preview.ingredients[0].outcome).toBe('no_mass');
        expect(result.preview.ingredients[0].resolved_grams).toBeUndefined();
      }
    }
  });

  it('resolves a source portion only when explicitly selected and bound', () => {
    const bundle = buildCalculationBundle(CALC_FOODS);
    const contextResult = createNutritionCalculationContext(bundle.manifest, bundle.records);
    if (!contextResult.ok) throw new Error('context failed');
    const context = contextResult.context;

    const identityRun = calc(context, '2 cups Flour, wheat, white');
    expect(identityRun.ok).toBe(true);
    if (!identityRun.ok) return;
    const identity = identityRun.preview.ingredients[0];
    expect(identity.outcome).toBe('no_mass');

    const portions = reviewFoodPortions(context, 3001);
    expect(portions.ok).toBe(true);
    if (!portions.ok) return;
    const cup = portions.review.candidates[0];
    const selection = {
      calculation_version: 'usda_advisory_calc_v2',
      portion_semantics_version: portions.review.portion_semantics_version,
      line_ref: 'a',
      ingredient_identity_digest: identity.ingredient_identity_digest,
      bundle_release: identityRun.preview.bundle_release,
      fdc_id: 3001,
      record_digest: identity.record_digest as string,
      candidates_digest: portions.review.candidates_digest,
      portion_index: cup.index,
      portion_amount: cup.effective_amount as number,
      measure: cup.measure,
      gram_weight: cup.gram_weight,
      semantics_kind: cup.kind,
      semantics_unit: cup.unit,
      semantics_volume_ml: cup.volume_ml,
      semantics_amount: cup.effective_amount,
      semantics_gram_weight: cup.gram_weight,
    };
    const result = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: '2 cups Flour, wheat, white', portion_selection: selection }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].mass_source).toBe('source_portion');
    expect(result.preview.ingredients[0].resolved_grams).toBeCloseTo(250, 6);
    expect(result.preview.totals.calories?.amount).toBeCloseTo(910, 6);
  });

  it('rejects a stale portion selection and treats an absent source amount as no_mass', () => {
    const bundle = buildCalculationBundle(CALC_FOODS);
    const contextResult = createNutritionCalculationContext(bundle.manifest, bundle.records);
    if (!contextResult.ok) throw new Error('context failed');
    const context = contextResult.context;
    const identityRun = calc(context, '2 cups Flour, wheat, white');
    if (!identityRun.ok) throw new Error('failed');
    const identity = identityRun.preview.ingredients[0];

    // Stale candidate digest -> no_mass (not a fake mass).
    const stale = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: 'a',
          ingredient: '2 cups Flour, wheat, white',
          portion_selection: {
            calculation_version: 'usda_advisory_calc_v2',
            portion_semantics_version: 'usda_portion_semantics_v1',
            line_ref: 'a',
            ingredient_identity_digest: identity.ingredient_identity_digest,
            bundle_release: identityRun.preview.bundle_release,
            fdc_id: 3001,
            record_digest: identity.record_digest as string,
            candidates_digest: 'f'.repeat(64),
            portion_index: 0,
            portion_amount: 1,
            measure: 'cup',
            gram_weight: 125,
            semantics_kind: 'volume',
            semantics_unit: 'cup',
            semantics_volume_ml: 236.5882365,
            semantics_amount: 1,
            semantics_gram_weight: 125,
          },
        },
      ],
    });
    expect(stale.ok).toBe(true);
    if (stale.ok) expect(stale.preview.ingredients[0].outcome).toBe('no_mass');

    // FNDDS portion with no source amount -> no_mass.
    const fndds = calc(context, '1 teaspoon Salt, table');
    expect(fndds.ok).toBe(true);
    if (fndds.ok) expect(fndds.preview.ingredients[0].outcome).toBe('no_mass');
  });
});

describe('phase 3 numeric policy', () => {
  it('rounds once to at most six decimal places and sums stably', () => {
    const { context } = buildContext([
      { fdcId: 5001, dataType: 'foundation', description: 'Tiny, food', nutrients: { calories: 1 } },
      { fdcId: 5002, dataType: 'foundation', description: 'Precise, food', nutrients: { calories: 0.123456 } },
    ]);
    const tiny = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: '0.00001 g Tiny, food' }],
    });
    expect(tiny.ok).toBe(true);
    if (tiny.ok) expect(tiny.preview.totals.calories?.amount).toBe(0);

    const precise = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: '1 g Precise, food' }],
    });
    expect(precise.ok).toBe(true);
    if (precise.ok) expect(precise.preview.totals.calories?.amount).toBeCloseTo(0.001235, 9);
  });

  it('is invariant to ingredient iteration order', () => {
    const { context } = buildContext();
    const ingredients = [
      { line_ref: 'a', ingredient: '100 g Flour, wheat, white' },
      { line_ref: 'b', ingredient: '50 g Butter, salted' },
      { line_ref: 'c', ingredient: '30 g Flour, wheat, white' },
    ];
    const forward = calculateRecipeNutrition(context, { servings: 1, nutrient_scope: ['calories', 'fat'], ingredients });
    const reversed = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['fat', 'calories'],
      ingredients: [...ingredients].reverse(),
    });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(forward.preview.totals.calories?.amount).toBe(reversed.preview.totals.calories?.amount);
    expect(forward.preview.totals.fat?.amount).toBe(reversed.preview.totals.fat?.amount);
  });

  it('detects overflow instead of clamping to zero', () => {
    const { context } = buildContext([
      { fdcId: 6001, dataType: 'foundation', description: 'Huge, food', nutrients: { calories: 1_000_000_000 } },
    ]);
    const result = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: '1000 kg Huge, food' }],
    });
    expect(codeOf(result)).toBe('numeric_overflow');
  });

  it('binds the selected record digest into the ingredient identity digest', () => {
    const a = buildContext([
      { fdcId: 7001, dataType: 'foundation', description: 'Same, food', nutrients: { calories: 1 } },
    ]);
    const b = buildContext([
      { fdcId: 7001, dataType: 'foundation', description: 'Same, food', nutrients: { calories: 2 } },
    ]);
    const run = (context: unknown) =>
      calculateRecipeNutrition(context, {
        servings: 1,
        nutrient_scope: ['calories'],
        ingredients: [{ line_ref: 'a', ingredient: '100 g Same, food' }],
      });
    const ra = run(a.context);
    const rb = run(b.context);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(ra.preview.ingredients[0].record_digest).not.toBe(rb.preview.ingredients[0].record_digest);
    expect(ra.preview.ingredients[0].ingredient_identity_digest).not.toBe(
      rb.preview.ingredients[0].ingredient_identity_digest
    );
  });

  it('is invariant to ingredient iteration order even when summation is order-sensitive', () => {
    const N = 200;
    let seed = 28 >>> 0;
    const amounts: number[] = [];
    for (let i = 0; i < N; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      amounts.push(Math.round((seed / 0x100000000) * 4e6 * 1e6) / 1e6);
    }
    const specs = amounts.map((amount, i) => ({
      fdcId: 10000 + i,
      dataType: 'foundation' as const,
      description: `Order food ${i}`,
      nutrients: { calories: amount },
    }));
    const { context } = buildContext(specs);
    const ingredients = amounts.map((_, i) => ({ line_ref: `r${i}`, ingredient: `100 g Order food ${i}` }));
    const forward = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients,
    });
    const reversed = calculateRecipeNutrition(context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [...ingredients].reverse(),
    });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(forward.preview.totals.calories?.amount).toBe(reversed.preview.totals.calories?.amount);
  });

  it('never stores %DV or a Phase 0 schema marker in the advisory preview', () => {
    const { context } = buildContext();
    const result = calculateRecipeNutrition(context, {
      servings: 2,
      nutrient_scope: ['calories', 'protein', 'sodium'],
      ingredients: [{ line_ref: 'a', ingredient: '100 g Flour, wheat, white' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.preview);
    expect(serialized).not.toMatch(/%dv/i);
    expect(serialized).not.toMatch(/"dv"|daily_value|dailyValue/i);
    expect(serialized).not.toMatch(/codex_nutrition|computed_at/);
    expect('schema' in result.preview).toBe(false);
  });

  it('does not mutate totals across repeated calls', () => {
    const { context } = buildContext();
    const request = {
      servings: 2,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: '100 g Flour, wheat, white' }],
    };
    const first = calculateRecipeNutrition(context, request);
    const second = calculateRecipeNutrition(context, request);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.preview.totals.calories?.amount).toBe(second.preview.totals.calories?.amount);
    expect(first.preview.ingredient_digest).toBe(second.preview.ingredient_digest);
  });
});

describe('phase 3 rounding contract — binary floating-point, not decimal', () => {
  const inputs = [
    0,
    1,
    0.1 + 0.2,
    0.0000004,
    0.0000005,
    0.0000015,
    1.0000005,
    2.675,
    1.005,
    123.456789,
    1 / 3,
    2 / 3,
    999999999.999999,
  ];

  it('equals Math.round(value * 1_000_000) / 1_000_000 for representative binary doubles', () => {
    for (const value of inputs) {
      expect(roundCanonicalTotal(value)).toBe(Math.round(value * 1_000_000) / 1_000_000);
    }
  });

  it('follows the represented binary value, not an abstract decimal half-away rule', () => {
    // These decimal literals have a 5 in the seventh decimal place, so they LOOK
    // like exact decimal halves at six decimal places. Their nearest IEEE-754
    // doubles lie slightly BELOW the mathematical value, so the scaled product is
    // just under a half-integer and ECMAScript Math.round rounds DOWN. This asserts
    // the JavaScript runtime behavior; no independent decimal half-away-from-zero
    // guarantee is claimed.
    for (const value of [130.5218535, 8.2483905, 32.1427985]) {
      const scaled = value * 1_000_000;
      expect(scaled).toBeLessThan(Math.floor(scaled) + 0.5);
      expect(roundCanonicalTotal(value)).toBe(Math.floor(scaled) / 1_000_000);
      expect(roundCanonicalTotal(value)).toBe(Math.round(scaled) / 1_000_000);
    }
  });
});

describe('phase 3 request validation', () => {
  const validRequest = {
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [{ line_ref: 'a', ingredient: '100 g Flour, wheat, white' }],
  };

  it('rejects invalid servings, scope, ingredients, and line refs', () => {
    const { context } = buildContext();
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, servings: '4' }))).toBe('invalid_servings');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, servings: 0 }))).toBe('invalid_servings');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, servings: 1001 }))).toBe('invalid_servings');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, nutrient_scope: [] }))).toBe('invalid_nutrient_scope');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, nutrient_scope: ['nope'] }))).toBe('invalid_nutrient_scope');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, nutrient_scope: ['calories', 'calories'] }))).toBe('invalid_nutrient_scope');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, ingredients: [] }))).toBe('empty_ingredients');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, ingredients: [{ line_ref: 'a', ingredient: 'x' }, { line_ref: 'a', ingredient: 'y' }] }))).toBe('duplicate_line_ref');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, extra: 1 }))).toBe('unknown_field');
    expect(codeOf(calculateRecipeNutrition(context, { ...validRequest, ingredients: [{ line_ref: 'a', ingredient: 'x', evil: 1 }] }))).toBe('unknown_field');
  });

  it('rejects hostile request values without throwing', () => {
    const { context } = buildContext();
    const accessor: Record<string, unknown> = { nutrient_scope: ['calories'], ingredients: [] };
    Object.defineProperty(accessor, 'servings', { enumerable: true, get: () => 1 });
    expect(codeOf(calculateRecipeNutrition(context, accessor))).toBe('unsafe_request');
    expect(() => calculateRecipeNutrition(context, null)).not.toThrow();
    expect(codeOf(calculateRecipeNutrition(context, null))).toBe('invalid_request');
  });
});

describe('phase 3 serving and Daily Value derivation', () => {
  it('validates servings strictly (no string coercion)', () => {
    expect(isValidStrictServingCount(4)).toBe(true);
    expect(isValidStrictServingCount(1.5)).toBe(true);
    expect(isValidStrictServingCount('4')).toBe(false);
    expect(isValidStrictServingCount(0)).toBe(false);
    expect(isValidStrictServingCount(-0)).toBe(false);
    expect(isValidStrictServingCount(1001)).toBe(false);
    expect(isValidStrictServingCount(Number.NaN)).toBe(false);
  });

  it('derives per-serving and requested-serving views from the total baseline', () => {
    expect(derivePerServing(100, 4)).toBe(25);
    expect(deriveRequestedServing(100, 4, 8)).toBe(200);
    // Repeated basis toggles derive from the same total, so they do not drift.
    const total = 1086.5;
    const perServing = derivePerServing(total, 4);
    expect(deriveRequestedServing(total, 4, 4)).toBeCloseTo(perServing * 4, 9);
  });

  it('keeps coverage unchanged by serving scaling', () => {
    const { context } = buildContext();
    const result = calculateRecipeNutrition(context, {
      servings: 8,
      nutrient_scope: ['calories', 'sodium'],
      ingredients: [{ line_ref: 'a', ingredient: '100 g Flour, wheat, white' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.servings).toBe(8);
    expect(result.preview.totals.calories?.coverage).toBe(1);
    expect('sodium' in result.preview.totals).toBe(false);
  });

  it('derives %DV: missing unavailable, explicit zero 0%, no-DV unavailable', () => {
    expect(deriveDailyValue('protein', undefined)).toEqual({ available: false, reason: 'missing' });
    expect(deriveDailyValue('protein', 0)).toEqual({ available: true, percent: 0, standard: 'fda_adult_4plus_2020' });
    expect(deriveDailyValue('protein', 25)).toEqual({ available: true, percent: 50, standard: 'fda_adult_4plus_2020' });
    expect(deriveDailyValue('trans_fat', 5)).toEqual({ available: false, reason: 'no_daily_value' });
    expect(deriveDailyValue('calories', 100)).toEqual({ available: false, reason: 'no_daily_value' });
  });
});
