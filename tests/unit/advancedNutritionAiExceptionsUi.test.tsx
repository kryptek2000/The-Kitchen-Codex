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
import { useEffect, useState, type ComponentProps } from 'react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { ShisoEntryProvider, useShiso } from '../../src/application-ui/shisoEntryPoints';
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

/** Explicitly run the one AI-first workflow after the deterministic baseline. */
async function analyzeWithShiso(): Promise<void> {
  const button = (await screen.findByTestId(
    'advanced-nutrition-analyze-with-shiso'
  )) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

function StandingAuthorityHarness({
  target,
  apply,
  save,
}: {
  readonly target: ObsidianRecipe;
  readonly apply: ComponentProps<typeof AdvancedNutritionCard>['onApplyAdvancedNutrition'];
  readonly save: (grant: unknown) => Promise<{ ok: boolean; saved: boolean; message: string }>;
}) {
  const shiso = useShiso();
  const registerRecipeEditApplier = shiso.registerRecipeEditApplier;
  useEffect(() => registerRecipeEditApplier({
    applyEdits: async () => ({
      ok: false,
      applied: [],
      refused: [],
      summary: 'No recipe edit was requested.',
      working_unsaved: false,
      note: '',
    }),
    save: async (grant) => save(grant),
    discard: () => {},
  }), [registerRecipeEditApplier, save]);
  return (
    <AdvancedNutritionCard
      recipe={target}
      session={session}
      onApplyAdvancedNutrition={apply}
      nutritionAuthority={{
        enabled: true,
        available: true,
        recipeIdentity: 'Recipes/authority.md',
        vaultScope: 'disposable-vault',
        onChange: () => {},
      }}
      advancedNutritionAiAvailability={{
        available: false,
        reason: 'The selected AI connection is unavailable.',
        refreshing: false,
        canRetry: false,
        advancedEditingAccess: 'entitled',
      }}
    />
  );
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
    expect(summaryText()).toMatch(/0 match/);
    expect(summaryText()).toMatch(/1 amount/);
    expect(screen.getByTestId('advanced-nutrition-ai')).toBeTruthy();
    expect(screen.getByTestId('advanced-nutrition-ai-resolve')).toBeTruthy();
    expect((screen.getByTestId('advanced-nutrition-ai-resolve') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the bulk AI action for review_suggested with ZERO needs-match rows', async () => {
    const handler = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    render(<AdvancedNutritionCard recipe={recipe('1 cup berries')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();

    expect(rowStatusText()).toBe('Review suggested');
    expect(summaryText()).toMatch(/0 match/);
    expect(summaryText()).toMatch(/1 source review/);
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
    expect(summaryText()).toMatch(/1 source-backed/);
    expect(summaryText()).toMatch(/0 amount/);
    expect(screen.queryByTestId('advanced-nutrition-ai')).toBeNull();
  });

  it('offers row-level AI help on an actionable needs_amount row', async () => {
    const handler = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    render(<AdvancedNutritionCard recipe={recipe('3 garlic cloves, minced')} session={session} onResolveWithAi={handler} />);
    await openAndAnalyze();
    // Generate is deterministic only. No AI call has happened yet.
    expect(handler).not.toHaveBeenCalled();
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

describe('AI-first needs_review — UI', () => {
  it('shows the model explanation and opens the existing USDA search with a discovered query', async () => {
    const legacy = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    const handler = vi.fn(async (args: {
      rows: ReadonlyArray<Phase4Row>;
    }) => {
      const lineRef = args.rows[0].line_ref;
      return {
        ok: true,
        outcome: { candidates: [], unresolved: [lineRef], auto_count: 0 },
        amounts: EMPTY_AMOUNTS,
        aiFirstReviews: [
          {
            line_ref: lineRef,
            decision: 'needs_review' as const,
            justification: 'The recipe does not specify salted or unsalted tomato puree.',
            uncertainty: 'Salt level is ambiguous.',
            candidate_query: 'Mystery raw',
            candidate_count: 1,
          },
        ],
      };
    });
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup Zzz')}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={handler}
      />
    );
    await openAndAnalyze();
    await analyzeWithShiso();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByTestId('advanced-nutrition-edit'));

    const review = await screen.findByTestId('advanced-nutrition-ai-review');
    expect(review.textContent).toContain('AI needs your review');
    expect(review.textContent).toContain('salted or unsalted tomato puree');
    expect(review.textContent).toContain('Salt level is ambiguous');
    expect(review.textContent).toContain('Review 1 discovered USDA candidate');

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-review-search'));
    const input = (await screen.findByTestId('advanced-nutrition-search-input')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Mystery raw'));
    fireEvent.click(screen.getByTestId('advanced-nutrition-search-run'));
    fireEvent.click(await screen.findByTestId('advanced-nutrition-use-usda-7002'));
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="advanced-nutrition-row"]')?.textContent ?? ''
      ).toContain('Mystery, raw')
    );
  });

  it('discards a needs_review result that resolves after the recipe changed', async () => {
    const legacy = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    let resolveHandler!: (value: unknown) => void;
    const handler = vi.fn(
      (): Promise<any> =>
        new Promise((resolve) => {
          resolveHandler = resolve;
        })
    );
    const first = render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup Zzz', 'A')}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={handler}
      />
    );
    await openAndAnalyze();
    await analyzeWithShiso();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const oldLineRef = (handler.mock.calls[0] as unknown as [{ rows: ReadonlyArray<Phase4Row> }])[0].rows[0].line_ref;

    first.rerender(
      <AdvancedNutritionCard
        recipe={recipe('1 cup Qqq', 'B')}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={handler}
      />
    );
    await act(async () => {
      resolveHandler({
        ok: true,
        outcome: { candidates: [], unresolved: [oldLineRef], auto_count: 0 },
        amounts: EMPTY_AMOUNTS,
        aiFirstReviews: [
          {
            line_ref: oldLineRef,
            decision: 'needs_review',
            justification: 'Old recipe explanation.',
            uncertainty: 'Old recipe uncertainty.',
            candidate_query: 'Mystery raw',
            candidate_count: 1,
          },
        ],
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('advanced-nutrition-ai-review')).toBeNull();
    expect(document.body.textContent).not.toContain('Old recipe explanation');
  });

  it('offers external research for a no_match line and accepts it only on explicit Use', async () => {
    const legacy = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    let lineRef = '';
    const aiFirst = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => {
      lineRef = args.rows[0].line_ref;
      return {
        ok: true,
        outcome: { candidates: [], unresolved: [lineRef], auto_count: 0 },
        amounts: EMPTY_AMOUNTS,
        aiFirstReviews: [
          {
            line_ref: lineRef,
            decision: 'no_match' as const,
            justification: 'No local USDA record is a defensible match.',
            uncertainty: 'External product evidence may help.',
            candidate_count: 0,
          },
        ],
      };
    });
    const research = vi.fn(async () => ({
      ok: true,
      message: 'Researched 1 unresolved ingredient from 1 external source. Review the evidence before using it.',
      contributions: [
        {
          line_ref: lineRef,
          ingredient: '1 cup Zzz',
          quantity_basis: '100 g scaled from source per 100 g',
          weight_grams: 100,
          disposition: 'edible' as const,
          exclusion_role: 'none' as const,
          exclusion_assumption: '',
          classification: 'source_backed' as const,
          nutrients: { calories: { amount: 200, unit: 'kcal' as const }, protein: { amount: 5, unit: 'g' as const } },
          unknown_nutrients: ['fat' as const],
          assumptions: ['Label values scaled deterministically.'],
          confidence: 'medium' as const,
          sources: [{ title: 'Example label', url: 'https://example.com/label' }],
        },
      ],
      offers: [
        {
          line_ref: lineRef,
          ingredient: '1 cup Zzz',
          source_title: 'Example label',
          source_url: 'https://example.com/label',
          quantity_basis: '100 g scaled from source per 100 g',
          classification: 'source_backed' as const,
          nutrients: { calories: { amount: 200, unit: 'kcal' }, protein: { amount: 5, unit: 'g' } },
          limitations: ['Verify the exact product label.'],
        },
      ],
      skipped: [],
    }));
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup Zzz')}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={aiFirst}
        onResearchNutritionWithAi={research}
      />
    );
    await openAndAnalyze();
    await analyzeWithShiso();
    await waitFor(() => expect(aiFirst).toHaveBeenCalledTimes(1));
    fireEvent.click(
      await screen.findByTestId(`advanced-nutrition-ai-research-target-${lineRef}`)
    );
    fireEvent.click(await screen.findByTestId('advanced-nutrition-ai-research'));
    await waitFor(() => expect(research).toHaveBeenCalledTimes(1));
    expect((research.mock.calls[0] as unknown as [{ targets: ReadonlyArray<{ line_ref: string; ambiguity: string }> }])[0].targets[0]).toMatchObject({
      line_ref: lineRef,
      ambiguity: 'missing_information',
    });
    const offers = await screen.findByTestId('advanced-nutrition-ai-research-offers');
    expect(offers.textContent).toContain('External source-backed');
    expect(offers.textContent).toContain('Example label');
    expect(offers.textContent).toContain('calories: 200 kcal');
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-research-use'));
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-ai-research-message').textContent).toMatch(
        /Researched nutrition was added/i
      )
    );
  });

  it('offers research for a needs_match line even when no AI-first review explanation exists', async () => {
    const legacy = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    const research = vi.fn(async () => ({
      ok: false,
      code: 'unavailable',
      message: 'No reliable external nutrition evidence was found.',
      skipped: [],
    }));
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup Zzz')}
        session={session}
        onResolveWithAi={legacy}
        onResearchNutritionWithAi={research}
      />
    );
    await openAndAnalyze();
    expect(legacy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /1 cup Zzz/i }));
    fireEvent.click(await screen.findByTestId('advanced-nutrition-ai-research'));
    await waitFor(() => expect(research).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('advanced-nutrition-ai-research-message')).textContent).toContain(
      'No reliable external nutrition evidence'
    );
  });

  it('passes the needs_review marker to explicit Apply without changing the selection', async () => {
    const legacy = vi.fn(async () => ({ ok: true, outcome: EMPTY_FOOD, amounts: EMPTY_AMOUNTS }));
    const applyHandler = vi.fn(async () => ({ ok: true, message: 'Applied.' }));
    let lineRef = '';
    const handler = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => {
      lineRef = args.rows[0].line_ref;
      return {
        ok: true,
        outcome: { candidates: [], unresolved: [lineRef], auto_count: 0 },
        amounts: EMPTY_AMOUNTS,
        aiFirstReviews: [
          {
            line_ref: lineRef,
            decision: 'needs_review' as const,
            justification: 'Salt level is ambiguous.',
            uncertainty: 'The recipe does not specify salted or unsalted.',
            candidate_query: 'Mystery raw',
            candidate_count: 1,
          },
        ],
      };
    });
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup Zzz')}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={handler}
        onApplyAdvancedNutrition={applyHandler}
      />
    );
    await openAndAnalyze();
    await analyzeWithShiso();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: /^Apply to recipe$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirm Apply$/i }));
    await waitFor(() => expect(applyHandler).toHaveBeenCalledTimes(1));
    const args = (applyHandler.mock.calls[0] as unknown as [{ reviewReasons?: Record<string, string> }])[0];
    expect(args.reviewReasons).toEqual({ [lineRef]: 'needs_review' });
  });
});

