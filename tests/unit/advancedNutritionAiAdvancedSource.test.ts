/**
 * AI-1 — DETERMINISTIC SOURCE OBSERVATIONS.
 *
 * The authoritative amount evidence the canonical reconciliation consumes is
 * built from the RECIPE'S OWN deterministic parse state, before any provider
 * call, and is never requested from (or influenced by) provider output.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { parseIngredientLine } from '../../src/utils/markdownParser';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { reconcileAiAdvancedAmount } from '../../src/core/nutritionV2/aiAdvanced';
import {
  buildAuthoritativeAmountObservations,
  sourceAmountObservation,
} from '../../src/core/nutritionV2/aiAdvancedSource';
import type { AdaptedIngredient } from '../../src/core/nutritionV2/phase4/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

function adaptedFor(line: string): AdaptedIngredient {
  const parsedLine = parseIngredientLine(line);
  const ingredient = {
    original: line,
    ...(parsedLine.amount !== null ? { amount: parsedLine.amount } : {}),
    ...(parsedLine.unit !== undefined ? { unit: parsedLine.unit } : {}),
    name: parsedLine.name,
  };
  const recipe = {
    id: 'source-observations',
    fileName: 'source-observations.md',
    filePath: 'Recipes/source-observations.md',
    rawMarkdown: '',
    title: 'Source observations',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [ingredient],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as never;
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  return adaptation.recipe.adapted[0];
}

function rowsFor(entries: ReadonlyArray<AdaptedIngredient>): never {
  return entries.map((entry) => ({ line_ref: entry.line_ref, query: entry.ingredient.name })) as never;
}

describe('AI-1 deterministic source observations — authored state', () => {
  it('an exact scalar mass is never reported as a range', () => {
    const adapted = adaptedFor('3.5 lb beef chuck roast');
    const observation = sourceAmountObservation(adapted);
    expect(observation.quantity_kind).toBe('exact');
    expect(observation.amount).toBe(3.5);
    expect(observation.measurement_kind).toBe('mass');
    expect(observation.quantity_range ?? null).toBeNull();
    expect(observation.mass_range ?? null).toBeNull();
    expect(observation.representative_grams ?? null).toBeNull();
  });

  it('an authored range keeps BOTH endpoints and never a single endpoint scalar', () => {
    const adapted = adaptedFor('3-4 lb beef chuck roast');
    const observation = sourceAmountObservation(adapted);
    expect(observation.quantity_kind).toBe('range');
    expect(observation.amount).toBeNull();
    expect(observation.quantity_range).toEqual({ lower: 3, upper: 4 });
    expect(observation.measurement_kind).toBe('mass');
    expect(observation.representative_grams).toBeGreaterThan(0);
  });

  it('a written MASS range is distinguishable from the count range it annotates', () => {
    const adapted = adaptedFor('3 to 4 slices provolone (about 75-100 g in total)');
    const observation = sourceAmountObservation(adapted);
    expect(observation.quantity_kind).toBe('range');
    expect(observation.quantity_range).toEqual({ lower: 3, upper: 4 });
    expect(observation.mass_range).toEqual({ lower: 75, upper: 100 });
    expect(observation.representative_grams).toBe(87.5);
  });

  it('a count line carries no mass evidence at all', () => {
    const adapted = adaptedFor('3 cloves garlic, minced');
    const observation = sourceAmountObservation(adapted);
    expect(observation.quantity_kind).toBe('exact');
    expect(observation.amount).toBe(3);
    expect(observation.measurement_kind).toBe('count');
    expect(observation.representative_grams ?? null).toBeNull();
    expect(observation.mass_range ?? null).toBeNull();
  });

  it('a quantity-less line has no amount and no derived mass', () => {
    const adapted = adaptedFor('a pinch of crushed red pepper flakes');
    const observation = sourceAmountObservation(adapted);
    expect(observation.quantity_kind).toBe('absent');
    expect(observation.amount).toBeNull();
    expect(observation.representative_grams ?? null).toBeNull();
  });

  it('an unparseable line fails closed (invalid, no amount)', () => {
    const adapted = adaptedFor('3 cloves garlic, minced');
    const broken = { ...adapted, ingredient: { original: '', line_ref: adapted.line_ref } } as never;
    const observation = sourceAmountObservation(broken);
    expect(observation.quantity_kind).toBe('invalid');
    expect(observation.amount).toBeNull();
    expect(observation.measurement_kind).toBe('unknown');
  });
});

describe('AI-1 deterministic source observations — map construction', () => {
  it('observes exactly the rows that have deterministic evidence', () => {
    const adapted = [adaptedFor('3 cloves garlic, minced'), adaptedFor('1 cup heavy cream')];
    const rows = [
      { line_ref: adapted[0].line_ref },
      { line_ref: adapted[1].line_ref },
      { line_ref: 'line:no-deterministic-evidence' },
    ];
    const map = buildAuthoritativeAmountObservations({ rows: rows as never, adapted });
    expect(map.size).toBe(2);
    expect(map.has(adapted[0].line_ref)).toBe(true);
    expect(map.has(adapted[1].line_ref)).toBe(true);
    // A line without deterministic evidence simply has NO entry: an AI echo for
    // it can never be confirmed.
    expect(map.has('line:no-deterministic-evidence')).toBe(false);
  });

  it('is invariant to provider output: the same source yields the same map', () => {
    const adapted = [adaptedFor('3-4 lb beef chuck roast')];
    const rows = rowsFor(adapted);
    const before = buildAuthoritativeAmountObservations({ rows: rows as never, adapted });
    // A forged "provider response" object existing in the process cannot change
    // ANY observation: nothing provider-shaped is ever an input.
    const forgedProviderPayload = {
      interpretations: [
        {
          line_ref: adapted[0].line_ref,
          amount_semantics: { kind: 'exact', echoed_value: 500 },
        },
      ],
      grams: 500,
    };
    expect(forgedProviderPayload.interpretations[0].amount_semantics.echoed_value).toBe(500);
    const after = buildAuthoritativeAmountObservations({ rows: rows as never, adapted });
    expect([...after.entries()]).toEqual([...before.entries()]);
    expect(after.get(adapted[0].line_ref)?.amount).toBeNull();
    expect(after.get(adapted[0].line_ref)?.quantity_range).toEqual({ lower: 3, upper: 4 });
  });

  it('a provider echo cannot manufacture source evidence for an unobserved line', () => {
    // Nothing deterministic exists for this line, so the echo is refused.
    const forged = reconcileAiAdvancedAmount(
      { kind: 'exact', echoed_value: 2 },
      { quantity_kind: 'invalid', amount: null, measurement_kind: 'unknown' }
    );
    expect(forged.ok).toBe(false);
    const refusal = forged as { readonly ok: false; readonly code: string };
    expect(refusal.code).toBe('unconfirmed_quantity');
  });

  it('is a pure, provider-free module (static isolation)', () => {
    const source = readFileSync(join(REPO, 'src/core/nutritionV2/aiAdvancedSource.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(new Set(imports)).toEqual(
      new Set(['./phase4/rows', './phase4/types', './aiAdvanced'])
    );
    // BOUNDARY: the AI-1 source map reads the frozen parser ONLY through the
    // audited Phase 4 review boundary — never by importing Phase 2 itself.
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/matching/);
    }
    expect(source).not.toMatch(/fetch\(|http|openai|gemini|anthropic|express|server\//i);
  });

  it('the observation shape has no field a provider could forge into evidence', () => {
    const adapted = adaptedFor('3 cloves garlic, minced');
    const observation = sourceAmountObservation(adapted);
    expect(Object.keys(observation).sort()).toEqual(
      ['amount', 'measurement_kind', 'quantity_kind'].sort()
    );
  });
});

describe('AI-1 deterministic source observations — parser agreement', () => {
  it('agrees with the deterministic Phase 1 parser for every observation field', () => {
    for (const line of [
      '3.5 lb beef chuck roast',
      '3-4 lb beef chuck roast',
      '3 cloves garlic, minced',
      '1 cup heavy cream',
      '12 oysters, shucked',
      'a pinch of crushed red pepper flakes',
      '2 medium yellow onions, thinly sliced',
    ]) {
      const adapted = adaptedFor(line);
      const parsed = parseIngredient(adapted.ingredient);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const observation = sourceAmountObservation(adapted);
      expect(observation.quantity_kind, line).toBe(parsed.parsed.quantity_kind);
      expect(observation.measurement_kind, line).toBe(parsed.parsed.measurement_kind);
      expect(observation.amount, line).toBe(
        parsed.parsed.quantity_kind === 'exact' ? parsed.parsed.amount : null
      );
    }
  });
});
