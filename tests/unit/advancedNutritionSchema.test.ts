import { describe, it, expect, vi } from 'vitest';
import {
  CANONICAL_UNITS,
  MAX_NUTRIENT_AMOUNT,
  convertEnergy,
  convertUnit,
  decimalPlaces,
  isCanonicalUnit,
  isNegativeZero,
  isValidNutrientAmount,
} from '../../src/core/nutritionV2/units';
import { NUTRIENT_IDS, NUTRIENT_REGISTRY, isNutrientId } from '../../src/core/nutritionV2/nutrients';
import {
  DV_STANDARD_ID,
  DV_STANDARD_SOURCE,
  dailyValuePercent,
} from '../../src/core/nutritionV2/dailyValues';
import {
  MAX_EXTENSION_ARRAY,
  MAX_EXTENSION_DEPTH,
  MAX_EXTENSION_KEYS,
  MAX_EXTENSION_STRING,
  MAX_SERIALIZED_BYTES,
  MAX_VALIDATION_DIAGNOSTIC_BYTES,
  MAX_VALIDATION_ERRORS,
  MAX_VALIDATION_ERROR_LENGTH,
  USER_MANUAL_RELEASE_ID,
  cloneSafeValue,
  containsReservedUsdaIdentity,
  isPlainSafeValue,
  normalizeReleaseIdentity,
  serializedBlockBytes,
  utf8ByteLength,
  type CodexNutritionV1,
} from '../../src/core/nutritionV2/schema';
import {
  ENCODE_UNSAFE_MESSAGE,
  decodeCodexNutrition,
  encodeCodexNutrition,
  validateCodexNutritionV1,
} from '../../src/core/nutritionV2/validate';