describe('live status summary authority — UI', () => {
  it('summary follows an explicit user resolution immediately (no stale counters)', async () => {
    render(<AdvancedNutritionCard recipe={recipe('1 cup berries')} session={session} />);
    await openAndAnalyze();
    expect(summaryText()).toMatch(/0 source-backed/);
    expect(summaryText()).toMatch(/1 source review/);

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
    expect(summaryText()).toMatch(/1 source-backed/);
    expect(summaryText()).toMatch(/0 source review/);
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
    expect(summaryText()).toMatch(/1 amount/);

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-ai-message').textContent).toMatch(
        /1 resolved automatically from verified local data/i
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
    await waitFor(() => expect(summaryText()).toMatch(/1 source-backed/));
    expect(summaryText()).toMatch(/0 amount/);
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
    // Generate is deterministic only; this test isolates the explicit control's
    // synchronous re-entry guard.
    expect(handler).not.toHaveBeenCalled();
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

describe('Generate — deterministic first, AI only on explicit SHISO action', () => {
  const AVAILABLE = {
    available: true,
    reason: null,
    refreshing: false,
    canRetry: false,
    advancedEditingAccess: 'entitled',
  } as const;

  it('Generate performs the deterministic baseline with ZERO AI provider calls', async () => {
    const legacy = vi.fn(async () => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: EMPTY_AMOUNTS,
    }));
    const aiFirst = vi.fn(async () => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: EMPTY_AMOUNTS,
    }));
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries')}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={aiFirst}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await openAndAnalyze();
    expect(summaryText()).toMatch(/1 source review|0 source-backed/);
    expect(legacy).not.toHaveBeenCalled();
    expect(aiFirst).not.toHaveBeenCalled();
  });

  it('invokes the genuine AI-first whole-recipe port only after Analyze with SHISO', async () => {
    const legacy = vi.fn(async () => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: EMPTY_AMOUNTS,
    }));
    const aiFirst = vi.fn(async (_args: {
      readonly rows: ReadonlyArray<Phase4Row>;
      readonly adapted: ReadonlyArray<AdaptedIngredient>;
      readonly issueKinds: Record<string, string>;
      readonly recipe?: ObsidianRecipe;
      readonly orchestration?: 'generate';
    }) => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: EMPTY_AMOUNTS,
    }));
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries')}
        session={session}
        onResolveWithAi={legacy}
        onResolveWithAiFirst={aiFirst}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await openAndAnalyze();
    expect(aiFirst).not.toHaveBeenCalled();
    await analyzeWithShiso();
    await waitFor(() => expect(aiFirst).toHaveBeenCalledTimes(1));
    const args = aiFirst.mock.calls[0][0] as {
      rows: ReadonlyArray<Phase4Row>;
      adapted: ReadonlyArray<AdaptedIngredient>;
      issueKinds: Record<string, string>;
      recipe?: ObsidianRecipe;
      orchestration?: string;
    };
    expect(args.rows).toHaveLength(1);
    expect(args.rows[0].original_text).toBe('1 cup berries');
    expect(args.issueKinds[args.rows[0].line_ref]).toBe('review_suggested');
    expect(args.recipe).toBeDefined();
    expect(args.orchestration).toBe('generate');
  });

  it('runs an observable authenticated USDA-only fallback when AI is unavailable', async () => {
    const aiFirst = vi.fn();
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries')}
        session={session}
        onResolveWithAiFirst={aiFirst}
        advancedNutritionAiAvailability={{
          available: false,
          reason: 'The selected AI connection is unavailable.',
          refreshing: false,
          canRetry: true,
          advancedEditingAccess: 'entitled',
        }}
      />
    );
    await openAndAnalyze();
    const button = await screen.findByTestId('advanced-nutrition-analyze-with-shiso') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-shiso-status').textContent).toMatch(/completed the authenticated USDA-only analysis/i));
    expect(aiFirst).not.toHaveBeenCalled();
    expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy();
  });

  it('runs the authenticated USDA-only fallback through Apply and Save when standing authority is enabled', async () => {
    const apply = vi.fn(async () => ({ ok: true, mode: 'create' as const, message: 'Applied through the canonical review owner.' }));
    const save = vi.fn(async (_grant: unknown) => ({ ok: true, saved: true, message: 'Saved through the canonical Vault owner.' }));
    render(
      <ShisoEntryProvider>
        <StandingAuthorityHarness target={recipe('1 cup Mystery, raw', 'standing-authority')} apply={apply} save={save} />
      </ShisoEntryProvider>
    );
    await openAndAnalyze();
    fireEvent.click(await screen.findByTestId('advanced-nutrition-analyze-with-shiso'));
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-shiso-status').textContent).toMatch(/saved it to the active Vault/i));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      authorized: true,
      via: 'standing_nutrition',
      recipe_identity: 'Recipes/authority.md',
      vault_scope: 'disposable-vault',
      nutrition_applied: true,
    });
    expect(screen.getByTestId('advanced-nutrition-shiso-status').textContent).not.toMatch(/nothing was applied or saved/i);
  });

  it('announces the correct idle Analyze with SHISO policy for both authority states', async () => {
    const authority = (enabled: boolean) => ({
      enabled,
      available: true,
      recipeIdentity: 'Recipes/idle-wording.md',
      vaultScope: 'disposable-vault',
      onChange: () => {},
    });

    render(<AdvancedNutritionCard recipe={recipe('1 cup Mystery, raw', 'idle-off')} session={session} nutritionAuthority={authority(false)} />);
    await openAndAnalyze();
    expect(screen.getByTestId('advanced-nutrition-shiso-status').textContent).toContain(
      'Analysis creates a working review only. Apply and Vault saving are separate steps.'
    );

    cleanup();
    render(<AdvancedNutritionCard recipe={recipe('1 cup Mystery, raw', 'idle-on')} session={session} nutritionAuthority={authority(true)} />);
    await openAndAnalyze();
    expect(screen.getByTestId('advanced-nutrition-shiso-status').textContent).toContain(
      'SHISO will automatically apply and save eligible nutrition results. Unresolved ingredient choices or failed verification will prevent saving.'
    );
  });

  it('does not ask AI when the deterministic baseline already resolved every line', async () => {
    const handler = vi.fn(async () => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: EMPTY_AMOUNTS,
    }));
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup Mystery, raw')}
        session={session}
        onResolveWithAi={handler}
        onResolveWithAiFirst={handler}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await openAndAnalyze();
    expect(summaryText()).toMatch(/1 source-backed/);
    expect(summaryText()).toMatch(/0 need attention/);
    await analyzeWithShiso();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handler).not.toHaveBeenCalled();
    expect(screen.getByTestId('advanced-nutrition-generate-ai-status').textContent).toMatch(
      /resolved every ingredient|No AI interpretation was needed/i
    );
  });

  it('resolves the server-owned product tier once while access is unknown', () => {
    const resolve = vi.fn();
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries')}
        session={session}
        advancedNutritionAiAvailability={{
          available: false,
          reason: 'Checking AI availability…',
          refreshing: false,
          canRetry: false,
          advancedEditingAccess: 'unknown',
          onResolveAccess: resolve,
        }}
      />
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('Basic product access cannot mount the Advanced editing workspace', async () => {
    const handler = vi.fn(async () => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: EMPTY_AMOUNTS,
    }));
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries')}
        session={session}
        onResolveWithAi={handler}
        onResolveWithAiFirst={handler}
        advancedNutritionAiAvailability={{
          available: false,
          reason: 'AI Advanced Nutrition is not enabled for this deployment.',
          refreshing: false,
          canRetry: false,
          advancedEditingAccess: 'basic',
        }}
      />
    );
    expect(screen.getByTestId('advanced-nutrition-basic-locked').textContent).toMatch(
      /Basic Nutrition remains available/i
    );
    expect(screen.queryByTestId('advanced-nutrition-open')).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('Generate and explicit SHISO action — cold start, cancellation, feedback', () => {
  const AVAILABLE = {
    available: true,
    reason: null,
    refreshing: false,
    canRetry: false,
    advancedEditingAccess: 'entitled',
  } as const;

  function emptyHandler() {
    return vi.fn(async (_args: {
      readonly rows: ReadonlyArray<Phase4Row>;
      readonly orchestration?: 'generate';
    }) => ({
      ok: true,
      outcome: EMPTY_FOOD,
      amounts: EMPTY_AMOUNTS,
    }));
  }

  it('cold bundle initialization performs deterministic analysis with no AI, then one explicit SHISO call', async () => {
    const handler = emptyHandler();
    const load = vi.fn();
    const target = recipe('1 cup berries', 'cold-start');
    const first = render(
      <AdvancedNutritionCard
        recipe={target}
        session={null}
        onLoadBundle={load}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    expect(load).toHaveBeenCalledTimes(1);

    first.rerender(
      <AdvancedNutritionCard
        recipe={target}
        session={session}
        onLoadBundle={load}
        onResolveWithAi={handler}
        onResolveWithAiFirst={handler}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy());
    expect(handler).not.toHaveBeenCalled();

    await analyzeWithShiso();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const call = handler.mock.calls[0][0] as { orchestration?: string };
    expect(call.orchestration).toBe('generate');

    first.rerender(
      <AdvancedNutritionCard
        recipe={target}
        session={session}
        onLoadBundle={load}
        onResolveWithAi={handler}
        onResolveWithAiFirst={handler}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight explicit SHISO analysis when the editor closes', async () => {
    let resolveHandler!: (value: unknown) => void;
    const handler = vi.fn(
      (): Promise<any> =>
        new Promise((resolve) => {
          resolveHandler = resolve;
        })
    );
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries', 'close-explicit')}
        session={session}
        onResolveWithAi={handler}
        onResolveWithAiFirst={handler}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await openAndAnalyze();
    await analyzeWithShiso();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('advanced-nutrition-close-without-saving'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      resolveHandler({
        ok: true,
        outcome: EMPTY_FOOD,
        amounts: EMPTY_AMOUNTS,
        aiFirstReviews: [
          {
            line_ref: 'stale',
            decision: 'needs_review',
            justification: 'Late result must be discarded.',
            uncertainty: '',
            candidate_count: 0,
          },
        ],
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('advanced-nutrition-generate-ai-status')).toBeNull();
    expect(document.body.textContent).not.toContain('Late result must be discarded');
  });

  it.each([
    ['503 service failure', 'The selected AI could not complete nutrition interpretation.'],
    ['504 deadline failure', 'AI assistance failed or timed out. Deterministic partial nutrition remains available.'],
  ])('shows visible failure feedback for an explicit %s with no retry', async (_label, failureMessage) => {
    const handler = vi.fn(async () => ({
      ok: false,
      message: failureMessage,
      outcome: EMPTY_FOOD,
      amounts: EMPTY_AMOUNTS,
    }));
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries', 'failure')}
        session={session}
        onResolveWithAi={handler}
        onResolveWithAiFirst={handler}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await openAndAnalyze();
    expect(handler).not.toHaveBeenCalled();
    await analyzeWithShiso();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const feedback = await screen.findByTestId('advanced-nutrition-generate-ai-status');
    expect(feedback.getAttribute('role')).toBe('alert');
    expect(feedback.textContent).toMatch(failureMessage);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(summaryText()).toMatch(/1 source review/);
  });

  it('shows visible partial success feedback without hiding unresolved uncertainty', async () => {
    const handler = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => ({
      ok: true,
      interpretedCount: 1,
      outcome: {
        candidates: [],
        unresolved: [args.rows[0].line_ref],
        auto_count: 0,
      },
      amounts: EMPTY_AMOUNTS,
      withheld: [],
      contradicted: [],
      inadaptable: [],
    }));
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries', 'partial-success')}
        session={session}
        onResolveWithAi={handler}
        onResolveWithAiFirst={handler}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await openAndAnalyze();
    await analyzeWithShiso();
    const feedback = await screen.findByTestId('advanced-nutrition-generate-ai-status');
    await waitFor(() => expect(feedback.getAttribute('role')).toBe('status'));
    expect(feedback.textContent).toMatch(/some lines still need review|complete/i);
    expect(summaryText()).toMatch(/1 source review/);
  });
});

describe('AN-SEM-1 — semantic outcome classification in Generate feedback', () => {
  const AVAILABLE = {
    available: true,
    reason: null,
    refreshing: false,
    canRetry: false,
    advancedEditingAccess: 'entitled',
  } as const;

  function diagnosticHandler(diagnostics: {
    withheld?: ReadonlyArray<{ line_ref: string; reason: 'ambiguous' | 'alternatives' }>;
    contradicted?: ReadonlyArray<string>;
    inadaptable?: ReadonlyArray<string>;
    interpretedCount?: number;
    candidates?: number;
  }) {
    return vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => {
      const ref = args.rows[0].line_ref;
      return {
        ok: true,
        interpretedCount: diagnostics.interpretedCount ?? 0,
        outcome: {
          candidates:
            (diagnostics.candidates ?? 0) > 0
              ? [
                  {
                    line_ref: ref,
                    query: 'mystery raw',
                    fdc_id: 7002,
                    description: 'Mystery, raw',
                    record_digest: 'a'.repeat(64),
                    auto: false,
                    choice: {
                      kind: 'manual' as const,
                      fdc_id: 7002,
                      review_digest:
                        args.rows[0].review_digest ?? '',
                      record_digest: 'a'.repeat(64),
                      catalog_digest: session.metadata().catalog_digest,
                      description: 'Mystery, raw',
                      aiAssisted: true,
                    },
                  },
                ]
              : [],
          unresolved: diagnostics.candidates === 0 ? [ref] : [],
          auto_count: 0,
        },
        amounts: EMPTY_AMOUNTS,
        withheld: diagnostics.withheld ?? [],
        contradicted: diagnostics.contradicted ?? [],
        inadaptable: diagnostics.inadaptable ?? [],
      };
    });
  }

  async function generateWith(
    handler: ReturnType<typeof diagnosticHandler>,
    id: string
  ): Promise<HTMLElement> {
    render(
      <AdvancedNutritionCard
        recipe={recipe('1 cup berries', id)}
        session={session}
        onResolveWithAi={handler}
        onResolveWithAiFirst={handler}
        advancedNutritionAiAvailability={AVAILABLE}
      />
    );
    await openAndAnalyze();
    expect(handler).not.toHaveBeenCalled();
    await analyzeWithShiso();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    return screen.findByTestId('advanced-nutrition-generate-ai-status');
  }

  it('explains genuine ambiguity instead of reporting successful interpretation', async () => {
    const handler = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => ({
      ok: true,
      interpretedCount: 0,
      outcome: { candidates: [], unresolved: [args.rows[0].line_ref], auto_count: 0 },
      amounts: EMPTY_AMOUNTS,
      withheld: [{ line_ref: args.rows[0].line_ref, reason: 'ambiguous' as const }],
      contradicted: [],
      inadaptable: [],
    }));
    const feedback = await generateWith(handler as never, 'semantic-ambiguous');
    await waitFor(() => expect(feedback.textContent).toMatch(/insufficient interpretation/i));
    expect(feedback.textContent).toMatch(/withheld as ambiguous/i);
    expect(feedback.textContent).not.toMatch(/AI returned usable search wording/i);
  });

  it('explains explicit alternatives without choosing one', async () => {
    const handler = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => ({
      ok: true,
      interpretedCount: 0,
      outcome: { candidates: [], unresolved: [args.rows[0].line_ref], auto_count: 0 },
      amounts: EMPTY_AMOUNTS,
      withheld: [{ line_ref: args.rows[0].line_ref, reason: 'alternatives' as const }],
      contradicted: [],
      inadaptable: [],
    }));
    const feedback = await generateWith(handler as never, 'semantic-alternatives');
    await waitFor(() => expect(feedback.textContent).toMatch(/explicit alternative readings/i));
  });

  it('explains insufficient semantic information for an empty interpretation', async () => {
    // Use a row-ref-aware empty classification, matching the server bridge.
    const emptyHandler = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => ({
      ok: true,
      interpretedCount: 0,
      outcome: { candidates: [], unresolved: [args.rows[0].line_ref], auto_count: 0 },
      amounts: EMPTY_AMOUNTS,
      withheld: [],
      contradicted: [],
      inadaptable: [args.rows[0].line_ref],
    }));
    const feedback = await generateWith(emptyHandler as never, 'semantic-empty');
    await waitFor(() => expect(feedback.textContent).toMatch(/insufficient interpretation/i));
    expect(feedback.textContent).toMatch(/insufficient semantic information/i);
    expect(feedback.textContent).not.toMatch(/AI returned usable search wording/i);
  });

  it('explains a source-contradicted quantity without applying it', async () => {
    const contradictedHandler = vi.fn(async (args: { rows: ReadonlyArray<Phase4Row> }) => ({
      ok: true,
      interpretedCount: 0,
      outcome: { candidates: [], unresolved: [args.rows[0].line_ref], auto_count: 0 },
      amounts: EMPTY_AMOUNTS,
      withheld: [],
      contradicted: [args.rows[0].line_ref],
      inadaptable: [],
    }));
    const feedback = await generateWith(contradictedHandler as never, 'semantic-contradicted');
    await waitFor(() => expect(feedback.textContent).toMatch(/contradicted the authored quantity/i));
  });

  it('distinguishes usable AI wording that fails USDA validation', async () => {
    const handler = diagnosticHandler({ interpretedCount: 1, candidates: 0 });
    const feedback = await generateWith(handler, 'semantic-usda-fail');
    await waitFor(() => expect(feedback.textContent).toMatch(/some lines still need review/i));
    expect(feedback.textContent).toMatch(/no authenticated USDA candidate passed validation/i);
    expect(feedback.textContent).toMatch(/AI returned usable search wording for 1 ingredient/i);
  });
});
