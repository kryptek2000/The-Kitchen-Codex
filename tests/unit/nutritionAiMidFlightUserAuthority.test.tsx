// @vitest-environment jsdom
/**
 * The Kitchen Codex — AI exception resolution: MID-FLIGHT USER AUTHORITY.
 *
 * An AI request can be in flight while the user edits a targeted row. The user's
 * newer explicit decision is FINAL: a stale AI result must never overwrite it,
 * and it must never be credited to the AI operation. Untouched targeted rows in
 * the SAME response must still receive their AI resolution.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { resolveAmountsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiAmountResolve';
import type {
  AdvancedNutritionSession,
  AiAmountResolveOutcome,
  AiResolveOutcome,
  Phase4Row,
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
    fdcId: 7002,
    dataType: 'foundation' as const,
    description: 'Mystery, raw',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 100, sequence: 1 }],
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

function recipe(lines: ReadonlyArray<string>, id = 'r1'): ObsidianRecipe {
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
    ingredients: lines.map((line) => structured(line)) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

const EMPTY_FOOD: AiResolveOutcome = { candidates: [], unresolved: [], auto_count: 0 };
const EMPTY_AMOUNTS: AiAmountResolveOutcome = {
  resolved: [],
  offers: [],
  unresolved: [],
  inconsistent: [],
  auto_count: 0,
};

interface HandlerArgs {
  readonly session: AdvancedNutritionSession;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<{ line_ref: string }>;
  readonly liveRows: ReadonlyArray<unknown>;
  readonly state: unknown;
}

interface DeferredCall {
  readonly args: HandlerArgs;
  readonly resolve: (value: unknown) => void;
}

function deferredHandler() {
  const calls: DeferredCall[] = [];
  const handler = vi.fn(
    (args: HandlerArgs) =>
      new Promise<any>((resolve) => {
        calls.push({ args, resolve });
      })
  );
  return { handler, calls };
}

/** A genuine deterministic automatic food acceptance bound to the row. */
function autoFoodOutcome(row: Phase4Row, description: string, fdcId: number) {
  const search = session.searchFoods(String(fdcId), 5);
  if (!search.ok) throw new Error('search failed');
  const hit = search.results.find((result) => result.fdc_id === fdcId);
  if (!hit) throw new Error('missing search hit');
  return {
    ok: true as const,
    interpretedCount: 1,
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

/** An OFFERED (below-threshold) AI candidate; only an explicit click applies it. */
function offeredFoodOutcome(row: Phase4Row, description: string, fdcId: number) {
  const search = session.searchFoods(String(fdcId), 5);
  if (!search.ok) throw new Error('search failed');
  const hit = search.results.find((result) => result.fdc_id === fdcId);
  if (!hit) throw new Error('missing search hit');
  return {
    ok: true as const,
    interpretedCount: 1,
    outcome: {
      candidates: [
        {
          line_ref: row.line_ref,
          query: 'mystery raw',
          fdc_id: fdcId,
          description,
          record_digest: hit.record_digest,
          auto: false,
          choice: {
            kind: 'manual' as const,
            fdc_id: fdcId,
            review_digest: row.review_digest ?? '',
            record_digest: hit.record_digest,
            catalog_digest: session.metadata().catalog_digest,
            description,
            aiAssisted: true,
          },
        },
      ],
      unresolved: [],
      auto_count: 0,
    },
    amounts: EMPTY_AMOUNTS,
  };
}

async function openAndAnalyze(): Promise<void> {
  fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
  await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
  await waitFor(() =>
    expect(document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length).toBeGreaterThan(0)
  );
  fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
  await waitFor(() => expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy());
}

function rowElement(text: string): HTMLElement {
  const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find(
    (node) => (node.textContent ?? '').includes(text)
  );
  if (!row) throw new Error(`missing row: ${text}`);
  return row as HTMLElement;
}

function expandRow(text: string): void {
  const row = rowElement(text);
  const button = row.querySelector('[data-testid="advanced-nutrition-edit"]') as HTMLButtonElement;
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
}

function foodRadioIn(row: HTMLElement, fdcId: number): HTMLInputElement {
  const radio = Array.from(row.querySelectorAll('input[type="radio"]')).find((entry) =>
    (entry.closest('label')?.textContent ?? '').includes(String(fdcId))
  );
  if (!radio) throw new Error(`missing food radio ${fdcId}`);
  return radio as HTMLInputElement;
}

function countRadioIn(row: HTMLElement, label: string): HTMLInputElement {
  const radios = Array.from(row.querySelectorAll('input[type="radio"]'));
  const radio = radios.find((entry) => (entry.closest('label')?.textContent ?? '').includes(label));
  if (!radio) {
    const labels = radios.map((entry) => (entry.closest('label')?.textContent ?? '').trim());
    throw new Error(`missing count radio ${label}; available: ${labels.join(' | ')}`);
  }
  return radio as HTMLInputElement;
}

function messageText(): string {
  return screen.getByTestId('advanced-nutrition-ai-message').textContent ?? '';
}

describe('mid-flight user authority — single row', () => {
  it('TEST 1: preserves a mid-flight explicit food selection (AI never overwrites it)', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard recipe={recipe(['1 cup berries'])} session={session} onResolveWithAi={handler} />
    );
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));

    // MID-FLIGHT: the user explicitly picks an authenticated food.
    expandRow('berries');
    fireEvent.click(foodRadioIn(rowElement('berries'), 5030));
    await waitFor(() => expect(rowElement('berries').textContent).toMatch(/Berries, dried/));

    // The AI response proposes a genuine automatic food acceptance for the row.
    await act(async () => {
      calls[0].resolve(autoFoodOutcome(calls[0].args.rows[0], 'Mystery, raw', 7002));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    const row = rowElement('berries');
    expect(row.textContent).toMatch(/Berries, dried/);
    expect(row.textContent).not.toMatch(/Mystery, raw/);
    expect(row.textContent).not.toMatch(/AI-assisted USDA match/i);
    expect(messageText()).toMatch(/No additional ingredients could be resolved automatically/i);
    expect(messageText()).toMatch(/1 still needs review/i);
  });

  it('TEST 2: preserves a mid-flight explicit count-portion (stale AI amount is discarded)', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['3 cloves garlic, minced'])}
        session={session}
        onResolveWithAi={handler}
      />
    );
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));

    // MID-FLIGHT: the user explicitly selects the `3 clove = 9 g` authenticated count portion.
    expandRow('garlic');
    fireEvent.click(countRadioIn(rowElement('garlic'), '3 clove = 9 g'));
    await waitFor(() =>
      expect((rowElement('garlic').querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()).toBe('Matched')
    );

    // The AI response proposes its own authenticated count portion (1 clove = 3 g).
    const garlicRow = calls[0].args.rows[0];
    const amounts = resolveAmountsFromAiSuggestions({
      session: calls[0].args.session,
      rows: calls[0].args.rows,
      adapted: calls[0].args.adapted as never,
      liveRows: calls[0].args.liveRows as never,
      state: calls[0].args.state as never,
      suggestions: [
        {
          line_ref: garlicRow.line_ref,
          interpreted_food_name: 'Garlic, raw',
          suggested_usda_queries: ['garlic raw'],
          quantity_value: 3,
          quantity_unit_hint: 'cloves',
          count_descriptor_hint: 'clove',
          portion_search_hint: 'clove',
        },
      ],
    });
    expect(amounts.resolved).toHaveLength(1);

    await act(async () => {
      calls[0].resolve({ ok: true, interpretedCount: 1, outcome: EMPTY_FOOD, amounts });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    const row = rowElement('garlic');
    expect(row.textContent).toMatch(/9 g/);
    // The user's explicit choice carries no AI marker: the stale AI count
    // portion was discarded, not merged.
    expect(row.textContent).not.toMatch(/AI-assisted USDA count portion/i);
    expect(screen.queryByTestId('advanced-nutrition-ai-amount-badge')).toBeNull();
    expect(messageText()).toMatch(/No additional ingredients could be resolved automatically/i);
  });

  it('TEST 4: a cleared choice is not silently restored by a stale AI result', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['3 cloves garlic, minced'])}
        session={session}
        onResolveWithAi={handler}
      />
    );
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));

    // MID-FLIGHT: the user clears the analyzer's food choice ("None of these"),
    // then explicitly re-selects the SAME food as a user choice (different
    // provenance). The stale AI amount belongs to the OLD choice and must not
    // attach to the new one.
    expandRow('garlic');
    fireEvent.click(await screen.findByTestId('advanced-nutrition-change-food'));
    const noneRadio = Array.from(rowElement('garlic').querySelectorAll('input[type="radio"]')).find(
      (entry) => (entry.closest('label')?.textContent ?? '').includes('None of these')
    ) as HTMLInputElement;
    expect(noneRadio).toBeTruthy();
    fireEvent.click(noneRadio);
    await waitFor(() =>
      expect((rowElement('garlic').querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()).toBe('Needs match')
    );
    // With no selected food the candidate list is already visible; re-select 7001
    // explicitly as a USER choice (no automatic provenance).
    fireEvent.click(foodRadioIn(rowElement('garlic'), 7001));
    await waitFor(() =>
      expect((rowElement('garlic').querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()).toBe('Needs amount')
    );

    // The AI response proposes an authenticated count portion for the row.
    const garlicRow = calls[0].args.rows[0];
    const amounts = resolveAmountsFromAiSuggestions({
      session: calls[0].args.session,
      rows: calls[0].args.rows,
      adapted: calls[0].args.adapted as never,
      liveRows: calls[0].args.liveRows as never,
      state: calls[0].args.state as never,
      suggestions: [
        {
          line_ref: garlicRow.line_ref,
          interpreted_food_name: 'Garlic, raw',
          suggested_usda_queries: ['garlic raw'],
          quantity_value: 3,
          quantity_unit_hint: 'cloves',
          count_descriptor_hint: 'clove',
          portion_search_hint: 'clove',
        },
      ],
    });
    expect(amounts.resolved).toHaveLength(1);

    await act(async () => {
      calls[0].resolve({ ok: true, interpretedCount: 1, outcome: EMPTY_FOOD, amounts });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    const finalRow = rowElement('garlic');
    expect(
      (finalRow.querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()
    ).toBe('Needs amount');
    // No resolved mass and no AI-attached count portion on the user's food.
    const foodSummary = finalRow.querySelector('[data-testid="advanced-nutrition-food-summary"]');
    expect(foodSummary?.textContent ?? '').not.toMatch(/USDA count portion/i);
    expect(finalRow.textContent).not.toMatch(/AI-assisted USDA count portion/i);
    expect(screen.queryByTestId('advanced-nutrition-ai-amount-badge')).toBeNull();
    expect(messageText()).toMatch(/No additional ingredients could be resolved automatically/i);
  });
});

describe('mid-flight user authority — mixed bulk', () => {
  it('TEST 6: two untouched targeted rows both resolve and are both credited', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['3 cloves garlic, minced', '4 cloves garlic, chopped'])}
        session={session}
        onResolveWithAi={handler}
      />
    );
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].args.rows).toHaveLength(2);

    const amounts = resolveAmountsFromAiSuggestions({
      session: calls[0].args.session,
      rows: calls[0].args.rows,
      adapted: calls[0].args.adapted as never,
      liveRows: calls[0].args.liveRows as never,
      state: calls[0].args.state as never,
      suggestions: calls[0].args.rows.map((row, index) => ({
        line_ref: row.line_ref,
        interpreted_food_name: 'Garlic, raw',
        suggested_usda_queries: ['garlic raw'],
        quantity_value: index === 0 ? 3 : 4,
        quantity_unit_hint: 'cloves',
        count_descriptor_hint: 'clove',
        portion_search_hint: 'clove',
      })),
    });
    expect(amounts.resolved).toHaveLength(2);

    await act(async () => {
      calls[0].resolve({ ok: true, interpretedCount: 2, outcome: EMPTY_FOOD, amounts });
      await Promise.resolve();
    });
    await waitFor(() => expect(messageText()).toMatch(/2 resolved automatically from verified local data/i));

    const rows = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toMatch(/Matched/);
      expect(row.textContent).toMatch(/AI-assisted USDA count portion/i);
    }
    expect(screen.getByTestId('advanced-nutrition-live-summary').textContent).toMatch(/2 matched/);
  });

  it('TEST 3: conflicted row preserved, untouched row resolved, count credits ONLY the untouched row', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['1 cup berries', '3 cloves garlic, minced'])}
        session={session}
        onResolveWithAi={handler}
      />
    );
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].args.rows).toHaveLength(2);

    // MID-FLIGHT: the user resolves the berries row explicitly.
    expandRow('berries');
    fireEvent.click(foodRadioIn(rowElement('berries'), 5030));
    await waitFor(() => expect(rowElement('berries').textContent).toMatch(/Berries, dried/));

    const berriesRow = calls[0].args.rows.find((row) => /berries/.test(row.original_text)) as Phase4Row;
    const garlicRow = calls[0].args.rows.find((row) => /garlic/.test(row.original_text)) as Phase4Row;

    const food = autoFoodOutcome(berriesRow, 'Mystery, raw', 7002);
    const amounts = resolveAmountsFromAiSuggestions({
      session: calls[0].args.session,
      rows: calls[0].args.rows,
      adapted: calls[0].args.adapted as never,
      liveRows: calls[0].args.liveRows as never,
      state: calls[0].args.state as never,
      suggestions: [
        {
          line_ref: garlicRow.line_ref,
          interpreted_food_name: 'Garlic, raw',
          suggested_usda_queries: ['garlic raw'],
          quantity_value: 3,
          quantity_unit_hint: 'cloves',
          count_descriptor_hint: 'clove',
          portion_search_hint: 'clove',
        },
      ],
    });
    expect(amounts.resolved).toHaveLength(1);

    await act(async () => {
      calls[0].resolve({
        ok: true,
        interpretedCount: 2,
        outcome: food.outcome,
        amounts,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    // Row A: the user's edit survives; the AI food candidate for it is discarded.
    const berries = rowElement('berries');
    expect(berries.textContent).toMatch(/Berries, dried/);
    expect(berries.textContent).not.toMatch(/Mystery, raw/);
    expect(berries.textContent).not.toMatch(/AI-assisted USDA match/i);

    // Row B: the untouched row receives its authenticated AI count resolution.
    const garlic = rowElement('garlic');
    expect(garlic.textContent).toMatch(/Matched/);
    expect(garlic.textContent).toMatch(/9 g/);
    expect(garlic.textContent).toMatch(/AI-assisted USDA count portion/i);

    // Counts: exactly the untouched row is credited.
    expect(messageText()).toMatch(/1 resolved automatically from verified local data/i);
    expect(messageText()).toMatch(/1 still needs review/i);
    const summary = screen.getByTestId('advanced-nutrition-live-summary').textContent ?? '';
    expect(summary).toMatch(/1 matched/);
    expect(summary).toMatch(/1 need amount/);
  });
});

describe('explicit AI-suggestion click', () => {
  it('TEST 5: clicking "Use this match" produces a user-confirmed choice with no automatic marker', async () => {
    const calls: Array<{ args: HandlerArgs; resolve: (value: unknown) => void }> = [];
    const handler = vi.fn(
      (args: HandlerArgs) =>
        new Promise<any>((resolve) => {
          calls.push({ args, resolve });
          // The offered candidate is available immediately for this explicit-click test.
          resolve(offeredFoodOutcome(args.rows[0], 'Mystery, raw', 7002));
        })
    );
    render(
      <AdvancedNutritionCard
        recipe={recipe(['1 cup Zzz'])}
        session={session}
        onResolveWithAi={handler}
      />
    );
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    expandRow('Zzz');
    fireEvent.click(await screen.findByTestId('advanced-nutrition-ai-use'));
    await waitFor(() => {
      expect(rowElement('Zzz').textContent).toMatch(/Mystery, raw/);
      expect(rowElement('Zzz').textContent).toMatch(/AI-assisted · user-confirmed/i);
    });
    // Explicit user confirmation: never the automatic-acceptance label.
    expect(rowElement('Zzz').textContent).not.toMatch(/AI-assisted USDA match/i);
  });
});
