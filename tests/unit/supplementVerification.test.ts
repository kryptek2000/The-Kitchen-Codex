/**
 * SINC-4R2 — trusted supplement verification against genuine source evidence.
 *
 * Saved v6 metadata is not proof. These tests use a synthetic authoritative
 * preview and prove that only supplements whose source line genuinely lacks the
 * nutrient can activate, while conflicts, mismatches, duplicates, and missing
 * evidence are quarantined.
 */

import { describe, expect, it } from 'vitest';

import { verifySupplementsAgainstPreview } from '../../src/core/nutritionV2/supplementVerification';
import {
  AI_NUTRIENT_SUPPLEMENT_VERSION,
  type AiNutrientSupplement,
} from '../../src/core/nutritionV2/aiContribution';
import type { AdvisoryNutritionPreview, IngredientCalculationEvidence } from '../../src/core/nutritionV2/calculation/types';

const REF = 'ing:flour';
const LINE = '100 g Flour, wheat, white';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE = 'usda_fdc_release_2026_04';

function supplement(overrides: Partial<AiNutrientSupplement> = {}): AiNutrientSupplement {
  return Object.freeze({
    supplement_version: AI_NUTRIENT_SUPPLEMENT_VERSION,
    line_ref: REF,
    ingredient: LINE,
    nutrient_id: 'niacin',
    amount: 1.2,
    unit: 'mg_ne',
    classification: 'ai_estimate',
    source_kind: 'ai_supplement',
    source_food_id: '6001',
    source_release: RELEASE,
    weight_grams: 100,
    quantity_basis: '100 g resolved source weight',
    assumptions: ['Synthetic verification fixture.'],
    confidence: 'medium',
    recipe_digest: DIGEST,
    review_identity: 'review_v1:test',
    ...overrides,
  });
}

function preview(): AdvisoryNutritionPreview {
  const flour = {
    line_ref: REF,
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
    contributing_nutrients: ['calories', 'protein', 'fiber'],
  } as unknown as IngredientCalculationEvidence;
  return {
    calculation_schema: 1,
    calculation_version: 'v3',
    bundle_release: RELEASE,
    catalog_digest: 'catalog',
    nutrient_map_version: 'map',
    servings: 4,
    ingredient_digest: DIGEST,
    nutrient_scope: ['calories', 'protein', 'fiber', 'niacin'],
    basis: 'total',
    status: 'partial',
    totals: {
      calories: { amount: 364, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 1, measurable_ingredient_count: 1 },
    },
    ingredients: [flour],
    unresolved: [],
    advisory_only: true,
    application_authorized: false,
  } as AdvisoryNutritionPreview;
}

describe('SINC-4R2 — trusted supplement verification', () => {
  it('activates a supplement only when the genuine source lacks the nutrient', () => {
    const result = verifySupplementsAgainstPreview([supplement()], preview(), { [REF]: LINE }, DIGEST);
    expect(result.evidence).toBe('authoritative_preview');
    expect(result.verified).toHaveLength(1);
    expect(result.quarantined).toEqual([]);
  });

  it('quarantines a supplement that conflicts with a genuine source nutrient', () => {
    const result = verifySupplementsAgainstPreview(
      [supplement({ nutrient_id: 'calories', unit: 'kcal', amount: 100 })],
      preview(),
      { [REF]: LINE },
      DIGEST,
    );
    expect(result.verified).toEqual([]);
    expect(result.quarantined[0]).toMatchObject({
      reason: 'source_conflict',
      code: 'source_already_has_nutrient',
    });
  });

  it('quarantines a supplement for an explicit source zero', () => {
    // The genuine flour source contributes fiber as an explicit zero.
    const result = verifySupplementsAgainstPreview(
      [supplement({ nutrient_id: 'fiber', unit: 'g', amount: 1 })],
      preview(),
      { [REF]: LINE },
      DIGEST,
    );
    expect(result.quarantined[0]).toMatchObject({
      reason: 'source_conflict',
      code: 'source_already_has_nutrient',
    });
  });

  it('quarantines a supplement when trusted source evidence is unavailable', () => {
    const result = verifySupplementsAgainstPreview([supplement()], null, { [REF]: LINE }, DIGEST);
    expect(result.evidence).toBe('unavailable');
    expect(result.verified).toEqual([]);
    expect(result.quarantined[0]).toMatchObject({ reason: 'source_unavailable' });
  });

  it('quarantines source identity, weight, and text mismatches', () => {
    const identity = verifySupplementsAgainstPreview(
      [supplement({ source_food_id: '9999' })],
      preview(),
      { [REF]: LINE },
      DIGEST,
    );
    expect(identity.quarantined[0]).toMatchObject({ reason: 'source_mismatch' });
    const weight = verifySupplementsAgainstPreview(
      [supplement({ weight_grams: 90 })],
      preview(),
      { [REF]: LINE },
      DIGEST,
    );
    expect(weight.quarantined[0]).toMatchObject({ reason: 'source_mismatch' });
    const text = verifySupplementsAgainstPreview(
      [supplement({ ingredient: '100 g Sugar' })],
      preview(),
      { [REF]: LINE },
      DIGEST,
    );
    expect(text.quarantined[0]).toMatchObject({ reason: 'source_mismatch' });
  });

  it('keeps the first valid duplicate and quarantines the rest', () => {
    const result = verifySupplementsAgainstPreview(
      [supplement(), supplement()],
      preview(),
      { [REF]: LINE },
      DIGEST,
    );
    expect(result.verified).toHaveLength(1);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]).toMatchObject({ reason: 'duplicate' });
  });

  it('quarantines a supplement line absent from the genuine source preview', () => {
    const result = verifySupplementsAgainstPreview(
      [supplement({ line_ref: 'ing:other' })],
      preview(),
      { 'ing:other': '100 g Other' },
      DIGEST,
    );
    expect(result.quarantined[0]).toMatchObject({ reason: 'source_unavailable' });
  });
});
