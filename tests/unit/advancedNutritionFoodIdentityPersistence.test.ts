/**
 * Advanced Nutrition — independent FOOD-IDENTITY persistence for unresolved-mass
 * rows.
 *
 * Food identity and mass resolution are separate concerns: a user-confirmed USDA
 * food must survive Apply even when the line's mass is still unresolved, while
 * the line contributes ZERO nutrients. Covers persistence, serialization
 * round-trip, hydration, backward compatibility, and fail-closed security.
 */

import { describe, it, expect } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { hydrateWorkingReview } from '../../src/core/nutritionV2/phase4/hydrate';
import { projectLiveRow } from '../../src/core/nutritionV2/phase4/liveRow';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { parseIngredientLine, parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import { decodeCodexNutrition, encodeCodexNutrition, validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import type { AdvancedNutritionSession, Phase4Action, Phase4State } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';

const SPECS: ReadonlyArray<CalcRecordSpec> = [
  { fdcId: 6001, dataType: 'sr_legacy', description: 'Flour, wheat, white', nutrients: { calories: 364 } },
  { fdcId: 6002, dataType: 'fndds', description: 'Mystery, raw', nutrients: { calories: 100 } },
  { fdcId: 6003, dataType: 'fndds', description: 'Mystery, cooked', nutrients: { calories: 120 } },
];

const BUNDLE = buildCalculationBundle(SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipe(lines: ReadonlyArray<string> = ['100 g Flour, wheat, white', '1 cup Mystery']): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Food Identity Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: lines.map(structured) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

interface ManualPick {
  readonly pattern: RegExp;
  readonly fdcId: number;
}

/** Builds a reviewed state with an optional explicit manual selection. */
function buildReviewed(target: ObsidianRecipe, pick?: ManualPick): Phase4State {
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe;
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adapted.recipe_key,
    sessionIdentity: phase4SessionIdentity(SESSION.metadata()),
    rows: buildReviewRows(SESSION, adapted.adapted),
    baseServings: adapted.base_servings,
  });
  const dispatch = (action: Phase4Action) => {
    state = phase4Reducer(state, action);
  };
  if (pick) {
    const pickedRow = state.rows.find((row) => pick.pattern.test(row.query));
    if (!pickedRow) throw new Error('target row missing');
    const search = SESSION.searchFoods(String(pick.fdcId), 1);
    const hit = search.ok
      ? search.results.find((result) => result.fdc_id === pick.fdcId && result.exact_fdc_id)
      : undefined;
    if (!hit) throw new Error('target fdc missing');
    dispatch({
      type: 'select_match',
      lineRef: pickedRow.line_ref,
      choice: {
        kind: 'manual',
        fdc_id: pick.fdcId,
        review_digest: pickedRow.review_digest ?? '',
        record_digest: hit.record_digest,
        catalog_digest: SESSION.metadata().catalog_digest,
      },
    });
  }
  const seq = state.operationSeq;
  const result = SESSION.calculate(buildCalculationRequest(adapted.adapted, state));
  if (!result.ok) throw new Error('calc failed');
  dispatch({ type: 'preview_succeeded', seq, recipeKey: state.recipeKey as string, preview: result.preview });
  return state;
}

async function applyAndGetBlock(target: ObsidianRecipe, pick?: ManualPick): Promise<CodexNutritionV1> {
  let written: ObsidianRecipe | undefined;
  const result = await applyAdvancedNutrition({
    session: SESSION,
    recipe: target,
    state: buildReviewed(target, pick),
    expectedMode: 'create',
    write: async (updated: ObsidianRecipe) => {
      written = updated;
      serializeRecipeToObsidianMarkdown(updated);
    },
  });
  expect(result.ok).toBe(true);
  if (!written || !written.codexNutrition) throw new Error('not written');
  return written.codexNutrition as CodexNutritionV1;
}

function mysteryLineRef(target: ObsidianRecipe): string {
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const row = buildReviewRows(SESSION, adaptation.recipe.adapted).find((entry) => /mystery/i.test(entry.query));
  if (!row) throw new Error('mystery row missing');
  return row.line_ref;
}

describe('food identity persistence — persistence', () => {
  it('persists the user-confirmed FDC on an unresolved-mass row without contributing nutrients', async () => {
    const target = recipe();
    const block = await applyAndGetBlock(target, { pattern: /mystery/i, fdcId: 6002 });
    const ref = mysteryLineRef(target);

    // The food identity is preserved on the unresolved reference.
    const unresolvedEntry = block.unresolved.find((entry) => entry.line_ref === ref);
    expect(unresolvedEntry).toBeDefined();
    expect(unresolvedEntry?.reason).toBe('no_mass');
    expect(unresolvedEntry?.source_food_id).toBe('6002');
    expect(unresolvedEntry?.source_release).toBe(SESSION.metadata().bundle_release);

    // The unresolved-mass row is NOT a resolved ingredient and has no amount.
    expect(block.ingredients.find((entry) => entry.line_ref === ref)).toBeUndefined();

    // Totals come ONLY from the resolved flour line (364 kcal / 100 g × 100 g).
    expect(block.nutrients.calories?.amount).toBeCloseTo(364, 6);
    expect(block.status).toBe('partial');
  });

  it('persists a manual selection made on an UNMATCHED row (manual-search escape hatch)', async () => {
    // `Zzz` has no automatic candidate at all; the user picks 6002 manually.
    const target = recipe(['100 g Flour, wheat, white', '1 cup Zzz']);
    const block = await applyAndGetBlock(target, { pattern: /zzz/i, fdcId: 6002 });
    const adaptation = adaptRecipe(target);
    if (!adaptation.ok) throw new Error('adapt failed');
    const zzzRow = buildReviewRows(SESSION, adaptation.recipe.adapted).find((row) => /zzz/i.test(row.query));
    expect(zzzRow).toBeDefined();
    if (!zzzRow) return;
    const entry = block.unresolved.find((item) => item.line_ref === zzzRow.line_ref);
    expect(entry?.source_food_id).toBe('6002');
    expect(entry?.reason).toBe('no_mass');
  });

  it('does NOT persist a food identity for an automatic (non-user) unresolved row', async () => {
    // `1 cup Mystery, raw` is uniquely exact -> an automatic match, not a user choice.
    const target = recipe(['100 g Flour, wheat, white', '1 cup Mystery, raw']);
    const block = await applyAndGetBlock(target);
    for (const entry of block.unresolved) {
      expect(entry.source_food_id).toBeUndefined();
      expect(entry.source_release).toBeUndefined();
    }
  });
});

describe('food identity persistence — serialization round-trip', () => {
  it('survives Markdown/YAML round-trip with the same FDC identity', async () => {
    const target = recipe();
    const block = await applyAndGetBlock(target, { pattern: /mystery/i, fdcId: 6002 });
    const saved: ObsidianRecipe = {
      ...target,
      codexNutrition: block as never,
      frontmatter: { codex_nutrition: encodeCodexNutrition(block) },
    } as ObsidianRecipe;

    const markdown = serializeRecipeToObsidianMarkdown(saved);
    const parsed = parseObsidianRecipeMarkdown(markdown, 'r1.md', 'Recipes/r1.md');
    const decoded = decodeCodexNutrition(parsed.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind !== 'v1') return;
    const ref = mysteryLineRef(target);
    const entry = decoded.value.unresolved.find((item) => item.line_ref === ref);
    expect(entry?.source_food_id).toBe('6002');
    expect(entry?.source_release).toBe(SESSION.metadata().bundle_release);

    // Re-encoding is stable and still valid.
    const reencoded = encodeCodexNutrition(decoded.value);
    expect(validateCodexNutritionV1(reencoded).ok).toBe(true);
  });

  it('keeps legacy unresolved rows (no food fields) valid and readable', () => {
    const block: CodexNutritionV1 = {
      schema: 1,
      basis: 'total',
      servings: 2,
      status: 'partial',
      computed_at: '2026-09-14T00:00:00.000Z',
      ingredient_digest: `sha256:${'a'.repeat(64)}`,
      dv_standard: DV_STANDARD_ID,
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: 'r' },
      nutrient_scope: ['calories'],
      nutrients: {},
      ingredients: [],
      unresolved: [{ line_ref: 'ing:1:legacy', reason: 'no_match' }],
    };
    const validation = validateCodexNutritionV1(block);
    expect(validation.ok).toBe(true);
    if (!validation.ok || !validation.value) return;
    expect(validation.value.unresolved[0]).toEqual({ line_ref: 'ing:1:legacy', reason: 'no_match' });
  });

  it('rejects a food identity without a release and a release mismatch', () => {
    const base = {
      schema: 1,
      basis: 'total',
      servings: 2,
      status: 'partial',
      computed_at: '2026-09-14T00:00:00.000Z',
      ingredient_digest: `sha256:${'a'.repeat(64)}`,
      dv_standard: DV_STANDARD_ID,
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: 'r' },
      nutrient_scope: ['calories'],
      nutrients: {},
      ingredients: [],
    };
    expect(
      validateCodexNutritionV1({ ...base, unresolved: [{ line_ref: 'x', reason: 'no_mass', source_food_id: '6002' }] }).ok
    ).toBe(false);
    expect(
      validateCodexNutritionV1({
        ...base,
        unresolved: [{ line_ref: 'x', reason: 'no_mass', source_food_id: '6002', source_release: 'other' }],
      }).ok
    ).toBe(false);
    expect(
      validateCodexNutritionV1({
        ...base,
        unresolved: [{ line_ref: 'x', reason: 'no_mass', source_food_id: '6002', source_release: 'r' }],
      }).ok
    ).toBe(true);
  });
});

