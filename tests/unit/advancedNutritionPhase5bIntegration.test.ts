/**
 * The Kitchen Codex — Advanced Nutrition Phase 5B: real-bundle hamburger Apply.
 *
 * Genuine application-level integration: the pinned, authenticated USDA bundle is
 * composed into a real Phase 4 session, the hamburger acceptance recipe is
 * reviewed (bacon 224 g / cheddar 68 g / buns 208 g; tomatoes & pickles
 * unresolved), and the explicit Apply writes exactly one canonical schema-v1
 * `codex_nutrition` block through the injected writer while preserving unrelated
 * recipe content.
 *
 * The synthetic unit tests cover the Apply mechanics; this file proves the real
 * authenticated end-to-end path.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { composeAdvancedNutritionSessionFromBundle, type RuntimeBundleInputs } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { decodeCodexNutrition, validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import {
  parseIngredientLine,
  parseObsidianRecipeMarkdown,
  serializeRecipeToObsidianMarkdown,
} from '../../src/utils/markdownParser';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import type { AdvancedNutritionSession, Phase4Action, Phase4State } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

const HAMBURGER_INGREDIENTS = [
  '1 pound ground beef (80/20), formed into 4 patties',
  '1 teaspoon kosher salt',
  '0.5 teaspoon ground black pepper',
  '8 slices bacon',
  '4 slices cheddar cheese',
  '4 burger buns',
  '1 cup shredded lettuce',
  '2 medium tomatoes, sliced',
  '4 pickles, sliced',
  '2 tablespoons mayonnaise',
  '1 tablespoon ketchup',
];

const SELECTIONS: ReadonlyArray<[string, number]> = [
  ['8 slices bacon', 168277],
  ['4 slices cheddar cheese', 328637],
  ['4 burger buns', 2707657],
  ['2 medium tomatoes, sliced', 2709719],
  ['4 pickles, sliced', 2710078],
];

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

let session: AdvancedNutritionSession | null = null;

beforeAll(async () => {
  const inputs: RuntimeBundleInputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!loaded.ok) throw new Error('real bundle failed');
  session = loaded.session;
}, 120000);

function buildHamburgerReviewed(): { recipe: ObsidianRecipe; state: Phase4State } {
  if (!session) throw new Error('no session');
  const filePath = 'Recipes/Hamburger Acceptance 5B.md';
  const recipe = {
    id: 'hamburger-5b',
    fileName: 'Hamburger Acceptance 5B.md',
    filePath,
    rawMarkdown: '',
    title: 'Hamburger Acceptance 5B',
    tags: ['food/recipes'],
    category: 'Main Course',
    cuisine: 'American',
    difficulty: 'Easy',
    rating: 5,
    servings: 4,
    ingredients: HAMBURGER_INGREDIENTS.map(structured),
    instructions: [{ stepNumber: 1, text: 'Grill and assemble.' }],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: { my_custom_field: 'keep-me' },
    nutrition: { calories: 999, protein: 1 },
    calories: '999',
  } as unknown as ObsidianRecipe;

  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe;
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adapted.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows: buildReviewRows(session, adapted.adapted),
    baseServings: adapted.base_servings,
  });
  const dispatch = (action: Phase4Action) => {
    state = phase4Reducer(state, action);
  };

  for (const [line, fdcId] of SELECTIONS) {
    const parsed = parseIngredientLine(line);
    const row = state.rows.find((entry) => entry.original_text === parsed.original);
    if (!row) throw new Error(`no row for ${line}`);
    dispatch({
      type: 'select_match',
      lineRef: row.line_ref,
      choice: { kind: 'candidate', fdc_id: fdcId, review_digest: row.review_digest as string },
    });
  }

  const seq = state.operationSeq;
  const request = buildCalculationRequest(adapted.adapted, state);
  const result = session.calculate(request);
  if (!result.ok) throw new Error(`calculation failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  dispatch({ type: 'preview_succeeded', seq, recipeKey: state.recipeKey as string, preview: result.preview });
  return { recipe, state };
}

describe('phase 5B — real hamburger Apply (authenticated USDA bundle)', () => {
  it('preserves the known count-portion results and applies one canonical block', async () => {
    if (!session) throw new Error('no session');
    const { recipe, state } = buildHamburgerReviewed();

    const writes: ObsidianRecipe[] = [];
    const result = await applyAdvancedNutrition({
      session,
      recipe,
      state,
      expectedMode: 'create',
      write: async (updated: ObsidianRecipe) => {
        writes.push(updated);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.mode).toBe('create');

    expect(writes).toHaveLength(1);
    const written = writes[0];
    const decoded = decodeCodexNutrition(written.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind !== 'v1') return;
    const block: CodexNutritionV1 = decoded.value;

    // The persisted block validates as canonical schema v1.
    expect(validateCodexNutritionV1(block).ok).toBe(true);
    expect(block.basis).toBe('total');
    expect(block.servings).toBe(4);
    expect(block.status).toBe('partial');

    // Provenance: bacon 224 g, cheddar 68 g, buns 208 g from authenticated portions.
    const byLine = new Map(block.ingredients.map((entry) => [entry.line_ref, entry]));
    const baconLine = state.rows.find((row) => row.original_text === '8 slices bacon')?.line_ref as string;
    const cheddarLine = state.rows.find((row) => row.original_text === '4 slices cheddar cheese')?.line_ref as string;
    const bunsLine = state.rows.find((row) => row.original_text === '4 burger buns')?.line_ref as string;
    expect(byLine.get(baconLine)?.source_food_id).toBe('168277');
    expect(byLine.get(baconLine)?.amount?.value).toBe(224);
    expect(byLine.get(cheddarLine)?.source_food_id).toBe('328637');
    expect(byLine.get(cheddarLine)?.amount?.value).toBe(68);
    expect(byLine.get(bunsLine)?.source_food_id).toBe('2707657');
    expect(byLine.get(bunsLine)?.amount?.value).toBe(208);

    // Tomatoes and pickles remain honestly unresolved.
    const unresolvedLines = new Set(block.unresolved.map((entry) => entry.line_ref));
    const tomatoLine = state.rows.find((row) => row.original_text === '2 medium tomatoes, sliced')?.line_ref as string;
    const pickleLine = state.rows.find((row) => row.original_text === '4 pickles, sliced')?.line_ref as string;
    expect(unresolvedLines.has(tomatoLine)).toBe(true);
    expect(unresolvedLines.has(pickleLine)).toBe(true);
  });

  it('writes a whole block and preserves unrelated content through the serializer', async () => {
    if (!session) throw new Error('no session');
    const { recipe, state } = buildHamburgerReviewed();

    // Simulate the real vault writer: serialize the updated recipe to Markdown.
    let markdown = '';
    const result = await applyAdvancedNutrition({
      session,
      recipe,
      state,
      write: async (updated: ObsidianRecipe) => {
        markdown = serializeRecipeToObsidianMarkdown(updated);
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reparsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
    expect(reparsed.title).toBe('Hamburger Acceptance 5B');
    expect(reparsed.frontmatter?.my_custom_field).toBe('keep-me');
    expect(reparsed.ingredients).toHaveLength(HAMBURGER_INGREDIENTS.length);
    expect(reparsed.instructions[0]?.text).toBe('Grill and assemble.');
    const decoded = decodeCodexNutrition(reparsed.codexNutrition);
    expect(decoded.kind).toBe('v1');
  });
});
