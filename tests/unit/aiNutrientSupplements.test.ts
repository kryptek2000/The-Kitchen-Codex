/**
 * SINC-4 — separately attributed AI nutrient supplements.
 *
 * These tests prove the closed supplement contract: a supplement may only cover
 * a nutrient genuinely absent from a verified source-backed line, keeps its own
 * provenance, and never overwrites a source value, an explicit zero, or an
 * existing contribution. All values are synthetic.
 */

import { describe, expect, it } from 'vitest';

import {
  AI_NUTRIENT_SUPPLEMENT_VERSION,
  combineAiContributionsWithPreview,
  sumNutrientSupplements,
  validateAiNutrientSupplements,
  type AiNutrientSupplement,
  type NutrientSupplementBinding,
} from '../../src/core/nutritionV2/aiContribution';
import type { AdvisoryNutritionPreview, IngredientCalculationEvidence } from '../../src/core/nutritionV2/calculation/types';
import { NUTRIENT_REGISTRY } from '../../src/core/nutritionV2/nutrients';

const LINE_REF = 'ing:flour';
const LINE = '100 g Flour, wheat, white';
const RECIPE_DIGEST = `sha256:${'a'.repeat(64)}`;
const REVIEW_IDENTITY = 'review_v1:test-review';
const SOURCE_RELEASE = 'usda_fdc_release_2026_04';

const PRESENT: ReadonlyArray<'calories' | 'protein' | 'fiber'> = ['calories', 'protein', 'fiber'];

function sourceBinding(overrides: Partial<NutrientSupplementBinding> = {}): NutrientSupplementBinding {
  return {
    recipe_digest: RECIPE_DIGEST,
    review_identity: REVIEW_IDENTITY,
    line_text_by_ref: { [LINE_REF]: LINE },
    sources_by_ref: new Map([[LINE_REF, {
      nutrient_ids: PRESENT,
      source_food_id: '6001',
      source_release: SOURCE_RELEASE,
      weight_grams: 100,
    }]]),
    ...overrides,
  };
}

function rawSupplement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supplement_version: AI_NUTRIENT_SUPPLEMENT_VERSION,
    line_ref: LINE_REF,
    ingredient: LINE,
    nutrient_id: 'niacin',
    amount: 1.2,
    unit: 'mg_ne',
    classification: 'ai_estimate',
    source_kind: 'ai_supplement',
    source_food_id: '6001',
    source_release: SOURCE_RELEASE,
    weight_grams: 100,
    quantity_basis: '100 g resolved source weight',
    assumptions: ['Typical flour niacin content assumed; the USDA record omits niacin.'],
    confidence: 'medium',
    recipe_digest: RECIPE_DIGEST,
    review_identity: REVIEW_IDENTITY,
    ...overrides,
  };
}

function validatedSupplement(overrides: Record<string, unknown> = {}): AiNutrientSupplement {
  const result = validateAiNutrientSupplements([rawSupplement(overrides)], sourceBinding());
  if (!result.ok) throw new Error(`fixture rejected: ${(result as { code?: string }).code ?? 'invalid'}`);
  return result.supplements[0]!;
}

