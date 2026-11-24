// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RecipeNutritionSection } from '../../src/components/RecipeNutritionSection';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV5 } from '../../src/core/nutritionV2/schema';
import { resolveRecipeNutritionPresentation } from '../../src/core/nutritionV2/phase5c';
import { readStoredBlock } from '../../src/core/nutritionV2/phase4/stored';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import type { ObsidianRecipe } from '../../src/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

const network = { request: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as NetworkAdapter;
const tempDirs: string[] = [];
afterEach(() => {
  cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function savedCochinita(): { markdown: string; recipe: ObsidianRecipe; block: CodexNutritionV5 } {
  const authored = readFileSync(join(process.cwd(), 'tests/fixtures/nutritionRepairCochinitaPibil.md'), 'utf8');
  const base = parseObsidianRecipeMarkdown(authored, 'Cochinita Pibil.md', 'Recipes/Cochinita Pibil.md');
  const adapted = adaptRecipe(base);
  if (!adapted.ok) throw new Error('fixture recipe could not be adapted');
  const lines = adapted.recipe.adapted;
  const wrapper = lines.find((line) => /banana leaves/i.test(line.ingredient.original));
  if (!wrapper) throw new Error('fixture wrapper line missing');
  const sourceLines = lines.filter((line) => line !== wrapper).slice(0, 4);
  const sourceRefs = new Set(sourceLines.map((line) => line.line_ref));
  const estimatedLines = lines.filter((line) => line !== wrapper && !sourceRefs.has(line.line_ref));
  const contributions = [
    ...estimatedLines.map((line, index) => ({
      line_ref: line.line_ref,
      ingredient: line.ingredient.original,
      quantity_basis: 'recipe measure interpreted for this whole ingredient line',
      weight_grams: 100 + index * 10,
      disposition: 'edible' as const,
      exclusion_role: 'none' as const,
      exclusion_assumption: '',
      classification: 'ai_estimate' as const,
      nutrients: { calories: { amount: 40 + index, unit: 'kcal' as const }, protein: { amount: 1 + index / 10, unit: 'g' as const }, carbohydrates: { amount: 5 + index, unit: 'g' as const }, fat: { amount: 1 + index / 10, unit: 'g' as const } },
      unknown_nutrients: ['fiber', 'sodium'] as const,
      assumptions: ['Recipe-bound estimate used typical ingredient composition.'],
      confidence: 'medium' as const,
      sources: [],
    })),
    {
      line_ref: wrapper.line_ref,
      ingredient: wrapper.ingredient.original,
      quantity_basis: 'zero edible weight; used only to wrap the food during roasting',
      weight_grams: 0,
      disposition: 'excluded' as const,
      exclusion_role: 'cooking_wrapper' as const,
      exclusion_assumption: 'Not eaten; removed and discarded after cooking as a wrapper only.',
      classification: 'ai_estimate' as const,
      nutrients: { calories: { amount: 0, unit: 'kcal' as const }, protein: { amount: 0, unit: 'g' as const }, carbohydrates: { amount: 0, unit: 'g' as const }, fat: { amount: 0, unit: 'g' as const } },
      unknown_nutrients: [],
      assumptions: ['Wrapper is not consumed.'],
      confidence: 'high' as const,
      sources: [],
    },
  ];
  const block: CodexNutritionV5 = {
    schema: 5,
    basis: 'total',
    servings: adapted.recipe.base_servings,
    status: 'partial',
    computed_at: '2026-10-17T12:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc', 'ai_estimate'],
    source_releases: { usda_fdc: 'test-bundle' },
    nutrient_scope: ['calories', 'protein', 'carbohydrates', 'fat', 'fiber', 'sodium'],
    nutrients: {
      calories: { amount: 5702.95, unit: 'kcal', status: 'partial', coverage: 10 / 11, covered_ingredient_count: 10, measurable_ingredient_count: 11 },
      protein: { amount: 361.0104, unit: 'g', status: 'partial', coverage: 10 / 11, covered_ingredient_count: 10, measurable_ingredient_count: 11 },
      carbohydrates: { amount: 230.3224, unit: 'g', status: 'partial', coverage: 10 / 11, covered_ingredient_count: 10, measurable_ingredient_count: 11 },
      fat: { amount: 340.56104, unit: 'g', status: 'partial', coverage: 10 / 11, covered_ingredient_count: 10, measurable_ingredient_count: 11 },
    },
    ingredients: sourceLines.map((line, index) => ({
      line_ref: line.line_ref,
      source: 'usda_fdc' as const,
      source_food_id: String(1000 + index),
      source_release: 'test-bundle',
      match_status: 'confirmed' as const,
      resolved: true,
      user_confirmed: true,
      amount: { value: index === 0 ? 1814.36948 : 100 + index, unit: 'g' as const },
    })),
    unresolved: [],
    ai_contributions: contributions,
  };
  const withSavedNutrition = { ...base, codexNutrition: block } as ObsidianRecipe;
  const markdown = serializeRecipeToObsidianMarkdown(withSavedNutrition);
  const dir = mkdtempSync(join(tmpdir(), 'kitchen-nutrition-reopen-'));
  tempDirs.push(dir);
  const path = join(dir, 'Cochinita Pibil.md');
  writeFileSync(path, markdown, 'utf8');
  const reopenedMarkdown = readFileSync(path, 'utf8');
  const reopened = parseObsidianRecipeMarkdown(reopenedMarkdown, 'Cochinita Pibil.md', 'Recipes/Cochinita Pibil.md');
  return { markdown: reopenedMarkdown, recipe: reopened, block };
}

function visibleRecipe(recipe: ObsidianRecipe, onApply = vi.fn()) {
  return render(
    <RecipeNutritionSection
      recipe={recipe}
      presentation={resolveRecipeNutritionPresentation(recipe)}
      servings={recipe.servings}
      network={network}
      onUpdateNutrition={vi.fn()}
      onApplyAdvancedNutrition={onApply as never}
      advancedNutritionBundleStatus="idle"
      onLoadAdvancedNutritionBundle={vi.fn()}
    />
  );
}

describe('saved Advanced Nutrition UI state reconciliation', () => {
  it('loads a 12-line Cochinita schema-v5 report into the main card before opening the report and keeps it unchanged on close/reload', () => {
    const saved = savedCochinita();
    const first = resolveRecipeNutritionPresentation(saved.recipe);
    expect(first.kind).toBe('advanced_saved');
    expect(first.stale_reasons).toEqual([]);
    expect(first.advanced_resolved_count).toBe(11);
    expect(first.advanced_excluded_count).toBe(1);
    expect(first.advanced_unresolved_count).toBe(0);
    expect(first.advanced_ingredient_count).toBe(12);
    expect(readStoredBlock(saved.recipe)).toMatchObject({ resolvedCount: 11, unresolvedCount: 0, excludedCount: 1, ingredientCount: 12 });

    const onApply = vi.fn();
    const view = visibleRecipe(saved.recipe, onApply);
    const mainBefore = document.getElementById('recipe-nutrition-card')!.textContent!;
    expect(mainBefore).toContain('5703');
    expect(mainBefore).toContain('361g');
    expect(mainBefore).toContain('230.3g');
    expect(mainBefore).toContain('340.6g');
    expect(mainBefore).toContain('subtotal');
    expect(mainBefore).toContain('includes AI estimates');
    expect(mainBefore).toContain('12 of 12 ingredient lines accounted for');
    expect(mainBefore).toContain('1 wrapper excluded');

    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    expect(screen.getByTestId('saved-advanced-status').textContent).toContain('12 of 12 ingredient lines accounted for');
    expect(screen.getAllByTestId('saved-line-source-backed')).toHaveLength(4);
    expect(screen.getAllByTestId('saved-line-ai_estimate')).toHaveLength(7);
    expect(screen.getAllByTestId('saved-line-excluded')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close saved Advanced Nutrition report' }));
    expect(document.getElementById('recipe-nutrition-card')!.textContent).toBe(mainBefore);
    expect(onApply).not.toHaveBeenCalled();

    view.unmount();
    visibleRecipe(parseObsidianRecipeMarkdown(saved.markdown, 'Cochinita Pibil.md', 'Recipes/Cochinita Pibil.md'));
    expect(document.getElementById('recipe-nutrition-card')!.textContent).toContain('5703');
  });

  it('keeps a real ingredient edit stale and withholds the old values', () => {
    const saved = savedCochinita();
    const changed = { ...saved.recipe, ingredients: [...saved.recipe.ingredients] } as ObsidianRecipe;
    changed.ingredients[0] = { ...changed.ingredients[0], original: '5 lb pork shoulder, cut into large pieces' } as never;
    const presentation = resolveRecipeNutritionPresentation(changed);
    expect(presentation.kind).toBe('advanced_stale');
    expect(presentation.stale_reasons).toContain('ingredients_changed');
    const view = visibleRecipe(changed);
    const main = document.getElementById('recipe-nutrition-card')!.textContent!;
    expect(main).toContain('Saved evidence does not match the current recipe');
    expect(main).not.toContain('5702.95');
  });
});
