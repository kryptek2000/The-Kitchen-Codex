// @vitest-environment jsdom
/**
 * The Kitchen Codex — Advanced Nutrition Phase 7 FLAG F-3: the Modal household
 * portion display must never render stored/unverified grams.
 *
 * The stored `HouseholdPortionChoice.resolved_grams` field is a display claim
 * only. This suite proves the Modal renders gram values exclusively from the
 * SAME calculator/live-verified row projection used by the collapsed row:
 *   - a valid verified household choice displays the exact verified grams and
 *     source (calculator = live = modal);
 *   - a tampered stored `resolved_grams` can never change any visible grams;
 *   - a tampered selection (rejected by the calculator) shows no grams, no
 *     MATCHED state, and no household chip.
 *
 * The session is a SYNTHETIC fixture catalog whose FDC id is bound by the REAL
 * verified household registry; the builder/calculator/registry paths are the
 * genuine Phase 6/7 ones.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { AdvancedNutritionModal } from '../../src/components/AdvancedNutritionModal';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { resolveHouseholdsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiHouseholdResolve';
import {
  INITIAL_PHASE4_STATE,
  adaptRecipe,
  analyzeRecipe,
  buildCalculationRequest,
  buildReviewRows,
  ingredientEvidenceViews,
  phase4Reducer,
  phase4SessionIdentity,
  projectLiveRows,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type HouseholdPortionChoice,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const SPECS = [
  {
    fdcId: 2709719,
    dataType: 'foundation' as const,
    description: 'Tomatoes, raw',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 180, sequence: 1 }],
  },
];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

afterEach(() => cleanup());

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredient(line);
  if (!parsed.ok) return { original: line };
  const p = parsed.parsed;
  return {
    original: line,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function recipe(lines: ReadonlyArray<string>, id = 'modal-display'): ObsidianRecipe {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `Recipes/${id}.md`,
    rawMarkdown: '',
    title: `Recipe ${id}`,
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: lines.map((line) => structured(line)) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

interface Harness {
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly state: Phase4State;
  readonly choice: HouseholdPortionChoice;
  readonly lineRef: string;
}

/** Builds the verified state and the genuine AI-assisted household choice. */
function harness(): Harness {
  const target = recipe(['2 tomatoes']);
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 2);
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows,
    baseServings: 2,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  });
  const liveRows = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
    analysis.portions,
    analysis.countPortions
  );
  const outcome = resolveHouseholdsFromAiSuggestions({
    session,
    rows,
    adapted,
    liveRows,
    state,
    suggestions: [
      {
        line_ref: adapted[0].line_ref,
        interpreted_food_name: 'Tomatoes, raw',
        suggested_usda_queries: [],
        household_size_hint: 'medium',
      },
    ],
  });
  if (outcome.resolved.length !== 1) throw new Error('household resolution failed');
  return { adapted, state, choice: outcome.resolved[0].choice, lineRef: adapted[0].line_ref };
}

function renderModal(adapted: ReadonlyArray<AdaptedIngredient>, state: Phase4State) {
  const analysis = analyzeRecipe(session, adapted, 2);
  return render(
    <AdvancedNutritionModal
      isOpen
      onClose={vi.fn()}
      title="Modal Display"
      session={session}
      adapted={adapted}
      state={state}
      dispatch={vi.fn() as never}
      onCalculate={vi.fn()}
      calculating={false}
      analysis={analysis}
      onAnalyze={vi.fn()}
    />
  );
}

function expandFirstRow(): void {
  fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[0]);
}

function householdPanel(): HTMLElement {
  const panel = document.querySelector('[data-testid="advanced-nutrition-household-portion"]');
  if (!panel) throw new Error('missing household panel');
  return panel as HTMLElement;
}

function rowText(): string {
  return (
    (document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement | null)
      ?.textContent ?? ''
  );
}

describe('phase 7 F-3 — Modal household grams are calculator/live verified', () => {
  it('displays the exact verified grams and source, never the stored claim', () => {
    const { adapted, state, choice, lineRef } = harness();
    // The genuine verified choice is 2 × 123 g = 246 g.
    expect(choice.resolved_grams).toBe(246);

    const applied = phase4Reducer(state, {
      type: 'select_household_portion',
      lineRef,
      choice,
    });
    const calculated = session.calculate(buildCalculationRequest(adapted, applied));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients[0];
    expect(evidence.mass_source).toBe('household_portion');
    expect(evidence.resolved_grams).toBe(246);
    expect(evidence.household_record_key).toBe('tomato|item|medium|null');
    expect(evidence.household_authority_class).toBe('usda_derived');

    renderModal(adapted, applied);
    // Collapsed row (live projection) agrees.
    expect(rowText()).toMatch(/Matched/);
    expect(rowText()).toMatch(/246 g · vetted household portion/);
    // Expanded Modal panel (calculator/live verified) agrees exactly.
    expandFirstRow();
    const panel = householdPanel();
    expect(panel.textContent).toMatch(/246 g/);
    expect(panel.textContent).toMatch(/Kitchen Codex household portion/);
    expect(panel.textContent).not.toMatch(/999/);
  });

  it('a tampered stored resolved_grams never alters any visible grams', () => {
    const { adapted, state, choice, lineRef } = harness();
    const tampered = { ...choice, resolved_grams: 999 } as HouseholdPortionChoice;
    const applied = phase4Reducer(state, {
      type: 'select_household_portion',
      lineRef,
      choice: tampered,
    });
    // The calculator re-derives the genuine 246 g from the untouched selection.
    const calculated = session.calculate(buildCalculationRequest(adapted, applied));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].resolved_grams).toBe(246);

    renderModal(adapted, applied);
    expect(rowText()).toMatch(/246 g/);
    expect(rowText()).not.toMatch(/999/);
    expandFirstRow();
    const panel = householdPanel();
    expect(panel.textContent).toMatch(/246 g/);
    expect(panel.textContent).not.toMatch(/999/);
  });

  it('a rejected (tampered-selection) choice shows no grams, no MATCHED, and no household chip', () => {
    const { adapted, state, choice, lineRef } = harness();
    const forged = JSON.parse(JSON.stringify(choice)) as HouseholdPortionChoice;
    (forged.selection as { resolved_grams: number }).resolved_grams = 999;
    const applied = phase4Reducer(state, {
      type: 'select_household_portion',
      lineRef,
      choice: forged,
    });
    // The calculator refuses the whole request; the live projection fails too.
    const calculated = session.calculate(buildCalculationRequest(adapted, applied));
    expect(calculated.ok).toBe(false);

    renderModal(adapted, applied);
    const text = rowText();
    expect(text).toMatch(/Needs amount/);
    expect(text).not.toMatch(/Matched/);
    expect(text).not.toMatch(/vetted household portion|household estimate/);
    expect(text).not.toMatch(/999/);

    expandFirstRow();
    const panel = householdPanel();
    // The stored (unverified) choice is visible for Clear, but no gram value is
    // ever displayed and no verified household label is claimed.
    expect(panel.textContent).toMatch(/Stored household portion/);
    expect(panel.textContent).toMatch(/not accepted by the current calculation/);
    expect(panel.textContent).not.toMatch(/999/);
  });
});
