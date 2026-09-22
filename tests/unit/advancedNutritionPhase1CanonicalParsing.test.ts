/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: canonical ingredient parsing
 * (deterministic, offline, no USDA bundle).
 *
 * Proves the ONE canonical parse representation: exact/range quantities,
 * canonical unit classification (mass / volume / count / container / unknown),
 * count-noun extraction (leading and after the food), container classification,
 * package net-mass representation, and preservation of state/size/variety/
 * preparation words.
 *
 * Safety invariants proved here:
 *   - a range never yields a single amount (no endpoint authority, no grams);
 *   - a container never implies a gram weight;
 *   - a package net mass is extracted, never converted or multiplied;
 *   - no input is ever mutated; repeated runs are content-identical;
 *   - malformed ranges, dates, hyphenated foods, and no-amount phrases are never
 *     split by substring matching.
 */

import { describe, it, expect } from 'vitest';

import {
  CANONICAL_INGREDIENT_PARSE_VERSION,
  MAX_CANONICAL_RANGE_QUANTITY,
  getMeasurementKind,
  normalizeUnit,
  parseCanonicalIngredientParts,
  parseRawIngredientMeasurementParts,
} from '../../src/utils/measurements';
import {
  canonicalHouseholdUnit,
  householdCollisionHeads,
  householdCollisionUnitNouns,
  householdContainerNouns,
  householdCountNouns,
  householdUnitAliases,
  householdUnitFoodCollision,
  isIdentityBearingCountNoun,
  isStrippableCountNoun,
} from '../../src/utils/householdUnits';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { canonicalCountUnit } from '../../src/core/nutritionV2/calculation/countPortion';
import { PHASE1_PARSING_CASES } from '../fixtures/advancedNutritionPhase1ParsingCorpus';

function canonical(line: string) {
  return parseCanonicalIngredientParts(line, { includeCount: true });
}

function review(line: string) {
  const parsed = parseIngredient(line);
  if (!parsed.ok) {
    throw new Error(`parse failed: ${(parsed as { failure: { code: string } }).failure.code}`);
  }
  return parsed.parsed;
}

describe('phase 1 canonical parsing — corpus', () => {
  for (const entry of PHASE1_PARSING_CASES) {
    it(`parses ${JSON.stringify(entry.line)} exactly`, () => {
      const c = canonical(entry.line);
      expect(c.version).toBe(CANONICAL_INGREDIENT_PARSE_VERSION);
      expect(c.originalText).toBe(entry.line);
      expect(c.quantity.kind).toBe(entry.quantityKind);
      if (entry.quantityKind === 'exact') {
        expect(c.quantity.amount).toBe(entry.amount);
        expect(c.quantity.lower).toBeNull();
        expect(c.quantity.upper).toBeNull();
      } else {
        expect(c.quantity.amount).toBeNull();
        if (entry.quantityKind === 'range') {
          expect(c.quantity.lower).toBe(entry.lower);
          expect(c.quantity.upper).toBe(entry.upper);
        }
      }
      expect(c.unit).toBe(entry.unit);
      expect(c.unitKind).toBe(entry.unitKind);
      expect(c.countNoun).toBe(entry.countNoun ?? null);
      expect(c.container).toBe(entry.container ?? null);
      expect(c.packageNetMass).toEqual(entry.packageMass ?? null);
      expect(c.foodText).toBe(entry.foodText);

      // The review layer must expose the SAME canonical classification.
      const p = review(entry.line);
      expect(p.parse_version).toBe(CANONICAL_INGREDIENT_PARSE_VERSION);
      expect(p.quantity_kind).toBe(entry.quantityKind);
      expect(p.amount).toBe(entry.quantityKind === 'exact' ? entry.amount : null);
      if (entry.quantityKind === 'range') {
        expect(p.quantity_range).toEqual({ lower: entry.lower, upper: entry.upper });
      } else {
        expect(p.quantity_range).toBeUndefined();
      }
      expect(p.unit_kind).toBe(entry.unitKind);
      expect(p.count_noun).toBe(entry.countNoun ?? undefined);
      expect(p.container).toBe(entry.container ?? undefined);
      expect(p.package_net_mass).toEqual(entry.packageMass ?? undefined);
      expect(p.query).toBe(entry.foodText);
    });
  }

  it('never produces grams for a non-mass unit or an unresolved amount', () => {
    for (const entry of PHASE1_PARSING_CASES) {
      const p = review(entry.line);
      if (entry.unitKind === 'mass' && entry.quantityKind === 'exact') {
        expect(p.grams, entry.line).toBeDefined();
      } else {
        expect(p.grams, entry.line).toBeUndefined();
      }
    }
  });
});

