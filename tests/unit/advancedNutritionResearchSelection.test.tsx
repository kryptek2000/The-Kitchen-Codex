// @vitest-environment jsdom
/**
 * AN-LIVE-R1 — explicit ingredient selection for external nutrition research.
 *
 * Proves the request contains EXACTLY the user's checked refs (never recipe
 * order), that three is the maximum, that identity-ambiguous lines stay
 * ineligible with a visible explanation, and that closing the editor aborts and
 * discards a late research result.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type {
  AdvancedNutritionSession,
  AiAmountResolveOutcome,
  AiResolveOutcome,
  Phase4Row,
} from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle([
    {
      fdcId: 9801,
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
    id: 'research-selection-recipe',
    fileName: 'research-selection-recipe.md',
    filePath: 'Recipes/research-selection-recipe.md',
    rawMarkdown: '',
    title: 'Research Selection Recipe',
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

const LINES = [
  '2 tbsp gochujang',
  '1 cup broccoli',
  '1 cup snap peas',
  '1 cup mushrooms',
  '1 tbsp gochujang (Korean chili paste)',
  '1 tbsp soy sauce',
];

/**
 * AI-first returns `no_match` for every line except the last one, which is
 * deliberately ambiguous and must never become a research checkbox.
 */
function aiFirstFor(rowRefs: ReadonlyArray<string>, ambiguousRef: string) {
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
      decision: lineRef === ambiguousRef ? ('needs_review' as const) : ('no_match' as const),
      justification:
        lineRef === ambiguousRef
          ? 'Salted versus unsalted gochujang is a genuine product ambiguity.'
          : 'No local USDA record is defensible.',
      uncertainty:
        lineRef === ambiguousRef ? 'The product identity is not specific enough.' : '',
      candidate_count: lineRef === ambiguousRef ? 1 : 0,
    })),
  };
}

function researchButton(): HTMLButtonElement {
  return screen.getByTestId('advanced-nutrition-ai-research') as HTMLButtonElement;
}

