/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5C: canonical portion semantics.
 *
 * Pure tests for the three canonical USDA portion shapes: Foundation (numeric
 * amount + measure), SR Legacy (`undetermined` + leading unit in `modifier`),
 * and FNDDS (explicit amount embedded in `measure`). No density, no defaulted
 * amount, no numeric FNDDS code shown as a descriptor.
 */

import { describe, it, expect } from 'vitest';
import {
  PORTION_SEMANTICS_VERSION,
  normalizePortionSemantics,
  portionCompatibility,
  candidatePortionCompatibility,
  resolvePortionMassFromSemantics,
} from '../../src/core/nutritionV2/calculation/portionSemantics';

const MAX = 1_000_000_000;

describe('phase 4.5C portion semantics — version and shape recognition', () => {
  it('stamps the explicit semantics version', () => {
    const normalized = normalizePortionSemantics({ amount: 1, measure: 'cup', gram_weight: 122 }, 0);
    expect(normalized.semantics_version).toBe(PORTION_SEMANTICS_VERSION);
    expect(PORTION_SEMANTICS_VERSION).toBe('usda_portion_semantics_v1');
  });

  it('Foundation: numeric amount + real measure unit', () => {
    const cup = normalizePortionSemantics({ amount: 1, measure: 'cup', gram_weight: 125 }, 0);
    expect(cup.kind).toBe('volume');
    expect(cup.amount).toBe(1);
    expect(cup.unit).toBe('cup');
    expect(cup.volume_ml).toBeCloseTo(236.5882365, 9);
    expect(cup.amount_source).toBe('raw_amount');
    expect(cup.display_label).toBe('1 cup = 125 g');

    const tbsp = normalizePortionSemantics({ amount: 2, measure: 'tablespoon', gram_weight: 14.2 }, 0);
    expect(tbsp.kind).toBe('volume');
    expect(tbsp.amount).toBe(2);

    const oz = normalizePortionSemantics({ amount: 1, measure: 'oz', gram_weight: 28.4 }, 0);
    expect(oz.kind).toBe('mass');
    expect(oz.mass_grams).toBeCloseTo(28.349523125, 9);

    const piece = normalizePortionSemantics({ amount: 1, measure: 'piece', gram_weight: 48 }, 0);
    expect(piece.kind).toBe('count');

    const racc = normalizePortionSemantics({ amount: 1, measure: 'RACC', gram_weight: 100 }, 0);
    expect(racc.kind).toBe('unusable');
  });

  it('SR Legacy: `undetermined` measure with the real unit in the modifier', () => {
    const cup = normalizePortionSemantics(
      { amount: 1, measure: 'undetermined', modifier: 'cup', gram_weight: 122 },
      0
    );
    expect(cup.kind).toBe('volume');
    expect(cup.unit).toBe('cup');
    expect(cup.amount).toBe(1);
    expect(cup.volume_ml).toBeCloseTo(236.5882365, 9);
    expect(cup.amount_source).toBe('modifier_text');
    // The user-facing label must never show the placeholder `undetermined`.
    expect(cup.display_label).toBe('1 cup = 122 g');
    expect(cup.display_label).not.toMatch(/undetermined/i);

    const chopped = normalizePortionSemantics(
      { amount: 1, measure: 'undetermined', modifier: 'cup, chopped', gram_weight: 130 },
      0
    );
    expect(chopped.kind).toBe('volume');
    expect(chopped.unit).toBe('cup');
    expect(chopped.descriptor).toBe('chopped');

    const flOz = normalizePortionSemantics(
      { amount: 1, measure: 'undetermined', modifier: 'fl oz', gram_weight: 30 },
      0
    );
    expect(flOz.kind).toBe('volume');
    expect(flOz.unit).toBe('fl_oz');

    const oz = normalizePortionSemantics(
      { amount: 1, measure: 'undetermined', modifier: 'oz', gram_weight: 28 },
      0
    );
    expect(oz.kind).toBe('mass');

    // A leading token that is NOT a unit (food form / size) is unusable.
    for (const modifier of ['large', 'steak', 'roast', 'serving', 'fruit', 'fl']) {
      expect(normalizePortionSemantics({ amount: 1, measure: 'undetermined', modifier, gram_weight: 50 }, 0).kind).toBe(
        'unusable'
      );
    }
  });

  it('FNDDS: explicit amount embedded in the measure text', () => {
    const cup = normalizePortionSemantics({ measure: '1 cup', modifier: '10205', gram_weight: 240 }, 0);
    expect(cup.kind).toBe('volume');
    expect(cup.amount).toBe(1);
    expect(cup.unit).toBe('cup');
    expect(cup.amount_source).toBe('measure_text');
    // The numeric source code must never appear as a descriptor/label.
    expect(cup.descriptor).toBeNull();
    expect(cup.display_label).toBe('1 cup = 240 g');
    expect(cup.display_label).not.toMatch(/10205/);

    const flOz = normalizePortionSemantics({ measure: '1 fl oz', modifier: '30000', gram_weight: 30.5 }, 0);
    expect(flOz.kind).toBe('volume');
    expect(flOz.unit).toBe('fl_oz');

    const tbsp = normalizePortionSemantics({ measure: '1 tablespoon', modifier: '21000', gram_weight: 15 }, 0);
    expect(tbsp.kind).toBe('volume');

    // Unusable FNDDS measures (no explicit positive leading amount / not a unit).
    for (const measure of [
      'Quantity not specified',
      'Guideline amount per cup of hot cereal',
      'Guideline amount on regular sandwich',
      'Juice of 1 lemon (2-1/8" dia)',
      'Skin from 1 small',
      'Topping from 1 piece',
      'cup',
      '1 large',
      '1 4 oz container',
      '1 individual school container',
      '',
    ]) {
      expect(normalizePortionSemantics({ measure, modifier: '90000', gram_weight: 100 }, 0).kind, measure).toBe(
        'unusable'
      );
    }
  });

  it('never defaults a missing amount to one and fails closed on malformed input', () => {
    expect(normalizePortionSemantics({ measure: 'cup', gram_weight: 125 }, 0).kind).toBe('unusable');
    expect(normalizePortionSemantics({ amount: 0, measure: 'cup', gram_weight: 125 }, 0).kind).toBe('unusable');
    expect(normalizePortionSemantics({ amount: -1, measure: 'cup', gram_weight: 125 }, 0).kind).toBe('unusable');
    expect(normalizePortionSemantics({ amount: Number.NaN, measure: 'cup', gram_weight: 125 }, 0).kind).toBe('unusable');
    expect(normalizePortionSemantics({ amount: 1, measure: 'cup', gram_weight: 0 }, 0).kind).toBe('unusable');
    expect(normalizePortionSemantics(null, 0).kind).toBe('unusable');
    expect(normalizePortionSemantics('nope', 0).kind).toBe('unusable');
  });
});