describe('food identity persistence — hydration', () => {
  it('restores FOOD (user-confirmed) but leaves the row NEEDS AMOUNT', async () => {
    const target = recipe();
    const block = await applyAndGetBlock(target, { pattern: /mystery/i, fdcId: 6002 });
    const adaptation = adaptRecipe(target);
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const rows = buildReviewRows(SESSION, adapted);

    const hydrated = hydrateWorkingReview({ session: SESSION, adapted, rows, savedBlock: block });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    const ref = mysteryLineRef(target);
    expect(hydrated.matches[ref]?.kind).toBe('manual');
    expect(hydrated.matches[ref]?.fdc_id).toBe(6002);
    expect(hydrated.userMasses[ref]).toBeUndefined();
    expect(hydrated.portions[ref]).toBeUndefined();

    const state = {
      version: '',
      status: 'ready',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: null,
      baseServings: 2,
      rows,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
      basis: 'entire_recipe',
      selectedServings: 2,
      preview: null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    } as never;

    const mysteryRow = rows.find((row) => /mystery/i.test(row.query)) as never;
    const live = projectLiveRow({
      row: mysteryRow,
      analyzed: undefined,
      state,
      entry: adapted.find((entry) => /mystery/i.test(entry.ingredient.name ?? '')) as never,
      session: SESSION,
      evidence: undefined,
    });
    // FOOD confirmed, MASS unresolved -> NEEDS AMOUNT, never NEEDS MATCH.
    expect(live.status).toBe('needs_amount');
    expect(live.food_authority).toBe('user_confirmed');
    expect(live.selected_fdc_id).toBe(6002);
    expect(live.resolved_grams).toBeUndefined();
  });

  it('fails closed for a food id that is absent from the active catalog', async () => {
    const target = recipe();
    const block = await applyAndGetBlock(target, { pattern: /mystery/i, fdcId: 6002 });
    const ref = mysteryLineRef(target);
    const forged: CodexNutritionV1 = {
      ...block,
      unresolved: block.unresolved.map((entry) =>
        entry.line_ref === ref ? { ...entry, source_food_id: '999999' } : entry
      ),
    };
    expect(validateCodexNutritionV1(forged).ok).toBe(true);
    const adaptation = adaptRecipe(target);
    if (!adaptation.ok) throw new Error('adapt failed');
    const hydrated = hydrateWorkingReview({
      session: SESSION,
      adapted: adaptation.recipe.adapted,
      rows: buildReviewRows(SESSION, adaptation.recipe.adapted),
      savedBlock: forged,
    });
    expect(hydrated?.matches[ref]).toBeUndefined();
  });

  it('later resolves the mass: the restored food + a manual weight becomes MATCHED', async () => {
    const target = recipe();
    const block = await applyAndGetBlock(target, { pattern: /mystery/i, fdcId: 6002 });
    const adaptation = adaptRecipe(target);
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const rows = buildReviewRows(SESSION, adapted);
    const hydrated = hydrateWorkingReview({ session: SESSION, adapted, rows, savedBlock: block });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    const ref = mysteryLineRef(target);
    const mysteryRow = rows.find((row) => /mystery/i.test(row.query));
    const mysteryEntry = adapted.find((entry) => /mystery/i.test(entry.ingredient.name ?? ''));
    if (!mysteryRow || !mysteryEntry) throw new Error('mystery missing');
    const match = hydrated.matches[ref];
    const selection = {
      kind: 'manual',
      fdc_id: match.fdc_id,
      record_digest: match.record_digest,
      catalog_digest: match.catalog_digest,
      line_ref: ref,
      review_digest: match.review_digest,
    };
    const userMass = buildUserMassChoice(SESSION, {
      lineRef: ref,
      ingredient: mysteryEntry.ingredient,
      review: mysteryRow.outcome === 'review_required' ? mysteryRow.review : undefined,
      selection,
      fdcId: 6002,
      quantity: 400,
      unit: 'g',
    });
    expect(userMass.ok).toBe(true);
    if (!userMass.ok) return;

    const state = {
      version: '',
      status: 'ready',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: null,
      baseServings: 2,
      rows,
      matches: hydrated.matches,
      portions: {},
      countPortions: {},
      userMasses: { [ref]: userMass.choice },
      basis: 'entire_recipe',
      selectedServings: 2,
      preview: null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    } as never;

    const live = projectLiveRow({
      row: mysteryRow,
      analyzed: undefined,
      state,
      entry: mysteryEntry,
      session: SESSION,
      evidence: undefined,
    });
    expect(live.status).toBe('matched');
    expect(live.selected_fdc_id).toBe(6002);
    expect(live.resolved_grams).toBe(400);
    expect(live.food_authority).toBe('user_confirmed');
  });

  it('does not bind food evidence to a changed line', async () => {    const target = recipe();
    const block = await applyAndGetBlock(target, { pattern: /mystery/i, fdcId: 6002 });
    // A different recipe with a DIFFERENT content at index 1 -> different line_ref.
    const changed = recipe(['100 g Flour, wheat, white', '1 cup Mystery, cooked']);
    const adaptation = adaptRecipe(changed);
    if (!adaptation.ok) throw new Error('adapt failed');
    const hydrated = hydrateWorkingReview({
      session: SESSION,
      adapted: adaptation.recipe.adapted,
      rows: buildReviewRows(SESSION, adaptation.recipe.adapted),
      savedBlock: block,
    });
    // Only the unchanged flour line (index 0) can bind.
    const mysteryRef = mysteryLineRef(target);
    expect(hydrated?.matches[mysteryRef]).toBeUndefined();
  });
});
