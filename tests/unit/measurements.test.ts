import { describe, it, expect } from 'vitest';
import {
  normalizeMeasurement,
  normalizeUnit,
  getMeasurementKind,
  convertMassToGrams,
  convertVolumeToMl,
  parseAmount,
  normalizeIngredientMeasurement,
  GRAMS_PER_OZ,
  GRAMS_PER_LB,
  ML_PER_CUP,
  ML_PER_TBSP,
  ML_PER_TSP,
  ML_PER_FL_OZ,
  NormalizedUnit,
} from '../../src/utils/measurements';

describe('mass conversions (deterministic)', () => {
  it('g', () => {
    expect(normalizeMeasurement(100, 'g').grams).toBe(100);
    expect(getMeasurementKind('g')).toBe('mass');
  });
  it('kg -> 1000 g', () => {
    expect(normalizeMeasurement(1, 'kg').grams).toBe(1000);
  });
  it('8 oz -> exact grams', () => {
    expect(normalizeMeasurement(8, 'oz').grams).toBeCloseTo(8 * GRAMS_PER_OZ, 10);
  });
  it('1 lb -> exact grams', () => {
    expect(normalizeMeasurement(1, 'lb').grams).toBeCloseTo(GRAMS_PER_LB, 10);
  });
  it('16 oz ≈ 1 lb', () => {
    expect(convertMassToGrams(16, 'oz')).toBeCloseTo(convertMassToGrams(1, 'lb'), 8);
  });
});

describe('volume conversions (deterministic)', () => {
  const cases: Array<[NormalizedUnit, number, number]> = [
    ['ml', 240, 240],
    ['l', 1, 1000],
    ['tsp', 1, ML_PER_TSP],
    ['tbsp', 1, ML_PER_TBSP],
    ['cup', 1, ML_PER_CUP],
    ['fl_oz', 1, ML_PER_FL_OZ],
  ];
  it.each(cases)('%s -> %s ml', (unit, amount, expectedMl) => {
    expect(normalizeMeasurement(amount, unit).milliliters).toBeCloseTo(expectedMl, 10);
    expect(getMeasurementKind(unit)).toBe('volume');
  });
});

describe('aliases / plurals / abbreviations', () => {
  it.each([
    ['grams', 'g'],
    ['kilograms', 'kg'],
    ['ounces', 'oz'],
    ['lbs', 'lb'],
    ['teaspoons', 'tsp'],
    ['tablespoons', 'tbsp'],
    ['cups', 'cup'],
    ['fluid ounces', 'fl_oz'],
    ['fluid ounce', 'fl_oz'],
    ['millilitre', 'ml'],
    ['millilitres', 'ml'],
    ['litre', 'l'],
    ['litres', 'l'],
    ['Cup', 'cup'],
  ] as Array<[string, NormalizedUnit]>)('normalize(%s) -> %s', (input, expected) => {
    expect(normalizeUnit(input)).toBe(expected);
  });

  it('handles punctuation decorators', () => {
    expect(normalizeUnit('fl. oz.')).toBe('fl_oz');
    expect(normalizeUnit('  cups  ')).toBe('cup');
  });
});

describe('count handling (no gram conversion)', () => {
  it('2 eggs -> count, no grams (unit absent, inferred from name)', () => {
    const m = normalizeMeasurement(2, undefined, 'eggs');
    expect(m.kind).toBe('count');
    expect(m.amount).toBe(2);
    expect(m.grams).toBeUndefined();
    expect(m.milliliters).toBeUndefined();
  });

  it('3 cloves -> count', () => {
    const m = normalizeMeasurement(3, 'cloves');
    expect(m.kind).toBe('count');
    expect(m.grams).toBeUndefined();
  });

  it('4 slices -> count', () => {
    const m = normalizeMeasurement(4, 'slices');
    expect(m.kind).toBe('count');
    expect(m.grams).toBeUndefined();
  });

  it('1 can -> count, no grams', () => {
    const m = normalizeMeasurement(1, 'can');
    expect(m.kind).toBe('count');
    expect(m.grams).toBeUndefined();
  });

  it('does NOT assume egg=50g / clove=3g / can=411g', () => {
    expect(normalizeMeasurement(1, 'egg').grams).toBeUndefined();
    expect(normalizeMeasurement(1, 'clove').grams).toBeUndefined();
    expect(normalizeMeasurement(1, 'can').grams).toBeUndefined();
  });
});

