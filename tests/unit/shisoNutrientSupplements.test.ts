/**
 * SINC-4 — SHISO explicit completion of USDA source-backed nutrient gaps.
 *
 * A fully resolved source-backed recipe still has nutrients the verified USDA
 * records do not report. These tests prove that explicit SHISO completion:
 *   - preserves every verified contribution unchanged;
 *   - proposes separately attributed supplements only for source gaps;
 *   - binds each supplement to the recipe, review, line, source and weight;
 *   - accepts nothing when the provider fails or the recipe changes;
 *   - never applies or saves.
 *
 * All provider data is synthetic.
 */

import { describe, expect, it, vi } from 'vitest';

import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { brandedReviewIdentity } from '../../src/core/nutritionV2/brandedEvidenceTrust';
import type { AiNutrientContribution, AiNutrientSupplement } from '../../src/core/nutritionV2/aiContribution';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import type { ShisoNutrientCoverageEntry } from '../../src/core/shiso/nutritionCoverage';
import type { NutrientId } from '../../src/core/nutritionV2/nutrients';

const LINE = '100 g Flour, wheat, white';
const REF = 'ing:flour';
const RECIPE_DIGEST = `sha256:${'a'.repeat(64)}`;
const SOURCE_RELEASE = 'usda_fdc_release_2026_04';
const REVIEW_IDENTITY = brandedReviewIdentity('session-sinc4', 'flour-recipe', 4);
const RECORD_DIGEST = `sha256:${'c'.repeat(64)}`;

function rows(): LiveRowState[] {
  return [{
    line_ref: REF,
    original_text: LINE,
    status: 'matched',
    food_authority: 'automatic',
    selected_fdc_id: 6001,
    selected_description: 'Flour, wheat, white',
    resolved_grams: 100,
    mass_source: 'source_portion',
    portion_index: 0,
    user_mass_quantity: undefined,
    user_mass_unit: undefined,
    source_portion_automatic: true,
    household_unit: undefined,
    household_size_class: undefined,
    household_requires_state: undefined,
    household_authority_class: undefined,
  } as unknown as LiveRowState];
}

function gapLines(nutrients: ReadonlyArray<{ id: NutrientId; label: string; unit: string }>): ShisoNutrientCoverageEntry[] {
  return nutrients.map((entry) => ({
    id: entry.id,
    label: entry.label,
    unit: entry.unit,
    status: 'unknown' as const,
    total_amount: null,
    ai_estimated_amount: 0,
    derived_source_subtotal: null,
    covered_ingredient_count: 0,
    measurable_ingredient_count: 1,
    missing_source_lines: [{
      line_ref: REF,
      label: LINE,
      fdc_id: 6001,
      record_digest: RECORD_DIGEST,
      weight_grams: 100,
      source_release: SOURCE_RELEASE,
    }],
    missing_ai_lines: [],
  }));
}

function coverage(): ShisoNutrientCoverageEntry[] {
  return [
    {
      id: 'calories',
      label: 'Calories',
      unit: 'kcal',
      status: 'complete',
      total_amount: 364,
      ai_estimated_amount: 0,
      derived_source_subtotal: 364,
      covered_ingredient_count: 1,
      measurable_ingredient_count: 1,
      missing_source_lines: [],
      missing_ai_lines: [],
    },
    {
      id: 'protein',
      label: 'Protein',
      unit: 'g',
      status: 'complete',
      total_amount: 10.3,
      ai_estimated_amount: 0,
      derived_source_subtotal: 10.3,
      covered_ingredient_count: 1,
      measurable_ingredient_count: 1,
      missing_source_lines: [],
      missing_ai_lines: [],
    },
    ...gapLines([
      { id: 'niacin', label: 'Niacin', unit: 'mg_ne' },
      { id: 'added_sugars', label: 'Added sugars', unit: 'g' },
    ]),
  ];
}

function aiContribution(overrides: Partial<AiNutrientContribution> = {}): AiNutrientContribution {
  return Object.freeze({
    line_ref: REF,
    ingredient: LINE,
    quantity_basis: '100 g resolved source weight',
    weight_grams: 100,
    disposition: 'edible',
    exclusion_role: 'none',
    exclusion_assumption: '',
    classification: 'ai_estimate',
    nutrients: Object.freeze({
      niacin: Object.freeze({ amount: 1.2, unit: 'mg_ne' as const }),
      added_sugars: Object.freeze({ amount: 0.4, unit: 'g' as const }),
    }),
    unknown_nutrients: Object.freeze([]),
    assumptions: Object.freeze(['Typical refined flour composition assumed.']),
    confidence: 'medium',
    sources: Object.freeze([]),
    ...overrides,
  });
}

