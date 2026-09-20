// @vitest-environment jsdom
/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: React UI + accessibility.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import { PHASE4_UNAVAILABLE_MESSAGE } from '../../src/core/nutritionV2/phase4/types';
import { PHASE4_UNREADABLE_MESSAGE } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';
import { buildCalculationBundle, CALC_FOODS } from '../fixtures/usdaCalculationFixtures';

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
    servings: 4,
    ingredients: [
      { original: '100 g Flour, wheat, white', amount: 100, unit: 'g', name: 'Flour, wheat, white' },
      { original: '2 cups Flour, wheat, white', amount: 2, unit: 'cups', name: 'Flour, wheat, white' },
      { original: 'Butter', name: 'Butter' },
    ],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...overrides,
  };
}

afterEach(() => cleanup());

/**
 * Post-Phase-5 remediation: the detailed candidate/portion/weight tools are
 * compact by default and appear ONLY for the row being edited. Opens the Edit
 * expansion for the row at `index` (adaptation order).
 */
async function openEdit(index: number): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: /^Edit$/ });
  fireEvent.click(buttons[index]);
}

const ROW_MASS_FLOUR = 0;
const ROW_VOLUME_FLOUR = 1;
const ROW_BUTTER = 2;

describe('phase 4 card — honest availability', () => {
  it('reports unavailable without fabricating data when no session is configured', () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={null} />);
    expect(screen.getByText(PHASE4_UNAVAILABLE_MESSAGE)).toBeTruthy();
    const button = screen.getByRole('button', { name: /Open Advanced Nutrition/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    // No fabricated calories / zeros are shown.
    expect(screen.queryByText(/kcal/)).toBeNull();
  });

  it('fails closed with fixed copy when the recipe is hostile, without crashing', () => {
    const hostile: Record<string, unknown> = { title: 'Hostile' };
    Object.defineProperty(hostile, 'ingredients', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('attacker-message');
      },
    });
    render(
      <AdvancedNutritionCard
        recipe={hostile as unknown as ObsidianRecipe}
        session={genuineSession()}
      />
    );
    expect(screen.getByText(PHASE4_UNREADABLE_MESSAGE)).toBeTruthy();
    // No attacker message is rendered and no review control is offered.
    expect(screen.queryByText(/attacker-message/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Open Advanced Nutrition/i })).toBeNull();
  });

  it('offers the entry point when a genuine session is injected', () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    const button = screen.getByRole('button', { name: /Open Advanced Nutrition/i });
    expect(button.hasAttribute('disabled')).toBe(false);
  });
});

describe('phase 4 modal — accessibility', () => {
  it('exposes a named modal dialog and moves focus into it, restoring on close', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    const opener = screen.getByRole('button', { name: /Open Advanced Nutrition/i });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('uses radio semantics for mutually exclusive match and basis choices', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });

    expect(screen.getByRole('radiogroup', { name: 'Display basis' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Entire recipe' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Per serving' })).toBeTruthy();

    // The ambiguous "Butter" row requires an explicit choice; nothing is
    // preselected. Its detailed tools are behind Edit.
    await openEdit(ROW_BUTTER);
    const none = await screen.findByRole('radio', { name: /None of these/i });
    expect((none as HTMLInputElement).checked).toBe(false);
  });

  it('does not auto-select an ambiguous candidate', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await openEdit(ROW_BUTTER);

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    const matchRadios = radios.filter((radio) => /FDC|None of these/.test(radio.closest('label')?.textContent ?? ''));
    expect(matchRadios.length).toBeGreaterThan(0);
    expect(matchRadios.every((radio) => !radio.checked)).toBe(true);
  });

  it('does not auto-select a source portion', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await openEdit(ROW_VOLUME_FLOUR);

    const load = screen.getByRole('button', { name: /Review source portions/i });
    fireEvent.click(load);
    const portionRadios = (await screen.findAllByRole('radio')).filter((radio) =>
      /=\s*\d+(\.\d+)?\s*g/.test(radio.closest('label')?.textContent ?? '')
    );
    expect(portionRadios.length).toBeGreaterThan(0);
    expect((portionRadios as HTMLInputElement[]).every((radio) => !radio.checked)).toBe(true);
  });

  it('labels an automatic unique-exact match as not user-confirmed', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await openEdit(ROW_MASS_FLOUR);
    expect(dialog.textContent).toMatch(/not\s+manually confirmed by you/i);
  });

  it('offers no Apply or Save control and never constructs codex_nutrition', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    const buttons = Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent ?? '');
    for (const label of buttons) expect(label).not.toMatch(/\bApply\b|\bSave\b/i);
    expect(dialog.textContent).not.toMatch(/codex_nutrition/);
  });
});

describe('phase 4 modal — calculation flow', () => {
  it('calculates only on explicit action and shows an advisory preview with all nutrient groups', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });

    expect(screen.queryByText('Advisory nutrition preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Calculate Preview/i }));
    expect(await screen.findByText('Advisory nutrition preview')).toBeTruthy();

    // All nutrient groups are present.
    expect(screen.getByText('Energy and macronutrients')).toBeTruthy();
    expect(screen.getByText('Vitamins and related nutrients')).toBeTruthy();
    expect(screen.getByText('Vitamin B12')).toBeTruthy();
    expect(screen.getByText('Manganese')).toBeTruthy();
    // Not-medical-advice statement.
    expect(screen.getAllByText(/not medical advice/i).length).toBeGreaterThan(0);
  });

  it('marks the preview stale after a calculation-affecting change', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    fireEvent.click(screen.getByRole('button', { name: /Calculate Preview/i }));
    await screen.findByText('Advisory nutrition preview');

    // Select "None of these" for the ambiguous row -> preview becomes stale.
    await openEdit(ROW_BUTTER);
    const none = await screen.findByRole('radio', { name: /None of these/i });
    fireEvent.click(none);
    await waitFor(() => expect(screen.getByText(/Stale — recalculate/i)).toBeTruthy());
  });
});

describe('phase 4.5C — US customary portions and explicit total weight', () => {
  it('presents compatible canonical portions immediately with a semantic label', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await openEdit(ROW_VOLUME_FLOUR);

    // No second action is required to reveal the portions.
    const portionRadios = (await screen.findAllByRole('radio')).filter((radio) =>
      /=\s*\d+(\.\d+)?\s*g/.test(radio.closest('label')?.textContent ?? '')
    );
    expect(portionRadios.length).toBeGreaterThan(0);
    // Nothing is auto-selected.
    expect(portionRadios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    // The SR Legacy `undetermined` placeholder is never shown.
    expect(screen.queryByText(/undetermined/i)).toBeNull();
  });

  it('offers an explicit total-weight fallback that produces user_mass evidence', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await openEdit(ROW_VOLUME_FLOUR);

    const weightInput = await screen.findByLabelText('Total weight for this ingredient line');
    fireEvent.change(weightInput, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Use this weight/i }));
    fireEvent.click(screen.getByRole('button', { name: /Calculate Preview/i }));
    await screen.findByText('Advisory nutrition preview');

    expect(screen.getAllByText(/user-entered total weight/i).length).toBeGreaterThan(0);
    // A user-entered weight is never labelled as a USDA portion.
    expect(screen.queryByText(/user-entered total weight · FDC/i)).toBeNull();
  });

  it('shows no Apply/Save control for the fallback and keeps advisory copy', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    const labels = Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent ?? '');
    for (const label of labels) expect(label).not.toMatch(/\bApply\b|\bSave\b|\bPersist\b|\bWrite to Vault\b/i);
  });
});