describe('phase 1 canonical parsing — quantity ranges', () => {
  it('accepts ordinary culinary range separators', () => {
    const cases: ReadonlyArray<readonly [string, number, number]> = [
      ['1-2 tbsp olive oil', 1, 2],
      ['1–2 tbsp olive oil', 1, 2],
      ['1—2 tbsp olive oil', 1, 2],
      ['1 to 2 tbsp olive oil', 1, 2],
      ['1/4-1/2 tsp chili flakes', 0.25, 0.5],
      ['1 1/2-2 cups broth', 1.5, 2],
      ['2 to 3 cloves garlic', 2, 3],
      ['1.5-2.5 cups stock', 1.5, 2.5],
      ['1½-2 cups stock', 1.5, 2],
      ['½-¾ cup sugar', 0.5, 0.75],
    ];
    for (const [line, lower, upper] of cases) {
      const c = canonical(line);
      expect(c.quantity.kind, line).toBe('range');
      expect(c.quantity.lower, line).toBe(lower);
      expect(c.quantity.upper, line).toBe(upper);
      expect(c.quantity.amount, line).toBeNull();
    }
  });

  it('never collapses a range to one endpoint (no grams from a range)', () => {
    const p = review('2 to 3 cloves garlic');
    expect(p.amount).toBeNull();
    expect(p.quantity_range).toEqual({ lower: 2, upper: 3 });
    expect(p.grams).toBeUndefined();
    expect(p.milliliters).toBeUndefined();
    // The quantity does not become a count requirement amount either.
    expect(p.count_noun).toBe('clove');
  });

  it('removes the complete range from the food phrase with no fragments', () => {
    const lines: ReadonlyArray<readonly [string, string]> = [
      ['1-2 tbsp olive oil', 'olive oil'],
      ['1–2 tbsp olive oil', 'olive oil'],
      ['1 1/2-2 cups broth', 'broth'],
      ['2 to 3 cloves garlic', 'garlic'],
      ['1/4-1/2 tsp chili flakes (optional)', 'chili flakes (optional)'],
    ];
    for (const [line, food] of lines) {
      const c = canonical(line);
      expect(c.foodText, line).toBe(food);
      expect(c.foodText, line).not.toMatch(/^-/);
      expect(c.foodText, line).not.toMatch(/\d\s*(tsp|tbsp|cup|cups)\b/i);
      expect(c.foodText, line).not.toMatch(/\b(to|-)\s*\d/);
    }
  });

  it('rejects malformed ranges and never picks an endpoint', () => {
    const invalid: ReadonlyArray<string> = [
      '1-2-3 chained cups flour',
      '1-2-3 tbsp oil',
      '0-1 tsp salt',
      '2-1 tbsp oil',
      '1000001-1000002 cups water',
      '1 cup-2 tbsp broth',
      '1 tbsp - 2 tsp salt',
      '1- tbsp oil',
      '1 to cups oil',
    ];
    for (const line of invalid) {
      const c = canonical(line);
      expect(c.quantity.kind, line).toBe('invalid');
      expect(c.quantity.amount, line).toBeNull();
      expect(c.quantity.lower, line).toBeNull();
      expect(c.quantity.upper, line).toBeNull();
      expect(c.foodText, line).toBe(line);
      const p = review(line);
      expect(p.amount, line).toBeNull();
      expect(p.grams, line).toBeUndefined();
    }
  });

  it('keeps the pre-existing mixed-fraction contract (2-1/2 is 2 1/2)', () => {
    for (const line of ['2-1/2 cups flour', '1-1/2 tsp salt', '1 1/2 cups milk']) {
      const c = canonical(line);
      expect(c.quantity.kind, line).toBe('exact');
      expect(c.quantity.amount, line).toBe(line.startsWith('2') ? 2.5 : 1.5);
    }
  });

  it('never interprets dates, hyphenated foods, model numbers, or negative signs as ranges', () => {
    const dates = canonical('2024-01-02 grocery run');
    expect(dates.quantity.kind).toBe('absent');
    expect(dates.foodText).toBe('2024-01-02 grocery run');

    const model = canonical('2-3mm bolt');
    expect(model.quantity.kind).toBe('invalid');
    expect(model.foodText).toBe('2-3mm bolt');

    for (const line of ['gluten-free flour', 'chicken-fried steak', 'breadstick', 'a -2 cups nonsense']) {
      const c = canonical(line);
      expect(c.quantity.kind, line).toBe('absent');
      expect(c.foodText, line).toBe(line);
    }

    // A leading negative quantity is never a range: it stays unresolved.
    const negative = canonical('-2 to -1 tbsp oil');
    expect(negative.quantity.kind).toBe('absent');
    expect(negative.quantity.amount).toBeNull();
    expect(negative.foodText).toBe('-2 to -1 tbsp oil');

    // A hyphenated word directly after an exact quantity is untouched.
    const fried = canonical('2 chicken-fried steaks');
    expect(fried.quantity.kind).toBe('exact');
    expect(fried.quantity.amount).toBe(2);
    expect(fried.foodText).toBe('chicken-fried steaks');
  });

  it('bounds range endpoints without touching exact quantities', () => {
    expect(MAX_CANONICAL_RANGE_QUANTITY).toBe(1_000_000);
    const huge = canonical('999999-1000000 cups water');
    expect(huge.quantity.kind).toBe('range');
    const over = canonical('1000000-1000001 cups water');
    expect(over.quantity.kind).toBe('invalid');
  });

  it('is linear and bounded on repeated long inputs', () => {
    const long = `1-2 tbsp ${'x'.repeat(250)}`;
    const started = Date.now();
    for (let i = 0; i < 500; i += 1) {
      const c = canonical(long);
      expect(c.quantity.kind).toBe('range');
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('phase 1 canonical parsing — count nouns after the food', () => {
  it('extracts a trailing measure noun and preserves the food head', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['2 garlic cloves', 'clove', 'garlic'],
      ['2 garlic cloves, minced', 'clove', 'garlic, minced'],
      ['2 celery stalks', 'stalk', 'celery'],
      ['4 bacon slices', 'slice', 'bacon'],
      ['2 thyme sprigs', 'sprig', 'thyme'],
      ['2 scoops protein powder', 'scoop', 'protein powder'],
    ];
    for (const [line, noun, food] of cases) {
      const c = canonical(line);
      expect(c.countNoun, line).toBe(noun);
      expect(c.unit, line).toBe(noun);
      expect(c.unitKind, line).toBe('count');
      expect(c.foodText, line).toBe(food);
      const p = review(line);
      expect(p.count_noun, line).toBe(noun);
      expect(p.unit_kind, line).toBe('count');
      expect(p.query, line).toBe(food);
      expect(p.grams, line).toBeUndefined();
    }
  });

  it('records identity-bearing nouns as metadata but never erases a food head', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['3 chicken breasts', 'breast', 'chicken breasts'],
      ['4 spare ribs', 'rib', 'spare ribs'],
      ['2 bay leaves', 'leaf', 'bay leaves'],
      ['2 salmon fillets', 'fillet', 'salmon fillets'],
      ['2 fish sticks', 'stick', 'fish sticks'],
      ['2 sausage links', 'link', 'sausage links'],
      ['2 lemon strips', 'strip', 'lemon strips'],
    ];
    for (const [line, noun, food] of cases) {
      const c = canonical(line);
      expect(c.countNoun, line).toBe(noun);
      expect(c.foodText, line).toBe(food);
      expect(review(line).query, line).toBe(food);
      expect(isIdentityBearingCountNoun(noun), line).toBe(true);
      expect(isStrippableCountNoun(noun), line).toBe(false);
    }
  });

  it('never consumes a count noun without an explicit quantity', () => {
    for (const line of ['bottle gourd', 'head cheese', 'spring roll', 'spare ribs', 'chicken-fried', 'breadstick', 'bagel']) {
      const c = canonical(line);
      expect(c.quantity.kind, line).toBe('absent');
      expect(c.foodText, line).toBe(line);
      expect(c.rawUnit, line).toBeNull();
      expect(c.unit, line).toBeNull();
    }
  });

  it('never invents a food phrase when only a measure remains', () => {
    const c = canonical('2 cloves');
    expect(c.countNoun).toBe('clove');
    expect(c.unit).toBe('clove');
    // No food head exists, so the bounded fallback keeps the source text.
    expect(c.foodText).toBe('2 cloves');
  });
});

describe('phase 1 canonical parsing — containers', () => {
  it('classifies every container noun and plural without any mass', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['1 jar marinara sauce', 'jar'],
      ['2 jars marinara sauce', 'jar'],
      ['1 package cream cheese', 'package'],
      ['2 packages cream cheese', 'package'],
      ['2 pkg cream cheese', 'package'],
      ['1 can black beans', 'can'],
      ['2 cans tomato sauce', 'can'],
      ['1 box pasta', 'box'],
      ['2 boxes pasta', 'box'],
      ['1 bag spinach', 'bag'],
      ['2 bags spinach', 'bag'],
      ['1 bottle hot sauce', 'bottle'],
      ['2 bottles hot sauce', 'bottle'],
    ];
    for (const [line, noun] of cases) {
      const c = canonical(line);
      expect(c.unitKind, line).toBe('container');
      expect(c.container, line).toBe(noun);
      expect(c.countNoun, line).toBeNull();
      expect(c.packageNetMass, line).toBeNull();
      const p = review(line);
      expect(p.grams, line).toBeUndefined();
      expect(p.milliliters, line).toBeUndefined();
    }
  });

  it('never lets a container become a count conversion unit (jar/box/bag/bottle)', () => {
    for (const noun of ['jar', 'box', 'bag', 'bottle']) {
      expect(canonicalCountUnit(noun), noun).toBeNull();
    }
    // Pre-existing calculation vocabulary entries stay intact.
    expect(canonicalCountUnit('can')).toBe('can');
    expect(canonicalCountUnit('package')).toBe('package');
  });

  it('keeps every container unresolved without an authenticated USDA portion route', () => {
    for (const line of ['1 jar marinara sauce', '1 bottle hot sauce', '1 box pasta', '1 bag spinach']) {
      expect(review(line).measurement_kind, line).toBe('count');
      expect(review(line).grams, line).toBeUndefined();
    }
  });
});

