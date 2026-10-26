// @vitest-environment jsdom
/**
 * UD-2D.3 — nutrition presentation truthfulness regressions.
 *
 * These tests pin the PRESENTATION-ONLY contract added by the flagship pass:
 *   - a missing macro is never rendered as zero;
 *   - a macro distribution is never drawn from incomplete macro values;
 *   - a complete macro set still renders the existing (unchanged) distribution;
 *   - the Advanced card states saved-complete vs saved-partial truthfully.
 *
 * No nutrition calculation, matching, persistence or authority is exercised or
 * changed here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { AdvancedNutritionCard, advancedNutritionStatusLabel } from '../../src/components/AdvancedNutritionCard';
import { RecipeNutritionCard } from '../../src/components/RecipeNutritionCard';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import { validateAiNutrientContributions } from '../../src/core/nutritionV2/aiContribution';
import { validateCodexNutrition } from '../../src/core/nutritionV2/validate';
import { parseObsidianRecipeMarkdown } from '../../src/utils/markdownParser';
import type { ObsidianRecipe } from '../../src/types';

afterEach(() => cleanup());

const network = {} as never;

function recipe(servingsLine: string, nutritionFrontmatter: string): ObsidianRecipe {
  return parseObsidianRecipeMarkdown(
    `---\ntitle: Presentation Contract\n${servingsLine}${nutritionFrontmatter}---\n\n# Presentation Contract\n\n## Ingredients\n- 100 g Flour, wheat, white\n- 50 g Sugar, granulated\n\n## Instructions\n1. Cook.\n`,
    'presentation-contract.md',
    'Recipes/presentation-contract.md'
  );
}

function recipeWithThirdLine(): ObsidianRecipe {
  return parseObsidianRecipeMarkdown(
    `---\ntitle: Presentation Contract\nservings: 4\n---\n\n# Presentation Contract\n\n## Ingredients\n- 100 g Flour, wheat, white\n- 50 g Sugar, granulated\n- 1 tbsp Olive oil\n\n## Instructions\n1. Cook.\n`,
    'presentation-contract.md',
    'Recipes/presentation-contract.md'
  );
}

function completeBlock(target: ObsidianRecipe) {
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const raw = {
    schema: 1 as const,
    basis: 'total' as const,
    servings: adaptation.recipe.base_servings,
    status: 'complete' as const,
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'] as const,
    source_releases: { usda_fdc: 'r' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: { amount: 364, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: adaptation.recipe.adapted.length, measurable_ingredient_count: adaptation.recipe.adapted.length },
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
  };
  const validated = validateCodexNutrition(raw);
  if (!validated.ok || !validated.value) throw new Error('block invalid');
  return { block: validated.value, adaptation };
}

describe('UD-2D.3 basic nutrition presentation truthfulness', () => {
  it('leaves missing macros missing (never zero) and does not fabricate a distribution', () => {
    const target = recipe(
      'servings: 4\n',
      'calories: 390\nnutrition:\n  calories: 390\n  protein: 13\n  servings: 4\n'
    );
    render(<RecipeNutritionCard recipe={target} onUpdateNutrition={vi.fn()} network={network} />);

    // Four nutrients are absent; each is labelled "not recorded", not 0.
    expect(screen.getAllByText('not recorded')).toHaveLength(4);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByRole('img', { name: /Macro distribution by grams/i })).toBeNull();
  });

  it('keeps the existing distribution when all three macros are known', () => {
    const target = recipe(
      'servings: 4\n',
      'nutrition:\n  calories: 486\n  protein: 18\n  carbohydrates: 62\n  fat: 18\n  fiber: 6\n  sodium: 540\n  servings: 4\n  source: user_defined\n  confidence: high\n'
    );
    render(<RecipeNutritionCard recipe={target} onUpdateNutrition={vi.fn()} network={network} />);

    expect(screen.getByRole('img', { name: /Macro distribution by grams/i })).toBeTruthy();
    expect(screen.getByText('18% of macro grams')).toBeTruthy();
    expect(screen.queryByText('not recorded')).toBeNull();
  });
});

describe('UD-2D.3 advanced card saved-state truthfulness', () => {
  it('labels a complete saved result as Saved · complete', () => {
    const target = recipe('servings: 4\n', '');
    const { block } = completeBlock(target);
    render(<AdvancedNutritionCard recipe={{ ...target, codexNutrition: block } as never} savedAdvancedBlock={block} onLoadBundle={vi.fn()} />);
    expect(screen.getByTestId('advanced-nutrition-status-chip').textContent).toBe('Saved · complete');
    expect(screen.getByTestId('advanced-saved-complete')).toBeTruthy();
  });

  it('labels a partial saved result as Saved · partial and keeps it distinct from complete', () => {
    const target = recipe('servings: 4\n', '');
    const { block, adaptation } = completeBlock(target);
    const partial = validateCodexNutrition({
      ...block,
      status: 'partial',
      nutrients: {
        ...block.nutrients,
        calories: { ...block.nutrients.calories, status: 'partial', coverage: 0.5, covered_ingredient_count: 1, measurable_ingredient_count: 2 },
      },
      ingredients: block.ingredients.slice(0, 1),
      unresolved: [{ line_ref: adaptation.recipe.adapted[1].line_ref, reason: 'no_match' }],
    });
    if (!partial.ok || !partial.value) throw new Error('partial block invalid');
    render(<AdvancedNutritionCard recipe={{ ...target, codexNutrition: partial.value } as never} savedAdvancedBlock={partial.value} onLoadBundle={vi.fn()} />);
    expect(screen.getByTestId('advanced-nutrition-status-chip').textContent).toBe('Saved · partial');
    expect(screen.getByTestId('advanced-saved-partial')).toBeTruthy();
    expect(screen.queryByTestId('advanced-saved-complete')).toBeNull();
  });

  it('keeps a partial result containing accepted AI estimates explicitly partial, and keeps stale precedence', () => {
    const target = recipeWithThirdLine();
    const { block } = completeBlock(target);
    const adaptation = adaptRecipe(target);
    if (!adaptation.ok) throw new Error('adapt failed');
    const [sourceLine, aiLine, unresolvedLine] = adaptation.recipe.adapted;

    const checked = validateAiNutrientContributions(
      [{
        line_ref: aiLine.line_ref,
        ingredient: aiLine.ingredient.original,
        quantity_basis: '50 grams granulated sugar',
        weight_grams: 50,
        classification: 'ai_estimate',
        confidence: 'medium',
        assumptions: ['Approximate composition.'],
        sources: [],
        unknown_nutrients: ['fiber'],
        nutrients: {
          calories: { amount: 194, unit: 'kcal' },
          carbohydrates: { amount: 50, unit: 'g' },
        },
      }],
      { recipe_digest: `sha256:${'b'.repeat(64)}`, line_refs: adaptation.recipe.adapted.map((entry) => entry.line_ref) }
    );
    if (!checked.ok) throw new Error('ai contributions invalid');

    const partialWithAi = validateCodexNutrition({
      ...block,
      schema: 5,
      status: 'partial',
      sources: ['usda_fdc', 'ai_estimate'],
      nutrients: {
        ...block.nutrients,
        calories: {
          ...block.nutrients.calories,
          status: 'partial',
          coverage: 2 / 3,
          covered_ingredient_count: 2,
          measurable_ingredient_count: 3,
        },
      },
      ingredients: [block.ingredients[0]],
      unresolved: [{ line_ref: unresolvedLine.line_ref, reason: 'no_match' }],
      ai_contributions: checked.contributions,
    });
    if (!partialWithAi.ok || !partialWithAi.value) throw new Error('partial AI block invalid');

    const first = render(
      <AdvancedNutritionCard
        recipe={{ ...target, codexNutrition: partialWithAi.value } as never}
        savedAdvancedBlock={partialWithAi.value}
        onLoadBundle={vi.fn()}
      />
    );
    const partialChip = screen.getByTestId('advanced-nutrition-status-chip');
    expect(partialChip.textContent).toBe('Saved · partial · includes AI estimates');
    expect(partialChip.textContent).not.toMatch(/complete/i);
    expect(screen.getByTestId('advanced-saved-partial')).toBeTruthy();
    expect(screen.queryByTestId('advanced-saved-complete')).toBeNull();
    first.unmount();

    // Stale precedence remains first: no completeness claim, and the body keeps
    // the existing recalculate guidance.
    const staleTarget = recipe('servings: 4\n', '');
    const staleBase = completeBlock(staleTarget);
    const staleBlock = validateCodexNutrition({ ...staleBase.block, servings: 2 });
    if (!staleBlock.ok || !staleBlock.value) throw new Error('stale block invalid');
    render(
      <AdvancedNutritionCard
        recipe={{ ...staleTarget, codexNutrition: staleBlock.value } as never}
        savedAdvancedBlock={staleBlock.value}
        onLoadBundle={vi.fn()}
      />
    );
    const staleChip = screen.getByTestId('advanced-nutrition-status-chip');
    expect(staleChip.textContent).toBe('Saved · needs review');
    expect(staleChip.textContent).not.toMatch(/complete/i);

    // The full precedence matrix is deterministic and presentation-only.
    expect(advancedNutritionStatusLabel({ hasSavedBlock: false, nutritionUnsaved: false, stale: false, partial: false, hasAiEstimate: false })).toBe('Not analyzed');
    expect(advancedNutritionStatusLabel({ hasSavedBlock: true, nutritionUnsaved: false, stale: false, partial: false, hasAiEstimate: false })).toBe('Saved · complete');
    expect(advancedNutritionStatusLabel({ hasSavedBlock: true, nutritionUnsaved: false, stale: true, partial: false, hasAiEstimate: false })).toBe('Saved · needs review');
    expect(advancedNutritionStatusLabel({ hasSavedBlock: true, nutritionUnsaved: false, stale: true, partial: true, hasAiEstimate: true })).toBe('Saved · needs review · partial · includes AI estimates');
    expect(advancedNutritionStatusLabel({ hasSavedBlock: true, nutritionUnsaved: false, stale: false, partial: false, hasAiEstimate: true })).toBe('Saved · includes AI estimates');
    expect(advancedNutritionStatusLabel({ hasSavedBlock: true, nutritionUnsaved: false, stale: false, partial: true, hasAiEstimate: true })).toBe('Saved · partial · includes AI estimates');
    expect(advancedNutritionStatusLabel({ hasSavedBlock: true, nutritionUnsaved: true, stale: false, partial: true, hasAiEstimate: true })).toBe('Applied · not saved · partial · includes AI estimates');
  });
});
