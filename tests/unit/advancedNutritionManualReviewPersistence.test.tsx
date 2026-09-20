// @vitest-environment jsdom
/**
 * Advanced Nutrition — manual review persistence (DOM).
 *
 * Proves an explicitly Reviewed/Applied manual USDA selection and its mass
 * survive reopen + Re-analyze for an unchanged recipe. Regression for manually
 * selected rows reverting to NEEDS MATCH / NEEDS AMOUNT after re-analysis.
 *
 * (The real-pinned-bundle broccoli/garlic acceptance lives in the faster node
 * suite `advancedNutritionHydration.test.ts`.)
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
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
    id: 'butter-salt',
    fileName: 'Butter Salt.md',
    filePath: 'Recipes/Butter Salt.md',
    rawMarkdown: '',
    title: 'Butter Salt',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: [
      { original: '57 g unsalted butter', amount: 57, unit: 'g', name: 'unsalted butter' },
      { original: '5 g salt', amount: 5, unit: 'g', name: 'salt' },
    ] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
  } as unknown as ObsidianRecipe;
}

/** The saved block records BOTH reviewed manual decisions. */
function savedBlock(target: ObsidianRecipe): CodexNutritionV1 {
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const raw: CodexNutritionV1 = {
    schema: 1,
    basis: 'total',
    servings: 4,
    status: 'complete',
    computed_at: '2026-09-20T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'r' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: { amount: 200, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
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
      {
        line_ref: adaptation.recipe.adapted[1].line_ref,
        source: 'usda_fdc',
        source_food_id: '1003',
        source_release: 'r',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
        amount: { value: 5, unit: 'g' },
        conversion_basis: 'direct_mass',
      },
    ],
    unresolved: [],
  };
  const validation = validateCodexNutritionV1(raw);
  if (!validation.ok || !validation.value) throw new Error('block invalid');
  return validation.value;
}

/** Finds a row by the START of its original ingredient text (avoids substring traps). */
function rowByOriginal(prefix: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((row) =>
    (row.querySelector('p')?.textContent ?? '').toLowerCase().startsWith(prefix.toLowerCase())
  ) as HTMLElement | undefined;
}

async function openWorkingEditor(): Promise<void> {
  fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
  await screen.findByTestId('saved-advanced-status');
  fireEvent.click(screen.getByTestId('saved-advanced-edit'));
  await screen.findByTestId('advanced-nutrition-analyze');
}

describe('manual review persistence', () => {
  it('restores the manual food choices and masses on reopen', async () => {
    const target = recipe();
    render(
      <AdvancedNutritionCard
        recipe={target}
        session={session}
        savedAdvancedBlock={savedBlock(target)}
        onLoadBundle={vi.fn()}
        onApplyAdvancedNutrition={vi.fn()}
      />
    );
    await openWorkingEditor();

    await waitFor(() => {
      const butter = rowByOriginal('57 g unsalted butter');
      expect(butter?.textContent).toMatch(/butter, stick, unsalted/i);
      expect(butter?.textContent).toMatch(/57 g/);
      expect(butter?.querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent).toMatch(/Matched/i);
      const salt = rowByOriginal('5 g salt');
      expect(salt?.textContent).toMatch(/salt, table/i);
      expect(salt?.textContent).toMatch(/5 g/);
      expect(salt?.querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent).toMatch(/Matched/i);
    });
  });

  it('keeps the manual choices through Re-analyze (never reverts to NEEDS MATCH)', async () => {
    const target = recipe();
    render(
      <AdvancedNutritionCard
        recipe={target}
        session={session}
        savedAdvancedBlock={savedBlock(target)}
        onLoadBundle={vi.fn()}
        onApplyAdvancedNutrition={vi.fn()}
      />
    );
    await openWorkingEditor();

    fireEvent.click(await screen.findByTestId('advanced-nutrition-analyze'));

    await waitFor(() => {
      const butter = rowByOriginal('57 g unsalted butter');
      const salt = rowByOriginal('5 g salt');
      expect(butter?.textContent).toMatch(/butter, stick, unsalted/i);
      expect(butter?.textContent).toMatch(/57 g/);
      expect(butter?.querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent).toMatch(/Matched/i);
      expect(salt?.textContent).toMatch(/salt, table/i);
      expect(salt?.textContent).toMatch(/5 g/);
      expect(salt?.querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent).toMatch(/Matched/i);
    });
    expect(screen.getByTestId('advanced-nutrition-analysis-runs').textContent).toMatch(/run 1/i);
  });

  it('still lets Re-analyze fill in rows the user has NOT decided', async () => {
    // The salt line has NO saved evidence: the analyzer should supply it.
    const target = recipe();
    const block = savedBlock(target);
    const partialBlock: CodexNutritionV1 = {
      ...block,
      status: 'partial',
      ingredients: block.ingredients.slice(0, 1),
      unresolved: [{ line_ref: block.ingredients[1].line_ref, reason: 'no_match' }],
    };
    render(
      <AdvancedNutritionCard
        recipe={target}
        session={session}
        savedAdvancedBlock={partialBlock}
        onLoadBundle={vi.fn()}
        onApplyAdvancedNutrition={vi.fn()}
      />
    );
    await openWorkingEditor();
    fireEvent.click(await screen.findByTestId('advanced-nutrition-analyze'));
    await waitFor(() => {
      const butter = rowByOriginal('57 g unsalted butter');
      const salt = rowByOriginal('5 g salt');
      expect(butter?.textContent).toMatch(/butter, stick, unsalted/i);
      expect(salt?.textContent).toMatch(/salt, table/i);
      expect(salt?.querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent).toMatch(/Matched/i);
    });
  });
});
