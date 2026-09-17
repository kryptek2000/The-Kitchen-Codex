import { describe, it, expect } from 'vitest';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import { parseRawIngredientMeasurementParts } from '../../src/utils/measurements';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import { projectQueryText } from '../../src/core/nutritionV2/matching/query';
import { MAX_INGREDIENT_TEXT_LENGTH } from '../../src/core/nutritionV2/matching/types';

/**
 * Phase 4.5D — exact leading-unit parsing, possessive normalization, and the
 * closed query-role projection.
 */

function structured(original: string) {
  const line = parseIngredientLine(original);
  const obj: Record<string, unknown> = { original: line.original, name: line.name };
  if (line.amount !== null) obj.amount = line.amount;
  if (line.unit) obj.unit = line.unit;
  return obj;
}

function queryOf(original: string): string {
  const result = parseIngredient(structured(original));
  if (!result.ok) throw new Error('parse failed');
  return result.parsed.query;
}

describe('phase 4.5d parsing — exact leading-unit consumption', () => {
  it('never leaves a stray plural suffix (`slice s`, `tablespoon s`)', () => {
    const cases: ReadonlyArray<[string, number | null, string, string]> = [
      ['8 slices bacon', 8, 'slices', 'bacon'],
      ['4 slices cheddar cheese', 4, 'slices', 'cheddar cheese'],
      ['2 tablespoons mayonnaise', 2, 'tablespoons', 'mayonnaise'],
      ['1 teaspoon kosher salt', 1, 'teaspoon', 'kosher salt'],
      ['0.5 teaspoon ground black pepper', 0.5, 'teaspoon', 'ground black pepper'],
      ['1 cup shredded lettuce', 1, 'cup', 'shredded lettuce'],
      ['1 tablespoon ketchup', 1, 'tablespoon', 'ketchup'],
      ['3 cloves garlic', 3, 'cloves', 'garlic'],
      ['1 pinch salt', 1, 'pinch', 'salt'],
    ];
    for (const [line, amount, unit, name] of cases) {
      const parsed = parseIngredientLine(line);
      expect(parsed.amount, line).toBe(amount);
      expect(parsed.unit, line).toBe(unit);
      expect(parsed.name, line).toBe(name);
      expect(parsed.name, line).not.toMatch(/\bs\b/);
    }
  });

  it('matches every supported singular/plural unit pair exactly', () => {
    const pairs: ReadonlyArray<[string, string]> = [
      ['tablespoon', 'tablespoons'],
      ['teaspoon', 'teaspoons'],
      ['cup', 'cups'],
      ['ounce', 'ounces'],
      ['pound', 'pounds'],
      ['gram', 'grams'],
      ['kilogram', 'kilograms'],
      ['milliliter', 'milliliters'],
      ['liter', 'liters'],
      ['clove', 'cloves'],
      ['pinch', 'pinches'],
      ['dash', 'dashes'],
      ['slice', 'slices'],
      ['can', 'cans'],
      ['stalk', 'stalks'],
      ['bunch', 'bunches'],
      ['sprig', 'sprigs'],
      ['piece', 'pieces'],
      ['head', 'heads'],
      ['handful', 'handfuls'],
    ];
    for (const [singular, plural] of pairs) {
      const s = parseIngredientLine(`1 ${singular} thing`);
      const p = parseIngredientLine(`2 ${plural} thing`);
      expect(s.unit, singular).toBe(singular);
      expect(s.name, singular).toBe('thing');
      expect(p.unit, plural).toBe(plural);
      expect(p.name, plural).toBe('thing');
    }
  });

  it('never consumes a unit as a prefix of a longer food word', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['1 can candy', 'candy'],
      ['1 g garlic', 'garlic'],
      ['2 l lettuce', 'lettuce'],
      ['1 c cheese', 'cheese'],
    ];
    for (const [line, expectedName] of cases) {
      const parsed = parseIngredientLine(line);
      expect(parsed.name, line).toBe(expectedName);
    }
    // No amount: the whole word is the food name.
    expect(parseIngredientLine('candy').name).toBe('candy');
    expect(parseIngredientLine('garlic').name).toBe('garlic');
    expect(parseIngredientLine('lettuce').name).toBe('lettuce');
    expect(parseIngredientLine('cheese').name).toBe('cheese');
  });

  it('consumes exact multi-token units atomically', () => {
    const flOz = parseIngredientLine('2 fl oz milk');
    expect(flOz.unit).toBe('fl oz');
    expect(flOz.name).toBe('milk');
    const fluid = parseIngredientLine('2 fluid ounces milk');
    expect(fluid.unit).toBe('fluid ounces');
    expect(fluid.name).toBe('milk');
    const punctuated = parseIngredientLine('2 fl. oz. milk');
    expect(punctuated.unit).toBe('fl. oz.');
    expect(punctuated.name).toBe('milk');
  });

  it('handles punctuation adjacent to a valid unit under an explicit rule', () => {
    const parsed = parseIngredientLine('2 cups, flour');
    expect(parsed.unit).toBe('cups');
    expect(parsed.name).toBe('flour');
    const of = parseIngredientLine('1 cup of All-Purpose Flour');
    expect(of.unit).toBe('cup');
    expect(of.name).toBe('All-Purpose Flour');
  });

  it('handles Unicode fractions and hyphenated mixed numbers', () => {
    expect(parseIngredientLine('½ cup sugar').amount).toBe(0.5);
    expect(parseIngredientLine('1½ cups sugar').amount).toBe(1.5);
    expect(parseIngredientLine('1-1/2 cups sugar').amount).toBe(1.5);
    expect(parseIngredientLine('3/4 cup sugar').amount).toBe(0.75);
  });

  it('leaves malformed amounts as an unparsed name rather than a fabricated number', () => {
    const parsed = parseIngredientLine('abc 2 cups flour');
    expect(parsed.amount).toBeNull();
    expect(parsed.name).toBe('abc 2 cups flour');
  });

  it('preserves the exact original ingredient text', () => {
    const original = '- [x] 2 tablespoons [[Mayonnaise]]';
    const parsed = parseIngredientLine(original);
    expect(parsed.original).toBe('2 tablespoons [[Mayonnaise]]');
    expect(parsed.isChecked).toBe(true);
    expect(parsed.name).toBe('[[Mayonnaise]]');
  });

  it('keeps count nouns that are foods in the name', () => {
    expect(parseIngredientLine('2 eggs').name).toBe('eggs');
    expect(parseIngredientLine('3 garlic cloves').name).toBe('garlic cloves');
  });
});

