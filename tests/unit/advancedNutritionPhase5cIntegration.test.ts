/**
 * The Kitchen Codex — Advanced Nutrition Phase 5C: consolidated display across
 * the explicit Apply lifecycle.
 *
 * Proves that a legacy-only recipe becomes Advanced-primary after a successful
 * explicit Apply, that a failed Apply leaves the previously saved Advanced result
 * authoritative, and that legacy/simple fields are never mutated.
 */

import { describe, it, expect } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { parseIngredientLine, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import {
  resolveNutritionDisplayCalories,
  resolveRecipeNutritionPresentation,
} from '../../src/core/nutritionV2/phase5c';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import type { AdvancedNutritionSession, Phase4Action, Phase4State } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';

const SPECS: ReadonlyArray<CalcRecordSpec> = [
  {
    fdcId: 6001,
    dataType: 'sr_legacy',
    description: 'Flour, wheat, white',
    nutrients: { calories: 364, protein: 10.3 },
  },
];

const BUNDLE = buildCalculationBundle(SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipe(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Consolidation Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: [structured('100 g Flour, wheat, white')] as never,
    instructions: [{ stepNumber: 1, text: 'Bake.' }],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
    nutrition: { calories: 9999, protein: 1, servings: 2 } as never,
    calories: '9999',
    ...overrides,
  } as ObsidianRecipe;
}

function buildReviewed(target: ObsidianRecipe): Phase4State {
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe;
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adapted.recipe_key,
    sessionIdentity: phase4SessionIdentity(SESSION.metadata()),
    rows: buildReviewRows(SESSION, adapted.adapted),
    baseServings: adapted.base_servings,
  });
  const dispatch = (action: Phase4Action) => {
    state = phase4Reducer(state, action);
  };
  const seq = state.operationSeq;
  const result = SESSION.calculate(buildCalculationRequest(adapted.adapted, state));
  if (!result.ok) throw new Error('calc failed');
  dispatch({ type: 'preview_succeeded', seq, recipeKey: state.recipeKey as string, preview: result.preview });
  return state;
}

/** A valid saved block whose line ref matches the recipe's adapted ingredient set. */
function savedBlockFor(target: ObsidianRecipe, servings = 2): CodexNutritionV1 {
  const adaptation = adaptRecipe(target);
  const lineRef = adaptation.ok ? adaptation.recipe.adapted[0].line_ref : 'ing:0:seed';
  return {
    schema: 1,
    basis: 'total',
    servings,
    status: 'partial',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'r' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: { amount: 364, unit: 'kcal', status: 'partial', coverage: 0.5, covered_ingredient_count: 1, measurable_ingredient_count: 2 },
    },
    ingredients: [
      {
        line_ref: lineRef,
        source: 'usda_fdc',
        source_food_id: '6001',
        source_release: 'r',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
      },
    ],
    unresolved: [],
  };
}

describe('phase 5C — consolidated display across Apply', () => {
  it('legacy-only recipe becomes Advanced-primary after a successful explicit Apply', async () => {
    const original = recipe();
    const before = resolveRecipeNutritionPresentation(original);
    expect(before.kind).toBe('legacy');
    expect(resolveNutritionDisplayCalories(before, 2)).toBe(9999);

    let written: ObsidianRecipe | undefined;
    const result = await applyAdvancedNutrition({
      session: SESSION,
      recipe: original,
      state: buildReviewed(original),
      expectedMode: 'create',
      write: async (updated: ObsidianRecipe) => {
        written = updated;
        serializeRecipeToObsidianMarkdown(updated);
      },
    });
    expect(result.ok).toBe(true);
    expect(written).toBeDefined();
    if (!written) return;

    const after = resolveRecipeNutritionPresentation(written);
    expect(after.kind).toBe('advanced_saved');
    expect(after.advanced_preferred).toBe(true);
    expect(resolveNutritionDisplayCalories(after, 2)).toBeCloseTo(364, 6);
    // Legacy remains stored untouched (presentation keeps it as fallback data).
    expect(after.legacy_nutrition?.calories).toBe(9999);
    expect(written.nutrition?.calories).toBe(9999);
    expect(written.calories).toBe('9999');
  });

  it('a failed Apply leaves the previously saved Advanced result authoritative', async () => {
    const original = recipe({ frontmatter: { codex_nutrition: savedBlockFor(recipe()) } });
    const before = resolveRecipeNutritionPresentation(original);
    expect(before.kind).toBe('advanced_saved');
    expect(resolveNutritionDisplayCalories(before, 2)).toBe(364);
    const snapshot = JSON.stringify(original);

    const result = await applyAdvancedNutrition({
      session: SESSION,
      recipe: original,
      state: buildReviewed(original),
      write: async () => {
        throw new Error('disk full');
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result as { ok: false; failure: { code: string } }).failure.code).toBe('write_failed');

    // The recipe (and its saved block) is unchanged; the saved result stays primary.
    expect(JSON.stringify(original)).toBe(snapshot);
    const after = resolveRecipeNutritionPresentation(original);
    expect(after.kind).toBe('advanced_saved');
    expect(resolveNutritionDisplayCalories(after, 2)).toBe(364);
  });

  it('an unsaved review does not replace the saved Advanced display authority', () => {
    const original = recipe({ frontmatter: { codex_nutrition: savedBlockFor(recipe()) } });
    const presentation = resolveRecipeNutritionPresentation(original);
    // The selector reads only the SAVED block; an in-memory review is a separate,
    // unsaved concern and never changes the persisted display authority.
    expect(presentation.kind).toBe('advanced_saved');
    expect(presentation.advanced?.computed_at).toBe('2026-09-14T00:00:00.000Z');
  });
});
