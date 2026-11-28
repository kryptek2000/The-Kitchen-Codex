import { describe, expect, it } from 'vitest';

import {
  candidateIdentityVerdict,
  projectCulinaryIngredient,
} from '../../src/core/nutritionV2/phase4/ingredientInvestigation';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

function toolContext(session: AdvancedNutritionSession): ShisoToolContext {
  return { session, recipe: null, nutrition: null };
}

function sessionFixture() {
  const { manifest, records } = buildMatchingBundle([
    { fdcId: 1, dataType: 'sr_legacy', description: 'Butter, without salt', portions: [{ amount: 1, measure: 'tsp', gram_weight: 4.7, sequence: 1 }] },
    { fdcId: 2, dataType: 'sr_legacy', description: 'Seeds, sunflower seed butter, without salt', portions: [{ amount: 1, measure: 'tbsp', gram_weight: 16, sequence: 1 }] },
    { fdcId: 3, dataType: 'sr_legacy', description: 'Cheese, monterey jack, solid', portions: [{ amount: 1, measure: 'cup', gram_weight: 113, sequence: 1 }] },
    { fdcId: 4, dataType: 'sr_legacy', description: 'Fish, mackerel, jack, canned, drained solids', portions: [{ amount: 1, measure: 'cup', gram_weight: 190, sequence: 1 }] },
    { fdcId: 5, dataType: 'sr_legacy', description: 'Raw vegetable, NFS', portions: [{ amount: 1, measure: 'cup', gram_weight: 120, sequence: 1 }] },
    { fdcId: 6, dataType: 'sr_legacy', description: 'Beef and noodles', portions: [{ amount: 1, measure: 'cup', gram_weight: 200, sequence: 1 }] },
    { fdcId: 7, dataType: 'sr_legacy', description: 'Sausage, turkey, breakfast links, mild, raw', portions: [{ amount: 1, measure: 'link', gram_weight: 28, sequence: 1 }] },
    { fdcId: 8, dataType: 'sr_legacy', description: 'Sausage, egg and cheese breakfast biscuit', portions: [{ amount: 1, measure: 'biscuit', gram_weight: 126, sequence: 1 }] },
    { fdcId: 9, dataType: 'sr_legacy', description: 'Nuts, pecans', portions: [{ amount: 1, measure: 'cup', gram_weight: 109, sequence: 1 }] },
  ]);
  const created = createAdvancedNutritionSession(manifest, records);
  if (!created.ok) throw new Error('fixture session failed');
  return created.session;
}

