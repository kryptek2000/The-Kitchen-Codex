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
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { AiNutrientContribution } from '../../src/core/nutritionV2/aiContribution';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';

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

  it('resolves sliced strawberries and toasted pecans with authenticated household portions', () => {
    const result = adaptRecipe({
      title: 'Strawberry Spinach Salad',
      servings: 2,
      ingredients: [
        structuredIngredient('3 cups sliced strawberries'),
        structuredIngredient('1 cup toasted pecans'),
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
    expect(analysis.preview?.ingredients.map((entry) => entry.outcome)).toEqual(['calculated', 'calculated']);
    expect(analysis.preview?.ingredients.map((entry) => entry.mass_source)).toEqual([
      'source_portion',
      'source_portion',
    ]);
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
