/**
 * N-1 — ordinary ingredient resolution at the SHISO capability boundary.
 *
 * The pinned USDA bundle is real authenticated fixture data. These tests prove
 * that SHISO discovery uses the same food-identity projection as Phase 4, while
 * the completion fixture proves that grounded research failure does not suppress
 * a separately authorized, validated AI estimate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { createShisoNutritionReviewController } from '../../src/application/shisoNutritionReview';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { AiNutrientContribution } from '../../src/core/nutritionV2/aiContribution';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import type { ObsidianRecipe } from '../../src/types';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_1f3e3068a7ae0702f360d1caae40a628',
);

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const result = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  });
  if (!result.ok) throw new Error('N-1 USDA fixture session failed to load');
  session = result.session;
}, 180000);

function structuredIngredient(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  return {
    original,
    ...(parsed.parsed.amount !== null ? { amount: parsed.parsed.amount } : {}),
    ...(parsed.parsed.raw_unit !== undefined ? { unit: parsed.parsed.raw_unit } : {}),
    name: parsed.parsed.query,
  };
}

describe('N-1 ordinary ingredient resolution', () => {
  it('uses food identity rather than preparation wording for SHISO USDA discovery', async () => {
    const ctx = { session, recipe: null, nutrition: null } as unknown as ShisoToolContext;

    const pecans = await executeShisoTool({ tool: 'search_usda_foods', query: 'toasted pecans', limit: 6 }, ctx);
    expect(pecans).toMatchObject({ ok: true, tool: 'search_usda_foods' });
    if (!pecans.ok) return;
    const pecanRows = pecans.data['results'] as Array<Record<string, unknown>>;
    expect(pecanRows.length).toBeGreaterThan(0);
    expect(pecanRows.every((row) => /pecan/i.test(String(row['description'])))).toBe(true);
    expect(pecanRows.some((row) => /cereal|pie/i.test(String(row['description'])))).toBe(false);

    const strawberries = await executeShisoTool({ tool: 'search_usda_foods', query: '3 cups sliced strawberries', limit: 6 }, ctx);
    expect(strawberries).toMatchObject({ ok: true, tool: 'search_usda_foods' });
    if (!strawberries.ok) return;
    const strawberryRows = strawberries.data['results'] as Array<Record<string, unknown>>;
    expect(strawberryRows.length).toBeGreaterThan(0);
    expect(strawberryRows.every((row) => /strawberr/i.test(String(row['description'])))).toBe(true);
    expect(strawberryRows.some((row) => /hemp|barley/i.test(String(row['description'])))).toBe(false);
  });

  it('preserves meaningful parenthetical food identity without promoting preparation prose', () => {
    const record = (name: string): Record<string, unknown> =>
      session.reviewIngredient(name) as unknown as Record<string, unknown>;
    const descriptions = (review: Record<string, unknown>): string[] =>
      Array.isArray(review['candidates'])
        ? (review['candidates'] as Array<Record<string, unknown>>).map((candidate) => String(candidate['description']))
        : [];

    const thigh = record('chicken (thigh)');
    const breast = record('chicken (breast)');
    expect(thigh['query']).toBe('chicken thigh');
    expect(breast['query']).toBe('chicken breast');
    expect(descriptions(thigh).some((description) => /chicken.*thigh|thigh.*chicken/i.test(description))).toBe(true);
    expect(descriptions(breast).some((description) => /chicken.*breast|breast.*chicken/i.test(description))).toBe(true);
    expect(descriptions(thigh)).not.toEqual(descriptions(breast));

    const coconut = record('coconut milk (full fat)');
    expect(coconut['query']).toBe('coconut milk full fat');
    // The pinned bundle has no authoritative full-fat coconut record. Preserve
    // the requested identity and leave it reviewable/unmatched rather than
    // auto-selecting an unrelated full-fat food.
    expect(['review_required', 'unmatched']).toContain(coconut['outcome']);
    expect(coconut['selected_fdc_id']).toBeUndefined();

    const beef = record('beef (80/20)');
    expect(beef['normalized_query']).toBe('beef 80 20');
    expect(descriptions(beef).some((description) => /80%.*20%|80.*20/i.test(description))).toBe(true);

    expect(record('milk (whole)')['query']).toBe('milk whole');
    expect(record('milk (skim)')['query']).toBe('milk skim');
    expect(record('butter (salted)')['query']).toBe('butter salted');
    expect(record('butter (unsalted)')['query']).toBe('butter unsalted');
  });

  it('resolves the authored strawberry and pecan preparation parentheticals with authenticated portions', () => {
    const strawberrySearch = session.searchFoods('strawberries', 20);
    expect(strawberrySearch.ok).toBe(true);
    if (!strawberrySearch.ok) return;
    const strawberryRecord = strawberrySearch.results.find((food) => food.description === 'Strawberries, raw' && food.data_type === 'fndds');
    expect(strawberryRecord).toBeDefined();
    if (strawberryRecord === undefined) return;
    const strawberryPortions = session.reviewPortions(strawberryRecord.fdc_id);
    expect(strawberryPortions.ok).toBe(true);
    if (!strawberryPortions.ok) return;
    const oneCupStrawberries = strawberryPortions.review.candidates.find((candidate) =>
      candidate.kind === 'volume' &&
      candidate.unit === 'cup' &&
      candidate.effective_amount === 1 &&
      candidate.gram_weight === 150
    );
    expect(oneCupStrawberries).toBeDefined();

    const result = adaptRecipe({
      title: 'Strawberry Spinach Salad',
      servings: 2,
      ingredients: [
        structuredIngredient('3 cups strawberries (cleaned and hulled, sliced)'),
        structuredIngredient('1 cup pecans (toasted, some of them chopped)'),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const analysis = analyzeRecipe(session, result.recipe.adapted, result.recipe.base_servings);
    expect(analysis.rows.map((row) => row.status)).toEqual(['matched', 'matched']);
    expect(analysis.rows.map((row) => row.selected_description)).toEqual([
      'Strawberries, raw',
      'Pecans, NFS',
    ]);
    expect(analysis.rows.map((row) => row.auto_portion)).toEqual([true, true]);
    const automaticStrawberryFdcId = analysis.rows[0]?.selected_fdc_id;
    expect(automaticStrawberryFdcId).toEqual(expect.any(Number));
    if (automaticStrawberryFdcId === undefined) return;
    const automaticStrawberryPortions = session.reviewPortions(automaticStrawberryFdcId);
    expect(automaticStrawberryPortions.ok).toBe(true);
    if (!automaticStrawberryPortions.ok) return;
    expect(automaticStrawberryPortions.review.candidates.some((candidate) =>
      candidate.kind === 'volume' && candidate.unit === 'cup' && candidate.descriptor === 'sliced' && candidate.gram_weight > 0
    )).toBe(true);
    expect(analysis.preview?.ingredients.map((entry) => entry.outcome)).toEqual(['calculated', 'calculated']);
    expect(analysis.preview?.ingredients[0]).toMatchObject({
      mass_source: 'source_portion',
    });
    expect(analysis.preview?.ingredients.map((entry) => entry.mass_source)).toEqual([
      'source_portion',
      'source_portion',
    ]);
  });

  it('refreshes completion from the review updated by analysis instead of a stale partial snapshot', async () => {
    const recipe: ObsidianRecipe = {
      id: '15-minute-strawberry-spinach-salad',
      fileName: '15-Minute Strawberry Spinach Salad.md',
      filePath: 'Recipes/15-Minute Strawberry Spinach Salad.md',
      rawMarkdown: '',
      title: '15-Minute Strawberry Spinach Salad',
      tags: ['food/recipes'],
      category: 'Salads & Bowls',
      cuisine: 'American',
      servings: 2,
      difficulty: 'Easy',
      rating: 0,
      ingredients: [
        { original: '3 cups sliced strawberries', amount: 3, unit: 'cups', name: 'sliced strawberries' },
        { original: '1 cup toasted pecans', amount: 1, unit: 'cup', name: 'toasted pecans' },
        { original: '2 cups sliced strawberries', amount: 2, unit: 'cups', name: 'sliced strawberries' },
        { original: '1/2 cup toasted pecans', amount: 0.5, unit: 'cup', name: 'toasted pecans' },
        { original: '1 cup sliced strawberries', amount: 1, unit: 'cup', name: 'sliced strawberries' },
        { original: '1/2 cup toasted pecans', amount: 0.5, unit: 'cup', name: 'toasted pecans' },
        { original: '1 cup sliced strawberries', amount: 1, unit: 'cup', name: 'sliced strawberries' },
      ],
      instructions: [{ stepNumber: 1, text: 'Toss the salad and serve.' }],
      callouts: [],
      dataviewFields: {},
      wikilinks: [],
    };
    const controller = createShisoNutritionReviewController(recipe, session);
    expect(controller).not.toBeNull();
    if (controller === null) return;
    const refreshed = controller.getSnapshot();
    expect(refreshed.rows).toHaveLength(7);
    expect(refreshed.rows.filter((row) => row.status === 'matched')).toHaveLength(7);

    // This is the owner's starting state: a previous review still says that the
    // two strawberry/pecan lines need a match even though a fresh analysis can
    // now bind the authenticated identities and portions.
    const stale = {
      ...refreshed,
      rows: refreshed.rows.map((row, index) => index < 2
        ? { ...row, status: 'needs_match' as const, food_authority: 'none' as const, selected_fdc_id: undefined, selected_description: undefined, resolved_grams: undefined, mass_source: undefined }
        : row),
    };
    let liveNutrition: typeof stale | typeof refreshed = stale;
    const researchNutrition = vi.fn(async () => ({
      ok: false as const,
      code: 'WEB_RESEARCH_UNAVAILABLE',
      message: 'The selected AI provider does not support grounded web research.',
    }));
    const runAiNutrition = vi.fn(async () => ({ ok: false as const, message: 'The selected AI connection is unavailable.' }));
    const result = await executeShisoTool(
      { tool: 'complete_nutrition' },
      {
        session,
        recipe: {
          title: recipe.title,
          servings: recipe.servings ?? null,
          ingredients: recipe.ingredients.map((ingredient, index) => ({
            text: ingredient.original,
            name: ingredient.name,
            amount: ingredient.amount,
            unit: ingredient.unit,
            line_ref: refreshed.rows[index]!.line_ref,
          })),
          instructions: recipe.instructions,
        },
        get nutrition() {
          return liveNutrition;
        },
        runAnalysis: vi.fn(async () => {
          const outcome = controller.analyze();
          liveNutrition = controller.getSnapshot();
          return outcome;
        }),
        researchNutrition,
        runAiNutrition,
        acceptNutritionContributions: vi.fn(() => true),
      } as ShisoToolContext,
    );

    expect(result).toMatchObject({ ok: true, tool: 'complete_nutrition' });
    if (!result.ok) return;
    expect(result.data['accounted']).toBe(7);
    expect(result.data['remaining']).toBe(0);
    expect(result.summary).toContain('7 of 7');
    expect(result.data['breakdown']).toMatchObject({ ai_estimated: 0 });
    expect(researchNutrition).not.toHaveBeenCalled();
    // The source records cover every ingredient line. The pinned USDA fixture
    // still has nutrient-level gaps, so the completion path may ask the
    // independently authorized estimator about those gaps; an unavailable
    // estimator must not turn resolved ingredient identities into unresolved
    // lines or a false success.
    expect(runAiNutrition).toHaveBeenCalledTimes(1);
  });

  it('keeps run analysis, completion, and review coverage on one real tool-path result', async () => {
    const ingredientLines = [
      '3 cups strawberries (cleaned and hulled, sliced)',
      '1 cup pecans (toasted, some of them chopped)',
      '100 g baby spinach',
      '75 g feta cheese',
      '50 g red onion',
      '28 g olive oil',
      '16 g balsamic vinegar',
    ];
    const recipe: ObsidianRecipe = {
      id: '15-minute-strawberry-spinach-salad-real-wording',
      fileName: '15-Minute Strawberry Spinach Salad.md',
      filePath: 'Recipes/15-Minute Strawberry Spinach Salad.md',
      rawMarkdown: '',
      title: '15-Minute Strawberry Spinach Salad',
      tags: ['food/recipes'],
      category: 'Salads & Bowls',
      cuisine: 'American',
      servings: 2,
      difficulty: 'Easy',
      rating: 0,
      ingredients: ingredientLines.map(structuredIngredient) as unknown as ObsidianRecipe['ingredients'],
      instructions: [{ stepNumber: 1, text: 'Toss the salad and serve.' }],
      callouts: [],
      dataviewFields: {},
      wikilinks: [],
    };
    const controller = createShisoNutritionReviewController(recipe, session);
    expect(controller).not.toBeNull();
    if (controller === null) return;
    const fresh = controller.getSnapshot();
    expect(fresh).not.toBeNull();
    if (fresh === null) return;

    const stale = {
      ...fresh,
      rows: fresh.rows.map((row, index) => index < 2
        ? {
            ...row,
            status: 'needs_match' as const,
            food_authority: 'none' as const,
            selected_fdc_id: undefined,
            selected_description: undefined,
            resolved_grams: undefined,
            mass_source: undefined,
          }
        : row),
    };
    let liveNutrition: typeof stale | typeof fresh = stale;
    const contextRecipe = {
      title: recipe.title,
      servings: recipe.servings ?? null,
      ingredients: recipe.ingredients.map((ingredient, index) => ({
        text: ingredient.original,
        name: ingredient.name,
        amount: ingredient.amount,
        unit: ingredient.unit,
        line_ref: fresh.rows[index]!.line_ref,
      })),
      instructions: recipe.instructions,
    };
    const runAiNutrition = vi.fn(async () => ({
      ok: false as const,
      message: 'The selected AI connection is unavailable.',
    }));
    const ctx: ShisoToolContext = {
      session,
      recipe: contextRecipe,
      get nutrition() {
        return liveNutrition;
      },
      runAnalysis: vi.fn(async () => {
        const outcome = controller.analyze();
        const next = controller.getSnapshot();
        if (next !== null) liveNutrition = next;
        return outcome;
      }),
      runAiNutrition,
      researchNutrition: vi.fn(async () => ({
        ok: false as const,
        code: 'WEB_RESEARCH_UNAVAILABLE',
        message: 'The selected AI provider does not support grounded web research.',
      })),
      acceptNutritionContributions: vi.fn(() => true),
    };

    const analyzed = await executeShisoTool({ tool: 'run_nutrition_analysis' }, ctx);
    expect(analyzed).toMatchObject({ ok: true, tool: 'run_nutrition_analysis' });
    if (!analyzed.ok) return;
    expect(analyzed.summary).toContain('7 of 7 ingredient lines covered');
    expect(analyzed.summary).toContain('0 still require attention');
    // USDA-backed rows are sufficient here; an unavailable AI connection must
    // not block ordinary offline source resolution or be invoked unnecessarily.
    expect(runAiNutrition).not.toHaveBeenCalled();

    const review = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, ctx);
    expect(review).toMatchObject({ ok: true, tool: 'get_nutrition_review' });
    if (!review.ok) return;
    expect(review.data['resolved']).toBe(7);
    expect(review.data['unresolved_count']).toBe(0);
    const reviewedIngredients = review.data['ingredients'] as Array<Record<string, unknown>>;
    expect(reviewedIngredients[0]).toMatchObject({
      label: ingredientLines[0],
      status: 'source_backed',
      food: 'Strawberries, raw',
      mass_source: 'source_portion',
    });
    expect(reviewedIngredients[1]).toMatchObject({
      label: ingredientLines[1],
      status: 'source_backed',
      food: 'Pecans, NFS',
      mass_source: 'source_portion',
    });

    const completed = await executeShisoTool({ tool: 'complete_nutrition' }, ctx);
    expect(completed).toMatchObject({ ok: true, tool: 'complete_nutrition' });
    if (!completed.ok) return;
    expect(completed.data['accounted']).toBe(7);
    expect(completed.data['remaining']).toBe(0);
    expect(completed.summary).toContain('Nothing was applied or saved');

    const finalReview = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, ctx);
    expect(finalReview).toMatchObject({ ok: true, tool: 'get_nutrition_review' });
    if (finalReview.ok) {
      expect(finalReview.data['resolved']).toBe(7);
      expect(finalReview.data['unresolved_count']).toBe(0);
    }
  });
});

describe('N-1 separate research and estimation capabilities', () => {
  it('continues to an authorized AI estimate when grounded research is unavailable', async () => {
    const lineRef = 'salad:strawberries';
    const text = '3 cups sliced strawberries';
    const contribution: AiNutrientContribution = {
      line_ref: lineRef,
      ingredient: text,
      quantity_basis: 'Estimated edible weight for the authored sliced fruit volume.',
      weight_grams: 498,
      disposition: 'edible',
      exclusion_role: 'none',
      exclusion_assumption: '',
      classification: 'ai_estimate',
      nutrients: { calories: { amount: 159, unit: 'kcal' } },
      unknown_nutrients: ['protein', 'sodium'],
      assumptions: ['Household volume converted to an estimated edible weight; not USDA-authenticated.'],
      confidence: 'medium',
      sources: [],
    };
    const accepted: AiNutrientContribution[][] = [];
    const row = {
      line_ref: lineRef,
      original_text: text,
      status: 'needs_match',
      food_authority: 'none',
      resolved_grams: undefined,
      mass_source: undefined,
    } as unknown as LiveRowState;
    const researchNutrition = vi.fn(async () => ({
      ok: false,
      code: 'WEB_RESEARCH_UNAVAILABLE',
      message: 'The selected AI provider does not support grounded web research.',
    }));
    const runAiNutrition = vi.fn(async () => ({ ok: true, contributions: [contribution] }));
    const ctx: ShisoToolContext = {
      session: {} as never,
      recipe: {
        title: 'Strawberry Spinach Salad',
        servings: 2,
        ingredients: [{ text, name: 'sliced strawberries', line_ref: lineRef }],
        instructions: [],
      },
      nutrition: {
        rows: [row],
        aiContributions: [],
        summary: null,
        unsaved: true,
      },
      runAnalysis: vi.fn(async () => ({
        ok: true,
        analyzed: true,
        summary: 'one unresolved line',
        matched: 0,
        needs_amount: 0,
        needs_match: 1,
        total_lines: 1,
        unresolved_line_refs: [lineRef],
        preview_state: 'partial' as const,
      })),
      researchNutrition,
      runAiNutrition,
      acceptNutritionContributions: vi.fn((contributions) => {
        accepted.push([...contributions]);
        return true;
      }),
    };

    const result = await executeShisoTool({ tool: 'complete_nutrition' }, ctx);
    expect(result).toMatchObject({ ok: true, tool: 'complete_nutrition' });
    expect(researchNutrition).toHaveBeenCalledTimes(1);
    const researchCall = researchNutrition.mock.calls[0] as unknown as
      | readonly [{ readonly targets: ReadonlyArray<Record<string, unknown>> }]
      | undefined;
    const researchArgs = researchCall?.[0];
    expect(researchArgs).toBeDefined();
    if (researchArgs === undefined) return;
    expect(researchArgs.targets[0]).toMatchObject({
      line_ref: lineRef,
      query: 'strawberries',
      amount: 3,
      unit: 'cups',
      measurement_kind: 'volume',
    });
    expect(runAiNutrition).toHaveBeenCalledTimes(1);
    expect(accepted[0]).toHaveLength(1);
    expect(accepted[0]?.[0]).toMatchObject({
      classification: 'ai_estimate',
      line_ref: lineRef,
      weight_grams: 498,
      sources: [],
    });
    expect(result.ok && result.data['breakdown']).toMatchObject({ ai_estimated: 1 });
    if (result.ok) expect(result.summary).toContain('Nothing was applied or saved');
  });
});
