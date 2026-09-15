import { describe, it, expect } from 'vitest';
import { adaptUsdaFood } from '../../src/core/nutritionV2/usda/adapter';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import { encodeCodexNutrition } from '../../src/core/nutritionV2/validate';
import {
  TEST_UPSTREAM_RELEASES,
  FOUNDATION_RAW,
  SR_LEGACY_RAW,
  FNDDS_RAW,
  explicitZeroRaw,
  missingNutrientRaw,
  duplicateMappedRaw,
  conflictingEnergyRaw,
  kjOnlyEnergyRaw,
  wrongUnitRaw,
  iuVitaminDRaw,
  folateTotalRaw,
  invalidFdcIdRaw,
  invalidDataTypeRaw,
  unsafeDescriptionRaw,
  oversizedRaw,
  rawOversizedRaw,
  deepRaw,
  negativeAmountRaw,
  negativeZeroAmountRaw,
  nonFiniteAmountRaw,
  overPreciseAmountRaw,
  excessiveAmountRaw,
  validPortionRaw,
  absentPortionRaw,
  malformedPortionRaw,
  zeroGramPortionRaw,
  dangerousKeyRaw,
  cloneFixture,
} from '../fixtures/usdaFixtures';
import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';

const RELEASE = 'usda_fdc_phase1adapter';

function ctx(dataType: UsdaDataType, overrides: Record<string, unknown> = {}) {
  return {
    bundle_release: RELEASE,
    upstream_release: TEST_UPSTREAM_RELEASES[dataType],
    data_type: dataType,
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    ...overrides,
  };
}

function failureOf(result: ReturnType<typeof adaptUsdaFood>): string | undefined {
  return result.ok ? undefined : (result as { ok: false; failure: { code: string } }).failure.code;
}

