// @vitest-environment jsdom
/**
 * The Kitchen Codex — Advanced Nutrition Phase 5C: consolidated Nutrition UI.
 *
 * Proves the recipe-detail nutrition surface is ONE coherent section driven by
 * the pure precedence selector: a saved Advanced result is primary, legacy is the
 * fallback, stale/unknown/malformed saved blocks are surfaced without silently
 * substituting legacy values, and viewing never writes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RecipeNutritionSection } from '../../src/components/RecipeNutritionSection';
import { resolveRecipeNutritionPresentation } from '../../src/core/nutritionV2/phase5c';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import type { ObsidianRecipe } from '../../src/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipe(lines: ReadonlyArray<string>, overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
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
    ingredients: lines.map(structured) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...overrides,
  } as ObsidianRecipe;
}

function advancedBlock(target: ObsidianRecipe, overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  return {
    schema: 1,
    basis: 'total',
    servings: adaptation.recipe.base_servings,
    status: 'complete',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'r' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: { amount: 364, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
    },
    ingredients: adaptation.recipe.adapted.map((entry) => ({
      line_ref: entry.line_ref,
      source: 'usda_fdc' as const,
      source_food_id: '6001',
      source_release: 'r',
      match_status: 'confirmed' as const,
      resolved: true,
      user_confirmed: true,
    })),
    unresolved: [],
    ...overrides,
  };
}

/** A recognized but INCOMPLETE saved block (partial coverage / unresolved lines). */
function partialBlock(target: ObsidianRecipe): CodexNutritionV1 {
  const block = advancedBlock(target, {
    status: 'partial',
    nutrient_scope: ['calories', 'fat', 'sodium'],
    nutrients: {
      calories: { amount: 364, unit: 'kcal', status: 'partial', coverage: 0.5, covered_ingredient_count: 1, measurable_ingredient_count: 2 },
      fat: { amount: 91.3, unit: 'g', status: 'partial', coverage: 0.5, covered_ingredient_count: 1, measurable_ingredient_count: 2 },
      sodium: { amount: 11, unit: 'mg', status: 'partial', coverage: 0.5, covered_ingredient_count: 1, measurable_ingredient_count: 2 },
    },
  });
  return {
    ...block,
    ingredients: block.ingredients.slice(0, 1),
    unresolved: [{ line_ref: 'ing:1:unresolved', reason: 'no_match' }],
  };
}

const network = {
  request: vi.fn(async () => ({ status: 200, ok: true })),
  get: vi.fn(async () => ({ status: 200, ok: true })),
  post: vi.fn(async () => ({ status: 200, ok: true })),
} as unknown as NetworkAdapter;

const FLOUR = '100 g Flour, wheat, white';
const SUGAR = '50 g Sugar, granulated';

function renderSection(r: ObsidianRecipe, onApply = vi.fn()) {
  const presentation = resolveRecipeNutritionPresentation(r);
  const utils = render(
    <RecipeNutritionSection
      recipe={r}
      presentation={presentation}
      servings={4}
      network={network}
      onUpdateNutrition={vi.fn()}
      onApplyAdvancedNutrition={onApply as never}
      advancedNutritionBundleStatus="idle"
      onLoadAdvancedNutritionBundle={vi.fn()}
    />
  );
  return { ...utils, onApply };
}

afterEach(() => cleanup());

