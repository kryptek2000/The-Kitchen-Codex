import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { resolveFoodsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiResolve';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';

/**
 * Advanced Nutrition Phase 2 — AI source-constraint parity (real pinned bundle).
 *
 * Proves the production `resolveFoodsFromAiSuggestions` can never let AI wording
 * erase an authenticated source line's container-implied state, explicit state,
 * or explicit preparation form. Source context is reconstructed locally from the
 * session-bound row; provider wording is never trusted as context.
 */

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) {
    throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  }
  session = result.session;
}, 180000);

function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function rowsFor(line: string) {
  const adaptation = adaptRecipe({
    title: 'AI Source Constraint',
    servings: 4,
    ingredients: [structuredLine(line)],
  });
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  return { adapted, rows, row: rows[0] };
}

function resolveFor(
  line: string,
  suggestions: ReadonlyArray<{
    readonly interpreted_food_name: string;
    readonly suggested_usda_queries: ReadonlyArray<string>;
    readonly preparation_hint?: string;
    readonly count_descriptor_hint?: string;
    readonly quantity_unit_hint?: string;
  }>
) {
  const { adapted, rows, row } = rowsFor(line);
  const outcome = resolveFoodsFromAiSuggestions({
    session,
    rows,
    adapted,
    suggestions: suggestions.map((s) => ({ line_ref: row.line_ref, ...s })),
  });
  return { row, outcome };
}

describe('phase 2 AI source-constraint parity — diced tomatoes', () => {
  const SUGGESTIONS = [
    'diced tomatoes',
    'tomatoes',
    'raw tomatoes',
    'crushed tomatoes',
    'crushed canned tomatoes',
  ];

  for (const source of ['1 can diced tomatoes', '2 (14.5 oz) cans diced tomatoes']) {
    it(`never binds a raw or crushed tomato identity for ${source}`, () => {
      const { row, outcome } = resolveFor(
        source,
        SUGGESTIONS.map((query) => ({ interpreted_food_name: query, suggested_usda_queries: [query] }))
      );
      expect(outcome.candidates).toEqual([]);
      expect(outcome.unresolved.length).toBe(SUGGESTIONS.length);
      expect(outcome.unresolved.every((ref) => ref === row.line_ref)).toBe(true);
      expect(outcome.auto_count).toBe(0);
      // Candidates stay available for explicit review on the row itself.
      expect(row.candidates.length).toBeGreaterThan(0);
      expect(
        row.candidates.some((candidate) => /tomato/i.test(candidate.description))
      ).toBe(true);
      // No mass/nutrient authority is ever carried by an AI resolution.
      for (const candidate of outcome.candidates) {
        expect(candidate).not.toHaveProperty('grams');
        expect(candidate).not.toHaveProperty('calories');
      }
    });
  }

  it('still resolves a suggestion that does not contradict the source', () => {
    const { outcome } = resolveFor(
      '1 can diced tomatoes',
      [{ interpreted_food_name: 'tomatoes canned', suggested_usda_queries: ['tomatoes canned'] }]
    );
    for (const candidate of outcome.candidates) {
      expect(candidate.description).not.toMatch(/\braw\b|\bcrushed\b/i);
    }
  });
});

describe('phase 2 AI source-constraint parity — explicit state and form', () => {
  it('never binds fresh thyme for a dried source wording', () => {
    const { outcome } = resolveFor('dried thyme', [
      { interpreted_food_name: 'thyme', suggested_usda_queries: ['thyme', 'thyme dried'] },
    ]);
    for (const candidate of outcome.candidates) {
      expect(candidate.description).not.toMatch(/\bfresh\b/i);
    }
  });

  it('never binds dill seed or dried dill for a fresh dill source', () => {
    const { outcome } = resolveFor('fresh dill', [
      { interpreted_food_name: 'dill', suggested_usda_queries: ['dill'] },
    ]);
    for (const candidate of outcome.candidates) {
      expect(candidate.description).not.toMatch(/\bseed\b|\bdried\b/i);
    }
  });

  it('never binds a whole/chopped/minced/crushed mushroom for a sliced can source', () => {
    const { outcome } = resolveFor('1 can sliced mushrooms', [
      { interpreted_food_name: 'mushrooms', suggested_usda_queries: ['mushrooms'] },
      { interpreted_food_name: 'mushrooms whole', suggested_usda_queries: ['mushrooms whole'] },
      { interpreted_food_name: 'mushrooms chopped', suggested_usda_queries: ['mushrooms chopped'] },
    ]);
    for (const candidate of outcome.candidates) {
      expect(candidate.description).not.toMatch(/\b(raw|whole|chopped|minced|crushed)\b/i);
    }
  });

  it('never binds raw tomatoes for a crushed can source', () => {
    const { outcome } = resolveFor('1 can crushed tomatoes', [
      { interpreted_food_name: 'crushed tomatoes', suggested_usda_queries: ['crushed tomatoes'] },
    ]);
    for (const candidate of outcome.candidates) {
      expect(candidate.description).not.toMatch(/\braw\b/i);
    }
  });
});

