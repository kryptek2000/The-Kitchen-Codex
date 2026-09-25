/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: display derivations.
 */

import { describe, it, expect } from 'vitest';
import { NUTRIENT_IDS } from '../../src/core/nutritionV2/nutrients';
import {
  NUTRIENT_GROUPS,
  allGroupedNutrients,
  basisLabel,
  coverageSummary,
  deriveDisplayNutrients,
  formatUnitLabel,
} from '../../src/core/nutritionV2/phase4/display';
import { summarizeStoredAdvanced } from '../../src/core/nutritionV2/phase4/stored';
import type { AdvisoryNutritionPreview, NutrientTotalResult } from '../../src/core/nutritionV2/calculation/types';
import type { NutrientId } from '../../src/core/nutritionV2/nutrients';

function previewWith(totals: Partial<Record<NutrientId, NutrientTotalResult>>): AdvisoryNutritionPreview {
  return Object.freeze({
    calculation_schema: 1,
    calculation_version: 'usda_advisory_calc_v1',
    bundle_release: 'bundle',
    catalog_digest: 'c'.repeat(64),
    nutrient_map_version: 'usda_fdc_nutrient_map_v2',
    servings: 4,
    ingredient_digest: 'sha256:' + 'a'.repeat(64),
    nutrient_scope: Object.freeze(['protein'] as NutrientId[]),
    basis: 'total',
    status: 'partial',
    totals: Object.freeze(totals),
    ingredients: Object.freeze([]),
    unresolved: Object.freeze([]),
    advisory_only: true,
    application_authorized: false,
  });
}

describe('phase 4 display — nutrient groups', () => {
  it('groups every registered nutrient exactly once, in registry order within groups', () => {
    const grouped = allGroupedNutrients();
    expect(grouped.length).toBe(NUTRIENT_IDS.length);
    expect(new Set(grouped).size).toBe(NUTRIENT_IDS.length);
    expect([...grouped].sort()).toEqual([...NUTRIENT_IDS].sort());
    for (const id of grouped) expect(NUTRIENT_IDS).toContain(id);
  });

  it('does not include an unknown nutrient', () => {
    for (const id of allGroupedNutrients()) expect(NUTRIENT_IDS).toContain(id);
    expect(NUTRIENT_GROUPS.map((group) => group.id)).toEqual([
      'energy_macros',
      'fats',
      'carbohydrates',
      'minerals',
      'vitamins',
    ]);
  });
});

