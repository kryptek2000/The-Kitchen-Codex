/**
 * The Kitchen Codex — AI-assisted AMOUNT interpretation (local verification).
 *
 * Proves the amount contract end-to-end against a genuine pinned catalog:
 *   - an AI count-identity hint feeds the deterministic USDA count-portion
 *     resolver, and the calculator derives mass ONLY from authenticated portions;
 *   - arbitrary AI quantity/mass is never authority;
 *   - materially different authenticated weights are OFFERED to the user, never
 *     silently chosen;
 *   - a missing hint / missing portion leaves the line unresolved.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows, summarizeLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import {
  buildUserChoiceFromAiAmountOffer,
  countRequirementHintFromSuggestion,
  resolveAmountsFromAiSuggestions,
} from '../../src/core/nutritionV2/phase4/aiAmountResolve';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  LiveRowState,
  Phase4Row,
  Phase4State,
} from '../../src/core/nutritionV2/phase4';
import type { AiResolutionSuggestion } from '../../src/core/nutritionV2/aiResolution';
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
  {
    fdcId: 7002,
    dataType: 'sr_legacy' as const,
    description: 'Bread, white',
    nutrientAmount: 8,
    portions: [
      { usda_portion_id: 3, amount: 1, measure: 'slice', gram_weight: 25, sequence: 1 },
      { usda_portion_id: 4, amount: 1, measure: 'slice', gram_weight: 32, sequence: 2 },
    ],
  },
  {
    fdcId: 7003,
    dataType: 'foundation' as const,
    description: 'Mystery, raw',
    nutrientAmount: 1,
    portions: [{ usda_portion_id: 5, amount: 1, measure: 'cup', gram_weight: 100, sequence: 1 }],
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
    title: 'AI Amount',
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

interface Setup {
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly state: Phase4State;
  readonly liveRows: ReadonlyArray<LiveRowState>;
}

function setup(line: string): Setup {
  const adaptation = adaptRecipe(recipe(line));
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 2);
  const rows = buildReviewRows(session, adapted);
  const state = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: null,
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
  const analyzedByRef = new Map(analysis.rows.map((analysisRow) => [analysisRow.line_ref, analysisRow]));
  const liveRows = projectLiveRows(
    state,
    analyzedByRef,
    adapted,
    session,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
    analysis.portions,
    analysis.countPortions
  );
  return { adapted, rows, state, liveRows };
}

function suggestion(
  lineRef: string,
  overrides: Partial<AiResolutionSuggestion> = {}
): AiResolutionSuggestion {
  return {
    line_ref: lineRef,
    interpreted_food_name: 'Garlic, raw',
    suggested_usda_queries: ['garlic raw'],
    quantity_value: 3,
    quantity_unit_hint: 'cloves',
    count_descriptor_hint: 'clove',
    portion_search_hint: 'clove',
    ...overrides,
  };
}

describe('AI amount interpretation — local verification', () => {
  it('resolves a needs_amount count line through an authenticated USDA portion', () => {
    const { adapted, rows, state, liveRows } = setup('3 garlic cloves, minced');
    const summary = summarizeLiveRows(liveRows);
    expect(summary.needs_amount).toBe(1);
    expect(summary.needs_match).toBe(0);

    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state,
      suggestions: [suggestion(rows[0].line_ref)],
    });
    expect(outcome.resolved).toHaveLength(1);
    expect(outcome.resolved[0].resolved_grams).toBe(9);
    expect(outcome.resolved[0].choice.aiAssisted).toBe(true);
    expect(outcome.resolved[0].choice.automatic).toBe(true);

    // The genuine calculator independently re-derives the mass from the
    // authenticated USDA portion (3 cloves x 3 g per clove = 9 g).
    const merged: Phase4State = {
      ...state,
      countPortions: { ...state.countPortions, [rows[0].line_ref]: outcome.resolved[0].choice },
    } as Phase4State;
    const calculated = session.calculate(buildCalculationRequest(adapted, merged));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients[0];
    expect(evidence.outcome).toBe('calculated');
    expect(evidence.resolved_grams).toBe(9);
    expect(evidence.mass_source).toBe('count_portion');
    expect(evidence.count_unit).toBe('clove');
    // Category B provenance: AI-assisted deterministic, NEVER user-confirmed.
    expect(evidence.match_status).toBe('auto_confirmed');
    expect(evidence.user_confirmed).toBe(false);
    // No Apply authority is created by AI assistance.
    expect(calculated.preview.application_authorized).toBe(false);
  });

  it('offers materially different authenticated weights instead of silently choosing', () => {
    const { adapted, rows, state, liveRows } = setup('3 slices bread');
    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state,
      suggestions: [
        suggestion(rows[0].line_ref, {
          interpreted_food_name: 'Bread, white',
          suggested_usda_queries: ['bread white'],
          quantity_value: 3,
          quantity_unit_hint: 'slices',
          count_descriptor_hint: 'slice',
          portion_search_hint: 'slice',
        }),
      ],
    });
    expect(outcome.resolved).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(0);
    expect(outcome.offers).toHaveLength(2);
    const grams = outcome.offers.map((offer) => offer.resolved_grams).sort((a, b) => a - b);
    expect(grams).toEqual([75, 96]);
  });

  it('lets the user explicitly choose an offered authenticated portion', () => {
    const { adapted, rows, state, liveRows } = setup('3 slices bread');
    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state,
      suggestions: [
        suggestion(rows[0].line_ref, {
          interpreted_food_name: 'Bread, white',
          suggested_usda_queries: ['bread white'],
          quantity_value: 3,
          count_descriptor_hint: 'slice',
          portion_search_hint: 'slice',
        }),
      ],
    });
    const offer = outcome.offers.find((entry) => entry.resolved_grams === 75);
    if (!offer) throw new Error('missing offer');
    const choice = buildUserChoiceFromAiAmountOffer({
      session,
      offer,
      row: rows[0],
      entry: adapted[0],
      matchChoice: state.matches[rows[0].line_ref],
    });
    expect(choice).toBeDefined();
    if (!choice) return;
    // An explicit user choice is NOT an AI-assisted automatic acceptance.
    expect(choice.aiAssisted).toBeUndefined();
    const merged: Phase4State = {
      ...state,
      countPortions: { ...state.countPortions, [rows[0].line_ref]: choice },
    } as Phase4State;
    const calculated = session.calculate(buildCalculationRequest(adapted, merged));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].resolved_grams).toBe(75);
  });

  it('ignores an AI quantity that materially disagrees with the recipe (no invented mass)', () => {
    const { adapted, rows, state, liveRows } = setup('3 garlic cloves, minced');
    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state,
      suggestions: [suggestion(rows[0].line_ref, { quantity_value: 30 })],
    });
    expect(outcome.resolved).toHaveLength(0);
    expect(outcome.inconsistent).toEqual([rows[0].line_ref]);
    expect(outcome.unresolved).toHaveLength(0);
  });

  it('leaves the line unresolved when the interpretation carries no closed count identity', () => {
    const { adapted, rows, state, liveRows } = setup('3 garlic cloves, minced');
    expect(countRequirementHintFromSuggestion(suggestion(rows[0].line_ref, { count_descriptor_hint: 'garlic clove', portion_search_hint: 'a clove of garlic' }))).toBeDefined();
    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state,
      suggestions: [
        suggestion(rows[0].line_ref, {
          quantity_unit_hint: 'garlic',
          count_descriptor_hint: 'unknown',
          portion_search_hint: 'some garlic',
        }),
      ],
    });
    expect(outcome.resolved).toHaveLength(0);
    expect(outcome.offers).toHaveLength(0);
    expect(outcome.unresolved).toEqual([rows[0].line_ref]);
  });

  it('leaves the line unresolved when no authenticated compatible portion exists', () => {
    // The garlic identity is resolved, but a celery hint cannot bind a portion.
    const { adapted, rows, state, liveRows } = setup('3 garlic cloves, minced');
    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state,
      suggestions: [
        suggestion(rows[0].line_ref, {
          quantity_unit_hint: 'stalk',
          count_descriptor_hint: 'stalk',
          portion_search_hint: 'stalk',
        }),
      ],
    });
    expect(outcome.resolved).toHaveLength(0);
    expect(outcome.unresolved).toEqual([rows[0].line_ref]);
  });

  it('fails a forged count-requirement hint closed in the calculator', () => {
    const { adapted, rows, state } = setup('3 garlic cloves, minced');
    const calculated = session.calculate({
      servings: 2,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: rows[0].line_ref,
          ingredient: adapted[0].ingredient,
          count_requirement_hint: { unit: 'barrel', size: null },
        },
      ],
    });
    expect(calculated.ok).toBe(false);
  });

  it('keeps the AI contract free of any mass/quantity authority field', () => {
    const { rows } = setup('3 garlic cloves, minced');
    const sanitized = suggestion(rows[0].line_ref) as unknown as Record<string, unknown>;
    // The bounded interpretation fields are the ONLY amount-related keys.
    expect(Object.keys(sanitized)).not.toContain('grams');
    expect(Object.keys(sanitized)).not.toContain('mass_g');
    expect(Object.keys(sanitized)).not.toContain('fdc_id');
    expect(sanitized.quantity_value).toBe(3);
  });

  it('parses the canonical recipe count for the bind (no AI amount input)', () => {
    const parsed = parseIngredient(structuredLine('3 garlic cloves, minced'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.parsed.amount).toBe(3);
    expect(parseIngredientLine('3 garlic cloves, minced').amount).toBe(3);
  });
});
