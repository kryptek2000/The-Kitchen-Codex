import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseObsidianRecipeMarkdown } from '../../src/utils/markdownParser';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { NUTRIENT_IDS } from '../../src/core/nutritionV2/nutrients';
import { validatesAiSchema } from '../../server/ai/openRouterOutput';
import { ProviderOperationError } from '../../server/ai/providerErrors';
import { shisoNutritionFailureMessage } from '../../src/application/shisoNutritionResponse';

const harness = vi.hoisted(() => ({ response: null as any, calls: [] as any[], selection: null as any }));
vi.mock('../../server/ai/effectiveSelection.js', () => ({
  resolveExecutableTextCandidates: (_operation: unknown, _registry: unknown, selection: unknown) => {
    harness.selection = selection;
    return [{ model: 'liquid/lfm-2.5-2.6b', provider: { generateStructured: async (prompt: string, schema: unknown, options: unknown) => {
      harness.calls.push({ prompt, schema, options });
      if (harness.response instanceof Error) throw harness.response;
      return harness.response;
    } } }];
  },
}));
vi.mock('../../server/ai/providerRegistry.js', () => ({
  getRegisteredProviders: () => [],
  runWithAiFallback: async (options: any) => {
    expect(options.candidates).toHaveLength(1);
    expect(options.candidates[0]).toMatchObject({ singleAttempt: true, terminalOnFailure: true });
    return { result: await options.run(options.candidates[0]) };
  },
}));
vi.mock('../../server/providerDiagnostics.js', () => ({ logModelAttempt: vi.fn(), redactSecrets: (s: string) => s }));
import { estimateRecipeNutrientsWithAi } from '../../server/shiso/aiNutrition';

