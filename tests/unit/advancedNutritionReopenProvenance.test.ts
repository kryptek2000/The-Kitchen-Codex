/**
 * Advanced Nutrition Phase 0B final parity — truthful Apply→reopen provenance.
 *
 * Proves the narrow fail-closed hydration rule through BOTH the core lifecycle
 * (analyze → AI-assisted count resolution → Apply → authorize → reopen) and
 * rendered working-review behavior:
 *   - a saved count/source basis that cannot be re-authenticated NEVER becomes
 *     a user-entered mass; the reviewed food identity is restored and the line
 *     stays NEEDS AMOUNT; re-Apply is refused until the mass is resolved again;
 *   - a saved basis that CAN be re-authenticated reopens with truthful
 *     portion provenance;
 *   - a basis-omitted (schema-v1 user-mass) line truthfully reopens as
 *     user-entered mass.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows, selectionFromMatchChoice } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows, summarizeLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { buildCountPortionChoice } from '../../src/core/nutritionV2/phase4/countPortion';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import { resolveAmountsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiAmountResolve';
import { hydrateWorkingReview } from '../../src/core/nutritionV2/phase4/hydrate';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5/authorize';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';
import type { AiResolutionSuggestion } from '../../src/core/nutritionV2/aiResolution';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import type { ObsidianRecipe } from '../../src/types';

const SPECS = [
  {
    fdcId: 7001,
    dataType: 'sr_legacy' as const,
    description: 'Garlic, raw',
    nutrientAmount: 5,
    portions: [
      { usda_portion_id: 1, amount: 1, measure: 'clove', gram_weight: 3, sequence: 1 },
      { usda_portion_id: 2, amount: 3, measure: 'cloves', gram_weight: 9, sequence: 2 },
    ],
  },
];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function recipe(line: string): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Reopen Provenance',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [structuredLine(line)] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as unknown as ObsidianRecipe;
}

interface Flow {
  readonly recipe: ObsidianRecipe;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly analysis: ReturnType<typeof analyzeRecipe>;
  readonly rows: ReturnType<typeof buildReviewRows>;
  readonly state: Phase4State;
  readonly lineRef: string;
}

function flow(line: string): Flow {
  const recipeObject = recipe(line);
  const adaptation = adaptRecipe(recipeObject);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows,
    baseServings: 1,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    preview: analysis.preview,
  });
  return { recipe: recipeObject, adapted, analysis, rows, state, lineRef: adapted[0].line_ref };
}

function liveOf(flowValue: Flow, state: Phase4State) {
  const analysis = analyzeRecipe(session, flowValue.adapted, 1);
  const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
  return projectLiveRows(state, analyzedByRef, flowValue.adapted, session, null);
}

function applyReady(flowValue: Flow, state: Phase4State): Phase4State {
  const calculated = session.calculate(buildCalculationRequest(flowValue.adapted, state));
  if (!calculated.ok) throw new Error('apply preview failed');
  return {
    ...state,
    status: 'preview_current',
    preview: calculated.preview,
    previewKey: state.recipeKey,
  } as Phase4State;
}

function authorize(flowValue: Flow, state: Phase4State): CodexNutritionV1 {
  const result = authorizeNutritionPersistence({
    session,
    recipe: flowValue.recipe,
    state,
  });
  if (!result.ok) {
    throw new Error(
      `authorize failed: ${JSON.stringify((result as { failure: { code: string } }).failure)}`
    );
  }
  return result.candidate.block;
}

function reAuthorize(
  flowValue: Flow,
  state: Phase4State,
  existingBlock: CodexNutritionV1
): { code: string } {
  const result = authorizeNutritionPersistence({
    session,
    recipe: flowValue.recipe,
    state: applyReady(flowValue, state),
    existingBlock,
  });
  if (result.ok) return { code: 'applied' };
  return { code: (result as { failure: { code: string } }).failure.code };
}

function cloveSuggestion(lineRef: string): AiResolutionSuggestion {
  return {
    line_ref: lineRef,
    interpreted_food_name: 'garlic',
    suggested_usda_queries: ['garlic'],
    quantity_value: 3,
    quantity_unit_hint: 'cloves',
    count_descriptor_hint: 'clove',
    portion_search_hint: 'clove',
  };
}

describe('phase 0B final parity — Apply→reopen provenance (I-2)', () => {
  it('hint-dependent garlic: Apply persists truthfully; reopen restores food only, keeps mass NEEDS AMOUNT, and blocks re-Apply', () => {
    // `3 garlic` has no recipe-declared count unit, so the applied count basis is
    // genuinely hint-dependent (Phase 1: `3 garlic cloves` would carry its own
    // unit and re-authenticate without a hint).
    const f = flow('3 garlic');
    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows: f.rows,
      adapted: f.adapted,
      liveRows: liveOf(f, f.state),
      state: f.state,
      suggestions: [cloveSuggestion(f.lineRef)],
    });
    expect(outcome.resolved).toHaveLength(1);
    const choice = outcome.resolved[0].choice;
    expect(choice.countRequirementHint).toEqual({ unit: 'clove', size: null });
    const working = phase4Reducer(f.state, {
      type: 'select_count_portion',
      lineRef: f.lineRef,
      choice,
    });
    const workingLive = liveOf(f, working)[0];
    expect(workingLive.status).toBe('matched');
    expect(workingLive.mass_source).toBe('count_portion');
    expect(workingLive.resolved_grams).toBe(9);

    // Explicit Apply persists the truthful count-portion basis.
    const block = authorize(f, applyReady(f, working));
    const applied = block.ingredients[0];
    expect(applied.conversion_basis).toBe('source_portion');
    expect(applied.amount?.value).toBe(9);

    // REOPEN: the hint is not persisted, so the count basis cannot be
    // re-authenticated. The reviewed food identity is restored, but NO user
    // mass is ever fabricated.
    const hydrated = hydrateWorkingReview({ session, adapted: f.adapted, rows: f.rows, savedBlock: block });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    expect(hydrated.matches[f.lineRef]).toBeDefined();
    expect(hydrated.countPortions[f.lineRef]).toBeUndefined();
    expect(hydrated.userMasses[f.lineRef]).toBeUndefined();
    const reopenState: Phase4State = {
      ...f.state,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
    };
    const reopenedLive = liveOf(f, reopenState)[0];
    expect(reopenedLive.status).toBe('needs_amount');
    expect(reopenedLive.mass_source).toBeUndefined();
    expect(reopenedLive.resolved_grams).toBeUndefined();
    expect(summarizeLiveRows(liveOf(f, reopenState)).needs_amount).toBe(1);

    // Re-Apply is blocked until the mass is resolved again: no provenance
    // downgrade is ever written over the applied report.
    expect(reAuthorize(f, reopenState, block).code).toBe('applied_line_unresolved');
  });

  it('explicit-unit `3 cloves garlic` reopens truthfully as the authenticated count portion and re-applies', () => {
    const f = flow('3 cloves garlic');
    const selected = f.analysis.rows[0].selected_fdc_id;
    expect(selected).toBe(7001);
    const review = session.reviewCountPortions(f.adapted[0].ingredient, selected as number);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.review.candidates.length).toBeGreaterThan(0);
    const match = f.state.matches[f.lineRef];
    const built = buildCountPortionChoice(session, {
      lineRef: f.lineRef,
      ingredient: f.adapted[0].ingredient,
      review: f.rows[0].outcome === 'review_required' ? f.rows[0].review : undefined,
      ...(match !== undefined ? { selection: selectionFromMatchChoice(match, f.lineRef) } : {}),
      automaticSelection: match?.automatic === true,
      fdcId: selected as number,
      portionIndex: review.review.candidates[0].index,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const working = phase4Reducer(f.state, {
      type: 'select_count_portion',
      lineRef: f.lineRef,
      choice: built.choice,
    });
    const block = authorize(f, applyReady(f, working));
    const hydrated = hydrateWorkingReview({ session, adapted: f.adapted, rows: f.rows, savedBlock: block });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    expect(hydrated.countPortions[f.lineRef]).toBeDefined();
    expect(hydrated.userMasses[f.lineRef]).toBeUndefined();
    const reopenState: Phase4State = {
      ...f.state,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
    };
    const reopenedLive = liveOf(f, reopenState)[0];
    expect(reopenedLive.status).toBe('matched');
    expect(reopenedLive.mass_source).toBe('count_portion');
    expect(reopenedLive.resolved_grams).toBe(9);
    // Truthful re-authentication: re-Apply succeeds (no regression gate hit).
    expect(reAuthorize(f, reopenState, block).code).toBe('applied');
  });

  it('a basis-omitted (schema-v1 user-mass) line truthfully reopens as user-entered mass', () => {
    const f = flow('3 garlic cloves');
    const match = f.state.matches[f.lineRef];
    const built = buildUserMassChoice(session, {
      lineRef: f.lineRef,
      ingredient: f.adapted[0].ingredient,
      review: f.rows[0].outcome === 'review_required' ? f.rows[0].review : undefined,
      ...(match !== undefined ? { selection: selectionFromMatchChoice(match, f.lineRef) } : {}),
      automaticSelection: match?.automatic === true,
      fdcId: match?.fdc_id ?? 7001,
      quantity: 9,
      unit: 'g',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const working = phase4Reducer(f.state, {
      type: 'select_user_mass',
      lineRef: f.lineRef,
      choice: built.choice,
    });
    const block = authorize(f, applyReady(f, working));
    // A user_mass line persists with the basis OMITTED (schema-v1 contract).
    expect(block.ingredients[0].conversion_basis).toBeUndefined();
    const hydrated = hydrateWorkingReview({ session, adapted: f.adapted, rows: f.rows, savedBlock: block });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    expect(hydrated.userMasses[f.lineRef]).toBeDefined();
    const reopenState: Phase4State = {
      ...f.state,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
    };
    const reopenedLive = liveOf(f, reopenState)[0];
    expect(reopenedLive.status).toBe('matched');
    expect(reopenedLive.mass_source).toBe('user_mass');
    expect(reopenedLive.resolved_grams).toBe(9);
  });

  it('a saved source basis that no longer re-authenticates restores food but never fabricates user mass', () => {
    const f = flow('3 cloves garlic');
    const selected = f.analysis.rows[0].selected_fdc_id;
    const review = session.reviewCountPortions(f.adapted[0].ingredient, selected as number);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const match = f.state.matches[f.lineRef];
    const built = buildCountPortionChoice(session, {
      lineRef: f.lineRef,
      ingredient: f.adapted[0].ingredient,
      review: f.rows[0].outcome === 'review_required' ? f.rows[0].review : undefined,
      ...(match !== undefined ? { selection: selectionFromMatchChoice(match, f.lineRef) } : {}),
      automaticSelection: match?.automatic === true,
      fdcId: selected as number,
      portionIndex: review.review.candidates[0].index,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const working = phase4Reducer(f.state, {
      type: 'select_count_portion',
      lineRef: f.lineRef,
      choice: built.choice,
    });
    const block = authorize(f, applyReady(f, working));
    // Corrupt the saved amount so NO candidate can re-authenticate the basis.
    const corruptedBlock: CodexNutritionV1 = {
      ...block,
      ingredients: [{ ...block.ingredients[0], amount: { value: 999, unit: 'g' } }],
    };
    const hydrated = hydrateWorkingReview({
      session,
      adapted: f.adapted,
      rows: f.rows,
      savedBlock: corruptedBlock,
    });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    expect(hydrated.matches[f.lineRef]).toBeDefined();
    expect(hydrated.countPortions[f.lineRef]).toBeUndefined();
    expect(hydrated.portions[f.lineRef]).toBeUndefined();
    expect(hydrated.userMasses[f.lineRef]).toBeUndefined();
    const reopenState: Phase4State = {
      ...f.state,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
    };
    const reopenedLive = liveOf(f, reopenState)[0];
    expect(reopenedLive.status).toBe('needs_amount');
    expect(reopenedLive.mass_source).toBeUndefined();
    expect(reopenedLive.resolved_grams).toBeUndefined();
  });
});