describe('phase 4.5d parsing — possessive normalization', () => {
  it('never produces a standalone `s` token from a possessive', () => {
    for (const text of ["McDonald's", "McDONALD'S", "USDA's", 'USDA\u2019s']) {
      const normalized = normalizeQuery(text);
      expect(normalized.tokens, text).not.toContain('s');
    }
    expect(normalizeQuery("McDonald's").text).toBe('mcdonalds');
    expect(normalizeQuery("USDA's").text).toBe('usdas');
    expect(normalizeQuery('USDA\u2019s').text).toBe('usdas');
  });

  it('preserves plural food words and literal single letters', () => {
    expect(normalizeQuery('tomatoes').text).toBe('tomatoes');
    expect(normalizeQuery('pickles').text).toBe('pickles');
    expect(normalizeQuery('vitamin c').tokens).toContain('c');
    expect(normalizeQuery('a s').tokens).toContain('s');
  });
});

describe('phase 4.5d parsing — raw/structured/imported parity', () => {
  it('produces the same query for raw and structured ingredients', () => {
    const lines = [
      '8 slices bacon',
      '2 tablespoons mayonnaise',
      '0.5 teaspoon ground black pepper',
      '2 medium tomatoes, sliced',
    ];
    for (const line of lines) {
      const raw = parseIngredient(line);
      const structuredResult = parseIngredient(structured(line));
      expect(raw.ok && structuredResult.ok, line).toBe(true);
      if (raw.ok && structuredResult.ok) {
        expect(structuredResult.parsed.query, line).toBe(raw.parsed.query);
        expect(structuredResult.parsed.measurement_kind, line).toBe(raw.parsed.measurement_kind);
      }
    }
  });

  it('does not mutate structured input and preserves wikilinks', () => {
    const source = {
      original: '1 cup [[Flour|all-purpose flour]]',
      amount: 1,
      unit: 'cup',
      name: '[[Flour|all-purpose flour]]',
    };
    const before = JSON.stringify(source);
    const result = parseIngredient(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.query).toBe('[[Flour|all-purpose flour]]');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('rejects oversized lines instead of truncating to a different ingredient', () => {
    const oversized = `1 cup ${'x'.repeat(MAX_INGREDIENT_TEXT_LENGTH)}`;
    const result = parseIngredient(oversized);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; failure: { code: string } }).failure.code).toBe('oversized_input');
  });
});