describe('phase 1 canonical parsing — package net mass', () => {
  it('extracts every bounded package net-mass form with truthful scope', () => {
    const cases: ReadonlyArray<readonly [string, number, string, string, string]> = [
      ['1 (15 oz) can tomato sauce', 15, 'oz', 'per_container', 'tomato sauce'],
      ['1 (8 oz) package cream cheese', 8, 'oz', 'per_container', 'cream cheese'],
      ['2 (14.5 oz) cans diced tomatoes', 14.5, 'oz', 'per_container', 'diced tomatoes'],
      ['1 400 g can chickpeas', 400, 'g', 'per_container', 'chickpeas'],
      ['1 can (15 ounces) black beans', 15, 'oz', 'per_container', 'black beans'],
      ['1 (15 oz total) can tomato sauce', 15, 'oz', 'total', 'tomato sauce'],
    ];
    for (const [line, amount, unit, scope, food] of cases) {
      const c = canonical(line);
      expect(c.packageNetMass, line).toEqual({ amount, unit, scope });
      expect(c.foodText, line).toBe(food);
      // The outer count stays the amount; the net mass is representation only.
      expect(c.quantity.kind, line).toBe('exact');
      expect(c.quantity.amount, line).toBe(line.startsWith('2') ? 2 : 1);
      const p = review(line);
      expect(p.grams, line).toBeUndefined();
      expect(p.milliliters, line).toBeUndefined();
    }
  });

  it('never treats a package net mass as a generic container mass', () => {
    for (const line of PHASE1_PARSING_CASES.filter((entry) => entry.category === 'package-net-mass')) {
      const p = review(line.line);
      expect(p.package_net_mass, line.line).toBeDefined();
      expect(p.grams, line.line).toBeUndefined();
    }
  });

  it('does not extract a mass that is not attached to a container', () => {
    const beef = canonical('1 lb ground beef (80/20)');
    expect(beef.packageNetMass).toBeNull();
    expect(beef.foodText).toBe('ground beef (80/20)');
  });
});

