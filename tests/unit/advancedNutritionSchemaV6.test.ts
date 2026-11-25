/**
 * SINC-4 — schema-v6 supplemental nutrient contract.
 *
 * v6 is the smallest truthful extension of v5: a closed `nutrient_supplements`
 * array of separately attributed AI estimates. A supplement-only block is valid;
 * both arrays are optional, but at least one must be present. v5 (and older)
 * blocks remain valid and are never rewritten, and a future schema stays opaque.
 */

import { describe, expect, it } from 'vitest';

import { encodeCodexNutrition, decodeCodexNutrition, validateCodexNutrition } from '../../src/core/nutritionV2/validate';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import { AI_NUTRIENT_SUPPLEMENT_VERSION, type AiNutrientContribution } from '../../src/core/nutritionV2/aiContribution';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE = 'usda_fdc_release_2026_04';

function supplement(overrides: Record<string, unknown> = {}) {
  return {
    supplement_version: AI_NUTRIENT_SUPPLEMENT_VERSION,
    line_ref: 'flour',
    ingredient: '100 g Flour, wheat, white',
    nutrient_id: 'niacin',
    amount: 1.2,
    unit: 'mg_ne',
    classification: 'ai_estimate',
    source_kind: 'ai_supplement',
    source_food_id: '6001',
    source_release: RELEASE,
    weight_grams: 100,
    quantity_basis: '100 g resolved source weight',
    assumptions: ['Typical refined flour niacin content assumed.'],
    confidence: 'medium',
    recipe_digest: DIGEST,
    review_identity: 'review_v1:test',
    ...overrides,
  };
}

function aiContribution(): AiNutrientContribution {
  return {
    line_ref: 'gochujang',
    ingredient: '1 tbsp gochujang',
    quantity_basis: 'one tablespoon',
    weight_grams: 16,
    disposition: 'edible',
    exclusion_role: 'none',
    exclusion_assumption: '',
    classification: 'ai_estimate',
    nutrients: { sodium: { amount: 800, unit: 'mg' } },
    unknown_nutrients: [],
    assumptions: ['Synthetic estimate.'],
    confidence: 'medium',
    sources: [],
  } as AiNutrientContribution;
}

function v6(overrides: Record<string, unknown> = {}) {
  return {
    schema: 6,
    basis: 'total',
    servings: 4,
    status: 'complete',
    computed_at: '2026-11-23T00:00:00.000Z',
    ingredient_digest: DIGEST,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc', 'ai_estimate'],
    source_releases: { usda_fdc: RELEASE },
    nutrient_scope: ['calories', 'niacin'],
    nutrients: {
      calories: {
        amount: 364,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 1,
      },
      niacin: {
        amount: 1.2,
        unit: 'mg_ne',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 1,
      },
    },
    ingredients: [{
      line_ref: 'flour',
      source: 'usda_fdc',
      source_food_id: '6001',
      source_release: RELEASE,
      match_status: 'confirmed',
      resolved: true,
      user_confirmed: true,
      amount: { value: 100, unit: 'g' },
      conversion_basis: 'direct_mass',
      source_nutrients: ['calories'],
    }],
    unresolved: [],
    nutrient_supplements: [supplement()],
    source_amounts: { calories: 364 },
    ...overrides,
  };
}