describe('SHISO Phase 1 culinary identity projection', () => {
  it('separates authored identity, quantity, alternatives and flexible mixtures', () => {
    const vegetables = projectCulinaryIngredient('2 cups chopped vegetables (such as red onion, bell pepper, mushrooms or broccoli)');
    expect(vegetables.identity).toBe('vegetables');
    expect(vegetables.amount).toBe(2);
    expect(vegetables.unit).toBe('cups');
    expect(vegetables.flexible_mixture).toBe(true);
    expect(vegetables.choice_required).toBe(true);
    expect(vegetables.identities).toEqual(expect.arrayContaining(['red onion', 'bell pepper', 'mushrooms', 'broccoli']));

    const sausage = projectCulinaryIngredient('1 pound breakfast sausage or Italian sausage');
    expect(sausage.equal_choice).toBe(true);
    expect(sausage.choice_required).toBe(true);
    expect(sausage.identities).toEqual(['breakfast sausage', 'Italian sausage']);

    const cheese = projectCulinaryIngredient('2 cups shredded cheddar cheese (or Monterey Jack)');
    expect(cheese.primary_index).toBe(0);
    expect(cheese.equal_choice).toBe(false);
    expect(cheese.identities).toEqual(['cheddar cheese']);
    expect(cheese.alternatives.map((entry) => entry.label)).toEqual(['cheddar cheese', 'Monterey Jack']);
    expect(cheese.fallback_identities).toEqual([]);

    const tortillas = projectCulinaryIngredient('8 burrito-size tortillas');
    expect(tortillas.identity).toBe('burrito tortillas');
    expect(tortillas.fallback_identities).toEqual(['tortillas']);

    const salt = projectCulinaryIngredient('2 pinches salt');
    expect(salt.identity).toBe('salt');
    expect(salt.measurement_note).toMatch(/no documented exact mass conversion/i);
    expect(salt.choice_required).toBe(true);
  });

  it('rejects different food heads and composite dishes without rejecting category-prefixed foods', () => {
    expect(candidateIdentityVerdict('unsalted butter', 'Butter, without salt')).toMatchObject({ compatible: true });
    expect(candidateIdentityVerdict('unsalted butter', 'Seeds, sunflower seed butter, without salt')).toMatchObject({ compatible: false });
    expect(candidateIdentityVerdict('chopped vegetables', 'Beef and noodles')).toMatchObject({ compatible: false });
    expect(candidateIdentityVerdict('chopped vegetables', 'Vegetables as ingredient in curry')).toMatchObject({ compatible: false });
    expect(candidateIdentityVerdict('Monterey Jack', 'Cheese, monterey jack, solid')).toMatchObject({ compatible: true });
    expect(candidateIdentityVerdict('Monterey Jack', 'Fish, mackerel, jack, canned, drained solids')).toMatchObject({ compatible: false });
    expect(candidateIdentityVerdict('breakfast sausage', 'Sausage, turkey, breakfast links, mild, raw')).toMatchObject({ compatible: true });
    expect(candidateIdentityVerdict('breakfast sausage', 'Sausage, egg and cheese breakfast biscuit')).toMatchObject({ compatible: false });
    expect(candidateIdentityVerdict('pecans', 'Nuts, pecans')).toMatchObject({ compatible: true });
  });

  it('filters USDA search results by culinary identity', async () => {
    const session = sessionFixture();
    const ctx = toolContext(session);

    const butter = await executeShisoTool({ tool: 'search_usda_foods', query: 'unsalted butter', limit: 10 }, ctx);
    expect(butter.ok).toBe(true);
    if (butter.ok) {
      const descriptions = (butter.data['results'] as Array<Record<string, unknown>>).map((entry) => String(entry['description']));
      expect(descriptions).toContain('Butter, without salt');
      expect(descriptions.some((description) => /sunflower/i.test(description))).toBe(false);
    }

    const monterey = await executeShisoTool({ tool: 'search_usda_foods', query: 'Monterey Jack', limit: 10 }, ctx);
    expect(monterey.ok).toBe(true);
    if (monterey.ok) {
      const descriptions = (monterey.data['results'] as Array<Record<string, unknown>>).map((entry) => String(entry['description']));
      expect(descriptions.some((description) => /monterey jack/i.test(description))).toBe(true);
      expect(descriptions.some((description) => /mackerel/i.test(description))).toBe(false);
    }

    const vegetables = await executeShisoTool({ tool: 'search_usda_foods', query: 'chopped vegetables', limit: 10 }, ctx);
    expect(vegetables.ok).toBe(true);
    if (vegetables.ok) {
      const descriptions = (vegetables.data['results'] as Array<Record<string, unknown>>).map((entry) => String(entry['description']));
      expect(descriptions).toEqual(expect.arrayContaining(['Raw vegetable, NFS']));
      expect(descriptions.some((description) => /beef|noodle|curry/i.test(description))).toBe(false);
    }

    const pecans = await executeShisoTool({ tool: 'search_usda_foods', query: 'toasted pecans', limit: 10 }, ctx);
    expect(pecans.ok).toBe(true);
    if (pecans.ok) {
      const descriptions = (pecans.data['results'] as Array<Record<string, unknown>>).map((entry) => String(entry['description']));
      expect(descriptions).toEqual(expect.arrayContaining(['Nuts, pecans']));
    }
  });

  it('pages complete recipe instructions with explicit completeness metadata', async () => {
    const instructions = Array.from({ length: 23 }, (_, index) => ({ text: `Step ${index + 1}`, step_ref: `step:${index}` }));
    const ctx = {
      session: null,
      recipe: { title: 'Paged Recipe', servings: 4, ingredients: [], instructions },
      nutrition: null,
    } as unknown as ShisoToolContext;
    const first = await executeShisoTool({ tool: 'get_current_recipe', instruction_offset: 0, instruction_limit: 10 }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data['instructions_total']).toBe(23);
    expect(first.data['instructions_offset']).toBe(0);
    expect(first.data['instructions_returned']).toBe(10);
    expect(first.data['instructions_complete']).toBe(false);
    expect(first.data['next_instruction_offset']).toBe(10);

    const third = await executeShisoTool({ tool: 'get_current_recipe', instruction_offset: 20, instruction_limit: 10 }, ctx);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.data['instructions_returned']).toBe(3);
    expect(third.data['instructions_complete']).toBe(true);
    expect(third.data['next_instruction_offset']).toBeNull();
  });
});

import { createShisoNutritionReviewController } from '../../src/application/shisoNutritionReview';
import { toShisoRecipeView } from '../../src/application-ui/useShisoRecipeContext';
import type { ObsidianRecipe } from '../../src/types';

