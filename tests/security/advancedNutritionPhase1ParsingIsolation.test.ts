/**
 * The Kitchen Codex — Advanced Nutrition Phase 1 parsing isolation / security
 * guard.
 *
 * Proves the canonical parsing layer is pure, offline, dependency-free in the
 * correct direction, and incapable of inventing mass:
 *   - `src/utils/householdUnits.ts` is a zero-import vocabulary owner;
 *   - the canonical parser (`src/utils/measurements.ts`) may depend only on the
 *     canonical fraction contract and the vocabulary owner — never on the
 *     calculation, matching, phase, server, provider, or UI layers;
 *   - the household vocabulary contains no gram weight of any kind;
 *   - no network, secret, persistence, or nondeterminism token exists in the
 *     parsing layer;
 *   - parsing is deterministic, mutation-free, and bounded.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  canonicalHouseholdUnit,
  householdCollisionHeads,
  householdCollisionUnitNouns,
  householdContainerNouns,
  householdCountNouns,
  householdUnitAliases,
} from '../../src/utils/householdUnits';
import { parseCanonicalIngredientParts } from '../../src/utils/measurements';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const HOUSEHOLD_UNITS = resolve(ROOT, 'src/utils/householdUnits.ts');
const MEASUREMENTS = resolve(ROOT, 'src/utils/measurements.ts');
const COUNT_PORTION = resolve(ROOT, 'src/core/nutritionV2/calculation/countPortion.ts');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const HOUSEHOLD_SOURCE = readFileSync(HOUSEHOLD_UNITS, 'utf8');
const MEASUREMENTS_SOURCE = readFileSync(MEASUREMENTS, 'utf8');

const NETWORK_TOKENS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\b/,
  /\bEventSource\b/,
  /\baxios\b/,
  /\bnode:(http|https|net|dns|tls)\b/,
];
const SECRET_TOKENS = [
  /api[_-]?key/i,
  /GEMINI/i,
  /OPENROUTER/i,
  /process\s*\.\s*env/,
  /localStorage/,
  /sessionStorage/,
  /indexedDB/,
];
const PERSISTENCE_TOKENS = [
  /codex_nutrition/,
  /encodeCodexNutrition/,
  /serializeRecipeToObsidianMarkdown/,
  /applyAdvancedNutritionRoundTrip/,
];
const NONDETERMINISM_TOKENS = [/\bMath\.random\b/, /\bDate\.now\b/, /new\s+Date\s*\(/, /\bperformance\.now\b/];
const AI_TOKENS = [/\bopenai\b/i, /\bopenrouter\b/i, /\bgemini\b/i, /\bprompt\b/i, /\bFDC\s*id\b/i];

describe('phase 1 parsing isolation — vocabulary owner', () => {
  it('is a zero-import, dependency-free module', () => {
    const stripped = stripComments(HOUSEHOLD_SOURCE);
    expect(stripped).not.toMatch(/\bimport\s/);
    expect(stripped).not.toMatch(/\brequire\s*\(/);
  });

  it('contains no gram weight, conversion factor, or mass authority of any kind', () => {
    const stripped = stripComments(HOUSEHOLD_SOURCE);
    for (const token of [/\bgrams?\b/i, /\bkg\b/i, /\boz\b/i, /\blb\b/i, /convertMassToGrams/, /gram_weight/]) {
      expect(stripped, `matcher ${token}`).not.toMatch(token);
    }
    // No numeric mass/quantity literal of any kind: a unit classification is
    // not a quantity. (Indexing/length comparisons in the classifier are not
    // weights, so only mass-qualified numbers are forbidden.)
    expect(stripped).not.toMatch(
      /\d+(\.\d+)?\s*(g|kg|oz|lb|gram|grams|kilogram|kilograms|ounce|ounces|pound|pounds)\b/i
    );
    // Every vocabulary entry is a plain lowercase noun token with no numbers.
    for (const alias of householdUnitAliases()) {
      expect(alias, alias).toMatch(/^[a-z]+$/);
    }
    for (const noun of householdCollisionUnitNouns()) {
      for (const head of householdCollisionHeads(noun)) {
        expect(head, `${noun}/${head}`).toMatch(/^[a-z]+$/);
      }
    }
  });

  it('classifies every count noun and container noun without mass', () => {
    for (const noun of [...householdCountNouns(), ...householdContainerNouns()]) {
      const unit = canonicalHouseholdUnit(noun);
      expect(unit, noun).not.toBeNull();
      expect(Object.keys(unit as object).sort()).toEqual(['kind', 'noun']);
    }
  });
});

describe('phase 1 parsing isolation — canonical parser dependency direction', () => {
  it('imports only the canonical fraction contract and the vocabulary owner', () => {
    const imports = [...MEASUREMENTS_SOURCE.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['../schema/recipeValidator', './householdUnits'].sort());
  });

  it('never reaches calculation, matching, phase, server, provider, or UI layers', () => {
    const stripped = stripComments(MEASUREMENTS_SOURCE);
    for (const forbidden of [
      /from\s+['"][^'"]*\/calculation\//,
      /from\s+['"][^'"]*\/matching\//,
      /from\s+['"][^'"]*\/phase\d/,
      /from\s+['"][^'"]*\/server\//,
      /from\s+['"][^'"]*components\//,
      /from\s+['"]react['"]/,
    ]) {
      expect(stripped, `matcher ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('the calculation layer derives its count nouns from the ONE vocabulary owner', () => {
    const source = readFileSync(COUNT_PORTION, 'utf8');
    expect(source).toMatch(/from\s+['"][^'"]*utils\/householdUnits['"]/);
    expect(source).toMatch(/householdCountNouns|householdUnitAliases/);
    // Containers are deliberately NOT added to the count conversion vocabulary.
    expect(source).not.toMatch(/householdContainerNouns/);
  });

  it('contains no network, secret, persistence, nondeterminism, or AI token', () => {
    for (const source of [HOUSEHOLD_SOURCE, MEASUREMENTS_SOURCE]) {
      const stripped = stripComments(source);
      for (const token of [
        ...NETWORK_TOKENS,
        ...SECRET_TOKENS,
        ...PERSISTENCE_TOKENS,
        ...NONDETERMINISM_TOKENS,
        ...AI_TOKENS,
      ]) {
        expect(stripped, `matcher ${token}`).not.toMatch(token);
      }
    }
  });
});

describe('phase 1 parsing isolation — bounded deterministic behavior', () => {
  it('is pure: repeated parses are content-identical and inputs are untouched', () => {
    const lines = [
      '1-2 tbsp olive oil',
      '2 garlic cloves, minced',
      '1 (15 oz) can tomato sauce',
      '1 400 g can chickpeas',
      'bottle gourd',
      '1-2-3 chained cups',
    ];
    const frozen = [...lines];
    const first = lines.map((line) => parseCanonicalIngredientParts(line, { includeCount: true }));
    const second = lines.map((line) => parseCanonicalIngredientParts(line, { includeCount: true }));
    expect(second).toEqual(first);
    expect(lines).toEqual(frozen);
  });

  it('stays linear and bounded on adversarial repeated input', () => {
    const lines = [
      '1-2-3-4-5-6 tbsp oil',
      '1((((15 oz)))) can x',
      `${'9'.repeat(40)}-${'9'.repeat(40)} cups water`,
      `1-2 tbsp ${'z'.repeat(260)}`,
      '2 to 3 to 4 cloves garlic',
    ];
    const started = Date.now();
    for (let round = 0; round < 2000; round += 1) {
      for (const line of lines) parseCanonicalIngredientParts(line, { includeCount: true });
    }
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('never emits a non-finite quantity for any parse result', () => {
    const lines = ['Infinity cups water', 'NaN-2 cups water', '1/0 cup flour', '999999999999 cups water', '0 cups water'];
    for (const line of lines) {
      const parsed = parseCanonicalIngredientParts(line, { includeCount: true });
      for (const value of [parsed.quantity.amount, parsed.quantity.lower, parsed.quantity.upper]) {
        if (value !== null) expect(Number.isFinite(value), line).toBe(true);
      }
      if (parsed.packageNetMass) {
        expect(Number.isFinite(parsed.packageNetMass.amount), line).toBe(true);
      }
    }
  });
});
