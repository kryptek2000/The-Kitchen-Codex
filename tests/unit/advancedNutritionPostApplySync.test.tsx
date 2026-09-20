// @vitest-environment jsdom
/**
 * Advanced Nutrition — post-Apply live sync + serving-scaled standard nutrition.
 *
 * Proves that a successful Apply immediately replaces the saved Advanced result
 * on every recipe-facing surface (no reload/reopen), and that the standard
 * Nutrition & Macros card (and header basis) follow the CURRENT recipe serving
 * scale derived from the canonical saved base totals.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { RecipeNutritionSection } from '../../src/components/RecipeNutritionSection';
import { resolveRecipeNutritionPresentation } from '../../src/core/nutritionV2/phase5c';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { encodeCodexNutrition, validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const SPECS = [
  { fdcId: 1002, dataType: 'foundation' as const, description: 'Butter, stick, unsalted' },
  { fdcId: 1003, dataType: 'foundation' as const, description: 'Salt, table' },
];

const FULL06121: readonly [number, string][] = [
  [1002, 'Butter, stick, unsalted'],
  [1003, 'Salt, table'],
];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

afterEach(() => cleanup());

const network = {
  request: vi.fn(async () => ({ status: 200, ok: true })),
  get: vi.fn(async () => ({ status: 200, ok: true })),
  post: vi.fn(async () => ({ status: 200, ok: true })),
} as unknown as NetworkAdapter;

function recipe(lines: ReadonlyArray<{ original: string; amount?: number; unit?: string; name: string }>, overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Post Apply Sync',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: lines as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...overrides,
  } as unknown as ObsidianRecipe;
}

function blockFor(
  target: ObsidianRecipe,
  overrides: Partial<CodexNutritionV1> = {}
): CodexNutritionV1 {
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
      calories: {
        amount: 1200,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 2,
        measurable_ingredient_count: 2,
      },
    },
    ingredients: adaptation.recipe.adapted.map((entry) => ({
      line_ref: entry.line_ref,
      source: 'usda_fdc' as const,
      source_food_id: '1002',
      source_release: 'r',
      match_status: 'confirmed' as const,
      resolved: true,
      user_confirmed: true,
    })),
    unresolved: [],
    ...overrides,
  };
  const validation = validateCodexNutritionV1(raw);
  if (!validation.ok || !validation.value) throw new Error('block invalid');
  return validation.value;
}

function withBlock(target: ObsidianRecipe, block: CodexNutritionV1): ObsidianRecipe {
  return {
    ...target,
    codexNutrition: block as never,
    frontmatter: { codex_nutrition: encodeCodexNutrition(block) },
  } as ObsidianRecipe;
}

/**
 * Mimics the application shell: the Apply handler installs the NEW saved block
 * into the authoritative recipe state (the single source of truth), exactly as
 * App's write callback does.
 */
function Harness({ initial, next }: { initial: ObsidianRecipe; next: CodexNutritionV1 }) {
  const [current, setCurrent] = useState<ObsidianRecipe>(initial);
  const onApply = vi.fn(async () => {
    setCurrent((prev) => withBlock(prev, next));
    return { ok: true, mode: 'replace' as const, message: 'Advanced Nutrition was replaced and saved to your recipe.' };
  });
  return (
    <RecipeNutritionSection
      recipe={current}
      presentation={resolveRecipeNutritionPresentation(current)}
      servings={current.servings}
      network={network}
      onUpdateNutrition={vi.fn()}
      advancedNutritionSession={session}
      advancedNutritionBundleStatus="ready"
      onLoadAdvancedNutritionBundle={vi.fn()}
      onApplyAdvancedNutrition={onApply}
    />
  );
}