const recipe = parseObsidianRecipeMarkdown(readFileSync(join(__dirname, '../fixtures/nutritionRepairCochinitaPibil.md'), 'utf8'), 'cochinita.md', 'Recipes/cochinita.md');
const adapted = adaptRecipe(recipe);
if (!adapted.ok) throw new Error('fixture failed adaptation');
const request = { recipe: { title: recipe.title, servings: 8,
  ingredients: adapted.recipe.adapted.map((line, i) => ({ line_ref: line.line_ref, text: recipe.ingredients[i].original! })),
  instructions: recipe.instructions.map(step => step.text),
} };
// Synthetic responses test contracts; these are not nutritional reference data.
const weights = [1814.36948, 45, 120, 60, 18, 2, 1, 12, 0, 220, 9, 448];
function contributions() {
  return request.recipe.ingredients.map((line, i) => ({
    line_ref: line.line_ref, ingredient: line.text, quantity_basis: i === 8 ? 'Discarded cooking wrapper: no edible portion' : `Full authored line: ${line.text}`,
    weight_grams: weights[i], classification: 'ai_estimate', confidence: 'medium', sources: [],
    disposition: i === 8 ? 'excluded' : 'edible',
    exclusion_role: i === 8 ? 'cooking_wrapper' : 'none',
    exclusion_assumption: i === 8 ? 'The banana leaves line and cover the roasting pan; they are discarded and not eaten.' : '',
    assumptions: [i === 8 ? 'Instructions line the pan with leaves; the leaves are not served.' : 'Synthetic fixture estimate; authored mass preserved where stated.'],
    unknown_nutrients: i === 8 ? [] : ['vitamin_b12'],
    nutrients: { calories: { amount: i === 8 ? 0 : 30, unit: 'kcal' }, protein: { amount: i === 8 ? 0 : 1, unit: 'g' } },
  }));
}
beforeEach(() => { harness.calls = []; harness.response = { contributions: contributions() }; });
describe('Cochinita structured nutrition boundary', () => {
  it('does not dispatch a nutrition provider call when cancellation already occurred', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await estimateRecipeNutrientsWithAi(request, undefined, controller.signal);
    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(harness.calls).toHaveLength(0);
  });

  it('passes cancellation into the pending nutrition provider and rejects its late result', async () => {
    const controller = new AbortController();
    let resolveResponse!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { resolveResponse = resolve; });
    harness.response = pending;
    const result = estimateRecipeNutrientsWithAi(request, undefined, controller.signal);
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    expect((harness.calls[0]!.options as { signal?: AbortSignal }).signal).toBe(controller.signal);
    controller.abort();
    resolveResponse({ contributions: contributions() });
    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(harness.calls).toHaveLength(1);
  });

  it('accepts schema-defined nullable optionals without turning unknowns into zero', async () => {
    harness.response.contributions = contributions().map(row => ({ ...row,
      nutrients: { ...Object.fromEntries(NUTRIENT_IDS.map(id => [id, null])), ...row.nutrients },
    }));
    harness.response.contributions[1].weight_grams = null;
    const selection = { providerId: 'openrouter', model: 'liquid/lfm-2.5-2.6b', credentialSource: 'session_only' } as const;
    const result = await estimateRecipeNutrientsWithAi(request, selection);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contributions).toHaveLength(12);
    expect(result.contributions[0].weight_grams).toBeCloseTo(4 * 453.59237);
    expect(result.contributions[1].weight_grams).toBeUndefined();
    expect(result.contributions[1].nutrients.fiber).toBeUndefined();
    expect(result.contributions[8]).toMatchObject({ weight_grams: 0, nutrients: { calories: { amount: 0 } } });
    expect(result.contributions[8]).toMatchObject({ disposition: 'excluded', exclusion_role: 'cooking_wrapper' });
    expect(result.contributions[8].weight_grams).toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.selection).toEqual(selection);
    expect(harness.calls[0].prompt).toContain(request.recipe.instructions[2]);
    expect(harness.calls[0].options.model).toBe('liquid/lfm-2.5-2.6b');
    expect(harness.calls[0].schema.properties.contributions.items.properties.nutrients.type).toBe('array');
  });
  it('accepts the compact provider schema while rejecting duplicate nutrient IDs', async () => {
    harness.response.contributions = contributions().map(row => ({ ...row, nutrients: Object.entries(row.nutrients).map(([id, n]) => ({ id, ...n })) }));
    const result = await estimateRecipeNutrientsWithAi(request);
    expect(result.ok).toBe(true);
    expect(validatesAiSchema(harness.response, harness.calls[0].schema)).toBe(true);
    harness.response.contributions[0].nutrients.push(harness.response.contributions[0].nutrients[0]);
    expect((await estimateRecipeNutrientsWithAi(request)).ok).toBe(false);
  });
  it('accepts an independently usable subset without claiming full coverage', async () => {
    harness.response.contributions = contributions().slice(0, 2);
    const result = await estimateRecipeNutrientsWithAi(request);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contributions).toHaveLength(2);
  });
  it('reproduces the zero-weight contract failure on banana leaves without inferring an exclusion', async () => {
    const wrapper = harness.response.contributions[8];
    Object.assign(wrapper, {
      weight_grams: 0,
      disposition: 'edible',
      exclusion_role: 'none',
      exclusion_assumption: '',
      assumptions: [],
      unknown_nutrients: [],
      nutrients: { calories: { amount: 0, unit: 'kcal' }, protein: { amount: 0, unit: 'g' } },
    });
    const result = await estimateRecipeNutrientsWithAi(request);
    expect(result).toMatchObject({ ok: false, code: 'invalid_response', reason: 'invalid_zero_weight' });
  });
  it('rejects a wrapper row when the model omits the exclusion disposition fields', async () => {
    const wrapper = harness.response.contributions[8];
    wrapper.weight_grams = 0;
    delete wrapper.disposition;
    delete wrapper.exclusion_role;
    delete wrapper.exclusion_assumption;
    const result = await estimateRecipeNutrientsWithAi(request);
    expect(result).toMatchObject({ ok: false, code: 'invalid_response', reason: 'invalid_disposition' });
  });
  it.each(['wrong-unit', 'foreign-line', 'duplicate-line', 'unknown-null', 'zero-without-exclusion', 'unsupported-exclusion', 'zero-with-calories', 'invented-source'])('rejects %s', async problem => {
    const row = harness.response.contributions[0];
    if (problem === 'wrong-unit') row.nutrients.calories.unit = 'g';
    if (problem === 'foreign-line') row.line_ref = 'unrelated';
    if (problem === 'duplicate-line') harness.response.contributions.push(row);
    if (problem === 'unknown-null') row.nutrients.secret = null;
    if (problem === 'zero-without-exclusion') { row.weight_grams = 0; row.disposition = 'edible'; row.exclusion_role = 'none'; row.exclusion_assumption = ''; }
    if (problem === 'unsupported-exclusion') {
      Object.assign(row, { weight_grams: 0, disposition: 'excluded', exclusion_role: 'cooking_wrapper', exclusion_assumption: 'This item is discarded and not eaten.', unknown_nutrients: [], nutrients: { calories: { amount: 0, unit: 'kcal' } } });
    }
    if (problem === 'zero-with-calories') { const wrapper = harness.response.contributions[8]; wrapper.weight_grams = 0; wrapper.nutrients.calories.amount = 15; }
    if (problem === 'invented-source') row.sources = [{ title: 'Invented', url: 'https://example.org' }];
    const result = await estimateRecipeNutrientsWithAi(request);
    expect(result.ok).toBe(false);
    expect(harness.calls).toHaveLength(1);
  });
  it('reports bounded truncation diagnostics without exposing provider content or retrying', async () => {
    harness.response = new ProviderOperationError('INVALID_RESPONSE', 'private response content', { responseFailure: 'output_truncated' });
    const result = await estimateRecipeNutrientsWithAi(request);
    expect(result).toEqual({ ok: false, code: 'provider_error', reason: 'output_truncated' });
    expect(shisoNutritionFailureMessage('provider_error', 'output_truncated')).toContain('stopped before finishing');
    expect(shisoNutritionFailureMessage('provider_error', 'secret')).not.toContain('secret');
    expect(harness.calls).toHaveLength(1);
  });
});