describe('phase 4.5C portion semantics — compatibility and exact scaling', () => {
  const cup = normalizePortionSemantics(
    { amount: 1, measure: 'undetermined', modifier: 'cup', gram_weight: 122 },
    0
  );

  it('computes dimension compatibility without trusting labels', () => {
    expect(portionCompatibility(cup, 'volume')).toBe('compatible');
    expect(portionCompatibility(cup, 'mass')).toBe('incompatible');
    expect(portionCompatibility(cup, 'count')).toBe('incompatible');
    expect(portionCompatibility(cup, 'unknown')).toBe('incompatible');
    const unusable = normalizePortionSemantics({ measure: 'Quantity not specified', gram_weight: 100 }, 0);
    expect(portionCompatibility(unusable, 'volume')).toBe('unusable');
  });

  it('scales a compatible volume by exact canonical volume (never numeric-only division)', () => {
    // 2 tbsp = 29.5735295625 ml; 1 cup = 236.5882365 ml -> 0.125 cups -> 15.25 g
    const grams = resolvePortionMassFromSemantics(
      cup,
      { kind: 'volume', grams: undefined, milliliters: 2 * 14.78676478125 },
      MAX
    );
    expect(grams).toBeCloseTo(15.25, 9);

    // One cup exactly.
    expect(
      resolvePortionMassFromSemantics(cup, { kind: 'volume', grams: undefined, milliliters: 236.5882365 }, MAX)
    ).toBeCloseTo(122, 9);
  });

  it('rejects incompatible dimensions and unusable portions', () => {
    expect(
      resolvePortionMassFromSemantics(cup, { kind: 'count', grams: undefined, milliliters: undefined }, MAX)
    ).toBeUndefined();
    expect(
      resolvePortionMassFromSemantics(cup, { kind: 'volume', grams: undefined, milliliters: 0 }, MAX)
    ).toBe(0);
    const unusable = normalizePortionSemantics({ measure: 'Quantity not specified', gram_weight: 100 }, 0);
    expect(
      resolvePortionMassFromSemantics(unusable, { kind: 'volume', grams: undefined, milliliters: 100 }, MAX)
    ).toBeUndefined();
  });

  it('candidate compatibility mirrors the normalized compatibility', () => {
    expect(
      candidatePortionCompatibility({ kind: 'volume', effective_amount: 1, gram_weight: 122 }, 'volume')
    ).toBe('compatible');
    expect(
      candidatePortionCompatibility({ kind: 'unusable', effective_amount: null, gram_weight: 122 }, 'volume')
    ).toBe('unusable');
    expect(
      candidatePortionCompatibility({ kind: 'count', effective_amount: 1, gram_weight: 50 }, 'volume')
    ).toBe('incompatible');
  });
});
