// @vitest-environment jsdom
/**
 * The Kitchen Codex — recipe-bound AI lifecycle.
 *
 * Proves an AI request/intent created for Recipe A can NEVER surface or dispatch
 * into Recipe B, even when both recipes contain an identical ingredient at the
 * same index (and therefore an identical content-derived line_ref), and that a
 * pending Generate intent is recipe-bound.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { useState } from 'react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
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

function recipeNamed(id: string, line: string): ObsidianRecipe {
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

interface DeferredCall {
  rows: ReadonlyArray<{ line_ref: string; review_digest?: string }>;
  resolve: (value: any) => void;
}

function deferredHandler() {
  const calls: DeferredCall[] = [];
  const fn = vi.fn(
    (args: { rows: ReadonlyArray<{ line_ref: string; review_digest?: string }> }) =>
      new Promise<any>((resolve) => {
        calls.push({ rows: args.rows, resolve });
      })
  );
  return { fn, calls };
}

function aiOutcome(row: { line_ref: string; review_digest?: string }, auto: boolean) {
  return {
    ok: true,
    outcome: {
      candidates: [
        {
          line_ref: row.line_ref,
          query: 'mystery raw',
          fdc_id: 6002,
          description: 'Mystery, raw',
          record_digest: 'a'.repeat(64),
          auto,
          choice: {
            kind: 'manual' as const,
            fdc_id: 6002,
            review_digest: row.review_digest ?? '',
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
  };
}

/** A shell that can switch the working recipe while the card stays mounted. */
function Harness({ handler }: { handler: ReturnType<typeof deferredHandler>['fn'] }) {
  const [which, setWhich] = useState<'A' | 'B'>('A');
  const current = which === 'A' ? recipeNamed('A', '1 cup Zzz') : recipeNamed('B', '1 cup Zzz');
  return (
    <>
      <button data-testid="switch-recipe" onClick={() => setWhich((w) => (w === 'A' ? 'B' : 'A'))}>
        switch
      </button>
      <AdvancedNutritionCard recipe={current} session={session} onResolveWithAi={handler} />
    </>
  );
}

async function openEditorAndAnalyze(): Promise<void> {
  fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
  await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
  await waitFor(() => expect(document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByTestId('advanced-nutrition-ai-resolve')).toBeTruthy());
}

function rowText(): string {
  // jsdom does not implement innerText; textContent is the reliable projection.
  return (document.querySelector('[data-testid="advanced-nutrition-row"]') as HTMLElement | null)?.textContent ?? '';
}

describe('recipe-bound AI lifecycle', () => {
  it('precondition: two recipes with the same line collide on line_ref', () => {
    const a = adaptRecipe(recipeNamed('A', '1 cup Zzz'));
    const b = adaptRecipe(recipeNamed('B', '1 cup Zzz'));
    if (!a.ok || !b.ok) throw new Error('adapt failed');
    expect(a.recipe.adapted[0].line_ref).toBe(b.recipe.adapted[0].line_ref);
  });

  it('TEST 1/2 — an in-flight AI response from Recipe A never lands in Recipe B', async () => {
    const { fn, calls } = deferredHandler();
    render(<Harness handler={fn} />);
    await openEditorAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const aRow = calls[0].rows[0];

    // Switch to Recipe B (same line_ref!) before A's response returns.
    fireEvent.click(screen.getByTestId('switch-recipe'));

    await act(async () => {
      calls[0].resolve(aiOutcome(aRow, true));
      await Promise.resolve();
    });

    // B: no AI state, no dispatch, no badge.
    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
    expect(screen.queryByTestId('advanced-nutrition-ai')).toBeNull();
    await openEditorAndAnalyze();
    expect(rowText()).toMatch(/needs match/i);
    expect(rowText()).not.toMatch(/Mystery/);
    expect(rowText()).not.toMatch(/AI-assisted/i);
  });

  it('TEST 4 — switching back to Recipe A does not revive the old response', async () => {
    const { fn, calls } = deferredHandler();
    render(<Harness handler={fn} />);
    await openEditorAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const aRow = calls[0].rows[0];

    fireEvent.click(screen.getByTestId('switch-recipe')); // -> B
    fireEvent.click(screen.getByTestId('switch-recipe')); // -> A

    await act(async () => {
      calls[0].resolve(aiOutcome(aRow, true));
      await Promise.resolve();
    });

    // The old A lifecycle generation is invalid even though the recipeKey matches.
    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
    await openEditorAndAnalyze();
    expect(rowText()).toMatch(/needs match/i);
    expect(rowText()).not.toMatch(/Mystery/);
  });

  it('TEST 10 — a rapid double-click makes exactly ONE AI request', async () => {
    const { fn, calls } = deferredHandler();
    render(<Harness handler={fn} />);
    await openEditorAndAnalyze();
    const button = screen.getByTestId('advanced-nutrition-ai-resolve');
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      calls[0].resolve(aiOutcome(calls[0].rows[0], true));
      await Promise.resolve();
    });
  });

  it('TEST 8 — Re-analyze clears a stale offered AI suggestion', async () => {
    const { fn, calls } = deferredHandler();
    render(<Harness handler={fn} />);
    await openEditorAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {
      calls[0].resolve(aiOutcome(calls[0].rows[0], false));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('advanced-nutrition-edit'));
    await screen.findByTestId('advanced-nutrition-ai-suggestion');

    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    await waitFor(() => expect(screen.queryByTestId('advanced-nutrition-ai-suggestion')).toBeNull());
    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
  });

  it('TEST 9 — an explicit "Use this match" survives Re-analyze', async () => {
    const { fn, calls } = deferredHandler();
    render(<Harness handler={fn} />);
    await openEditorAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {
      calls[0].resolve(aiOutcome(calls[0].rows[0], false));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('advanced-nutrition-edit'));
    fireEvent.click(await screen.findByTestId('advanced-nutrition-ai-use'));
    await waitFor(() => expect(rowText()).toMatch(/Mystery, raw/));

    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    await waitFor(() => expect(rowText()).toMatch(/Mystery, raw/));
  });
});

