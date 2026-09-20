/**
 * Advanced Nutrition — saved report projection and per-serving compact math.
 *
 * Pure tests: no DOM, no session. Proves the saved report renders from the
 * persisted canonical block alone and that the compact per-serving values use
 * the shared deterministic serving math.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveAdvancedCompactPerServing,
  deriveSavedReportNutrients,
  savedReportMeta,
} from '../../src/core/nutritionV2/phase5c/savedReport';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';

function block(overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  return {
    schema: 1,
    basis: 'total',
    servings: 4,
    status: 'complete',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'usda_fdc_bundle' },
    nutrient_scope: ['calories', 'protein', 'carbohydrates', 'fat', 'fiber', 'sodium'],
    nutrients: {
      calories: { amount: 3210, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 11, measurable_ingredient_count: 11 },
      protein: { amount: 154.4, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 11, measurable_ingredient_count: 11 },
      carbohydrates: { amount: 127.5, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 11, measurable_ingredient_count: 11 },
      fat: { amount: 228.3, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 11, measurable_ingredient_count: 11 },
      fiber: { amount: 12, unit: 'g', status: 'partial', coverage: 0.5, covered_ingredient_count: 5, measurable_ingredient_count: 11 },
      sodium: { amount: 2400, unit: 'mg', status: 'complete', coverage: 1, covered_ingredient_count: 11, measurable_ingredient_count: 11 },
    },
    ingredients: [],
    unresolved: [],
    ...overrides,
  };
}

function amountOf(rows: ReturnType<typeof deriveSavedReportNutrients>, id: string): number | undefined {
  return rows.find((row) => row.nutrient === id)?.amount;
}

describe('saved report projection', () => {
  it('renders stored entire-recipe totals unchanged', () => {
    const rows = deriveSavedReportNutrients(block(), 'entire_recipe', 4);
    expect(amountOf(rows, 'calories')).toBe(3210);
    expect(amountOf(rows, 'protein')).toBe(154.4);
    expect(amountOf(rows, 'sodium')).toBe(2400);
  });

  it('derives per-serving values from the STORED denominator', () => {
    const rows = deriveSavedReportNutrients(block(), 'per_serving', 4);
    expect(amountOf(rows, 'calories')).toBeCloseTo(802.5, 6);
    expect(amountOf(rows, 'protein')).toBeCloseTo(38.6, 6);
    expect(amountOf(rows, 'carbohydrates')).toBeCloseTo(31.875, 6);
    expect(amountOf(rows, 'fat')).toBeCloseTo(57.075, 6);
    expect(amountOf(rows, 'fiber')).toBeCloseTo(3, 6);
    expect(amountOf(rows, 'sodium')).toBeCloseTo(600, 6);
  });

  it('derives selected-serving values from the stored denominator', () => {
    const rows = deriveSavedReportNutrients(block(), 'selected_servings', 2);
    expect(amountOf(rows, 'calories')).toBeCloseTo(1605, 6);
  });

  it('keeps an absent nutrient missing (never 0) and marks partial coverage', () => {
    const rows = deriveSavedReportNutrients(block({ nutrients: {} }), 'entire_recipe', 4);
    expect(amountOf(rows, 'calories')).toBeUndefined();
    const withFiber = deriveSavedReportNutrients(block(), 'entire_recipe', 4);
    expect(withFiber.find((row) => row.nutrient === 'fiber')?.coverage).toBe('partial');
    expect(withFiber.find((row) => row.nutrient === 'calories')?.coverage).toBe('complete');
  });

  it('reports bounded metadata including the USDA bundle release', () => {
    const meta = savedReportMeta(block({ unresolved: [{ line_ref: 'x', reason: 'no_match' }] }));
    expect(meta.complete).toBe(false);
    expect(meta.resolved_count).toBe(0);
    expect(meta.unresolved_count).toBe(1);
    expect(meta.ingredient_count).toBe(1);
    expect(meta.servings).toBe(4);
    expect(meta.usda_release).toBe('usda_fdc_bundle');
  });

  it('per-serving compact math divides the exact stored totals (3220-ish -> ~802)', () => {
    const compact = deriveAdvancedCompactPerServing(block());
    expect(compact).toBeDefined();
    if (!compact) return;
    expect(compact.servings).toBe(1);
    expect(compact.calories).toBeCloseTo(802.5, 6);
    expect(compact.protein).toBeCloseTo(38.6, 6);
    expect(compact.carbohydrates).toBeCloseTo(31.875, 6);
    expect(compact.fat).toBeCloseTo(57.075, 6);
    expect(compact.fiber).toBeCloseTo(3, 6);
    expect(compact.sodium).toBeCloseTo(600, 6);
  });

  it('per-serving compact is undefined for a partial/incomplete block', () => {
    expect(
      deriveAdvancedCompactPerServing(
        block({ status: 'partial', unresolved: [{ line_ref: 'x', reason: 'no_match' }] })
      )
    ).toBeUndefined();
  });
});