describe('phase 2 AI source-constraint parity — legitimate resolutions preserved', () => {
  it.each([
    ['1 can tuna', 'tuna', 2706309],
    ['1 can black beans', 'black beans', 2707359],
    ['2 cups cooked long-grain rice (cooled)', 'cooked rice', 2708402],
    ['4 slices bacon', 'bacon', 168277],
    ['1 lb ground beef (80/20)', 'ground beef 80 20', 174036],
  ] as const)('%s + AI `%s` resolves %d', (source, query, fdc) => {
    const { outcome } = resolveFor(source, [
      { interpreted_food_name: query, suggested_usda_queries: [query] },
    ]);
    expect(outcome.candidates[0]?.fdc_id).toBe(fdc);
    expect(outcome.candidates[0]?.auto).toBe(true);
  });

  it('never lets AI erase a source variety (dry white rice must not bind red rice)', () => {
    const { outcome } = resolveFor('1 cup dry white rice', [
      { interpreted_food_name: 'dry rice', suggested_usda_queries: ['dry rice'] },
    ]);
    for (const candidate of outcome.candidates) {
      expect(candidate.description).not.toMatch(/\bred\b/i);
    }
    // The safe outcome may be review; it must never be a red-rice identity.
    if (outcome.candidates.length > 0) {
      expect(outcome.candidates[0].description).toMatch(/\bwhite\b/i);
    }
  });

  it('does not invent authority: no FDC/grams/digest from provider wording alone', () => {
    const { row, outcome } = resolveFor('1 can tuna', [
      { interpreted_food_name: 'tuna', suggested_usda_queries: ['tuna'] },
    ]);
    const candidate = outcome.candidates[0];
    expect(candidate.choice.review_digest).toBe(row.review_digest);
    expect(candidate.choice.kind).toBe('manual');
    expect(candidate.choice).not.toHaveProperty('automatic');
    expect(candidate).not.toHaveProperty('grams');
  });
});

describe('phase 2 AI source-constraint parity — context provenance and staleness', () => {
  it('does not let provider hints create source constraints', () => {
    const { outcome } = resolveFor('1 cup tomatoes', [
      {
        interpreted_food_name: 'tomatoes',
        suggested_usda_queries: ['tomatoes'],
        preparation_hint: 'crushed',
        count_descriptor_hint: 'can',
        quantity_unit_hint: 'can',
      },
    ]);
    // The source is silent about container/state/form, so a plain tomato
    // resolution remains legitimate; the hints add no constraint.
    expect(outcome.candidates[0]?.fdc_id).toBe(2709719);
  });

  it('does not let provider hints erase source constraints', () => {
    const { outcome } = resolveFor('1 can diced tomatoes', [
      {
        interpreted_food_name: 'tomatoes',
        suggested_usda_queries: ['tomatoes raw'],
        preparation_hint: 'peeled',
        quantity_unit_hint: 'cup',
      },
    ]);
    expect(outcome.candidates).toHaveLength(0);
  });

  it('rejects a stale source fingerprint (edited source line)', () => {
    const first = rowsFor('1 can diced tomatoes');
    const second = rowsFor('1 can diced tomatoes with basil');
    expect(second.row.line_ref).not.toBe(first.row.line_ref);
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows: second.rows,
      adapted: second.adapted,
      suggestions: [
        {
          line_ref: first.row.line_ref,
          interpreted_food_name: 'diced tomatoes',
          suggested_usda_queries: ['diced tomatoes'],
        },
      ],
    });
    expect(outcome.candidates).toHaveLength(0);
  });

  it('rejects a wrong line reference', () => {
    const { adapted, rows } = rowsFor('1 can tuna');
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows,
      adapted,
      suggestions: [
        {
          line_ref: 'ing:99:000000000000',
          interpreted_food_name: 'tuna',
          suggested_usda_queries: ['tuna'],
        },
      ],
    });
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(0);
  });
});