function selectedCountText(): string {
  return screen.getByTestId('advanced-nutrition-ai-research-count').textContent ?? '';
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

async function analyzeWithShiso(): Promise<void> {
  const button = await screen.findByTestId('advanced-nutrition-analyze-with-shiso');
  fireEvent.click(button);
}

describe('AN-LIVE-R1 — research ingredient selection', () => {
  it('sends exactly the checked refs and explains an ambiguous ineligible line', async () => {
    let rowRefs: ReadonlyArray<string> = [];
    let ambiguousRef = '';
    const aiFirst = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => {
      rowRefs = args.rows.map((row) => row.line_ref);
      ambiguousRef = rowRefs[4];
      return aiFirstFor(rowRefs, ambiguousRef);
    });
    const legacy = vi.fn(async () => ({
      ok: true as const,
      outcome: { candidates: [], unresolved: [], auto_count: 0 } satisfies AiResolveOutcome,
      amounts: EMPTY_AMOUNTS,
    }));
    const research = vi.fn(async () => ({
      ok: false as const,
      code: 'unavailable',
      message: 'No reliable external nutrition evidence was found.',
      skipped: [],
    }));

    render(
      <AdvancedNutritionCard
        recipe={recipe(LINES)}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={aiFirst}
        onResearchNutritionWithAi={research}
      />
    );
    await openAndAnalyze();
    expect(aiFirst).not.toHaveBeenCalled();
    await analyzeWithShiso();
    await waitFor(() => expect(aiFirst).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(researchButton()).toBeTruthy());

    // Research is NEVER automatic, even when eligible rows exist.
    expect(research).not.toHaveBeenCalled();
    expect(selectedCountText()).toContain('0 of 3 selected');
    expect(researchButton().disabled).toBe(true);

    // The ambiguous line is visible as an explanation, not as a checkbox.
    expect(screen.queryByTestId(`advanced-nutrition-ai-research-target-${ambiguousRef}`)).toBeNull();
    const ineligible = screen.getByTestId('advanced-nutrition-ai-research-ineligible');
    expect(ineligible.textContent).toContain('gochujang (Korean chili paste)');
    expect(ineligible.textContent).toMatch(/identity needs clarification/i);
    expect(ineligible.textContent).toMatch(/salted\/unsalted/i);

    // Select only two lines; the third eligible line stays unselected.
    const first = rowRefs[0];
    const second = rowRefs[1];
    const unselected = rowRefs[2];
    fireEvent.click(screen.getByTestId(`advanced-nutrition-ai-research-target-${first}`));
    fireEvent.click(screen.getByTestId(`advanced-nutrition-ai-research-target-${second}`));
    expect(selectedCountText()).toContain('2 of 3 selected');
    expect(researchButton().disabled).toBe(false);

    fireEvent.click(researchButton());
    await waitFor(() => expect(research).toHaveBeenCalledTimes(1));

    const args = research.mock.calls[0] as unknown as [
      { targets: ReadonlyArray<{ line_ref: string; ambiguity: string }>; lineRefs: ReadonlyArray<string> }
    ];
    expect(args[0].targets.map((target) => target.line_ref)).toEqual([first, second]);
    expect(args[0].lineRefs).toEqual([first, second]);
    expect(args[0].lineRefs).not.toContain(unselected);
    expect(args[0].lineRefs).not.toContain(ambiguousRef);
    expect(args[0].targets.every((target) => target.ambiguity === 'missing_information')).toBe(true);
  });

  it('lets the owner research only gochujang without the vegetable lines', async () => {
    let rowRefs: ReadonlyArray<string> = [];
    const aiFirst = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => {
      rowRefs = args.rows.map((row) => row.line_ref);
      return aiFirstFor(rowRefs, rowRefs[4]);
    });
    const legacy = vi.fn(async () => ({
      ok: true as const,
      outcome: { candidates: [], unresolved: [], auto_count: 0 } satisfies AiResolveOutcome,
      amounts: EMPTY_AMOUNTS,
    }));
    const research = vi.fn(async () => ({
      ok: false as const,
      code: 'unavailable',
      message: 'No reliable external nutrition evidence was found.',
      skipped: [],
    }));

    render(
      <AdvancedNutritionCard
        recipe={recipe(LINES)}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={aiFirst}
        onResearchNutritionWithAi={research}
      />
    );
    await openAndAnalyze();
    expect(aiFirst).not.toHaveBeenCalled();
    await analyzeWithShiso();
    await waitFor(() => expect(aiFirst).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(researchButton()).toBeTruthy());

    const gochujangRef = rowRefs[0];
    fireEvent.click(
      screen.getByTestId(`advanced-nutrition-ai-research-target-${gochujangRef}`)
    );
    expect(selectedCountText()).toContain('1 of 3 selected');
    fireEvent.click(researchButton());
    await waitFor(() => expect(research).toHaveBeenCalledTimes(1));

    const args = research.mock.calls[0] as unknown as [
      { targets: ReadonlyArray<{ line_ref: string; ingredient_text: string }>; lineRefs: ReadonlyArray<string> }
    ];
    expect(args[0].targets).toHaveLength(1);
    expect(args[0].targets[0]).toMatchObject({
      line_ref: gochujangRef,
      ingredient_text: '2 tbsp gochujang',
    });
    expect(args[0].lineRefs).toEqual([gochujangRef]);
    for (const excluded of rowRefs.slice(1, 4)) expect(args[0].lineRefs).not.toContain(excluded);
  });

  it('enforces the three-target maximum in the UI', async () => {
    let rowRefs: ReadonlyArray<string> = [];
    const aiFirst = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => {
      rowRefs = args.rows.map((row) => row.line_ref);
      return aiFirstFor(rowRefs, rowRefs[rowRefs.length - 1]);
    });
    const legacy = vi.fn(async () => ({
      ok: true as const,
      outcome: { candidates: [], unresolved: [], auto_count: 0 } satisfies AiResolveOutcome,
      amounts: EMPTY_AMOUNTS,
    }));
    const research = vi.fn(async () => ({
      ok: false as const,
      code: 'unavailable',
      message: 'No reliable external nutrition evidence was found.',
      skipped: [],
    }));

    render(
      <AdvancedNutritionCard
        recipe={recipe(LINES)}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={aiFirst}
        onResearchNutritionWithAi={research}
      />
    );
    await openAndAnalyze();
    expect(aiFirst).not.toHaveBeenCalled();
    await analyzeWithShiso();
    await waitFor(() => expect(aiFirst).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(researchButton()).toBeTruthy());

    for (const lineRef of rowRefs.slice(0, 3)) {
      fireEvent.click(screen.getByTestId(`advanced-nutrition-ai-research-target-${lineRef}`));
    }
    expect(selectedCountText()).toContain('3 of 3 selected');

    const fourth = screen.getByTestId(
      `advanced-nutrition-ai-research-target-${rowRefs[3]}`
    ) as HTMLInputElement;
    expect(fourth.disabled).toBe(true);
    fireEvent.click(fourth);
    expect(selectedCountText()).toContain('3 of 3 selected');

    fireEvent.click(researchButton());
    await waitFor(() => expect(research).toHaveBeenCalledTimes(1));
    const args = research.mock.calls[0] as unknown as [
      { targets: ReadonlyArray<{ line_ref: string }> }
    ];
    expect(args[0].targets).toHaveLength(3);
    expect(args[0].targets.map((target) => target.line_ref)).toEqual(rowRefs.slice(0, 3));
  });

  it('aborts an in-flight request on close and discards its late result', async () => {
    let rowRefs: ReadonlyArray<string> = [];
    let resolveResearch: ((value: unknown) => void) | null = null;
    let requestSignal: AbortSignal | undefined;
    const aiFirst = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => {
      rowRefs = args.rows.map((row) => row.line_ref);
      return aiFirstFor(rowRefs, rowRefs[rowRefs.length - 1]);
    });
    const legacy = vi.fn(async () => ({
      ok: true as const,
      outcome: { candidates: [], unresolved: [], auto_count: 0 } satisfies AiResolveOutcome,
      amounts: EMPTY_AMOUNTS,
    }));
    const research = vi.fn(
      (args: { signal?: AbortSignal }) =>
        new Promise<{
          ok: true;
          message: string;
          contributions: [];
          offers: Array<{
            line_ref: string;
            ingredient: string;
            source_title: string;
            source_url: string;
            quantity_basis: string;
            classification: 'source_backed';
            nutrients: Record<string, { amount: number; unit: string }>;
            limitations: string[];
          }>;
          skipped: [];
        }>((resolve) => {
          requestSignal = args.signal;
          resolveResearch = resolve;
        })
    );

    render(
      <AdvancedNutritionCard
        recipe={recipe(LINES)}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={aiFirst}
        onResearchNutritionWithAi={research}
      />
    );
    await openAndAnalyze();
    expect(aiFirst).not.toHaveBeenCalled();
    await analyzeWithShiso();
    await waitFor(() => expect(aiFirst).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(researchButton()).toBeTruthy());

    fireEvent.click(
      screen.getByTestId(`advanced-nutrition-ai-research-target-${rowRefs[0]}`)
    );
    fireEvent.click(researchButton());
    await waitFor(() => expect(research).toHaveBeenCalledTimes(1));
    expect(requestSignal?.aborted).toBe(false);

    fireEvent.click(screen.getByLabelText('Close Advanced Nutrition'));
    await waitFor(() => expect(requestSignal?.aborted).toBe(true));

    // A late provider result must not resurrect offers or messages.
    await act(async () => {
      resolveResearch?.({
        ok: true,
        message: 'Late result that must be discarded.',
        contributions: [],
        offers: [
          {
            line_ref: rowRefs[0],
            ingredient: '2 tbsp gochujang',
            source_title: 'Late source',
            source_url: 'https://example.com/late',
            quantity_basis: '100 g scaled from source per 100 g',
            classification: 'source_backed',
            nutrients: { calories: { amount: 100, unit: 'kcal' } },
            limitations: [],
          },
        ],
        skipped: [],
      });
      await Promise.resolve();
    });

    expect(screen.queryByTestId('advanced-nutrition-ai-research-offers')).toBeNull();
    expect(document.body.textContent).not.toContain('Late source');
  });
});
