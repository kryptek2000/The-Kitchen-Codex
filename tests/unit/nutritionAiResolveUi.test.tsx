// @vitest-environment jsdom
/**
 * The Kitchen Codex — AI-assisted USDA resolution UI.
 *
 * Proves the optional AI panel appears for unresolved rows, calls the injected
 * port, renders advisory suggestions, and lets the user apply one (which becomes
 * an ordinary manual selection with no mass authority).
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const SPECS = [{ fdcId: 6002, dataType: 'foundation' as const, description: 'Mystery, raw' }];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

afterEach(() => cleanup());

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipe(): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'AI UI Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: [structured('1 cup Zzz')] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

function fakeHandler(auto: boolean) {
  return vi.fn(async ({ rows }: { rows: ReadonlyArray<{ line_ref: string; review_digest?: string }> }) => ({
    ok: true,
    outcome: {
      candidates: [
        {
          line_ref: rows[0].line_ref,
          query: 'mystery raw',
          fdc_id: 6002,
          description: 'Mystery, raw',
          record_digest: 'a'.repeat(64),
          auto,
          choice: {
            kind: 'manual' as const,
            fdc_id: 6002,
            review_digest: rows[0].review_digest ?? '',
            record_digest: 'a'.repeat(64),
            catalog_digest: session.metadata().catalog_digest,
            description: 'Mystery, raw',
            aiAssisted: true,
            ...(auto ? { aiAccepted: true } : {}),
          },
        },
      ],
      unresolved: [],
      auto_count: auto ? 1 : 0,
    },
  }));
}

describe('AI-assisted resolution UI', () => {
  it('offers the AI panel only when the resolver port is injected', async () => {
    const { unmount } = render(<AdvancedNutritionCard recipe={recipe()} session={session} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    expect(screen.queryByTestId('advanced-nutrition-ai')).toBeNull();
    unmount();

    render(
      <AdvancedNutritionCard recipe={recipe()} session={session} onResolveWithAi={fakeHandler(false)} />
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    expect(screen.getByTestId('advanced-nutrition-ai')).toBeTruthy();
    expect(screen.getByTestId('advanced-nutrition-ai-resolve')).toBeTruthy();
  });

  it('resolves with AI, shows a suggestion, and applies it as a manual choice', async () => {
    const handler = fakeHandler(false);
    render(<AdvancedNutritionCard recipe={recipe()} session={session} onResolveWithAi={handler} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(
        /0 selected, 1 suggested/i
      );
    });

    // Expand the unresolved row and use the suggested match.
    fireEvent.click(screen.getByTestId('advanced-nutrition-edit'));
    const suggestion = await screen.findByTestId('advanced-nutrition-ai-suggestion');
    expect(suggestion.textContent).toMatch(/Mystery, raw/);
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-use'));

    await waitFor(() => {
      const row = document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement;
      expect(row.textContent).toMatch(/Mystery, raw/);
      // FOOD only: no mass is invented.
      expect(row.textContent).toMatch(/Needs amount/i);
      // An explicit "Use this match" is user-confirmed (not the automatic marker).
      expect(row.textContent).toMatch(/AI-assisted · user-confirmed/i);
      expect(row.textContent).not.toMatch(/AI-assisted USDA match/i);
    });
    // The suggestion is consumed once applied.
    expect(screen.queryByTestId('advanced-nutrition-ai-suggestion')).toBeNull();
  });

  it('auto-applies a deterministic candidate and reports the selection count', async () => {
    const handler = fakeHandler(true);
    render(<AdvancedNutritionCard recipe={recipe()} session={session} onResolveWithAi={handler} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => {
      expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(/1 selected/i);
    });
    const row = document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement;
    expect(row.textContent).toMatch(/Mystery, raw/);
    expect(row.textContent).toMatch(/Needs amount/i);
    // Deterministic acceptance by AI is marked as an AI-assisted USDA match,
    // never as a manual/user-selected choice.
    expect(row.textContent).toMatch(/AI-assisted USDA match/i);
    expect(row.textContent).not.toMatch(/user-selected from USDA search/i);

    // Re-analyze must NOT preserve an AI-assisted AUTOMATIC acceptance as a
    // reviewed decision: the deterministic pass cannot rediscover it here.
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    await waitFor(() => {
      const after = document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement;
      expect(after.textContent).toMatch(/Needs match/i);
      expect(after.textContent).not.toMatch(/Mystery, raw/);
    });
  });

  it('supports the row-level "Ask AI for help" action', async () => {
    const handler = fakeHandler(false);
    render(<AdvancedNutritionCard recipe={recipe()} session={session} onResolveWithAi={handler} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    fireEvent.click(screen.getByTestId('advanced-nutrition-edit'));
    fireEvent.click(await screen.findByTestId('advanced-nutrition-ai-help'));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const call = handler.mock.calls[0][0] as { rows: ReadonlyArray<unknown> };
    expect(call.rows).toHaveLength(1);
  });

  it('shows a bounded message when the resolver fails', async () => {
    const handler = vi.fn(async () => ({
      ok: false,
      message: 'AI assistance is unavailable. You can continue with USDA search manually.',
      outcome: { candidates: [], unresolved: [], auto_count: 0 },
    }));
    render(<AdvancedNutritionCard recipe={recipe()} session={session} onResolveWithAi={handler} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => {
      expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(
        /AI assistance is unavailable/i
      );
    });
  });
});
