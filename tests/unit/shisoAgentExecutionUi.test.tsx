// @vitest-environment jsdom

import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { useEffect, type ComponentProps } from 'react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { ShisoEntryProvider, useShiso, type ShisoEntryPoints } from '../../src/application-ui/shisoEntryPoints';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle([{
    fdcId: 169640,
    dataType: 'sr_legacy',
    description: 'Honey',
    portions: [{ amount: 1, measure: 'cup', gram_weight: 339, sequence: 1 }],
  }]);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('USDA fixture did not load');
  session = result.session;
});

afterEach(() => cleanup());

function honeyRecipe(): ObsidianRecipe {
  return {
    id: 'shiso-execution-honey',
    fileName: 'shiso-execution-honey.md',
    filePath: 'Recipes/shiso-execution-honey.md',
    rawMarkdown: '',
    title: 'SHISO Honey Selection',
    tags: [],
    category: 'Test',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 0,
    servings: 4,
    ingredients: [{
      original: '1/4 cup honey (or brown sugar)',
      amount: 0.25,
      unit: 'cup',
      name: 'honey',
    }] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

function PortProbe({ onReady }: { readonly onReady: (value: ShisoEntryPoints) => void }) {
  const shiso = useShiso();
  useEffect(() => onReady(shiso), [onReady, shiso]);
  return null;
}

describe('SHISO connected execution ordering', () => {
  it('applies the synchronously committed USDA selection without a render delay', async () => {
    const recipe = honeyRecipe();
    const adaptation = adaptRecipe(recipe);
    if (!adaptation.ok) throw new Error('recipe adaptation failed');
    const lineRef = adaptation.recipe.adapted[0]!.line_ref;
    const portions = session.reviewPortions(169640);
    if (!portions.ok) throw new Error('Honey portions missing');
    const honeyCup = portions.review.candidates.find((candidate) => candidate.gram_weight === 339 && /cup/i.test(candidate.display_label));
    if (!honeyCup) throw new Error('Authenticated Honey cup portion missing');

    const apply = vi.fn(async (request: Parameters<NonNullable<ComponentProps<typeof AdvancedNutritionCard>['onApplyAdvancedNutrition']>>[0]) => {
      const evidence = request.state.preview?.ingredients.find((entry) => entry.line_ref === lineRef);
      expect(evidence?.fdc_id).toBe(169640);
      expect(evidence?.resolved_grams).toBeCloseTo(84.75, 8);
      expect(request.state.preview?.status).toBe('complete');
      return { ok: true, mode: request.expectedMode, message: 'Applied the committed review.' };
    });

    let current: ShisoEntryPoints | null = null;
    const onReady = (value: ShisoEntryPoints) => { current = value; };
    render(
      <ShisoEntryProvider>
        <AdvancedNutritionCard recipe={recipe} session={session} onApplyAdvancedNutrition={apply} />
        <PortProbe onReady={onReady} />
      </ShisoEntryProvider>,
    );

    await waitFor(() => {
      expect(current?.canApplyNutritionSourceSelection).toBe(true);
      expect(current?.canApplyNutritionReview).toBe(true);
      expect(current?.snapshot?.reviewRows.length).toBe(1);
    });

    // Deliberately do not wait for a React render between these two calls.
    let selected!: Awaited<ReturnType<ShisoEntryPoints['applyNutritionSourceSelection']>>;
    let applied!: Awaited<ReturnType<ShisoEntryPoints['applyNutritionReview']>>;
    await act(async () => {
      selected = await current!.applyNutritionSourceSelection({
        lineRef,
        fdcId: 169640,
        portionIndex: honeyCup.index,
      });
      applied = await current!.applyNutritionReview();
    });
    expect(selected.ok).toBe(true);
    expect(applied).toMatchObject({ ok: true, applied: true });
    expect(apply).toHaveBeenCalledTimes(1);
  }, 30000);
});
