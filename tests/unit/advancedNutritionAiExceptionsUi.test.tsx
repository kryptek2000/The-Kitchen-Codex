// @vitest-environment jsdom
/**
 * The Kitchen Codex — unified AI exception-resolution UI.
 *
 * Proves the product contract:
 *   - the bulk "Resolve remaining with AI" action is offered for ANY actionable
 *     exception (needs_amount / review_suggested / needs_match), not only
 *     NEEDS MATCH;
 *   - the live status summary always equals the rendered row statuses;
 *   - row-level AI help exists on actionable rows;
 *   - AI amount offers are explicit user choices backed by authenticated USDA
 *     portions;
 *   - loading feedback, post-result feedback, and stale-response safety hold.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { resolveAmountsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiAmountResolve';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  AiAmountResolveOutcome,
  AiResolveOutcome,
  LiveRowState,
  Phase4Row,
  Phase4State,
} from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const SPECS = [
  {
    fdcId: 7001,
    dataType: 'sr_legacy' as const,
    description: 'Garlic, raw',
    proteinAmount: 5,
    portions: [
      { usda_portion_id: 1, amount: 1, measure: 'clove', gram_weight: 3, sequence: 1 },
      { usda_portion_id: 2, amount: 3, measure: 'cloves', gram_weight: 9, sequence: 2 },
    ],
  },
  {
    fdcId: 7004,
    dataType: 'sr_legacy' as const,
    description: 'Bread, white',
    proteinAmount: 8,
    portions: [
      { usda_portion_id: 3, amount: 1, measure: 'slice', gram_weight: 25, sequence: 1 },
      { usda_portion_id: 4, amount: 1, measure: 'slice', gram_weight: 32, sequence: 2 },
    ],
  },
  {
    fdcId: 7002,
    dataType: 'foundation' as const,
    description: 'Mystery, raw',
    proteinAmount: 1,
    portions: [{ usda_portion_id: 5, amount: 1, measure: 'cup', gram_weight: 100, sequence: 1 }],
  },
  {
    fdcId: 5030,
    dataType: 'sr_legacy' as const,
    description: 'Berries, dried',
    proteinAmount: 2,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 100, sequence: 1 }],
  },
  {
    fdcId: 5031,
    dataType: 'sr_legacy' as const,
    description: 'Berries, frozen',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 120, sequence: 1 }],
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

function recipe(line: string, id = 'r1'): ObsidianRecipe {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `Recipes/${id}.md`,
    rawMarkdown: '',
    title: `Recipe ${id}`,
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: [structured(line)] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

const EMPTY_AMOUNTS: AiAmountResolveOutcome = {
  resolved: [],
  offers: [],
  unresolved: [],
  inconsistent: [],
  auto_count: 0,
};

const EMPTY_FOOD: AiResolveOutcome = { candidates: [], unresolved: [], auto_count: 0 };

async function openAndAnalyze(): Promise<void> {
  fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
  await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
  await waitFor(() =>
    expect(document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length).toBeGreaterThan(0)
  );
  fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
  await waitFor(() => expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy());
}

function summaryText(): string {
  return screen.getByTestId('advanced-nutrition-live-summary').textContent ?? '';
}

function rowStatusText(): string {
  return (
    document.querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? ''
  ).trim();
}

function autoFoodOutcome(row: Phase4Row, description: string, fdcId: number): {
  ok: true;
  outcome: AiResolveOutcome;
  amounts: AiAmountResolveOutcome;
} {
  // A GENUINE pinned-catalog record digest: the deterministic calculator must
  // independently authenticate the selection (a forged digest would fail closed).
  const search = session.searchFoods(String(fdcId), 5);
  if (!search.ok) throw new Error('search failed');
  const hit = search.results.find((result) => result.fdc_id === fdcId);
  if (!hit) throw new Error('missing search hit');
  return {
    ok: true,
    outcome: {
      candidates: [
        {
          line_ref: row.line_ref,
          query: 'mystery raw',
          fdc_id: fdcId,
          description,
          record_digest: hit.record_digest,
          auto: true,
          choice: {
            kind: 'manual' as const,
            fdc_id: fdcId,
            review_digest: row.review_digest ?? '',
            record_digest: hit.record_digest,
            catalog_digest: session.metadata().catalog_digest,
            description,
            aiAssisted: true,
            aiAccepted: true,
          },
        },
      ],
      unresolved: [],
      auto_count: 1,
    },
    amounts: EMPTY_AMOUNTS,
  };
}

describe('unified AI exception eligibility — UI', () => {
  it('shows the bulk AI action for needs_amount with ZERO needs-match rows', async () => {
    const handler = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    render(<AdvancedNutritionCard recipe={recipe('3 garlic cloves, minced')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();

    expect(rowStatusText()).toBe('Needs amount');
    expect(summaryText()).toMatch(/0 need match/);
    expect(summaryText()).toMatch(/1 need amount/);
    expect(screen.getByTestId('advanced-nutrition-ai')).toBeTruthy();
    expect(screen.getByTestId('advanced-nutrition-ai-resolve')).toBeTruthy();
    expect((screen.getByTestId('advanced-nutrition-ai-resolve') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the bulk AI action for review_suggested with ZERO needs-match rows', async () => {
    const handler = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    render(<AdvancedNutritionCard recipe={recipe('1 cup berries')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();

    expect(rowStatusText()).toBe('Review suggested');
    expect(summaryText()).toMatch(/0 need match/);
    expect(summaryText()).toMatch(/1 review suggested/);
    expect(screen.getByTestId('advanced-nutrition-ai-resolve')).toBeTruthy();
  });

  it('shows the bulk AI action for needs_match', async () => {
    const handler = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    render(<AdvancedNutritionCard recipe={recipe('1 cup Zzz')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    expect(rowStatusText()).toBe('Needs match');
    expect(screen.getByTestId('advanced-nutrition-ai-resolve')).toBeTruthy();
  });

  it('hides the bulk AI action when every row is resolved', async () => {
    const handler = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    render(<AdvancedNutritionCard recipe={recipe('100 g Mystery, raw')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    expect(rowStatusText()).toBe('Matched');
    expect(summaryText()).toMatch(/1 matched/);
    expect(summaryText()).toMatch(/0 need amount/);
    expect(screen.queryByTestId('advanced-nutrition-ai')).toBeNull();
  });

  it('offers row-level AI help on an actionable needs_amount row', async () => {
    const handler = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    render(<AdvancedNutritionCard recipe={recipe('3 garlic cloves, minced')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-edit'));
    fireEvent.click(await screen.findByTestId('advanced-nutrition-ai-help'));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const args = (handler.mock.calls[0] as unknown as [{
      issueKinds: Record<string, string>;
      rows: ReadonlyArray<unknown>;
    }])[0];
    expect(args.rows).toHaveLength(1);
    expect(Object.values(args.issueKinds)).toEqual(['needs_amount']);
  });
});

describe('live status summary authority — UI', () => {
  it('summary follows an explicit user resolution immediately (no stale counters)', async () => {
    render(<AdvancedNutritionCard recipe={recipe('1 cup berries')} session={session} />);
    await openAndAnalyze();
    expect(summaryText()).toMatch(/0 matched/);
    expect(summaryText()).toMatch(/1 review suggested/);

    // Expand and pick a credible food + its authenticated cup portion.
    fireEvent.click(screen.getByTestId('advanced-nutrition-edit'));
    const row = document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement;
    const foodRadio = Array.from(row.querySelectorAll('input[type="radio"]')).find((radio) =>
      (radio.closest('label')?.textContent ?? '').includes('5030')
    ) as HTMLInputElement | undefined;
    if (!foodRadio) throw new Error('missing food radio');
    fireEvent.click(foodRadio);

    // The count/volume portion appears; choose the authenticated cup portion.
    await waitFor(() => {
      const label = Array.from(document.querySelectorAll('label')).find(
        (entry) => (entry.textContent ?? '').trim() === '1 cup = 100 g'
      );
      if (!label) throw new Error('missing portion');
      fireEvent.click(label.querySelector('input[type="radio"]') as HTMLInputElement);
    });
    await waitFor(() => expect(rowStatusText()).toBe('Matched'));
    // The summary derives from the SAME live rows, never the analyzer snapshot.
    expect(summaryText()).toMatch(/1 matched/);
    expect(summaryText()).toMatch(/0 review suggested/);
  });
});

describe('AI amount offers and post-result feedback — UI', () => {
  it('reports loading and post-result feedback for an auto resolution', async () => {
    let release: ((value: any) => void) | null = null;
    let capturedRow: Phase4Row | null = null;
    const handler = vi.fn(
      (args: { rows: ReadonlyArray<Phase4Row> }) =>
        new Promise<any>((resolve) => {
          capturedRow = args.rows[0];
          release = resolve;
        })
    );
    render(<AdvancedNutritionCard recipe={recipe('1 cup Zzz')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-ai-resolve').textContent).toMatch(
        /Resolving remaining ingredients/i
      )
    );
    if (!release || !capturedRow) throw new Error('request not captured');
    await act(async () => {
      release(autoFoodOutcome(capturedRow as Phase4Row, 'Mystery, raw', 7002));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(
        /No additional ingredients could be resolved automatically/i
      )
    );
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(
        /1 still needs review/i
      )
    );
    // FOOD identity only: no mass is invented for `1 cup Zzz`, so the row stays
    // NEEDS AMOUNT but is now bound to the genuine authenticated record. It must
    // NEVER be counted as automatically resolved.
    await waitFor(() => expect(rowStatusText()).toBe('Needs amount'));
    const row = document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement;
    expect(row.textContent).toMatch(/Mystery, raw/);
    expect(row.textContent).toMatch(/AI-assisted USDA match/);
  });

  it('applies a real AI-assisted count resolution to the SAME live state (badge, mass, evidence, counts)', async () => {
    const handler = vi.fn(
      async (args: {
        session: AdvancedNutritionSession;
        rows: ReadonlyArray<Phase4Row>;
        adapted: ReadonlyArray<AdaptedIngredient>;
        liveRows: ReadonlyArray<LiveRowState>;
        state: Phase4State;
      }) => {
        // The REAL local verification the application layer runs: an advisory
        // `clove` hint becomes an authenticated USDA count-portion choice.
        const amounts = resolveAmountsFromAiSuggestions({
          session: args.session,
          rows: args.rows,
          adapted: args.adapted,
          liveRows: args.liveRows,
          state: args.state,
          suggestions: [
            {
              line_ref: args.rows[0].line_ref,
              interpreted_food_name: 'Garlic, raw',
              suggested_usda_queries: ['garlic raw'],
              quantity_value: 3,
              quantity_unit_hint: 'cloves',
              count_descriptor_hint: 'clove',
              portion_search_hint: 'clove',
            },
          ],
        });
        return { ok: true, interpretedCount: 1, outcome: EMPTY_FOOD, amounts };
      }
    );
    render(<AdvancedNutritionCard recipe={recipe('3 garlic cloves, minced')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    expect(rowStatusText()).toBe('Needs amount');
    expect(summaryText()).toMatch(/1 need amount/);

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(
        /1 resolved automatically with USDA data/i
      )
    );

    // The SAME live state drives the rendered badge, the mass, the evidence and
    // the preview: the row must have genuinely transitioned to MATCHED with the
    // authenticated 9 g (3 cloves x 3 g), never a proposal-only count.
    await waitFor(() => expect(rowStatusText()).toBe('Matched'));
    const row = document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement;
    expect(row.textContent).toMatch(/9 g/);
    expect(row.textContent).toMatch(/USDA count portion/);
    expect(row.textContent).toMatch(/AI-assisted USDA count portion/);
    expect(row.textContent).not.toMatch(/user-confirmed/i);
    await waitFor(() => expect(summaryText()).toMatch(/1 matched/));
    expect(summaryText()).toMatch(/0 need amount/);
    expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(
      /0 still need review/i
    );
  });

  it('shows authenticated amount offers and applies the user choice explicitly', async () => {
    const handler = vi.fn(async ({ rows }: { rows: ReadonlyArray<Phase4Row> }) => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: {
        resolved: [],
        offers: [
          {
            line_ref: rows[0].line_ref,
            fdc_id: 7004,
            portion_index: 0,
            display_label: '1 slice = 25 g',
            resolved_grams: 75,
            hint: { unit: 'slice', size: null },
          },
          {
            line_ref: rows[0].line_ref,
            fdc_id: 7004,
            portion_index: 1,
            display_label: '1 slice = 32 g',
            resolved_grams: 96,
            hint: { unit: 'slice', size: null },
          },
        ],
        unresolved: [],
        inconsistent: [],
        auto_count: 0,
      },
    }));
    render(<AdvancedNutritionCard recipe={recipe('3 slices bread')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    expect(rowStatusText()).toBe('Needs amount');

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(
        /1 still needs review/i
      )
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-edit'));
    const offers = await screen.findByTestId('advanced-nutrition-ai-amount-offers');
    expect(offers.textContent).toMatch(/1 slice = 25 g/);
    expect(offers.textContent).toMatch(/1 slice = 32 g/);

    const useButtons = screen.getAllByTestId('advanced-nutrition-ai-amount-use');
    fireEvent.click(useButtons[0]);
    await waitFor(() => expect(rowStatusText()).toBe('Matched'));
    const row = document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement;
    expect(row.textContent).toMatch(/75 g/);
    expect(screen.queryByTestId('advanced-nutrition-ai-amount-offers')).toBeNull();
  });

  it('clears AI amount offers on Re-analyze', async () => {
    const handler = vi.fn(async ({ rows }: { rows: ReadonlyArray<Phase4Row> }) => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: {
        resolved: [],
        offers: [
          {
            line_ref: rows[0].line_ref,
            fdc_id: 7004,
            portion_index: 0,
            display_label: '1 slice = 25 g',
            resolved_grams: 75,
            hint: { unit: 'slice', size: null },
          },
        ],
        unresolved: [],
        inconsistent: [],
        auto_count: 0,
      },
    }));
    render(<AdvancedNutritionCard recipe={recipe('3 slices bread')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    fireEvent.click(screen.getByTestId('advanced-nutrition-edit'));
    await screen.findByTestId('advanced-nutrition-ai-amount-offers');
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    await waitFor(() =>
      expect(screen.queryByTestId('advanced-nutrition-ai-amount-offers')).toBeNull()
    );
    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
  });

  it('rapid double-click makes exactly ONE AI request', async () => {
    const handler = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    render(<AdvancedNutritionCard recipe={recipe('3 garlic cloves, minced')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    const button = screen.getByTestId('advanced-nutrition-ai-resolve');
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });
});

describe('recipe-bound AI lifecycle — needs_amount', () => {
  function Harness({
    handler,
  }: {
    handler: ComponentProps<typeof AdvancedNutritionCard>['onResolveWithAi'];
  }) {
    const [which, setWhich] = useState<'A' | 'B'>('A');
    const current =
      which === 'A' ? recipe('3 garlic cloves, minced', 'A') : recipe('3 garlic cloves, minced', 'B');
    return (
      <>
        <button data-testid="switch-recipe" onClick={() => setWhich((value) => (value === 'A' ? 'B' : 'A'))}>
          switch
        </button>
        <AdvancedNutritionCard recipe={current} session={session} onResolveWithAi={handler} />
      </>
    );
  }

  it('discards an in-flight amount response after the analyzer is closed', async () => {
    const calls: Array<{ rows: ReadonlyArray<Phase4Row>; resolve: (value: any) => void }> = [];
    const handler = vi.fn(
      (args: { rows: ReadonlyArray<Phase4Row> }) =>
        new Promise<any>((resolve) => {
          calls.push({ rows: args.rows, resolve });
        })
    );
    render(<AdvancedNutritionCard recipe={recipe('3 garlic cloves, minced', 'C')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByTestId('advanced-nutrition-close-without-saving'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      calls[0].resolve({
        ok: true,
        outcome: EMPTY_FOOD,
        amounts: {
          resolved: [],
          offers: [
            {
              line_ref: calls[0].rows[0].line_ref,
              fdc_id: 7001,
              portion_index: 0,
              display_label: '1 clove = 3 g',
              resolved_grams: 9,
              hint: { unit: 'clove', size: null },
            },
          ],
          unresolved: [],
          inconsistent: [],
          auto_count: 0,
        },
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
    await openAndAnalyze();
    expect(rowStatusText()).toBe('Needs amount');
    expect(screen.queryByTestId('advanced-nutrition-ai-amount-offers')).toBeNull();
  });

  it('discards an in-flight amount response after a recipe switch', async () => {
    const calls: Array<{ rows: ReadonlyArray<Phase4Row>; resolve: (value: any) => void }> = [];
    const handler = vi.fn(
      (args: { rows: ReadonlyArray<Phase4Row> }) =>
        new Promise<any>((resolve) => {
          calls.push({ rows: args.rows, resolve });
        })
    );
    render(<Harness handler={handler} />);
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByTestId('switch-recipe'));
    await act(async () => {
      calls[0].resolve({
        ok: true,
        outcome: EMPTY_FOOD,
        amounts: {
          resolved: [],
          offers: [
            {
              line_ref: calls[0].rows[0].line_ref,
              fdc_id: 7001,
              portion_index: 0,
              display_label: '1 clove = 3 g',
              resolved_grams: 9,
              hint: { unit: 'clove', size: null },
            },
          ],
          unresolved: [],
          inconsistent: [],
          auto_count: 0,
        },
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
    await openAndAnalyze();
    expect(rowStatusText()).toBe('Needs amount');
  });
});
