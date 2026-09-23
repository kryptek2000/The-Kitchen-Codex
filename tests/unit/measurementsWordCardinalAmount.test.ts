import { describe, it, expect } from 'vitest';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';

/**
 * Focused regression: spelled-out CARDINAL amounts `one` … `twelve` are parsed
 * when (and only when) they precede an existing supported measurement or
 * count/container unit, feeding the current amount parsing — no new units, no
 * conversions, no defaults.
 *
 * Explicit non-goals proved here: bare `a`, `half`, `quarter`, ordinal words,
 * compound word numbers, and word numbers not followed by a supported unit
 * remain untouched.
 */

type Parsed = {
  amount: number | null;
  query: string;
  unit_kind?: string;
  count_noun?: string;
  measurement_kind: string;
  grams: number | null;
  milliliters: number | null;
};

function parsed(line: string): Parsed {
  const result = parseIngredient(line);
  if (!result.ok) throw new Error(`expected parse to succeed for: ${line}`);
  return result.parsed as unknown as Parsed;
}

function measurementShape(p: Parsed) {
  return {
    amount: p.amount,
    query: p.query,
    unit_kind: p.unit_kind,
    count_noun: p.count_noun,
    measurement_kind: p.measurement_kind,
    grams: p.grams,
    milliliters: p.milliliters,
  };
}

describe('spelled-out cardinal amounts one..twelve', () => {
  it('parses `one cup flour` as amount 1 with existing unit/query behavior', () => {
    const p = parsed('one cup flour');
    expect(p.amount).toBe(1);
    expect(p.query).toBe('flour');
    expect(p.unit_kind).toBe('volume');
    expect(p.measurement_kind).toBe('volume');
  });

  it('parses `two cloves garlic` as amount 2 with existing count behavior', () => {
    const p = parsed('two cloves garlic');
    expect(p.amount).toBe(2);
    expect(p.query).toBe('garlic');
    expect(p.count_noun).toBe('clove');
    expect(p.measurement_kind).toBe('count');
  });

  it('is measurement-identical to the numeric form (no other behavior change)', () => {
    expect(measurementShape(parsed('one cup flour'))).toEqual(
      measurementShape(parsed('1 cup flour')),
    );
    expect(measurementShape(parsed('two cloves garlic'))).toEqual(
      measurementShape(parsed('2 cloves garlic')),
    );
    expect(measurementShape(parsed('three tbsp olive oil'))).toEqual(
      measurementShape(parsed('3 tbsp olive oil')),
    );
  });

  it.each([
    ['a pinch of salt'],
    ['half cup milk'],
    ['quarter teaspoon salt'],
    ['twenty one cups water'],
    ['first cup flour'],
    ['one pot chicken'],
  ])('leaves non-goal input untouched: %s', (line) => {
    const p = parsed(line);
    expect(p.amount).toBeNull();
  });
});