describe('phase 5C — consolidated Nutrition UI', () => {
  it('legacy-only recipe shows the legacy fallback and keeps the Advanced upgrade affordance', () => {
    renderSection(recipe([FLOUR], { nutrition: { calories: 320 } as never }));
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    // The Advanced review/apply affordance remains reachable, but it is not a
    // competing nutrition table (no saved result, no preview yet).
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
    expect(screen.getByText(/^Advanced Nutrition$/i)).toBeTruthy();
  });

  it('a saved Advanced result keeps the normal Nutrition & Macros card visible and separate', () => {
    const base = recipe([FLOUR]);
    renderSection(recipe([FLOUR], { codexNutrition: advancedBlock(base) as never, nutrition: { calories: 320 } as never }));
    // BOTH experiences remain: the ordinary compact card AND the separate
    // Advanced review card.
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
    // The normal card derives its compact values from the saved Advanced block
    // for the CURRENT recipe scale (base 4 / current 4 -> the base totals, 364),
    // never from the conflicting legacy value (320).
    const normal = document.getElementById('recipe-nutrition-card') as HTMLElement;
    expect(normal.textContent).toMatch(/364/);
    expect(normal.textContent).toMatch(/current recipe: 4 servings/i);
    expect(normal.textContent).not.toMatch(/320/);
    expect(normal.textContent).toMatch(/Advanced Nutrition · USDA reviewed/i);
  });

  it('shows the normal card and the separate Advanced card (no hidden nutrition)', () => {
    const base = recipe([FLOUR]);
    renderSection(recipe([FLOUR], { codexNutrition: advancedBlock(base) as never, nutrition: { calories: 320 } as never }));
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
  });

  it('surfaces a stale saved result while keeping the normal card derived from it', () => {
    const base = recipe([FLOUR], { servings: 2 });
    const block = advancedBlock(base, { servings: 2 });
    renderSection(
      recipe([FLOUR, SUGAR], { servings: 4, codexNutrition: block as never, nutrition: { calories: 100 } as never })
    );
    expect(document.getElementById('recipe-nutrition-section')?.textContent ?? '').toMatch(/may be out of date/i);
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    // The saved Advanced block is still the compact authority, scaled to the
    // CURRENT recipe scale (364 kcal for 2 saved servings -> 728 for the current
    // 4); legacy 100 is never silently substituted.
    const normal = document.getElementById('recipe-nutrition-card') as HTMLElement;
    expect(normal.textContent).toMatch(/728/);
    expect(normal.textContent).not.toMatch(/\b100\b/);
  });

  it('a PARTIAL saved Advanced result shows its partial values clearly labelled as partial', () => {
    const base = recipe([FLOUR, SUGAR]);
    renderSection(
      recipe([FLOUR, SUGAR], { codexNutrition: partialBlock(base) as never, nutrition: { calories: 320 } as never })
    );
    const normal = document.getElementById('recipe-nutrition-card') as HTMLElement;
    // The incomplete/partial state is explicit and prominent.
    expect(normal.textContent).toMatch(/Partial estimate/i);
    expect(normal.textContent).toMatch(/Advanced nutrition incomplete/i);
    expect(normal.textContent).toMatch(/1 of 2 ingredient lines resolved/i);
    expect(normal.textContent).toMatch(/unresolved ingredient line/i);
    // The PARTIAL values over the resolved lines ARE shown (not hidden).
    expect(normal.textContent).toMatch(/364/);
    expect(normal.textContent).toMatch(/91\.3/);
    expect(normal.textContent).toMatch(/11/);
    // No per-nutrient legacy top-up.
    expect(normal.textContent).not.toMatch(/320/);
    // The detailed partial values remain available inside the separate card.
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
    expect(document.querySelector('[data-testid="advanced-saved-partial"]')).toBeTruthy();
  });

  it('the separate Advanced status card distinguishes complete from partial', () => {
    const completeBase = recipe([FLOUR]);
    const first = renderSection(
      recipe([FLOUR], { codexNutrition: advancedBlock(completeBase) as never })
    );
    expect(document.querySelector('[data-testid="advanced-saved-complete"]')).toBeTruthy();
    first.unmount();
    const partialBase = recipe([FLOUR, SUGAR]);
    renderSection(recipe([FLOUR, SUGAR], { codexNutrition: partialBlock(partialBase) as never }));
    expect(document.querySelector('[data-testid="advanced-saved-partial"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="advanced-saved-partial"]')?.textContent).toMatch(/1 of 2/);
  });

  it('refresh/reopen preserves the PARTIAL incomplete state', () => {
    const base = recipe([FLOUR, SUGAR]);
    const partial = recipe([FLOUR, SUGAR], { codexNutrition: partialBlock(base) as never });
    const first = renderSection(partial);
    expect(document.querySelector('[data-testid="nutrition-advanced-incomplete"]')).toBeTruthy();
    first.unmount();
    renderSection(partial);
    expect(document.querySelector('[data-testid="nutrition-advanced-incomplete"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="advanced-saved-partial"]')).toBeTruthy();
  });

  it('reports an unknown future schema and keeps the legacy fallback clearly labelled', () => {
    renderSection(
      recipe([FLOUR], {
        frontmatter: { codex_nutrition: { schema: 3, basis: 'total' } },
        nutrition: { calories: 100 } as never,
      })
    );
    expect(document.getElementById('recipe-nutrition-section')?.textContent ?? '').toMatch(/newer format/i);
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    expect(screen.getByText(/Legacy estimate/i)).toBeTruthy();
  });

  it('reports a malformed saved block and keeps the legacy fallback clearly labelled', () => {
    renderSection(
      recipe([FLOUR], {
        frontmatter: { codex_nutrition: { schema: 1, basis: 'per_serving', servings: 4 } },
        nutrition: { calories: 100 } as never,
      })
    );
    expect(document.getElementById('recipe-nutrition-section')?.textContent ?? '').toMatch(/cannot be read safely/i);
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    expect(screen.getByText(/Legacy estimate/i)).toBeTruthy();
  });

  it('viewing a recipe never triggers Apply (no automatic write)', () => {
    const base = recipe([FLOUR]);
    const { onApply } = renderSection(
      recipe([FLOUR], { codexNutrition: advancedBlock(base) as never, nutrition: { calories: 320 } as never })
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  it('a recipe with neither representation shows the empty legacy state', () => {
    renderSection(recipe([FLOUR]));
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
  });

  it('refresh/reopen: a saved block keeps BOTH the normal card and the separate Advanced card', () => {
    const base = recipe([FLOUR]);
    const withSaved = recipe([FLOUR], { codexNutrition: advancedBlock(base) as never });
    const first = renderSection(withSaved);
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
    first.unmount();
    // Re-mount simulates a page refresh/reopen with the saved block still present.
    renderSection(withSaved);
    expect(document.getElementById('recipe-nutrition-card')).toBeTruthy();
    expect(document.getElementById('advanced-nutrition-card')).toBeTruthy();
    const normal = document.getElementById('recipe-nutrition-card') as HTMLElement;
    expect(normal.textContent).toMatch(/364/);
    expect(normal.textContent).toMatch(/current recipe: 4 servings/i);
  });
});
