// @vitest-environment jsdom
/**
 * SINC-4 — saved-report presentation of supplemental AI estimates.
 *
 * The saved report must keep verified USDA values and separately attributed AI
 * supplements visually distinct. This is a read-only presentation test.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { AdvancedNutritionSavedReport } from '../../src/components/AdvancedNutritionSavedReport';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV6 } from '../../src/core/nutritionV2/schema';
import { AI_NUTRIENT_SUPPLEMENT_VERSION } from '../../src/core/nutritionV2/aiContribution';
import { validateCodexNutrition } from '../../src/core/nutritionV2/validate';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE = 'usda_fdc_release_2026_04';

function block(): CodexNutritionV6 {
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
    source_amounts: { calories: 364 },
    nutrient_supplements: [{
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
    }],
  };
}

afterEach(cleanup);

describe('SINC-4 — saved report supplemental estimates', () => {
  it('shows verification-needed state when no trusted source verification is available', () => {
    expect(validateCodexNutrition(block()).ok).toBe(true);
    render(
      <AdvancedNutritionSavedReport
        isOpen
        title="Supplement test"
        block={block()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('saved-supplement-verification-required')).toBeTruthy();
    expect(screen.getByTestId('saved-supplement-verification-required').textContent).toContain('need verification');
    expect(screen.getByTestId('saved-supplement-line').textContent).toContain('Niacin');
    expect(screen.getByTestId('saved-supplement-line').textContent).toContain('1.2');
    expect(screen.getByTestId('saved-supplement-line').textContent).toContain('USDA FDC 6001');
    expect(screen.getByTestId('saved-supplement-line').textContent).toContain('Unverified');
  });

  it('shows verified supplemental provenance only after trusted verification', () => {
    render(
      <AdvancedNutritionSavedReport
        isOpen
        title="Supplement test"
        block={block()}
        supplementVerification="verified"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('saved-supplement-verification-required')).toBeNull();
    const section = screen.getByTestId('saved-advanced-supplements');
    expect(section.textContent).toContain('verified USDA values unchanged');
    expect(section.textContent).not.toContain('Unverified');
  });

  it('marks quarantined supplements while preserving the saved content', () => {
    render(
      <AdvancedNutritionSavedReport
        isOpen
        title="Supplement test"
        block={block()}
        supplementVerification="partial"
        quarantinedSupplements={[{
          line_ref: 'flour',
          nutrient_id: 'niacin',
          reason: 'source_conflict',
        }]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('saved-supplement-verification-required')).toBeTruthy();
    expect(screen.getByTestId('saved-supplement-line').textContent).toContain('Verification needed (source_conflict)');
  });
});
