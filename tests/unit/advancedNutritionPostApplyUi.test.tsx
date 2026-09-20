// @vitest-environment jsdom
/**
 * Advanced Nutrition — post-Apply reconciliation.
 *
 * After an explicit Apply the live review session must NOT be presented as a
 * second "UNSAVED REVIEW — NOT APPLIED" panel when it is byte-for-byte the
 * result that was just saved (compared by the canonical ingredient digest). A
 * subsequent genuine change re-surfaces the unsaved-review panel.
 */

import { describe, it, expect, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

import { AdvancedNutritionCard, type AdvancedNutritionApplyHandler } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';

const RECIPE_LINES = ['1 cup flour'];

const SPECS: ReadonlyArray<CalcRecordSpec> = [
  {
    fdcId: 7001,
    dataType: 'sr_legacy',
    description: 'Flour, wheat, white',
    nutrients: { calories: 364, protein: 10 },
    portions: [{ usda_portion_id: 1, amount: 1, measure: 'cup', gram_weight: 125, sequence: 1 }],
  },
  {
    fdcId: 7002,
    dataType: 'sr_legacy',
    description: 'Flour, wheat, whole-grain',
    nutrients: { calories: 340, protein: 13 },
    portions: [{ usda_portion_id: 2, amount: 1, measure: 'cup', gram_weight: 120, sequence: 1 }],
  },
];

function genuineSession(): AdvancedNutritionSession {
  const bundle = buildCalculationBundle(SPECS);
  const result = createAdvancedNutritionSession(bundle.manifest, bundle.records);
  if (!result.ok) throw new Error('session failed');
  return result.session;
}

const session = genuineSession();

afterEach(() => cleanup());

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function makeRecipe(): ObsidianRecipe {
  return {
    id: 'post-apply',
    fileName: 'post-apply.md',
    filePath: 'Recipes/post-apply.md',
    rawMarkdown: '',
    title: 'Post Apply Recipe',
    tags: [],
    category: 'Dessert',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: RECIPE_LINES.map(structured),
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
  } as unknown as ObsidianRecipe;
}

const Harness: React.FC = () => {
  const [recipe, setRecipe] = useState<ObsidianRecipe>(() => makeRecipe());
  const handler: AdvancedNutritionApplyHandler = async (args) => {
    const result = await applyAdvancedNutrition({
      session: args.session,
      recipe: args.recipe,
      state: args.state,
      expectedMode: args.expectedMode,
      write: async (updated) => {
        setRecipe(updated);
      },
    });
    if (result.ok) {
      return { ok: true, mode: result.result.mode, message: 'Advanced Nutrition was saved to your recipe.' };
    }
    return { ok: false, message: 'Advanced Nutrition could not be applied.' };
  };
  return <AdvancedNutritionCard recipe={recipe} session={session} onApplyAdvancedNutrition={handler} />;
};

async function openAndCalculate(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i }));
  await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
  // One-click analyzer applies the automatic food + portion to live state.
  fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
  fireEvent.click(screen.getByRole('button', { name: /Calculate Preview/i }));
  await screen.findByText('Advisory nutrition preview');
}

describe('post-Apply reconciliation', () => {
  it('does not show an identical unsaved review after Apply, and shows it after a real change', async () => {
    render(<Harness />);
    await openAndCalculate();
    fireEvent.click(screen.getByRole('button', { name: /Apply to recipe/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm Apply/i }));
    await screen.findByText(/was saved to your recipe/i);

    // Saved block is authoritative; no duplicate identical unsaved panel.
    await waitFor(() => expect(screen.getByTestId('advanced-saved-complete')).toBeTruthy());
    expect(screen.queryByText(/Unsaved review — not applied/i)).toBeNull();

    // A genuine change (different cornmeal record) + recalculate diverges from the
    // saved digest and re-surfaces the unsaved-review panel.
    const dialog = screen.getByRole('dialog', { name: 'Advanced Nutrition' });
    const flourRow = Array.from(
      dialog.querySelectorAll('[data-testid="advanced-nutrition-row"]')
    ).find((row) => /flour/i.test(row.textContent ?? '')) as HTMLElement;
    fireEvent.click(flourRow.querySelector('[data-testid="advanced-nutrition-edit"]') as HTMLButtonElement);
    const change = flourRow.querySelector(
      '[data-testid="advanced-nutrition-change-food"]'
    ) as HTMLButtonElement | null;
    if (change) fireEvent.click(change);
    const radios = Array.from(flourRow.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    const alternative = radios.find((radio) => !radio.checked);
    expect(alternative).toBeTruthy();
    if (alternative) fireEvent.click(alternative);
    fireEvent.click(screen.getByRole('button', { name: /Recalculate Preview|Calculate Preview/i }));
    await screen.findByText('Advisory nutrition preview');
    fireEvent.click(screen.getByRole('button', { name: /Close Advanced Nutrition/i }));

    expect(await screen.findByText(/Unsaved review — not applied/i)).toBeTruthy();
  });
});