describe('phase 1 canonical parsing — preservation', () => {
  it('keeps state, size, variety, and preparation words in the food phrase', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['2 medium potatoes', 'medium potatoes'],
      ['1 red bell pepper', 'red bell pepper'],
      ['1 can diced tomatoes', 'diced tomatoes'],
      ['1 lb ground beef', 'ground beef'],
      ['2 cups cooked rice', 'cooked rice'],
      ['1 cup dry rice', 'dry rice'],
      ['fresh thyme', 'fresh thyme'],
      ['dried thyme', 'dried thyme'],
      ['2 tbsp fresh parsley, chopped', 'fresh parsley, chopped'],
      ['1 can drained chickpeas', 'drained chickpeas'],
    ];
    for (const [line, food] of cases) {
      expect(canonical(line).foodText, line).toBe(food);
    }
  });

  it('exposes the canonical unit classification without changing the legacy projection', () => {
    // Legacy default (no includeCount) must not consume count/container nouns.
    expect(parseRawIngredientMeasurementParts('3 garlic cloves')).toEqual({
      amount: 3,
      unit: null,
      name: 'garlic cloves',
    });
    expect(parseRawIngredientMeasurementParts('1 jar marinara sauce')).toEqual({
      amount: 1,
      unit: null,
      name: 'jar marinara sauce',
    });
    // A range is unresolved in the legacy projection as well (never one endpoint).
    expect(parseRawIngredientMeasurementParts('1-2 tbsp olive oil')).toEqual({
      amount: null,
      unit: 'tbsp',
      name: 'olive oil',
    });
  });
});

