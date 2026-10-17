import { describe, expect, it } from 'vitest';
import { aiNutrientPerServing, combineAiContributionsWithPreview, hasUsableAiNutrientValue, sumAiNutrientContributions, validateAiNutrientContributions } from '../../src/core/nutritionV2/aiContribution';
import type { AdvisoryNutritionPreview } from '../../src/core/nutritionV2/calculation/types';
import { deriveNutritionCoverage } from '../../src/core/shiso/nutritionCoverage';

const binding = { recipe_digest: 'recipe-digest-1', line_refs: ['line-achiote', 'line-pork'] };
const achiote = {
  line_ref: 'line-achiote', ingredient: '2 tbsp achiote paste', quantity_basis: '2 tablespoons prepared paste',
  weight_grams: 30, classification: 'ai_estimate', confidence: 'medium',
  assumptions: ['Approximate prepared paste composition; no authenticated catalog match was used.'],
  sources: [], unknown_nutrients: ['vitamin_b12'],
  nutrients: { calories: { amount: 36, unit: 'kcal' }, protein: { amount: 1.2, unit: 'g' }, sodium: { amount: 120, unit: 'mg' } },
};

describe('AI nutrient contributions', () => {
  it('accepts bounded AI nutrient estimates without USDA identity and preserves unknowns', () => {
    const parsed = validateAiNutrientContributions([achiote], binding);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.contributions[0].classification).toBe('ai_estimate');
    expect(parsed.contributions[0].unknown_nutrients).toEqual(['vitamin_b12']);
    expect('fdc_id' in parsed.contributions[0]).toBe(false);
  });

  it('rejects invented lines, invalid units, non-finite values, and unsupported source claims', () => {
    expect(validateAiNutrientContributions([{ ...achiote, line_ref: 'other' }], binding).ok).toBe(false);
    expect(validateAiNutrientContributions([{ ...achiote, nutrients: { calories: { amount: 36, unit: 'g' } } }], binding).ok).toBe(false);
    expect(validateAiNutrientContributions([{ ...achiote, nutrients: { calories: { amount: Number.NaN, unit: 'kcal' } } }], binding).ok).toBe(false);
    expect(validateAiNutrientContributions([{ ...achiote, classification: 'source_backed' }], binding).ok).toBe(false);
  });

  it('sums an AI line alongside a source-backed line and keeps known zero distinct from missing', () => {
    const source = { ...achiote, line_ref: 'line-pork', ingredient: '1 lb pork shoulder', classification: 'source_backed', assumptions: [], sources: [{ title: 'Example', url: 'https://example.org/nutrition' }], unknown_nutrients: ['vitamin_b12'], nutrients: { calories: { amount: 900, unit: 'kcal' }, protein: { amount: 80, unit: 'g' }, sodium: { amount: 0, unit: 'mg' } } };
    const parsed = validateAiNutrientContributions([achiote, source], binding);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(sumAiNutrientContributions(parsed.contributions)).toEqual({
      calories: { amount: 936, unit: 'kcal', covered_ingredient_count: 2 },
      protein: { amount: 81.2, unit: 'g', covered_ingredient_count: 2 },
      sodium: { amount: 120, unit: 'mg', covered_ingredient_count: 2 },
    });
    expect(sumAiNutrientContributions([parsed.contributions[1]])).toMatchObject({ sodium: { amount: 0 } });
    expect(sumAiNutrientContributions([parsed.contributions[1]])).not.toHaveProperty('vitamin_b12');
    expect(aiNutrientPerServing(parsed.contributions, 4)).toMatchObject({ calories: { amount: 234 }, protein: { amount: 20.3 }, sodium: { amount: 30 } });
  });

  it('does not let unknown-only contributions clear unresolved lines or make the preview partial-success', () => {
    const unknownOnly = { ...achiote, nutrients: {}, unknown_nutrients: ['calories', 'protein'] };
    const base = {
      calculation_schema: 1,
      calculation_version: 'test',
      bundle_release: 'test',
      catalog_digest: 'test',
      nutrient_map_version: 'test',
      servings: 4,
      ingredient_digest: 'test',
      nutrient_scope: ['calories', 'protein'],
      basis: 'total',
      status: 'unresolved',
      totals: {},
      ingredients: [],
      unresolved: [{ line_ref: 'line-achiote', outcome: 'needs_match' }],
      advisory_only: true,
      application_authorized: false,
    } as unknown as AdvisoryNutritionPreview;
    const combined = combineAiContributionsWithPreview(base, [unknownOnly as never]);
    expect(combined.status).toBe('unresolved');
    expect(combined.unresolved).toHaveLength(1);
    expect(combined.ai_contributions).toEqual([]);
  });

  it('keeps usable AI contributions partial when nutrients are explicitly unknown', () => {
    const base = {
      calculation_schema: 1,
      calculation_version: 'test',
      bundle_release: 'test',
      catalog_digest: 'test',
      nutrient_map_version: 'test',
      servings: 4,
      ingredient_digest: 'test',
      nutrient_scope: ['calories', 'protein', 'vitamin_b12'],
      basis: 'total',
      status: 'unresolved',
      totals: {},
      ingredients: [],
      unresolved: [{ line_ref: 'line-achiote', outcome: 'needs_match' }],
      advisory_only: true,
      application_authorized: false,
    } as unknown as AdvisoryNutritionPreview;
    const parsed = validateAiNutrientContributions([achiote], binding);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const combined = combineAiContributionsWithPreview(base, parsed.contributions);
    expect(combined.status).toBe('partial');
    expect(combined.unresolved).toHaveLength(0);
    expect(combined.ai_contributions).toHaveLength(1);
  });

  it('keeps an evidenced cooking-wrapper exclusion distinct and out of consumed totals', () => {
    const wrapper = {
      ...achiote,
      line_ref: 'line-wrapper',
      ingredient: '2 banana leaves, softened',
      quantity_basis: 'Used only to line and cover the roasting pan; not served',
      weight_grams: 0,
      disposition: 'excluded',
      exclusion_role: 'cooking_wrapper',
      exclusion_assumption: 'The banana leaves line and cover the roasting pan; they are discarded and not eaten.',
      assumptions: ['Cooking wrapper only; not eaten.'],
      unknown_nutrients: [],
      nutrients: { calories: { amount: 0, unit: 'kcal' }, protein: { amount: 0, unit: 'g' } },
    };
    const checked = validateAiNutrientContributions([wrapper], {
      recipe_digest: 'recipe-digest-1',
      line_refs: ['line-wrapper'],
      line_text_by_ref: { 'line-wrapper': wrapper.ingredient },
      instructions: ['Line a roasting pan with banana leaves.', 'Roast the pork, then serve the pork in tortillas.'],
      requireExclusionContext: true,
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(hasUsableAiNutrientValue(checked.contributions[0])).toBe(false);
    expect(sumAiNutrientContributions(checked.contributions)).toEqual({});
    const coverage = deriveNutritionCoverage([{ line_ref: 'line-wrapper', status: 'needs_match' } as never], checked.contributions);
    expect(coverage).toMatchObject({ resolved: 0, ai_estimated: 0, excluded: 1, unresolved: 0, reconciled: true });
    const combined = combineAiContributionsWithPreview({
      calculation_schema: 1, calculation_version: 'test', bundle_release: 'test', catalog_digest: 'test', nutrient_map_version: 'test', servings: 4,
      ingredient_digest: 'test', nutrient_scope: ['calories'], basis: 'total', status: 'unresolved', totals: {}, ingredients: [],
      unresolved: [{ line_ref: 'line-wrapper', outcome: 'needs_match' }], advisory_only: true, application_authorized: false,
    } as unknown as AdvisoryNutritionPreview, checked.contributions);
    expect(combined.ai_contributions).toEqual(checked.contributions);
    expect(combined.unresolved).toEqual([]);
    expect(combined.totals).toEqual({});
  });

  it('rejects zero edible weight without context and refuses edible foods marked as wrappers', () => {
    const zeroFood = { ...achiote, weight_grams: 0, nutrients: { calories: { amount: 0, unit: 'kcal' } } };
    expect(validateAiNutrientContributions([zeroFood], binding).ok).toBe(false);
    const falseExclusion = {
      ...zeroFood, disposition: 'excluded', exclusion_role: 'cooking_wrapper',
      exclusion_assumption: 'This item is discarded and not eaten.', unknown_nutrients: [],
    };
    expect(validateAiNutrientContributions([falseExclusion], {
      recipe_digest: 'recipe-digest-1', line_refs: ['line-achiote'],
      line_text_by_ref: { 'line-achiote': '1 white onion, finely diced' },
      instructions: ['Dice the onion and serve it with the meal.'], requireExclusionContext: true,
    }).ok).toBe(false);
  });
});
