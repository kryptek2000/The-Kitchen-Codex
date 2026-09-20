// @vitest-environment jsdom
/**
 * The Kitchen Codex — Advanced Nutrition Phase 5B: explicit Apply UI.
 *
 * Proves the Apply control is user-triggered only (never automatic), requires an
 * explicit confirmation that distinguishes create vs. replace, disables while
 * ineligible/busy, prevents duplicate writes, and surfaces bounded feedback.
 * The card NEVER writes itself: it invokes the injected shell handler.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';
import { buildCalculationBundle, CALC_FOODS } from '../fixtures/usdaCalculationFixtures';
import type { AdvancedNutritionApplyHandler } from '../../src/components/AdvancedNutritionCard';

function genuineSession(): AdvancedNutritionSession {
  const bundle = buildCalculationBundle(CALC_FOODS);
  const result = createAdvancedNutritionSession(bundle.manifest, bundle.records);
  if (!result.ok) throw new Error('session failed');
  return result.session;
}

function recipe(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Test Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: [
      { original: '100 g Flour, wheat, white', amount: 100, unit: 'g', name: 'Flour, wheat, white' },
    ],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...overrides,
  };
}

afterEach(() => cleanup());

async function openAndCalculate(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i }));
  const dialog = await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
  fireEvent.click(screen.getByRole('button', { name: /Calculate Preview/i }));
  await screen.findByText('Advisory nutrition preview');
  return dialog;
}

describe('phase 5B card — explicit Apply UX', () => {
  it('offers no Apply control when no write handler is wired', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    const dialog = await openAndCalculate();
    expect(Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent ?? '').join(' ')).not.toMatch(
      /\bApply\b/
    );
  });

  it('does not apply automatically on open or calculate', async () => {
    const handler = vi.fn(async () => ({ ok: true, mode: 'create' as const, message: 'Saved.' }));
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} onApplyAdvancedNutrition={handler} />);
    await openAndCalculate();
    expect(handler).not.toHaveBeenCalled();
  });

  it('requires confirmation, distinguishes create, and calls the handler exactly once', async () => {
    const handler = vi.fn<AdvancedNutritionApplyHandler>(async () => ({
      ok: true,
      mode: 'create',
      message: 'Advanced Nutrition was saved to your recipe.',
    }));
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} onApplyAdvancedNutrition={handler} />);
    const dialog = await openAndCalculate();

    const applyButton = screen.getByRole('button', { name: /Apply to recipe/i });
    expect(applyButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(applyButton);

    expect(await screen.findByText(/will add a saved Advanced Nutrition block/i)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: /Confirm Apply/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const args = handler.mock.calls[0][0];
    expect(args.expectedMode).toBe('create');
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(dialog.textContent).toMatch(/was saved to your recipe/i);
  });

  it('distinguishes replace and passes the replace expected mode', async () => {
    const handler = vi.fn<AdvancedNutritionApplyHandler>(async () => ({
      ok: true,
      mode: 'replace',
      message: 'Advanced Nutrition was replaced and saved to your recipe.',
    }));
    const stored = {
      schema: 1,
      basis: 'total',
      servings: 2,
      status: 'partial',
      computed_at: '2026-09-14T00:00:00.000Z',
      ingredient_digest: `sha256:${'a'.repeat(64)}`,
      dv_standard: 'fda_adult_4plus_2020',
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: 'r' },
      nutrient_scope: ['calories'],
      nutrients: {},
      ingredients: [],
      unresolved: [],
    };
    render(
      <AdvancedNutritionCard
        recipe={recipe({ frontmatter: { codex_nutrition: stored }, codexNutrition: stored as never })}
        session={genuineSession()}
        onApplyAdvancedNutrition={handler}
      />
    );
    await openAndCalculate();
    fireEvent.click(screen.getByRole('button', { name: /Apply and replace saved nutrition/i }));
    expect(await screen.findByText(/will replace the existing saved Advanced Nutrition block/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Confirm Apply/i }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0].expectedMode).toBe('replace');
  });

  it('cancelling the confirmation performs no write', async () => {
    const handler = vi.fn(async () => ({ ok: true, mode: 'create' as const, message: 'Saved.' }));
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} onApplyAdvancedNutrition={handler} />);
    await openAndCalculate();
    fireEvent.click(screen.getByRole('button', { name: /Apply to recipe/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/i }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('disables Apply while in flight and surfaces a bounded failure', async () => {
    let resolve: ((value: { ok: boolean; message: string }) => void) | undefined;
    const handler = vi.fn<AdvancedNutritionApplyHandler>(
      () => new Promise((r) => { resolve = r as never; })
    );
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} onApplyAdvancedNutrition={handler} />);
    await openAndCalculate();
    fireEvent.click(screen.getByRole('button', { name: /Apply to recipe/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm Apply/i }));

    const busy = await screen.findByRole('button', { name: /Applying…/i });
    expect(busy.hasAttribute('disabled')).toBe(true);

    resolve?.({ ok: false, message: 'The recipe or review changed before Apply completed. Nothing was written.' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing was written/i);
  });

  it('disables Apply for an opaque future schema', async () => {
    const handler = vi.fn(async () => ({ ok: true, mode: 'create' as const, message: 'Saved.' }));
    render(
      <AdvancedNutritionCard
        recipe={recipe({ codexNutrition: { kind: 'opaque', schema: 2, data: {} } as never })}
        session={genuineSession()}
        onApplyAdvancedNutrition={handler}
      />
    );
    await openAndCalculate();
    const applyButton = screen.getByRole('button', { name: /Apply to recipe/i });
    expect(applyButton.hasAttribute('disabled')).toBe(true);
  });
});