describe('phase 1 canonical parsing — vocabulary owner', () => {
  it('classifies every household alias through the legacy unit ids', () => {
    for (const alias of householdUnitAliases()) {
      const household = canonicalHouseholdUnit(alias);
      expect(household, alias).not.toBeNull();
      expect(normalizeUnit(alias), alias).toBe('count');
      expect(getMeasurementKind('count'), alias).toBe('count');
    }
  });

  it('exposes closed count and container vocabularies', () => {
    expect(householdCountNouns()).toContain('clove');
    expect(householdCountNouns()).toContain('item');
    expect(householdContainerNouns()).toEqual(['can', 'package', 'jar', 'box', 'bag', 'bottle']);
    for (const noun of householdCountNouns()) {
      expect(canonicalHouseholdUnit(noun)?.kind, noun).toBe('count');
    }
    for (const noun of householdContainerNouns()) {
      expect(canonicalHouseholdUnit(noun)?.kind, noun).toBe('container');
    }
  });

  it('agrees with the calculation count vocabulary for household count nouns', () => {
    for (const noun of householdCountNouns()) {
      expect(canonicalCountUnit(noun), noun).toBe(noun);
    }
    expect(canonicalCountUnit('cloves')).toBe('clove');
    expect(canonicalCountUnit('leaves')).toBe('leaf');
    expect(canonicalCountUnit('stalks')).toBe('stalk');
  });
});

