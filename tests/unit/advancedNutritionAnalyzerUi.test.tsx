// @vitest-environment jsdom
/**
 * Advanced Nutrition — post-Phase-5 smoke-test remediation: compact analyzer UI.
 *
 * Proves the default surface is a COMPACT analysis (no candidate-list explosion),
 * that the one-click Analyze action is primary, that each row exposes an Edit
 * control, and that the detailed candidate/portion tools appear ONLY for the row
 * being edited. Viewing/analyzing never writes.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

import { AdvancedNutritionModal } from '../../src/components/AdvancedNutritionModal';
import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { resolveRecipeNutritionPresentation } from '../../src/core/nutritionV2/phase5c';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import type {
  AdvancedNutritionSession,
  AdaptedIngredient,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const SPECS = [
  { fdcId: 1002, dataType: 'foundation' as const, description: 'Butter, stick, unsalted' },
  { fdcId: 1003, dataType: 'foundation' as const, description: 'Salt, table' },
  { fdcId: 1004, dataType: 'foundation' as const, description: 'Ketchup' },
  { fdcId: 1005, dataType: 'foundation' as const, description: 'Sugar, granulated' },
];

let session: AdvancedNutritionSession;
let state: Phase4State;
let adapted: ReadonlyArray<AdaptedIngredient>;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
  const adaptation = adaptRecipe({
    title: 'UI Test Recipe',
    servings: 4,
    ingredients: [
      { original: '1/2 cup unsalted butter', amount: 0.5, unit: 'cup', name: 'unsalted butter' },
      { original: '1/2 teaspoon salt', amount: 0.5, unit: 'teaspoon', name: 'salt' },
      { original: '1/2 cup ketchup', amount: 0.5, unit: 'cup', name: 'ketchup' },
      { original: 'salt and pepper to taste' },
    ],
  });
  if (!adaptation.ok) throw new Error('adapt failed');
  adapted = adaptation.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows,
    baseServings: 4,
  });
});

afterEach(() => cleanup());

function renderModal(overrides: { onAnalyze?: () => void; dispatch?: ReturnType<typeof vi.fn> } = {}) {
  const analysis = analyzeRecipe(session, adapted, 4);
  const onAnalyze = overrides.onAnalyze ?? vi.fn();
  const dispatch = (overrides.dispatch ?? vi.fn()) as unknown as React.Dispatch<never>;
  const utils = render(
    <AdvancedNutritionModal
      isOpen
      onClose={vi.fn()}
      title="UI Test Recipe"
      session={session}
      adapted={adapted}
      state={state}
      dispatch={dispatch as never}
      onCalculate={vi.fn()}
      calculating={false}
      analysis={analysis}
      onAnalyze={onAnalyze}
    />
  );
  return { ...utils, onAnalyze, dispatch };
}

describe('post-Phase-5 — compact analyzer UI', () => {
  it('exposes a primary Analyze Nutrition action', () => {
    const { onAnalyze } = renderModal();
    const button = screen.getByRole('button', { name: /Analyze Nutrition/i });
    fireEvent.click(button);
    expect(onAnalyze).toHaveBeenCalledTimes(1);
  });

  it('does NOT expand candidate lists by default', () => {
    renderModal();
    // No match radios are rendered until a row's Edit is opened.
    expect(document.querySelectorAll('input[type="radio"][name^="match-"]')).toHaveLength(0);
  });

  it('gives every analyzed ingredient row an accessible Edit control', () => {
    renderModal();
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/ });
    expect(editButtons.length).toBeGreaterThan(0);
  });

  it('expands detailed candidates for ONLY the edited row', () => {
    renderModal();
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/ });
    fireEvent.click(editButtons[0]);
    const radios = document.querySelectorAll('input[type="radio"][name^="match-"]');
    expect(radios.length).toBeGreaterThan(0);
    // Only one row is expanded at a time.
    expect(screen.getAllByRole('button', { name: /^Close$/ })).toHaveLength(1);
  });

  it('closing Edit returns to the compact presentation', () => {
    renderModal();
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
    expect(document.querySelectorAll('input[type="radio"][name^="match-"]')).toHaveLength(0);
  });

  it('shows compact status labels without internal match-class jargon', () => {
    renderModal();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Matched|Review suggested|Needs amount|Needs match|Qualitative/);
    expect(text).not.toMatch(/partial_token_overlap|all_query_tokens_present/);
  });
});

describe('post-Phase-5 — Advanced card Analyze after saved-state reopen', () => {  function cardRecipe(): ObsidianRecipe {
    return {
      id: 'card-r1',
      fileName: 'card-r1.md',
      filePath: 'Recipes/card-r1.md',
      rawMarkdown: '',
      title: 'Card Recipe',
      tags: [],
      category: 'Dinner',
      cuisine: 'Test',
      difficulty: 'Easy',
      rating: 4,
      servings: 4,
      ingredients: [
        { original: '1/2 cup unsalted butter', amount: 0.5, unit: 'cup', name: 'unsalted butter' },
        { original: '1/2 teaspoon salt', amount: 0.5, unit: 'teaspoon', name: 'salt' },
      ] as never,
      instructions: [],
      callouts: [],
      dataviewFields: {},
      wikilinks: [],
      // Simulates a recipe reopened with a saved Advanced result already present.
      // The block is a fully-formed recognized schema-v1 record so the SAVED
      // REPORT can render from it without any USDA analyzer session.
      codexNutrition: {
        schema: 1,
        basis: 'total',
        status: 'partial',
        servings: 4,
        computed_at: '2026-09-14T00:00:00.000Z',
        ingredient_digest: `sha256:${'a'.repeat(64)}`,
        dv_standard: 'fda_adult_4plus_2020',
        sources: ['usda_fdc'],
        source_releases: { usda_fdc: 'r' },
        nutrient_scope: ['calories'],
        nutrients: {
          calories: {
            amount: 120,
            unit: 'kcal',
            status: 'partial',
            coverage: 0.5,
            covered_ingredient_count: 1,
            measurable_ingredient_count: 2,
          },
        },
        ingredients: [],
        unresolved: [{ line_ref: 'ing:1:deadbeefdead', reason: 'no_match' }],
      },
    } as unknown as ObsidianRecipe;
  }

  it('runs a fresh analysis every time Analyze is clicked after a saved-state reopen', async () => {
    const onApply = vi.fn();
    const savedRecipe = cardRecipe();
    const savedBlock = resolveRecipeNutritionPresentation(savedRecipe).advanced;
    render(
      <AdvancedNutritionCard
        recipe={savedRecipe}
        session={session}
        onApplyAdvancedNutrition={onApply}
        savedAdvancedBlock={savedBlock}
      />
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    // A saved Advanced block opens the SAVED REPORT first (no analyzer work).
    expect(await screen.findByTestId('saved-advanced-status')).toBeTruthy();
    // Edit / Re-analyze explicitly initializes the working analyzer.
    fireEvent.click(screen.getByTestId('saved-advanced-edit'));
    const analyze = await screen.findByTestId('advanced-nutrition-analyze');
    expect(analyze.textContent).toMatch(/Analyze Nutrition/i);
    fireEvent.click(analyze);
    // Visible transition: the run counter/state updates.
    expect(screen.getByTestId('advanced-nutrition-analysis-runs').textContent).toMatch(/run 1/i);
    expect(screen.getByTestId('advanced-nutrition-analyze').textContent).toMatch(/Re-analyze/i);
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    expect(screen.getByTestId('advanced-nutrition-analysis-runs').textContent).toMatch(/run 2/i);
    // Analyze NEVER persists.
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('post-Phase-5 — manual USDA search UI', () => {
  it('exposes Search USDA on an expanded row and dispatches a manual selection', async () => {
    const { dispatch } = renderModal();
    // Expand the first row (unsalted butter — matched_exact in the fixture bundle).
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[0]);
    const searchToggle = await screen.findByTestId('advanced-nutrition-search-usda');
    expect(searchToggle.textContent).toMatch(/Search USDA/i);
    fireEvent.click(searchToggle);
    const input = await screen.findByTestId('advanced-nutrition-search-input');
    fireEvent.change(input, { target: { value: 'butter' } });
    fireEvent.click(screen.getByTestId('advanced-nutrition-search-run'));
    const useButtons = await screen.findAllByRole('button', { name: /Use this USDA food/i });
    expect(useButtons.length).toBeGreaterThan(0);
    fireEvent.click(useButtons[0]);
    expect(dispatch).toHaveBeenCalled();
    const action = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      type: string;
      choice: { kind: string; fdc_id: number; record_digest?: string; catalog_digest?: string };
    };
    expect(action.type).toBe('select_match');
    expect(action.choice.kind).toBe('manual');
    expect(action.choice.fdc_id).toBeGreaterThan(0);
    expect(action.choice.record_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(action.choice.catalog_digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