describe('SINC-4 — ai nutrient supplement validation', () => {
  it('accepts a supplement for a nutrient genuinely absent from the verified source line', () => {
    const result = validateAiNutrientSupplements([rawSupplement()], sourceBinding());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supplements).toHaveLength(1);
    expect(result.supplements[0]).toMatchObject({
      supplement_version: AI_NUTRIENT_SUPPLEMENT_VERSION,
      line_ref: LINE_REF,
      ingredient: LINE,
      nutrient_id: 'niacin',
      amount: 1.2,
      unit: 'mg_ne',
      classification: 'ai_estimate',
      source_kind: 'ai_supplement',
      source_food_id: '6001',
      source_release: SOURCE_RELEASE,
      weight_grams: 100,
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
    });
    expect(Object.isFrozen(result.supplements[0])).toBe(true);
    expect(Object.isFrozen(result.supplements[0]!.assumptions)).toBe(true);
  });

  it('rejects a supplement that would overwrite a verified source nutrient', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ nutrient_id: 'calories', unit: 'kcal', amount: 100 })], sourceBinding()))
      .toEqual({ ok: false, code: 'source_already_has_nutrient' });
  });

  it('rejects a supplement for an explicit source zero', () => {
    // `fiber` is a present source nutrient with an explicit 0 amount.
    expect(validateAiNutrientSupplements([rawSupplement({ nutrient_id: 'fiber', unit: 'g', amount: 1 })], sourceBinding()))
      .toEqual({ ok: false, code: 'source_already_has_nutrient' });
  });

  it('rejects duplicate line+nutrient supplements', () => {
    expect(validateAiNutrientSupplements([rawSupplement(), rawSupplement()], sourceBinding()))
      .toEqual({ ok: false, code: 'duplicate_supplement' });
  });

  it('rejects a stale recipe digest', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ recipe_digest: `sha256:${'b'.repeat(64)}` })], sourceBinding()))
      .toEqual({ ok: false, code: 'stale_recipe' });
  });

  it('rejects a stale review identity when the binding requires one', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ review_identity: 'review_v1:other' })], sourceBinding()))
      .toEqual({ ok: false, code: 'stale_review' });
  });

  it('rejects an unknown line ref', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ line_ref: 'ing:other' })], sourceBinding()))
      .toEqual({ ok: false, code: 'unknown_line_ref' });
  });

  it('rejects a wrong ingredient text', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ ingredient: '100 g Sugar' })], sourceBinding()))
      .toEqual({ ok: false, code: 'line_text_mismatch' });
  });

  it('rejects a weight basis that differs from the verified source weight', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ weight_grams: 90 })], sourceBinding()))
      .toEqual({ ok: false, code: 'weight_mismatch' });
    expect(validateAiNutrientSupplements([rawSupplement({ weight_grams: undefined })], sourceBinding()))
      .toEqual({ ok: false, code: 'missing_weight' });
  });

  it('rejects a unit that is not the canonical nutrient unit', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ nutrient_id: 'niacin', unit: 'g' })], sourceBinding()))
      .toEqual({ ok: false, code: 'unit_mismatch' });
  });

  it('rejects a non-positive or non-finite amount', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ amount: 0 })], sourceBinding()))
      .toEqual({ ok: false, code: 'invalid_amount' });
    expect(validateAiNutrientSupplements([rawSupplement({ amount: Number.NaN })], sourceBinding()))
      .toEqual({ ok: false, code: 'invalid_amount' });
  });

  it('rejects a source identity mismatch', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ source_food_id: '9999' })], sourceBinding()))
      .toEqual({ ok: false, code: 'source_identity_mismatch' });
    expect(validateAiNutrientSupplements([rawSupplement({ source_release: 'other_release' })], sourceBinding()))
      .toEqual({ ok: false, code: 'source_release_mismatch' });
  });

  it('rejects a mislabeled supplement that claims source-backed authority', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ classification: 'source_backed' })], sourceBinding()))
      .toEqual({ ok: false, code: 'invalid_supplement_classification' });
    expect(validateAiNutrientSupplements([rawSupplement({ source_kind: 'usda_fdc' })], sourceBinding()))
      .toEqual({ ok: false, code: 'invalid_supplement_classification' });
  });

  it('rejects empty assumptions and an invalid confidence', () => {
    expect(validateAiNutrientSupplements([rawSupplement({ assumptions: [] })], sourceBinding()))
      .toEqual({ ok: false, code: 'invalid_assumptions' });
    expect(validateAiNutrientSupplements([rawSupplement({ confidence: 'certain' })], sourceBinding()))
      .toEqual({ ok: false, code: 'invalid_confidence' });
  });

  it('sums supplements per nutrient and counts each line once', () => {
    const niacin = validatedSupplement();
    const addedSugars = validatedSupplement({ nutrient_id: 'added_sugars', unit: 'g', amount: 0.4 });
    const totals = sumNutrientSupplements([niacin, addedSugars]);
    expect(totals.niacin).toMatchObject({ amount: 1.2, unit: 'mg_ne', covered_ingredient_count: 1 });
    expect(totals.added_sugars).toMatchObject({ amount: 0.4, unit: 'g', covered_ingredient_count: 1 });
  });
});

