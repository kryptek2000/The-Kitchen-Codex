// @vitest-environment jsdom
/**
 * Advanced Nutrition — saved-report lifecycle + working-review hydration.
 *
 * Proves the saved report renders without any analyzer session, that
 * Edit / Re-analyze initializes the working analyzer lazily, and that previously
 * reviewed evidence (food choice + user-entered total weight) hydrates back into
 * the working review for an unchanged recipe.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import { validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const SPECS = [
  { fdcId: 1002, dataType: 'foundation' as const, description: 'Butter, stick, unsalted' },
  { fdcId: 1003, dataType: 'foundation' as const, description: 'Salt, table' },
];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

afterEach(() => cleanup());

function recipe(): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Saved Report Lifecycle',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: [
      // A volume line: a user-entered total weight is a valid fallback here.
      // (Phase 0B: a line that already declares a direct recipe mass never
      // carries a user mass; that conflicting state is refused at creation.)
      { original: '2 tbsp unsalted butter', amount: 2, unit: 'tbsp', name: 'unsalted butter' },
      { original: '1/2 teaspoon salt', amount: 0.5, unit: 'teaspoon', name: 'salt' },
    ] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
  } as unknown as ObsidianRecipe;
}

/** Builds a valid saved block whose evidence binds the CURRENT adapted lines. */
function savedBlockFor(target: ObsidianRecipe, overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const raw: CodexNutritionV1 = {
    schema: 1,
    basis: 'total',
    servings: 4,
    status: 'complete',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'r' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: {
        amount: 3210,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 2,
        measurable_ingredient_count: 2,
      },
    },
    ingredients: [
      {
        line_ref: adaptation.recipe.adapted[0].line_ref,
        source: 'usda_fdc',
        source_food_id: '1002',
        source_release: 'r',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
        amount: { value: 57, unit: 'g' },
      },
    ],
    unresolved: [],
    ...overrides,
  };
  const validation = validateCodexNutritionV1(raw);
  if (!validation.ok || !validation.value) throw new Error('block invalid');
  return validation.value;
}

describe('saved Advanced report lifecycle', () => {
  it('opens the saved report immediately without initializing the USDA analyzer', () => {
    const onLoadBundle = vi.fn();
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        savedAdvancedBlock={savedBlockFor(recipe())}
        onLoadBundle={onLoadBundle}
        onApplyAdvancedNutrition={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    // The saved report is visible from the persisted block alone.
    expect(screen.getByTestId('saved-advanced-status')).toBeTruthy();
    expect(screen.getByTestId('saved-advanced-status').textContent).toMatch(/Complete ingredient coverage/i);
    // No analyzer initialization was required.
    expect(onLoadBundle).not.toHaveBeenCalled();
    expect(screen.queryByTestId('advanced-nutrition-working-banner')).toBeNull();
  });

  it('renders partial saved results with an honest partial status', () => {
    const base = recipe();
    const partial = savedBlockFor(base, {
      status: 'partial',
      unresolved: [{ line_ref: 'ing:9:unresolved', reason: 'no_match' }],
    });
    render(<AdvancedNutritionCard recipe={base} savedAdvancedBlock={partial} onLoadBundle={vi.fn()} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    expect(screen.getByTestId('saved-advanced-status').textContent).toMatch(/Partial ingredient coverage/i);
    expect(screen.getByTestId('saved-advanced-status').textContent).toMatch(/1 of 2 ingredient lines resolved/i);
  });

  it('switches display basis without mutating stored totals', () => {
    const base = recipe();
    render(<AdvancedNutritionCard recipe={base} savedAdvancedBlock={savedBlockFor(base)} onLoadBundle={vi.fn()} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    expect(screen.getByTestId('saved-advanced-basis-label').textContent).toBe('Entire recipe');
    expect(screen.getByText(/3210/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('saved-advanced-basis-per_serving'));
    expect(screen.getByTestId('saved-advanced-basis-label').textContent).toBe('Per serving');
    expect(screen.getByText(/802\.5/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('saved-advanced-basis-entire_recipe'));
    expect(screen.getByText(/3210/)).toBeTruthy();
  });

  it('Edit / Re-analyze initializes the analyzer lazily and hydrates prior evidence', async () => {
    const base = recipe();
    const onLoadBundle = vi.fn();
    render(
      <AdvancedNutritionCard
        recipe={base}
        session={session}
        savedAdvancedBlock={savedBlockFor(base)}
        onLoadBundle={onLoadBundle}
        onApplyAdvancedNutrition={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    expect(screen.getByTestId('saved-advanced-status')).toBeTruthy();
    fireEvent.click(screen.getByTestId('saved-advanced-edit'));
    const analyze = await screen.findByTestId('advanced-nutrition-analyze');
    expect(analyze).toBeTruthy();
    // The working review banner makes the saved-vs-working distinction explicit.
    expect(screen.getByTestId('advanced-nutrition-working-banner').textContent).toMatch(
      /Working Advanced Nutrition review/i
    );
    // The previously reviewed butter line is hydrated: selected food + 57 g.
    const rows = document.querySelectorAll('[data-testid="advanced-nutrition-row"]');
    const butterRow = Array.from(rows).find((row) => (row.textContent ?? '').includes('unsalted butter')) as HTMLElement;
    expect(butterRow).toBeTruthy();
    await waitFor(() => {
      expect(butterRow.textContent).toMatch(/butter/i);
      expect(butterRow.textContent).toMatch(/57 g/);
      expect(butterRow.textContent).toMatch(/user-entered/i);
    });
  });

  it('closing the working editor without Apply preserves the saved report', async () => {
    const base = recipe();
    const block = savedBlockFor(base);
    render(<AdvancedNutritionCard recipe={base} session={session} savedAdvancedBlock={block} onApplyAdvancedNutrition={vi.fn()} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    expect(screen.getByText(/3210/)).toBeTruthy();
    // Edit, then close without saving.
    fireEvent.click(screen.getByTestId('saved-advanced-edit'));
    await screen.findByTestId('advanced-nutrition-analyze');
    fireEvent.click(screen.getByTestId('advanced-nutrition-close-without-saving'));
    await waitFor(() => expect(screen.queryByTestId('advanced-nutrition-analyze')).toBeNull());
    // Reopen: the original saved report is still present and unchanged.
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    expect(screen.getByTestId('saved-advanced-status').textContent).toMatch(/Complete ingredient coverage/i);
    expect(screen.getByText(/3210/)).toBeTruthy();
  });

  it('marks the working review dirty only after a genuine user edit', async () => {
    const base = recipe();
    render(<AdvancedNutritionCard recipe={base} session={session} savedAdvancedBlock={savedBlockFor(base)} onApplyAdvancedNutrition={vi.fn()} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    fireEvent.click(screen.getByTestId('saved-advanced-edit'));
    await screen.findByTestId('advanced-nutrition-working-banner');
    // Hydrated but clean: no unsaved-changes wording yet.
    await waitFor(() => {
      expect(screen.getByTestId('advanced-nutrition-working-banner').textContent).toMatch(/Hydrated from the saved review/i);
    });
    // A genuine user edit marks it dirty.
    const analyze = await screen.findByTestId('advanced-nutrition-analyze');
    fireEvent.click(analyze);
    await waitFor(() => {
      expect(screen.getByTestId('advanced-nutrition-working-banner').textContent).toMatch(/Unsaved changes/i);
    });
  });
});
