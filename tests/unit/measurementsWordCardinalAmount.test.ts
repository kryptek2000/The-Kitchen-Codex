import { describe, it, expect } from 'vitest';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { CODEX_NUTRITION_SCHEMA_V1 } from '../../src/core/nutritionV2/schema';
import {
  CANONICAL_INGREDIENT_PARSE_VERSION,
  parseCanonicalIngredientParts,
  parseRawIngredientMeasurementParts,
} from '../../src/utils/measurements';
import { canonicalHouseholdUnit, householdContainerNouns } from '../../src/utils/householdUnits';

/**
 * Focused regression: spelled-out CARDINAL amounts `one` … `twelve` are parsed
 * when (and only when) they precede an existing supported measurement or
 * count/container unit, feeding the current amount parsing — no new units, no
 * conversions, no defaults.
 *
 * Explicit non-goals proved here: bare `a`, `half`, `quarter`, ordinal words,
 * compound word numbers, and word numbers not followed by a supported unit
 * remain untouched.
 *
 * Contract repair proved here (OpenClaw word-cardinal follow-up):
 *   - the immutable source wording is preserved: `originalText` is NEVER the
 *     internally expanded numeral form (which remains parsing-only);
 *   - `CANONICAL_INGREDIENT_PARSE_VERSION` is `canonical_ingredient_parse_v2`
 *     because leading word cardinals changed the canonical classification of
 *     existing inputs;
 *   - raw and structured review provenance (`original_text`, `line_ref`) always
 *     expose the authored line, never the expanded working form;
 *   - structured explicit amounts are never overwritten by a word cardinal;
 *   - ranges / malformed quantities stay fail-closed and invent no endpoint;
 *   - the word-cardinal path never bypasses the compound-food collision policy
 *     or the `tin` -> `can` container alias (which never implies mass).
 */

type ParsedOk = Extract<ReturnType<typeof parseIngredient>, { ok: true }>['parsed'];

function parsed(raw: unknown): ParsedOk {
  const result = parseIngredient(raw);
  if (!result.ok) throw new Error(`expected parse to succeed for: ${String(raw)}`);
  return result.parsed;
}

function canonical(line: string) {
  return parseCanonicalIngredientParts(line, { includeCount: true });
}