describe('phase 1 canonical parsing — compound-food collision policy', () => {
  it('never consumes a unit that begins a documented compound food name', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['1 bottle gourd', 'bottle gourd'],
      ['2 bottle gourds', 'bottle gourds'],
      ['1 head cheese', 'head cheese'],
      ['2 head cheeses', 'head cheeses'],
      ['2 heads cheese', 'heads cheese'],
      ['1 leaf lettuce', 'leaf lettuce'],
      ['2 leaf lettuces', 'leaf lettuces'],
    ];
    for (const [line, food] of cases) {
      const c = canonical(line);
      expect(c.quantity.kind, line).toBe('exact');
      expect(c.quantity.amount, line).toBe(line.startsWith('1') ? 1 : 2);
      expect(c.rawUnit, line).toBeNull();
      expect(c.unit, line).toBeNull();
      expect(c.unitKind, line).toBe('unknown');
      expect(c.countNoun, line).toBeNull();
      expect(c.container, line).toBeNull();
      expect(c.foodText, line).toBe(food);
      const p = review(line);
      expect(p.grams, line).toBeUndefined();
      expect(p.milliliters, line).toBeUndefined();
    }
  });

  it('still supports ordinary container lines and explicit `of` grammar', () => {
    const containers: ReadonlyArray<readonly [string, string, string]> = [
      ['1 bottle hot sauce', 'bottle', 'hot sauce'],
      ['1 bottle of hot sauce', 'bottle', 'hot sauce'],
      ['1 jar marinara sauce', 'jar', 'marinara sauce'],
      ['1 box pasta', 'box', 'pasta'],
      ['1 bag spinach', 'bag', 'spinach'],
      ['1 can black beans', 'can', 'black beans'],
      ['1 head cabbage', 'head', 'cabbage'],
      ['1 leaf of lettuce', 'leaf', 'lettuce'],
    ];
    for (const [line, noun, food] of containers) {
      const c = canonical(line);
      expect(c.unit, line).toBe(noun);
      expect(c.foodText, line).toBe(food);
      const p = review(line);
      expect(p.grams, line).toBeUndefined();
    }
    expect(canonical('1 bottle hot sauce').unitKind).toBe('container');
    expect(canonical('1 leaf of lettuce').unitKind).toBe('count');
  });

  it('keeps the collision policy closed, centralized, and documented', () => {
    expect([...householdCollisionUnitNouns()].sort()).toEqual(['bottle', 'head', 'leaf']);
    expect(householdCollisionHeads('bottle')).toEqual(['gourd', 'gourds']);
    expect(householdCollisionHeads('head')).toEqual(['cheese', 'cheeses']);
    for (const noun of householdCollisionUnitNouns()) {
      expect(canonicalHouseholdUnit(noun), noun).not.toBeNull();
      expect(householdCollisionHeads(noun).length, noun).toBeGreaterThanOrEqual(2);
    }
    // Token-boundary logic only: unrelated words and longer tokens never match.
    expect(householdUnitFoodCollision('bottle', 'gourmet sauce')).toBe(false);
    expect(householdUnitFoodCollision('bottle', 'gourd-geous')).toBe(false);
    expect(householdUnitFoodCollision('head', 'cheesecake')).toBe(false);
    expect(householdUnitFoodCollision('bottle', 'GOURDS')).toBe(true);
    expect(householdUnitFoodCollision('bottle', 'gourds, sliced')).toBe(true);
  });
});

