import { describe, it, expect } from 'vitest';

import {
  adaptUsdaBrandedFoodRecord,
  brandedBrandAppearsInIngredient,
  buildBrandedContribution,
  computeBrandedSnapshotDigest,
  sanitizeBrandedCandidate,
  sanitizeBrandedLookupResponse,
  USDA_BRANDED_FOOD_CONTRACT_VERSION,
  USDA_BRANDED_LOOKUP_RESPONSE_VERSION,
  type UsdaBrandedFoodCandidate,
} from '../../src/core/nutritionV2/brandedFoods';
import {
  MOCK_BRANDED_GOCHUJANG_FDC_ID,
  MOCK_BRANDED_GOCHUJANG_SAUCE_FDC_ID,
  MOCK_BRANDED_RICE_VINEGAR_FDC_ID,
  mockBrandedDetail,
  mockBrandedDuplicateNutrientDetail,
  mockBrandedInvalidNutrientDetail,
  mockBrandedNoServingDetail,
} from '../fixtures/usdaBrandedFixtures';

function failureOf<T extends { ok: boolean }>(result: T): { code: string; reason?: string } {
  return result as unknown as { code: string; reason?: string };
}

function candidateFor(fdcId: number, query = 'gochujang'): UsdaBrandedFoodCandidate {
  const result = adaptUsdaBrandedFoodRecord(mockBrandedDetail(fdcId), query);
  if (!result.ok) throw new Error(`fixture did not adapt: ${failureOf(result).code}`);
  return result.candidate;
}