function measurementShape(p: ParsedOk) {
  return {
    amount: p.amount,
    query: p.query,
    unit_kind: p.unit_kind,
    count_noun: p.count_noun,
    container: p.container,
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
    expect(measurementShape(parsed('one tin chopped tomatoes'))).toEqual(
      measurementShape(parsed('1 can chopped tomatoes')),
    );
  });

  it('keeps the authored wording distinct and truthful in the numeric-equivalence pairs', () => {
    // Measurement authority must be equal even though the source wording is not.
    expect(parsed('one cup flour').original_text).toBe('one cup flour');
    expect(parsed('1 cup flour').original_text).toBe('1 cup flour');
    expect(parsed('two cloves garlic').original_text).toBe('two cloves garlic');
    expect(parsed('2 cloves garlic').original_text).toBe('2 cloves garlic');
    expect(parsed('three tbsp olive oil').original_text).toBe('three tbsp olive oil');
    expect(parsed('3 tbsp olive oil').original_text).toBe('3 tbsp olive oil');
    expect(parsed('one tin chopped tomatoes').original_text).toBe('one tin chopped tomatoes');
    expect(parsed('1 can chopped tomatoes').original_text).toBe('1 can chopped tomatoes');
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

describe('canonical source preservation', () => {
  it('preserves the true original text while parsing quantity from the working form', () => {
    const c = canonical('one cup flour');
    expect(c.originalText).toBe('one cup flour');
    expect(c.originalText).not.toBe('1 cup flour');
    expect(c.quantity.kind).toBe('exact');
    expect(c.quantity.amount).toBe(1);
    expect(c.unit).toBe('cup');
    expect(c.unitKind).toBe('volume');
    expect(c.rawUnit).toBe('cup');
    expect(c.foodText).toBe('flour');
  });

  it.each([
    ['Two Cloves Garlic', 'Two Cloves Garlic', 2, 'clove', 'count', 'Garlic'],
    ['three tbsp olive oil', 'three tbsp olive oil', 3, 'tbsp', 'volume', 'olive oil'],
    ['one tin chopped tomatoes', 'one tin chopped tomatoes', 1, 'can', 'container', 'chopped tomatoes'],
    ['one head cheese', 'one head cheese', 1, null, 'unknown', 'head cheese'],
    ['one bottle gourd', 'one bottle gourd', 1, null, 'unknown', 'bottle gourd'],
  ] as const)(
    'preserves source wording for %s',
    (line, source, amount, unit, unitKind, foodText) => {
      const c = canonical(line);
      expect(c.originalText).toBe(source);
      expect(c.quantity.amount).toBe(amount);
      expect(c.unit).toBe(unit);
      expect(c.unitKind).toBe(unitKind);
      expect(c.foodText).toBe(foodText);
    }
  );

  it('falls back to the authored source (never the expanded numeral) when no food remains', () => {
    const c = canonical('one cup');
    expect(c.originalText).toBe('one cup');
    expect(c.foodText).toBe('one cup');
    expect(c.quantity.amount).toBe(1);
    expect(c.unit).toBe('cup');
  });

  it('preserves the authored source on an invalid word-cardinal parse', () => {
    const c = canonical('one cup -2 tbsp oil');
    expect(c.originalText).toBe('one cup -2 tbsp oil');
    expect(c.foodText).toBe('one cup -2 tbsp oil');
    expect(c.quantity.kind).toBe('invalid');
    expect(c.quantity.amount).toBeNull();
  });

  it('never exposes the expanded working form through the legacy projection', () => {
    expect(parseRawIngredientMeasurementParts('one cup flour', { includeCount: true })).toEqual({
      amount: 1,
      unit: 'cup',
      name: 'flour',
    });
    expect(parseRawIngredientMeasurementParts('one cup', { includeCount: true })).toEqual({
      amount: 1,
      unit: 'cup',
      name: 'one cup',
    });
  });
});

describe('raw parsing provenance', () => {
  it('keeps the real authored raw line in original_text and line_ref', () => {
    const p = parsed('one cup flour');
    expect(p.original_text).toBe('one cup flour');
    expect(p.line_ref).toBe('one cup flour');
    expect(p.original_text).not.toMatch(/\d/);
    expect(p.line_ref).not.toMatch(/\d/);
    expect(p.amount).toBe(1);
    expect(p.query).toBe('flour');
    expect(p.quantity_kind).toBe('exact');
    expect(p.unit_kind).toBe('volume');
    expect(p.measurement_kind).toBe('volume');
  });

  it('keeps provenance truthful for mixed casing and container lines', () => {
    for (const line of ['Two Cloves Garlic', 'one tin chopped tomatoes', 'one head cheese']) {
      const p = parsed(line);
      expect(p.original_text, line).toBe(line);
      expect(p.line_ref, line).toBe(line);
    }
  });

  it('keeps provenance truthful and fails closed for a malformed word-cardinal parse', () => {
    const p = parsed('one cup -2 tbsp oil');
    expect(p.original_text).toBe('one cup -2 tbsp oil');
    expect(p.line_ref).toBe('one cup -2 tbsp oil');
    expect(p.amount).toBeNull();
    expect(p.quantity_kind).toBe('invalid');
  });

  it('does not leak the expanded numeral into the query fallback', () => {
    const p = parsed('one cup');
    expect(p.original_text).toBe('one cup');
    expect(p.query).toBe('one cup');
    expect(p.query).not.toBe('1 cup');
    expect(p.amount).toBe(1);
  });
});

describe('structured parsing', () => {
  it('keeps the real `original` authoritative for provenance', () => {
    const p = parsed({ original: 'one cup flour', name: 'flour' });
    expect(p.original_text).toBe('one cup flour');
    expect(p.line_ref).toBe('one cup flour');
    expect(p.query).toBe('flour');
    expect(p.quantity_kind).toBe('exact');
    expect(p.unit_kind).toBe('volume');
    // No structured amount was supplied: none may be invented from the wording.
    expect(p.amount).toBeNull();
  });

  it('preserves a caller-supplied line_ref and never rewrites the original', () => {
    const p = parsed({ original: 'one cup flour', name: 'flour', line_ref: 'L7' });
    expect(p.line_ref).toBe('L7');
    expect(p.original_text).toBe('one cup flour');
    expect(p.amount).toBeNull();
  });

  it('never lets a word cardinal overwrite an explicit structured amount', () => {
    const p = parsed({ original: 'one cup flour', name: 'flour', amount: 5, unit: 'cup' });
    expect(p.amount).toBe(5);
    expect(p.query).toBe('flour');
    expect(p.measurement_kind).toBe('volume');
    expect(p.original_text).toBe('one cup flour');
  });

  it('keeps an explicit structured amount absent when authored absent', () => {
    const p = parsed({ original: 'one cup flour', name: 'flour', amount: null, unit: 'cup' });
    expect(p.amount).toBeNull();
    expect(p.original_text).toBe('one cup flour');
  });

  it('classifies a structured `Two Cloves Garlic` through the existing unit vocabulary', () => {
    const p = parsed({ original: 'Two Cloves Garlic', name: 'Garlic', amount: 2, unit: 'cloves' });
    expect(p.amount).toBe(2);
    expect(p.query).toBe('Garlic');
    expect(p.unit_kind).toBe('count');
    expect(p.count_noun).toBe('clove');
    expect(p.original_text).toBe('Two Cloves Garlic');
  });

  it('keeps a structured range fail-closed (no endpoint amount)', () => {
    const p = parsed({ original: '1-2 cups broth', name: 'broth', amount: 1, unit: 'cup' });
    expect(p.amount).toBeNull();
    expect(p.quantity_kind).toBe('range');
    expect(p.quantity_range).toEqual({ lower: 1, upper: 2 });
    expect(p.original_text).toBe('1-2 cups broth');
  });

  it('keeps a malformed structured quantity fail-closed with no invented amount', () => {
    const p = parsed({ original: '1 cup-2 tbsp oil', name: 'oil' });
    expect(p.amount).toBeNull();
    expect(p.quantity_kind).toBe('invalid');
    expect(p.original_text).toBe('1 cup-2 tbsp oil');

    const word = parsed({ original: 'one cup -2 tbsp oil', name: 'oil' });
    expect(word.amount).toBeNull();
    expect(word.quantity_kind).toBe('invalid');
    expect(word.original_text).toBe('one cup -2 tbsp oil');
  });
});

describe('canonical parse version contract', () => {
  it('pins the canonical parse contract at v2', () => {
    expect(CANONICAL_INGREDIENT_PARSE_VERSION).toBe('canonical_ingredient_parse_v2');
  });

  it('exposes v2 on canonical, raw, and structured parse results', () => {
    expect(canonical('one cup flour').version).toBe('canonical_ingredient_parse_v2');
    expect(parsed('one cup flour').parse_version).toBe('canonical_ingredient_parse_v2');
    expect(parsed({ original: 'one cup flour', name: 'flour' }).parse_version).toBe(
      'canonical_ingredient_parse_v2'
    );
  });

  it('no longer emits v1 from current parsing', () => {
    for (const line of ['one cup flour', '1 cup flour', '2 to 3 cloves garlic', 'one tin beans']) {
      expect(parsed(line).parse_version, line).not.toBe('canonical_ingredient_parse_v1');
      expect(parsed(line).parse_version, line).toBe(CANONICAL_INGREDIENT_PARSE_VERSION);
    }
  });

  it('leaves the persisted nutrition schema version unchanged', () => {
    expect(CODEX_NUTRITION_SCHEMA_V1).toBe(1);
  });
});

describe('compound-food collision policy under word cardinals', () => {
  it.each([
    ['one bottle gourd'],
    ['one head cheese'],
    ['one leaf lettuce'],
  ])('preserves full food identity and wording: %s', (line) => {
    const c = canonical(line);
    expect(c.originalText).toBe(line);
    expect(c.quantity.amount).toBe(1);
    expect(c.unit).toBeNull();
    expect(c.unitKind).toBe('unknown');
    expect(c.container).toBeNull();
    expect(c.countNoun).toBeNull();
    expect(c.foodText).toBe(line.replace(/^one\s+/, ''));
    expect(c.packageNetMass).toBeNull();

    const p = parsed(line);
    expect(p.original_text).toBe(line);
    expect(p.query).toBe(line.replace(/^one\s+/, ''));
    expect(p.container).toBeUndefined();
    expect(p.count_noun).toBeUndefined();
    expect(p.grams).toBeUndefined();
  });

  it.each([
    ['one bottle of hot sauce', 'hot sauce', 'bottle', undefined],
    ['one head of cabbage', 'cabbage', undefined, 'head'],
    ['one leaf of lettuce', 'lettuce', undefined, 'leaf'],
  ] as const)(
    'consumes the unit when an explicit `of` separator is present: %s',
    (line, foodText, container, countNoun) => {
      const c = canonical(line);
      expect(c.originalText).toBe(line);
      expect(c.quantity.amount).toBe(1);
      expect(c.foodText).toBe(foodText);
      expect(c.container).toBe(container ?? null);
      expect(c.countNoun).toBe(countNoun ?? null);
      expect(c.packageNetMass).toBeNull();
    }
  );

  it('keeps `tin`/`tins` authority-identical to `can`/`cans` and never mass-bearing', () => {
    expect(canonicalHouseholdUnit('tin')).toEqual({ noun: 'can', kind: 'container' });
    expect(canonicalHouseholdUnit('tins')).toEqual({ noun: 'can', kind: 'container' });
    expect(householdContainerNouns()).toContain('can');
    expect(householdContainerNouns()).not.toContain('tin');

    const tin = parsed('one tin chopped tomatoes');
    const can = parsed('1 can chopped tomatoes');
    expect(measurementShape(tin)).toEqual(measurementShape(can));
    expect(tin.query).toBe('chopped tomatoes');
    expect(tin.amount).toBe(1);
    expect(tin.container).toBe('can');
    expect(tin.measurement_kind).toBe('count');
    expect(tin.grams).toBeUndefined();
    expect(tin.milliliters).toBeUndefined();
    expect(tin.original_text).toBe('one tin chopped tomatoes');
    expect(can.original_text).toBe('1 can chopped tomatoes');

    const tins = parsed('two tins beans');
    const cans = parsed('2 cans beans');
    expect(measurementShape(tins)).toEqual(measurementShape(cans));
    expect(tins.original_text).toBe('two tins beans');
    expect(cans.original_text).toBe('2 cans beans');
  });
});