function previewFixture(): AdvisoryNutritionPreview {
  const flour: IngredientCalculationEvidence = {
    line_ref: LINE_REF,
    original_text: LINE,
    outcome: 'calculated',
    qualitative: false,
    match_status: 'unique_exact',
    user_confirmed: true,
    fdc_id: 6001,
    record_digest: `sha256:${'c'.repeat(64)}`,
    mass_source: 'direct_mass',
    resolved_grams: 100,
    ingredient_identity_digest: 'identity',
    ingredient_digest: 'digest',
    contributing_nutrients: [...PRESENT],
  } as unknown as IngredientCalculationEvidence;
  return Object.freeze({
    calculation_schema: 1,
    calculation_version: 'v3',
    bundle_release: SOURCE_RELEASE,
    catalog_digest: 'catalog',
    nutrient_map_version: 'map',
    servings: 4,
    ingredient_digest: RECIPE_DIGEST,
    nutrient_scope: ['calories', 'protein', 'fiber', 'niacin', 'added_sugars'] as const,
    basis: 'total',
    status: 'partial',
    totals: Object.freeze({
      calories: Object.freeze({ amount: 364, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 1, measurable_ingredient_count: 1 }),
      protein: Object.freeze({ amount: 10.3, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 1, measurable_ingredient_count: 1 }),
      fiber: Object.freeze({ amount: 0, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 1, measurable_ingredient_count: 1 }),
    }),
    ingredients: Object.freeze([flour]),
    unresolved: Object.freeze([]),
    advisory_only: true,
    application_authorized: false,
  });
}

describe('SINC-4 — merge without overwriting or double counting', () => {
  it('adds a supplement to the nutrient total while verified values stay byte-identical', () => {
    const preview = previewFixture();
    const niacin = validatedSupplement();
    const combined = combineAiContributionsWithPreview(preview, [], [niacin]);
    expect(combined.totals.calories).toEqual(preview.totals.calories);
    expect(combined.totals.protein).toEqual(preview.totals.protein);
    expect(combined.totals.fiber).toEqual(preview.totals.fiber);
    expect(combined.totals.niacin).toMatchObject({
      amount: 1.2,
      unit: 'mg_ne',
      covered_ingredient_count: 1,
      measurable_ingredient_count: 1,
      status: 'complete',
    });
  });

  it('drops a conflicting supplement instead of double counting a source nutrient', () => {
    const preview = previewFixture();
    // Defense in depth: the validator rejects this at creation, and the combiner
    // independently refuses to add it even if a hostile state supplies it.
    const conflicting = Object.freeze({
      ...validatedSupplement(),
      nutrient_id: 'calories' as const,
      unit: 'kcal' as const,
      amount: 100,
    });
    const combined = combineAiContributionsWithPreview(preview, [], [conflicting]);
    expect(combined.totals.calories).toEqual(preview.totals.calories);
    expect(combined.nutrient_supplements).toEqual([]);
  });

  it('drops duplicate supplements from the combined preview', () => {
    const preview = previewFixture();
    const niacin = validatedSupplement();
    const combined = combineAiContributionsWithPreview(preview, [], [niacin, niacin]);
    expect(combined.nutrient_supplements).toHaveLength(1);
    expect(combined.totals.niacin?.amount).toBe(1.2);
  });

  it('keeps AI line contributions and source supplements separate and additive', () => {
    const preview = previewFixture();
    const niacin = validatedSupplement();
    const aiLineContribution = Object.freeze({
      line_ref: 'ing:unresolved',
      ingredient: '1 tbsp gochujang',
      quantity_basis: 'one tablespoon',
      weight_grams: 16,
      disposition: 'edible' as const,
      exclusion_role: 'none' as const,
      exclusion_assumption: '',
      classification: 'ai_estimate' as const,
      nutrients: Object.freeze({ niacin: Object.freeze({ amount: 0.8, unit: 'mg_ne' as const }) }),
      unknown_nutrients: Object.freeze([]),
      assumptions: Object.freeze(['Synthetic estimate.']),
      confidence: 'medium' as const,
      sources: Object.freeze([]),
    });
    const withAiLine = Object.freeze({
      ...preview,
      nutrient_scope: [...preview.nutrient_scope],
      unresolved: Object.freeze([{ line_ref: 'ing:unresolved', outcome: 'no_match' as const }]),
      totals: Object.freeze({ ...preview.totals }),
      ingredients: Object.freeze([...preview.ingredients]),
    }) as AdvisoryNutritionPreview;
    const combined = combineAiContributionsWithPreview(withAiLine, [aiLineContribution], [niacin]);
    // 1.2 mg from the source-line supplement + 0.8 mg from the AI-estimated line.
    expect(combined.totals.niacin?.amount).toBe(2);
    expect(combined.totals.niacin?.unit).toBe(NUTRIENT_REGISTRY.niacin.unit);
    expect(combined.nutrient_supplements).toHaveLength(1);
    expect(combined.ai_contributions).toHaveLength(1);
  });
});
