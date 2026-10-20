import { hydrateAiSelections } from '../../src/application/aiSelection';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initialShisoConversation, runShisoConversationTurn } from '../../src/application/shisoConversation';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { AiNutrientContribution } from '../../src/core/nutritionV2/aiContribution';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import { deriveNutritionCoverage } from '../../src/core/shiso/nutritionCoverage';

beforeAll(async () => { await hydrateAiSelections({ get: async () => null }); });

const onionRef = 'guac:onion';
const onionContribution: AiNutrientContribution = {
  line_ref: onionRef,
  ingredient: '1/2 white onion, finely diced',
  quantity_basis: 'half of a typical medium raw white onion, diced',
  weight_grams: 55,
  disposition: 'edible',
  exclusion_role: 'none',
  exclusion_assumption: '',
  classification: 'ai_estimate',
  nutrients: { calories: { amount: 22, unit: 'kcal' } },
  unknown_nutrients: ['vitamin_b12'],
  assumptions: ['Estimated as half of a typical medium white onion; diced yield assumed unchanged.'],
  confidence: 'medium',
  sources: [],
};

const unresolvedOnion = {
  line_ref: onionRef,
  original_text: '1/2 white onion, finely diced',
  status: 'needs_match',
  food_authority: 'none',
  resolved_grams: undefined,
  mass_source: undefined,
} as unknown as LiveRowState;

function context(): ShisoToolContext {
  return {
    session: {} as never,
    recipe: {
      title: 'Guacamole', servings: 4,
      ingredients: [{ text: onionContribution.ingredient, name: 'white onion', line_ref: onionRef }],
      instructions: [],
    },
    nutrition: { rows: [unresolvedOnion], summary: null, unsaved: true, aiContributions: [] },
    runAnalysis: vi.fn(async () => ({
      ok: true, analyzed: true, summary: '1 ingredient line analyzed', matched: 0,
      needs_amount: 0, needs_match: 1, total_lines: 1,
      unresolved_line_refs: [onionRef], preview_state: 'partial' as const,
    })),
    runAiNutrition: vi.fn(async () => ({ ok: true, contributions: [onionContribution] })),
    applyIngredientEdits: vi.fn(async () => { throw new Error('must not edit recipe'); }),
  };
}

const noProviderNetwork = {
  request: vi.fn(async () => { throw new Error('estimate intent must not call chat provider'); }),
  get: vi.fn(async () => { throw new Error('estimate intent must not call chat provider'); }),
  post: vi.fn(async () => { throw new Error('estimate intent must not call chat provider'); }),
} as unknown as NetworkAdapter;

