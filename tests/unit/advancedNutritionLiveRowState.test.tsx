// @vitest-environment jsdom
/**
 * Advanced Nutrition — central LIVE row-state projection.
 *
 * Proves the collapsed row status/amount derive from CURRENT authoritative
 * session state (food confirmation + authenticated portion + manual total weight)
 * and never from a stale analyzer snapshot. Also proves the staple/prepared
 * product matching repair: a survey dish built from a staple (`Cornmeal stick`,
 * `Cornmeal mush`) never outranks plain staple records, while an explicit
 * `cornmeal stick` / `cornmeal mush` request still resolves.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';

const SPECS = [
  // Survey (FNDDS) prepared dishes built from the staple — must NOT auto-win.
  {
    fdcId: 5001,
    dataType: 'fndds' as const,
    description: 'Cornmeal stick, Puerto Rican style',
    portions: [{ amount: 1, measure: 'stick', gram_weight: 20 }],
  },
  {
    fdcId: 5002,
    dataType: 'fndds' as const,
    description: 'Cornmeal mush, fat added',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 240 }],
  },
  // Plain staple records — the sensible identities.
  {
    fdcId: 5003,
    dataType: 'sr_legacy' as const,
    description: 'Cornmeal, whole-grain, yellow',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 122 }],
  },
  { fdcId: 5004, dataType: 'sr_legacy' as const, description: 'Cornmeal, yellow (Navajo)' },
  {
    fdcId: 5010,
    dataType: 'fndds' as const,
    description: 'Peppers, jalapenos',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 150 }],
  },
  { fdcId: 5011, dataType: 'sr_legacy' as const, description: 'Chicken, breast, boneless, skinless, raw' },
  { fdcId: 5016, dataType: 'sr_legacy' as const, description: 'Chicken, breast, boneless, skinless, cooked' },
  {
    fdcId: 5012,
    dataType: 'sr_legacy' as const,
    description: 'Celery, raw',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 101 }],
  },
  {
    fdcId: 5013,
    dataType: 'fndds' as const,
    description: 'Onions, green, raw',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 100 }],
  },
  {
    fdcId: 5014,
    dataType: 'sr_legacy' as const,
    description: 'Pork, cured, bacon, unprepared',
    portions: [{ amount: 1, measure: 'slice', gram_weight: 8.1 }],
  },
  {
    fdcId: 5015,
    dataType: 'sr_legacy' as const,
    description: 'Cheese, cheddar',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 105 }],
  },
  // A materially ambiguous same-family pair (whole vs skim) stays review.
  {
    fdcId: 5020,
    dataType: 'foundation' as const,
    description: 'Milk, whole',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 244 }],
  },
  {
    fdcId: 5021,
    dataType: 'foundation' as const,
    description: 'Milk, skim',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 245 }],
  },
  // A genuinely material-variant-only family stays review (dried/frozen).
  {
    fdcId: 5030,
    dataType: 'sr_legacy' as const,
    description: 'Berries, dried',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 100 }],
  },
  {
    fdcId: 5031,
    dataType: 'sr_legacy' as const,
    description: 'Berries, frozen',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 120 }],
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

function recipe(lines: ReadonlyArray<string>, overrides: Record<string, unknown> = {}): ObsidianRecipe {
  const ingredients = lines.map((line) => {
    const match = line.match(/^([\d.]+)\s+(\S+)\s+(.*)$/);
    const amount = match ? Number(match[1]) : undefined;
    const unit = match ? match[2] : undefined;
    const name = match ? match[3] : line;
    return { original: line, ...(amount !== undefined ? { amount } : {}), ...(unit ? { unit } : {}), name };
  });
  return {
    id: 'live-r1',
    fileName: 'live-r1.md',
    filePath: 'Recipes/live-r1.md',
    rawMarkdown: '',
    title: 'Live Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: ingredients as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...overrides,
  } as unknown as ObsidianRecipe;
}

function openAndAnalyze(r: ObsidianRecipe) {
  render(<AdvancedNutritionCard recipe={r} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i }));
  fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
}

function findRow(textMatch: RegExp): HTMLElement {
  const rows = screen.getAllByTestId('advanced-nutrition-row');
  const row = rows.find((node) => textMatch.test(node.textContent ?? ''));
  if (!row) throw new Error('row not found');
  return row;
}

function openRow(textMatch: RegExp): HTMLElement {
  const row = findRow(textMatch);
  const edit = row.querySelector('[data-testid="advanced-nutrition-edit"]') as HTMLButtonElement;
  fireEvent.click(edit);
  return row;
}

function statusText(row: Element): string {
  return (row.querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim();
}

function selectFood(row: Element, fdc: string) {
  const change = row.querySelector(
    '[data-testid="advanced-nutrition-change-food"]'
  ) as HTMLButtonElement | null;
  if (change && (change.textContent ?? '').includes('Change food')) fireEvent.click(change);
  const radio = Array.from(row.querySelectorAll('input[type="radio"]')).find((r) =>
    (r.closest('label')?.textContent ?? '').includes(fdc)
  ) as HTMLInputElement | undefined;
  if (!radio) throw new Error(`food radio ${fdc} not found`);
  fireEvent.click(radio);
}

function selectPortion(label: string) {
  const portionLabel = Array.from(document.querySelectorAll('label')).find(
    (l) => (l.textContent ?? '').trim() === label
  );
  if (!portionLabel) throw new Error(`portion ${label} not found`);
  fireEvent.click(portionLabel.querySelector('input[type="radio"]') as HTMLInputElement);
}

function enterManualWeight(row: Element, qty: string, unit: 'g' | 'oz' | 'lb' = 'g') {
  const input = row.querySelector(
    'input[aria-label="Total weight for this ingredient line"]'
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: qty } });
  const select = row.querySelector('select[aria-label="Weight unit"]') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: unit } });
  const useWeight = Array.from(row.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('Use this weight')
  ) as HTMLButtonElement;
  fireEvent.click(useWeight);
}

function calculate() {
  fireEvent.click(screen.getByRole('button', { name: /Calculate Preview|Recalculate Preview/i }));
}

function previewText(): string {
  return document.querySelector('[aria-label="Advisory nutrition preview"]')?.textContent ?? '';
}

// ---------------------------------------------------------------------------
// Live row-status transitions
// ---------------------------------------------------------------------------

describe('live row state — status transitions', () => {
  it('review suggested -> confirm food -> needs amount', () => {
    // A material-variant-only family (dried/frozen berries) stays review.
    openAndAnalyze(recipe(['1 cup berries']));
    const row = openRow(/berries/i);
    expect(statusText(row)).toBe('Review suggested');
    // The food-choice review is primary: candidates are visible without a click.
    selectFood(row, '5030');
    expect(statusText(row)).toBe('Needs amount');
    expect(document.body.textContent).not.toContain('Review suggested');
  });

  it('needs amount -> select authenticated portion -> matched (grams visible)', () => {
    openAndAnalyze(recipe(['1 cup berries']));
    const row = openRow(/berries/i);
    selectFood(row, '5030');
    expect(statusText(row)).toBe('Needs amount');
    selectPortion('1 cup = 100 g');
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/100 g/);
    calculate();
    expect(previewText()).toMatch(/100 g/);
    expect(previewText()).toMatch(/FDC 5030/);
  });

  it('needs amount -> manual total weight -> matched', () => {
    openAndAnalyze(recipe(['1 large chicken breast']));
    const row = openRow(/chicken breast/i);
    expect(statusText(row)).toBe('Needs amount');
    enterManualWeight(row, '150', 'g');
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/150 g/);
    calculate();
    expect(previewText()).toMatch(/user-entered total weight|user_mass/i);
    expect(previewText()).toMatch(/150 g/);
  });

  it('changing the food invalidates the previous amount', () => {
    openAndAnalyze(recipe(['1 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    selectFood(row, '5003');
    selectPortion('1 cup = 122 g');
    expect(statusText(row)).toBe('Matched');
    selectFood(row, '5004');
    expect(statusText(row)).toBe('Needs amount');
    expect(document.body.textContent).not.toContain('Source portion selected');
  });

  it('closing and reopening the editor preserves the resolved state', () => {
    openAndAnalyze(recipe(['1 cup Cornmeal']));
    let row = openRow(/cornmeal/i);
    selectFood(row, '5003');
    selectPortion('1 cup = 122 g');
    expect(statusText(row)).toBe('Matched');
    // Collapse, then reopen.
    fireEvent.click(row.querySelector('[data-testid="advanced-nutrition-edit"]') as HTMLButtonElement);
    row = openRow(/cornmeal/i);
    expect(statusText(row)).toBe('Matched');
    expect(document.body.textContent).toContain('Source portion selected');
  });

  it('a display-basis change does not revert the row status', () => {
    openAndAnalyze(recipe(['1 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    selectFood(row, '5003');
    selectPortion('1 cup = 122 g');
    fireEvent.click(screen.getByRole('radio', { name: /Per serving/i }));
    expect(statusText(row)).toBe('Matched');
  });

  it('Calculate Preview does not revert the row status', () => {
    openAndAnalyze(recipe(['1 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    selectFood(row, '5003');
    selectPortion('1 cup = 122 g');
    calculate();
    expect(statusText(row)).toBe('Matched');
  });

  it('re-analysis preserves an explicit live review override (never reverts reviewed work)', () => {
    openAndAnalyze(recipe(['1 cup berries']));
    const row = openRow(/berries/i);
    selectFood(row, '5030');
    selectPortion('1 cup = 100 g');
    expect(statusText(row)).toBe('Matched');
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    // The explicit user decision survives Re-analyze: re-analysis fills gaps, it
    // never discards a reviewed override for an unchanged line.
    expect(document.body.textContent).toContain('Source portion selected');
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/100 g/);
  });
});

// ---------------------------------------------------------------------------
// Manual total weight
// ---------------------------------------------------------------------------

describe('live row state — manual total weight', () => {
  it('oz converts deterministically', () => {
    openAndAnalyze(recipe(['1 large chicken breast']));
    const row = openRow(/chicken breast/i);
    enterManualWeight(row, '4', 'oz');
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/113\.4 g/);
  });

  it('lb converts deterministically', () => {
    openAndAnalyze(recipe(['1 large chicken breast']));
    const row = openRow(/chicken breast/i);
    enterManualWeight(row, '0.5', 'lb');
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/226\.8 g/);
  });

  it('Clear restores needs amount', () => {
    openAndAnalyze(recipe(['1 large chicken breast']));
    const row = openRow(/chicken breast/i);
    enterManualWeight(row, '150', 'g');
    expect(statusText(row)).toBe('Matched');
    const clear = Array.from(row.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').trim() === 'Clear'
    ) as HTMLButtonElement;
    fireEvent.click(clear);
    expect(statusText(row)).toBe('Needs amount');
  });

  it('changing the food invalidates a manual weight', () => {
    openAndAnalyze(recipe(['1 large chicken breast']));
    const row = openRow(/chicken breast/i);
    enterManualWeight(row, '150', 'g');
    expect(statusText(row)).toBe('Matched');
    selectFood(row, '5016');
    expect(statusText(row)).toBe('Needs amount');
  });
});

// ---------------------------------------------------------------------------
// Count + volume paths
// ---------------------------------------------------------------------------

describe('live row state — count and volume preservation', () => {
  it('count mass stays deterministic (5 slices bacon x 8.1 g = 40.5 g)', () => {
    openAndAnalyze(recipe(['5 slices bacon']));
    const row = findRow(/bacon/i);
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/40\.5 g/);
    calculate();
    expect(previewText()).toMatch(/40\.5 g/);
    expect(previewText()).toMatch(/count/i);
  });

  it('volume happy path stays matched (0.5 cup cheddar x 105 g/cup = 52.5 g)', () => {
    openAndAnalyze(recipe(['0.5 cup shredded cheddar cheese']));
    const row = findRow(/cheddar/i);
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/52\.5 g/);
  });

  it('jalapeno: one-click auto-selects a normal jalapeno and resolves 37.5 g', () => {
    // `chopped fresh jalapeno` no longer forces review: the one-click analyzer
    // picks the normal jalapeno record and its authenticated cup portion.
    openAndAnalyze(recipe(['0.25 cup chopped fresh jalapeno']));
    const row = findRow(/jalapeno/i);
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/37\.5 g/);
    calculate();
    expect(previewText()).toMatch(/37\.5 g/);
    expect(previewText()).toMatch(/FDC 5010/);
    expect(previewText()).toMatch(/USDA source portion/);
  });



  it('celery with no compatible count portion falls back to manual weight', () => {
    openAndAnalyze(recipe(['2 stalks celery']));
    const row = openRow(/celery/i);
    if (statusText(row) === 'Review suggested') selectFood(row, '5012');
    expect(statusText(row)).toBe('Needs amount');
    enterManualWeight(row, '60', 'g');
    expect(statusText(row)).toBe('Matched');
    expect(row.textContent ?? '').toMatch(/60 g/);
  });

  it('green onions with no compatible count portion fall back to manual weight', () => {
    openAndAnalyze(recipe(['2 stalks green onions']));
    const row = openRow(/green onion/i);
    if (statusText(row) === 'Review suggested') selectFood(row, '5013');
    expect(statusText(row)).toBe('Needs amount');
    enterManualWeight(row, '30', 'g');
    expect(statusText(row)).toBe('Matched');
  });
});

// ---------------------------------------------------------------------------
// Staple / prepared-product matching
// ---------------------------------------------------------------------------

function analyzedRow(line: string) {
  const adaptation = adaptRecipe({
    title: 't',
    servings: 4,
    ingredients: [{ original: line, name: line.replace(/^[\d./]+\s+\S+\s+/, '') }],
  });
  if (!adaptation.ok) throw new Error('adapt failed');
  return analyzeRecipe(session, adaptation.recipe.adapted, 4).rows[0];
}

function candidateDescriptions(query: string): string[] {
  const review = session.reviewIngredient({ name: query }) as {
    candidates?: ReadonlyArray<{ description: string }>;
  };
  return (review.candidates ?? []).map((candidate) => candidate.description);
}

describe('staple / prepared-product matching', () => {
  it('bare cornmeal never auto-selects a prepared cornmeal stick', () => {
    const row = analyzedRow('1 cup Cornmeal');
    expect(row.selected_description ?? '').not.toMatch(/stick/i);
    expect(row.selected_fdc_id).not.toBe(5001);
  });

  it('bare cornmeal never auto-selects cornmeal mush', () => {
    const row = analyzedRow('1 cup Cornmeal');
    expect(row.selected_description ?? '').not.toMatch(/mush/i);
    expect(row.selected_fdc_id).not.toBe(5002);
  });

  it('plain cornmeal candidates rank above prepared products', () => {
    const descriptions = candidateDescriptions('cornmeal');
    const plainIndex = descriptions.findIndex((d) => /whole-grain, yellow/i.test(d));
    const stickIndex = descriptions.findIndex((d) => /stick/i.test(d));
    const mushIndex = descriptions.findIndex((d) => /mush/i.test(d));
    expect(plainIndex).toBeGreaterThanOrEqual(0);
    expect(stickIndex === -1 || plainIndex < stickIndex).toBe(true);
    expect(mushIndex === -1 || plainIndex < mushIndex).toBe(true);
  });

  it('an explicit cornmeal stick request still resolves', () => {
    const row = analyzedRow('1 cup cornmeal stick');
    expect(row.selected_description ?? '').toMatch(/cornmeal stick/i);
  });

  it('an explicit cornmeal mush request still surfaces the mush record', () => {
    // `Cornmeal mush, fat added` carries an unrequested derived-component word
    // (`fat`), so it stays review-required — but it must be the TOP candidate
    // for an explicit `cornmeal mush` request, never demoted below plain cornmeal.
    const descriptions = candidateDescriptions('cornmeal mush');
    expect(descriptions[0] ?? '').toMatch(/cornmeal mush/i);
  });
});