describe('usda adapter — supported data types (official transport labels)', () => {
  it('adapts a Foundation-shaped record to a canonical per-100-g record', () => {
    const result = adaptUsdaFood(FOUNDATION_RAW, ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.record;
    expect(record.source).toBe('usda_fdc');
    expect(record.data_type).toBe('foundation');
    expect(record.basis).toBe('per_100_g');
    expect(record.nutrients.protein?.amount_per_100g).toBe(3.15);
    expect(record.nutrients.calories?.amount_per_100g).toBe(61);
    expect(record.nutrients.vitamin_a?.unit).toBe('ug_rae');
    // `added_sugars` (USDA 1235) is absent from the pinned releases: an
    // unmapped entry is ignored, never inferred from total sugars.
    expect('added_sugars' in record.nutrients).toBe(false);
    expect(record.nutrient_map_version).toBe(USDA_NUTRIENT_MAP_VERSION);
  });

  it('adapts an SR Legacy-shaped record', () => {
    const result = adaptUsdaFood(SR_LEGACY_RAW, ctx('sr_legacy'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.data_type).toBe('sr_legacy');
    expect(result.record.upstream_release).toBe(TEST_UPSTREAM_RELEASES.sr_legacy);
    expect(result.record.nutrients.saturated_fat?.amount_per_100g).toBe(5.686);
    expect(result.record.nutrients.cholesterol?.amount_per_100g).toBe(71);
  });

  it('adapts an FNDDS-shaped record and maps DFE forms', () => {
    const result = adaptUsdaFood(FNDDS_RAW, ctx('fndds'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.data_type).toBe('fndds');
    expect(result.record.nutrients.folate?.unit).toBe('ug_dfe');
    expect(result.record.nutrients.folate?.usda_nutrient_id).toBe(1190);
    // niacin is NOT mapped: the pinned downloads expose no NE component.
    expect('niacin' in result.record.nutrients).toBe(false);
  });

  it('rejects case-altered, partial, branded, and internal labels', () => {
    for (const label of ['foundation', 'FOUNDATION', 'Foundation Foods', 'Branded', 'Survey', 'FNDDS', 'SR-Legacy', 'Experimental']) {
      const raw = { ...cloneFixture(FOUNDATION_RAW), dataType: label };
      expect(failureOf(adaptUsdaFood(raw, ctx('foundation'))), label).toBe('unsupported_data_type');
    }
  });
});

describe('usda adapter — stable-ID mapping and units', () => {
  it('maps by stable USDA id, never by display name', () => {
    const byId = cloneFixture(FOUNDATION_RAW);
    byId.foodNutrients = [{ nutrient: { id: 1003, name: 'Definitely Not Protein', unitName: 'g' }, amount: 7 }];
    const result = adaptUsdaFood(byId, ctx('foundation'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.nutrients.protein?.amount_per_100g).toBe(7);

    const byName = cloneFixture(FOUNDATION_RAW);
    byName.foodNutrients = [{ nutrient: { id: 999999, name: 'Protein', unitName: 'g' }, amount: 7 }];
    const nameResult = adaptUsdaFood(byName, ctx('foundation'));
    expect(nameResult.ok).toBe(false);
    expect(failureOf(nameResult)).toBe('no_supported_nutrients');
  });

  it('normalizes official micro-sign units and rejects wrong units', () => {
    const micro = cloneFixture(FOUNDATION_RAW);
    micro.foodNutrients = [{ nutrient: { id: 1103, unitName: '\u00b5g' }, amount: 5 }];
    const microResult = adaptUsdaFood(micro, ctx('foundation'));
    expect(microResult.ok).toBe(true);
    if (microResult.ok) expect(microResult.record.nutrients.selenium?.amount_per_100g).toBe(5);

    expect(failureOf(adaptUsdaFood(wrongUnitRaw(), ctx('foundation')))).toBe('unit_mismatch');
  });

  it('ignores unsupported nutrients without retaining them', () => {
    const result = adaptUsdaFood(FOUNDATION_RAW, ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = Object.values(result.record.nutrients).map((entry) => entry?.usda_nutrient_id);
    expect(ids).not.toContain(1009);
    expect(JSON.stringify(result.record)).not.toContain('Starch');
  });

  it('keeps a missing supported nutrient absent (never synthesized as zero)', () => {
    const result = adaptUsdaFood(missingNutrientRaw(), ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('protein' in result.record.nutrients).toBe(false);
  });

  it('preserves an explicit source-reported zero as zero', () => {
    const result = adaptUsdaFood(explicitZeroRaw(), ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.nutrients.protein?.amount_per_100g).toBe(0);
    expect(result.record.nutrients.calories?.amount_per_100g).toBe(0);
  });

  it('treats a null amount as absent (never zero) and keeps zero distinct', () => {
    const nulled = cloneFixture(FOUNDATION_RAW);
    nulled.foodNutrients = [{ nutrient: { id: 1003, unitName: 'g' }, amount: null }];
    const nullResult = adaptUsdaFood(nulled, ctx('foundation'));
    expect(nullResult.ok).toBe(false);
    expect(failureOf(nullResult)).toBe('no_supported_nutrients');
  });

  it('rejects duplicate/conflicting values for one canonical nutrient', () => {
    expect(failureOf(adaptUsdaFood(duplicateMappedRaw(), ctx('foundation')))).toBe('duplicate_nutrient');
  });
});

describe('usda adapter — energy policy', () => {
  it('rejects conflicting direct kcal components', () => {
    expect(failureOf(adaptUsdaFood(conflictingEnergyRaw(), ctx('foundation')))).toBe('duplicate_nutrient');
  });

  it('uses the exact 4.184 helper for a kJ-only fallback and never sums', () => {
    const result = adaptUsdaFood(kjOnlyEnergyRaw(), ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.nutrients.calories?.amount_per_100g).toBe(100);
    expect(result.record.nutrients.calories?.usda_nutrient_id).toBe(1062);
    expect(result.record.nutrients.calories?.converted).toBe(true);
  });

  it('prefers the direct kcal component over the kJ fallback without duplication', () => {
    const both = cloneFixture(FOUNDATION_RAW);
    both.foodNutrients = [
      { nutrient: { id: 1008, unitName: 'kcal' }, amount: 100 },
      { nutrient: { id: 1062, unitName: 'kJ' }, amount: 99999 },
    ];
    const result = adaptUsdaFood(both, ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.nutrients.calories?.amount_per_100g).toBe(100);
    expect(result.record.nutrients.calories?.usda_nutrient_id).toBe(1008);
  });
});

describe('usda adapter — no inference or form guessing', () => {
  it('does not map IU or biological-form nutrients by name', () => {
    const iu = adaptUsdaFood(iuVitaminDRaw(), ctx('foundation'));
    expect(iu.ok).toBe(true);
    if (iu.ok) expect('vitamin_d' in iu.record.nutrients).toBe(false);

    const folate = adaptUsdaFood(folateTotalRaw(), ctx('foundation'));
    expect(folate.ok).toBe(true);
    if (folate.ok) expect('folate' in folate.record.nutrients).toBe(false);

    const retinol = cloneFixture(FOUNDATION_RAW);
    retinol.foodNutrients = [
      { nutrient: { id: 1104, unitName: 'IU' }, amount: 200 },
      { nutrient: { id: 1105, unitName: '\u00b5g' }, amount: 100 },
      { nutrient: { id: 1008, unitName: 'kcal' }, amount: 10 },
    ];
    const retinolResult = adaptUsdaFood(retinol, ctx('foundation'));
    expect(retinolResult.ok).toBe(true);
    if (retinolResult.ok) expect('vitamin_a' in retinolResult.record.nutrients).toBe(false);
  });
});

describe('usda adapter — shape and release validation', () => {
  it('rejects an invalid FDC id and an unsupported data type', () => {
    expect(failureOf(adaptUsdaFood(invalidFdcIdRaw(), ctx('foundation')))).toBe('invalid_fdc_id');
    expect(failureOf(adaptUsdaFood(invalidDataTypeRaw(), ctx('foundation')))).toBe('unsupported_data_type');
  });

  it('rejects a data-type release mismatch', () => {
    expect(failureOf(adaptUsdaFood(FOUNDATION_RAW, ctx('sr_legacy')))).toBe('release_mismatch');
    expect(failureOf(adaptUsdaFood(FNDDS_RAW, ctx('foundation')))).toBe('release_mismatch');
  });

  it('rejects unknown root fields and a malformed shape', () => {
    expect(failureOf(adaptUsdaFood({ ...cloneFixture(FOUNDATION_RAW), extra: 1 }, ctx('foundation')))).toBe('malformed');
    expect(failureOf(adaptUsdaFood({ fdcId: 1 }, ctx('foundation')))).toBe('malformed');
    expect(failureOf(adaptUsdaFood('not an object', ctx('foundation')))).toBe('malformed');
    expect(failureOf(adaptUsdaFood(dangerousKeyRaw(), ctx('foundation')))).toBe('unsafe');
  });

  it('rejects unknown nested nutrient and portion fields', () => {
    const badNutrient = cloneFixture(FOUNDATION_RAW);
    badNutrient.foodNutrients = [{ nutrient: { id: 1003, unitName: 'g', evil: true }, amount: 1 }];
    expect(failureOf(adaptUsdaFood(badNutrient, ctx('foundation')))).toBe('malformed');

    const badPortion = cloneFixture(validPortionRaw()) as Record<string, any>;
    badPortion.foodPortions[0].evil = true;
    expect(failureOf(adaptUsdaFood(badPortion, ctx('foundation')))).toBe('malformed');
  });
});

describe('usda adapter — bounds and hostile input', () => {
  it('rejects oversized, deep, and too-many-nutrient input without throwing', () => {
    expect(() => adaptUsdaFood(oversizedRaw(), ctx('foundation'))).not.toThrow();
    expect(failureOf(adaptUsdaFood(oversizedRaw(), ctx('foundation')))).toBe('oversized');

    expect(() => adaptUsdaFood(rawOversizedRaw(), ctx('foundation'))).not.toThrow();
    expect(failureOf(adaptUsdaFood(rawOversizedRaw(), ctx('foundation')))).toBe('record_too_large');

    expect(() => adaptUsdaFood(deepRaw(), ctx('foundation'))).not.toThrow();
    expect(failureOf(adaptUsdaFood(deepRaw(), ctx('foundation')))).toBe('malformed');

    const many = cloneFixture(FOUNDATION_RAW);
    many.foodNutrients = Array.from({ length: 300 }, () => ({ nutrient: { id: 1003, unitName: 'g' }, amount: 1 }));
    expect(failureOf(adaptUsdaFood(many, ctx('foundation')))).toBe('oversized');
  });

  it('rejects negative, -0, non-finite, excessive, and over-precise amounts', () => {
    expect(failureOf(adaptUsdaFood(negativeAmountRaw(), ctx('foundation')))).toBe('invalid_nutrient');
    expect(failureOf(adaptUsdaFood(negativeZeroAmountRaw(), ctx('foundation')))).toBe('invalid_nutrient');
    expect(failureOf(adaptUsdaFood(nonFiniteAmountRaw(), ctx('foundation')))).toBe('invalid_nutrient');
    expect(failureOf(adaptUsdaFood(excessiveAmountRaw(), ctx('foundation')))).toBe('invalid_nutrient');
    expect(failureOf(adaptUsdaFood(overPreciseAmountRaw(), ctx('foundation')))).toBe('invalid_nutrient');
  });

  it('never invokes getters, toJSON, valueOf, or proxy traps', () => {
    let getterCalled = false;
    const accessor: Record<string, unknown> = {
      fdcId: 1,
      dataType: 'Foundation',
      foodNutrients: [{ nutrient: { id: 1003, unitName: 'g' }, amount: 1 }],
    };
    Object.defineProperty(accessor, 'description', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalled = true;
        return 'x';
      },
    });
    expect(() => adaptUsdaFood(accessor, ctx('foundation'))).not.toThrow();
    expect(getterCalled).toBe(false);
    expect(failureOf(adaptUsdaFood(accessor, ctx('foundation')))).toBe('unsafe');

    let toJsonCalled = false;
    let valueOfCalled = false;
    const coercive: Record<string, unknown> = {
      fdcId: 1,
      dataType: 'Foundation',
      description: 'x',
      foodNutrients: [{ nutrient: { id: 1003, unitName: 'g' }, amount: 1 }],
      toJSON() {
        toJsonCalled = true;
        return {};
      },
      valueOf() {
        valueOfCalled = true;
        return 1;
      },
    };
    expect(() => adaptUsdaFood(coercive, ctx('foundation'))).not.toThrow();
    expect(toJsonCalled).toBe(false);
    expect(valueOfCalled).toBe(false);
    expect(failureOf(adaptUsdaFood(coercive, ctx('foundation')))).toBe('malformed');

    const target = cloneFixture(FOUNDATION_RAW);
    const hostileProxy = new Proxy(target, {
      get() {
        throw new Error('get trap');
      },
      has() {
        throw new Error('has trap');
      },
      ownKeys() {
        throw new Error('ownKeys trap');
      },
    });
    expect(() => adaptUsdaFood(hostileProxy, ctx('foundation'))).not.toThrow();
    expect(failureOf(adaptUsdaFood(hostileProxy, ctx('foundation')))).toBe('unsafe');
  });

  it('produces bounded, input-redacted failures', () => {
    const secret = 'SUPER-SECRET-INPUT-VALUE';
    const raw = { ...cloneFixture(FOUNDATION_RAW), fdcId: 0, description: secret };
    const result = adaptUsdaFood(raw, ctx('foundation'));
    expect(result.ok).toBe(false);
    const failure = (result as { ok: false; failure: { code: string; message: string } }).failure;
    expect(failure.code).toBe('invalid_fdc_id');
    expect(failure.message).toBe('usda_fdc_id_invalid');
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(failure.message.length).toBeLessThanOrEqual(120);
  });
});

describe('usda adapter — output contract', () => {
  it('returns an immutable canonical record', () => {
    const result = adaptUsdaFood(FOUNDATION_RAW, ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.record;
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.nutrients)).toBe(true);
    expect(Object.isFrozen(record.portions)).toBe(true);
    expect(() => {
      (record as { description: string }).description = 'mutated';
    }).toThrow();
  });

  it('produces a deterministic canonical digest independent of key/entry order', () => {
    const a = cloneFixture(FOUNDATION_RAW);
    const b = cloneFixture(FOUNDATION_RAW);
    b.foodNutrients = b.foodNutrients.map((entry: Record<string, unknown>) => {
      const nutrient = entry.nutrient as Record<string, unknown>;
      return { amount: entry.amount, nutrient: { unitName: nutrient.unitName, id: nutrient.id } };
    });
    const ra = adaptUsdaFood(a, ctx('foundation'));
    const rb = adaptUsdaFood(b, ctx('foundation'));
    expect(ra.ok && rb.ok).toBe(true);
    if (ra.ok && rb.ok) expect(ra.record.record_digest).toBe(rb.record.record_digest);
  });

  it('never produces %DV and never produces a recipe-total block', () => {
    const result = adaptUsdaFood(FOUNDATION_RAW, ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.record);
    expect(serialized).not.toMatch(/%dv/i);
    expect(serialized).not.toMatch(/"dv"|daily_value/i);
    expect(result.record.basis).toBe('per_100_g');
    expect(() => encodeCodexNutrition(result.record as never)).toThrow();
  });
});

describe('usda adapter — portions (evidence only)', () => {
  it('preserves a valid source-provided gram-weight portion', () => {
    const result = adaptUsdaFood(validPortionRaw(), ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const portion = result.record.portions[0];
    expect(portion.usda_portion_id).toBe(42);
    expect(portion.amount).toBe(1);
    expect(portion.measure).toBe('cup');
    expect(portion.gram_weight).toBe(240);
    expect(portion.modifier).toBe('sliced');
    expect(portion.sequence).toBe(1);
  });

  it('accepts the official Foundation `value` when `amount` is absent', () => {
    const raw = cloneFixture(validPortionRaw()) as Record<string, any>;
    raw.foodPortions[0] = {
      id: 77,
      value: 3,
      measureUnit: { id: 1000, name: 'tablespoon' },
      gramWeight: 45,
      sequenceNumber: 1,
    };
    const result = adaptUsdaFood(raw, ctx('foundation'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.portions[0].amount).toBe(3);
    expect(result.record.portions[0].measure).toBe('tablespoon');
  });

  it('keeps a missing portion amount absent and never invents one', () => {
    const result = adaptUsdaFood(FNDDS_RAW, ctx('fndds'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.portions).toHaveLength(1);
    expect('amount' in result.record.portions[0]).toBe(false);
    expect(result.record.portions[0].gram_weight).toBe(158);
  });

  it('rejects a present `amount: 0` instead of silently omitting it', () => {
    const raw = cloneFixture(validPortionRaw()) as Record<string, any>;
    raw.foodPortions[0].amount = 0;
    expect(failureOf(adaptUsdaFood(raw, ctx('foundation')))).toBe('invalid_portion');
  });

  it('rejects present -0, negative, non-finite, numeric-string, excessive, and over-precise amounts', () => {
    for (const amount of [-0, -1, Number.POSITIVE_INFINITY, Number.NaN, '5', 2_000_000, 1.1234567]) {
      const raw = cloneFixture(validPortionRaw()) as Record<string, any>;
      raw.foodPortions[0].amount = amount;
      expect(failureOf(adaptUsdaFood(raw, ctx('foundation'))), `amount ${String(amount)}`).toBe(
        'invalid_portion'
      );
    }
  });

  it('never falls back to `value` when a present `amount` is invalid', () => {
    const raw = cloneFixture(validPortionRaw()) as Record<string, any>;
    raw.foodPortions[0].amount = 0;
    raw.foodPortions[0].value = 3;
    expect(failureOf(adaptUsdaFood(raw, ctx('foundation')))).toBe('invalid_portion');
  });

  it('uses `value` only when `amount` is genuinely absent', () => {
    const raw = cloneFixture(validPortionRaw()) as Record<string, any>;
    delete raw.foodPortions[0].amount;
    raw.foodPortions[0].value = 3;
    const result = adaptUsdaFood(raw, ctx('foundation'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.portions[0].amount).toBe(3);
  });

  it('enforces the documented amount/value consistency rule', () => {
    const agree = cloneFixture(validPortionRaw()) as Record<string, any>;
    agree.foodPortions[0].amount = 2;
    agree.foodPortions[0].value = 2;
    const agreeResult = adaptUsdaFood(agree, ctx('foundation'));
    expect(agreeResult.ok).toBe(true);
    if (agreeResult.ok) expect(agreeResult.record.portions[0].amount).toBe(2);

    const disagree = cloneFixture(validPortionRaw()) as Record<string, any>;
    disagree.foodPortions[0].amount = 2;
    disagree.foodPortions[0].value = 3;
    expect(failureOf(adaptUsdaFood(disagree, ctx('foundation')))).toBe('invalid_portion');
  });

  it('rejects the whole food record when any portion has an invalid present amount', () => {
    const raw = cloneFixture(validPortionRaw()) as Record<string, any>;
    raw.foodPortions[0].amount = 0;
    const result = adaptUsdaFood(raw, ctx('foundation'));
    expect(result.ok).toBe(false);
    expect(failureOf(result)).toBe('invalid_portion');
  });

  it('keeps a missing portion absent', () => {
    const result = adaptUsdaFood(absentPortionRaw(), ctx('foundation'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.portions).toHaveLength(0);
  });

  it('rejects invalid, negative, zero, -0, and non-finite gram weights', () => {
    expect(failureOf(adaptUsdaFood(malformedPortionRaw(), ctx('foundation')))).toBe('invalid_portion');
    expect(failureOf(adaptUsdaFood(zeroGramPortionRaw(), ctx('foundation')))).toBe('invalid_portion');
    for (const gramWeight of [-1, -0, Number.POSITIVE_INFINITY, Number.NaN, 2_000_000]) {
      const raw = cloneFixture(validPortionRaw());
      raw.foodPortions[0].gramWeight = gramWeight;
      expect(failureOf(adaptUsdaFood(raw, ctx('foundation'))), `gramWeight ${gramWeight}`).toBe('invalid_portion');
    }
  });

  it('rejects contradictory duplicate portion identities', () => {
    const raw = cloneFixture(validPortionRaw()) as Record<string, any>;
    raw.foodPortions = [
      { id: 5, measureUnit: { id: 1000, name: 'cup' }, amount: 1, gramWeight: 100 },
      { id: 5, measureUnit: { id: 1000, name: 'cup' }, amount: 2, gramWeight: 200 },
    ];
    expect(failureOf(adaptUsdaFood(raw, ctx('foundation')))).toBe('invalid_portion');
  });

  it('never selects a portion or infers mass from a volume/count measure', () => {
    const withPortion = adaptUsdaFood(validPortionRaw(), ctx('foundation'));
    const withoutPortion = adaptUsdaFood(absentPortionRaw(), ctx('foundation'));
    expect(withPortion.ok && withoutPortion.ok).toBe(true);
    if (!withPortion.ok || !withoutPortion.ok) return;
    expect(withPortion.record.nutrients).toEqual(withoutPortion.record.nutrients);
    const serialized = JSON.stringify(withPortion.record);
    expect(serialized).not.toMatch(/selected|portion_basis|conversion_basis|density|count_weight/i);
  });
});
