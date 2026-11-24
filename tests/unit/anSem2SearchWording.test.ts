/**
 * AN-SEM-2 — food-category-aware AI search wording.
 *
 * PURE/OFFLINE. Verifies the prompt refinement and proves that a suitably
 * specific generic phrase can reach the real authenticated USDA catalog while
 * an unsupported generic phrase remains unresolved. No provider is called.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { WHOLE_RECIPE_SEMANTIC_INSTRUCTIONS } from '../../server/wholeRecipeSemanticInterpret';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { resolveFoodsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiResolve';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdaptedIngredient, AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_1f3e3068a7ae0702f360d1caae40a628'
);
const LINES = ['2 tbsp unsalted butter', '1 cup half and half', '1 cup passata'];

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

let session: AdvancedNutritionSession;
let rows: ReturnType<typeof buildReviewRows>;
let adapted: ReadonlyArray<AdaptedIngredient>;

beforeAll(async () => {
  const result = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  });
  if (!result.ok) throw new Error('bundle failed');
  session = result.session;
  const adaptation = adaptRecipe({
    id: 'an-sem-2',
    title: 'AN-SEM-2 Search Wording',
    servings: 4,
    ingredients: LINES.map(structuredLine),
  });
  if (!adaptation.ok) throw new Error('adapt failed');
  adapted = adaptation.recipe.adapted;
  rows = buildReviewRows(session, adapted);
}, 240000);

describe('AN-SEM-2 — prompt contract', () => {
  const prompt = WHOLE_RECIPE_SEMANTIC_INSTRUCTIONS.join('\n').toLowerCase();

  it('requires food-category-aware search wording rather than isolated ambiguous tokens', () => {
    expect(prompt).toContain('specific enough for a food database');
    expect(prompt).toContain('food family/category');
    expect(prompt).toContain('never offer an isolated ambiguous token');
  });

  it('requires common food terminology only when genuinely equivalent', () => {
    expect(prompt).toContain('specific, commonly understood food descriptions');
    expect(prompt).toContain('genuinely equivalent');
    expect(prompt).toContain('never invent a food category');
  });

  it('preserves composition, processing, preparation and state, with a bounded phrase set', () => {
    expect(prompt).toContain('composition, processing, preparation, and state');
    expect(prompt).toContain('small bounded set of distinct useful search phrases');
    expect(prompt).toContain('do not pad with unsupported synonyms');
  });

  it('asks for multiple database-style discovery hypotheses when the authored name is not a database description', () => {
    expect(prompt).toContain('regional, branded, translated, or home-cooking name');
    expect(prompt).toContain('discovery hypotheses');
    expect(prompt).toContain('database-style food descriptions');
    expect(prompt).toContain('more than one distinct search formulation');
    expect(prompt).toContain('search hypotheses, not assertions');
    expect(prompt).toContain('never erase a food-defining modifier');
  });

  it('contains no ingredient-specific dictionary or example food mapping', () => {
    expect(prompt).not.toContain('half and half');
    expect(prompt).not.toContain('passata');
    expect(prompt).not.toContain('tomato puree');
    expect(prompt).not.toContain('cream fluid');
  });
});

describe('AN-SEM-2 — controlled search wording reaches real USDA validation', () => {
  it('a category-qualified dairy phrase can produce an authenticated auto candidate and portion', () => {
    const halfRow = rows.find((row) => /half and half/i.test(row.original_text));
    if (!halfRow) throw new Error('missing half-and-half row');
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows,
      adapted,
      suggestions: [
        {
          line_ref: halfRow.line_ref,
          // CONTROLLED wording, not an actual model response.
          interpreted_food_name: 'cream',
          suggested_usda_queries: ['cream fluid half and half'],
        },
      ],
    });
    const candidate = outcome.candidates.find((entry) => entry.line_ref === halfRow.line_ref);
    expect(candidate).toBeDefined();
    expect(candidate?.fdc_id).toBe(171255);
    expect(candidate?.description).toMatch(/cream, fluid, half and half/i);
    expect(candidate?.auto).toBe(true);
    expect(candidate?.portion).toBeDefined();
    expect(candidate?.choice.catalog_digest).toBe(session.metadata().catalog_digest);
  });

  it('an unsupported generic tomato phrase is not forced into a resolution', () => {
    const passataRow = rows.find((row) => /passata/i.test(row.original_text));
    if (!passataRow) throw new Error('missing passata row');
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows,
      adapted,
      suggestions: [
        {
          line_ref: passataRow.line_ref,
          // CONTROLLED wording, not an actual model response.
          interpreted_food_name: 'passata',
          suggested_usda_queries: ['tomato puree'],
        },
      ],
    });
    const candidate = outcome.candidates.find((entry) => entry.line_ref === passataRow.line_ref);
    // The deterministic confidence contract must not auto-select a materially
    // ambiguous tomato-puree variant for an unsupported passata identity.
    if (candidate) {
      expect(candidate.auto).toBe(false);
    } else {
      expect(outcome.unresolved).toContain(passataRow.line_ref);
    }
  });
});
