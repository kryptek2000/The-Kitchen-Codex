/**
 * SINC-3 — SHISO autonomous nutrition completion.
 *
 * The owner's explicit "resolve the last two ingredients" command is routed to
 * the real `complete_nutrition` capability, which runs the source-first pipeline
 * through the application's existing ports:
 *
 *   deterministic generic USDA -> USDA Branded -> external research -> AI estimate
 *
 * These tests use deterministic synthetic branded/research/provider responses.
 * They prove orchestration and provenance handling, NOT a live USDA or provider
 * success.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { initialShisoConversation, runShisoConversationTurn } from '../../src/application/shisoConversation';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import { validateAiNutrientContributions, type AiNutrientContribution } from '../../src/core/nutritionV2/aiContribution';
import { brandedReviewIdentity } from '../../src/core/nutritionV2/brandedEvidenceTrust';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import type { ShisoNutrientCoverageEntry } from '../../src/core/shiso/nutritionCoverage';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import {
  adaptUsdaBrandedFoodRecord,
  type UsdaBrandedFoodCandidate,
} from '../../src/core/nutritionV2/brandedFoods';
import {
  MOCK_BRANDED_GOCHUJANG_FDC_ID,
  MOCK_BRANDED_RICE_VINEGAR_FDC_ID,
  mockBrandedDetail,
} from '../fixtures/usdaBrandedFixtures';

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => null });
});

const OWNER_LINES: ReadonlyArray<string> = [
  '680 g raw boneless skinless chicken thighs',
  '1 tbsp olive oil',
  '1 medium yellow onion (150 g)',
  '3 garlic cloves',
  '1 tbsp minced fresh ginger',
  '1 red bell pepper (150 g)',
  '1 medium carrot (70 g)',
  '100 g broccoli florets',
  '100 g sugar snap peas',
  '100 g cremini mushrooms',
  '2 tbsp gochujang (Korean chili paste)',
  '2 tbsp reduced-sodium soy sauce',
  '1 tbsp rice vinegar',
  '1 tbsp honey',
  '1 tsp toasted sesame oil',
  '200 g dry jasmine rice',
  '1 tbsp sesame seeds',
  '2 scallions (30 g)',
];

const GOCHUJANG_INDEX = 10;
const VINEGAR_INDEX = 12;
const GOCHUJANG_REF = 'ing:gochujang';
const VINEGAR_REF = 'ing:rice-vinegar';
const RECIPE_DIGEST = `sha256:${'a'.repeat(64)}`;
const REVIEW_IDENTITY = brandedReviewIdentity('session-sinc3', 'gochujang-bowls', 4);

function refFor(index: number): string {
  if (index === GOCHUJANG_INDEX) return GOCHUJANG_REF;
  if (index === VINEGAR_INDEX) return VINEGAR_REF;
  return `ing:${index}`;
}

function ingredientContext() {
  return OWNER_LINES.map((text, index) => {
    const parsed = parseIngredient(text);
    return {
      text,
      name: parsed.ok ? parsed.parsed.query : text,
      line_ref: refFor(index),
    };
  });
}

function ownerRows(): LiveRowState[] {
  return OWNER_LINES.map((text, index) => {
    const unresolved = index === GOCHUJANG_INDEX || index === VINEGAR_INDEX;
    return {
      line_ref: refFor(index),
      original_text: text,
      status: unresolved ? 'needs_match' : 'matched',
      food_authority: unresolved ? 'none' : 'automatic',
      selected_fdc_id: unresolved ? undefined : 6000 + index,
      selected_description: unresolved ? undefined : `USDA food ${index}`,
      resolved_grams: unresolved ? undefined : 50,
      mass_source: unresolved ? undefined : 'source_portion',
      portion_index: unresolved ? undefined : 0,
      user_mass_quantity: undefined,
      user_mass_unit: undefined,
      source_portion_automatic: !unresolved,
      household_unit: undefined,
      household_size_class: undefined,
      household_requires_state: undefined,
      household_authority_class: undefined,
    } as unknown as LiveRowState;
  });
}

function brandedCandidate(fdcId: number, query: string): UsdaBrandedFoodCandidate {
  const adapted = adaptUsdaBrandedFoodRecord(mockBrandedDetail(fdcId), query);
  if (!adapted.ok) throw new Error('synthetic branded fixture failed');
  return Object.freeze({
    ...adapted.candidate,
    evidence_id: `test-evidence-sinc3-${fdcId}`,
  });
}

function aiContribution(lineRef: string, text: string, calories: number): AiNutrientContribution {
  return Object.freeze({
    line_ref: lineRef,
    ingredient: text,
    quantity_basis: `Estimated from a typical representative product for ${text}`,
    weight_grams: 30,
    disposition: 'edible',
    exclusion_role: 'none',
    exclusion_assumption: '',
    classification: 'ai_estimate',
    nutrients: Object.freeze({ calories: Object.freeze({ amount: calories, unit: 'kcal' as const }) }),
    unknown_nutrients: ['protein', 'sodium'] as const,
    assumptions: Object.freeze(['Typical composition assumed; the recipe does not name a brand.']),
    confidence: 'medium',
    sources: Object.freeze([]),
  });
}

function researchContribution(lineRef: string, text: string, calories: number): AiNutrientContribution {
  return Object.freeze({
    line_ref: lineRef,
    ingredient: text,
    quantity_basis: 'Published manufacturer label scaled deterministically to the authored line.',
    weight_grams: 30,
    disposition: 'edible',
    exclusion_role: 'none',
    exclusion_assumption: '',
    classification: 'source_backed',
    nutrients: Object.freeze({ calories: Object.freeze({ amount: calories, unit: 'kcal' as const }) }),
    unknown_nutrients: ['protein'] as const,
    assumptions: Object.freeze(['Values taken from the cited published nutrition page.']),
    confidence: 'medium',
    sources: Object.freeze([{ title: 'Mock manufacturer nutrition page', url: 'https://example.com/nutrition' }]),
  });
}

function noProviderNetwork(): NetworkAdapter {
  return {
    get: vi.fn(async () => { throw new Error('completion must not call the chat provider'); }),
    post: vi.fn(async () => { throw new Error('completion must not call the chat provider'); }),
    request: vi.fn(async () => { throw new Error('completion must not call the chat provider'); }),
  } as unknown as NetworkAdapter;
}

interface OwnerFixture {
  readonly ctx: ShisoToolContext;
  readonly accepted: AiNutrientContribution[][];
}

function ownerNutrientCoverage(): ShisoNutrientCoverageEntry[] {
  const aiGap = [
    { line_ref: GOCHUJANG_REF, label: OWNER_LINES[GOCHUJANG_INDEX] },
    { line_ref: VINEGAR_REF, label: OWNER_LINES[VINEGAR_INDEX] },
  ];
  const sourceGaps = (count: number) => Array.from({ length: count }, (_, index) => ({
    line_ref: `ing:source-${index}`,
    label: `USDA source line ${index + 1}`,
  }));
  return [
    { id: 'calories', label: 'Calories', unit: 'kcal', status: 'complete' as const, total_amount: 2378.723, ai_estimated_amount: 78, derived_source_subtotal: 2300.723, covered_ingredient_count: 18, measurable_ingredient_count: 18, missing_source_lines: [], missing_ai_lines: [] },
    { id: 'protein', label: 'Protein', unit: 'g', status: 'partial' as const, total_amount: 158.492, ai_estimated_amount: 0, derived_source_subtotal: 158.492, covered_ingredient_count: 16, measurable_ingredient_count: 18, missing_source_lines: [], missing_ai_lines: aiGap },
    { id: 'carbohydrates', label: 'Total carbohydrate', unit: 'g', status: 'complete' as const, total_amount: 248.094, ai_estimated_amount: 15, derived_source_subtotal: 233.094, covered_ingredient_count: 18, measurable_ingredient_count: 18, missing_source_lines: [], missing_ai_lines: [] },
    { id: 'fat', label: 'Total fat', unit: 'g', status: 'complete' as const, total_amount: 80.901, ai_estimated_amount: 0, derived_source_subtotal: 80.901, covered_ingredient_count: 18, measurable_ingredient_count: 18, missing_source_lines: [], missing_ai_lines: [] },
    { id: 'fiber', label: 'Dietary fiber', unit: 'g', status: 'complete' as const, total_amount: 15.811, ai_estimated_amount: 0, derived_source_subtotal: 15.811, covered_ingredient_count: 18, measurable_ingredient_count: 18, missing_source_lines: [], missing_ai_lines: [] },
    { id: 'sodium', label: 'Sodium', unit: 'mg', status: 'partial' as const, total_amount: 2473.924, ai_estimated_amount: 804, derived_source_subtotal: 1669.924, covered_ingredient_count: 16, measurable_ingredient_count: 18, missing_source_lines: [], missing_ai_lines: aiGap },
    { id: 'niacin', label: 'Niacin', unit: 'mg_ne', status: 'partial' as const, total_amount: 20, ai_estimated_amount: 0, derived_source_subtotal: 20, covered_ingredient_count: 12, measurable_ingredient_count: 18, missing_source_lines: sourceGaps(6), missing_ai_lines: [] },
    { id: 'added_sugars', label: 'Added sugars', unit: 'g', status: 'unknown' as const, total_amount: null, ai_estimated_amount: 0, derived_source_subtotal: null, covered_ingredient_count: 0, measurable_ingredient_count: 18, missing_source_lines: sourceGaps(16), missing_ai_lines: [] },
  ];
}

function ownerFixture(overrides: Partial<ShisoToolContext> = {}): OwnerFixture {
  const accepted: AiNutrientContribution[][] = [];
  const ctx: ShisoToolContext = {
    session: {} as never,
    recipe: {
      title: 'Gochujang Chicken Rice Bowls',
      servings: 4,
      ingredients: ingredientContext(),
      instructions: [],
    },
    nutrition: {
      rows: ownerRows(),
      aiContributions: [],
      summary: '16 of 18 ingredient lines resolved.',
      unsaved: true,
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
      nutrientCoverage: ownerNutrientCoverage(),
    },
    runAnalysis: vi.fn(async () => ({
      ok: true,
      analyzed: true,
      summary: '16 of 18 ingredient lines resolved',
      matched: 16,
      needs_amount: 0,
      needs_match: 2,
      total_lines: 18,
      unresolved_line_refs: [GOCHUJANG_REF, VINEGAR_REF],
      preview_state: 'partial' as const,
    })),
    searchBrandedFoods: vi.fn(async ({ lineRef, query }) => {
      if (lineRef === GOCHUJANG_REF) {
        return { ok: true, candidates: [brandedCandidate(MOCK_BRANDED_GOCHUJANG_FDC_ID, query)] };
      }
      if (lineRef === VINEGAR_REF) {
        return { ok: true, candidates: [brandedCandidate(MOCK_BRANDED_RICE_VINEGAR_FDC_ID, query)] };
      }
      return { ok: false, message: 'Unexpected lookup.' };
    }),
    researchNutrition: vi.fn(async ({ targets }) => ({
      ok: true,
      contributions: targets.map((target) =>
        researchContribution(target.line_ref, target.ingredient_text, target.line_ref === GOCHUJANG_REF ? 60 : 0)
      ),
      sources: [{ title: 'Mock manufacturer nutrition page', url: 'https://example.com/nutrition' }],
      skipped: [],
      message: 'External nutrition evidence is ready for review.',
    })),
    runAiNutrition: vi.fn(async () => ({
      ok: true,
      contributions: [
        aiContribution(GOCHUJANG_REF, OWNER_LINES[GOCHUJANG_INDEX], 60),
        aiContribution(VINEGAR_REF, OWNER_LINES[VINEGAR_INDEX], 3),
      ],
    })),
    acceptNutritionContributions: vi.fn((contributions) => {
      accepted.push([...contributions]);
      return true;
    }),
    researchEligibleRefs: [GOCHUJANG_REF, VINEGAR_REF],
    brandedEligibleRefs: [GOCHUJANG_REF, VINEGAR_REF],
    ...overrides,
  };
  return { ctx, accepted };
}

function expectContributionsMatchRecipe(contributions: ReadonlyArray<AiNutrientContribution>): void {
  const checked = validateAiNutrientContributions(contributions, {
    recipe_digest: RECIPE_DIGEST,
    line_refs: OWNER_LINES.map((_line, index) => refFor(index)),
    line_text_by_ref: Object.fromEntries(OWNER_LINES.map((line, index) => [refFor(index), line])),
    requireTrustedBranded: false,
  });
  expect(checked.ok).toBe(true);
}

describe('SINC-3 SHISO complete_nutrition — owner fixture', () => {
  it('resolves the last two ingredients with strong USDA Branded evidence and no AI call', async () => {
    const fixture = ownerFixture();
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, fixture.ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;

    expect(fixture.ctx.searchBrandedFoods).toHaveBeenCalledTimes(2);
    const queriedRefs = (fixture.ctx.searchBrandedFoods as unknown as { mock: { calls: Array<[{ lineRef: string }]> } }).mock.calls
      .map(([args]) => args.lineRef);
    expect(queriedRefs.sort()).toEqual([GOCHUJANG_REF, VINEGAR_REF].sort());
    expect(fixture.ctx.researchNutrition).not.toHaveBeenCalled();
    expect(fixture.ctx.runAiNutrition).not.toHaveBeenCalled();

    expect(fixture.accepted).toHaveLength(1);
    const accepted = fixture.accepted[0]!;
    expect(accepted).toHaveLength(2);
    expect(accepted.every((entry) => entry.source_kind === 'usda_branded' && entry.classification === 'source_backed')).toBe(true);
    expect(accepted.find((entry) => entry.line_ref === GOCHUJANG_REF)?.usda_branded).toMatchObject({
      fdc_id: MOCK_BRANDED_GOCHUJANG_FDC_ID,
      evidence_id: `test-evidence-sinc3-${MOCK_BRANDED_GOCHUJANG_FDC_ID}`,
      target: { amount: 2, unit: 'tbsp', measurement_kind: 'volume' },
    });
    expect(accepted.find((entry) => entry.line_ref === VINEGAR_REF)?.usda_branded).toMatchObject({
      fdc_id: MOCK_BRANDED_RICE_VINEGAR_FDC_ID,
      target: { amount: 1, unit: 'tbsp', measurement_kind: 'volume' },
    });

    expect(observation.data).toMatchObject({
      total_lines: 18,
      accounted: 18,
      remaining: 0,
      initial_unresolved: 2,
      resolved_new: 2,
      breakdown: {
        generic_usda: 16,
        usda_branded: 2,
        external_research: 0,
        ai_estimated: 0,
        partial_known: 2,
      },
      nutrition_status: 'partial',
    });
    expect(observation.summary).toContain('2 of 2 previously unresolved line(s) resolved');
    expect(observation.summary).toContain('2 USDA Branded');
    expect(observation.summary).toContain('Nothing was applied or saved');
  });

  it('does not auto-select a non-strong or unhandleable branded candidate', async () => {
    const gochujang = brandedCandidate(MOCK_BRANDED_GOCHUJANG_FDC_ID, 'gochujang');
    const vinegar = brandedCandidate(MOCK_BRANDED_RICE_VINEGAR_FDC_ID, 'rice vinegar');
    const fixture = ownerFixture({
      searchBrandedFoods: vi.fn(async ({ query }) => ({
        ok: true,
        candidates: query === 'gochujang'
          // Strong, but no server-held evidence handle: not applyable, so skip.
          ? [{ ...gochujang, evidence_id: undefined }]
          // Has a handle, but only a possible identity match: do not overclaim.
          : [{ ...vinegar, match_quality: 'possible' as const }],
      })),
    });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, fixture.ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(fixture.accepted[0]!.some((entry) => entry.source_kind === 'usda_branded')).toBe(false);
    expect(fixture.ctx.researchNutrition).toHaveBeenCalledTimes(1);
    expect(fixture.ctx.runAiNutrition).not.toHaveBeenCalled();
    expect(observation.data).toMatchObject({
      total_lines: 18,
      accounted: 18,
      breakdown: { usda_branded: 0, external_research: 2, ai_estimated: 0 },
    });
  });

  it('falls back to one researched contribution and one AI estimate for the remaining lines', async () => {
    const fixture = ownerFixture({
      searchBrandedFoods: vi.fn(async () => ({ ok: false, code: 'not_configured', message: 'USDA Branded lookup is not configured.' })),
      researchNutrition: vi.fn(async ({ targets }) => ({
        ok: true,
        contributions: [researchContribution(targets[0]!.line_ref, targets[0]!.ingredient_text, 60)],
        sources: [{ title: 'Mock manufacturer nutrition page', url: 'https://example.com/nutrition' }],
        skipped: [{ line_ref: targets[1]!.line_ref, reason: 'no_source' }],
        message: 'One external source was verified.',
      })),
    });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, fixture.ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;

    expect(fixture.ctx.searchBrandedFoods).toHaveBeenCalledTimes(2);
    expect(fixture.ctx.researchNutrition).toHaveBeenCalledTimes(1);
    const researchCall = (fixture.ctx.researchNutrition as unknown as {
      mock: { calls: Array<[{ targets: Array<Record<string, unknown>> }]> };
    }).mock.calls[0]![0];
    expect(researchCall.targets.find((target) => target['line_ref'] === GOCHUJANG_REF)).toMatchObject({
      amount: 2,
      unit: 'tbsp',
      measurement_kind: 'volume',
      ambiguity: 'missing_information',
    });
    expect(fixture.ctx.runAiNutrition).toHaveBeenCalledTimes(1);
    const accepted = fixture.accepted[0]!;
    const researched = accepted.find((entry) => entry.line_ref === GOCHUJANG_REF);
    const estimated = accepted.find((entry) => entry.line_ref === VINEGAR_REF);
    expect(researched).toMatchObject({ classification: 'source_backed' });
    expect(researched?.sources[0]?.url).toBe('https://example.com/nutrition');
    expect(estimated).toMatchObject({ classification: 'ai_estimate', sources: [] });
    expectContributionsMatchRecipe(accepted);
    expect(observation.data).toMatchObject({
      total_lines: 18,
      accounted: 18,
      remaining: 0,
      breakdown: { generic_usda: 16, usda_branded: 0, external_research: 1, ai_estimated: 1 },
    });
  });

  it('falls back to AI estimates for both lines when branded and research are unavailable', async () => {
    const fixture = ownerFixture({
      searchBrandedFoods: vi.fn(async () => ({ ok: false, code: 'auth_failed', message: 'USDA Branded lookup is not authorized.' })),
      researchNutrition: vi.fn(async () => ({ ok: false, code: 'WEB_RESEARCH_UNAVAILABLE', message: 'The selected AI provider does not support grounded web research.' })),
    });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, fixture.ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(fixture.ctx.runAiNutrition).toHaveBeenCalledTimes(1);
    expect(fixture.accepted[0]!.every((entry) => entry.classification === 'ai_estimate')).toBe(true);
    expect(observation.data).toMatchObject({
      total_lines: 18,
      accounted: 18,
      remaining: 0,
      breakdown: { generic_usda: 16, usda_branded: 0, external_research: 0, ai_estimated: 2 },
    });
    expect(observation.summary).toContain('2 AI-estimated');
  });

  it('keeps verified work when the provider fails and supports an estimate continuation', async () => {
    const fixture = ownerFixture({
      searchBrandedFoods: vi.fn(async ({ lineRef, query }) =>
        lineRef === GOCHUJANG_REF
          ? { ok: true, candidates: [brandedCandidate(MOCK_BRANDED_GOCHUJANG_FDC_ID, query)] }
          : { ok: false, code: 'not_configured', message: 'USDA Branded lookup is not configured.' }
      ),
      researchNutrition: vi.fn(async () => ({
        ok: false,
        code: 'WEB_RESEARCH_UNAVAILABLE',
        message: 'The selected AI provider does not support grounded web research.',
      })),
      runAiNutrition: vi.fn(async () => ({ ok: false, message: 'Provider temporarily unavailable.' })),
    });
    const first = await executeShisoTool({ tool: 'complete_nutrition' }, fixture.ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data).toMatchObject({ remaining: 1, resolved_new: 1, breakdown: { usda_branded: 1, ai_estimated: 0 } });
    expect(JSON.stringify(first.data['notes'])).toContain('Provider temporarily unavailable.');
    expect(fixture.accepted[0]!.some((entry) => entry.source_kind === 'usda_branded')).toBe(true);

    // Continuation: the same live review still has one unresolved line.
    const withBranded: ShisoToolContext = {
      ...fixture.ctx,
      nutrition: {
        ...fixture.ctx.nutrition!,
        aiContributions: fixture.accepted[0]!,
      },
      searchBrandedFoods: vi.fn(async () => ({ ok: false, code: 'not_configured', message: 'USDA Branded lookup is not configured.' })),
      runAiNutrition: vi.fn(async () => ({
        ok: true,
        contributions: [aiContribution(VINEGAR_REF, OWNER_LINES[VINEGAR_INDEX], 3)],
      })),
    };
    const outcome = await runShisoConversationTurn({
      network: noProviderNetwork(),
      toolContext: withBranded,
      context: {
        recipe: { title: 'Gochujang Chicken Rice Bowls', servings: 4, ingredientCount: 18, stepCount: 6 },
        nutrition: { available: true, summary: null, unresolvedCount: 1, needsAmountCount: 0, needsMatchCount: 1, unsavedWorkingReview: true },
        recipeKey: 'gochujang-bowls',
        sessionIdentity: 'session-sinc3',
      },
    }, initialShisoConversation(), 'Okay, use an estimate for the remaining ingredient.');
    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(['complete_nutrition']);
    expect(outcome.message).toContain('1 of 1 previously unresolved line(s) resolved');
    expect(withBranded.runAiNutrition).toHaveBeenCalledTimes(1);
  });

  it('does not search source-resolved lines or touch any Apply/Save authority', async () => {
    const applyIngredientEdits = vi.fn(async () => { throw new Error('must not edit'); });
    const saveWorkingRecipe = vi.fn(async () => { throw new Error('must not save'); });
    const fixture = ownerFixture({ applyIngredientEdits, saveWorkingRecipe });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, fixture.ctx);
    expect(observation.ok).toBe(true);
    const calls = (fixture.ctx.searchBrandedFoods as unknown as { mock: { calls: Array<[{ lineRef: string }]> } }).mock.calls;
    expect(calls.map(([args]) => args.lineRef).sort()).toEqual([GOCHUJANG_REF, VINEGAR_REF].sort());
    expect(applyIngredientEdits).not.toHaveBeenCalled();
    expect(saveWorkingRecipe).not.toHaveBeenCalled();
  });

  it('fails closed for a Basic review with no Advanced nutrition state', async () => {
    const fixture = ownerFixture({ nutrition: null, runAnalysis: vi.fn(), runAiNutrition: vi.fn() });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, fixture.ctx);
    expect(observation).toMatchObject({ ok: false, code: 'no_nutrition_review' });
    expect(fixture.ctx.runAnalysis).not.toHaveBeenCalled();
    expect(fixture.ctx.runAiNutrition).not.toHaveBeenCalled();
    expect(fixture.accepted).toHaveLength(0);
  });

  it('rejects a recipe change during branded lookup before accepting anything', async () => {
    const fixture = ownerFixture();
    const mutable = fixture.ctx as unknown as { recipe: ShisoToolContext['recipe'] };
    const original = mutable.recipe;
    const searchBrandedFoods = vi.fn(async () => {
      mutable.recipe = original === null ? null : { ...original, title: 'A different recipe revision' };
      return { ok: true, candidates: [brandedCandidate(MOCK_BRANDED_GOCHUJANG_FDC_ID, 'gochujang')] };
    });
    mutable.recipe = original;
    (fixture.ctx as unknown as { searchBrandedFoods: unknown }).searchBrandedFoods = searchBrandedFoods;
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, fixture.ctx);
    expect(observation).toMatchObject({ ok: false, code: 'stale_recipe' });
    expect(fixture.accepted).toHaveLength(0);
  });
});

describe('SINC-3 end-to-end conversational command', () => {
  it('starts from "resolve the last two ingredients" and prepares both contributions', async () => {
    const fixture = ownerFixture();
    const network = noProviderNetwork();
    const outcome = await runShisoConversationTurn({
      network,
      toolContext: fixture.ctx,
      context: {
        recipe: { title: 'Gochujang Chicken Rice Bowls', servings: 4, ingredientCount: 18, stepCount: 6 },
        nutrition: { available: true, summary: null, unresolvedCount: 2, needsAmountCount: 0, needsMatchCount: 2, unsavedWorkingReview: true },
        recipeKey: 'gochujang-bowls',
        sessionIdentity: 'session-sinc3',
      },
    }, initialShisoConversation(), 'Shiso, resolve the last two ingredients.');

    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(['complete_nutrition']);
    expect(outcome.message).toContain('2 of 2 previously unresolved line(s) resolved');
    expect(outcome.message).toContain('18 of 18 ingredient lines covered');
    expect(outcome.message).toContain('2 USDA Branded');
    expect(outcome.message).toContain('Nothing was applied or saved');
    expect(fixture.ctx.runAnalysis).toHaveBeenCalledTimes(1);
    expect(fixture.ctx.searchBrandedFoods).toHaveBeenCalledTimes(2);
    expect(fixture.ctx.runAiNutrition).not.toHaveBeenCalled();
    expect(fixture.accepted[0]).toHaveLength(2);
    expect(fixture.accepted[0]!.every((entry) => entry.source_kind === 'usda_branded')).toBe(true);
    expect(network.post).not.toHaveBeenCalled();
  });

  it('executes a model-requested complete_nutrition tool call', async () => {
    const fixture = ownerFixture();
    const replies = [
      {
        ok: true,
        kind: 'tool_request',
        tool: 'complete_nutrition',
        args: { tool: 'complete_nutrition' },
        model_invocations_used: 1,
        tool_calls_used: 0,
      },
      {
        ok: true,
        kind: 'reply',
        text: 'Prepared the completion in the unsaved review.',
        proposals: [],
        model_invocations_used: 2,
        tool_calls_used: 1,
      },
    ];
    const network = {
      get: vi.fn(async () => { throw new Error('unexpected network'); }),
      request: vi.fn(async () => { throw new Error('unexpected network'); }),
      post: vi.fn(async () => ({ ok: true, status: 200, data: replies.shift() })),
    } as unknown as NetworkAdapter;
    const outcome = await runShisoConversationTurn({
      network,
      toolContext: fixture.ctx,
      context: {
        recipe: { title: 'Gochujang Chicken Rice Bowls', servings: 4, ingredientCount: 18, stepCount: 6 },
        nutrition: { available: true, summary: null, unresolvedCount: 2, needsAmountCount: 0, needsMatchCount: 2, unsavedWorkingReview: true },
        recipeKey: 'gochujang-bowls',
        sessionIdentity: 'session-sinc3',
      },
    }, initialShisoConversation(), 'What should we do about the nutrition gaps?');
    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(['complete_nutrition']);
    expect(outcome.message).toContain('Prepared the completion');
    expect(fixture.ctx.runAnalysis).toHaveBeenCalledTimes(1);
    expect(fixture.ctx.searchBrandedFoods).toHaveBeenCalledTimes(2);
    expect(fixture.accepted[0]).toHaveLength(2);
  });

  it.each([
    'Finish the nutrition.',
    'Estimate whatever is missing.',
    'Find nutrition for these unresolved foods.',
    "Complete my recipe's nutrition.",
    'Figure out the missing ingredient amounts.',
  ])('recognizes "%s" as a completion action', async (message) => {
    const fixture = ownerFixture();
    const outcome = await runShisoConversationTurn({
      network: noProviderNetwork(),
      toolContext: fixture.ctx,
      context: {
        recipe: { title: 'Gochujang Chicken Rice Bowls', servings: 4, ingredientCount: 18, stepCount: 6 },
        nutrition: { available: true, summary: null, unresolvedCount: 2, needsAmountCount: 0, needsMatchCount: 2, unsavedWorkingReview: true },
        recipeKey: 'gochujang-bowls',
        sessionIdentity: 'session-sinc3',
      },
    }, initialShisoConversation(), message);
    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(['complete_nutrition']);
    expect(fixture.ctx.runAnalysis).toHaveBeenCalledTimes(1);
    expect(fixture.accepted[0]).toHaveLength(2);
  });
});
async function resolveToPartialAi() {
  const fixture = ownerFixture({
    searchBrandedFoods: vi.fn(async () => ({ ok: false, code: 'not_configured', message: 'USDA Branded lookup is not configured.' })),
    researchNutrition: vi.fn(async () => ({ ok: false, message: 'External nutrition research is unavailable.' })),
  });
  const outcome = await runShisoConversationTurn({
    network: noProviderNetwork(),
    toolContext: fixture.ctx,
    context: {
      recipe: { title: 'Gochujang Chicken Rice Bowls', servings: 4, ingredientCount: 18, stepCount: 6 },
      nutrition: { available: true, summary: null, unresolvedCount: 2, needsAmountCount: 0, needsMatchCount: 2, unsavedWorkingReview: true },
      recipeKey: 'gochujang-bowls',
      sessionIdentity: 'session-sinc3',
    },
  }, initialShisoConversation(), 'Resolve the last two ingredients.');
  if (!outcome.ok) throw new Error(`initial completion failed: ${outcome.status}`);
  const accepted = fixture.accepted[0];
  if (!accepted) throw new Error('initial completion accepted nothing');
  return { outcome, partials: accepted };
}

function gapFixture(
  partials: ReadonlyArray<AiNutrientContribution>,
  gapContributions: ReadonlyArray<AiNutrientContribution>,
  research?: ShisoToolContext['researchNutrition'],
) {
  const base = ownerFixture();
  const accepted: AiNutrientContribution[][] = [];
  const runAnalysis = vi.fn(async () => {
    throw new Error('nutrient-gap pass must not rerun the source analysis');
  });
  const runAiNutrition = vi.fn(async (_signal?: AbortSignal, options?: { apply?: boolean; nutrientGapFocus?: ReadonlyArray<{ line_ref: string; unknown_nutrients: readonly string[] }> }) => {
    expect(options?.apply).toBe(false);
    expect(options?.nutrientGapFocus?.length).toBeGreaterThan(0);
    return { ok: true, contributions: gapContributions };
  });
  const ctx: ShisoToolContext = {
    ...base.ctx,
    nutrition: { ...base.ctx.nutrition!, aiContributions: partials },
    searchBrandedFoods: undefined,
    researchNutrition: research,
    runAnalysis,
    runAiNutrition,
    acceptNutritionContributions: vi.fn((contributions) => {
      accepted.push([...contributions]);
      return true;
    }),
  };
  return { ctx, accepted, runAnalysis, runAiNutrition, base };
}

function gapAiContribution(lineRef: string, text: string, nutrients: Record<string, { amount: number; unit: string }>): AiNutrientContribution {
  return Object.freeze({
    line_ref: lineRef,
    ingredient: text,
    quantity_basis: `Focused nutrient-gap estimate for ${text}`,
    weight_grams: lineRef === GOCHUJANG_REF ? 36 : 15,
    disposition: 'edible',
    exclusion_role: 'none',
    exclusion_assumption: '',
    classification: 'ai_estimate',
    nutrients: Object.freeze(nutrients as never),
    unknown_nutrients: [],
    assumptions: ['Focused nutrient-gap estimate using the full recipe context.'],
    confidence: 'medium',
    sources: [],
  });
}

describe('SINC-3 finishing pass — nutrient gaps after 18/18 ingredients', () => {
  it('fills previously unknown AI-estimated nutrients on the second command while preserving USDA contributions', async () => {
    const { partials } = await resolveToPartialAi();
    expect(partials).toHaveLength(2);
    expect(partials.every((entry) => entry.classification === 'ai_estimate')).toBe(true);
    expect(partials.every((entry) => entry.unknown_nutrients.includes('protein'))).toBe(true);

    const { ctx, accepted, runAnalysis, runAiNutrition } = gapFixture(partials, [
      gapAiContribution(GOCHUJANG_REF, OWNER_LINES[GOCHUJANG_INDEX], {
        calories: { amount: 75, unit: 'kcal' },
        protein: { amount: 1.2, unit: 'g' },
        sodium: { amount: 800, unit: 'mg' },
      }),
      gapAiContribution(VINEGAR_REF, OWNER_LINES[VINEGAR_INDEX], {
        calories: { amount: 3, unit: 'kcal' },
        protein: { amount: 0, unit: 'g' },
        sodium: { amount: 4, unit: 'mg' },
      }),
    ]);
    const outcome = await runShisoConversationTurn({
      network: noProviderNetwork(),
      toolContext: ctx,
      context: {
        recipe: { title: 'Gochujang Chicken Rice Bowls', servings: 4, ingredientCount: 18, stepCount: 6 },
        nutrition: { available: true, summary: null, unresolvedCount: 0, needsAmountCount: 0, needsMatchCount: 0, unsavedWorkingReview: true },
        recipeKey: 'gochujang-bowls',
        sessionIdentity: 'session-sinc3',
      },
    }, initialShisoConversation(), 'Complete nutrition.');

    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(['complete_nutrition']);
    expect(runAnalysis).not.toHaveBeenCalled();
    expect(runAiNutrition).toHaveBeenCalledTimes(1);
    const focus = (runAiNutrition.mock.calls[0] as unknown as [unknown, { nutrientGapFocus: Array<{ line_ref: string; unknown_nutrients: string[] }> }])[1].nutrientGapFocus;
    expect(focus.find((entry) => entry.line_ref === GOCHUJANG_REF)?.unknown_nutrients).toEqual(['protein', 'sodium']);
    expect(focus.find((entry) => entry.line_ref === VINEGAR_REF)?.unknown_nutrients).toEqual(['protein', 'sodium']);

    expect(accepted).toHaveLength(1);
    const finalContributions = accepted[0]!;
    expect(finalContributions).toHaveLength(2);
    const gochujang = finalContributions.find((entry) => entry.line_ref === GOCHUJANG_REF)!;
    const vinegar = finalContributions.find((entry) => entry.line_ref === VINEGAR_REF)!;
    expect(gochujang).toMatchObject({
      classification: 'ai_estimate',
      weight_grams: 30,
      nutrients: {
        calories: { amount: 60, unit: 'kcal' },
        protein: { amount: 1.2, unit: 'g' },
        sodium: { amount: 800, unit: 'mg' },
      },
      unknown_nutrients: [],
    });
    expect(vinegar).toMatchObject({
      classification: 'ai_estimate',
      weight_grams: 30,
      nutrients: {
        calories: { amount: 3, unit: 'kcal' },
        protein: { amount: 0, unit: 'g' },
        sodium: { amount: 4, unit: 'mg' },
      },
      unknown_nutrients: [],
    });
    expect(gochujang.sources).toEqual([]);
    expect(vinegar.sources).toEqual([]);
    expect(outcome.message).toContain('Ingredient coverage is 18 of 18');
    expect(outcome.message).toContain('filled 4 nutrient value(s)');
    expect(outcome.message).toContain('No AI-estimated nutrient gaps remain');
    expect(outcome.message).toContain('USDA source-backed gaps remain');
    expect(outcome.message).toContain('Niacin');
    expect(outcome.message).toContain('Added sugars');
    expect(outcome.message).toContain('Additional completion:');
    expect(outcome.message).toContain('bounded AI supplement pass');
    expect(outcome.message).toContain('Verified USDA contributions were preserved');
    expect(outcome.message).toContain('Nothing was applied or saved');

  });

  it('reports whole-recipe nutrient coverage, including niacin and added sugars, in the completion data', async () => {
    const { partials } = await resolveToPartialAi();
    const { ctx } = gapFixture(partials, [
      gapAiContribution(GOCHUJANG_REF, OWNER_LINES[GOCHUJANG_INDEX], {
        calories: { amount: 60, unit: 'kcal' },
        protein: { amount: 1.2, unit: 'g' },
        sodium: { amount: 800, unit: 'mg' },
      }),
      gapAiContribution(VINEGAR_REF, OWNER_LINES[VINEGAR_INDEX], {
        calories: { amount: 3, unit: 'kcal' },
        protein: { amount: 0, unit: 'g' },
        sodium: { amount: 4, unit: 'mg' },
      }),
    ]);
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    const whole = observation.data['whole_recipe_nutrient_coverage'] as {
      total_nutrients: number;
      complete_nutrients: number;
      source_gap_nutrients: Array<{ label: string; missing_source_count: number }>;
      remaining_source_gap_values: number;
      remaining_ai_gap_values: number;
      additional_completion: { possible: boolean; reason: string };
    };
    expect(whole.total_nutrients).toBe(8);
    expect(whole.complete_nutrients).toBe(6);
    expect(whole.source_gap_nutrients.map((entry) => entry.label)).toEqual(['Niacin', 'Added sugars']);
    expect(whole.source_gap_nutrients.find((entry) => entry.label === 'Niacin')?.missing_source_count).toBe(6);
    expect(whole.source_gap_nutrients.find((entry) => entry.label === 'Added sugars')?.missing_source_count).toBe(16);
    expect(whole.remaining_source_gap_values).toBe(22);
    expect(whole.remaining_ai_gap_values).toBe(0);
    expect(whole.additional_completion.possible).toBe(true);
    expect(whole.additional_completion.reason).toContain('bounded AI supplement pass');
    expect(observation.data['ingredient_coverage']).toMatchObject({ accounted: 18, unresolved: 0 });
  });

  it('still reports whole-recipe source-backed gaps when no AI nutrient gaps remain', async () => {
    const { partials } = await resolveToPartialAi();
    const completeAi = partials.map((entry) => Object.freeze({
      ...entry,
      nutrients: Object.freeze({
        ...entry.nutrients,
        protein: Object.freeze({ amount: 1, unit: 'g' as const }),
        sodium: Object.freeze({ amount: 10, unit: 'mg' as const }),
      }),
      unknown_nutrients: Object.freeze([]),
    }));
    const base = ownerFixture();
    const runAnalysis = vi.fn(async () => { throw new Error('no source analysis needed'); });
    // SINC-4: source-backed gaps now trigger one explicit bounded supplement
    // pass even when no AI-estimated line remains. The synthetic source-gap
    // lines in this fixture carry no source metadata, so nothing is proposed.
    const runAiNutrition = vi.fn(async () => ({ ok: true as const, contributions: [] }));
    const ctx: ShisoToolContext = {
      ...base.ctx,
      nutrition: { ...base.ctx.nutrition!, aiContributions: completeAi },
      runAnalysis,
      runAiNutrition,
      researchNutrition: undefined,
      searchBrandedFoods: undefined,
    };
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(runAnalysis).not.toHaveBeenCalled();
    expect(runAiNutrition).toHaveBeenCalledTimes(1);
    expect(observation.summary).toContain('No AI-estimated nutrient gaps remain');
    expect(observation.summary).toContain('USDA source-backed gaps remain');
    expect(observation.summary).toContain('Niacin');
    expect(observation.summary).toContain('Added sugars');
    expect(observation.summary).toContain('Additional completion:');
    const whole = observation.data['whole_recipe_nutrient_coverage'] as {
      source_gap_nutrients: Array<{ label: string }>;
      remaining_source_gap_values: number;
      remaining_ai_gap_values: number;
      additional_completion: { possible: boolean; reason: string };
    };
    expect(whole.source_gap_nutrients.map((entry) => entry.label)).toEqual(['Niacin', 'Added sugars']);
    expect(whole.remaining_source_gap_values).toBe(22);
    expect(whole.remaining_ai_gap_values).toBe(0);
    expect(whole.additional_completion.possible).toBe(true);
  });

  it('does not describe an AI-resolved line as currently unresolved', async () => {
    const { outcome } = await resolveToPartialAi();
    expect(outcome.message).toContain('2 of 2 previously unresolved line(s) resolved');
    expect(outcome.message).not.toMatch(/ingredient remains unresolved/i);
    expect(outcome.message).toContain('Completed by a validated AI estimate');
  });

  it('keeps unknowns and known values when the gap estimate adds nothing defensible', async () => {
    const { partials } = await resolveToPartialAi();
    const unchangedGap = partials.map((entry) => gapAiContribution(
      entry.line_ref,
      entry.ingredient,
      Object.fromEntries(Object.entries(entry.nutrients).map(([id, value]) => [id, { amount: value.amount, unit: value.unit }])),
    ));
    const { ctx, accepted } = gapFixture(partials, unchangedGap);
    const outcome = await runShisoConversationTurn({
      network: noProviderNetwork(),
      toolContext: ctx,
      context: {
        recipe: { title: 'Gochujang Chicken Rice Bowls', servings: 4, ingredientCount: 18, stepCount: 6 },
        nutrition: { available: true, summary: null, unresolvedCount: 0, needsAmountCount: 0, needsMatchCount: 0, unsavedWorkingReview: true },
        recipeKey: 'gochujang-bowls',
        sessionIdentity: 'session-sinc3',
      },
    }, initialShisoConversation(), 'Complete nutrition.');

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('no additional defensible nutrient values');
    expect(outcome.message).toContain('2 line(s) still have unknown nutrients');
    const finalContributions = accepted[0]!;
    expect(finalContributions.find((entry) => entry.line_ref === GOCHUJANG_REF)?.unknown_nutrients).toEqual(['protein', 'sodium']);
    expect(finalContributions.find((entry) => entry.line_ref === GOCHUJANG_REF)?.nutrients.calories).toEqual({ amount: 60, unit: 'kcal' });
    expect(finalContributions.find((entry) => entry.line_ref === VINEGAR_REF)?.unknown_nutrients).toEqual(['protein', 'sodium']);
  });

  it('upgrades a gap line to source-backed research only when it covers the existing known values', async () => {
    const { partials } = await resolveToPartialAi();
    const researchedGochujang = Object.freeze({
      ...gapAiContribution(GOCHUJANG_REF, OWNER_LINES[GOCHUJANG_INDEX], {
        calories: { amount: 75, unit: 'kcal' },
        protein: { amount: 1, unit: 'g' },
        sodium: { amount: 800, unit: 'mg' },
        fiber: { amount: 1, unit: 'g' },
      }),
      classification: 'source_backed' as const,
      sources: Object.freeze([{ title: 'Mock manufacturer nutrition page', url: 'https://example.com/gochujang' }]),
    });
    const { ctx, accepted } = gapFixture(
      partials,
      [gapAiContribution(VINEGAR_REF, OWNER_LINES[VINEGAR_INDEX], {
        calories: { amount: 3, unit: 'kcal' },
        protein: { amount: 0, unit: 'g' },
        sodium: { amount: 4, unit: 'mg' },
      })],
      vi.fn(async () => ({
        ok: true,
        contributions: [researchedGochujang],
        sources: [{ title: 'Mock manufacturer nutrition page', url: 'https://example.com/gochujang' }],
        skipped: [],
        message: 'One external source was verified.',
      })),
    );
    const outcome = await runShisoConversationTurn({
      network: noProviderNetwork(),
      toolContext: ctx,
      context: {
        recipe: { title: 'Gochujang Chicken Rice Bowls', servings: 4, ingredientCount: 18, stepCount: 6 },
        nutrition: { available: true, summary: null, unresolvedCount: 0, needsAmountCount: 0, needsMatchCount: 0, unsavedWorkingReview: true },
        recipeKey: 'gochujang-bowls',
        sessionIdentity: 'session-sinc3',
      },
    }, initialShisoConversation(), 'Complete nutrition.');

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('1 line(s) upgraded to source-backed external research');
    const finalContributions = accepted[0]!;
    const gochujang = finalContributions.find((entry) => entry.line_ref === GOCHUJANG_REF)!;
    expect(gochujang.classification).toBe('source_backed');
    expect(gochujang.sources[0]?.url).toBe('https://example.com/gochujang');
    expect(finalContributions.find((entry) => entry.line_ref === VINEGAR_REF)?.classification).toBe('ai_estimate');
  });
});