describe('SINC-4 — schema v6 supplemental nutrients', () => {
  it('accepts a supplement-only v6 block and round-trips it through the codec', () => {
    const decoded = decodeCodexNutrition(v6());
    expect(decoded.kind).toBe('v6');
    if (decoded.kind !== 'v6') return;
    expect(decoded.value.nutrient_supplements).toHaveLength(1);
    expect(decoded.value.nutrient_supplements?.[0]).toMatchObject({
      line_ref: 'flour',
      nutrient_id: 'niacin',
      amount: 1.2,
      unit: 'mg_ne',
      source_kind: 'ai_supplement',
      classification: 'ai_estimate',
      source_food_id: '6001',
      source_release: RELEASE,
      weight_grams: 100,
      recipe_digest: DIGEST,
    });
    expect(decoded.value.ai_contributions).toBeUndefined();

    const encoded = encodeCodexNutrition(decoded.value);
    expect(encoded.schema).toBe(6);
    expect(encoded.nutrient_supplements).toEqual(decoded.value.nutrient_supplements);
    expect(encoded.source_amounts).toEqual({ calories: 364 });
    expect((encoded.ingredients as Array<{ source_nutrients?: string[] }>)[0]?.source_nutrients).toEqual(['calories']);
    expect(encoded.ai_contributions).toBeUndefined();
    expect(decodeCodexNutrition(encoded).kind).toBe('v6');
  });

  it('accepts AI line contributions and supplements together', () => {
    const base = v6();
    const decoded = decodeCodexNutrition(v6({
      nutrient_scope: ['calories', 'niacin', 'sodium'],
      nutrients: {
        calories: { ...base.nutrients.calories, status: 'partial', coverage: 0.5, measurable_ingredient_count: 2 },
        niacin: { ...base.nutrients.niacin, status: 'partial', coverage: 0.5, measurable_ingredient_count: 2 },
        sodium: {
          amount: 800,
          unit: 'mg',
          status: 'partial',
          coverage: 0.5,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 2,
        },
      },
      ai_contributions: [aiContribution()],
    }));
    expect(decoded.kind).toBe('v6');
    if (decoded.kind !== 'v6') return;
    expect(decoded.value.ai_contributions).toHaveLength(1);
    expect(decoded.value.nutrient_supplements).toHaveLength(1);
  });

  it('accepts a multi-line source + AI + supplement block with truthful coverage counts', () => {
    const base = v6();
    const secondSource = {
      ...base.ingredients[0],
      line_ref: 'flour-2',
      source_food_id: '6002',
      source_nutrients: [],
    };
    const decoded = decodeCodexNutrition({
      ...base,
      nutrient_scope: ['calories', 'sodium', 'niacin'],
      nutrients: {
        calories: {
          amount: 364,
          unit: 'kcal',
          status: 'partial',
          coverage: 1 / 3,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 3,
        },
        sodium: {
          amount: 800,
          unit: 'mg',
          status: 'partial',
          coverage: 1 / 3,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 3,
        },
        niacin: {
          amount: 1.2,
          unit: 'mg_ne',
          status: 'partial',
          coverage: 1 / 3,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 3,
        },
      },
      ingredients: [base.ingredients[0], secondSource],
      source_amounts: { calories: 364 },
      ai_contributions: [aiContribution()],
      nutrient_supplements: [supplement()],
    });
    expect(decoded.kind).toBe('v6');
  });

  it('rejects a v6 block with neither AI contributions nor supplements', () => {
    expect(validateCodexNutrition(v6({ nutrient_supplements: undefined })).ok).toBe(false);
  });

  it('rejects Sol Light\'s forged saved block: verified calories plus a calorie supplement', () => {
    const forged = v6({
      nutrient_supplements: [supplement({ nutrient_id: 'calories', unit: 'kcal', amount: 100 })],
    });
    const validation = validateCodexNutrition(forged);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('invalid_nutrient_supplements');
    const decoded = decodeCodexNutrition(forged);
    expect(decoded.kind).toBe('malformed');
  });

  it('fails closed when a persisted supplement has no trustworthy source coverage', () => {
    const base = v6();
    const ingredients = base.ingredients.map(({ source_nutrients: _coverage, ...entry }) => entry);
    const forged = { ...base, ingredients };
    delete (forged as { source_amounts?: unknown }).source_amounts;
    const validation = validateCodexNutrition(forged);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error === 'source_coverage_missing' || error === 'invalid_nutrient_supplements')).toBe(true);
    expect(decodeCodexNutrition(forged).kind).toBe('malformed');
  });

  it('rejects an arbitrary source-coverage list that conflicts with the persisted source amount', () => {
    const base = v6();
    const forged = {
      ...base,
      ingredients: base.ingredients.map((entry) => ({ ...entry, source_nutrients: [] })),
      // The source amount still proves flour contributed calories, but the
      // coverage list now claims no source nutrient. That is not independent
      // proof and must fail closed.
      source_amounts: { calories: 364 },
      nutrient_supplements: [supplement({ nutrient_id: 'calories', unit: 'kcal', amount: 364 })],
    };
    expect(validateCodexNutrition(forged).ok).toBe(false);
    expect(decodeCodexNutrition(forged).kind).toBe('malformed');
  });

  it('does not allow supplementing an explicit source zero', () => {
    const base = v6();
    const forged = {
      ...base,
      nutrient_scope: ['calories', 'fiber', 'niacin'],
      nutrients: {
        ...base.nutrients,
        fiber: {
          amount: 0,
          unit: 'g',
          status: 'complete',
          coverage: 1,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 1,
        },
      },
      ingredients: base.ingredients.map((entry) => ({
        ...entry,
        source_nutrients: ['calories', 'fiber'],
      })),
      source_amounts: { calories: 364, fiber: 0 },
      nutrient_supplements: [supplement({ nutrient_id: 'fiber', unit: 'g', amount: 1 })],
    };
    expect(validateCodexNutrition(forged).ok).toBe(false);
    expect(decodeCodexNutrition(forged).kind).toBe('malformed');
  });

  it('rejects an empty array in either v6 evidence slot', () => {
    expect(validateCodexNutrition(v6({ nutrient_supplements: [] })).ok).toBe(false);
    expect(validateCodexNutrition(v6({ ai_contributions: [] })).ok).toBe(false);
  });

  it('rejects a supplement that claims USDA-only provenance', () => {
    expect(validateCodexNutrition(v6({ sources: ['usda_fdc'] })).ok).toBe(false);
  });

  it('rejects a supplement bound to a source line that is not resolved USDA evidence', () => {
    const result = validateCodexNutrition(v6({
      ingredients: [],
      unresolved: [{ line_ref: 'flour', reason: 'no_match' }],
    }));
    expect(result.ok).toBe(false);
  });

  it('rejects a source identity, release, weight, or unit mismatch', () => {
    expect(validateCodexNutrition(v6({ nutrient_supplements: [supplement({ source_food_id: '9999' })] })).ok).toBe(false);
    expect(validateCodexNutrition(v6({ nutrient_supplements: [supplement({ source_release: 'other' })] })).ok).toBe(false);
    expect(validateCodexNutrition(v6({ nutrient_supplements: [supplement({ weight_grams: 90 })] })).ok).toBe(false);
    expect(validateCodexNutrition(v6({ nutrient_supplements: [supplement({ unit: 'g' })] })).ok).toBe(false);
  });

  it('rejects stale recipe binding and duplicate line+nutrient supplements', () => {
    expect(validateCodexNutrition(v6({
      nutrient_supplements: [supplement({ recipe_digest: `sha256:${'b'.repeat(64)}` })],
    })).ok).toBe(false);
    expect(validateCodexNutrition(v6({
      nutrient_supplements: [supplement(), supplement()],
    })).ok).toBe(false);
  });

  it('keeps a genuine v5 block valid and distinct', () => {
    const v6Base = v6();
    const block: Record<string, unknown> = {
      ...v6Base,
      schema: 5,
      ingredients: v6Base.ingredients.map(({ source_nutrients: _coverage, ...entry }) => entry),
      nutrient_scope: ['calories', 'sodium'],
      nutrients: {
        calories: v6().nutrients.calories,
        sodium: {
          amount: 800,
          unit: 'mg',
          status: 'complete',
          coverage: 1,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 1,
        },
      },
      ai_contributions: [aiContribution()],
    };
    delete block.nutrient_supplements;
    delete block.source_amounts;
    const decoded = decodeCodexNutrition(block);
    expect(decoded.kind).toBe('v5');
    if (decoded.kind !== 'v5') return;
    expect(decoded.value.ai_contributions).toHaveLength(1);
    expect('nutrient_supplements' in decoded.value).toBe(false);
  });

  it('preserves an unknown future schema as bounded opaque data', () => {
    const future = { ...v6(), schema: 7 };
    const decoded = decodeCodexNutrition(future);
    expect(decoded.kind).toBe('opaque');
    if (decoded.kind === 'opaque') expect(decoded.value.schema).toBe(7);
  });
});