describe('SHISO Phase 1 unresolved-line investigation', () => {
  it('returns culinary choices, compatible candidates and actionable source selections', async () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 11, dataType: 'sr_legacy', description: 'Butter, without salt', portions: [{ amount: 1, measure: 'tsp', gram_weight: 4.7, sequence: 1 }] },
      { fdcId: 12, dataType: 'sr_legacy', description: 'Cheese, cheddar', portions: [{ amount: 1, measure: 'cup', gram_weight: 105, sequence: 1 }] },
      { fdcId: 13, dataType: 'sr_legacy', description: 'Tortilla, flour', portions: [{ amount: 1, measure: 'tortilla', gram_weight: 45, sequence: 1 }] },
      { fdcId: 14, dataType: 'sr_legacy', description: 'Sausage, turkey, breakfast links, mild, raw', portions: [{ amount: 1, measure: 'link', gram_weight: 28, sequence: 1 }] },
      { fdcId: 15, dataType: 'sr_legacy', description: 'Salt, table', portions: [{ amount: 1, measure: 'tsp', gram_weight: 6, sequence: 1 }] },
      { fdcId: 16, dataType: 'sr_legacy', description: 'Raw vegetable, NFS', portions: [{ amount: 1, measure: 'cup', gram_weight: 120, sequence: 1 }] },
      { fdcId: 17, dataType: 'sr_legacy', description: 'Egg, whole, raw', portions: [{ amount: 1, measure: 'egg', gram_weight: 50, sequence: 1 }] },
      { fdcId: 18, dataType: 'sr_legacy', description: 'Milk, whole', portions: [{ amount: 1, measure: 'cup', gram_weight: 244, sequence: 1 }] },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('fixture session failed');
    const recipe = {
      id: 'breakfast-burritos-phase1',
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
      ingredients: [
        { original: '2 cups chopped vegetables (such as red onion, bell pepper, mushrooms or broccoli)', name: 'chopped vegetables', amount: 2, unit: 'cups' },
        { original: '1 pound breakfast sausage or Italian sausage', name: 'breakfast sausage', amount: 1, unit: 'pound' },
        { original: '2 pinches salt', name: 'salt', amount: 2, unit: 'pinches' },
        { original: '2 teaspoons unsalted butter', name: 'unsalted butter', amount: 2, unit: 'teaspoons' },
        { original: '8 burrito-size tortillas', name: 'burrito-size tortillas', amount: 8 },
        { original: '2 cups shredded cheddar cheese (or Monterey Jack)', name: 'cheddar cheese', amount: 2, unit: 'cups' },
        { original: '8 large eggs', name: 'eggs', amount: 8 },
        { original: '1 cup milk', name: 'milk', amount: 1, unit: 'cup' },
      ],
      instructions: [{ text: 'Cook the filling.' }, { text: 'Fill and roll the tortillas.' }],
      callouts: [],
      dataviewFields: {},
      wikilinks: [],
      frontmatter: {},
    } as unknown as ObsidianRecipe;
    const view = toShisoRecipeView(recipe);
    if (view === null) throw new Error('recipe view failed');
    const controller = createShisoNutritionReviewController(recipe, created.session);
    if (controller === null) throw new Error('review controller failed');
    const snapshot = controller.getSnapshot();
    if (snapshot === null) throw new Error('review snapshot failed');
    const ctx = {
      session: created.session,
      recipe: view,
      nutrition: snapshot,
    } as unknown as ShisoToolContext;
    const result = await executeShisoTool({ tool: 'investigate_unresolved_ingredients' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.data['lines'] as Array<Record<string, unknown>>;
    const cheese = lines.find((line) => String(line['label']).includes('cheddar cheese'));
    expect(cheese).toBeDefined();
    const cheeseCulinary = cheese?.['culinary'] as Record<string, unknown>;
    expect(cheeseCulinary?.['identity']).toBe('cheddar cheese');
    expect(cheeseCulinary?.['next_action']).toMatchObject({ kind: 'select_source', fdc_id: 12 });
    const cheeseCandidates = cheeseCulinary?.['compatible_candidates'] as Array<Record<string, unknown>>;
    expect(cheeseCandidates.some((candidate) => String(candidate['description']).includes('Cheese, cheddar'))).toBe(true);

    const vegetables = lines.find((line) => String(line['label']).includes('chopped vegetables'));
    expect(vegetables?.['culinary']).toMatchObject({ flexible_mixture: true, choice_required: true });
    expect((vegetables?.['culinary'] as Record<string, unknown>)?.['next_action']).toMatchObject({ kind: 'composition_choice' });

    const sausage = lines.find((line) => String(line['label']).includes('breakfast sausage'));
    expect(sausage?.['culinary']).toMatchObject({ equal_choice: true, choice_required: true });
    expect((sausage?.['culinary'] as Record<string, unknown>)?.['next_action']).toMatchObject({ kind: 'ingredient_choice' });

    const salt = lines.find((line) => String(line['label']).includes('pinches salt'));
    expect((salt?.['culinary'] as Record<string, unknown>)?.['next_action']).toMatchObject({ kind: 'needs_measurement' });

    const pending = result.data['pending_user_choices'] as Array<Record<string, unknown>>;
    expect(pending.map((entry) => entry['kind'])).toEqual(expect.arrayContaining(['composition', 'ingredient', 'measurement']));
    expect(String(result.data['consolidated_question'])).toMatch(/which|what measured/i);
  });
});