/**
 * Phase 0 — Advanced Nutrition schema/registry/units/%DV/evidence validation.
 * Mutation-sensitive: each rule is asserted with a violating fixture.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`;

function validV1(overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  return {
    schema: 1,
    basis: 'total',
    servings: 4,
    serving_size: '1 burger',
    status: 'complete',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: DIGEST,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: '2026-04' },
    nutrient_scope: ['calories', 'protein'],
    nutrients: {
      calories: {
        amount: 540,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 2,
        measurable_ingredient_count: 2,
      },
      protein: {
        amount: 32,
        unit: 'g',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 2,
        measurable_ingredient_count: 2,
      },
    },
    ingredients: [
      {
        line_ref: '454 g ground beef',
        source: 'usda_fdc',
        source_food_id: '171077',
        source_release: '2026-04',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
      },
      {
        line_ref: '2 buns',
        source: 'usda_fdc',
        source_food_id: '174929',
        source_release: '2026-04',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
      },
    ],
    unresolved: [],
    ...overrides,
  };
}

describe('nutrient registry — closed ids and canonical units', () => {
  it('every registry entry has a canonical unit and stable id', () => {
    expect(NUTRIENT_IDS.length).toBeGreaterThanOrEqual(34);
    for (const id of NUTRIENT_IDS) {
      expect(isNutrientId(id)).toBe(true);
      expect(isCanonicalUnit(NUTRIENT_REGISTRY[id].unit)).toBe(true);
    }
  });

  it('rejects unknown nutrient ids and unknown units', () => {
    expect(isNutrientId('unobtainium')).toBe(false);
    expect(isCanonicalUnit('iu')).toBe(false);
    expect(isCanonicalUnit('volume')).toBe(false);
    expect(isCanonicalUnit('mg_ne')).toBe(true);
  });

  it('documents the official FDA Daily Value source', () => {
    expect(DV_STANDARD_ID).toBe('fda_adult_4plus_2020');
    expect(DV_STANDARD_SOURCE.url).toContain('fda.gov');
    expect(DV_STANDARD_SOURCE.regulation).toBe('21 CFR 101.9(c)(8)');
  });
});

describe('units — deterministic metric mass + explicit energy only', () => {
  it('16. converts grams <-> milligrams <-> micrograms', () => {
    expect(convertUnit(1, 'g', 'mg')).toBe(1000);
    expect(convertUnit(1000, 'mg', 'g')).toBe(1);
    expect(convertUnit(1, 'mg', 'ug')).toBe(1000);
    expect(convertUnit(1, 'g', 'ug')).toBe(1_000_000);
    expect(convertUnit(2.5, 'g', 'g')).toBe(2.5);
  });

  it('17. never performs volume/count/density or form-qualified conversions', () => {
    expect(() => convertUnit(1, 'ug_rae', 'ug')).toThrow();
    expect(() => convertUnit(1, 'mg_ne', 'mg')).toThrow();
    expect(() => convertUnit(1, 'ug_dfe', 'ug')).toThrow();
    expect(() => convertUnit(1, 'g', 'kcal')).toThrow();
    expect(CANONICAL_UNITS.g.convertible).toBe(true);
    expect(CANONICAL_UNITS.ug_rae.convertible).toBe(false);
  });

  it('18. has no implicit IU conversion', () => {
    expect(() => convertUnit(1, 'iu' as never, 'ug')).toThrow();
    expect(() => convertEnergy(1, 'kcal', 'kj')).not.toThrow();
  });

  it('supports the exact kcal/kJ energy equivalence only', () => {
    expect(convertEnergy(1, 'kcal', 'kj')).toBe(4.184);
    expect(convertEnergy(4.184, 'kj', 'kcal')).toBe(1);
    expect(convertEnergy(10, 'kcal', 'kcal')).toBe(10);
  });

  it('15. rejects NaN, Infinity, negative, excessive, and over-precise amounts', () => {
    expect(isValidNutrientAmount(Number.NaN)).toBe(false);
    expect(isValidNutrientAmount(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidNutrientAmount(-1)).toBe(false);
    expect(isValidNutrientAmount(MAX_NUTRIENT_AMOUNT + 1)).toBe(false);
    expect(isValidNutrientAmount(1.1234567)).toBe(false);
    expect(isValidNutrientAmount(1.123456)).toBe(true);
    expect(isValidNutrientAmount(0)).toBe(true);
    expect(decimalPlaces(0.001)).toBe(3);
    expect(decimalPlaces(5)).toBe(0);
  });
});

describe('Daily Values — pinned standard, derived only', () => {
  it('19. calculates correct %DV from the pinned table', () => {
    expect(dailyValuePercent('fat', 39, 'g', DV_STANDARD_ID)).toEqual({ available: true, percent: 50, standard: DV_STANDARD_ID });
    expect(dailyValuePercent('sodium', 1150, 'mg', DV_STANDARD_ID)).toEqual({ available: true, percent: 50, standard: DV_STANDARD_ID });
    expect(dailyValuePercent('protein', 25, 'g', DV_STANDARD_ID)).toEqual({ available: true, percent: 50, standard: DV_STANDARD_ID });
    expect(dailyValuePercent('calcium', 1300, 'mg', DV_STANDARD_ID)).toEqual({ available: true, percent: 100, standard: DV_STANDARD_ID });
  });

  it('8. handles an explicit source-reported zero as 0%', () => {
    expect(dailyValuePercent('protein', 0, 'g', DV_STANDARD_ID)).toEqual({ available: true, percent: 0, standard: DV_STANDARD_ID });
  });

  it('20. nutrients without a DV return unavailable', () => {
    expect(dailyValuePercent('calories', 500, 'kcal', DV_STANDARD_ID)).toEqual({ available: false, reason: 'no_daily_value' });
    expect(dailyValuePercent('total_sugars', 10, 'g', DV_STANDARD_ID)).toEqual({ available: false, reason: 'no_daily_value' });
    expect(dailyValuePercent('trans_fat', 0, 'g', DV_STANDARD_ID)).toEqual({ available: false, reason: 'no_daily_value' });
  });

  it('rejects unknown standard, nutrient, mismatched unit, and invalid amount', () => {
    expect(dailyValuePercent('fat', 39, 'g', 'who_1990')).toEqual({ available: false, reason: 'unknown_standard' });
    expect(dailyValuePercent('nope' as never, 1, 'g', DV_STANDARD_ID)).toEqual({ available: false, reason: 'unknown_nutrient' });
    expect(dailyValuePercent('fat', 39, 'mg', DV_STANDARD_ID)).toEqual({ available: false, reason: 'invalid_unit' });
    expect(dailyValuePercent('fat', Number.NaN, 'g', DV_STANDARD_ID)).toEqual({ available: false, reason: 'invalid_amount' });
  });
});

describe('schema v1 — totals-only basis, coverage, missing vs zero', () => {
  it('10. accepts the exact totals basis', () => {
    const result = validateCodexNutritionV1(validV1());
    expect(result.ok).toBe(true);
    expect(result.value?.basis).toBe('total');
  });

  it('11. rejects a per-serving basis in schema v1', () => {
    const result = validateCodexNutritionV1(validV1({ basis: 'per_serving' as never }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('invalid_basis');
  });

  it('7. a missing nutrient is absent, never synthesized as zero', () => {
    const result = validateCodexNutritionV1(validV1());
    expect(result.ok).toBe(true);
    expect(result.value?.nutrients.fiber).toBeUndefined();
    expect('fiber' in (result.value?.nutrients ?? {})).toBe(false);
    // Serialization must not add a zero for the absent nutrient.
    const encoded = encodeCodexNutrition(result.value!);
    expect(Object.keys(encoded.nutrients as object)).not.toContain('fiber');
  });

  it('8. an explicitly reported zero is preserved as a present zero', () => {
    const value = validV1();
    value.nutrients.calories = {
      amount: 0,
      unit: 'kcal',
      status: 'complete',
      coverage: 1,
      covered_ingredient_count: 2,
      measurable_ingredient_count: 2,
    };
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(true);
    expect(result.value?.nutrients.calories?.amount).toBe(0);
  });

  it('9. partial nutrient coverage cannot claim complete', () => {
    const value = validV1();
    value.nutrients.protein = {
      amount: 10,
      unit: 'g',
      status: 'complete',
      coverage: 0.5,
      covered_ingredient_count: 1,
      measurable_ingredient_count: 2,
    };
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('nutrient_complete_with_partial_coverage:protein');
  });

  it('rejects a coverage value that disagrees with covered/measurable', () => {
    const value = validV1();
    value.nutrients.protein = {
      amount: 10,
      unit: 'g',
      status: 'partial',
      coverage: 0.6,
      covered_ingredient_count: 1,
      measurable_ingredient_count: 2,
    };
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('nutrient_coverage_mismatch:protein');
  });

  it('a partial nutrient with full coverage is rejected', () => {
    const value = validV1();
    value.nutrients.protein = {
      amount: 10,
      unit: 'g',
      status: 'partial',
      coverage: 1,
      covered_ingredient_count: 2,
      measurable_ingredient_count: 2,
    };
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('nutrient_partial_with_full_coverage:protein');
  });

  it('a complete block may carry a validly-partial nutrient (nutrient coverage is independent)', () => {
    const value = validV1();
    value.nutrients.protein = {
      amount: 10,
      unit: 'g',
      status: 'partial',
      coverage: 0.5,
      covered_ingredient_count: 1,
      measurable_ingredient_count: 2,
    };
    // BLOCK completeness is ingredient-line resolution; per-nutrient coverage
    // is reported independently by each nutrient.
    expect(validateCodexNutritionV1(value).ok).toBe(true);
  });

  it('rejects an unknown authoritative nutrient id', () => {
    const value = validV1() as unknown as Record<string, unknown>;
    (value.nutrients as Record<string, unknown>).unobtainium = {
      amount: 1,
      unit: 'g',
      status: 'complete',
      coverage: 1,
      covered_ingredient_count: 1,
      measurable_ingredient_count: 1,
    };
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('unknown_nutrient');
  });
});

describe('schema v1 — mixed sources and evidence binding', () => {
  it('12. mixed authoritative sources remain distinguishable', () => {
    const value = validV1({
      sources: ['usda_fdc', 'open_food_facts'],
      source_releases: { usda_fdc: '2026-04', open_food_facts: '2026-09-01' },
    });
    value.ingredients[1] = {
      line_ref: '2 buns',
      source: 'open_food_facts',
      source_food_id: '0012345678901',
      source_release: '2026-09-01',
      match_status: 'confirmed',
      resolved: true,
      user_confirmed: true,
    };
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(true);
    expect(result.value?.sources).toEqual(['usda_fdc', 'open_food_facts']);
    expect(result.value?.ingredients[1].source).toBe('open_food_facts');
  });

  it('13/14. rejects undeclared sources, release mismatches, duplicates, and forged resolution', () => {
    const undeclared = validV1();
    undeclared.ingredients[0].source = 'open_food_facts' as never;
    expect(validateCodexNutritionV1(undeclared).errors).toContain('ingredient_source_not_declared');

    const releaseMismatch = validV1();
    releaseMismatch.ingredients[0].source_release = '2019-04';
    expect(validateCodexNutritionV1(releaseMismatch).errors).toContain('ingredient_release_mismatch');

    const duplicate = validV1();
    duplicate.ingredients[1].line_ref = duplicate.ingredients[0].line_ref;
    expect(validateCodexNutritionV1(duplicate).errors.some((e) => e.startsWith('duplicate_line_ref'))).toBe(true);

    const forgedResolution = validV1();
    forgedResolution.ingredients[0] = {
      ...forgedResolution.ingredients[0],
      match_status: 'ambiguous',
      resolved: true,
      user_confirmed: true,
    };
    expect(validateCodexNutritionV1(forgedResolution).errors).toContain('ingredient_resolution_inconsistent');
  });

  it('14. rejects a wrong nutrient unit binding', () => {
    const value = validV1();
    value.nutrients.protein = {
      amount: 32,
      unit: 'mg',
      status: 'complete',
      coverage: 1,
      covered_ingredient_count: 2,
      measurable_ingredient_count: 2,
    };
    expect(validateCodexNutritionV1(value).errors).toContain('nutrient_unit_mismatch:protein');
  });

  it('15. rejects NaN/Infinity/negative/over-precise nutrient amounts', () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.1234567]) {
      const value = validV1();
      value.nutrients.protein = {
        amount,
        unit: 'g',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 2,
        measurable_ingredient_count: 2,
      };
      expect(validateCodexNutritionV1(value).errors).toContain('nutrient_invalid_amount:protein');
    }
  });

  it('rejects inconsistent status provenance (complete with unresolved)', () => {
    const value = validV1({
      unresolved: [{ line_ref: 'salt to taste', reason: 'qualitative' }],
    });
    expect(validateCodexNutritionV1(value).errors).toContain('complete_with_unresolved');
  });
});

describe('extensions — bounded, non-authoritative, prototype-safe', () => {
  it('22. rejects dangerous prototype keys', () => {
    const extensions: Record<string, unknown> = {};
    Object.defineProperty(extensions, '__proto__', { value: { polluted: true }, enumerable: true });
    Object.defineProperty(extensions, 'constructor', { value: { evil: true }, enumerable: true });
    const value = validV1({ extensions });
    // Dangerous keys are rejected during safe materialization (fail closed).
    expect(validateCodexNutritionV1(value).ok).toBe(false);
    expect(validateCodexNutritionV1(value).errors).toContain('unsafe_value:dangerous_key');
    expect(isPlainSafeValue(extensions)).toBe(false);
    expect(isPlainSafeValue({ nested: { __proto__: { x: 1 } } })).toBe(false);
  });

  it('23. enforces depth, key, array, and string bounds', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < MAX_EXTENSION_DEPTH + 2; i += 1) deep = { nested: deep };
    expect(isPlainSafeValue(deep)).toBe(false);

    const manyKeys: Record<string, unknown> = {};
    for (let i = 0; i < MAX_EXTENSION_KEYS + 1; i += 1) manyKeys[`k${i}`] = i;
    expect(isPlainSafeValue(manyKeys)).toBe(false);

    expect(isPlainSafeValue(new Array(MAX_EXTENSION_ARRAY + 1).fill(1))).toBe(false);
    expect(isPlainSafeValue('x'.repeat(MAX_EXTENSION_STRING + 1))).toBe(false);
    expect(isPlainSafeValue({ ok: ['a', 1, true, null] })).toBe(true);
  });
});

describe('21. %DV is never serialized', () => {
  it('encoded nutrient results contain only amount/unit/coverage fields', () => {
    const encoded = encodeCodexNutrition(validV1());
    const calories = (encoded.nutrients as Record<string, Record<string, unknown>>).calories;
    expect(Object.keys(calories).sort()).toEqual(
      ['amount', 'covered_ingredient_count', 'coverage', 'measurable_ingredient_count', 'status', 'unit'].sort()
    );
    expect(JSON.stringify(encoded)).not.toContain('"percent"');
    expect(JSON.stringify(encoded)).not.toContain('"dv"');
    expect(encoded.dv_standard).toBe(DV_STANDARD_ID);
    expect(encoded.nutrient_scope).toEqual(['calories', 'protein']);
  });
});

describe('nutrient_scope and the complete/partial contract (Finding 1)', () => {
  it('1. an empty complete record is rejected', () => {
    const result = validateCodexNutritionV1(
      validV1({ nutrient_scope: ['calories'], nutrients: {}, ingredients: [] })
    );
    expect(result.ok).toBe(false);
    // Completion is ingredient-line resolution, so an empty evidence set with a
    // declared dataset source is the authority error.
    expect(result.errors).toContain('dataset_source_without_resolved_evidence:usda_fdc');
  });

  it('2. a complete block with calories only but a broader scope is accepted (absent nutrient stays absent)', () => {
    expect(validateCodexNutritionV1(validV1()).ok).toBe(true);
    const value = validV1({ nutrient_scope: ['calories', 'protein'] });
    delete (value.nutrients as Record<string, unknown>).protein;
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(true);
    expect(result.value?.nutrients.protein).toBeUndefined();
  });

  it('3. an absent scoped nutrient is allowed when every ingredient line is resolved', () => {
    const result = validateCodexNutritionV1(validV1({ nutrient_scope: ['calories', 'protein', 'fat'] }));
    expect(result.ok).toBe(true);
    expect(result.value?.nutrients.fat).toBeUndefined();
  });

  it('rejects an empty, unknown, duplicate, or oversized scope', () => {
    expect(validateCodexNutritionV1(validV1({ nutrient_scope: [] })).errors).toContain('invalid_nutrient_scope');
    expect(
      validateCodexNutritionV1(validV1({ nutrient_scope: ['calories', 'unobtainium'] as never })).errors.some((e) =>
        e.startsWith('unknown_scope_nutrient')
      )
    ).toBe(true);
    expect(validateCodexNutritionV1(validV1({ nutrient_scope: ['calories', 'calories'] })).errors).toContain(
      'duplicate_scope_nutrient:calories'
    );
    expect(
      validateCodexNutritionV1(validV1({ nutrient_scope: new Array(40).fill('calories') as never })).errors
    ).toContain('invalid_nutrient_scope');
  });

  it('rejects a nutrient result outside the declared scope', () => {
    const result = validateCodexNutritionV1(validV1({ nutrient_scope: ['calories'] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('nutrient_out_of_scope:protein');
  });

  it('4. a partial record preserves absent scoped nutrients as missing (never zero)', () => {
    const value = validV1({
      status: 'partial',
      nutrient_scope: ['calories', 'protein', 'fiber'],
      nutrients: {
        calories: {
          amount: 100,
          unit: 'kcal',
          status: 'partial',
          coverage: 0.5,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 2,
        },
      },
    });
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(true);
    expect(result.value?.nutrients.protein).toBeUndefined();
    expect(result.value?.nutrients.fiber).toBeUndefined();
    const encoded = encodeCodexNutrition(result.value!);
    const keys = Object.keys(encoded.nutrients as object);
    expect(keys).not.toContain('protein');
    expect(keys).not.toContain('fiber');
  });

  it('a partial record without absent/partial/unresolved evidence is rejected', () => {
    expect(validateCodexNutritionV1(validV1({ status: 'partial' })).errors).toContain(
      'partial_without_partial_evidence'
    );
  });

  it('5. a complete machine record requires at least one resolved evidence record', () => {
    expect(validateCodexNutritionV1(validV1({ ingredients: [] })).errors).toContain(
      'dataset_source_without_resolved_evidence:usda_fdc'
    );
  });

  it('6. a manual-only exception cannot be forged by machine provenance', () => {
    const forged = validV1({
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: '2026-04' },
      ingredients: [],
      manual_override: { overridden_at: '2026-09-14T00:00:00.000Z' },
    });
    expect(validateCodexNutritionV1(forged).errors).toContain('dataset_source_without_resolved_evidence:usda_fdc');

    const manualOnly = validV1({
      sources: ['user_manual'],
      source_releases: {},
      ingredients: [],
      manual_override: { overridden_at: '2026-09-14T00:00:00.000Z' },
    });
    const result = validateCodexNutritionV1(manualOnly);
    expect(result.ok).toBe(true);
    expect(result.value?.sources).toEqual(['user_manual']);
  });

  it('stale/unresolved never authorize as complete', () => {
    expect(validateCodexNutritionV1(validV1({ status: 'stale' })).value?.status).toBe('stale');
    expect(
      validateCodexNutritionV1(
        validV1({ status: 'unresolved', unresolved: [{ line_ref: 'salt', reason: 'no_match' }] })
      ).ok
    ).toBe(true);
    expect(validateCodexNutritionV1(validV1({ status: 'unresolved', unresolved: [] })).errors).toContain(
      'unresolved_without_entries'
    );
  });
});

describe('source/release binding (Finding 2)', () => {
  it('7. a missing source release is rejected', () => {
    const result = validateCodexNutritionV1(validV1({ source_releases: {} }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing_source_release:usda_fdc');
  });

  it('8. an evidence release mismatch is rejected', () => {
    const value = validV1();
    value.ingredients[0].source_release = '2019-04';
    expect(validateCodexNutritionV1(value).errors).toContain('ingredient_release_mismatch');
  });

  it('9. undeclared and extra release entries are rejected', () => {
    const extra = validV1({ source_releases: { usda_fdc: '2026-04', open_food_facts: '2026-09-01' } });
    expect(validateCodexNutritionV1(extra).errors).toContain('source_release_without_source:open_food_facts');
    const unknown = validV1({ source_releases: { usda_fdc: '2026-04', bogus: 'x' } as never });
    expect(validateCodexNutritionV1(unknown).errors).toContain('unknown_source_release');
  });

  it('10. mixed-source releases are bound independently', () => {
    const value = validV1({
      sources: ['usda_fdc', 'open_food_facts'],
      source_releases: { usda_fdc: '2026-04', open_food_facts: '2026-09-01' },
    });
    value.ingredients[1] = {
      line_ref: '2 buns',
      source: 'open_food_facts',
      source_food_id: '0012345678901',
      source_release: '2026-09-01',
      match_status: 'confirmed',
      resolved: true,
      user_confirmed: true,
    };
    expect(validateCodexNutritionV1(value).ok).toBe(true);

    const mismatched = validV1({
      sources: ['usda_fdc', 'open_food_facts'],
      source_releases: { usda_fdc: '2026-04', open_food_facts: '2026-09-01' },
    });
    mismatched.ingredients[1] = {
      ...mismatched.ingredients[1],
      source: 'open_food_facts',
      source_release: '2026-04',
    };
    expect(validateCodexNutritionV1(mismatched).errors).toContain('ingredient_release_mismatch');
  });

  it('rejects duplicate releases and a curated_reference claiming USDA identity', () => {
    const duplicate = validV1({
      sources: ['usda_fdc', 'curated_reference'],
      source_releases: { usda_fdc: '2026-04', curated_reference: '2026-04' },
    });
    expect(validateCodexNutritionV1(duplicate).errors).toContain('duplicate_source_release');

    const curated = validV1({
      sources: ['curated_reference'],
      source_releases: { curated_reference: 'usda-fdc-2026' },
      ingredients: [
        {
          line_ref: '1 cup oats',
          source: 'curated_reference',
          source_food_id: 'oats',
          source_release: 'usda-fdc-2026',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
        },
      ],
    });
    expect(validateCodexNutritionV1(curated).errors).toContain('curated_reference_usda_identity');
  });

  it('user_manual declares no release and uses the fixed server-owned marker', () => {
    expect(USER_MANUAL_RELEASE_ID).toBe('user_manual');
    const valid = validV1({
      sources: ['user_manual'],
      source_releases: {},
      ingredients: [
        {
          line_ref: 'a pinch of salt',
          source: 'user_manual',
          source_food_id: 'salt',
          source_release: USER_MANUAL_RELEASE_ID,
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
        },
      ],
      manual_override: { overridden_at: '2026-09-14T00:00:00.000Z' },
    });
    expect(validateCodexNutritionV1(valid).ok).toBe(true);

    const wrongMarker = validV1({
      sources: ['user_manual'],
      source_releases: {},
      ingredients: [
        {
          line_ref: 'a pinch of salt',
          source: 'user_manual',
          source_food_id: 'salt',
          source_release: 'usda-2026',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
        },
      ],
      manual_override: { overridden_at: '2026-09-14T00:00:00.000Z' },
    });
    expect(validateCodexNutritionV1(wrongMarker).errors).toContain('user_manual_release_mismatch');

    const declaredRelease = validV1({ sources: ['user_manual'], source_releases: { user_manual: 'x' } as never });
    expect(validateCodexNutritionV1(declaredRelease).errors).toContain('user_manual_release_not_allowed');
  });
});

describe('UTF-8 serialized byte limit (Finding 3)', () => {
  it('11. counts two-, three-, and four-byte characters correctly', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('aé€😀')).toBe(10);
    expect(serializedBlockBytes({ schema: 2, data: '😀' })).toBe(
      utf8ByteLength(JSON.stringify({ schema: 2, data: '😀' }))
    );
  });

  it('12. accepts an exact 64 KiB block and rejects one byte over', () => {
    const overhead = utf8ByteLength(JSON.stringify({ schema: 2, data: '' }));
    const fill = MAX_SERIALIZED_BYTES - overhead;
    expect(serializedBlockBytes({ schema: 2, data: 'a'.repeat(fill) })).toBe(MAX_SERIALIZED_BYTES);
    expect(serializedBlockBytes({ schema: 2, data: 'a'.repeat(fill + 1) })).toBe(Infinity);

    const multibyteFill = (MAX_SERIALIZED_BYTES - overhead) / 2;
    expect(serializedBlockBytes({ schema: 2, data: 'é'.repeat(multibyteFill) })).toBe(MAX_SERIALIZED_BYTES);
    expect(serializedBlockBytes({ schema: 2, data: 'é'.repeat(multibyteFill + 1) })).toBe(Infinity);
  });

  it('applies the byte rule to opaque data and recognized extensions', () => {
    // Opaque data respects the structural bounds but can still exceed 64 KiB.
    const big = 'x'.repeat(MAX_EXTENSION_STRING);
    const oversized = { schema: 2, items: new Array(MAX_EXTENSION_ARRAY).fill(big) };
    expect(decodeCodexNutrition(oversized).kind).toBe('malformed');
    expect(decodeCodexNutrition({ schema: 4, small: 'ok' }).kind).toBe('opaque');

    // The whole-block byte budget is enforced during materialization, so an
    // oversized recognized block fails closed before field diagnostics.
    const value = validV1({ extensions: { many: new Array(MAX_EXTENSION_ARRAY).fill(big) } });
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('unsafe_value:oversized');
  });

  it('never silently truncates oversized output', () => {
    const big = 'x'.repeat(MAX_EXTENSION_STRING);
    const opaque = { kind: 'opaque' as const, schema: 2, data: { many: new Array(MAX_EXTENSION_ARRAY).fill(big) } };
    expect(() => encodeCodexNutrition(opaque)).toThrow();
  });
});

describe('hostile programmatic values fail closed (Finding 4)', () => {
  it('13. rejects getters and setters without invoking them', () => {
    const value = validV1();
    let getterCalls = 0;
    Object.defineProperty(value, 'status', {
      get() {
        getterCalls += 1;
        return 'complete';
      },
      enumerable: true,
      configurable: true,
    });
    expect(validateCodexNutritionV1(value).ok).toBe(false);
    expect(getterCalls).toBe(0);

    const nested = validV1();
    let nestedCalls = 0;
    Object.defineProperty(nested.nutrients.calories as object, 'amount', {
      get() {
        nestedCalls += 1;
        return 540;
      },
      enumerable: true,
      configurable: true,
    });
    expect(validateCodexNutritionV1(nested).ok).toBe(false);
    expect(nestedCalls).toBe(0);

    const setterOnly: Record<string, unknown> = {};
    let setterCalls = 0;
    Object.defineProperty(setterOnly, 'schema', {
      set() {
        setterCalls += 1;
      },
      enumerable: true,
      configurable: true,
    });
    expect(validateCodexNutritionV1(setterOnly).ok).toBe(false);
    expect(setterCalls).toBe(0);
  });

  it('14. a throwing getter returns a validation failure, not an exception', () => {
    const value = validV1();
    Object.defineProperty(value, 'sources', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => validateCodexNutritionV1(value)).not.toThrow();
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/unsafe_value|validation_error/);
  });

  it('15. hostile proxy/reflection failures fail closed', () => {
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
        getOwnPropertyDescriptor() {
          throw new Error('gopd');
        },
        getPrototypeOf() {
          throw new Error('gpo');
        },
      }
    );
    expect(() => validateCodexNutritionV1(hostileProxy)).not.toThrow();
    expect(validateCodexNutritionV1(hostileProxy).ok).toBe(false);
    expect(decodeCodexNutrition(hostileProxy).kind).toBe('malformed');
  });

  it('16. attacker-controlled toJSON is never called', () => {
    let toJsonCalls = 0;
    const value = validV1() as CodexNutritionV1 & { toJSON?: () => unknown };
    value.toJSON = () => {
      toJsonCalls += 1;
      return {};
    };
    expect(validateCodexNutritionV1(value).ok).toBe(false);
    expect(toJsonCalls).toBe(0);

    let directCalls = 0;
    const serializable = {
      toJSON() {
        directCalls += 1;
        return { a: 1 };
      },
    };
    expect(serializedBlockBytes(serializable)).toBe(Infinity);
    expect(directCalls).toBe(0);
  });

  it('17. cycles and unusual objects are rejected', () => {
    const cyclic: Record<string, unknown> = { schema: 2 };
    cyclic.self = cyclic;
    expect(isPlainSafeValue(cyclic)).toBe(false);
    expect(decodeCodexNutrition(cyclic).kind).toBe('malformed');

    expect(isPlainSafeValue(new Date())).toBe(false);
    expect(isPlainSafeValue(new Map())).toBe(false);
    expect(isPlainSafeValue(new Set())).toBe(false);
    expect(isPlainSafeValue(new Uint8Array([1, 2]))).toBe(false);
    class Sample {
      value = 1;
    }
    expect(isPlainSafeValue(new Sample())).toBe(false);
    expect(isPlainSafeValue(() => 1)).toBe(false);
    expect(isPlainSafeValue(10n)).toBe(false);
    expect(isPlainSafeValue(undefined)).toBe(false);
    const symbolKeyed: Record<PropertyKey, unknown> = { ok: 1 };
    symbolKeyed[Symbol('s')] = 1;
    expect(isPlainSafeValue(symbolKeyed)).toBe(false);
    const hidden: Record<string, unknown> = {};
    Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
    expect(isPlainSafeValue(hidden)).toBe(false);
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    expect(isPlainSafeValue(sparse)).toBe(false);
  });
});

describe('negative zero is rejected everywhere (Finding 6)', () => {
  it('20. rejects -0 in every authoritative numeric position', () => {
    expect(isNegativeZero(-0)).toBe(true);
    expect(isValidNutrientAmount(-0)).toBe(false);
    expect(isValidNutrientAmount(0)).toBe(true);
    expect(() => convertUnit(-0, 'g', 'mg')).toThrow();
    expect(() => convertEnergy(-0, 'kcal', 'kj')).toThrow();
    expect(dailyValuePercent('protein', -0, 'g', DV_STANDARD_ID)).toEqual({
      available: false,
      reason: 'invalid_amount',
    });

    const amount = validV1();
    amount.nutrients.protein = {
      amount: -0,
      unit: 'g',
      status: 'complete',
      coverage: 1,
      covered_ingredient_count: 2,
      measurable_ingredient_count: 2,
    };
    expect(validateCodexNutritionV1(amount).errors).toContain('nutrient_invalid_amount:protein');

    expect(validateCodexNutritionV1(validV1({ servings: -0 })).errors).toContain('invalid_servings');

    const coverage = validV1();
    coverage.nutrients.protein = {
      amount: 1,
      unit: 'g',
      status: 'partial',
      coverage: -0,
      covered_ingredient_count: 0,
      measurable_ingredient_count: 2,
    };
    expect(validateCodexNutritionV1(coverage).errors).toContain('nutrient_invalid_coverage:protein');

    const covered = validV1();
    covered.nutrients.protein = {
      amount: 1,
      unit: 'g',
      status: 'partial',
      coverage: 0,
      covered_ingredient_count: -0,
      measurable_ingredient_count: 2,
    };
    expect(validateCodexNutritionV1(covered).errors).toContain('nutrient_invalid_covered:protein');

    const measurable = validV1();
    measurable.nutrients.protein = {
      amount: 1,
      unit: 'g',
      status: 'partial',
      coverage: 0,
      covered_ingredient_count: 0,
      measurable_ingredient_count: -0,
    };
    expect(validateCodexNutritionV1(measurable).errors).toContain('nutrient_invalid_measurable:protein');
  });

  it('21. a positive source-reported zero remains valid', () => {
    const value = validV1();
    value.nutrients.calories = {
      amount: 0,
      unit: 'kcal',
      status: 'complete',
      coverage: 1,
      covered_ingredient_count: 2,
      measurable_ingredient_count: 2,
    };
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(true);
    expect(result.value?.nutrients.calories?.amount).toBe(0);
    expect(dailyValuePercent('protein', 0, 'g', DV_STANDARD_ID)).toEqual({
      available: true,
      percent: 0,
      standard: DV_STANDARD_ID,
    });
  });

  it('rejects -0 on an ingredient amount', () => {
    const value = validV1();
    value.ingredients[0] = { ...value.ingredients[0], amount: { value: -0, unit: 'g' } };
    expect(validateCodexNutritionV1(value).errors).toContain('invalid_ingredient_amount');
  });
});

describe('coverage arithmetic — exact and unconditional (Final Finding 1)', () => {
  function protein(overrides: Record<string, unknown>) {
    const value = validV1();
    value.nutrients.protein = {
      amount: 10,
      unit: 'g',
      status: 'complete',
      coverage: 1,
      covered_ingredient_count: 2,
      measurable_ingredient_count: 2,
      ...overrides,
    } as never;
    return value;
  }

  it('rejects impossible covered > measurable counts before ratio comparison', () => {
    const result = validateCodexNutritionV1(
      protein({ covered_ingredient_count: 3, measurable_ingredient_count: 2, coverage: 1 })
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('nutrient_covered_exceeds_measurable:protein');
    // No ratio comparison is attempted for impossible counts.
    expect(result.errors).not.toContain('nutrient_coverage_mismatch:protein');
  });

  it('accepts equal counts with exact coverage 1', () => {
    expect(validateCodexNutritionV1(protein({})).ok).toBe(true);
  });

  it('rejects covered below measurable with coverage falsely set to 1', () => {
    const result = validateCodexNutritionV1(
      protein({ covered_ingredient_count: 1, measurable_ingredient_count: 2, coverage: 1 })
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('nutrient_coverage_mismatch:protein');
    expect(result.errors).toContain('nutrient_complete_with_partial_coverage:protein');
  });

  it('rejects equal counts with coverage below 1 by any amount (0.9999999995)', () => {
    const result = validateCodexNutritionV1(protein({ coverage: 0.9999999995 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('nutrient_coverage_mismatch:protein');
    expect(result.errors).toContain('nutrient_complete_coverage_not_one:protein');
  });

  it('rejects coverage above 1 by Number.EPSILON', () => {
    expect(validateCodexNutritionV1(protein({ coverage: 1 + Number.EPSILON })).errors).toContain(
      'nutrient_invalid_coverage:protein'
    );
  });

  it('rejects zero and negative measurable counts', () => {
    expect(
      validateCodexNutritionV1(
        protein({ status: 'partial', measurable_ingredient_count: 0, covered_ingredient_count: 0, coverage: 0 })
      ).errors
    ).toContain('nutrient_invalid_measurable:protein');
    expect(validateCodexNutritionV1(protein({ measurable_ingredient_count: -1 })).errors).toContain(
      'nutrient_invalid_measurable:protein'
    );
  });

  it('rejects unsafe-integer counts', () => {
    expect(
      validateCodexNutritionV1(protein({ measurable_ingredient_count: Number.MAX_SAFE_INTEGER + 1 })).errors
    ).toContain('nutrient_invalid_measurable:protein');
    expect(
      validateCodexNutritionV1(protein({ covered_ingredient_count: Number.MAX_SAFE_INTEGER + 1 })).errors
    ).toContain('nutrient_invalid_covered:protein');
  });

  it('rejects negative-zero counts', () => {
    expect(validateCodexNutritionV1(protein({ measurable_ingredient_count: -0 })).errors).toContain(
      'nutrient_invalid_measurable:protein'
    );
    expect(validateCodexNutritionV1(protein({ covered_ingredient_count: -0 })).errors).toContain(
      'nutrient_invalid_covered:protein'
    );
  });

  it('rejects contradictory count/coverage combinations', () => {
    expect(
      validateCodexNutritionV1(
        protein({ covered_ingredient_count: 1, measurable_ingredient_count: 3, coverage: 1 })
      ).errors
    ).toContain('nutrient_coverage_mismatch:protein');
    expect(
      validateCodexNutritionV1(
        protein({ covered_ingredient_count: 2, measurable_ingredient_count: 4, coverage: 0.5 })
      ).ok
    ).toBe(false);
  });
});

describe('dataset/manual provenance (Final Finding 2)', () => {
  const manualEvidence = {
    line_ref: 'a pinch of salt',
    source: 'user_manual' as const,
    source_food_id: 'salt',
    source_release: USER_MANUAL_RELEASE_ID,
    match_status: 'confirmed' as const,
    resolved: true,
    user_confirmed: true,
  };

  it('rejects USDA declared with only manual evidence', () => {
    const value = validV1({
      sources: ['usda_fdc', 'user_manual'],
      source_releases: { usda_fdc: '2026-04' },
      ingredients: [manualEvidence],
    });
    expect(validateCodexNutritionV1(value).errors).toContain('dataset_source_without_resolved_evidence:usda_fdc');
  });

  it('requires evidence from every declared dataset source', () => {
    const value = validV1({
      sources: ['usda_fdc', 'open_food_facts'],
      source_releases: { usda_fdc: '2026-04', open_food_facts: '2026-09-01' },
    });
    expect(validateCodexNutritionV1(value).errors).toContain(
      'dataset_source_without_resolved_evidence:open_food_facts'
    );
  });

  it('rejects unused declared dataset sources', () => {
    const value = validV1({
      sources: ['usda_fdc', 'curated_reference'],
      source_releases: { usda_fdc: '2026-04', curated_reference: 'local-1' },
    });
    expect(validateCodexNutritionV1(value).errors).toContain(
      'dataset_source_without_resolved_evidence:curated_reference'
    );
  });

  it('rejects manual-only complete with evidence but no override', () => {
    const value = validV1({
      sources: ['user_manual'],
      source_releases: {},
      ingredients: [manualEvidence],
    });
    expect(validateCodexNutritionV1(value).errors).toContain('manual_only_requires_manual_override');
  });

  it('rejects manual-only complete with a malformed override', () => {
    const value = validV1({
      sources: ['user_manual'],
      source_releases: {},
      ingredients: [],
      manual_override: { overridden_at: 'not-a-timestamp' },
    });
    expect(validateCodexNutritionV1(value).errors).toContain('invalid_manual_override');
  });

  it('rejects manual-only complete with a dataset release', () => {
    const value = validV1({
      sources: ['user_manual'],
      source_releases: { usda_fdc: '2026-04' },
      ingredients: [],
      manual_override: { overridden_at: '2026-09-14T00:00:00.000Z' },
    });
    expect(validateCodexNutritionV1(value).errors).toContain('source_release_without_source:usda_fdc');
  });

  it('mixed provenance cannot use the manual-only exception', () => {
    const value = validV1({
      sources: ['usda_fdc', 'user_manual'],
      source_releases: { usda_fdc: '2026-04' },
      ingredients: [],
      manual_override: { overridden_at: '2026-09-14T00:00:00.000Z' },
    });
    expect(validateCodexNutritionV1(value).errors).toContain('dataset_source_without_resolved_evidence:usda_fdc');
  });

  it('a coherent manual-only complete record is accepted', () => {
    const value = validV1({
      sources: ['user_manual'],
      source_releases: {},
      ingredients: [],
      manual_override: { overridden_at: '2026-09-14T00:00:00.000Z' },
    });
    expect(validateCodexNutritionV1(value).ok).toBe(true);
  });
});

describe('hostile encode/clone/materialization (Final Finding 3)', () => {
  it('encode never invokes a discriminator getter', () => {
    let kindCalls = 0;
    const block = validV1() as unknown as Record<string, unknown>;
    Object.defineProperty(block, 'kind', {
      get() {
        kindCalls += 1;
        return 'opaque';
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => encodeCodexNutrition(block as never)).toThrow();
    expect(kindCalls).toBe(0);
  });

  it('clone returns an independent inert clone and never reads original properties', () => {
    const target = { a: 1, nested: { b: 2 } };
    let getCalls = 0;
    const proxy = new Proxy(target, {
      get(t, p, r) {
        getCalls += 1;
        return Reflect.get(t, p, r);
      },
    });
    const clone = cloneSafeValue(proxy) as Record<string, unknown>;
    expect(clone).toEqual({ a: 1, nested: { b: 2 } });
    expect(getCalls).toBe(0);
    (target.nested as { b: number }).b = 99;
    expect((clone.nested as { b: number }).b).toBe(2);
  });

  it('proxy reflection failures return fixed bounded errors', () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('SECRET_MARKER_' + 'Z'.repeat(60000));
        },
        ownKeys() {
          throw new Error('SECRET_MARKER');
        },
      }
    );
    const result = validateCodexNutritionV1(proxy);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).not.toContain('SECRET_MARKER');
    try {
      encodeCodexNutrition(proxy as never);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe(ENCODE_UNSAFE_MESSAGE);
      expect((error as Error).message).not.toContain('SECRET_MARKER');
    }
  });
});

describe('bounded redacted diagnostics (Final Finding 4)', () => {
  it('bounds a 120,000-character unknown key without echoing it', () => {
    const hugeKey = 'k'.repeat(120000);
    const value = { schema: 1, [hugeKey]: 'SECRET_MARKER_VALUE' };
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    const text = result.errors.join(' ');
    expect(text).not.toContain('SECRET_MARKER_VALUE');
    expect(text).not.toContain('k'.repeat(50));
    expect(text.length).toBeLessThanOrEqual(MAX_VALIDATION_DIAGNOSTIC_BYTES);
    for (const error of result.errors) expect(error.length).toBeLessThanOrEqual(MAX_VALIDATION_ERROR_LENGTH);
  });

  it('bounds hundreds of invalid keys', () => {
    const value: Record<string, unknown> = { schema: 1 };
    for (let i = 0; i < 200; i += 1) value[`bad_${i}`] = 'SECRET_MARKER';
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeLessThanOrEqual(MAX_VALIDATION_ERRORS);
    expect(result.errors.join(' ')).not.toContain('SECRET_MARKER');
  });

  it('does not leak a 60,000-character proxy exception message', () => {
    const message = 'SECRET_MARKER_' + 'X'.repeat(60000);
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(message);
        },
      }
    );
    const result = validateCodexNutritionV1(proxy);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).not.toContain('SECRET_MARKER');
    const decoded = decodeCodexNutrition(proxy);
    expect(decoded.kind).toBe('malformed');
    expect(JSON.stringify(decoded)).not.toContain('SECRET_MARKER');
  });

  it('does not echo hostile values resembling secrets', () => {
    const value = validV1() as unknown as Record<string, unknown>;
    value.api_key = 'sk-live-SECRET_MARKER_1234567890';
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).not.toContain('sk-live');
  });

  it('handles deeply nested invalid paths without unbounded output', () => {
    let nested: Record<string, unknown> = { value: 'SECRET_MARKER' };
    for (let i = 0; i < 40; i += 1) nested = { next: nested };
    const result = validateCodexNutritionV1({ schema: 1, deep: nested });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).not.toContain('SECRET_MARKER');
    expect(result.errors.length).toBeLessThanOrEqual(MAX_VALIDATION_ERRORS);
  });
});

describe('incremental JSON UTF-8 accounting (Final Finding 5)', () => {
  it('matches JSON.stringify UTF-8 bytes for bounded inert values', () => {
    const samples = [
      'ascii',
      'quote"back\\slash',
      '\b\f\n\r\t',
      '\u0000\u0001\u001f',
      'é',
      '€',
      '😀',
      '\uD83D\uDE00',
      '\uD800',
      '\uDC00',
      'café ☕ 😀',
    ];
    for (const sample of samples) {
      const value = { a: sample, nested: { b: [sample, { c: sample }] }, n: 1.5, t: true, z: null };
      expect(serializedBlockBytes(value)).toBe(utf8ByteLength(JSON.stringify(value)));
    }
  });

  it('short-circuits a much larger string without stringifying it', () => {
    const spy = vi.spyOn(JSON, 'stringify');
    expect(serializedBlockBytes({ schema: 2, data: 'x'.repeat(1000000) })).toBe(Infinity);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('unknown/undefined field rejection (Final Finding 6)', () => {
  it('rejects an own property whose value is undefined', () => {
    const value = validV1() as unknown as Record<string, unknown>;
    value.extra = undefined;
    const result = validateCodexNutritionV1(value);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/unsafe_value/);
  });

  it('rejects unknown top-level fields of every value kind', () => {
    for (const extra of [-0, 1, 'str', { a: 1 }, [1, 2], true, null]) {
      const value = validV1() as unknown as Record<string, unknown>;
      value.mystery = extra;
      const result = validateCodexNutritionV1(value);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('unknown_field');
    }
  });

  it('rejects unknown nested nutrient fields', () => {
    const value = validV1();
    (value.nutrients.calories as unknown as Record<string, unknown>).mystery = 1;
    expect(validateCodexNutritionV1(value).errors).toContain('nutrient_unknown_field:calories');
  });

  it('rejects unknown manual_override fields including -0', () => {
    const value = validV1({
      manual_override: { overridden_at: '2026-09-14T00:00:00.000Z', amount: -0 } as never,
    });
    expect(validateCodexNutritionV1(value).errors).toContain('unknown_manual_override_field');
  });

  it('rejects unknown evidence amount and unresolved fields', () => {
    const amount = validV1();
    amount.ingredients[0] = { ...amount.ingredients[0], amount: { value: 1, unit: 'g', extra: 1 } as never };
    expect(validateCodexNutritionV1(amount).errors).toContain('unknown_evidence_amount_field');

    const unresolved = validV1({
      status: 'partial',
      unresolved: [{ line_ref: 'salt', reason: 'no_match', extra: 1 } as never],
    });
    expect(validateCodexNutritionV1(unresolved).errors).toContain('unknown_unresolved_field');
  });

  it('rejects accessor, symbol, and non-enumerable unknown properties', () => {
    const accessor = validV1() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'mystery', {
      get() {
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    expect(validateCodexNutritionV1(accessor).errors).toContain('unsafe_value:accessor_or_hidden_property');

    const symbol = validV1() as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol('mystery')] = 1;
    expect(validateCodexNutritionV1(symbol).errors).toContain('unsafe_value:symbol_key');

    const hidden = validV1() as unknown as Record<string, unknown>;
    Object.defineProperty(hidden, 'mystery', { value: 1, enumerable: false, configurable: true });
    expect(validateCodexNutritionV1(hidden).errors).toContain('unsafe_value:accessor_or_hidden_property');
  });

  it('preserves arbitrary bounded keys only inside extensions', () => {
    const value = validV1({ extensions: { arbitrary_key: 'ok', nested: { a: 1 } } });
    expect(validateCodexNutritionV1(value).ok).toBe(true);
  });
});

describe('curated release reserved-token normalization (Final Finding 7)', () => {
  function curated(release: string) {
    return validV1({
      sources: ['curated_reference'],
      source_releases: { curated_reference: release },
      ingredients: [
        {
          line_ref: '1 cup oats',
          source: 'curated_reference',
          source_food_id: 'oats',
          source_release: release,
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
        },
      ],
    });
  }

  it('rejects separator-obfuscated USDA/FDC identities', () => {
    const releases = [
      'usda',
      'USDA',
      'fdc',
      'FDC',
      'u-s-d-a',
      'u_s_d_a',
      'u.s.d.a',
      'f-d-c',
      'f_d_c',
      'U-S-D-A_F-D-C_2026',
      'us.da',
      'f.d.c',
    ];
    for (const release of releases) {
      expect(validateCodexNutritionV1(curated(release)).errors).toContain('curated_reference_usda_identity');
    }
  });

  it('accepts ordinary legitimate curated release ids', () => {
    for (const release of ['curated_2026_01', 'local-2024', 'internal_v3', 'kitchenref-1']) {
      expect(validateCodexNutritionV1(curated(release)).ok).toBe(true);
    }
  });

  it('normalization is deterministic and locale-independent', () => {
    expect(normalizeReleaseIdentity('U-S-D-A')).toBe('usda');
    expect(normalizeReleaseIdentity('F.D.C.')).toBe('fdc');
    expect(containsReservedUsdaIdentity('u_s_d_a')).toBe(true);
    expect(containsReservedUsdaIdentity('curated_2026')).toBe(false);
  });
});
