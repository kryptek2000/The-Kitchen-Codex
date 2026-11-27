import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { createShisoNutritionReviewController } from '../../src/application/shisoNutritionReview';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { initialShisoConversation, runShisoConversationTurn } from '../../src/application/shisoConversation';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda',
  USDA_BUNDLE_RELEASE_LOCK.bundle_release,
);

async function makeSession() {
  const result = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  } as never);
  if (!result.ok) throw new Error('USDA fixture did not load');
  return result.session;
}

function honeyPortion(session: Awaited<ReturnType<typeof makeSession>>) {
  const portions = session.reviewPortions(169640);
  if (!portions.ok) throw new Error('Honey portions missing from fixture');
  const portion = portions.review.candidates.find((candidate) =>
    candidate.kind === 'volume' && /cup/i.test(candidate.display_label) && candidate.gram_weight === 339,
  );
  if (!portion) throw new Error('Authenticated 1 cup honey portion missing from fixture');
  return portion;
}

function recipe(text: string) {
  return {
    title: 'SHISO agent selection fixture',
    servings: 4,
    ingredients: [{ text, name: 'honey', amount: 0.25, unit: 'cup', line_ref: '' }],
    instructions: [],
  };
}

describe('SHISO authenticated nutrition source selection', () => {
  it('promotes the inspected honey record and authenticated cup portion into the working review', async () => {
    const session = await makeSession();
    const sourceRecipe = recipe('1/4 cup honey (or brown sugar)');
    const controllerRecipe = {
      title: sourceRecipe.title,
      servings: sourceRecipe.servings,
      ingredients: [{ original: sourceRecipe.ingredients[0].text, name: 'honey', amount: 0.25, unit: 'cup' }],
      instructions: [],
    };
    const controller = createShisoNutritionReviewController(controllerRecipe as never, session);
    if (!controller) throw new Error('review controller unavailable');
    const lineRef = controller.getSnapshot()!.rows[0]!.line_ref;
    const portion = honeyPortion(session);
    const ctx: ShisoToolContext = {
      session,
      recipe: { ...sourceRecipe, ingredients: [{ ...sourceRecipe.ingredients[0], line_ref: lineRef }] },
      nutrition: controller.getSnapshot()!,
      applyNutritionSourceSelection: (input) => Promise.resolve(controller.selectUsdaNutritionSource(input)),
    };

    const result = await executeShisoTool({
      tool: 'select_usda_nutrition_source',
      line_ref: lineRef,
      fdc_id: 169640,
      portion_index: portion.index,
    }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data['fdc_id']).toBe(169640);
    expect(result.data['resolved_grams']).toBeCloseTo(84.75, 8);
    expect(String(result.data['description'])).toMatch(/honey/i);
    const state = controller.getState();
    const evidence = state.preview?.ingredients.find((entry) => entry.line_ref === lineRef);
    expect(evidence?.match_status).toBe('assistant_user_directed');
    expect(evidence?.user_confirmed).toBe(false);
    expect(evidence?.selection_origin).toBe('shiso_user_directed');
    expect(evidence?.resolved_grams).toBeCloseTo(84.75, 8);
  }, 30000);

  it('refuses equal alternatives until the trusted user message names the selected branch', async () => {
    const session = await makeSession();
    const sourceRecipe = recipe('1/4 cup honey or brown sugar');
    const controllerRecipe = {
      title: sourceRecipe.title,
      servings: sourceRecipe.servings,
      ingredients: [{ original: sourceRecipe.ingredients[0].text, name: 'honey', amount: 0.25, unit: 'cup' }],
      instructions: [],
    };
    const controller = createShisoNutritionReviewController(controllerRecipe as never, session);
    if (!controller) throw new Error('review controller unavailable');
    const lineRef = controller.getSnapshot()!.rows[0]!.line_ref;
    const portion = honeyPortion(session);
    const base: Omit<ShisoToolContext, 'isTrustedNutritionSourceSelection'> = {
      session,
      recipe: { ...sourceRecipe, ingredients: [{ ...sourceRecipe.ingredients[0], line_ref: lineRef }] },
      nutrition: controller.getSnapshot()!,
      applyNutritionSourceSelection: (input) => Promise.resolve(controller.selectUsdaNutritionSource(input)),
    };
    const refused = await executeShisoTool({
      tool: 'select_usda_nutrition_source', line_ref: lineRef, fdc_id: 169640, portion_index: portion.index,
    }, base);
    expect(refused.ok).toBe(false);
    if (refused.ok === false) expect(refused.code).toBe('explicit_choice_required');

    const trusted = await executeShisoTool({
      tool: 'select_usda_nutrition_source', line_ref: lineRef, fdc_id: 169640, portion_index: portion.index,
    }, { ...base, isTrustedNutritionSourceSelection: (_ref, description) => /honey/i.test(description) });
    expect(trusted.ok).toBe(true);
    if (trusted.ok) expect(trusted.data['resolved_grams']).toBeCloseTo(84.75, 8);
  }, 30000);

  it('executes an explicit branch choice before asking the model for another step', async () => {
    const session = await makeSession();
    const sourceRecipe = recipe('1/4 cup honey (or brown sugar)');
    const controller = createShisoNutritionReviewController({
      title: sourceRecipe.title,
      servings: sourceRecipe.servings,
      ingredients: [{ original: sourceRecipe.ingredients[0].text, name: 'honey', amount: 0.25, unit: 'cup' }],
      instructions: [],
    } as never, session);
    if (!controller) throw new Error('review controller unavailable');
    const lineRef = controller.getSnapshot()!.rows[0]!.line_ref;
    const contextRecipe = {
      title: sourceRecipe.title,
      servings: 4,
      ingredients: [{ ...sourceRecipe.ingredients[0], line_ref: lineRef }],
      instructions: [],
    };
    const toolContext: ShisoToolContext = {
      session,
      recipe: contextRecipe,
      nutrition: controller.getSnapshot()!,
      applyNutritionSourceSelection: (input) => Promise.resolve(controller.selectUsdaNutritionSource(input)),
    };
    const network = {
      request: async () => ({ status: 200, ok: true, data: {} }),
      get: async () => ({ status: 200, ok: true, data: {} }),
      post: async () => ({
        status: 200,
        ok: true,
        data: {
          ok: true,
          kind: 'reply',
          text: 'Honey was selected through the authenticated USDA review.',
          model_invocations_used: 1,
          tool_calls_used: 1,
        },
      }),
    } as never;

    const outcome = await runShisoConversationTurn(
      {
        network,
        context: {
          recipe: { title: sourceRecipe.title, ingredientCount: 1, stepCount: 0, servings: 4 },
          nutrition: { available: true, summary: '1 of 1 unresolved', unresolvedCount: 1, needsAmountCount: 0, needsMatchCount: 1, unsavedWorkingReview: true },
          recipeKey: 'selection-fixture',
          sessionIdentity: 'session-fixture',
        },
        toolContext,
      },
      initialShisoConversation(),
      'pick the honey and fix it',
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(['select_usda_nutrition_source']);
    expect(outcome.message).toContain('Verified Honey');
    const evidence = controller.getState().preview?.ingredients[0];
    expect(evidence).toMatchObject({
      fdc_id: 169640,
      match_status: 'assistant_user_directed',
      resolved_grams: 84.75,
    });
  }, 30000);
});