interface Fixture {
  readonly ctx: ShisoToolContext;
  readonly accepted: Array<{ contributions: readonly AiNutrientContribution[]; supplements: readonly AiNutrientSupplement[] }>;
  readonly runAiNutrition: ReturnType<typeof vi.fn>;
  readonly applyIngredientEdits: ReturnType<typeof vi.fn>;
  readonly saveWorkingRecipe: ReturnType<typeof vi.fn>;
}

function fixture(options: {
  readonly contribution?: AiNutrientContribution;
  readonly providerOk?: boolean;
  readonly mutateDigest?: boolean;
  readonly existingSupplements?: readonly AiNutrientSupplement[];
  readonly nutrientCoverage?: ShisoNutrientCoverageEntry[];
  readonly nutrition?: ShisoToolContext['nutrition'];
} = {}): Fixture {
  const accepted: Fixture['accepted'] = [];
  const applyIngredientEdits = vi.fn(async () => { throw new Error('must not edit ingredients'); });
  const saveWorkingRecipe = vi.fn(async () => { throw new Error('must not save'); });
  const runAiNutrition = vi.fn(async (_signal?: AbortSignal, callOptions?: { apply?: boolean; nutrientGapFocus?: ReadonlyArray<{ line_ref: string; unknown_nutrients: readonly string[] }> }) => {
    expect(callOptions?.apply).toBe(false);
    expect(callOptions?.nutrientGapFocus?.length).toBeGreaterThan(0);
    if (options.mutateDigest) {
      const current = ctx.nutrition;
      if (current !== null) {
        (current as { recipeDigest?: string }).recipeDigest = `sha256:${'d'.repeat(64)}`;
      }
    }
    if (options.providerOk === false) return { ok: false, message: 'Provider temporarily unavailable.' };
    return { ok: true, contributions: [options.contribution ?? aiContribution()] };
  });
  const ctx: ShisoToolContext = {
    session: {} as never,
    recipe: {
      title: 'Flour test',
      servings: 4,
      ingredients: [{ text: LINE, name: 'Flour, wheat, white', line_ref: REF }],
      instructions: [],
    },
    nutrition: 'nutrition' in options ? options.nutrition ?? null : {
      rows: rows(),
      aiContributions: [],
      nutrientSupplements: options.existingSupplements ?? [],
      summary: '1 of 1 ingredient line resolved.',
      unsaved: true,
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
      nutrientCoverage: options.nutrientCoverage ?? coverage(),
    },
    runAnalysis: vi.fn(async () => { throw new Error('a resolved recipe must not rerun analysis'); }),
    runAiNutrition,
    acceptNutritionContributions: vi.fn((contributions, supplements) => {
      accepted.push({ contributions: [...contributions], supplements: [...(supplements ?? [])] });
      return true;
    }),
    researchEligibleRefs: [],
    brandedEligibleRefs: [],
    applyIngredientEdits,
    saveWorkingRecipe,
  };
  return { ctx, accepted, runAiNutrition, applyIngredientEdits, saveWorkingRecipe };
}