describe('phase 4.5d query projection — closed roles', () => {
  it('separates measurement, size, preparation, note, numeric, identity', () => {
    const projection = projectQueryText('ground beef 80 20 formed into 4 patties');
    expect(projection.food_identity).toBe('ground beef');
    expect(projection.food_tokens).toEqual(['ground', 'beef']);
    expect(projection.numeric_qualifiers).toEqual(['80', '20']);
    expect(projection.notes.join(' ')).toContain('formed into 4 patties');
    expect(projection.anchor_groups[0].accepted).toEqual(['beef']);
  });

  it('treats size words as portion qualifiers, not identity', () => {
    const projection = projectQueryText('medium tomatoes sliced');
    expect(projection.food_identity).toBe('tomatoes');
    expect(projection.size_qualifiers).toEqual(['medium']);
    expect(projection.preparation_qualifiers).toEqual(['sliced']);
    expect(projection.anchor_groups[0].accepted).toEqual(['tomatoes']);
  });

  it('removes only the closed preparation set from identity', () => {
    const projection = projectQueryText('shredded lettuce');
    expect(projection.food_identity).toBe('lettuce');
    expect(projection.preparation_qualifiers).toEqual(['shredded']);
    // Nutritionally significant qualifiers stay in identity.
    expect(projectQueryText('raw ground beef').food_tokens).toContain('raw');
    expect(projectQueryText('unsalted butter').food_tokens).toContain('unsalted');
    expect(projectQueryText('whole milk').food_tokens).toContain('whole');
  });

  it('keeps `ground` identity-bearing for meat and preparation-only otherwise', () => {
    expect(projectQueryText('ground beef').food_identity).toBe('ground beef');
    expect(projectQueryText('ground black pepper').food_identity).toBe('black pepper');
    expect(projectQueryText('ground black pepper').anchor_groups[0].accepted).toEqual(['pepper']);
  });

  it('applies the bounded burger-bun alias directionally with a bun/roll anchor', () => {
    const projection = projectQueryText('burger buns');
    expect(projection.aliases).toContain('burger_bun_to_hamburger_bun');
    expect(projection.food_tokens).toContain('hamburger');
    expect(projection.food_tokens).toContain('bun');
    expect([...projection.anchor_groups[0].accepted].sort()).toEqual(['bun', 'roll']);
  });

  it('derives the head-noun anchor deterministically', () => {
    expect(projectQueryText('black pepper').anchor_groups[0].accepted).toEqual(['pepper']);
    expect(projectQueryText('kosher salt').anchor_groups[0].accepted).toEqual(['salt']);
    expect(projectQueryText('cheddar cheese').anchor_groups[0].accepted).toEqual(['cheese']);
    expect(projectQueryText('mayonnaise').anchor_groups[0].accepted).toEqual(['mayonnaise']);
    expect(projectQueryText('bacon').anchor_groups[0].accepted).toEqual(['bacon']);
  });

  it('is pure, deterministic, and does not mutate its input', () => {
    const text = 'medium tomatoes, sliced';
    const a = projectQueryText(text);
    const b = projectQueryText(text);
    expect(a).toEqual(b);
    expect(text).toBe('medium tomatoes, sliced');
  });
});

describe('phase 4.5d parsing — shared segmenter contract preserved', () => {
  it('keeps the deterministic-engine default (mass/volume only)', () => {
    expect(parseRawIngredientMeasurementParts('3 garlic cloves')).toEqual({
      amount: 3,
      unit: null,
      name: 'garlic cloves',
    });
    expect(parseRawIngredientMeasurementParts('2 eggs')).toEqual({ amount: 2, unit: null, name: 'eggs' });
    expect(parseRawIngredientMeasurementParts('1 can beans')).toEqual({
      amount: 1,
      unit: null,
      name: 'can beans',
    });
  });

  it('consumes count measures only when explicitly requested', () => {
    expect(parseRawIngredientMeasurementParts('1 can beans', { includeCount: true })).toEqual({
      amount: 1,
      unit: 'can',
      name: 'beans',
    });
    expect(parseRawIngredientMeasurementParts('3 cloves garlic', { includeCount: true })).toEqual({
      amount: 3,
      unit: 'cloves',
      name: 'garlic',
    });
  });
});
