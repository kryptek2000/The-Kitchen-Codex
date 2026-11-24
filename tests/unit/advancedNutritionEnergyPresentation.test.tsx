// @vitest-environment jsdom
/**
 * AN-LIVE-R1 — partial energy must never look like complete recipe calories.
 *
 * Reproduces the owner's observed contradiction: a preview can contain a known
 * energy number while ingredient lines are still unresolved. That number is a
 * SUBTOTAL and must be labeled as such in both the preview and the compact
 * unsaved-review summary.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { deriveDisplayNutrients, deriveEnergyDisplay } from '../../src/core/nutritionV2/phase4/display';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { AdvisoryNutritionPreview, NutrientTotalResult } from '../../src/core/nutritionV2/calculation/types';
import type { NutrientId } from '../../src/core/nutritionV2/nutrients';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

function previewWith(
  totals: Partial<Record<NutrientId, NutrientTotalResult>>,
  status: 'complete' | 'partial' | 'unresolved',
  unresolvedCount: number
): AdvisoryNutritionPreview {
  return Object.freeze({
    calculation_schema: 1,
    calculation_version: 'usda_advisory_calc_v1',
    bundle_release: 'bundle',
    catalog_digest: 'c'.repeat(64),
    nutrient_map_version: 'usda_fdc_nutrient_map_v3',
    servings: 4,
    ingredient_digest: 'sha256:' + 'a'.repeat(64),
    nutrient_scope: Object.freeze(['calories'] as NutrientId[]),
    basis: 'total',
    status,
    totals: Object.freeze(totals),
    ingredients: Object.freeze([]),
    unresolved: Object.freeze(
      Array.from({ length: unresolvedCount }, (_value, index) =>
        Object.freeze({ line_ref: `line-${index}`, outcome: 'no_match' as const })
      )
    ),
    advisory_only: true,
    application_authorized: false,
  });
}

const CALORIES_375 = Object.freeze({
  amount: 375.09,
  unit: 'kcal' as const,
  coverage: 1 / 8,
  covered_ingredient_count: 1,
  measurable_ingredient_count: 8,
  status: 'partial' as const,
});

describe('energy coverage presentation', () => {
  it('labels known energy as a subtotal when the recipe is partial (owner contradiction)', () => {
    const preview = previewWith({ calories: CALORIES_375 }, 'partial', 7);
    const calories = deriveDisplayNutrients(preview, 'entire_recipe', 4, 4).find(
      (entry) => entry.nutrient === 'calories'
    );
    const energy = deriveEnergyDisplay(calories, preview);
    expect(energy.kind).toBe('partial_subtotal');
    expect(energy.label).toBe('Energy subtotal');
    expect(energy.amount).toBe(375.09);
    expect(energy.is_complete_recipe_calories).toBe(false);
    expect(energy.unresolved_count).toBe(7);
    expect(energy.note).toMatch(/7 ingredient lines unresolved/i);
    expect(energy.note).toMatch(/not a complete recipe calorie total/i);
  });

  it('only calls fully resolved energy a complete recipe calorie total', () => {
    const completeTotal = Object.freeze({
      ...CALORIES_375,
      coverage: 1,
      covered_ingredient_count: 8,
      measurable_ingredient_count: 8,
      status: 'complete' as const,
    });
    const preview = previewWith({ calories: completeTotal }, 'complete', 0);
    const calories = deriveDisplayNutrients(preview, 'entire_recipe', 4, 4).find(
      (entry) => entry.nutrient === 'calories'
    );
    const energy = deriveEnergyDisplay(calories, preview);
    expect(energy.kind).toBe('complete');
    expect(energy.label).toBe('Calories');
    expect(energy.is_complete_recipe_calories).toBe(true);
  });

  it('shows unavailable rather than a fabricated calorie total when energy is missing', () => {
    const preview = previewWith({}, 'partial', 7);
    const calories = deriveDisplayNutrients(preview, 'entire_recipe', 4, 4).find(
      (entry) => entry.nutrient === 'calories'
    );
    const energy = deriveEnergyDisplay(calories, preview);
    expect(energy.kind).toBe('unavailable');
    expect(energy.label).toBe('Calories unavailable');
    expect(energy.amount).toBeUndefined();
    expect(energy.is_complete_recipe_calories).toBe(false);
  });
});

const SPECS = [
  {
    fdcId: 9701,
    dataType: 'foundation' as const,
    description: 'Nutrition, test food',
    caloriesAmount: 375.09,
    proteinAmount: 10,
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

function recipe(lines: ReadonlyArray<string>): ObsidianRecipe {
  const ingredients = lines.map((line) => structured(line));
  return {
    id: 'partial-energy-recipe',
    fileName: 'partial-energy-recipe.md',
    filePath: 'Recipes/partial-energy-recipe.md',
    rawMarkdown: '',
    title: 'Partial Energy Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: ingredients as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

describe('unsaved review compact energy summary', () => {
  it('does not present a partial 375.09 kcal value as complete recipe calories', async () => {
    render(
      <AdvancedNutritionCard
        recipe={recipe([
          '100 g Nutrition test food',
          '1 cup gochujang',
          '1 cup broccoli',
          '1 cup snap peas',
          '1 cup mushrooms',
          '1 tbsp soy sauce',
          '1 tsp sesame oil',
          '1 tsp sugar',
        ])}
        session={session}
      />
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));

    const energy = await screen.findByTestId('advanced-nutrition-unsaved-energy');
    await waitFor(() => expect(energy.textContent).toContain('Energy subtotal'));
    expect(energy.textContent).toContain('375.09');
    expect(energy.textContent).not.toMatch(/^Calories:/);
    expect(screen.getByTestId('advanced-nutrition-unsaved-energy-note').textContent).toMatch(
      /not a complete recipe calorie total/i
    );

    // The modal preview uses the SAME rule, so the number can never read as a
    // complete whole-recipe calorie total while seven lines are unresolved.
    const status = await screen.findByTestId('advanced-nutrition-energy-status');
    expect(status.getAttribute('data-energy-kind')).toBe('partial_subtotal');
    expect(status.textContent).toContain('Energy subtotal');
    expect(status.textContent).toContain('375.09');
    expect(status.textContent).toMatch(/7 ingredient lines unresolved/i);
    expect(status.textContent).toMatch(/not a complete recipe calorie total/i);
  });
});