describe('SINC-4 — SHISO completes USDA source-backed nutrient gaps', () => {
  it('proposes separately bound supplements while preserving verified USDA contributions unchanged', async () => {
    const harness = fixture();
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, harness.ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;

    expect(harness.accepted).toHaveLength(1);
    const accepted = harness.accepted[0]!;
    expect(accepted.contributions).toEqual([]);
    expect(accepted.supplements).toHaveLength(2);

    const niacin = accepted.supplements.find((entry) => entry.nutrient_id === 'niacin')!;
    const addedSugars = accepted.supplements.find((entry) => entry.nutrient_id === 'added_sugars')!;
    expect(niacin).toMatchObject({
      supplement_version: 'ai_nutrient_supplement_v1',
      line_ref: REF,
      ingredient: LINE,
      nutrient_id: 'niacin',
      amount: 1.2,
      unit: 'mg_ne',
      classification: 'ai_estimate',
      source_kind: 'ai_supplement',
      source_food_id: '6001',
      source_release: SOURCE_RELEASE,
      weight_grams: 100,
      confidence: 'medium',
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
    });
    expect(addedSugars).toMatchObject({ nutrient_id: 'added_sugars', amount: 0.4, unit: 'g' });
    expect(niacin.assumptions.join(' ')).toContain('USDA values are unchanged');
    expect(niacin.quantity_basis).toContain('100 g');

    // The verified contributions passed to the review are byte-identical.
    expect(accepted.contributions).toEqual([]);

    expect(observation.data).toMatchObject({
      total_lines: 1,
      accounted: 1,
      remaining: 0,
      initial_unresolved: 0,
      resolved_new: 0,
      nutrient_coverage: {
        source_gaps_examined: 2,
        source_supplements_this_pass: 2,
        total_supplements: 2,
        remaining_source_gap_values: 0,
      },
    });
    const whole = observation.data['whole_recipe_nutrient_coverage'] as {
      complete_nutrients: number;
      total_nutrients: number;
      supplemented_source_values: number;
      nutrients: Array<{ id: string; status: string; total_amount: number | null; supplemental_estimated_amount: number }>;
    };
    expect(whole.total_nutrients).toBe(4);
    expect(whole.complete_nutrients).toBe(4);
    expect(whole.supplemented_source_values).toBe(2);
    expect(whole.nutrients.find((entry) => entry.id === 'niacin')).toMatchObject({
      status: 'complete',
      total_amount: 1.2,
      supplemental_estimated_amount: 1.2,
    });
    expect(whole.nutrients.find((entry) => entry.id === 'added_sugars')).toMatchObject({
      status: 'complete',
      total_amount: 0.4,
    });
    expect(observation.summary).toContain('Supplemental AI estimates cover 2 source-backed nutrient-line value(s)');
    expect(observation.summary).toContain('Verified USDA contributions were preserved');
    expect(observation.summary).toContain('Nothing was applied or saved');

    // Explicit completion remains review-only.
    expect(harness.applyIngredientEdits).not.toHaveBeenCalled();
    expect(harness.saveWorkingRecipe).not.toHaveBeenCalled();
  });

  it('preserves verified work and accepts no supplement when the provider fails', async () => {
    const harness = fixture({ providerOk: false });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, harness.ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(harness.accepted).toHaveLength(1);
    expect(harness.accepted[0]!.supplements).toEqual([]);
    expect(JSON.stringify(observation.data['notes'])).toContain('Provider temporarily unavailable.');
    expect((observation.data['whole_recipe_nutrient_coverage'] as { remaining_source_gap_values: number }).remaining_source_gap_values).toBe(2);
    expect(harness.applyIngredientEdits).not.toHaveBeenCalled();
    expect(harness.saveWorkingRecipe).not.toHaveBeenCalled();
  });

  it('rejects a supplement proposal whose AI weight basis differs from the verified line', async () => {
    const harness = fixture({ contribution: aiContribution({ weight_grams: 90 }) });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, harness.ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(harness.accepted[0]!.supplements).toEqual([]);
    expect(JSON.stringify(observation.data['notes'])).toContain('different weight basis');
  });

  it('rejects every supplement when the recipe changes during the provider call', async () => {
    const harness = fixture({ mutateDigest: true });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, harness.ctx);
    expect(observation).toMatchObject({ ok: false, code: 'stale_recipe' });
    expect(harness.accepted).toHaveLength(0);
  });

  it('does not duplicate an existing supplement or re-request its nutrient', async () => {
    const existing = Object.freeze({
      supplement_version: 'ai_nutrient_supplement_v1' as const,
      line_ref: REF,
      ingredient: LINE,
      nutrient_id: 'niacin' as const,
      amount: 1.2,
      unit: 'mg_ne' as const,
      classification: 'ai_estimate' as const,
      source_kind: 'ai_supplement' as const,
      source_food_id: '6001',
      source_release: SOURCE_RELEASE,
      weight_grams: 100,
      quantity_basis: '100 g resolved source weight',
      assumptions: Object.freeze(['Previously accepted.']),
      confidence: 'medium' as const,
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
    });
    const withExisting = coverage().map((entry) => entry.id === 'niacin'
      ? {
          ...entry,
          status: 'partial' as const,
          total_amount: 1.2,
          supplemental_estimated_amount: 1.2,
          covered_ingredient_count: 1,
          missing_source_lines: [],
          supplemented_lines: [{ line_ref: REF, label: LINE, fdc_id: 6001, weight_grams: 100, source_release: SOURCE_RELEASE }],
        }
      : entry);
    const harness = fixture({ existingSupplements: [existing], nutrientCoverage: withExisting });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, harness.ctx);
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(harness.accepted[0]!.supplements).toHaveLength(2);
    expect(harness.accepted[0]!.supplements.filter((entry) => entry.nutrient_id === 'niacin')).toHaveLength(1);
    const focus = (harness.runAiNutrition.mock.calls[0] as unknown as [unknown, { nutrientGapFocus: Array<{ line_ref: string; unknown_nutrients: string[] }> }])[1].nutrientGapFocus;
    expect(focus).toEqual([{ line_ref: REF, unknown_nutrients: ['added_sugars'] }]);
  });

  it('reports unavailable when the application-owned review cannot initialize', async () => {
    const harness = fixture({ nutrition: null });
    const observation = await executeShisoTool({ tool: 'complete_nutrition' }, harness.ctx);
    expect(observation).toMatchObject({ ok: false, code: 'analysis_unavailable' });
    expect(harness.runAiNutrition).not.toHaveBeenCalled();
    expect(harness.accepted).toHaveLength(0);
  });
});