describe('SHISO AI-estimated nutrition resolution', () => {
  it('does not turn a model-only confirmation into an applied correction', async () => {
    const tools = context();
    const network = { ...noProviderNetwork, post: vi.fn(async () => ({ ok: true, status: 200, data: {
      ok: true, kind: 'reply', text: 'I applied everything!', proposals: [], model_invocations_used: 1, tool_calls_used: 0,
    } })) } as unknown as NetworkAdapter;
    const result = await runShisoConversationTurn({ network, toolContext: tools,
      context: { recipe: { title: 'Guacamole', servings: 4, ingredientCount: 1, stepCount: 0 },
        nutrition: { available: true, summary: null, unresolvedCount: 1, needsAmountCount: 0, needsMatchCount: 1, unsavedWorkingReview: true },
        recipeKey: 'guacamole', sessionIdentity: 'session' },
    }, initialShisoConversation(), 'yes apply');
    expect(result.message).toContain('No changes were applied');
    expect(result.message).not.toContain('I applied everything');
    expect(tools.applyIngredientEdits).not.toHaveBeenCalled();
  });

  it('reports zero corrections honestly even when the model claims it applied and saved them', async () => {
    const tools = { ...context(), applyNutritionCorrections: vi.fn(async () => ({
      ok: true, summary: '0 source corrections verified; the onion estimate remains in review.',
      applied: [], failed: [], regressed: [], changes: [], unresolved: [],
      before_resolved_count: 1, resolved_count: 1, total_count: 1,
      recalculation: 'partial' as const, working_unsaved: true,
    })) };
    const replies = [
      { ok: true, kind: 'tool_request', tool: 'apply_nutrition_corrections', args: { tool: 'apply_nutrition_corrections' }, model_invocations_used: 1, tool_calls_used: 0 },
      { ok: true, kind: 'reply', text: 'I applied the two fixes and saved everything!', proposals: [], model_invocations_used: 2, tool_calls_used: 1 },
    ];
    const network = { ...noProviderNetwork, post: vi.fn(async () => ({ ok: true, status: 200, data: replies.shift() })) } as unknown as NetworkAdapter;
    const result = await runShisoConversationTurn({ network, toolContext: tools,
      context: { recipe: { title: 'Guacamole', servings: 4, ingredientCount: 1, stepCount: 0 },
        nutrition: { available: true, summary: null, unresolvedCount: 0, needsAmountCount: 0, needsMatchCount: 0, unsavedWorkingReview: true },
        recipeKey: 'guacamole', sessionIdentity: 'session' },
    }, initialShisoConversation(), 'yes apply');
    expect(result.message).toContain('No additional source corrections were applied');
    expect(result.message).toContain('Nothing was saved to Vault');
    expect(result.message).not.toContain('I applied the two fixes');
    expect(tools.runAiNutrition).not.toHaveBeenCalled();
    expect(tools.applyIngredientEdits).not.toHaveBeenCalled();
  });

  it('stops after a correction returns no resolved-count progress', async () => {
    const tools = {
      ...context(),
      applyNutritionCorrections: vi.fn(async () => ({
        ok: true, summary: 'No source corrections resolved.', applied: [], failed: [], regressed: [], changes: [], unresolved: [],
        before_resolved_count: 5, resolved_count: 5, total_count: 13, recalculation: 'partial' as const, working_unsaved: true,
      })),
    };
    const network = { ...noProviderNetwork, post: vi.fn(async () => ({ ok: true, status: 200, data: {
      ok: true, kind: 'tool_request', tool: 'apply_nutrition_corrections', args: { tool: 'apply_nutrition_corrections' }, model_invocations_used: 1, tool_calls_used: 0,
    } })) } as unknown as NetworkAdapter;
    const result = await runShisoConversationTurn({ network, toolContext: tools,
      context: { recipe: { title: 'Oats', servings: 4, ingredientCount: 13, stepCount: 2 },
        nutrition: { available: true, summary: null, unresolvedCount: 8, needsAmountCount: 4, needsMatchCount: 4, unsavedWorkingReview: true },
        recipeKey: 'oats', sessionIdentity: 'session' },
    }, initialShisoConversation(), 'Fix the nutrition');
    expect(result.message).toContain('made no coverage progress: 5 of 13');
    expect(result.message).toContain('Nothing was saved');
    expect(tools.applyNutritionCorrections).toHaveBeenCalledTimes(1);
    expect(network.post).toHaveBeenCalledTimes(1);
  });

  it('recognizes a meaningful correction even when the resolved count is unchanged', async () => {
    const tools = {
      ...context(),
      applyNutritionCorrections: vi.fn(async (lineRefs?: string[]) => {
        if (Array.isArray(lineRefs) && lineRefs.includes('line-a')) {
          return {
            ok: true, summary: 'Updated an existing match.', applied: [{ line_ref: 'line-a', label: 'flour', description: 'Wheat flour' }],
            failed: [], regressed: [], changes: [{ line_ref: 'line-a', label: 'flour', change: 'identity', before_status: 'needs_match', after_status: 'matched' }],
            unresolved: [], before_resolved_count: 5, resolved_count: 5, total_count: 13, recalculation: 'partial' as const, working_unsaved: true,
          };
        }
        return {
          ok: true, summary: 'No source corrections resolved.', applied: [], failed: [], regressed: [], changes: [], unresolved: [],
          before_resolved_count: 5, resolved_count: 5, total_count: 13, recalculation: 'partial' as const, working_unsaved: true,
        };
      }),
    };
    const replies = [
      { ok: true, kind: 'tool_request', tool: 'apply_nutrition_corrections', args: { tool: 'apply_nutrition_corrections', line_refs: ['line-a'] }, model_invocations_used: 1, tool_calls_used: 0 },
      { ok: true, kind: 'tool_request', tool: 'apply_nutrition_corrections', args: { tool: 'apply_nutrition_corrections', line_refs: ['line-b'] }, model_invocations_used: 2, tool_calls_used: 1 },
    ];
    const network = { ...noProviderNetwork, post: vi.fn(async () => ({ ok: true, status: 200, data: replies.shift() })) } as unknown as NetworkAdapter;
    const result = await runShisoConversationTurn({ network, toolContext: tools,
      context: { recipe: { title: 'Oats', servings: 4, ingredientCount: 13, stepCount: 2 },
        nutrition: { available: true, summary: null, unresolvedCount: 8, needsAmountCount: 4, needsMatchCount: 4, unsavedWorkingReview: true },
        recipeKey: 'oats', sessionIdentity: 'session' },
    }, initialShisoConversation(), 'Fix the nutrition');
    expect(result.message).toContain('made no coverage progress: 5 of 13');
    expect(result.message).toContain('Nothing was saved');
    expect(tools.applyNutritionCorrections).toHaveBeenCalledTimes(2);
    expect(network.post).toHaveBeenCalledTimes(2);
  });

  it('does not re-run a cached successful nutrition correction', async () => {
    const tools = {
      ...context(),
      applyNutritionCorrections: vi.fn(async () => ({
        ok: true, summary: 'One line resolved.', applied: [{ line_ref: 'r', label: 'flour', description: 'Wheat flour' }], failed: [], regressed: [], changes: [], unresolved: [],
        before_resolved_count: 5, resolved_count: 6, total_count: 13, recalculation: 'partial' as const, working_unsaved: true,
      })),
    };
    const replies = [1, 2].map((invocation) => ({ ok: true, kind: 'tool_request', tool: 'apply_nutrition_corrections',
      args: { tool: 'apply_nutrition_corrections' }, model_invocations_used: invocation, tool_calls_used: invocation - 1 }));
    const network = { ...noProviderNetwork, post: vi.fn(async () => ({ ok: true, status: 200, data: replies.shift() })) } as unknown as NetworkAdapter;
    const result = await runShisoConversationTurn({ network, toolContext: tools,
      context: { recipe: { title: 'Oats', servings: 4, ingredientCount: 13, stepCount: 2 },
        nutrition: { available: true, summary: null, unresolvedCount: 8, needsAmountCount: 4, needsMatchCount: 4, unsavedWorkingReview: true },
        recipeKey: 'oats', sessionIdentity: 'session' },
    }, initialShisoConversation(), 'Fix the nutrition');
    expect(result.message).toContain('same nutrition correction was requested again');
    expect(result.message).toContain('6 of 13 ingredient lines resolved');
    expect(tools.applyNutritionCorrections).toHaveBeenCalledTimes(1);
    expect(network.post).toHaveBeenCalledTimes(2);
  });

  it('routes an ingredient request to the read-only nutrition investigation', async () => {
    const tools = context();
    const result = await runShisoConversationTurn({ network: noProviderNetwork, toolContext: tools,
      context: { recipe: { title: 'Oatmeal Bars', servings: 8, ingredientCount: 7, stepCount: 4 },
        nutrition: { available: true, summary: null, unresolvedCount: 1, needsAmountCount: 0, needsMatchCount: 1, unsavedWorkingReview: true },
        recipeKey: 'oatmeal-bars', sessionIdentity: 'session' },
    }, initialShisoConversation(), 'Resolve the light brown sugar.');
    expect(result.toolsUsed).toEqual(['investigate_unresolved_ingredients']);
    expect(result.message).toContain('Investigated all 1 unresolved ingredient');
    expect(tools.runAnalysis).not.toHaveBeenCalled();
    expect(tools.runAiNutrition).not.toHaveBeenCalled();
    expect(tools.applyIngredientEdits).not.toHaveBeenCalled();
  });

  it('directs USDA food choices to the explicit Advanced Nutrition control', async () => {
    const result = await runShisoConversationTurn({ network: noProviderNetwork, toolContext: context(),
      context: { recipe: { title: 'Guacamole', servings: 4, ingredientCount: 1, stepCount: 0 },
        nutrition: { available: true, summary: null, unresolvedCount: 1, needsAmountCount: 0, needsMatchCount: 1, unsavedWorkingReview: true },
        recipeKey: 'guacamole', sessionIdentity: 'session' },
    }, initialShisoConversation(), 'Use this USDA food.');
    expect(result.message).toContain('“Use this match”');
    expect(result.toolsUsed).toEqual([]);
    expect(noProviderNetwork.post).not.toHaveBeenCalled();
  });

  it.each([
    'Fix any missing ingredients.',
    "Resolve it with estimated nutrition. It doesn't have to be exact.",
    'yes, fix the last two unresolved ing',
    "Estimate the onion's weight.",
    "The onions doesnt have a weight.",
    'Finish the nutrition for the tomato and onion.',
  ])('routes "%s" to the nutrition estimator, not recipe editing', async (message) => {
    const tools = context();
    const outcome = await runShisoConversationTurn({
      network: noProviderNetwork,
      context: {
        recipe: { title: 'Guacamole', servings: 4, ingredientCount: 1, stepCount: 0 },
        nutrition: { available: true, summary: null, unresolvedCount: 1, needsAmountCount: 0, needsMatchCount: 1, unsavedWorkingReview: true },
        recipeKey: 'guacamole', sessionIdentity: 'session',
      },
      toolContext: tools,
    }, initialShisoConversation(), message);

    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(['run_nutrition_analysis']);
    expect(outcome.message).toContain('1 of 1 ingredient lines covered');
    expect(outcome.message).toContain('AI-estimated');
    expect(tools.runAnalysis).toHaveBeenCalledTimes(1);
    expect(tools.runAiNutrition).toHaveBeenCalledTimes(1);
    expect(tools.applyIngredientEdits).not.toHaveBeenCalled();
    expect(noProviderNetwork.post).not.toHaveBeenCalled();
  });

  it('does not call the estimator again when accepted nutrition already covers the outstanding source rows', async () => {
    const tools = {
      ...context(),
      nutrition: { rows: [unresolvedOnion], summary: null, unsaved: true, aiContributions: [onionContribution] },
    };
    const outcome = await executeShisoTool({ tool: 'run_nutrition_analysis' }, tools);
    expect(outcome.ok).toBe(true);
    expect(tools.runAiNutrition).not.toHaveBeenCalled();
    if (outcome.ok) expect(outcome.data['ai_estimate_status']).toBe('skipped_covered');
  });

  it('reports one failed nutrition estimate without claiming success or retrying', async () => {
    const tools = {
      ...context(),
      runAiNutrition: vi.fn(async () => ({ ok: false, message: 'Provider temporarily unavailable.' })),
    };
    const outcome = await runShisoConversationTurn({
      network: noProviderNetwork,
      context: {
        recipe: { title: 'Guacamole', servings: 4, ingredientCount: 1, stepCount: 0 },
        nutrition: { available: true, summary: null, unresolvedCount: 1, needsAmountCount: 0, needsMatchCount: 1, unsavedWorkingReview: true },
        recipeKey: 'guacamole', sessionIdentity: 'session',
      },
      toolContext: tools,
    }, initialShisoConversation(), 'Estimate the onion weight.');
    expect(outcome.ok).toBe(true);
    expect(tools.runAiNutrition).toHaveBeenCalledTimes(1);
    expect(outcome.message).toContain('No AI nutrition estimate was confirmed. Provider temporarily unavailable.');
    expect(outcome.message).not.toContain('Accepted estimates are in');
    expect(tools.applyIngredientEdits).not.toHaveBeenCalled();
  });

  it('counts an accepted Guacamole onion contribution as estimated and discloses weight and nutrient provenance', async () => {
    const tools: ShisoToolContext = {
      ...context(),
      nutrition: { rows: [unresolvedOnion], summary: null, unsaved: true, aiContributions: [onionContribution] },
    };
    const review = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, tools);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.data).toMatchObject({ total_ingredient_lines: 1, resolved: 1, ai_estimated: 1, unresolved_count: 0, counts_reconcile: true });
    expect((review.data.ingredients as Array<Record<string, unknown>>)[0]).toMatchObject({
      label: '1/2 white onion, finely diced', status: 'ai_estimated_partial',
      contribution_provenance: 'ai_estimate', weight_provenance: 'estimated_weight',
      estimated_weight_grams: 55, unknown_nutrients: ['vitamin_b12'],
    });
    const investigation = await executeShisoTool({ tool: 'investigate_unresolved_ingredients' }, tools);
    expect(investigation.ok).toBe(true);
    if (investigation.ok) {
      expect(investigation.data['total_unresolved']).toBe(0);
      expect(investigation.data['ai_estimated']).toBe(1);
      expect(investigation.data['lines']).toEqual([]);
    }
  });

  it('does not count an AI contribution again when the source review already resolved that line', async () => {
    const matched = { ...unresolvedOnion, status: 'matched', resolved_grams: 55, mass_source: 'source_portion' } as LiveRowState;
    const review = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, {
      ...context(),
      nutrition: { rows: [matched], summary: null, unsaved: true, aiContributions: [onionContribution] },
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.data).toMatchObject({ total_ingredient_lines: 1, resolved: 1, ai_estimated: 0, unresolved_count: 0, counts_reconcile: true });
    expect((review.data.ingredients as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: 'source_backed', source_status: 'matched', contribution_provenance: 'ai_estimate', contribution_used: false,
    });
  });

  it('keeps a line unresolved when the accepted contribution has no known nutrient values', async () => {
    const unknownOnly = { ...onionContribution, nutrients: {}, unknown_nutrients: ['calories', 'protein'] } as AiNutrientContribution;
    const review = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, {
      ...context(),
      nutrition: { rows: [unresolvedOnion], summary: null, unsaved: true, aiContributions: [unknownOnly] },
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.data).toMatchObject({ total_ingredient_lines: 1, resolved: 0, ai_estimated: 0, unresolved_count: 1, counts_reconcile: true });
    expect((review.data.ingredients as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'needs_match', contribution_provenance: 'ai_estimate', weight_provenance: 'estimated_weight' });
  });

  it('preserves the live Guacamole result: five source lines plus the accepted onion and tomato estimates', () => {
    const sourceRows = ['avocado', 'lime', 'serrano', 'cilantro', 'salt'].map(name => ({ ...unresolvedOnion, line_ref: name, original_text: name, status: 'matched', resolved_grams: 10, mass_source: 'source_portion' } as LiveRowState));
    const onion = { ...onionContribution, weight_grams: 75, nutrients: { calories: { amount: 30, unit: 'kcal' as const } } };
    const tomato = { ...onionContribution, line_ref: 'tomato', ingredient: '1 roma tomato, seeded and diced', weight_grams: 60, nutrients: { calories: { amount: 12, unit: 'kcal' as const } } };
    const coverage = deriveNutritionCoverage([...sourceRows, unresolvedOnion, { ...unresolvedOnion, line_ref: 'tomato' }], [onion, tomato]);
    expect(coverage).toMatchObject({ total: 7, source_backed: 5, ai_estimated: 2, resolved: 7, unresolved: 0, partial_known: 2, reconciled: true });
    expect(coverage.lines[5].contribution?.weight_grams).toBe(75);
    expect(coverage.lines[6].contribution?.nutrients.calories?.amount).toBe(12);
  });

  it('uses one coverage view for both Guacamole gaps and does not double-count their accepted estimates', async () => {
    const tomatoRef = 'guac:tomato';
    const tomatoRow = { ...unresolvedOnion, line_ref: tomatoRef, original_text: '1 roma tomato, seeded and diced' } as LiveRowState;
    const tomatoContribution: AiNutrientContribution = {
      ...onionContribution,
      line_ref: tomatoRef,
      ingredient: '1 roma tomato, seeded and diced',
      quantity_basis: 'one small Roma tomato',
      weight_grams: undefined,
      nutrients: { calories: { amount: 18, unit: 'kcal' } },
      unknown_nutrients: ['vitamin_b12'],
      assumptions: ['Estimated from a typical small Roma tomato.'],
    };
    const coverage = deriveNutritionCoverage(
      [unresolvedOnion, tomatoRow],
      [onionContribution, tomatoContribution, tomatoContribution],
    );
    expect(coverage).toMatchObject({ total: 2, resolved: 2, ai_estimated: 2, partial_known: 2, unresolved: 0, reconciled: true });
    expect(coverage.lines.map((line) => line.status)).toEqual(['ai_estimated_partial', 'ai_estimated_partial']);
    expect(coverage.lines[1]?.candidate_contribution?.weight_grams).toBeUndefined();

    const twoLineContext: ShisoToolContext = {
      ...context(),
      recipe: {
        title: 'Guacamole', servings: 4,
        ingredients: [
          { text: onionContribution.ingredient, name: 'white onion', line_ref: onionRef },
          { text: tomatoContribution.ingredient, name: 'Roma tomato', line_ref: tomatoRef },
        ],
        instructions: [],
      },
      nutrition: { rows: [unresolvedOnion, tomatoRow], summary: null, unsaved: true, aiContributions: [onionContribution, tomatoContribution] },
    };
    const review = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, twoLineContext);
    expect(review).toMatchObject({ ok: true });
    if (review.ok) expect(review.data).toMatchObject({ total_ingredient_lines: 2, resolved: 2, ai_estimated: 2, partial_known: 2, unresolved_count: 0, counts_reconcile: true });
    const investigation = await executeShisoTool({ tool: 'investigate_unresolved_ingredients' }, twoLineContext);
    expect(investigation).toMatchObject({ ok: true });
    if (investigation.ok) expect(investigation.data['total_unresolved']).toBe(0);
  });

  it('keeps the estimate weight unknown when the accepted contribution provides no weight', async () => {
    const withoutWeight = { ...onionContribution, weight_grams: undefined };
    const review = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, {
      ...context(),
      nutrition: { rows: [unresolvedOnion], summary: null, unsaved: true, aiContributions: [withoutWeight] },
      runAiNutrition: undefined,
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect((review.data.ingredients as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: 'ai_estimated_partial', weight_provenance: 'unknown', estimated_weight_grams: null,
    });
  });

  it('refuses a nutrition snapshot whose line handles belong to another recipe revision', async () => {
    const tools = context();
    const stale: ShisoToolContext = {
      ...tools,
      recipe: { ...tools.recipe!, ingredients: [{ text: '1 yellow onion', name: 'yellow onion', line_ref: 'new-revision:onion' }] },
    };
    const review = await executeShisoTool({ tool: 'get_nutrition_review', include_ingredients: true }, stale);
    expect(review).toMatchObject({ ok: false, code: 'stale_recipe' });
  });
});