describe('SINC-2 branded food adapter — synthetic fixtures', () => {
  it('adapts a per-serving mass record with label nutrients and a stable digest', () => {
    const candidate = candidateFor(MOCK_BRANDED_GOCHUJANG_FDC_ID);
    expect(candidate.source).toBe('usda_fdc_branded');
    expect(candidate.data_type).toBe('Branded');
    expect(candidate.serving).toEqual({ amount: 30, unit: 'g', household: '2 tbsp' });
    expect(candidate.basis).toBe('per_serving_g');
    expect(candidate.serving_grams).toBe(30);
    expect(candidate.nutrients.calories).toEqual({ amount: 60, unit: 'kcal' });
    expect(candidate.nutrients.protein).toEqual({ amount: 1, unit: 'g' });
    // Explicit source zero remains a known zero.
    expect(candidate.nutrients.trans_fat).toBeUndefined();
    expect(candidate.match_quality).toBe('strong');
    expect(candidate.usable).toBe(true);
    expect(candidate.snapshot_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(candidate.snapshot_digest).toBe(candidate.snapshot_digest);
    expect(computeBrandedSnapshotDigest(candidate)).toBe(candidate.snapshot_digest);
  });

  it('keeps a volume serving basis as volume and never invents grams', () => {
    const candidate = candidateFor(MOCK_BRANDED_RICE_VINEGAR_FDC_ID, 'rice vinegar');
    expect(candidate.basis).toBe('per_serving_ml');
    expect(candidate.serving_ml).toBe(15);
    expect(candidate.serving_grams).toBeUndefined();
    expect(candidate.nutrients.calories).toEqual({ amount: 0, unit: 'kcal' });
    expect(candidate.nutrients.carbohydrates).toEqual({ amount: 1, unit: 'g' });
    expect(candidate.nutrients.protein).toBeUndefined();
    expect(candidate.limitations.join(' ')).toMatch(/volume; no gram weight/i);
  });

  it('never treats a volume record’s standardized nutrients as per-100-g mass', () => {
    const result = adaptUsdaBrandedFoodRecord(
      {
        fdcId: 990012,
        dataType: 'Branded',
        description: 'SINC2 MOCK VOLUME SAUCE',
        brandOwner: 'Mock Foods',
        servingSize: 30,
        servingSizeUnit: 'ml',
        labelNutrients: { calories: { value: 10 }, carbohydrates: { value: 2 } },
        foodNutrients: [
          { nutrient: { id: 1008, unitName: 'kcal' }, amount: 999 },
          { nutrient: { id: 1005, unitName: 'g' }, amount: 99 },
        ],
      },
      'sauce'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.basis).toBe('per_serving_ml');
    expect(result.candidate.standardized_basis).toBe('unknown');
    expect(result.candidate.nutrients.calories).toEqual({ amount: 10, unit: 'kcal' });
    expect(result.candidate.nutrients.carbohydrates).toEqual({ amount: 2, unit: 'g' });
    const built = buildBrandedContribution(result.candidate, {
      line_ref: 'ing:sauce',
      ingredient_text: '30 ml sauce',
      query: 'sauce',
      amount: 30,
      unit: 'ml',
      measurement_kind: 'volume',
      quantity_ml: 30,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.contribution.nutrients.calories?.amount).toBe(10);
      expect(built.contribution.weight_grams).toBeUndefined();
    }
  });

  it('falls back to USDA standardized per 100 g only for a mass serving', () => {
    const result = adaptUsdaBrandedFoodRecord(
      {
        fdcId: 990010,
        dataType: 'Branded',
        description: 'SINC2 MOCK STANDARDIZED GOCHUJANG',
        brandOwner: 'Mock Foods',
        servingSize: 30,
        servingSizeUnit: 'g',
        foodNutrients: [
          { nutrient: { id: 1008, unitName: 'kcal' }, amount: 200 },
          { nutrient: { id: 1003, unitName: 'g' }, amount: 3 },
          { nutrient: { id: 1005, unitName: 'g' }, amount: 40 },
        ],
      },
      'gochujang'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.basis).toBe('per_100_g');
    expect(result.candidate.nutrients.calories).toEqual({ amount: 200, unit: 'kcal' });
    expect(result.candidate.limitations.join(' ')).toMatch(/standardized per 100 g/i);
  });

  it('preserves published label rounding instead of normalizing it away', () => {
    const result = adaptUsdaBrandedFoodRecord(
      {
        fdcId: 990013,
        dataType: 'Branded',
        description: 'SINC2 MOCK LABEL ROUNDING',
        servingSize: 30,
        servingSizeUnit: 'g',
        labelNutrients: {
          calories: { value: 59.9999 },
          protein: { value: 0 },
        },
      },
      'gochujang'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.nutrients.calories?.amount).toBe(59.9999);
    expect(result.candidate.nutrients.protein).toEqual({ amount: 0, unit: 'g' });
    expect(result.candidate.nutrients.fat).toBeUndefined();
  });

  it('keeps a product with no usable serving basis visible but unusable', () => {
    const result = adaptUsdaBrandedFoodRecord(mockBrandedNoServingDetail(), 'gochujang');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.usable).toBe(false);
    expect(result.candidate.basis).toBe('unsupported');
    const contribution = buildBrandedContribution(result.candidate, {
      line_ref: 'ing:0',
      ingredient_text: '2 tbsp gochujang',
      query: 'gochujang',
      amount: 2,
      unit: 'tbsp',
      measurement_kind: 'volume',
      quantity_ml: 30,
      quantity_grams: 30,
    });
    expect(contribution.ok).toBe(false);
    if (!contribution.ok) expect(failureOf(contribution).reason).toBe('missing_serving_basis');
  });

  it('fails closed on duplicate or invalid nutrient values', () => {
    const duplicate = adaptUsdaBrandedFoodRecord(mockBrandedDuplicateNutrientDetail(), 'gochujang');
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(failureOf(duplicate).code).toBe('duplicate_nutrient');

    const invalid = adaptUsdaBrandedFoodRecord(mockBrandedInvalidNutrientDetail(), 'gochujang');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(failureOf(invalid).code).toBe('invalid_nutrients');
  });

  it('rejects non-Branded records and invalid identifiers', () => {
    const foundation = adaptUsdaBrandedFoodRecord(
      { fdcId: 1, dataType: 'Foundation', description: 'Not branded' },
      'gochujang'
    );
    expect(foundation.ok).toBe(false);
    if (!foundation.ok) expect(failureOf(foundation).code).toBe('unsupported_data_type');

    const badId = adaptUsdaBrandedFoodRecord(
      { fdcId: -1, dataType: 'Branded', description: 'Bad id' },
      'gochujang'
    );
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(failureOf(badId).code).toBe('invalid_fdc_id');
  });

  it('fails closed on malformed brand/date identity metadata', () => {
    const base = {
      fdcId: 990020,
      dataType: 'Branded',
      description: 'SINC2 MOCK MALFORMED IDENTITY',
      servingSize: 30,
      servingSizeUnit: 'g',
      labelNutrients: { calories: { value: 10 } },
    };
    const brand = adaptUsdaBrandedFoodRecord({ ...base, brandOwner: 123 }, 'gochujang');
    expect(brand.ok).toBe(false);
    if (!brand.ok) expect((brand as { code: string }).code).toBe('invalid_brand');

    const date = adaptUsdaBrandedFoodRecord({ ...base, publicationDate: { value: 'today' } }, 'gochujang');
    expect(date.ok).toBe(false);
    if (!date.ok) expect((date as { code: string }).code).toBe('invalid_date');
  });

  it('classifies an unrelated food form as a weak match', () => {
    const chips = candidateFor(MOCK_BRANDED_GOCHUJANG_SAUCE_FDC_ID);
    expect(chips.match_quality).toBe('weak');
    expect(chips.limitations.join(' ')).toMatch(/different food form|does not closely match/i);
  });
});

