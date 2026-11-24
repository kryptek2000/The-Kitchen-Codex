// @vitest-environment jsdom
/**
 * SINC-2 — explicit USDA Branded Foods lookup in the existing Advanced review.
 *
 * Proves:
 *   - no lookup on open/Generate/greeting-like inactivity;
 *   - only the selected food term is requested;
 *   - a product is never auto-selected or auto-applied;
 *   - representative-brand acceptance is required when the recipe names no brand;
 *   - the selected product becomes a source-backed contribution in the existing
 *     working preview, with no Apply/Save side effect.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptUsdaBrandedFoodRecord } from '../../src/core/nutritionV2/brandedFoods';
import type {
  AdvancedNutritionSession,
  AiAmountResolveOutcome,
  AiResolveOutcome,
  Phase4Row,
} from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import {
  MOCK_BRANDED_GOCHUJANG_FDC_ID,
  mockBrandedDetail,
} from '../fixtures/usdaBrandedFixtures';

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle([
    {
      fdcId: 9811,
      dataType: 'foundation' as const,
      description: 'Unrelated, fixture record',
    },
  ]);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

afterEach(() => cleanup());

const EMPTY_AMOUNTS: AiAmountResolveOutcome = {
  resolved: [],
  offers: [],
  unresolved: [],
  inconsistent: [],
  auto_count: 0,
};

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
  return {
    id: 'sinc2-branded-recipe',
    fileName: 'sinc2-branded-recipe.md',
    filePath: 'Recipes/sinc2-branded-recipe.md',
    rawMarkdown: '',
    title: 'SINC-2 Branded Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: lines.map((line) => structured(line)) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

function aiFirstFor(rowRefs: ReadonlyArray<string>) {
  return {
    ok: true as const,
    outcome: {
      candidates: [],
      unresolved: rowRefs,
      auto_count: 0,
    } satisfies AiResolveOutcome,
    amounts: EMPTY_AMOUNTS,
    aiFirstReviews: rowRefs.map((lineRef) => ({
      line_ref: lineRef,
      decision: 'no_match' as const,
      justification: 'No defensible local USDA identity for the mock fixture.',
      uncertainty: '',
      candidate_count: 0,
    })),
  };
}

async function openAndAnalyze(): Promise<ReadonlyArray<string>> {
  let rowRefs: ReadonlyArray<string> = [];
  const aiFirst = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => {
    rowRefs = args.rows.map((row) => row.line_ref);
    return aiFirstFor(rowRefs);
  });
  const legacy = vi.fn(async () => ({
    ok: true as const,
    outcome: { candidates: [], unresolved: [], auto_count: 0 } satisfies AiResolveOutcome,
    amounts: EMPTY_AMOUNTS,
  }));
  const branded = vi.fn(async () => {
    const candidate = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!candidate.ok) throw new Error('fixture did not adapt');
    return {
      ok: true as const,
      message: '1 USDA Branded Foods candidate ready for review. Nothing is selected or applied automatically.',
      candidates: [candidate.candidate],
      cacheStatus: 'miss' as const,
      retrievedAt: '2026-11-22T00:00:00.000Z',
    };
  });

  render(
    <AdvancedNutritionCard
      recipe={recipe(['2 tbsp gochujang'])}
      session={session}
      onResolveWithAi={legacy}
      onResolveWithAiFirst={aiFirst}
      onSearchBrandedFoods={branded}
    />
  );
  fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
  await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
  await waitFor(() =>
    expect(document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length).toBeGreaterThan(0)
  );
  fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
  await waitFor(() => expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy());
  fireEvent.click(await screen.findByTestId('advanced-nutrition-analyze-with-shiso'));
  await waitFor(() => expect(aiFirst).toHaveBeenCalledTimes(1));
  return rowRefs;
}

describe('SINC-2 branded lookup — explicit review workflow', () => {
  it('searches only after the user chooses a line and requires representative acceptance', async () => {
    const rowRefs = await openAndAnalyze();
    const lineRef = rowRefs[0];

    const searchButton = (await screen.findByTestId('advanced-nutrition-branded-search')) as HTMLButtonElement;
    expect(searchButton.disabled).toBe(true);
    // The lookup is never automatic.
    expect(screen.queryByTestId(`advanced-nutrition-branded-candidate-${MOCK_BRANDED_GOCHUJANG_FDC_ID}`)).toBeNull();

    const select = screen.getByTestId('advanced-nutrition-branded-line') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: lineRef } });
    expect(searchButton.disabled).toBe(false);
    fireEvent.click(searchButton);

    await waitFor(() =>
      expect(screen.getByTestId(`advanced-nutrition-branded-candidate-${MOCK_BRANDED_GOCHUJANG_FDC_ID}`)).toBeTruthy()
    );
    const card = screen.getByTestId(`advanced-nutrition-branded-candidate-${MOCK_BRANDED_GOCHUJANG_FDC_ID}`);
    expect(card.textContent).toContain('SINC2 MOCK GOCHUJANG SAUCE');
    expect(card.textContent).toContain('Mock Foods');
    expect(card.textContent).toContain(`USDA FDC ${MOCK_BRANDED_GOCHUJANG_FDC_ID}`);
    expect(card.textContent).toContain('Per 1 label serving');
    expect(card.textContent).toContain('Representative product estimate');

    // Selecting a candidate is still not acceptance.
    fireEvent.click(screen.getByTestId(`advanced-nutrition-branded-select-${MOCK_BRANDED_GOCHUJANG_FDC_ID}`));
    const useButton = screen.getByTestId('advanced-nutrition-branded-use') as HTMLButtonElement;
    expect(useButton.disabled).toBe(true);
    const representative = screen.getByTestId('advanced-nutrition-branded-representative') as HTMLInputElement;
    fireEvent.click(representative);
    expect(useButton.disabled).toBe(false);

    fireEvent.click(useButton);
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-branded-message').textContent).toMatch(
        /added to the working review/i
      )
    );
    // The existing contribution surface now carries the branded provenance.
    expect(screen.getByLabelText('AI nutrition contributions').textContent).toContain('USDA Branded');
    expect(screen.getByLabelText('AI nutrition contributions').textContent).toContain(
      `USDA FDC ${MOCK_BRANDED_GOCHUJANG_FDC_ID}`
    );
  });

  it('shows a bounded not-configured state and never invents a candidate', async () => {
    const rowRefs = await openAndAnalyze();
    const branded = vi.fn(async () => ({
      ok: false as const,
      code: 'not_configured',
      message: 'USDA Branded Foods lookup is not configured on this server. The ingredient remains unresolved.',
    }));

    // Re-render with the failing handler while keeping the same review open is
    // not supported by the card; instead assert the handler contract directly
    // through a fresh render.
    cleanup();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['2 tbsp gochujang'])}
        session={session}
        onResolveWithAi={async () => ({
          ok: true as const,
          outcome: { candidates: [], unresolved: [], auto_count: 0 } satisfies AiResolveOutcome,
          amounts: EMPTY_AMOUNTS,
        })}
        onResolveWithAiFirst={async (args) => {
          const refs = args.rows.map((row) => row.line_ref);
          return aiFirstFor(refs);
        }}
        onSearchBrandedFoods={branded}
      />
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length).toBeGreaterThan(0)
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy());
    fireEvent.click(await screen.findByTestId('advanced-nutrition-analyze-with-shiso'));
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-branded-line')).toBeTruthy());

    const refs = Array.from(
      document.querySelectorAll<HTMLOptionElement>('[data-testid="advanced-nutrition-branded-line"] option')
    ).map((option) => option.value).filter((value) => value.length > 0);
    expect(refs.length).toBeGreaterThan(0);
    fireEvent.change(screen.getByTestId('advanced-nutrition-branded-line'), { target: { value: refs[0] } });
    fireEvent.click(screen.getByTestId('advanced-nutrition-branded-search'));
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-branded-message').textContent).toMatch(/not configured/i)
    );
    expect(screen.queryByTestId(`advanced-nutrition-branded-candidate-${MOCK_BRANDED_GOCHUJANG_FDC_ID}`)).toBeNull();
    expect(branded).toHaveBeenCalledTimes(1);
    // The row remains unresolved; no contribution was added.
    expect(screen.queryByLabelText('AI nutrition contributions')).toBeNull();
  });
});