describe('phase 4 display — missing / zero / partial / complete', () => {
  const proteinTotal = Object.freeze({
    amount: 40,
    unit: 'g' as const,
    coverage: 1,
    covered_ingredient_count: 1,
    measurable_ingredient_count: 1,
    status: 'complete' as const,
  });
  const sodiumTotal = Object.freeze({
    amount: 500,
    unit: 'mg' as const,
    coverage: 0.5,
    covered_ingredient_count: 1,
    measurable_ingredient_count: 2,
    status: 'partial' as const,
  });
  const caloriesZero = Object.freeze({
    amount: 0,
    unit: 'kcal' as const,
    coverage: 1,
    covered_ingredient_count: 1,
    measurable_ingredient_count: 1,
    status: 'complete' as const,
  });
  const vitaminCTotal = Object.freeze({
    amount: 45,
    unit: 'mg' as const,
    coverage: 1,
    covered_ingredient_count: 1,
    measurable_ingredient_count: 1,
    status: 'complete' as const,
  });

  const preview = previewWith({
    protein: proteinTotal,
    sodium: sodiumTotal,
    calories: caloriesZero,
    vitamin_c: vitaminCTotal,
  });

  it('shows missing as unavailable, never zero; explicit zero stays zero', () => {
    const rows = deriveDisplayNutrients(preview, 'entire_recipe', 4, 4);
    const fat = rows.find((row) => row.nutrient === 'fat')!;
    expect(fat.amount).toBeUndefined();
    expect(fat.coverage).toBe('missing');
    expect(fat.percent_daily_value.available).toBe(false);

    const calories = rows.find((row) => row.nutrient === 'calories')!;
    expect(calories.amount).toBe(0);
    expect(calories.explicit_zero).toBe(true);
    // Calories have no established Daily Value -> unavailable, never 0%.
    expect(calories.percent_daily_value.available).toBe(false);
  });

  it('marks partial coverage and reports exact counts', () => {
    const rows = deriveDisplayNutrients(preview, 'entire_recipe', 4, 4);
    const sodium = rows.find((row) => row.nutrient === 'sodium')!;
    expect(sodium.coverage).toBe('partial');
    expect(sodium.covered_ingredient_count).toBe(1);
    expect(sodium.measurable_ingredient_count).toBe(2);
    const protein = rows.find((row) => row.nutrient === 'protein')!;
    expect(protein.coverage).toBe('complete');
  });

  it('derives %DV from the currently displayed amount', () => {
    const entire = deriveDisplayNutrients(preview, 'entire_recipe', 4, 4);
    const perServing = deriveDisplayNutrients(preview, 'per_serving', 4, 4);
    const selected = deriveDisplayNutrients(preview, 'selected_servings', 4, 6);

    const proteinEntire = entire.find((row) => row.nutrient === 'protein')!;
    const proteinPer = perServing.find((row) => row.nutrient === 'protein')!;
    const proteinSelected = selected.find((row) => row.nutrient === 'protein')!;

    expect(proteinEntire.amount).toBe(40);
    expect(proteinEntire.percent_daily_value).toMatchObject({ available: true, percent: 80 });
    expect(proteinPer.amount).toBe(10);
    expect(proteinPer.percent_daily_value).toMatchObject({ available: true, percent: 20 });
    expect(proteinSelected.amount).toBe(60);
    expect(proteinSelected.percent_daily_value).toMatchObject({ available: true, percent: 120 });
  });

  it('never derives from an already-scaled view (no drift on repeated toggles)', () => {
    const first = deriveDisplayNutrients(preview, 'per_serving', 4, 4);
    const second = deriveDisplayNutrients(preview, 'entire_recipe', 4, 4);
    const third = deriveDisplayNutrients(preview, 'per_serving', 4, 4);
    expect(third).toEqual(first);
    expect(second.find((row) => row.nutrient === 'protein')!.amount).toBe(40);
  });

  it('coverage does not change when the basis changes', () => {
    const entire = coverageSummary(preview);
    expect(entire.status).toBe('partial');
    expect(entire.unresolved_count).toBe(0);
    expect(entire.total_ingredients).toBe(0);
  });

  it('renders canonical units with the micro sign', () => {
    expect(formatUnitLabel('ug')).toBe('µg');
    expect(formatUnitLabel('ug_rae')).toBe('µg RAE');
    expect(formatUnitLabel('mg_ne')).toBe('mg NE');
    expect(formatUnitLabel('ug_dfe')).toBe('µg DFE');
    expect(formatUnitLabel('g')).toBe('g');
    expect(formatUnitLabel('mg')).toBe('mg');
    expect(formatUnitLabel('kcal')).toBe('kcal');
  });

  it('labels the basis clearly', () => {
    expect(basisLabel('entire_recipe', 4)).toBe('Entire recipe');
    expect(basisLabel('per_serving', 4)).toBe('Per serving');
    expect(basisLabel('selected_servings', 1)).toBe('1 serving');
    expect(basisLabel('selected_servings', 6)).toBe('6 servings');
  });
});

describe('phase 4 display — stored block trust', () => {
  it('does not trust malformed or unknown-schema stored blocks', () => {
    expect(summarizeStoredAdvanced(undefined).kind).toBe('none');
    expect(summarizeStoredAdvanced({ kind: 'opaque', schema: 9, data: {} }).kind).toBe('opaque');
    expect(summarizeStoredAdvanced({ schema: 3, basis: 'total' }).kind).toBe('opaque');
    expect(summarizeStoredAdvanced({ schema: 1, basis: 'per_serving' }).kind).toBe('opaque');
    expect(summarizeStoredAdvanced({ schema: 1, basis: 'total', nutrients: null }).kind).toBe('opaque');
    expect(summarizeStoredAdvanced('nope').kind).toBe('opaque');
  });

  it('projects only valid, recognized v1 nutrient amounts', () => {
    const summary = summarizeStoredAdvanced({
      schema: 1,
      basis: 'total',
      status: 'complete',
      servings: 4,
      nutrients: {
        calories: { amount: 400, unit: 'kcal' },
        protein: { amount: 12.5, unit: 'g' },
        fat: { amount: NaN, unit: 'g' },
        sodium: { amount: -3, unit: 'mg' },
      },
    });
    expect(summary.kind).toBe('v1');
    expect(summary.status).toBe('complete');
    expect(summary.servings).toBe(4);
    expect(summary.values.map((value) => value.nutrient)).toEqual(['calories', 'protein']);
  });
});
