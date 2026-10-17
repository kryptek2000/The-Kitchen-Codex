// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RecipeNutritionCard } from '../../src/components/RecipeNutritionCard';
import { parseObsidianRecipeMarkdown } from '../../src/utils/markdownParser';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
const totals = { calories: 1182, protein: 30.5, carbohydrates: 150, fat: 40, fiber: null, sodium: 0 };
vi.mock('../../src/browser/basicNutrition', () => ({ calculateProductionBasicNutrition: async ({ servings }: { servings: number }) => ({
  ok: true, message: null, source: 'offline_heuristic', confidence: 'low', confidenceNote: 'PARTIAL test subtotal', baseServings: servings,
  totals: { calories: null, protein: null, carbohydrates: null, fat: null, fiber: null, sodium: null },
  knownSubtotal: { calories: 1182, protein: 30.5, carbohydrates: 150, fat: 40, fiber: null, sodium: 0 },
  perServing: {}, coverage: { total: 12, resolved: 8, unresolved: 4, qualitative: 0, complete: false }, assumptions: [], lines: [],
}) }));
afterEach(cleanup);
const recipe = (servings: number) => parseObsidianRecipeMarkdown(`---\ntitle: Cochinita\nservings: ${servings}\n---\n# Cochinita\n## Ingredients\n- 4 lb pork shoulder\n## Instructions\n1. Cook.`, 'cochinita.md', 'Recipes/cochinita.md');
describe('Basic subtotal serving labels', () => {
  it.each([[8, 148, '3.8'], [6, 197, '5.1'], [3, 394, '10.2']])('divides an unchanged batch at %s servings before rounding', async (servings, calories, protein) => {
    const save = vi.fn();
    render(<RecipeNutritionCard recipe={recipe(Number(servings))} onUpdateNutrition={save} network={{} as NetworkAdapter} />);
    fireEvent.click(screen.getAllByText('Calculate Basic Nutrition')[0]);
    const review = await screen.findByTestId('basic-nutrition-review');
    expect(review.textContent).toContain(`Per serving at ${servings} servings · partial subtotal: ${calories} kcal · ${protein} g protein`);
    expect(review.textContent).toContain('1182');
    expect(review.textContent).toContain('8/12 ingredient lines covered');
    expect(save).not.toHaveBeenCalled();
  });
  it('labels gram percentages as grams, not energy share', () => {
    const r = recipe(4); r.nutrition = { ...totals, fiber: undefined, servings: 4, protein: 10.7, carbohydrates: 51.6, fat: 66.8 };
    render(<RecipeNutritionCard recipe={r} onUpdateNutrition={() => {}} network={{} as NetworkAdapter} />);
    expect(screen.getByText('Macro percentages compare grams, not calories.')).toBeTruthy();
    expect(screen.getByText('8% of macro grams')).toBeTruthy();
  });
});