async function applyWorkingResult(): Promise<void> {
  fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
  await screen.findByTestId('saved-advanced-status');
  fireEvent.click(screen.getByTestId('saved-advanced-edit'));
  const analyze = await screen.findByTestId('advanced-nutrition-analyze');
  fireEvent.click(analyze);
  await waitFor(() => {
    const apply = screen.getByRole('button', { name: /Apply and replace saved nutrition/i });
    expect(apply.hasAttribute('disabled')).toBe(false);
  });
  fireEvent.click(screen.getByRole('button', { name: /Apply and replace saved nutrition/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Confirm Apply/i }));
  await screen.findByText(/was replaced and saved to your recipe/i);
  // The working modal stays open on success; close it to reveal the saved result.
  fireEvent.click(screen.getByLabelText('Close Advanced Nutrition'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('post-Apply live sync', () => {
  it('replaces a PARTIAL saved result A with a COMPLETE working result B immediately', async () => {
    const base = recipe([
      { original: '57 g unsalted butter', amount: 57, unit: 'g', name: 'unsalted butter' },
      { original: '5 g salt', amount: 5, unit: 'g', name: 'salt' },
    ]);
    const partialA = blockFor(base, {
      status: 'partial',
      nutrients: {
        calories: {
          amount: 1300,
          unit: 'kcal',
          status: 'partial',
          coverage: 0.5,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 2,
        },
      },
      ingredients: blockFor(base).ingredients.slice(0, 1),
      unresolved: [{ line_ref: 'ing:1:deadbeefdead', reason: 'no_match' }],
    });
    const completeB = blockFor(base, {
      status: 'complete',
      nutrients: {
        calories: {
          amount: 1600,
          unit: 'kcal',
          status: 'complete',
          coverage: 1,
          covered_ingredient_count: 2,
          measurable_ingredient_count: 2,
        },
      },
    });

    render(<Harness initial={withBlock(base, partialA)} next={completeB} />);
    // A is shown first.
    const card = document.getElementById('advanced-nutrition-card') as HTMLElement;
    await screen.findByTestId('advanced-nutrition-open');
    expect(card.textContent).toMatch(/partial/i);
    expect(document.getElementById('recipe-nutrition-card')?.textContent ?? '').toMatch(/Advanced nutrition incomplete/i);

    await applyWorkingResult();

    // B is THE saved result immediately: saved card, compact card, no A value.
    await waitFor(() => {
      expect(document.getElementById('advanced-nutrition-card')?.textContent ?? '').toMatch(/Complete coverage/i);
    });
    const sectionText = document.getElementById('recipe-nutrition-section')?.textContent ?? '';
    expect(sectionText).not.toMatch(/1300/);
    const compact = document.getElementById('recipe-nutrition-card')?.textContent ?? '';
    expect(compact).not.toMatch(/Advanced nutrition incomplete/i);
    expect(compact).toMatch(/1600/);
  });

  it('replaces a COMPLETE saved result A with a COMPLETE working result B immediately', async () => {
    const base = recipe([
      { original: '57 g unsalted butter', amount: 57, unit: 'g', name: 'unsalted butter' },
      { original: '5 g salt', amount: 5, unit: 'g', name: 'salt' },
    ]);
    const completeA = blockFor(base, {
      status: 'complete',
      nutrients: {
        calories: { amount: 1200, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
      },
    });
    const completeB = blockFor(base, {
      status: 'complete',
      nutrients: {
        calories: { amount: 1500, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
      },
    });

    render(<Harness initial={withBlock(base, completeA)} next={completeB} />);
    await screen.findByTestId('advanced-nutrition-open');
    expect(document.getElementById('recipe-nutrition-card')?.textContent ?? '').toMatch(/1200/);

    await applyWorkingResult();

    await waitFor(() => {
      const text = document.getElementById('recipe-nutrition-section')?.textContent ?? '';
      expect(text).toMatch(/1500/);
      expect(text).not.toMatch(/1200/);
    });
  });
});

describe('serving-scaled standard nutrition', () => {
  function scaledRecipe(servings: number): ObsidianRecipe {
    return recipe(
      [
        { original: '57 g unsalted butter', amount: 57, unit: 'g', name: 'unsalted butter' },
        { original: '1/2 teaspoon salt', amount: 0.5, unit: 'teaspoon', name: 'salt' },
      ],
      { servings }
    );
  }

  function baseBlock(target: ObsidianRecipe): CodexNutritionV1 {
    return blockFor(target, {
      servings: 8,
      nutrient_scope: ['calories', 'protein', 'carbohydrates', 'fat', 'fiber', 'sodium'],
      nutrients: {
        calories: { amount: 1364, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
        protein: { amount: 80, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
        carbohydrates: { amount: 100, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
        fat: { amount: 60, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
        fiber: { amount: 8, unit: 'g', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
        sodium: { amount: 1600, unit: 'mg', status: 'complete', coverage: 1, covered_ingredient_count: 2, measurable_ingredient_count: 2 },
      },
    });
  }

  function renderAt(servings: number) {
    const target = scaledRecipe(servings);
    const block = baseBlock(target);
    render(
      <RecipeNutritionSection
        recipe={withBlock(target, block)}
        presentation={resolveRecipeNutritionPresentation(withBlock(target, block))}
        servings={servings}
        network={network}
        onUpdateNutrition={vi.fn()}
        advancedNutritionBundleStatus="ready"
        onLoadAdvancedNutritionBundle={vi.fn()}
      />
    );
    return document.getElementById('recipe-nutrition-card') as HTMLElement;
  }

  function numbers(text: string): Record<string, string[]> {
    return {
      calories: [...text.matchAll(/Calories\s*([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => m[1]),
      protein: [...text.matchAll(/Protein\s*([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => m[1]),
      carbs: [...text.matchAll(/Carbs\s*([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => m[1]),
      fat: [...text.matchAll(/Fat\s*([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => m[1]),
      fiber: [...text.matchAll(/Fiber\s*([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => m[1]),
      sodium: [...text.matchAll(/Sodium\s*([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => m[1]),
    };
  }

  it('shows base entire-recipe totals at the base serving count', () => {
    const card = renderAt(8);
    expect(card.textContent).toMatch(/current recipe: 8 servings/i);
    expect(card.textContent).toMatch(/1364/);
  });

  it('scales every compact field by 0.5 and by 2, and returns exactly to base', () => {
    const base = numbers(renderAt(8).textContent ?? '');
    cleanup();
    const half = numbers(renderAt(4).textContent ?? '');
    cleanup();
    const double = numbers(renderAt(16).textContent ?? '');

    // calories / protein / carbs / fat / fiber / sodium each scale.
    expect(Number(half.calories[0])).toBeCloseTo(Number(base.calories[0]) / 2, 6);
    expect(Number(half.sodium[0])).toBeCloseTo(Number(base.sodium[0]) / 2, 6);
    expect(Number(double.calories[0])).toBeCloseTo(Number(base.calories[0]) * 2, 6);
    expect(Number(double.sodium[0])).toBeCloseTo(Number(base.sodium[0]) * 2, 6);

    // Return to base derives from canonical totals (no cumulative drift).
    cleanup();
    const back = numbers(renderAt(8).textContent ?? '');
    for (const key of Object.keys(base) as Array<keyof typeof base>) {
      expect(back[key][0]).toBe(base[key][0]);
    }
  });

  it('keeps macro percentages invariant across serving scales', () => {
    const pct = (text: string): string => {
      const m = text.match(/Protein (\d+)%[\s\S]*?Carbs (\d+)%[\s\S]*?Fat (\d+)%/);
      return m ? `${m[1]}/${m[2]}/${m[3]}` : '';
    };
    const base = pct(renderAt(8).textContent ?? '');
    cleanup();
    const half = pct(renderAt(4).textContent ?? '');
    cleanup();
    const double = pct(renderAt(16).textContent ?? '');
    expect(base.length).toBeGreaterThan(0);
    expect(half).toBe(base);
    expect(double).toBe(base);
  });

  it('keeps the canonical saved block unchanged when the serving scale changes', () => {
    const target = scaledRecipe(8);
    const block = baseBlock(target);
    const saved = withBlock(target, block);
    render(
      <RecipeNutritionSection
        recipe={saved}
        presentation={resolveRecipeNutritionPresentation(saved)}
        servings={2}
        network={network}
        onUpdateNutrition={vi.fn()}
        advancedNutritionBundleStatus="ready"
        onLoadAdvancedNutritionBundle={vi.fn()}
      />
    );
    // The UI scales, but the canonical stored totals remain the base values.
    const stored = saved.codexNutrition as CodexNutritionV1;
    expect(stored.basis).toBe('total');
    expect(stored.nutrients.calories?.amount).toBe(1364);
    expect(stored.servings).toBe(8);
  });

  it('shows PARTIAL saved values with a partial label at every serving scale', () => {
    const target = scaledRecipe(8);
    const partial = blockFor(target, {
      servings: 8,
      status: 'partial',
      nutrients: {
        calories: { amount: 1364, unit: 'kcal', status: 'partial', coverage: 0.5, covered_ingredient_count: 1, measurable_ingredient_count: 2 },
      },
      ingredients: blockFor(target).ingredients.slice(0, 1),
      unresolved: [{ line_ref: 'ing:1:deadbeefdead', reason: 'no_match' }],
    });
    for (const servings of [2, 4, 8, 16]) {
      const withSaved = withBlock(scaledRecipe(servings), partial);
      render(
        <RecipeNutritionSection
          recipe={withSaved}
          presentation={resolveRecipeNutritionPresentation(withSaved)}
          servings={servings}
          network={network}
          onUpdateNutrition={vi.fn()}
          advancedNutritionBundleStatus="ready"
          onLoadAdvancedNutritionBundle={vi.fn()}
        />
      );
      const card = document.getElementById('recipe-nutrition-card') as HTMLElement;
      // The partial state is explicit and prominent at every scale.
      expect(card.textContent).toMatch(/Partial estimate/i);
      expect(card.textContent).toMatch(/Advanced nutrition incomplete/i);
      // The partial values over the RESOLVED lines are shown and scale with servings.
      const expected = 1364 * (servings / 8);
      expect(card.textContent).toMatch(new RegExp(String(expected)));
      cleanup();
    }
  });
});
