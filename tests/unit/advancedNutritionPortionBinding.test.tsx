// @vitest-environment jsdom
/**
 * Advanced Nutrition — authenticated source-portion binding.
 *
 * Proves a user-selected authenticated USDA source portion becomes authoritative
 * LIVE calculation mass through the complete modal -> Phase 4 state -> Phase 3
 * calculate path, and that forged / wrong-food / untrusted portion metadata
 * fails closed.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildReviewRows, buildCalculationRequest } from '../../src/core/nutritionV2/phase4/rows';
import { buildPortionChoice } from '../../src/core/nutritionV2/phase4/portion';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';

const SPECS = [
  { fdcId: 168039, dataType: 'foundation' as const, description: 'Cornmeal, yellow (Navajo)' },
  {
    fdcId: 169697,
    dataType: 'sr_legacy' as const,
    description: 'Cornmeal, whole-grain, yellow',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 122 }],
  },
  {
    fdcId: 168867,
    dataType: 'sr_legacy' as const,
    description: 'Cornmeal, degermed, enriched, yellow',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 157 }],
  },
  {
    fdcId: 1002,
    dataType: 'sr_legacy' as const,
    description: 'Butter, stick, unsalted',
    portions: [
      { amount: 1, measure: 'cup', gram_weight: 224 },
      { amount: 1, measure: 'tbsp', gram_weight: 14 },
    ],
  },
  {
    fdcId: 1003,
    dataType: 'sr_legacy' as const,
    description: 'Buttermilk',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 244 }],
  },
  {
    fdcId: 1004,
    dataType: 'sr_legacy' as const,
    description: 'Honey',
    portions: [
      { amount: 1, measure: 'cup', gram_weight: 339 },
      { amount: 1, measure: 'tbsp', gram_weight: 21 },
    ],
  },
  {
    fdcId: 3003,
    dataType: 'sr_legacy' as const,
    description: 'Salt, table',
    portions: [{ amount: 1, measure: 'tsp', gram_weight: 6 }],
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
    id: 'portion-r1',
    fileName: 'portion-r1.md',
    filePath: 'Recipes/portion-r1.md',
    rawMarkdown: '',
    title: 'Portion Recipe',
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
  fireEvent.click(screen.getByRole('button', { name: /Open Advanced Nutrition/i }));
  fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
}

function openRow(textMatch: RegExp) {
  const rows = screen.getAllByTestId('advanced-nutrition-row');
  const row = rows.find((node) => textMatch.test(node.textContent ?? ''));
  if (!row) throw new Error('row not found');
  const edit = row.querySelector('[data-testid="advanced-nutrition-edit"]') as HTMLButtonElement;
  fireEvent.click(edit);
  return row;
}

function previewText(): string {
  return document.querySelector('[aria-label="Advisory nutrition preview"]')?.textContent ?? '';
}

function selectFood(row: Element, fdc: string) {
  // When a food is already selected the candidate list is collapsed behind the
  // explicit `Change food` control; expand it before choosing a different food.
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

function calculate() {
  fireEvent.click(screen.getByRole('button', { name: /Calculate Preview|Recalculate Preview/i }));
}

describe('authenticated source-portion binding — UI integration', () => {
  it('R3. 1 cup Cornmeal + FDC 169697 + 1 cup = 122 g resolves 122 g', () => {
    openAndAnalyze(recipe(['1 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    selectFood(row, '169697');
    selectPortion('1 cup = 122 g');
    calculate();
    expect(previewText()).toMatch(/122 g/);
    expect(previewText()).toMatch(/FDC 169697/);
    expect(previewText()).toMatch(/authenticated USDA portion|USDA source portion/i);
  });

  it('R4. 1.5 cup Cornmeal + 1 cup = 122 g resolves 183 g', () => {
    openAndAnalyze(recipe(['1.5 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    selectFood(row, '169697');
    // The row shows the derived total for the recipe amount immediately.
    expect(row.textContent ?? '').toMatch(/183 g for 1\.5 cup/);
    selectPortion('1 cup = 122 g');
    calculate();
    expect(previewText()).toMatch(/183 g/);
    expect(previewText()).toMatch(/FDC 169697/);
  });

  it('R5. 0.5 cup unsalted butter + 1 cup = 224 g resolves 112 g', () => {
    openAndAnalyze(recipe(['0.5 cup unsalted butter']));
    const row = openRow(/butter/i);
    selectFood(row, '1002');
    selectPortion('1 cup = 224 g');
    calculate();
    expect(previewText()).toMatch(/112 g/);
    expect(previewText()).toMatch(/FDC 1002/);
  });

  it('R6. 1 tbsp Honey auto-binds the authenticated tablespoon portion (21 g)', () => {
    openAndAnalyze(recipe(['1 tbsp Honey']));
    expect(previewText()).toMatch(/21 g/);
  });

  it('R7. 0.5 tsp Salt, table auto-binds the authenticated teaspoon portion (3 g)', () => {
    openAndAnalyze(recipe(['0.5 tsp Salt, table']));
    expect(previewText()).toMatch(/3 g/);
  });

  it('R8. 1 cup Buttermilk auto-binds the authenticated cup portion (244 g)', () => {
    openAndAnalyze(recipe(['1 cup Buttermilk']));
    expect(previewText()).toMatch(/244 g/);
  });

  it('R9. changing the food clears a portion chosen for the old food', () => {
    openAndAnalyze(recipe(['1 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    selectFood(row, '169697');
    selectPortion('1 cup = 122 g');
    expect(document.body.textContent).toContain('Source portion selected');
    selectFood(row, '168867');
    expect(document.body.textContent).not.toContain('Source portion selected');
  });

  it('R10. changing the portion recalculates the deterministic grams', () => {
    openAndAnalyze(recipe(['1.5 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    selectFood(row, '168867');
    selectPortion('1 cup = 157 g');
    calculate();
    expect(previewText()).toMatch(/235\.5 g/);
    // Switch to a different authenticated portion.
    selectFood(row, '169697');
    selectPortion('1 cup = 122 g');
    calculate();
    expect(previewText()).toMatch(/183 g/);
  });

  it('R11. re-running analysis preserves an explicit user portion (reviewed decision)', () => {
    openAndAnalyze(recipe(['1 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    // Make an explicit user choice the analyzer would not have made.
    selectFood(row, '168867');
    selectPortion('1 cup = 157 g');
    expect(row.textContent ?? '').toMatch(/157 g/);
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    // Re-analysis fills gaps; it never discards an explicit reviewed portion for
    // an unchanged line. The one-click default (169697 · 122 g) does NOT replace
    // the user's reviewed choice.
    expect(row.textContent ?? '').toMatch(/157 g/);
    expect(row.textContent ?? '').not.toMatch(/122 g/);
  });

  it('R12. manual total weight remains an independent fallback (183 g)', () => {
    openAndAnalyze(recipe(['1.5 cup Cornmeal']));
    const row = openRow(/cornmeal/i);
    selectFood(row, '168039');
    const input = row.querySelector(
      'input[aria-label="Total weight for this ingredient line"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: '183' } });
    const useWeight = Array.from(row.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Use this weight')
    ) as HTMLButtonElement;
    fireEvent.click(useWeight);
    calculate();
    expect(previewText()).toMatch(/183 g/);
  });
});

describe('authenticated source-portion binding — authority / security', () => {
  function bind(line: string, fdcId: number, unit: string, portionIndexOverride?: number) {
    const adaptation = adaptRecipe(recipe([line]));
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const rows = buildReviewRows(session, adapted);
    const review = rows[0].review as { review_digest?: string };
    const portions = session.reviewPortions(fdcId);
    if (!portions.ok) throw new Error('portions failed');
    const portion = portions.review.candidates.find((p) => p.unit === unit);
    if (!portion) throw new Error('portion not found');
    const selection = { kind: 'candidate' as const, fdc_id: fdcId, review_digest: review.review_digest ?? '' };
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'sec',
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows,
      baseServings: 4,
    });
    state = phase4Reducer(state, { type: 'select_match', lineRef: adapted[0].line_ref, choice: selection });
    const choice = buildPortionChoice(session, {
      lineRef: adapted[0].line_ref,
      ingredient: adapted[0].ingredient,
      review: rows[0].review,
      selection,
      fdcId,
      portionIndex: portionIndexOverride ?? portion.index,
    });
    if (!choice.ok) return { choiceOk: false as const, adapted, selection, portion };
    state = phase4Reducer(state, { type: 'select_portion', lineRef: adapted[0].line_ref, choice: choice.choice });
    return { choiceOk: true as const, adapted, selection, portion, state, choice };
  }

  it('R13. forged portion metadata fails closed (tampered gram weight)', () => {
    const bound = bind('1.5 cup Cornmeal', 169697, 'cup');
    if (!bound.choiceOk) throw new Error('expected bound choice');
    const forgedSelection = {
      ...(bound.choice.choice.selection as Record<string, unknown>),
      semantics_gram_weight: 9999,
      gram_weight: 9999,
    };
    const calculated = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: bound.adapted[0].line_ref,
          ingredient: bound.adapted[0].ingredient,
          selection: bound.selection,
          portion_selection: forgedSelection,
        },
      ],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    // The calculator recomputes from the canonical record; a forged gram weight
    // is rejected and no fabricated mass is produced.
    expect(calculated.preview.ingredients[0].resolved_grams).toBeUndefined();
    expect(calculated.preview.ingredients[0].mass_source).not.toBe('source_portion');
  });

  it('R14. a portion from the wrong FDC cannot bind', () => {
    // FDC 169697 has one cup portion; pretend its index belongs to 168867.
    const bound = bind('1.5 cup Cornmeal', 168867, 'cup');
    if (!bound.choiceOk) throw new Error('expected bound choice');
    const calculated = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: bound.adapted[0].line_ref,
          ingredient: bound.adapted[0].ingredient,
          selection: bound.selection,
          // The selection declares FDC 169697 while the portion metadata came
          // from 168867: the record digest cannot match.
          portion_selection: {
            ...(bound.choice.choice.selection as Record<string, unknown>),
            fdc_id: 169697,
          },
        },
      ],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].resolved_grams).toBeUndefined();
  });

  it('R15. untrusted / non-USDA portion metadata cannot bind', () => {
    const adaptation = adaptRecipe(recipe(['1 cup Cornmeal']));
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const rows = buildReviewRows(session, adapted);
    const review = rows[0].review as { review_digest?: string };
    const calculated = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: adapted[0].line_ref,
          ingredient: adapted[0].ingredient,
          selection: { kind: 'candidate', fdc_id: 169697, review_digest: review.review_digest ?? '' },
          // A hand-rolled, unauthenticated portion object.
          portion_selection: {
            calculation_version: 'x',
            portion_semantics_version: 'x',
            line_ref: adapted[0].line_ref,
            ingredient_identity_digest: 'sha256:' + '0'.repeat(64),
            bundle_release: 'fake',
            fdc_id: 169697,
            record_digest: 'sha256:' + '0'.repeat(64),
            candidates_digest: 'sha256:' + '0'.repeat(64),
            portion_index: 0,
            portion_amount: 1,
            measure: 'cup',
            gram_weight: 122,
            semantics_kind: 'volume',
            semantics_unit: 'cup',
            semantics_volume_ml: 236.588,
            semantics_amount: 1,
            semantics_gram_weight: 122,
          },
        },
      ],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].resolved_grams).toBeUndefined();
  });
});
