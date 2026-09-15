import { describe, it, expect } from 'vitest';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { ParsedIngredientReview } from '../../src/core/nutritionV2/matching/types';

/**
 * Phase 2 — defensive ingredient parsing. Mutation-sensitive: each rule is
 * asserted with a violating input.
 */

function parsed(raw: unknown): ParsedIngredientReview {
  const result = parseIngredient(raw);
  if (!result.ok) {
    throw new Error(`expected parse ok, got ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  }
  return result.parsed;
}

function failureCode(raw: unknown): string | undefined {
  const result = parseIngredient(raw);
  return result.ok ? undefined : (result as { ok: false; failure: { code: string } }).failure.code;
}

describe('phase 2 parse — structured and raw ingredients', () => {
  it('parses a structured ingredient without mutation', () => {
    const source = {
      original: '1 cup all-purpose flour',
      amount: 1,
      unit: 'cup',
      name: 'all-purpose flour',
      note: 'sifted',
    };
    const before = JSON.stringify(source);
    const result = parsed(source);
    expect(result.query).toBe('all-purpose flour');
    expect(result.amount).toBe(1);
    expect(result.raw_unit).toBe('cup');
    expect(result.normalized_unit).toBe('cup');
    expect(result.measurement_kind).toBe('volume');
    expect(result.milliliters).toBeCloseTo(236.5882365, 6);
    expect(result.grams).toBeUndefined();
    expect(result.count).toBe(false);
    expect(result.note).toBe('sifted');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('parses a raw ingredient line', () => {
    const result = parsed('2 tbsp olive oil');
    expect(result.query).toBe('olive oil');
    expect(result.amount).toBe(2);
    expect(result.normalized_unit).toBe('tbsp');
    expect(result.measurement_kind).toBe('volume');
    expect(result.grams).toBeUndefined();
  });

  it('parses fractions and Unicode fractions through the existing parser', () => {
    expect(parsed('1/2 cup sugar').amount).toBe(0.5);
    expect(parsed('½ cup sugar').amount).toBe(0.5);
    expect(parsed({ amount: '3/4', unit: 'cup', name: 'sugar' }).amount).toBe(0.75);
    expect(parsed({ amount: '½', unit: 'cup', name: 'sugar' }).amount).toBe(0.5);
  });

  it('derives deterministic grams for direct mass only', () => {
    const grams = parsed('250 g butter');
    expect(grams.measurement_kind).toBe('mass');
    expect(grams.grams).toBe(250);
    expect(grams.milliliters).toBeUndefined();

    const ounces = parsed('4 oz butter');
    expect(ounces.measurement_kind).toBe('mass');
    expect(ounces.grams).toBeCloseTo(113.3980925, 6);
  });

  it('derives deterministic milliliters for volume only', () => {
    const result = parsed('2 cups milk');
    expect(result.measurement_kind).toBe('volume');
    expect(result.milliliters).toBeCloseTo(473.176473, 6);
    expect(result.grams).toBeUndefined();
  });

  it('classifies count without any gram weight', () => {
    const result = parsed('3 garlic cloves');
    expect(result.measurement_kind).toBe('count');
    expect(result.count).toBe(true);
    expect(result.grams).toBeUndefined();
    expect(result.milliliters).toBeUndefined();
  });

  it('keeps unknown / pinch / dash / to-taste unmeasurable', () => {
    for (const line of ['a pinch of salt', '1 dash cinnamon', 'salt to taste', '1 bunch parsley']) {
      const result = parsed(line);
      expect(result.measurement_kind, line).toBe('unknown');
      expect(result.grams, line).toBeUndefined();
      expect(result.milliliters, line).toBeUndefined();
    }
  });

  it('never defaults a missing amount to 1', () => {
    const result = parsed({ name: 'flour', unit: 'cup' });
    expect(result.amount).toBeNull();
    expect(result.grams).toBeUndefined();
    expect(result.milliliters).toBeUndefined();
  });

  it('preserves an explicit zero amount as zero (not null, not 1)', () => {
    const result = parsed({ amount: 0, unit: 'g', name: 'salt' });
    expect(result.amount).toBe(0);
    expect(result.grams).toBe(0);
  });

  it('never converts volume or count to mass', () => {
    for (const line of ['1 cup flour', '3 eggs', '1 can beans', '2 tbsp oil']) {
      const result = parsed(line);
      expect(result.grams, line).toBeUndefined();
    }
  });

  it('preserves wikilink text in the query and does not mutate the source', () => {
    const source = {
      original: '1 cup [[Flour|all-purpose flour]]',
      amount: 1,
      unit: 'cup',
      name: '[[Flour|all-purpose flour]]',
      wikilink: '[[Flour|all-purpose flour]]',
      wikilinkTarget: 'Flour',
      wikilinkAlias: 'all-purpose flour',
    };
    const before = JSON.stringify(source);
    const result = parsed(source);
    expect(result.query).toBe('[[Flour|all-purpose flour]]');
    expect(result.grams).toBeUndefined();
    expect(JSON.stringify(source)).toBe(before);
  });

  it('uses an explicit line reference or index when supplied', () => {
    expect(parsed({ name: 'flour', line_ref: 'ing-7' }).line_ref).toBe('ing-7');
    expect(parsed({ name: 'flour', index: 3 }).line_ref).toBe('line:3');
    expect(parsed({ name: 'flour' }).line_ref).toBe('flour');
  });
});

describe('phase 2 parse — bounds and hostile input', () => {
  it('rejects oversized input instead of silently truncating', () => {
    expect(failureCode('x'.repeat(400))).toBe('oversized_input');
    expect(failureCode({ name: 'x'.repeat(400) })).toBe('oversized_input');
    expect(failureCode({ original: 'y'.repeat(400) })).toBe('oversized_input');
    expect(failureCode({ name: 'flour', note: 'z'.repeat(400) })).toBe('oversized_input');
  });

  it('rejects empty input', () => {
    expect(failureCode('')).toBe('empty_query');
    expect(failureCode('   ')).toBe('empty_query');
    expect(failureCode({ name: '' })).toBe('empty_query');
  });

  it('rejects unknown structured fields', () => {
    expect(failureCode({ name: 'flour', evil: true })).toBe('unknown_field');
  });

  it('rejects invalid amounts', () => {
    expect(failureCode({ name: 'flour', amount: Number.NaN })).toBe('invalid_amount');
    expect(failureCode({ name: 'flour', amount: Number.POSITIVE_INFINITY })).toBe('invalid_amount');
    expect(failureCode({ name: 'flour', amount: 'not-a-number' })).toBe('invalid_amount');
    expect(failureCode({ name: 'flour', amount: {} })).toBe('invalid_amount');
  });

  it('rejects accessors, proxies, dangerous keys, symbol keys, cycles, and non-plain objects', () => {
    const accessor: Record<string, unknown> = { original: '1 cup flour' };
    Object.defineProperty(accessor, 'name', { enumerable: true, get: () => 'flour' });
    expect(failureCode(accessor)).toBe('unsafe_input');

    const hostileProxy = new Proxy({}, {
      ownKeys() {
        throw new Error('nope');
      },
    });
    expect(failureCode(hostileProxy)).toBe('unsafe_input');

    expect(failureCode(JSON.parse('{"name":"flour","__proto__":{"x":1}}'))).toBe('unsafe_input');

    const symbolKey = { name: 'flour', [Symbol('k')]: 1 };
    expect(failureCode(symbolKey)).toBe('unsafe_input');

    const cyclic: Record<string, unknown> = { name: 'flour' };
    cyclic.self = cyclic;
    expect(failureCode(cyclic)).toBe('unsafe_input');

    expect(failureCode(new Date())).toBe('invalid_input');
    expect(failureCode([1, , 3])).toBe('invalid_input');
  });

  it('produces fixed, bounded, input-redacted diagnostics', () => {
    const secret = 'SUPER-SECRET-INGREDIENT';
    const result = parseIngredient({ name: secret, evil: 1 });
    expect(result.ok).toBe(false);
    const failure = (result as { ok: false; failure: { code: string; message: string } }).failure;
    expect(failure.code).toBe('unknown_field');
    expect(failure.message).toBe('phase2_unknown_field');
    expect(JSON.stringify(failure)).not.toContain(secret);
  });
});