describe('fractions (reuses canonical parser)', () => {
  it('1/2 cup', () => {
    const m = normalizeMeasurement('1/2', 'cup');
    expect(m.amount).toBe(0.5);
    expect(m.kind).toBe('volume');
    expect(m.milliliters).toBeCloseTo(ML_PER_CUP / 2, 10);
  });

  it('1 1/2 cups', () => {
    const m = normalizeMeasurement('1 1/2', 'cups');
    expect(m.amount).toBe(1.5);
    expect(m.milliliters).toBeCloseTo(1.5 * ML_PER_CUP, 10);
  });

  it('1-1/2 cups', () => {
    expect(normalizeMeasurement('1-1/2', 'cup').amount).toBe(1.5);
  });

  it('unicode fraction ½ cup', () => {
    const m = normalizeMeasurement('½', 'cup');
    expect(m.amount).toBe(0.5);
    expect(m.milliliters).toBeCloseTo(ML_PER_CUP / 2, 10);
  });

  it('mixed unicode 1½ cup', () => {
    expect(normalizeMeasurement('1½', 'cup').amount).toBe(1.5);
  });

  it('decimal amount and parseAmount parity with parseFraction', () => {
    expect(parseAmount('1 1/2')).toBe(1.5);
    expect(parseAmount('½')).toBe(0.5);
    expect(parseAmount(0.25)).toBe(0.25);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe('unknown / non-measured quantities', () => {
  it('"salt to taste" -> unknown, amount null', () => {
    const m = normalizeMeasurement(undefined, undefined, 'salt');
    expect(m.amount).toBeNull();
    expect(m.kind).toBe('unknown');
    expect(m.grams).toBeUndefined();
    expect(m.milliliters).toBeUndefined();
  });

  it('"as needed" -> unknown', () => {
    const m = normalizeMeasurement(null, undefined, 'pepper');
    expect(m.kind).toBe('unknown');
    expect(m.amount).toBeNull();
  });

  it('unsupported unit -> unknown (never guesses)', () => {
    const m = normalizeMeasurement(1, 'splortz');
    expect(m.kind).toBe('unknown');
    expect(m.grams).toBeUndefined();
    expect(m.milliliters).toBeUndefined();
  });

  it('recognized-but-unmeasurable (pinch) -> unknown, no conversion', () => {
    const m = normalizeMeasurement(1, 'pinch');
    expect(m.kind).toBe('unknown');
    expect(m.grams).toBeUndefined();
    expect(m.milliliters).toBeUndefined();
  });

  it('does NOT default missing amount to 1', () => {
    const m = normalizeMeasurement(undefined, 'cup', 'flour');
    expect(m.amount).toBeNull();
    expect(m.milliliters).toBeUndefined();
  });
});

describe('CRITICAL: no ingredient density introduced', () => {
  it('1 cup flour -> volume with known ml but grams undefined', () => {
    const flour = normalizeMeasurement(1, 'cup', 'flour');
    expect(flour.kind).toBe('volume');
    expect(flour.normalizedUnit).toBe('cup');
    expect(flour.grams).toBeUndefined();
    expect(flour.milliliters).toBeCloseTo(ML_PER_CUP, 10);
  });

  it('1 cup sugar -> SAME volume ml, grams undefined', () => {
    const sugar = normalizeMeasurement(1, 'cup', 'sugar');
    expect(sugar.kind).toBe('volume');
    expect(sugar.grams).toBeUndefined();
    expect(sugar.milliliters).toBeCloseTo(ML_PER_CUP, 10);
  });

  it('flour and sugar produce identical volume (proof of no density)', () => {
    const flour = normalizeMeasurement(1, 'cup', 'flour');
    const sugar = normalizeMeasurement(1, 'cup', 'sugar');
    expect(flour.milliliters).toBe(sugar.milliliters);
  });
});

describe('structured ingredient integration (read-only, non-mutating)', () => {
  it('derives a measurement without mutating the input', () => {
    const input = {
      amount: 1,
      unit: 'cup',
      name: 'Chicken Broth',
      raw: '1 cup [[Chicken Broth]]',
      original: '1 cup [[Chicken Broth]]',
    };
    const before = JSON.stringify(input);
    const m = normalizeIngredientMeasurement(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(m.kind).toBe('volume');
    expect(m.milliliters).toBeCloseTo(ML_PER_CUP, 10);
    expect(m.normalizedUnit).toBe('cup');
    // returned surface is computation-only: no raw/serialized ingestion fields
    expect('raw' in m).toBe(false);
  });

  it('leaves the raw/wikilink representation untouched', () => {
    const input = { amount: 1, unit: 'cup', name: 'Chicken Broth', raw: '1 cup [[Chicken Broth]]' };
    const m = normalizeIngredientMeasurement(input);
    expect(m).not.toHaveProperty('wikilink');
    expect(m).not.toHaveProperty('raw');
    expect(input.raw).toBe('1 cup [[Chicken Broth]]');
  });

  it('infers count from name when unit is absent', () => {
    const m = normalizeIngredientMeasurement({ amount: 2, name: 'eggs' });
    expect(m.kind).toBe('count');
    expect(m.grams).toBeUndefined();
  });
});

describe('kind classification', () => {
  it('classifies all mass/volume/count/unknown', () => {
    expect(getMeasurementKind('g')).toBe('mass');
    expect(getMeasurementKind('lb')).toBe('mass');
    expect(getMeasurementKind('cup')).toBe('volume');
    expect(getMeasurementKind('fl_oz')).toBe('volume');
    expect(getMeasurementKind('count')).toBe('count');
    expect(getMeasurementKind('unknown')).toBe('unknown');
    expect(getMeasurementKind(undefined)).toBe('unknown');
  });
});
