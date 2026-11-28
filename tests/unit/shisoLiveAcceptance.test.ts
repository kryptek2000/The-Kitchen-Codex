import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { createShisoNutritionReviewController } from '../../src/application/shisoNutritionReview';
import { initialShisoConversation, runShisoConversationTurn } from '../../src/application/shisoConversation';
import { toShisoRecipeView } from '../../src/application-ui/useShisoRecipeContext';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';

const ROOT = process.cwd();
const BUNDLE_DIR = join(ROOT, 'data/advanced-nutrition/usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);
const LINES = [
  '2 cups chopped vegetables (such as red onion, bell pepper, mushrooms or broccoli)',
  '1 pound breakfast sausage or Italian sausage',
  '2 pinches salt',
  '2 teaspoons unsalted butter',
  '8 burrito-size tortillas',
  '2 cups shredded cheddar cheese (or Monterey Jack)',
  '8 large eggs',
  '1 cup milk',
];

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const composed = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  } as never);
  if (!composed.ok) throw new Error('authenticated USDA fixture did not load');
  session = composed.session;
}, 180000);

describe('SHISO live acceptance — self-initialized real-catalogue investigation', () => {
  it('initializes without Advanced Nutrition, selects defensible real USDA lines, and asks once', async () => {
    const recipe = {
      id: 'breakfast-live',
      fileName: 'Breakfast Burritos.md',
      filePath: 'Recipes/Breakfast Burritos.md',
      rawMarkdown: '',
      title: 'Breakfast Burritos',
      tags: ['food/recipes'],
      category: 'Breakfast',
      cuisine: 'Mexican',
      difficulty: 'Easy',
      rating: 0,
      servings: 4,
      ingredients: LINES.map((original) => {
        const parsed = parseIngredient(original);
        return {
          original,
          name: parsed.ok ? parsed.parsed.query : original,
          ...(parsed.ok && parsed.parsed.amount !== null ? { amount: parsed.parsed.amount } : {}),
          ...(parsed.ok && parsed.parsed.raw_unit !== undefined ? { unit: parsed.parsed.raw_unit } : {}),
        };
      }),
      instructions: [{ text: 'Cook the filling and fill the tortillas.' }],
      callouts: [],
      dataviewFields: {},
      wikilinks: [],
      frontmatter: {},
    } as unknown as ObsidianRecipe;
    const view = toShisoRecipeView(recipe);
    if (view === null) throw new Error('recipe view failed');
    const controller = createShisoNutritionReviewController(recipe, session);
    if (controller === null) throw new Error('review controller failed');
    let currentSnapshot: ReturnType<typeof controller.getSnapshot> = null;
    const toolContext = {
      session,
      recipe: view,
      get nutrition() { return currentSnapshot; },
      runAnalysis: () => {
        const outcome = controller.analyze();
        currentSnapshot = controller.getSnapshot();
        return outcome;
      },
      acceptNutritionContributions: () => true,
      applyNutritionSourceSelection: (input: never) => controller.selectUsdaNutritionSource(input),
    } as never;

    const outcome = await runShisoConversationTurn({
      network: {
        request: async () => ({ status: 200, ok: true, data: {} }),
        get: async () => ({ status: 200, ok: true, data: {} }),
        post: async () => ({ status: 200, ok: true, data: { ok: true, kind: 'reply', text: 'unused', model_invocations_used: 1, tool_calls_used: 1 } }),
      } as never,
      context: {
        recipe: { title: recipe.title, ingredientCount: 8, stepCount: 1, servings: 4 },
        nutrition: { available: false, summary: null, unresolvedCount: 8, needsAmountCount: 0, needsMatchCount: 8, unsavedWorkingReview: false },
        recipeKey: 'breakfast-live',
        sessionIdentity: 'session-breakfast-live',
      },
      toolContext,
    }, initialShisoConversation(), "SHISO, investigate the unresolved nutrition for my Breakfast Burritos recipe. Use your available tools to identify the correct ingredients, find authenticated USDA sources, and resolve everything you can confidently resolve. Reject inappropriate food matches. Don't guess which ingredient alternatives I used. If you need information from me, ask one consolidated question covering all outstanding choices. Show me exactly what you've accomplished and what remains unresolved. Do not Apply or Save anything yet.");

    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toContain('run_nutrition_analysis');
    expect(outcome.toolsUsed).toContain('investigate_unresolved_ingredients');
    expect(outcome.toolsUsed).toContain('select_usda_nutrition_source');
    expect(outcome.toolsUsed).not.toContain('apply_nutrition_review');
    expect(outcome.toolsUsed).not.toContain('save_working_recipe');
    expect(outcome.message).toMatch(/initialized the unsaved nutrition review/i);
    expect(outcome.message).toMatch(/Selected 2 authenticated source\(s\).*Butter, without salt.*Cheese, cheddar/i);
    expect(outcome.message).toMatch(/consolidated choice set|which did you actually use|what measured amount/i);
    expect(outcome.message).toMatch(/chopped vegetables/i);
    expect(outcome.message).toMatch(/breakfast sausage/i);
    expect(outcome.message).toMatch(/pinches salt/i);
    expect(outcome.message).toMatch(/“8 burrito-size tortillas”.*what measured amount/i);
    expect(outcome.message).not.toMatch(/Open Advanced Nutrition/i);

    const rows = controller.getSnapshot()!.rows;
    const butter = rows.find((row) => row.original_text.includes('unsalted butter'));
    const cheddar = rows.find((row) => row.original_text.includes('cheddar cheese'));
    expect(butter).toMatchObject({ status: 'matched', selected_description: 'Butter, without salt', resolved_grams: 9.466666666666667 });
    expect(cheddar).toMatchObject({ status: 'matched', selected_description: 'Cheese, cheddar', resolved_grams: 210 });
    const tortillas = rows.find((row) => row.original_text.includes('burrito-size tortillas'));
    expect(tortillas?.status).not.toBe('matched');
    expect(tortillas?.selected_fdc_id ?? null).toBeNull();
    expect(rows.filter((row) => row.status !== 'matched').length).toBeGreaterThan(0);
  }, 180000);
});
