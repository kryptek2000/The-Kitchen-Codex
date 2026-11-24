/**
 * SINC-3 whole-recipe nutrient coverage mapping.
 *
 * Proves the read-only projection of the EXISTING calculated preview:
 *   - source-backed missing lines come from `contributing_nutrients`;
 *   - AI gaps come from the explicit declarative `unknown_nutrients`;
 *   - aggregate niacin and added sugars gaps are represented truthfully;
 *   - the derived source subtotal is total minus explicit AI amounts;
 *   - a missing total stays unknown, never zero.
 */

import { describe, expect, it } from 'vitest';

import { buildShisoNutrientCoverage } from '../../src/core/shiso/nutritionCoverage';
import type { AdvisoryNutritionPreview } from '../../src/core/nutritionV2/calculation/types';

function sourceLine(index: number, contributingNutrients: ReadonlyArray<string>) {
  return {
    line_ref: `ing:source-${index}`,
    original_text: `USDA source line ${index + 1}`,
    outcome: 'calculated',
    fdc_id: 6000 + index,
    resolved_grams: 50,
    contributing_nutrients: contributingNutrients,
  };
}

function aiLine(lineRef: string, knownNiacin: number | undefined, unknown: ReadonlyArray<string>) {
  return {
    line_ref: lineRef,
    ingredient: `AI estimate ${lineRef}`,
    classification: 'ai_estimate',
    disposition: 'edible',
    nutrients: knownNiacin === undefined ? {} : { niacin: { amount: knownNiacin, unit: 'mg_ne' } },
    unknown_nutrients: unknown,
  };
}

function preview(): AdvisoryNutritionPreview {
  return {
    nutrient_scope: ['niacin', 'added_sugars'],
    totals: {
      niacin: {
        amount: 20,
        unit: 'mg_ne',
        coverage: 11 / 18,
        covered_ingredient_count: 11,
        measurable_ingredient_count: 18,
        status: 'partial',
      },
    },
    ingredients: Array.from({ length: 16 }, (_, index) =>
      sourceLine(index, index >= 6 ? ['niacin'] : [])
    ),
    ai_contributions: [
      aiLine('ing:ai-1', 1, ['added_sugars']),
      aiLine('ing:ai-2', undefined, ['niacin', 'added_sugars']),
    ],
  } as unknown as AdvisoryNutritionPreview;
}

describe('SINC-3 whole-recipe nutrient coverage projection', () => {
  it('reports aggregate niacin source and AI gaps from the existing preview', () => {
    const coverage = buildShisoNutrientCoverage(preview());
    const niacin = coverage.find((entry) => entry.id === 'niacin');
    expect(niacin).toBeDefined();
    expect(niacin).toMatchObject({
      label: 'Niacin',
      unit: 'mg_ne',
      status: 'partial',
      total_amount: 20,
      ai_estimated_amount: 1,
      derived_source_subtotal: 19,
      covered_ingredient_count: 11,
      measurable_ingredient_count: 18,
    });
    expect(niacin?.missing_source_lines).toHaveLength(6);
    expect(niacin?.missing_ai_lines).toHaveLength(1);
    expect(niacin?.missing_ai_lines[0]?.line_ref).toBe('ing:ai-2');
  });

  it('keeps added sugars unknown and never turns a missing total into zero', () => {
    const coverage = buildShisoNutrientCoverage(preview());
    const added = coverage.find((entry) => entry.id === 'added_sugars');
    expect(added).toBeDefined();
    expect(added).toMatchObject({
      label: 'Added sugars',
      unit: 'g',
      status: 'unknown',
      total_amount: null,
      ai_estimated_amount: 0,
      derived_source_subtotal: null,
    });
    expect(added?.missing_source_lines).toHaveLength(16);
    expect(added?.missing_ai_lines).toHaveLength(2);
  });

  it('returns no synthetic coverage when no preview exists', () => {
    expect(buildShisoNutrientCoverage(null)).toEqual([]);
  });
});