describe('SINC-2 branded contribution — deterministic scaling', () => {
  const target = {
    line_ref: 'ing:gochujang',
    ingredient_text: '2 tbsp gochujang (Korean chili paste)',
    query: 'gochujang',
    amount: 2,
    unit: 'tbsp',
    measurement_kind: 'volume' as const,
    quantity_grams: 30,
    quantity_ml: 30,
  };

  it('scales a label serving to the authored mass without inventing nutrients', () => {
    const candidate = candidateFor(MOCK_BRANDED_GOCHUJANG_FDC_ID);
    const built = buildBrandedContribution(candidate, target);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const contribution = built.contribution;
    expect(contribution.classification).toBe('source_backed');
    expect(contribution.source_kind).toBe('usda_branded');
    expect(contribution.usda_branded).toMatchObject({
      fdc_id: MOCK_BRANDED_GOCHUJANG_FDC_ID,
      description: 'SINC2 MOCK GOCHUJANG SAUCE',
      basis: 'per_serving_g',
    });
    expect(contribution.nutrients.calories).toEqual({ amount: 60, unit: 'kcal' });
    expect(contribution.nutrients.sodium).toEqual({ amount: 480, unit: 'mg' });
    expect(contribution.unknown_nutrients).toContain('vitamin_b12');
    expect(contribution.assumptions.join(' ')).toMatch(/representative estimate/i);
    expect(contribution.sources[0]?.url).toContain('fdc.nal.usda.gov/food-details/990001');
    expect(contribution.weight_grams).toBe(30);
  });

  it('scales a per-100-g fallback and rejects a volume target without a volume basis', () => {
    const result = adaptUsdaBrandedFoodRecord(
      {
        fdcId: 990011,
        dataType: 'Branded',
        description: 'SINC2 MOCK STANDARDIZED GOCHUJANG',
        brandOwner: 'Mock Foods',
        servingSize: 30,
        servingSizeUnit: 'g',
        foodNutrients: [
          { nutrient: { id: 1008, unitName: 'kcal' }, amount: 200 },
          { nutrient: { id: 1003, unitName: 'g' }, amount: 3 },
        ],
      },
      'gochujang'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const built = buildBrandedContribution(result.candidate, { ...target, quantity_grams: 50 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.contribution.nutrients.calories?.amount).toBe(100);
    expect(built.contribution.nutrients.protein?.amount).toBe(1.5);
    expect(built.contribution.quantity_basis).toMatch(/per 100 g/i);

    const volumeCandidate = candidateFor(MOCK_BRANDED_RICE_VINEGAR_FDC_ID, 'rice vinegar');
    const missing = buildBrandedContribution(volumeCandidate, {
      ...target,
      query: 'rice vinegar',
      ingredient_text: '1 tbsp rice vinegar',
      quantity_grams: 15,
      quantity_ml: undefined,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(failureOf(missing).reason).toBe('volume_required');
  });

  it("uses the product's own declared household-to-gram relationship for a volume-authored line", () => {
    const candidate = candidateFor(MOCK_BRANDED_GOCHUJANG_FDC_ID);
    // The synthetic label declares "2 tbsp = 30 g". The recipe line is 2 tbsp.
    const sameMeasure = buildBrandedContribution(candidate, {
      ...target,
      quantity_grams: undefined,
      quantity_ml: 29.5735295625,
    });
    expect(sameMeasure.ok).toBe(true);
    if (!sameMeasure.ok) return;
    expect(sameMeasure.contribution.nutrients.calories).toEqual({ amount: 60, unit: 'kcal' });
    expect(sameMeasure.contribution.weight_grams).toBe(30);
    expect(sameMeasure.contribution.quantity_basis).toMatch(/household serving/i);
    expect(sameMeasure.contribution.assumptions.join(' ')).toMatch(/no generic density was inferred/i);

    // Half the household measure uses the same verified relationship.
    const half = buildBrandedContribution(candidate, {
      ...target,
      quantity_grams: undefined,
      quantity_ml: 14.78676478125,
    });
    expect(half.ok).toBe(true);
    if (half.ok) {
      expect(half.contribution.nutrients.calories?.amount).toBe(30);
      expect(half.contribution.weight_grams).toBe(15);
    }
  });

  it('detects an authored brand but defaults to a representative assumption', () => {
    const candidate = candidateFor(MOCK_BRANDED_GOCHUJANG_FDC_ID);
    expect(brandedBrandAppearsInIngredient(candidate, '2 tbsp Mock Foods gochujang')).toBe(true);
    expect(brandedBrandAppearsInIngredient(candidate, '2 tbsp gochujang')).toBe(false);
    const built = buildBrandedContribution(candidate, {
      ...target,
      ingredient_text: '2 tbsp Mock Foods gochujang',
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.contribution.confidence).toBe('high');
      expect(built.contribution.assumptions.join(' ')).toMatch(/appears to name this product brand/i);
    }
  });
});

describe('SINC-2 branded candidate sanitizer — server response revalidation', () => {
  it('revalidates a canonical candidate and rejects tampered source values', () => {
    const candidate = candidateFor(MOCK_BRANDED_GOCHUJANG_FDC_ID);
    const checked = sanitizeBrandedCandidate(candidate);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.candidate.snapshot_digest).toBe(candidate.snapshot_digest);

    const tampered = { ...candidate, nutrients: { ...candidate.nutrients, calories: { amount: 999, unit: 'kcal' } } };
    const rejected = sanitizeBrandedCandidate(tampered);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(failureOf(rejected).code).toBe('digest');
  });

  it('revalidates the exact line/query binding and response version', () => {
    const candidate = candidateFor(MOCK_BRANDED_GOCHUJANG_FDC_ID);
    const response = {
      ok: true,
      request_version: USDA_BRANDED_LOOKUP_RESPONSE_VERSION,
      line_ref: 'ing:gochujang',
      query: 'gochujang',
      total_hits: 2,
      candidates: [candidate],
      cache_status: 'miss',
      retrieved_at: '2026-11-22T00:00:00.000Z',
      signing_public_key: 'dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleQ==',
      signing_key_id: 'test-key-id-0001',
      limitations: ['Synthetic test limitation.'],
    };
    const checked = sanitizeBrandedLookupResponse(response, 'ing:gochujang', 'gochujang');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.response.candidates).toHaveLength(1);

    const wrongLine = sanitizeBrandedLookupResponse(response, 'ing:other', 'gochujang');
    expect(wrongLine.ok).toBe(false);
    const wrongQuery = sanitizeBrandedLookupResponse(response, 'ing:gochujang', 'rice vinegar');
    expect(wrongQuery.ok).toBe(false);
    const wrongVersion = sanitizeBrandedLookupResponse(
      { ...response, request_version: 'usda_branded_lookup_response_v0' },
      'ing:gochujang',
      'gochujang'
    );
    expect(wrongVersion.ok).toBe(false);
    const withoutKey: Record<string, unknown> = { ...response };
    delete withoutKey['signing_public_key'];
    const missingSigningKey = sanitizeBrandedLookupResponse(withoutKey, 'ing:gochujang', 'gochujang');
    expect(missingSigningKey.ok).toBe(false);
    if (!missingSigningKey.ok) expect(failureOf(missingSigningKey).code).toBe('signing_key');
  });

  it('pins the contract version literal', () => {
    expect(USDA_BRANDED_FOOD_CONTRACT_VERSION).toBe('usda_branded_food_v1');
  });
});
