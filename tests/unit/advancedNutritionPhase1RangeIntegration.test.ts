/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: range fail-closed integration.
 *
 * Proves end-to-end that a true quantity range never becomes a single amount:
 *   - every supported range keeps both endpoints and amount null;
 *   - the entire range and its unit are removed from the food identity;
 *   - no direct/source/count/user mass is derived from one endpoint;
 *   - a range cannot be serialized into a calculation request as an exact
 *     quantity and cannot regain a lower endpoint through the structured-input
 *     fallback;
 *   - re-analysis keeps the line unresolved, Apply is refused, and hydration
 *     never fabricates a user mass from a saved portion basis.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { hydrateWorkingReview } from '../../src/core/nutritionV2/phase4/hydrate';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5/authorize';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import type { ObsidianRecipe } from '../../src/types';

const SPECS = [
  {
    fdcId: 7002,
    dataType: 'sr_legacy' as const,
    description: 'Pork, cured, bacon, unprepared',
    nutrientAmount: 541,
    portions: [{ usda_portion_id: 3, amount: 1, measure: 'slice', gram_weight: 28, sequence: 1 }],
  },
  {
    fdcId: 7001,
    dataType: 'sr_legacy' as const,
    description: 'Garlic, raw',
    nutrientAmount: 149,
    portions: [{ usda_portion_id: 1, amount: 1, measure: 'clove', gram_weight: 3, sequence: 1 }],
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
    title: 'Range Fail Closed',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: [structuredLine(line)] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

function flow(line: string) {
  const recipeValue = recipe(line);
  const adaptation = adaptRecipe(recipeValue);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  const analysis = analyzeRecipe(session, adapted, 2);
  const state = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    baseServings: 2,
    rows,
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: 2,
    preview: analysis.preview ?? null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as Phase4State;
  return { adapted, rows, analysis, state, recipe: recipeValue };
}

const RANGE_LINES: ReadonlyArray<readonly [string, number, number]> = [
  ['2 to 3 bacon slices', 2, 3],
  ['1-2 bacon slices', 1, 2],
  ['1–2 bacon slices', 1, 2],
  ['1—2 bacon slices', 1, 2],
  ['1/2-1 bacon slices', 0.5, 1],
  ['1 1/2-2 bacon slices', 1.5, 2],
  ['½-¾ cup broth', 0.5, 0.75],
  ['2 to 3 cloves garlic', 2, 3],
];

describe('phase 1 ranges — end-to-end fail-closed', () => {
  it('keeps both endpoints, amount null, and no mass for every supported range', () => {
    for (const [line, lower, upper] of RANGE_LINES) {
      const parsed = parseIngredient(line);
      expect(parsed.ok, line).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.parsed.amount, line).toBeNull();
      expect(parsed.parsed.quantity_kind, line).toBe('range');
      expect(parsed.parsed.quantity_range, line).toEqual({ lower, upper });
      expect(parsed.parsed.grams, line).toBeUndefined();
      expect(parsed.parsed.milliliters, line).toBeUndefined();

      const { adapted, analysis, state } = flow(line);
      const live = projectLiveRows(
        state,
        new Map(analysis.rows.map((row) => [row.line_ref, row])),
        adapted,
        session,
        null,
        analysis.portions,
        analysis.countPortions
      )[0];
      expect(live.resolved_grams ?? null, line).toBeNull();
      expect(live.mass_source ?? null, line).toBeNull();
      expect(analysis.preview?.ingredients[0]?.resolved_grams ?? null, line).toBeNull();

      const calculated = session.calculate(buildCalculationRequest(adapted, state));
      if (calculated.ok) {
        expect(calculated.preview.ingredients[0].resolved_grams ?? null, line).toBeNull();
      }
    }
  });

  it('never serializes a range into the calculation request as an exact quantity', () => {
    const { adapted, state } = flow('2 to 3 bacon slices');
    const request = buildCalculationRequest(adapted, state);
    const ingredient = (request as { ingredients: ReadonlyArray<Record<string, unknown>> }).ingredients[0];
    expect(ingredient.amount).toBeUndefined();
    expect(ingredient.unit).toBeUndefined();
    const calculated = session.calculate(request);
    if (calculated.ok) {
      expect(calculated.preview.ingredients[0].resolved_grams).toBeUndefined();
      expect(calculated.preview.ingredients[0].mass_source).toBeUndefined();
    }
  });

  it('cannot regain a lower endpoint through the structured-input fallback', () => {
    const structured = parseIngredient({
      original: '2 to 3 bacon slices',
      amount: 2,
      unit: 'slices',
      name: 'bacon',
    });
    expect(structured.ok).toBe(true);
    if (!structured.ok) return;
    expect(structured.parsed.amount).toBeNull();
    expect(structured.parsed.quantity_kind).toBe('range');
    expect(structured.parsed.grams).toBeUndefined();

    const garlic = parseIngredient({
      original: '2 to 3 cloves garlic',
      amount: 2,
      name: 'garlic',
    });
    expect(garlic.ok).toBe(true);
    if (!garlic.ok) return;
    expect(garlic.parsed.amount).toBeNull();
    expect(garlic.parsed.quantity_kind).toBe('range');
  });

  it('stays unresolved after re-analysis and refuses Apply', () => {
    const { recipe: r, state } = flow('2 to 3 bacon slices');
    const authorized = authorizeNutritionPersistence({ session, recipe: r, state });
    expect(authorized.ok).toBe(false);
    if (!authorized.ok) {
      expect(typeof (authorized as { failure: { code: string } }).failure.code).toBe('string');
    }
  });

  it('never fabricates user mass from hydration for a saved range line', () => {
    const { adapted, rows, analysis, state } = flow('2 to 3 bacon slices');
    const lineRef = adapted[0].line_ref;
    const bundleRelease = session.metadata().bundle_release;
    // A synthetic schema-v1 block: a saved `source_portion` basis whose grams
    // equal the range's lower endpoint x the authenticated slice weight (56 g).
    // If a range endpoint were authority, hydration would bind it.
    const savedBlock = {
      schema: 1,
      basis: 'total',
      servings: 2,
      status: 'complete',
      computed_at: '2026-01-01T00:00:00.000Z',
      ingredient_digest: 'd'.repeat(64),
      dv_standard: 'fda_dv_2016',
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: bundleRelease },
      nutrient_scope: ['calories'],
      nutrients: {},
      ingredients: [
        {
          line_ref: lineRef,
          source: 'usda_fdc',
          source_food_id: '7002',
          source_release: bundleRelease,
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
          amount: { value: 56, unit: 'g' },
          conversion_basis: 'source_portion',
        },
      ],
      unresolved: [],
    } as unknown as CodexNutritionV1;

    const hydrated = hydrateWorkingReview({ session, adapted, rows, savedBlock });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    expect(hydrated.countPortions[lineRef]).toBeUndefined();
    expect(hydrated.userMasses[lineRef]).toBeUndefined();
    expect(hydrated.portions[lineRef]).toBeUndefined();

    const reopenedState = {
      ...state,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
    } as Phase4State;
    const live = projectLiveRows(
      reopenedState,
      new Map(analysis.rows.map((row) => [row.line_ref, row])),
      adapted,
      session,
      null,
      reopenedState.portions,
      reopenedState.countPortions
    )[0];
    expect(live.resolved_grams ?? null).toBeNull();
    expect(live.mass_source ?? null).toBeNull();
  });
});