import { initialShisoConversation, runShisoConversationTurn } from '../../src/application/shisoConversation';

describe('SHISO Phase 1 identity-first completion', () => {
  it('selects unambiguous sources and returns one consolidated choice set', async () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 21, dataType: 'sr_legacy', description: 'Butter, without salt', portions: [{ amount: 1, measure: 'tsp', gram_weight: 4.7, sequence: 1 }] },
      { fdcId: 22, dataType: 'sr_legacy', description: 'Cheese, cheddar', portions: [{ amount: 1, measure: 'cup', gram_weight: 105, sequence: 1 }] },
      { fdcId: 23, dataType: 'sr_legacy', description: 'Tortilla, flour', portions: [{ amount: 1, measure: 'tortilla', gram_weight: 45, sequence: 1 }] },
      { fdcId: 24, dataType: 'sr_legacy', description: 'Salt, table', portions: [{ amount: 1, measure: 'tsp', gram_weight: 6, sequence: 1 }] },
      { fdcId: 25, dataType: 'sr_legacy', description: 'Raw vegetable, NFS', portions: [{ amount: 1, measure: 'cup', gram_weight: 120, sequence: 1 }] },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('fixture session failed');
    const recipe = {
      id: 'identity-first', fileName: 'Identity First.md', filePath: 'Recipes/Identity First.md', rawMarkdown: '',
      title: 'Identity First', tags: ['food/recipes'], category: 'Breakfast', cuisine: 'Test', difficulty: 'Easy', rating: 0, servings: 4,
      ingredients: [
        { original: '2 cups chopped vegetables (such as red onion, bell pepper, mushrooms or broccoli)', name: 'chopped vegetables', amount: 2, unit: 'cups' },
        { original: '2 pinches salt', name: 'salt', amount: 2, unit: 'pinches' },
        { original: '2 teaspoons unsalted butter', name: 'unsalted butter', amount: 2, unit: 'teaspoons' },
        { original: '8 burrito-size tortillas', name: 'burrito-size tortillas', amount: 8 },
        { original: '2 cups shredded cheddar cheese (or Monterey Jack)', name: 'cheddar cheese', amount: 2, unit: 'cups' },
      ],
      instructions: [{ text: 'Cook.' }, { text: 'Fill and roll.' }], callouts: [], dataviewFields: {}, wikilinks: [], frontmatter: {},
    } as unknown as ObsidianRecipe;
    const view = toShisoRecipeView(recipe);
    if (view === null) throw new Error('view');
    const controller = createShisoNutritionReviewController(recipe, created.session);
    if (controller === null) throw new Error('controller');
    const snapshot = controller.getSnapshot();
    if (snapshot === null) throw new Error('snapshot');
    const ctx = {
      session: created.session,
      recipe: view,
      nutrition: snapshot,
      runAnalysis: () => controller.analyze(),
      acceptNutritionContributions: () => true,
      applyNutritionSourceSelection: (input: never) => controller.selectUsdaNutritionSource(input),
    } as unknown as ShisoToolContext;
    const outcome = await runShisoConversationTurn({
      network: {
        request: async () => ({ status: 200, ok: true, data: {} }),
        get: async () => ({ status: 200, ok: true, data: {} }),
        post: async () => ({ status: 200, ok: true, data: { ok: true, kind: 'reply', text: 'unused', model_invocations_used: 1, tool_calls_used: 1 } }),
      } as never,
      context: {
        recipe: { title: recipe.title, ingredientCount: recipe.ingredients.length, stepCount: recipe.instructions.length, servings: 4 },
        nutrition: { available: true, summary: 'unresolved', unresolvedCount: 5, needsAmountCount: 1, needsMatchCount: 4, unsavedWorkingReview: true },
        recipeKey: 'identity-first',
        sessionIdentity: 'session-identity-first',
      },
      toolContext: ctx,
    }, initialShisoConversation(), 'SHISO, resolve the remaining nutrition for this recipe.');
    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(expect.arrayContaining(['investigate_unresolved_ingredients', 'select_usda_nutrition_source', 'complete_nutrition']));
    expect(outcome.message).toMatch(/choice|which|measured/i);
    expect(outcome.message).toContain('Cheese, cheddar');
    expect(outcome.toolsUsed).not.toContain('apply_nutrition_review');
    expect(outcome.toolsUsed).not.toContain('save_working_recipe');
  }, 30000);
});
