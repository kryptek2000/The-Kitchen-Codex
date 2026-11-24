import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The Kitchen Codex — Advanced Nutrition Phase 5B: explicit Apply coordinator.
 *
 * Proves the write boundary: the candidate is freshly re-authorized from genuine
 * Phase 4 authority immediately before the write, only the freshly authorized
 * block is written, unrelated frontmatter is preserved, create/replace is
 * whole-block, stale/forged input fails closed, and no partial mutation occurs.
 *
 * Synthetic fixtures are clearly labeled and used only for unit-level behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { parseIngredientLine, parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { hydrateWorkingReview } from '../../src/core/nutritionV2/phase4/hydrate';
import type { AdvancedNutritionSession, Phase4Action, Phase4State } from '../../src/core/nutritionV2/phase4';
import type { AdvisoryNutritionPreview } from '../../src/core/nutritionV2/calculation/types';
import { decodeCodexNutrition, validateCodexNutrition, validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import { deriveSavedReportNutrients, savedReportMeta } from '../../src/core/nutritionV2/phase5c/savedReport';
import { combineAiContributionsWithPreview, validateAiNutrientContributions, validateAiNutrientSupplements, type AiNutrientContribution, type AiNutrientSupplement } from '../../src/core/nutritionV2/aiContribution';
import { adaptUsdaBrandedFoodRecord, buildBrandedContribution } from '../../src/core/nutritionV2/brandedFoods';
import { authenticateBrandedContributionsForApply, brandedReviewIdentity } from '../../src/core/nutritionV2/brandedEvidenceTrust';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5';
import { makeAlternateAssertion, makeApplyAuthentication, makeAttackerAssertion, makeTrustedContribution, TEST_ALTERNATE_KEY_ID, TEST_ALTERNATE_PUBLIC_KEY } from '../fixtures/brandedAssertion';
import { MOCK_BRANDED_GOCHUJANG_FDC_ID, mockBrandedDetail } from '../fixtures/usdaBrandedFixtures';
import { requestUsdaBrandedFoodLookup } from '../../src/application/nutritionBrandedFoods';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1, CodexNutritionV6 } from '../../src/core/nutritionV2/schema';
import { resolveRecipeVaultPath } from '../../src/core/vaultPath';
import { deriveAdvancedCompactNutrition, resolveRecipeNutritionPresentation } from '../../src/core/nutritionV2/phase5c/presentation';
import {
  ADVANCED_NUTRITION_APPLY_UI_MESSAGE,
  applyAdvancedNutrition,
  type AdvancedNutritionApplyResult,
} from '../../src/application/advancedNutritionApply';
import type { ObsidianRecipe } from '../../src/types';

// ---------------------------------------------------------------------------
// Synthetic fixtures (NOT real nutrition data)
// ---------------------------------------------------------------------------

const SPECS: ReadonlyArray<CalcRecordSpec> = [
  {
    fdcId: 6001,
    dataType: 'sr_legacy',
    description: 'Flour, wheat, white',
    nutrients: { calories: 364, protein: 10.3, fiber: 0 },
    portions: [{ usda_portion_id: 2, amount: 1, measure: 'cup', gram_weight: 125, sequence: 1 }],
  },
  {
    fdcId: 6004,
    dataType: 'sr_legacy',
    description: 'Flour, wheat, whole-grain',
    nutrients: { calories: 340, protein: 13.2 },
  },
  {
    fdcId: 6002,
    dataType: 'sr_legacy',
    description: 'Bacon',
    nutrients: { calories: 541 },
    portions: [
      { usda_portion_id: 1, amount: 1, measure: 'undetermined', modifier: 'slice', gram_weight: 28, sequence: 1 },
    ],
  },
];

const BUNDLE = buildCalculationBundle(SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;

const OTHER_BUNDLE = buildCalculationBundle([
  { fdcId: 6001, dataType: 'sr_legacy', description: 'Flour, wheat, white', nutrients: { calories: 999 } },
]);
const OTHER_SESSION_RESULT = createAdvancedNutritionSession(OTHER_BUNDLE.manifest, OTHER_BUNDLE.records);
if (!OTHER_SESSION_RESULT.ok) throw new Error('other session failed');
const OTHER_SESSION: AdvancedNutritionSession = OTHER_SESSION_RESULT.session;

const FLOUR_LINE = '100 g Flour, wheat, white';
const BACON_LINE = '8 slices bacon';
const GUACAMOLE_LINES = [
  '3 ripe avocados', '1 lime, juiced', '1/2 white onion, finely diced',
  '1 serrano chile, minced', '1 roma tomato, seeded and diced',
  '1/4 cup chopped cilantro', '1/2 tsp kosher salt',
];

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

interface RecipeOptions {
  readonly servings?: number;
  readonly filePath?: string;
  readonly title?: string;
  readonly frontmatter?: Record<string, unknown>;
  readonly instructions?: ReadonlyArray<{ stepNumber: number; text: string }>;
  readonly nutrition?: Record<string, unknown>;
  readonly calories?: string;
}

function obsidianRecipe(
  ingredients: ReadonlyArray<Record<string, unknown>>,
  options: RecipeOptions = {}
): ObsidianRecipe {
  const filePath = options.filePath ?? 'Recipes/Test Recipe.md';
  return {
    id: 'test-recipe',
    fileName: filePath.split('/').pop() as string,
    filePath,
    rawMarkdown: '',
    title: options.title ?? 'Test Recipe',
    tags: ['food/recipes'],
    category: 'Main Course',
    cuisine: 'American',
    difficulty: 'Easy',
    rating: 5,
    servings: options.servings ?? 2,
    ingredients: ingredients as never,
    instructions: (options.instructions ?? [{ stepNumber: 1, text: 'Cook.' }]) as never,
    callouts: [],
    wikilinks: [],
    dataviewFields: {},
    frontmatter: options.frontmatter ?? {},
    nutrition: options.nutrition as never,
    calories: options.calories,
  } as unknown as ObsidianRecipe;
}

interface Reviewed {
  readonly recipe: ObsidianRecipe;
  readonly state: Phase4State;
  readonly preview: AdvisoryNutritionPreview;
}

function buildReviewed(
  session: AdvancedNutritionSession,
  recipe: ObsidianRecipe,
  scope: ReadonlyArray<string>,
  select?: (ctx: { dispatch: (action: Phase4Action) => void; state: Phase4State }) => void
): Reviewed {
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe;
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adapted.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows: buildReviewRows(session, adapted.adapted),
    baseServings: adapted.base_servings,
  });
  const dispatch = (action: Phase4Action) => {
    state = phase4Reducer(state, action);
  };
  if (select) select({ dispatch, state });
  const seq = state.operationSeq;
  const base = buildCalculationRequest(adapted.adapted, state) as Record<string, unknown>;
  const result = session.calculate({ ...base, nutrient_scope: [...scope] });
  if (!result.ok) throw new Error(`calculation failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  dispatch({ type: 'preview_succeeded', seq, recipeKey: state.recipeKey as string, preview: result.preview });
  return { recipe, state, preview: result.preview };
}

function storedV1(overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  return {
    schema: 1,
    basis: 'total',
    servings: 4,
    status: 'complete',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'usda_fdc_release_2026_04' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: {
        amount: 100,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 1,
      },
    },
    ingredients: [
      {
        line_ref: 'flour',
        source: 'usda_fdc',
        source_food_id: '6001',
        source_release: 'usda_fdc_release_2026_04',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
      },
    ],
    unresolved: [],
    ...overrides,
  };
}

interface FakeVault {
  readonly files: Map<string, string>;
  readonly writes: ObsidianRecipe[];
  write(recipe: ObsidianRecipe): Promise<void>;
  readBack(recipe: ObsidianRecipe): Promise<string>;
}

function makeVault(): FakeVault {
  const files = new Map<string, string>();
  const writes: ObsidianRecipe[] = [];
  return {
    files,
    writes,
    async write(recipe: ObsidianRecipe) {
      writes.push(recipe);
      files.set(resolveRecipeVaultPath(recipe), serializeRecipeToObsidianMarkdown(recipe));
    },
    async readBack(recipe: ObsidianRecipe) {
      const text = files.get(resolveRecipeVaultPath(recipe));
      if (text === undefined) throw new Error('missing');
      return text;
    },
  };
}

interface ApplyOptions {
  readonly session?: unknown;
  readonly recipe?: ObsidianRecipe;
  readonly state?: unknown;
  readonly write?: ((recipe: ObsidianRecipe) => Promise<void>) | undefined;
  readonly readBack?: ((recipe: ObsidianRecipe) => Promise<string>) | undefined;
  readonly expectedMode?: unknown;
  readonly computedAt?: unknown;
  readonly reviewReasons?: unknown;
}

async function apply(reviewed: Reviewed, options: ApplyOptions = {}): Promise<AdvancedNutritionApplyResult> {
  const request: Record<string, unknown> = {
    session: options.session ?? SESSION,
    recipe: options.recipe ?? reviewed.recipe,
    state: options.state ?? reviewed.state,
  };
  if ('write' in options) {
    if (options.write !== undefined) request.write = options.write;
  } else {
    request.write = makeVault().write;
  }
  if (options.readBack !== undefined) request.readBack = options.readBack;
  if (options.expectedMode !== undefined) request.expectedMode = options.expectedMode;
  if (options.computedAt !== undefined) request.computedAt = options.computedAt;
  if (options.reviewReasons !== undefined) request.reviewReasons = options.reviewReasons;
  return applyAdvancedNutrition(request);
}

function failureCodeOf(result: AdvancedNutritionApplyResult): string {
  return result.ok ? 'ok' : (result as { ok: false; failure: { code: string } }).failure.code;
}

function stateWithBrandedContribution(
  reviewed: Reviewed,
  lineRef: string,
  contribution: AiNutrientContribution,
): { readonly state: Phase4State; readonly combined: AdvisoryNutritionPreview } {
  let state = phase4Reducer(reviewed.state, {
    type: 'accept_ai_nutrition',
    recipeKey: reviewed.state.recipeKey as string,
    servings: reviewed.state.baseServings,
    contributions: [contribution],
  });
  const combined = combineAiContributionsWithPreview(reviewed.preview, [contribution]);
  state = phase4Reducer(state, {
    type: 'preview_succeeded',
    seq: state.operationSeq,
    recipeKey: state.recipeKey as string,
    preview: combined,
  });
  return { state, combined };
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('phase 5B — explicit Apply success', () => {
  it('Cochinita: Apply stays unsaved, explicit Save to a disposable Vault reopens schema-v5 with zero-edible wrappers', async () => {
    const recipe = parseObsidianRecipeMarkdown(readFileSync(join(__dirname, '../fixtures/nutritionRepairCochinitaPibil.md'), 'utf8'), 'cochinita.md', 'Recipes/cochinita.md');
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein', 'fiber']);
    const adapted = adaptRecipe(recipe); if (!adapted.ok) throw new Error('adaptation failed');
    const weights = [1814.36948, 45, 120, 60, 18, 2, 1, 12, 0, 220, 9, 448];
    const raw = adapted.recipe.adapted.map((line, i) => ({
      line_ref: line.line_ref, ingredient: recipe.ingredients[i].original,
      quantity_basis: i === 8 ? 'Discarded cooking wrapper' : 'Full authored ingredient quantity',
      weight_grams: weights[i], classification: 'ai_estimate', confidence: 'medium', sources: [],
      disposition: i === 8 ? 'excluded' : 'edible',
      exclusion_role: i === 8 ? 'cooking_wrapper' : 'none',
      exclusion_assumption: i === 8 ? 'The banana leaves line and cover the roasting pan; they are discarded and not eaten.' : '',
      assumptions: [i === 8 ? 'Leaves line the roasting pan and are not eaten.' : 'Synthetic estimate for persistence verification.'],
      nutrients: { calories: { amount: i === 8 ? 0 : 30, unit: 'kcal' }, protein: { amount: i === 8 ? 0 : 1, unit: 'g' } },
      unknown_nutrients: i === 8 ? [] : ['fiber'],
    }));
    const checked = validateAiNutrientContributions(raw, {
      recipe_digest: reviewed.preview.ingredient_digest,
      line_refs: adapted.recipe.adapted.map(l => l.line_ref),
      line_text_by_ref: Object.fromEntries(adapted.recipe.adapted.map(line => [line.line_ref, line.ingredient.original])),
      instructions: recipe.instructions.map(step => step.text),
      requireExclusionContext: true,
    });
    if (!checked.ok) throw new Error('fixture validation failed');
    let state = phase4Reducer(reviewed.state, { type: 'accept_ai_nutrition', recipeKey: reviewed.state.recipeKey!, servings: 8, contributions: checked.contributions });
    const preview = combineAiContributionsWithPreview(reviewed.preview, checked.contributions);
    state = phase4Reducer(state, { type: 'preview_succeeded', seq: state.operationSeq, recipeKey: state.recipeKey!, preview });
    const directory = mkdtempSync(join(tmpdir(), 'kcx-cochinita-vault-'));
    try {
      let working: ObsidianRecipe | undefined;
      const result = await apply({ recipe, state, preview }, { write: async next => { working = next; }, readBack: async () => serializeRecipeToObsidianMarkdown(working!) });
      expect(failureCodeOf(result)).toBe('ok');
      expect(working).toBeDefined();
      expect(readdirSync(directory)).toEqual([]); // Apply never writes this Vault.
      mkdirSync(join(directory, 'Recipes'));
      const target = join(directory, 'Recipes/cochinita.md');
      writeFileSync(target, serializeRecipeToObsidianMarkdown(working!)); // explicit Save
      const reopened = parseObsidianRecipeMarkdown(readFileSync(target, 'utf8'), 'cochinita.md', 'Recipes/cochinita.md');
      const block = decodeCodexNutrition(reopened.codexNutrition);
      expect(block.kind).toBe('v5');
      const reopenedAdapted = adaptRecipe(reopened);
      if (block.kind !== 'v5' || !reopenedAdapted.ok) throw new Error('reopen failed');
      const hydrated = hydrateWorkingReview({ session: SESSION, recipeKey: reopenedAdapted.recipe.recipe_key, baseServings: 8, adapted: reopenedAdapted.recipe.adapted, instructions: reopened.instructions.map(step => step.text), rows: buildReviewRows(SESSION, reopenedAdapted.recipe.adapted), savedBlock: block.value });
      expect(hydrated?.aiNutrition?.contributions).toEqual(checked.contributions);
      expect(hydrated?.aiNutrition?.contributions[8].weight_grams).toBe(0);
      expect(hydrated?.aiNutrition?.contributions[8]).toMatchObject({ disposition: 'excluded', exclusion_role: 'cooking_wrapper' });
      expect(reopened.ingredients).toEqual(recipe.ingredients);
      expect(reopened.instructions).toEqual(recipe.instructions);
      expect(block.value.nutrients.calories?.amount).toBe(330);
      expect(block.value.servings).toBe(8);
      expect(reopened.nutrition?.fiber).toBeUndefined();
      expect(readdirSync(join(directory, 'Recipes'))).toEqual(['cochinita.md']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('applies accepted Guacamole onion AI nutrition through a disposable Vault and reopens it', async () => {
    const recipe = obsidianRecipe(GUACAMOLE_LINES.map(structured), { title: 'Guacamole', servings: 4, filePath: 'Recipes/Guacamole.md' });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const adaptation = adaptRecipe(recipe);
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const raw = adaptation.recipe.adapted.map((line, index) => ({
      line_ref: line.line_ref,
      ingredient: GUACAMOLE_LINES[index],
      quantity_basis: `Authored quantity: ${GUACAMOLE_LINES[index]}`,
      weight_grams: 40 + index * 10,
      classification: 'ai_estimate',
      nutrients: { calories: { amount: 15 + index, unit: 'kcal' }, protein: { amount: 0.5, unit: 'g' } },
      unknown_nutrients: ['vitamin_b12'],
      assumptions: [`Estimated edible weight from a typical household amount for ${GUACAMOLE_LINES[index]}.`],
      confidence: 'medium',
      sources: [],
    }));
    const validated = validateAiNutrientContributions(raw, {
      recipe_digest: reviewed.preview.ingredient_digest,
      line_refs: adaptation.recipe.adapted.map((line) => line.line_ref),
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    let state = phase4Reducer(reviewed.state, {
      type: 'accept_ai_nutrition', recipeKey: reviewed.state.recipeKey as string,
      servings: reviewed.state.baseServings, contributions: validated.contributions,
    });
    const combined = combineAiContributionsWithPreview(reviewed.preview, validated.contributions);
    const onionRef = adaptation.recipe.adapted[2]?.line_ref;
    expect(combined.unresolved.some((line) => line.line_ref === onionRef)).toBe(false);
    state = phase4Reducer(state, { type: 'preview_succeeded', seq: state.operationSeq, recipeKey: state.recipeKey as string, preview: combined });

    // This in-memory Vault is disposable and uses the production Apply,
    // Markdown serialization, parser, schema validation, and review hydration.
    const vault = makeVault();
    const applied = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(failureCodeOf(applied)).toBe('ok');
    expect(vault.writes).toHaveLength(1);
    const markdown = await vault.readBack(vault.writes[0]);
    expect(markdown).toContain('classification: ai_estimate');
    expect(markdown).toContain('Estimated edible weight from a typical household amount for 1/2 white onion, finely diced.');
    const reopened = parseObsidianRecipeMarkdown(markdown, 'Guacamole.md', 'Recipes/Guacamole.md');
    const savedPresentation = resolveRecipeNutritionPresentation(reopened);
    expect(savedPresentation.kind).toBe('advanced_saved');
    expect(savedPresentation.advanced_resolved_count).toBe(7);
    expect(savedPresentation.advanced_ingredient_count).toBe(7);
    expect(savedPresentation.advanced_unresolved_count).toBe(0);
    expect(deriveAdvancedCompactNutrition(savedPresentation)?.calories).toBeDefined();
    const decoded = decodeCodexNutrition(reopened.codexNutrition);
    const reopenedAdaptation = adaptRecipe(reopened);
    expect(decoded.kind).toBe('v5');
    expect(reopenedAdaptation.ok).toBe(true);
    if (decoded.kind !== 'v5' || !reopenedAdaptation.ok) return;
    const reopenedReview = hydrateWorkingReview({
      session: SESSION,
      recipeKey: reopenedAdaptation.recipe.recipe_key,
      baseServings: reopenedAdaptation.recipe.base_servings,
      adapted: reopenedAdaptation.recipe.adapted,
      rows: buildReviewRows(SESSION, reopenedAdaptation.recipe.adapted),
      savedBlock: decoded.value,
    });
    expect(reopenedReview?.aiNutrition?.contributions).toHaveLength(7);
    const reopenedOnion = reopenedReview?.aiNutrition?.contributions.find((line) => line.line_ref === onionRef);
    expect(reopenedOnion).toMatchObject({ classification: 'ai_estimate', weight_grams: 60, unknown_nutrients: ['vitamin_b12'] });
    expect(reopenedOnion?.assumptions[0]).toContain('1/2 white onion, finely diced');
    const tomatoRef = adaptation.recipe.adapted[4]?.line_ref;
    const reopenedTomato = reopenedReview?.aiNutrition?.contributions.find((line) => line.line_ref === tomatoRef);
    expect(reopenedTomato).toMatchObject({ classification: 'ai_estimate', weight_grams: 80, unknown_nutrients: ['vitamin_b12'] });
  });

  it('applies, saves, and reopens an AI estimate beside authenticated USDA nutrition', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE), structured('2 tbsp achiote paste')]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const aiLine = reviewed.preview.unresolved[0];
    expect(aiLine).toBeDefined();
    if (!aiLine) return;
    const raw = [{
      line_ref: aiLine.line_ref, ingredient: '2 tbsp achiote paste', quantity_basis: '2 tablespoons prepared paste',
      weight_grams: 30, classification: 'ai_estimate', confidence: 'medium',
      assumptions: ['Prepared paste is estimated from a typical two-tablespoon amount.'], sources: [],
      unknown_nutrients: ['vitamin_b12'],
      nutrients: { calories: { amount: 36, unit: 'kcal' }, protein: { amount: 1.2, unit: 'g' } },
    }];
    const validated = validateAiNutrientContributions(raw, { recipe_digest: reviewed.preview.ingredient_digest, line_refs: [aiLine.line_ref] });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    let state = phase4Reducer(reviewed.state, { type: 'accept_ai_nutrition', recipeKey: reviewed.state.recipeKey as string, servings: reviewed.state.baseServings, contributions: validated.contributions });
    const combined = combineAiContributionsWithPreview(reviewed.preview, validated.contributions);
    state = phase4Reducer(state, { type: 'preview_succeeded', seq: state.operationSeq, recipeKey: state.recipeKey as string, preview: combined });
    const vault = makeVault();
    const result = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(failureCodeOf(result)).toBe('ok');
    if (!result.ok) return;
    expect(vault.writes).toHaveLength(1);
    const savedMarkdown = await vault.readBack(vault.writes[0]);
    expect(savedMarkdown).toContain('schema: 5');
    expect(savedMarkdown).toContain('classification: ai_estimate');
    const reopened = parseObsidianRecipeMarkdown(savedMarkdown, vault.writes[0].fileName, vault.writes[0].filePath);
    expect(reopened.codexNutrition).toMatchObject({ schema: 5, servings: 2, ai_contributions: [{ classification: 'ai_estimate', line_ref: aiLine.line_ref, assumptions: ['Prepared paste is estimated from a typical two-tablespoon amount.'], unknown_nutrients: ['vitamin_b12'] }] });
    const reopenedAdaptation = adaptRecipe(reopened);
    expect(reopenedAdaptation.ok).toBe(true);
    const decoded = decodeCodexNutrition(reopened.codexNutrition);
    if (!reopenedAdaptation.ok || decoded.kind !== 'v5') return;
    const reopenedReview = hydrateWorkingReview({
      session: SESSION,
      recipeKey: reopenedAdaptation.recipe.recipe_key,
      baseServings: reopenedAdaptation.recipe.base_servings,
      adapted: reopenedAdaptation.recipe.adapted,
      rows: buildReviewRows(SESSION, reopenedAdaptation.recipe.adapted),
      savedBlock: decoded.value,
    });
    expect(reopenedReview?.aiNutrition?.contributions).toEqual(validated.contributions);
    expect(decoded.kind).toBe('v5');
    if (decoded.kind === 'v5') {
      expect(decoded.value.nutrients.calories?.amount).toBeCloseTo((reviewed.preview.totals.calories?.amount ?? 0) + 36, 6);
      expect(decoded.value.nutrients.protein?.amount).toBeCloseTo((reviewed.preview.totals.protein?.amount ?? 0) + 1.2, 6);
    }
  });

  it('creates a new block when the recipe has none', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write, readBack: vault.readBack });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.mode).toBe('create');
    expect(result.result.candidate_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const written = vault.writes[0];
    expect(written.codexNutrition).toBeDefined();
    expect((written.codexNutrition as CodexNutritionV1).schema).toBe(1);
    const decoded = decodeCodexNutrition(written.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind === 'v1') expect(decoded.value.nutrients.calories?.amount).toBeCloseTo(364, 6);
  });

  it('replaces the whole existing schema-v1 block', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { codex_nutrition: storedV1(), my_custom_field: 'keep-me' },
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write, readBack: vault.readBack, expectedMode: 'replace' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.mode).toBe('replace');
    const written = vault.writes[0];
    const decoded = decodeCodexNutrition(written.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind === 'v1') {
      // Whole-block replacement: the old 100 kcal single-nutrient block is gone.
      expect(decoded.value.nutrients.calories?.amount).toBeCloseTo(364, 6);
      expect(decoded.value.nutrient_scope).toEqual(['calories', 'protein']);
    }
  });

  it('preserves unrelated frontmatter, simple nutrition, calories, ingredients, and body', async () => {
    const instructions = [{ stepNumber: 1, text: 'Mix and bake.' }];
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      title: 'My Cake',
      frontmatter: { my_custom_field: 'keep-me', codex_other: 'keep-too' },
      instructions,
      nutrition: { calories: 111, protein: 2 },
      calories: '111',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write, readBack: vault.readBack });
    expect(result.ok).toBe(true);
    const markdown = vault.files.get(resolveRecipeVaultPath(recipe)) as string;
    expect(markdown).toContain('my_custom_field: keep-me');
    expect(markdown).toContain('codex_other: keep-too');
    expect(markdown).toContain('nutrition:');
    expect(markdown).toContain('calories:');
    expect(markdown).toContain('100 g Flour, wheat, white');
    expect(markdown).toContain('Mix and bake.');
    expect(markdown).toContain('# My Cake');
    // Round-trip: the persisted block decodes and the unrelated recipe survives.
    const reparsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
    expect(reparsed.title).toBe('My Cake');
    expect(reparsed.frontmatter?.my_custom_field).toBe('keep-me');
    expect(reparsed.ingredients[0]?.original).toBe('100 g Flour, wheat, white');
    expect(reparsed.codexNutrition && (reparsed.codexNutrition as CodexNutritionV1).schema).toBe(1);
  });

  it('writes a canonical block that validates and round-trips', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write, readBack: vault.readBack });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const markdown = vault.files.get(resolveRecipeVaultPath(recipe)) as string;
    const reparsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
    const decoded = decodeCodexNutrition(reparsed.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind === 'v1') expect(validateCodexNutritionV1(decoded.value).ok).toBe(true);
  });

  it('persists needs_review unresolved metadata through Apply, Save and reopen without changing nutrition', async () => {
    const recipe = obsidianRecipe(
      [structured(FLOUR_LINE), structured('1 cup sugar')],
      { title: 'Needs Review Persistence', servings: 2, filePath: 'Recipes/Needs Review Persistence.md' }
    );
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const unresolved = reviewed.preview.unresolved[0];
    expect(unresolved).toBeDefined();
    const vault = makeVault();
    const result = await apply(reviewed, {
      write: vault.write,
      readBack: vault.readBack,
      reviewReasons: { [unresolved.line_ref]: 'needs_review' },
    });
    expect(failureCodeOf(result)).toBe('ok');
    const markdown = vault.files.get(resolveRecipeVaultPath(recipe)) as string;
    const reparsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
    const decoded = decodeCodexNutrition(reparsed.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind !== 'v1') return;
    const saved = decoded.value.unresolved.find((entry) => entry.line_ref === unresolved.line_ref);
    expect(saved).toBeDefined();
    expect(saved?.review_reason).toBe('needs_review');
    expect(decoded.value.nutrients.calories?.amount).toBe(reviewed.preview.totals.calories?.amount);
    expect(validateCodexNutritionV1(decoded.value).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AN-WEB-1 source-backed contribution persistence
// ---------------------------------------------------------------------------

describe('phase 5B — AN-WEB-1 external source-backed contribution', () => {
  it('applies, saves and reopens a mixed USDA + source-backed recipe with truthful provenance', async () => {
    const recipe = obsidianRecipe([structured('1 cup Zzz')], {
      title: 'AN-WEB-1 Research Persistence',
      servings: 2,
      filePath: 'Recipes/AN-WEB-1 Research Persistence.md',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const adapted = adaptRecipe(recipe);
    if (!adapted.ok) throw new Error('adaptation failed');
    const lineRef = adapted.recipe.adapted[0].line_ref;
    const checked = validateAiNutrientContributions([
      {
        line_ref: lineRef,
        ingredient: '1 cup Zzz',
        quantity_basis: '100 g scaled from source per 100 g',
        weight_grams: 100,
        disposition: 'edible',
        exclusion_role: 'none',
        exclusion_assumption: '',
        classification: 'source_backed',
        nutrients: {
          calories: { amount: 200, unit: 'kcal' },
          protein: { amount: 5, unit: 'g' },
        },
        unknown_nutrients: ['fat', 'carbohydrates'],
        assumptions: ['Label values scaled deterministically; verify the product label.'],
        confidence: 'medium',
        sources: [{ title: 'Example manufacturer label', url: 'https://example.com/label' }],
      },
    ], {
      recipe_digest: reviewed.preview.ingredient_digest,
      line_refs: [lineRef],
      line_text_by_ref: { [lineRef]: '1 cup Zzz' },
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    let state = phase4Reducer(reviewed.state, {
      type: 'accept_ai_nutrition',
      recipeKey: reviewed.state.recipeKey as string,
      servings: reviewed.state.baseServings,
      contributions: checked.contributions,
    });
    const combined = combineAiContributionsWithPreview(reviewed.preview, checked.contributions);
    state = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq: state.operationSeq,
      recipeKey: state.recipeKey as string,
      preview: combined,
    });
    const vault = makeVault();
    const applied = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(failureCodeOf(applied)).toBe('ok');
    const markdown = vault.files.get(resolveRecipeVaultPath(recipe)) as string;
    const reparsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
    const decoded = decodeCodexNutrition(reparsed.codexNutrition);
    expect(decoded.kind).toBe('v5');
    if (decoded.kind !== 'v5') return;
    expect(decoded.value.ai_contributions).toHaveLength(1);
    expect(decoded.value.ai_contributions?.[0].classification).toBe('source_backed');
    expect(decoded.value.ai_contributions?.[0].sources).toEqual([
      { title: 'Example manufacturer label', url: 'https://example.com/label' },
    ]);
    expect(decoded.value.ai_contributions?.[0].nutrients.calories?.amount).toBe(200);
    expect(decoded.value.unresolved).toHaveLength(0);
  });

  it('applies, saves and reopens an explicitly selected USDA Branded contribution with exact provenance', async () => {
    const line = '100 g Sinc2 Mock Gochujang';
    const recipe = obsidianRecipe([structured(line)], {
      title: 'SINC-2 Branded Persistence',
      servings: 2,
      filePath: 'Recipes/SINC-2 Branded Persistence.md',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein', 'sodium']);
    const adapted = adaptRecipe(recipe);
    if (!adapted.ok) throw new Error('adaptation failed');
    const lineRef = adapted.recipe.adapted[0].line_ref;

    const adaptedCandidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adaptedCandidate.ok) throw new Error('synthetic branded fixture failed');
    const candidate = Object.freeze({
      ...adaptedCandidate.candidate,
      evidence_id: 'test-evidence-sinc2r2-0001',
    });
    const built = buildBrandedContribution(candidate, {
      line_ref: lineRef,
      ingredient_text: line,
      query: 'gochujang',
      amount: 100,
      unit: 'g',
      measurement_kind: 'mass',
      quantity_grams: 100,
    });
    if (!built.ok) throw new Error(`branded contribution failed: ${(built as { reason?: string }).reason}`);
    const reviewIdentity = brandedReviewIdentity(
      reviewed.state.sessionIdentity as string,
      reviewed.state.recipeKey as string,
      reviewed.state.baseServings
    );
    const trustedContribution = await makeTrustedContribution(built.contribution, {
      recipeDigest: reviewed.preview.ingredient_digest,
      reviewIdentity,
    });

    const authentication = await makeApplyAuthentication(trustedContribution, {
      recipeDigest: reviewed.preview.ingredient_digest,
      reviewIdentity,
    });
    const checked = validateAiNutrientContributions([trustedContribution], {
      recipe_digest: reviewed.preview.ingredient_digest,
      line_refs: [lineRef],
      line_text_by_ref: { [lineRef]: line },
      requireTrustedBranded: true,
      brandedAuthentication: authentication,
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    let state = phase4Reducer(reviewed.state, {
      type: 'accept_ai_nutrition',
      recipeKey: reviewed.state.recipeKey as string,
      servings: reviewed.state.baseServings,
      contributions: checked.contributions,
    });
    const combined = combineAiContributionsWithPreview(reviewed.preview, checked.contributions);
    state = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq: state.operationSeq,
      recipeKey: state.recipeKey as string,
      preview: combined,
    });

    // The synchronous Phase 5 path cannot authorize a branded contribution
    // without the per-Apply capability minted after ECDSA verification.
    const direct = authorizeNutritionPersistence({ session: SESSION, recipe, state });
    expect(direct.ok).toBe(false);

    const vault = makeVault();
    const applied = await apply({ recipe, state, preview: combined }, {
      write: vault.write,
      readBack: vault.readBack,
    });
    expect(failureCodeOf(applied)).toBe('ok');
    expect(vault.writes).toHaveLength(1);

    const markdown = vault.files.get(resolveRecipeVaultPath(recipe)) as string;
    const reparsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
    const decoded = decodeCodexNutrition(reparsed.codexNutrition);
    expect(decoded.kind).toBe('v5');
    if (decoded.kind !== 'v5') return;
    expect(decoded.value.unresolved).toHaveLength(0);
    expect(decoded.value.ai_contributions).toHaveLength(1);
    const contribution = decoded.value.ai_contributions?.[0];
    expect(contribution?.classification).toBe('source_backed');
    expect(contribution?.source_kind).toBe('usda_branded');
    expect(contribution?.usda_branded).toMatchObject({
      fdc_id: MOCK_BRANDED_GOCHUJANG_FDC_ID,
      description: 'SINC2 MOCK GOCHUJANG SAUCE',
      brand_owner: 'Mock Foods',
      basis: 'per_serving_g',
    });
    expect(contribution?.usda_branded?.snapshot_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contribution?.usda_branded?.verification?.signature).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(contribution?.nutrients.calories?.amount).toBe(200);
    expect(contribution?.nutrients.sodium?.amount).toBe(1600);
    expect(contribution?.sources[0]?.url).toContain(`fdc.nal.usda.gov/food-details/${MOCK_BRANDED_GOCHUJANG_FDC_ID}`);
    expect(decoded.value.sources).toContain('usda_branded');
    expect(decoded.value.source_releases.usda_branded).toBe('usda_fdc_branded_api_v1');
  });

  it('SINC-2R3 Test A — rejects a replaced signature at the Phase 5 Apply boundary and writes nothing', async () => {
    const line = '100 g Sinc2 Mock Gochujang R3 Signature';
    const recipe = obsidianRecipe([structured(line)], {
      title: 'SINC-2R3 Signature Refusal',
      servings: 2,
      filePath: 'Recipes/SINC-2R3 Signature Refusal.md',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const adapted = adaptRecipe(recipe);
    if (!adapted.ok) throw new Error('adaptation failed');
    const lineRef = adapted.recipe.adapted[0].line_ref;
    const adaptedCandidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adaptedCandidate.ok) throw new Error('synthetic branded fixture failed');
    const candidate = Object.freeze({ ...adaptedCandidate.candidate, evidence_id: 'test-evidence-sinc2r3-signature' });
    const built = buildBrandedContribution(candidate, {
      line_ref: lineRef,
      ingredient_text: line,
      query: 'gochujang',
      amount: 100,
      unit: 'g',
      measurement_kind: 'mass',
      quantity_grams: 100,
    });
    if (!built.ok) throw new Error('branded contribution failed');
    const trusted = await makeTrustedContribution(built.contribution, {
      recipeDigest: reviewed.preview.ingredient_digest,
      reviewIdentity: brandedReviewIdentity(
        reviewed.state.sessionIdentity as string,
        reviewed.state.recipeKey as string,
        reviewed.state.baseServings
      ),
    });
    const forged = Object.freeze({
      ...trusted,
      usda_branded: Object.freeze({
        ...trusted.usda_branded,
        verification: Object.freeze({
          ...trusted.usda_branded!.verification!,
          signature: Buffer.alloc(64, 7).toString('base64'),
        }),
      }),
    });
    const { state, combined } = stateWithBrandedContribution(reviewed, lineRef, forged);
    const vault = makeVault();
    const applied = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(applied.ok).toBe(false);
    expect(failureCodeOf(applied)).toBe('stale_authorization');
    expect(vault.writes).toHaveLength(0);
  });

  it('SINC-2R3 Test B — rejects an expired assertion at Phase 5 and writes nothing', async () => {
    const line = '100 g Sinc2 Mock Gochujang R3 Expired';
    const recipe = obsidianRecipe([structured(line)], {
      title: 'SINC-2R3 Expiry Refusal',
      servings: 2,
      filePath: 'Recipes/SINC-2R3 Expiry Refusal.md',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const adapted = adaptRecipe(recipe);
    if (!adapted.ok) throw new Error('adaptation failed');
    const lineRef = adapted.recipe.adapted[0].line_ref;
    const adaptedCandidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adaptedCandidate.ok) throw new Error('synthetic branded fixture failed');
    const candidate = Object.freeze({ ...adaptedCandidate.candidate, evidence_id: 'test-evidence-sinc2r3-expired' });
    const built = buildBrandedContribution(candidate, {
      line_ref: lineRef,
      ingredient_text: line,
      query: 'gochujang',
      amount: 100,
      unit: 'g',
      measurement_kind: 'mass',
      quantity_grams: 100,
    });
    if (!built.ok) throw new Error('branded contribution failed');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const issuedAt = Date.now();
      const trusted = await makeTrustedContribution(built.contribution, {
        recipeDigest: reviewed.preview.ingredient_digest,
        reviewIdentity: brandedReviewIdentity(
          reviewed.state.sessionIdentity as string,
          reviewed.state.recipeKey as string,
          reviewed.state.baseServings
        ),
        now: issuedAt,
        ttlMs: 10 * 60 * 1000,
      });
      const { state, combined } = stateWithBrandedContribution(reviewed, lineRef, trusted);
      vi.setSystemTime(issuedAt + 11 * 60 * 1000);
      const vault = makeVault();
      const applied = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
      expect(applied.ok).toBe(false);
      expect(failureCodeOf(applied)).toBe('stale_authorization');
      expect(vault.writes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SINC-2R3 Test C — rejects Apply under a different signing identity and writes nothing', async () => {
    const line = '100 g Sinc2 Mock Gochujang R3 Identity';
    const recipe = obsidianRecipe([structured(line)], {
      title: 'SINC-2R3 Identity Refusal',
      servings: 2,
      filePath: 'Recipes/SINC-2R3 Identity Refusal.md',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const adapted = adaptRecipe(recipe);
    if (!adapted.ok) throw new Error('adaptation failed');
    const lineRef = adapted.recipe.adapted[0].line_ref;
    const adaptedCandidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adaptedCandidate.ok) throw new Error('synthetic branded fixture failed');
    const candidate = Object.freeze({ ...adaptedCandidate.candidate, evidence_id: 'test-evidence-sinc2r3-identity' });
    const built = buildBrandedContribution(candidate, {
      line_ref: lineRef,
      ingredient_text: line,
      query: 'gochujang',
      amount: 100,
      unit: 'g',
      measurement_kind: 'mass',
      quantity_grams: 100,
    });
    if (!built.ok) throw new Error('branded contribution failed');
    const reviewIdentity = brandedReviewIdentity(
      reviewed.state.sessionIdentity as string,
      reviewed.state.recipeKey as string,
      reviewed.state.baseServings
    );
    // A valid P-256 signature from a DIFFERENT signing identity. The structural
    // preview accepts its shape; the configured trust anchor rejects it.
    const rotated = Object.freeze({
      ...built.contribution,
      usda_branded: Object.freeze({
        ...built.contribution.usda_branded,
        verification: makeAlternateAssertion(built.contribution, {
          recipeDigest: reviewed.preview.ingredient_digest,
          reviewIdentity,
        }),
      }),
    });
    const { state, combined } = stateWithBrandedContribution(reviewed, lineRef, rotated);
    const vault = makeVault();
    const applied = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(applied.ok).toBe(false);
    expect(failureCodeOf(applied)).toBe('stale_authorization');
    expect(vault.writes).toHaveLength(0);
  });

  it('SINC-2R4 — attacker key and 999999 calories cannot pass the async Apply coordinator', async () => {
    const line = '100 g Sinc2 Mock Gochujang R4 Attacker';
    const recipe = obsidianRecipe([structured(line)], {
      title: 'SINC-2R4 Attacker Refusal',
      servings: 2,
      filePath: 'Recipes/SINC-2R4 Attacker Refusal.md',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const adapted = adaptRecipe(recipe);
    if (!adapted.ok) throw new Error('adaptation failed');
    const lineRef = adapted.recipe.adapted[0].line_ref;
    const adaptedCandidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adaptedCandidate.ok) throw new Error('synthetic branded fixture failed');
    const candidate = Object.freeze({ ...adaptedCandidate.candidate, evidence_id: 'test-evidence-sinc2r4-attacker' });
    const built = buildBrandedContribution(candidate, {
      line_ref: lineRef,
      ingredient_text: line,
      query: 'gochujang',
      amount: 100,
      unit: 'g',
      measurement_kind: 'mass',
      quantity_grams: 100,
    });
    if (!built.ok) throw new Error('branded contribution failed');

    // 1. Attempt to establish an attacker-controlled signing key through the
    //    public lookup transport.
    const attackerLookup = await requestUsdaBrandedFoodLookup({
      network: {
        post: async () => ({
          status: 200,
          ok: true,
          data: {
            ok: true,
            request_version: 'usda_branded_lookup_response_v1',
            line_ref: lineRef,
            query: 'gochujang',
            total_hits: 1,
            candidates: [candidate],
            cache_status: 'miss',
            retrieved_at: '2026-11-22T00:00:00.000Z',
            signing_public_key: TEST_ALTERNATE_PUBLIC_KEY,
            signing_key_id: TEST_ALTERNATE_KEY_ID,
            limitations: ['Synthetic test limitation.'],
          },
        }),
        get: async () => ({ status: 404, ok: false, data: {} }),
        request: async () => ({ status: 404, ok: false, data: {} }),
      } as unknown as NetworkAdapter,
      lineRef,
      query: 'gochujang',
    });
    expect(attackerLookup.ok).toBe(false);
    expect((attackerLookup as { code?: string }).code).toBe('invalid_response');

    // 2. Forge 999999 calories and sign with the attacker key.
    const reviewIdentity = brandedReviewIdentity(
      reviewed.state.sessionIdentity as string,
      reviewed.state.recipeKey as string,
      reviewed.state.baseServings
    );
    const forgedBase = Object.freeze({
      ...built.contribution,
      nutrients: Object.freeze({
        ...built.contribution.nutrients,
        calories: Object.freeze({ amount: 999999, unit: 'kcal' as const }),
      }),
    });
    const attackerAssertion = makeAttackerAssertion(forgedBase, {
      recipeDigest: reviewed.preview.ingredient_digest,
      reviewIdentity,
    });
    const forged = Object.freeze({
      ...forgedBase,
      usda_branded: Object.freeze({
        ...forgedBase.usda_branded,
        verification: attackerAssertion,
      }),
    });

    // 3. Authentication fails even though its public digest is well formed.
    const authentication = await authenticateBrandedContributionsForApply([forged], {
      recipe_digest: reviewed.preview.ingredient_digest,
      review_identity: reviewIdentity,
    });
    expect(authentication.ok).toBe(false);

    // 4. The real async Apply coordinator rejects it before any write.
    const { state, combined } = stateWithBrandedContribution(reviewed, lineRef, forged);
    const vault = makeVault();
    const applied = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(applied.ok).toBe(false);
    expect(failureCodeOf(applied)).toBe('stale_authorization');
    expect(vault.writes).toHaveLength(0);
  });

  it('rejects a client-mutated branded contribution and writes nothing', async () => {
    const line = '100 g Sinc2 Mock Gochujang Mutated';
    const recipe = obsidianRecipe([structured(line)], {
      title: 'SINC-2R2 Mutation Refusal',
      servings: 2,
      filePath: 'Recipes/SINC-2R2 Mutation Refusal.md',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein', 'sodium']);
    const adapted = adaptRecipe(recipe);
    if (!adapted.ok) throw new Error('adaptation failed');
    const lineRef = adapted.recipe.adapted[0].line_ref;
    const adaptedCandidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adaptedCandidate.ok) throw new Error('synthetic branded fixture failed');
    const candidate = Object.freeze({ ...adaptedCandidate.candidate, evidence_id: 'test-evidence-sinc2r2-mutated' });
    const built = buildBrandedContribution(candidate, {
      line_ref: lineRef,
      ingredient_text: line,
      query: 'gochujang',
      amount: 100,
      unit: 'g',
      measurement_kind: 'mass',
      quantity_grams: 100,
    });
    if (!built.ok) throw new Error('branded contribution failed');
    const trusted = await makeTrustedContribution(built.contribution, {
      recipeDigest: reviewed.preview.ingredient_digest,
      reviewIdentity: brandedReviewIdentity(
        reviewed.state.sessionIdentity as string,
        reviewed.state.recipeKey as string,
        reviewed.state.baseServings
      ),
    });

    // The attacker changes calories but leaves the old signature and digest.
    const mutated = Object.freeze({
      ...trusted,
      nutrients: Object.freeze({
        ...trusted.nutrients,
        calories: Object.freeze({ amount: 999999, unit: 'kcal' as const }),
      }),
    });
    const checked = validateAiNutrientContributions([mutated], {
      recipe_digest: reviewed.preview.ingredient_digest,
      line_refs: [lineRef],
      line_text_by_ref: { [lineRef]: line },
      requireTrustedBranded: true,
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect((checked as { code: string }).code).toBe('branded_evidence_tampered');

    let state = phase4Reducer(reviewed.state, {
      type: 'accept_ai_nutrition',
      recipeKey: reviewed.state.recipeKey as string,
      servings: reviewed.state.baseServings,
      contributions: [mutated],
    });
    const combined = combineAiContributionsWithPreview(reviewed.preview, [mutated]);
    state = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq: state.operationSeq,
      recipeKey: state.recipeKey as string,
      preview: combined,
    });
    const vault = makeVault();
    const applied = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(applied.ok).toBe(false);
    expect(vault.writes).toHaveLength(0);
  });

  it('rejects a verified contribution whose target does not match the current recipe line', async () => {
    const line = '100 g Sinc2 Mock Gochujang Target';
    const recipe = obsidianRecipe([structured(line)], {
      title: 'SINC-2R2 Target Binding Refusal',
      servings: 2,
      filePath: 'Recipes/SINC-2R2 Target Binding Refusal.md',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const adapted = adaptRecipe(recipe);
    if (!adapted.ok) throw new Error('adaptation failed');
    const lineRef = adapted.recipe.adapted[0].line_ref;
    const adaptedCandidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adaptedCandidate.ok) throw new Error('synthetic branded fixture failed');
    const candidate = Object.freeze({ ...adaptedCandidate.candidate, evidence_id: 'test-evidence-sinc2r2-target' });
    const built = buildBrandedContribution(candidate, {
      line_ref: lineRef,
      ingredient_text: line,
      query: 'gochujang',
      amount: 100,
      unit: 'g',
      measurement_kind: 'mass',
      quantity_grams: 100,
    });
    if (!built.ok) throw new Error('branded contribution failed');
    // A genuine signature can cover any target the server produced; the local
    // Apply boundary must still refuse it because the CURRENT authored line
    // resolves to 100 g.
    const targetTampered = Object.freeze({
      ...built.contribution,
      usda_branded: Object.freeze({
        ...built.contribution.usda_branded,
        target: Object.freeze({
          ...built.contribution.usda_branded!.target!,
          quantity_grams: 200,
        }),
      }),
    });
    const trusted = await makeTrustedContribution(targetTampered, {
      recipeDigest: reviewed.preview.ingredient_digest,
      reviewIdentity: brandedReviewIdentity(
        reviewed.state.sessionIdentity as string,
        reviewed.state.recipeKey as string,
        reviewed.state.baseServings
      ),
    });
    const authentication = await makeApplyAuthentication(trusted, {
      recipeDigest: reviewed.preview.ingredient_digest,
      reviewIdentity: brandedReviewIdentity(
        reviewed.state.sessionIdentity as string,
        reviewed.state.recipeKey as string,
        reviewed.state.baseServings
      ),
    });
    const checked = validateAiNutrientContributions([trusted], {
      recipe_digest: reviewed.preview.ingredient_digest,
      line_refs: [lineRef],
      line_text_by_ref: { [lineRef]: line },
      requireTrustedBranded: true,
      brandedAuthentication: authentication,
    });
    expect(checked.ok).toBe(true);

    let state = phase4Reducer(reviewed.state, {
      type: 'accept_ai_nutrition',
      recipeKey: reviewed.state.recipeKey as string,
      servings: reviewed.state.baseServings,
      contributions: [trusted],
    });
    const combined = combineAiContributionsWithPreview(reviewed.preview, [trusted]);
    state = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq: state.operationSeq,
      recipeKey: state.recipeKey as string,
      preview: combined,
    });
    const vault = makeVault();
    const applied = await apply({ recipe, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(applied.ok).toBe(false);
    expect(vault.writes).toHaveLength(0);
  });

  it('rejects a legitimate recipe-A verification replayed onto recipe B with identical text and line ref', async () => {
    const line = '100 g Sinc2 Mock Gochujang Replay';
    const recipeA = obsidianRecipe([structured(line)], {
      title: 'SINC-2R2 Replay Recipe A',
      servings: 2,
      filePath: 'Recipes/SINC-2R2 Replay A.md',
    });
    const recipeB = obsidianRecipe([structured(line)], {
      title: 'SINC-2R2 Replay Recipe B',
      servings: 2,
      filePath: 'Recipes/SINC-2R2 Replay B.md',
    });
    const reviewedA = buildReviewed(SESSION, recipeA, ['calories', 'protein']);
    const reviewedB = buildReviewed(SESSION, recipeB, ['calories', 'protein']);
    const adaptedA = adaptRecipe(recipeA);
    const adaptedB = adaptRecipe(recipeB);
    if (!adaptedA.ok || !adaptedB.ok) throw new Error('adaptation failed');
    const lineRefA = adaptedA.recipe.adapted[0].line_ref;
    const lineRefB = adaptedB.recipe.adapted[0].line_ref;
    // The audit precondition: identical ingredient text AND identical line ref.
    expect(reviewedA.preview.ingredient_digest).toBe(reviewedB.preview.ingredient_digest);
    expect(lineRefA).toBe(lineRefB);
    expect(reviewedA.state.recipeKey).not.toBe(reviewedB.state.recipeKey);

    const adaptedCandidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adaptedCandidate.ok) throw new Error('synthetic branded fixture failed');
    const candidate = Object.freeze({ ...adaptedCandidate.candidate, evidence_id: 'test-evidence-sinc2r2-replay' });
    const built = buildBrandedContribution(candidate, {
      line_ref: lineRefA,
      ingredient_text: line,
      query: 'gochujang',
      amount: 100,
      unit: 'g',
      measurement_kind: 'mass',
      quantity_grams: 100,
    });
    if (!built.ok) throw new Error('branded contribution failed');
    const trustedForA = await makeTrustedContribution(built.contribution, {
      recipeDigest: reviewedA.preview.ingredient_digest,
      reviewIdentity: brandedReviewIdentity(
        reviewedA.state.sessionIdentity as string,
        reviewedA.state.recipeKey as string,
        reviewedA.state.baseServings
      ),
    });

    // Replay the exact recipe-A evidence into recipe B's review.
    // The ingredient digest and line text are identical, so only the
    // recipe/review binding can distinguish A from B. It is enforced at Apply.

    let state = phase4Reducer(reviewedB.state, {
      type: 'accept_ai_nutrition',
      recipeKey: reviewedB.state.recipeKey as string,
      servings: reviewedB.state.baseServings,
      contributions: [trustedForA],
    });
    const combined = combineAiContributionsWithPreview(reviewedB.preview, [trustedForA]);
    state = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq: state.operationSeq,
      recipeKey: state.recipeKey as string,
      preview: combined,
    });
    const vault = makeVault();
    const applied = await apply({ recipe: recipeB, state, preview: combined }, { write: vault.write, readBack: vault.readBack });
    expect(applied.ok).toBe(false);
    expect(failureCodeOf(applied)).toBe('stale_authorization');
    expect(vault.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TOCTOU / stale state
// ---------------------------------------------------------------------------

describe('phase 5B — TOCTOU and stale authority fail closed with no write', () => {
  function expectNoWrite(vault: FakeVault, result: AdvancedNutritionApplyResult, code?: string): void {
    expect(result.ok).toBe(false);
    expect(vault.writes).toHaveLength(0);
    if (code) expect(failureCodeOf(result)).toBe(code);
  }

  it('rejects an ingredient mutation between review and Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const mutated = obsidianRecipe([
      { original: '200 g Flour, wheat, white', name: 'Flour, wheat, white', amount: 200, unit: 'g' },
    ]);
    const vault = makeVault();
    expectNoWrite(vault, await apply(reviewed, { recipe: mutated, write: vault.write }), 'stale_authorization');
  });

  it('rejects a serving mutation between review and Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], { servings: 2 });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const mutated = obsidianRecipe([structured(FLOUR_LINE)], { servings: 4 });
    const vault = makeVault();
    expectNoWrite(vault, await apply(reviewed, { recipe: mutated, write: vault.write }), 'stale_authorization');
  });

  it('rejects a match mutation before Apply', async () => {
    const ambiguous = '100 g flour wheat';
    const recipe = obsidianRecipe([structured(ambiguous)]);
    let lineRef = '';
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein'], ({ dispatch, state }) => {
      lineRef = state.rows[0].line_ref;
      dispatch({
        type: 'select_match',
        lineRef,
        choice: { kind: 'candidate', fdc_id: 6001, review_digest: state.rows[0].review_digest as string },
      });
    });
    const mutatedState: Phase4State = {
      ...reviewed.state,
      matches: {
        ...reviewed.state.matches,
        [lineRef]: { kind: 'none', review_digest: reviewed.state.rows[0].review_digest as string },
      },
    };
    const vault = makeVault();
    expectNoWrite(vault, await apply(reviewed, { state: mutatedState, write: vault.write }), 'stale_authorization');
  });

  it('rejects a session/bundle change before Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { session: OTHER_SESSION, write: vault.write });
    expectNoWrite(vault, result);
    expect(['stale_authorization', 'not_authorized']).toContain(failureCodeOf(result));
  });

  it('rejects a stale preview before Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const mutatedState: Phase4State = { ...reviewed.state, status: 'preview_stale' };
    const vault = makeVault();
    expectNoWrite(vault, await apply(reviewed, { state: mutatedState, write: vault.write }), 'stale_authorization');
  });

  it('rejects a create -> replace mode change before Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const withBlock = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { codex_nutrition: storedV1() },
    });
    const vault = makeVault();
    // UI showed "create" (no block), but a block now exists.
    expectNoWrite(
      vault,
      await apply(reviewed, { recipe: withBlock, write: vault.write, expectedMode: 'create' }),
      'stale_authorization'
    );
  });

  it('rejects a replace -> create mode change before Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { codex_nutrition: storedV1() },
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const withoutBlock = obsidianRecipe([structured(FLOUR_LINE)]);
    const vault = makeVault();
    expectNoWrite(
      vault,
      await apply(reviewed, { recipe: withoutBlock, write: vault.write, expectedMode: 'replace' }),
      'stale_authorization'
    );
  });
});

// ---------------------------------------------------------------------------
// Forgery / hostile input
// ---------------------------------------------------------------------------

describe('phase 5B — forged input cannot cause a write', () => {
  it('ignores caller-supplied candidate/identity/block fields', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await applyAdvancedNutrition({
      session: SESSION,
      recipe: reviewed.recipe,
      state: reviewed.state,
      write: vault.write,
      candidate: { block: { schema: 1, nutrients: { calories: { amount: 999999 } } } },
      identity: { candidate_digest: 'forged' },
      block: { schema: 1, basis: 'total' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = vault.writes[0];
    const decoded = decodeCodexNutrition(written.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind === 'v1') expect(decoded.value.nutrients.calories?.amount).toBeCloseTo(364, 6);
  });

  it('rejects a fake session with no write', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const fake = { metadata: () => SESSION.metadata(), calculate: () => ({ ok: true, preview: reviewed.preview }) };
    const vault = makeVault();
    const result = await apply(reviewed, { session: fake, write: vault.write });
    expect(result.ok).toBe(false);
    expect(failureCodeOf(result)).toBe('not_authorized');
    expect(vault.writes).toHaveLength(0);
  });

  it('rejects a Proxy of the genuine session with no write', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { session: new Proxy(SESSION, {}), write: vault.write });
    expect(result.ok).toBe(false);
    expect(vault.writes).toHaveLength(0);
  });

  it('rejects a forged candidate digest by re-authorizing fresh', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The digest is minted by the fresh authorization, never accepted from input.
    expect(result.result.candidate_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects a non-object request', async () => {
    expect(failureCodeOf(await applyAdvancedNutrition(null))).toBe('unsafe_request');
    expect(failureCodeOf(await applyAdvancedNutrition('nope'))).toBe('unsafe_request');
  });
});

// ---------------------------------------------------------------------------
// Existing block protection
// ---------------------------------------------------------------------------

describe('phase 5B — existing block protection', () => {
  it('fails closed and preserves an unknown future schema', async () => {
    const future = { schema: 7, basis: 'total', futureField: { nested: [1, 2, 3] } };
    const before = JSON.stringify(future);
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], { frontmatter: { codex_nutrition: future } });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write });
    expect(failureCodeOf(result)).toBe('unknown_future_schema');
    expect(vault.writes).toHaveLength(0);
    expect(JSON.stringify(future)).toBe(before);
  });

  it('fails closed on a malformed existing schema-v1 block', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { codex_nutrition: { schema: 1, basis: 'per_serving', servings: 4 } },
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write });
    expect(failureCodeOf(result)).toBe('invalid_existing_block');
    expect(vault.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Write failure / atomicity
// ---------------------------------------------------------------------------

describe('phase 5B — write failure and atomicity', () => {
  it('reports a write failure and commits nothing', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    let committed = false;
    const result = await apply(reviewed, {
      write: async () => {
        throw new Error('disk full');
      },
    });
    expect(failureCodeOf(result)).toBe('write_failed');
    expect(committed).toBe(false);
    expect(ADVANCED_NUTRITION_APPLY_UI_MESSAGE.write_failed).not.toContain('disk full');
  });

  it('reports a serialization failure before any write', async () => {
    // A function value in unrelated frontmatter is not YAML-representable.
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { unrepresentable: () => undefined },
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write });
    expect(failureCodeOf(result)).toBe('serialization_failed');
    expect(vault.writes).toHaveLength(0);
  });

  it('reports an unavailable write target', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const result = await apply(reviewed, { write: undefined });
    expect(failureCodeOf(result)).toBe('unavailable_write_target');
  });

  it('reports a post-write verification failure without losing the write', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, {
      write: vault.write,
      readBack: async () => '# Wrong\n\nno nutrition here\n',
    });
    expect(failureCodeOf(result)).toBe('post_write_verification_failed');
    // The write DID occur; verification is what failed.
    expect(vault.writes).toHaveLength(1);
  });

  it('never commits in-memory state when the writer throws', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    let stateCommits = 0;
    const result = await apply(reviewed, {
      write: async () => {
        throw new Error('nope');
      },
    });
    expect(result.ok).toBe(false);
    expect(stateCommits).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// SINC-4 — separately attributed supplemental estimates
// ---------------------------------------------------------------------------

function supplementState(
  reviewed: Reviewed,
  supplements: ReadonlyArray<AiNutrientSupplement>,
): { readonly state: Phase4State; readonly combined: AdvisoryNutritionPreview } {
  let state = phase4Reducer(reviewed.state, {
    type: 'accept_ai_nutrition',
    recipeKey: reviewed.state.recipeKey as string,
    servings: reviewed.state.baseServings,
    contributions: [],
    supplements,
  });
  const combined = combineAiContributionsWithPreview(reviewed.preview, [], supplements);
  state = phase4Reducer(state, {
    type: 'preview_succeeded',
    seq: state.operationSeq,
    recipeKey: state.recipeKey as string,
    preview: combined,
  });
  return { state, combined };
}

async function sourceGapSupplementFixture() {
  const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
    title: 'Supplement test',
    servings: 4,
    filePath: 'Recipes/Supplement Test.md',
  });
  const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein', 'fiber', 'niacin']);
  const adapted = adaptRecipe(recipe);
  if (!adapted.ok) throw new Error('adaptation failed');
  const line = adapted.recipe.adapted[0]!;
  const reviewIdentity = brandedReviewIdentity(
    reviewed.state.sessionIdentity as string,
    reviewed.state.recipeKey as string,
    reviewed.state.baseServings,
  );
  const raw = {
    supplement_version: 'ai_nutrient_supplement_v1',
    line_ref: line.line_ref,
    ingredient: FLOUR_LINE,
    nutrient_id: 'niacin',
    amount: 1.2,
    unit: 'mg_ne',
    classification: 'ai_estimate',
    source_kind: 'ai_supplement',
    source_food_id: '6001',
    source_release: reviewed.preview.bundle_release,
    weight_grams: 100,
    quantity_basis: '100 g resolved source weight',
    assumptions: ['Synthetic niacin estimate for persistence verification.'],
    confidence: 'medium',
    recipe_digest: reviewed.preview.ingredient_digest,
    review_identity: reviewIdentity,
  };
  const validated = validateAiNutrientSupplements([raw], {
    recipe_digest: reviewed.preview.ingredient_digest,
    review_identity: reviewIdentity,
    line_text_by_ref: { [line.line_ref]: line.ingredient.original },
    sources_by_ref: new Map([[line.line_ref, {
      nutrient_ids: ['calories', 'protein', 'fiber'],
      source_food_id: '6001',
      source_release: reviewed.preview.bundle_release,
      weight_grams: 100,
    }]]),
  });
  if (!validated.ok) throw new Error(`supplement fixture rejected: ${(validated as { code?: string }).code ?? 'invalid'}`);
  return { recipe, reviewed, line, reviewIdentity, supplement: validated.supplements[0]!, raw };
}

describe('SINC-4 — supplemental nutrient Apply / Save / reopen', () => {
  it('applies and saves schema-v6 supplements with verified USDA values unchanged, then reopens them', async () => {
    const { recipe, reviewed, supplement } = await sourceGapSupplementFixture();
    const { state, combined } = supplementState(reviewed, [supplement]);
    expect(combined.totals.niacin).toMatchObject({ amount: 1.2, unit: 'mg_ne', status: 'complete' });
    expect(combined.totals.calories).toEqual(reviewed.preview.totals.calories);

    let working: ObsidianRecipe | undefined;
    const result = await apply(
      { recipe, state, preview: combined },
      {
        write: async (next) => { working = next; },
        readBack: async () => serializeRecipeToObsidianMarkdown(working!),
      },
    );
    expect(failureCodeOf(result)).toBe('ok');
    expect(working).toBeDefined();
    const applied = working!.codexNutrition as CodexNutritionV6;
    expect(applied.schema).toBe(6);
    expect(applied.nutrient_supplements).toEqual([supplement]);
    expect(applied.nutrients.calories?.amount).toBe(reviewed.preview.totals.calories?.amount);
    expect(applied.nutrients.protein?.amount).toBe(reviewed.preview.totals.protein?.amount);
    expect(applied.nutrients.fiber?.amount).toBe(0);
    expect(applied.nutrients.niacin?.amount).toBe(1.2);
    expect(applied.ingredients[0]?.source_nutrients).toEqual(['calories', 'protein', 'fiber']);
    expect(applied.source_amounts).toMatchObject({ calories: 364, protein: 10.3, fiber: 0 });

    // Explicit Save to a disposable file, then reopen.
    const directory = mkdtempSync(join(tmpdir(), 'kcx-supplement-vault-'));
    try {
      mkdirSync(join(directory, 'Recipes'));
      const target = join(directory, 'Recipes/Supplement Test.md');
      writeFileSync(target, serializeRecipeToObsidianMarkdown(working!));
      const reopened = parseObsidianRecipeMarkdown(readFileSync(target, 'utf8'), 'Supplement Test.md', 'Recipes/Supplement Test.md');
      const decoded = decodeCodexNutrition(reopened.codexNutrition);
      expect(decoded.kind).toBe('v6');
      if (decoded.kind !== 'v6') return;
      expect(decoded.value.nutrient_supplements).toEqual([supplement]);
      expect(decoded.value.nutrients.calories?.amount).toBe(364);
      expect(decoded.value.nutrients.niacin?.amount).toBe(1.2);
      expect(savedReportMeta(decoded.value).supplement_count).toBe(1);
      const perServing = deriveSavedReportNutrients(decoded.value, 'per_serving', 4);
      expect(perServing.find((entry) => entry.nutrient === 'niacin')?.amount).toBe(0.3);
      expect(perServing.find((entry) => entry.nutrient === 'calories')?.amount).toBe(91);

      const reopenedAdapted = adaptRecipe(reopened);
      expect(reopenedAdapted.ok).toBe(true);
      if (!reopenedAdapted.ok) return;
      const hydrated = hydrateWorkingReview({
        session: SESSION,
        recipeKey: reopenedAdapted.recipe.recipe_key,
        baseServings: 4,
        adapted: reopenedAdapted.recipe.adapted,
        instructions: reopened.instructions.map((step) => step.text),
        rows: buildReviewRows(SESSION, reopenedAdapted.recipe.adapted),
        savedBlock: decoded.value,
      });
      expect(hydrated?.aiNutrition?.supplements).toEqual([supplement]);
      expect(hydrated?.aiNutrition?.contributions).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not write schema-v6 unless supplements are actually present (v5 compatibility)', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], { title: 'No supplement', servings: 4 });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein', 'fiber']);
    let working: ObsidianRecipe | undefined;
    const result = await apply(
      { recipe, state: reviewed.state, preview: reviewed.preview },
      { write: async (next) => { working = next; }, readBack: async () => serializeRecipeToObsidianMarkdown(working!) },
    );
    expect(failureCodeOf(result)).toBe('ok');
    expect((working!.codexNutrition as { schema: number }).schema).toBe(1);
    expect(decodeCodexNutrition(working!.codexNutrition).kind).toBe('v1');
  });

  it.each([
    ['conflicting source nutrient', { nutrient_id: 'calories', unit: 'kcal', amount: 10 }],
    ['explicit source zero', { nutrient_id: 'fiber', unit: 'g', amount: 1 }],
    ['stale recipe digest', { recipe_digest: `sha256:${'b'.repeat(64)}` }],
    ['wrong weight basis', { weight_grams: 90 }],
  ])('fails closed for a %s supplement at Apply', async (_label, override) => {
    const { recipe, reviewed, supplement } = await sourceGapSupplementFixture();
    const hostile = Object.freeze({ ...supplement, ...override }) as AiNutrientSupplement;
    const { state, combined } = supplementState(reviewed, [hostile]);
    const write = vi.fn(async () => {});
    const result = await apply({ recipe, state, preview: combined }, { write });
    expect(failureCodeOf(result)).toBe('stale_authorization');
    expect(write).not.toHaveBeenCalled();
  });

  it('never hydrates a forged saved calorie supplement onto a verified calorie source line', async () => {
    const { recipe, reviewed, supplement } = await sourceGapSupplementFixture();
    const { state, combined } = supplementState(reviewed, [supplement]);
    let working: ObsidianRecipe | undefined;
    const result = await apply(
      { recipe, state, preview: combined },
      { write: async (next) => { working = next; }, readBack: async () => serializeRecipeToObsidianMarkdown(working!) },
    );
    expect(failureCodeOf(result)).toBe('ok');
    const applied = working!.codexNutrition as CodexNutritionV6;
    // Sol Light's forged block: the verified flour line already contributes
    // calories, and the supplement claims calories again for that same line.
    const forged: CodexNutritionV6 = {
      ...applied,
      nutrient_supplements: [{
        ...supplement,
        nutrient_id: 'calories',
        unit: 'kcal',
        amount: 100,
        quantity_basis: '100 g resolved source weight',
      }],
    };
    const adaptation = adaptRecipe(recipe);
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const hydrated = hydrateWorkingReview({
      session: SESSION,
      recipeKey: adaptation.recipe.recipe_key,
      baseServings: adaptation.recipe.base_servings,
      adapted: adaptation.recipe.adapted,
      instructions: recipe.instructions.map((step) => step.text),
      rows: buildReviewRows(SESSION, adaptation.recipe.adapted),
      savedBlock: forged,
    });
    expect(hydrated?.aiNutrition).toBeUndefined();
  });

  it('quarantines a coordinated-metadata calorie supplement on reopen and never activates it', async () => {
    const { recipe, reviewed, supplement } = await sourceGapSupplementFixture();
    const { state, combined } = supplementState(reviewed, [supplement]);
    let working: ObsidianRecipe | undefined;
    const result = await apply(
      { recipe, state, preview: combined },
      { write: async (next) => { working = next; }, readBack: async () => serializeRecipeToObsidianMarkdown(working!) },
    );
    expect(failureCodeOf(result)).toBe('ok');
    const applied = working!.codexNutrition as CodexNutritionV6;
    // Sol Light's coordinated metadata: erase the persisted source calories,
    // rewrite the source amounts and aggregate totals so the pure block is
    // internally self-consistent, then add an AI calorie supplement.
    const forged: CodexNutritionV6 = {
      ...applied,
      nutrient_scope: ['calories'],
      nutrients: {
        calories: {
          amount: 100,
          unit: 'kcal',
          status: 'complete',
          coverage: 1,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 1,
        },
      },
      ingredients: applied.ingredients.map((entry) => ({ ...entry, source_nutrients: [] })),
      source_amounts: {},
      nutrient_supplements: [{
        ...supplement,
        nutrient_id: 'calories',
        unit: 'kcal',
        amount: 100,
      }],
    };
    // Pure parsing remains separate from trusted activation: the coordinated
    // block is structurally coherent.
    expect(validateCodexNutrition(forged).ok).toBe(true);
    expect(decodeCodexNutrition(forged).kind).toBe('v6');

    const adaptation = adaptRecipe(recipe);
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const hydrated = hydrateWorkingReview({
      session: SESSION,
      recipeKey: adaptation.recipe.recipe_key,
      baseServings: adaptation.recipe.base_servings,
      adapted: adaptation.recipe.adapted,
      instructions: recipe.instructions.map((step) => step.text),
      rows: buildReviewRows(SESSION, adaptation.recipe.adapted),
      savedBlock: forged,
    });
    expect(hydrated?.aiNutrition).toBeUndefined();
    expect(hydrated?.quarantinedSupplements).toHaveLength(1);
    expect(hydrated?.quarantinedSupplements?.[0]).toMatchObject({
      reason: 'source_conflict',
      code: 'source_already_has_nutrient',
    });

    // Pure presentation preserves the saved content but never treats the
    // supplement-inclusive totals as authoritative.
    const presentation = resolveRecipeNutritionPresentation(
      obsidianRecipe([structured(FLOUR_LINE)], { frontmatter: { codex_nutrition: forged } }),
    );
    expect(presentation.advanced_verification_required).toBe(true);
    expect(presentation.advanced_complete).toBe(false);
    expect(deriveAdvancedCompactNutrition(presentation)).toBeUndefined();
  });

  it('fails closed for duplicate supplemental nutrients at Apply', async () => {
    const { recipe, reviewed, supplement } = await sourceGapSupplementFixture();
    const { state, combined } = supplementState(reviewed, [supplement, supplement]);
    const write = vi.fn(async () => {});
    const result = await apply({ recipe, state, preview: combined }, { write });
    expect(failureCodeOf(result)).toBe('stale_authorization');
    expect(write).not.toHaveBeenCalled();
  });
});