describe('recipe-bound pending Generate intent', () => {
  function LoaderHarness({
    sessionValue,
    onLoad,
  }: {
    sessionValue: AdvancedNutritionSession | null;
    onLoad: () => void;
  }) {
    const [which, setWhich] = useState<'A' | 'B'>('A');
    const current = which === 'A' ? recipeNamed('A', '1 cup Zzz') : recipeNamed('B', '1 cup Zzz');
    return (
      <>
        <button data-testid="switch-recipe" onClick={() => setWhich((w) => (w === 'A' ? 'B' : 'A'))}>
          switch
        </button>
        <AdvancedNutritionCard recipe={current} session={sessionValue} onLoadBundle={onLoad} />
      </>
    );
  }

  it('TEST 5 — Generate on A then switch to B during the load: B does NOT auto-open/analyze', async () => {
    const onLoad = vi.fn();
    const { rerender } = render(<LoaderHarness sessionValue={null} onLoad={onLoad} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    expect(onLoad).toHaveBeenCalledTimes(1);
    // Switch to B mid-load.
    fireEvent.click(screen.getByTestId('switch-recipe'));
    // The bundle finishes loading for B.
    rerender(<LoaderHarness sessionValue={session} onLoad={onLoad} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // B's Generate remains available and nothing was auto-analyzed.
    expect(screen.getByTestId('advanced-nutrition-open').textContent).toMatch(/Generate Nutrition/i);
  });

  it('TEST 6 — Generate on A, stay on A: A opens and analyzes exactly once', async () => {
    const onLoad = vi.fn();
    const { rerender } = render(<LoaderHarness sessionValue={null} onLoad={onLoad} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    rerender(<LoaderHarness sessionValue={session} onLoad={onLoad} />);
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await waitFor(() => expect(document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-analysis-runs').textContent).toMatch(/run 1/i));
    expect(screen.getByTestId('advanced-nutrition-analysis-runs').textContent).not.toMatch(/run 2/i);
  });

  it('TEST 7 — rapid repeated Generate clicks do not duplicate the analysis', async () => {
    const onLoad = vi.fn();
    const { rerender } = render(<LoaderHarness sessionValue={null} onLoad={onLoad} />);
    const button = screen.getByTestId('advanced-nutrition-open');
    fireEvent.click(button);
    fireEvent.click(button);
    rerender(<LoaderHarness sessionValue={session} onLoad={onLoad} />);
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-analysis-runs').textContent).toMatch(/run 1/i));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('advanced-nutrition-analysis-runs').textContent).not.toMatch(/run 2/i);
  });
});