describe('phase 1 canonical parsing — adversarial and mutation-sensitive', () => {
  it('never misclassifies words by substring replacement', () => {
    const words = ['bagel', 'bottle gourd', 'head cheese', 'spring roll', 'spare ribs', 'chicken-fried', 'breadstick'];
    for (const word of words) {
      const c = canonical(word);
      expect(c.foodText, word).toBe(word);
      expect(c.rawUnit, word).toBeNull();
      expect(c.unit, word).toBeNull();
      expect(c.countNoun, word).toBeNull();
      expect(c.container, word).toBeNull();
    }
  });

  it('handles repeated separators and dashes without fragments or throws', () => {
    const lines = ['1--2 tbsp oil', '1 - - 2 tbsp oil', '1 – – 2 tbsp oil', '1---2 cups water', '--1 cup water'];
    for (const line of lines) {
      const c = canonical(line);
      expect(['range', 'invalid', 'absent'], line).toContain(c.quantity.kind);
      if (c.quantity.kind !== 'range') expect(c.quantity.amount, line).toBeNull();
      expect(c.foodText.length, line).toBeGreaterThan(0);
    }
  });

  it('handles malformed fractions and non-finite-like quantities safely', () => {
    for (const line of ['1/0 cup flour', '1/2/3 cups flour', 'NaN cups flour', 'Infinity cups flour', '1e10 cups water']) {
      const c = canonical(line);
      expect(c.quantity.amount === null || Number.isFinite(c.quantity.amount), line).toBe(true);
      expect(c.foodText.length, line).toBeGreaterThan(0);
      const p = review(line);
      if (p.amount !== null) expect(Number.isFinite(p.amount), line).toBe(true);
      expect(p.grams, line).toBeUndefined();
    }
  });

  it('handles nested and unmatched parentheses without throwing', () => {
    for (const line of ['1 ((15 oz)) can tomato sauce', '1 (15 oz can tomato sauce', '1 15 oz) can tomato sauce', '1 can (15 ounces black beans']) {
      const c = canonical(line);
      expect(c.foodText.length, line).toBeGreaterThan(0);
      if (c.quantity.kind === 'exact') expect(c.quantity.amount, line).toBe(1);
    }
  });

  it('accepts bounded long text and never truncates silently inside a parser call', () => {
    const long = `1-2 tbsp ${'a'.repeat(280)}`;
    expect(long.length).toBeLessThanOrEqual(300);
    const c = canonical(long);
    expect(c.quantity.kind).toBe('range');
    expect(c.foodText.length).toBeGreaterThan(200);

    const over = `2 cups ${'b'.repeat(300)}`;
    const parsed = parseIngredient(over);
    expect(parsed.ok).toBe(false);
    expect((parsed as { failure: { code: string } }).failure.code).toBe('oversized_input');
  });

  it('fails closed on unsafe structured input shapes', () => {
    expect(parseIngredient({ original: ['x'] }).ok).toBe(false);
    expect(parseIngredient({ original: 'x', amount: {} }).ok).toBe(false);
    expect(parseIngredient({ original: 'x', amount: 'not-a-number' }).ok).toBe(false);
    expect(parseIngredient({ original: 'x', unexpected: 1 }).ok).toBe(false);
    const proto = JSON.parse('{"__proto__": {"polluted": true}, "name": "x"}');
    const result = parseIngredient(proto);
    expect(result.ok).toBe(false);
  });

  it('is deterministic, mutation-free, and repeatable', () => {
    const line = '2 garlic cloves, minced (optional)';
    const first = canonical(line);
    const second = canonical(line);
    expect(second).toEqual(first);
    expect(line).toBe('2 garlic cloves, minced (optional)');
    const inputs = PHASE1_PARSING_CASES.map((entry) => entry.line);
    const before = JSON.stringify(inputs);
    inputs.forEach((entry) => canonical(entry));
    expect(JSON.stringify(inputs)).toBe(before);
  });

  it('keeps casing and punctuation out of the canonical classification', () => {
    const upper = canonical('1 JAR Marinara Sauce');
    const lower = canonical('1 jar marinara sauce');
    expect(upper.unit).toBe(lower.unit);
    expect(upper.unitKind).toBe(lower.unitKind);
    expect(upper.foodText.toLowerCase()).toBe(lower.foodText);
  });
});
