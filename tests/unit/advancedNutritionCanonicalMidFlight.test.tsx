// @vitest-environment jsdom
/**
 * AI-1 — CANONICAL LIVE MID-FLIGHT USER AUTHORITY.
 *
 * The LIVE canonical semantic path runs through the REAL application pipeline
 * (`resolveUnresolvedRowsWithAi` with `liveCanonicalInterpretation`) and the REAL
 * Advanced Nutrition card, with only the HTTP hop replaced by a deferred
 * canonical-route double. While a canonical interpretation is in flight the user
 * may:
 *
 *   - enter manual grams;
 *   - change the food match;
 *   - choose a verified authenticated portion;
 *   - Clear a verified household portion;
 *   - close the editor;
 *   - change the recipe;
 *   - issue a NEWER AI request.
 *
 * In every case the returning canonical interpretation must NOT overwrite the
 * user's newer authority, and a stale request must never be credited. The
 * existing Phase 7 fingerprint/authority machinery is REUSED, never duplicated:
 * this suite drives it through the canonical route instead of the legacy one.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';
import type { AdvancedNutritionSession, AiResolutionIssueKind } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

vi.mock('../../src/application/aiSelection', () => ({
  buildAiSelectionRequestOptions: async () => ({}),
}));

import {
  NUTRITION_INTERPRET_ENDPOINT,
  resolveUnresolvedRowsWithAi,
} from '../../src/application/nutritionAiResolve';

/** Two mystery records (AI-selectable) + household-bound tomato/butter + garlic portions. */
const SPECS = [
  {
    fdcId: 8005,
    dataType: 'fndds' as const,
    description: 'Mystery, raw',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 240, sequence: 1 }],
  },
  {
    fdcId: 8006,
    dataType: 'fndds' as const,
    description: 'Mystery, cooked',
    proteinAmount: 2,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 200, sequence: 1 }],
  },
  {
    fdcId: 2709719,
    dataType: 'foundation' as const,
    description: 'Tomatoes, raw',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 180, sequence: 1 }],
  },
  {
    fdcId: 789828,
    dataType: 'foundation' as const,
    description: 'Butter, stick',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'tbsp', gram_weight: 14.2, sequence: 1 }],
  },
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
];

let session: AdvancedNutritionSession;
/** A second, DIFFERENT pinned session (authority replacement for the stale tests). */
let altSession: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS as never);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
  // A different catalog/authority: separate FDC ids for the same records.
  const alt = buildMatchingBundle(
    SPECS.map((spec) => ({ ...spec, fdcId: spec.fdcId + 100 })) as never
  );
  const altResult = createAdvancedNutritionSession(alt.manifest, alt.records);
  if (!altResult.ok) throw new Error('alt session failed');
  altSession = altResult.session;
});

afterEach(() => cleanup());

const AI_CAPABILITIES = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });

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

interface CanonicalCall {
  readonly path: string;
  readonly body: { readonly ingredients: ReadonlyArray<Record<string, unknown>> };
  readonly resolve: (response: unknown) => void;
}

/** Deferred canonical-route double: the POST stays pending until the test resolves it. */
function deferredCanonicalNetwork() {
  const calls: CanonicalCall[] = [];
  const network = {
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(
      (path: string, body: unknown) =>
        new Promise((resolve) => {
          calls.push({ path, body: body as CanonicalCall['body'], resolve });
        })
    ),
  } as unknown as NetworkAdapter;
  return { network, calls };
}

function interpretation(
  lineRef: string,
  name: string,
  phrases: ReadonlyArray<string>,
  amount: number
): Record<string, unknown> {
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: lineRef,
    semantic_food: { normalized_name: name, modifiers: [], preparation: [], state: [], qualifiers: [] },
    search_phrases: [...phrases],
    amount_semantics: { kind: 'exact', echoed_value: amount },
    unit_semantics: { family: 'volume', interpreted_unit: 'cup' },
    count_semantics: {},
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
    confidence: 'high',
  };
}

function canonicalResponse(interpretations: ReadonlyArray<Record<string, unknown>>): unknown {
  return {
    ok: true,
    status: 200,
    data: {
      ok: true,
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations,
    },
  };
}

/** The REAL live canonical handler; only HTTP is doubled. */
function canonicalHandler(network: NetworkAdapter) {
  return (args: {
    session: AdvancedNutritionSession;
    rows: never;
    adapted: never;
    issueKinds: Readonly<Record<string, AiResolutionIssueKind>>;
    liveRows: never;
    state: never;
  }) =>
    resolveUnresolvedRowsWithAi({
      network,
      session: args.session,
      rows: args.rows,
      adapted: args.adapted,
      issueKinds: args.issueKinds,
      liveRows: args.liveRows,
      state: args.state,
      capabilities: AI_CAPABILITIES,
      liveCanonicalInterpretation: true,
    });
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
  const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) =>
    (node.textContent ?? '').includes(text)
  );
  if (!row) throw new Error(`missing row: ${text}`);
  return row as HTMLElement;
}

function expandRow(text: string): void {
  const row = rowElement(text);
  const button = row.querySelector('[data-testid="advanced-nutrition-edit"]') as HTMLButtonElement | null;
  if (button && button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
}

function foodSummary(text: string): HTMLElement {
  const node = rowElement(text).querySelector('[data-testid="advanced-nutrition-food-summary"]');
  if (!node) throw new Error(`missing food summary: ${text}`);
  return node as HTMLElement;
}

function messageText(): string {
  return screen.getByTestId('advanced-nutrition-ai-message').textContent ?? '';
}

function foodRadioIn(row: HTMLElement, fdcId: number): HTMLInputElement {
  const radio = Array.from(row.querySelectorAll('input[type="radio"]')).find((entry) =>
    (entry.closest('label')?.textContent ?? '').includes(String(fdcId))
  );
  if (!radio) throw new Error(`missing food radio ${fdcId}`);
  return radio as HTMLInputElement;
}

describe('AI-1 canonical live mid-flight — user authority', () => {
  it('TEST 1: preserves MID-FLIGHT manual grams (stale canonical match is discarded)', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    render(<AdvancedNutritionCard recipe={recipe(['1 mystery'])} session={session} onResolveWithAi={canonicalHandler(network)} />);
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].path).toBe(NUTRITION_INTERPRET_ENDPOINT);
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    // MID-FLIGHT: the user enters an explicit total weight.
    expandRow('mystery');
    const input = await screen.findByLabelText('Total weight for this ingredient line');
    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /Use this weight/i }));
    await waitFor(() => expect(rowElement('mystery').textContent).toMatch(/250 г|250 g/));

    // The stale canonical interpretation would have auto-accepted a catalog food.
    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, 'Mystery, raw', ['mystery raw'], 1)]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    const row = rowElement('mystery');
    expect(row.textContent).toMatch(/250 g/);
    expect(row.textContent).not.toMatch(/AI-assisted USDA match/i);
    expect(messageText()).toMatch(/No additional ingredients could be resolved automatically/i);
  });

  it('TEST 2: preserves a MID-FLIGHT changed food match', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['1 mystery'])}
        session={session}
        onResolveWithAi={canonicalHandler(network)}
      />
    );
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    // MID-FLIGHT: the user confirms the deterministic candidate for this line.
    expandRow('mystery');
    const radio = rowElement('mystery').querySelector('input[type="radio"]') as HTMLInputElement;
    fireEvent.click(radio);
    await waitFor(() => expect(rowElement('mystery').textContent).toMatch(/Mystery,/));

    const pickedText = rowElement('mystery').textContent ?? '';
    const picked = /Mystery, cooked/.test(pickedText) ? 'Mystery, cooked' : 'Mystery, raw';
    const claimed = picked === 'Mystery, raw' ? 'Mystery, cooked' : 'Mystery, raw';

    // A stale canonical reading naming the OTHER catalog record must not replace
    // the user's newer explicit match.
    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, claimed, [claimed.toLowerCase()], 1)]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    const after = rowElement('mystery').textContent ?? '';
    expect(after).toMatch(new RegExp(picked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(after).not.toMatch(new RegExp(claimed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(after).not.toMatch(/AI-assisted USDA match/i);
    expect(messageText()).toMatch(/No additional ingredients could be resolved automatically/i);
  });

  it('TEST 3: preserves a MID-FLIGHT verified authenticated portion selection', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['3 cloves garlic, minced'])}
        session={session}
        onResolveWithAi={canonicalHandler(network)}
      />
    );
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    expandRow('garlic');
    const radios = Array.from(rowElement('garlic').querySelectorAll('input[type="radio"]'));
    const portion = radios.find((entry) => (entry.closest('label')?.textContent ?? '').includes('3 clove = 9 g'));
    if (!portion) throw new Error('missing authenticated count portion');
    fireEvent.click(portion);
    await waitFor(() =>
      expect(
        (rowElement('garlic').querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()
      ).toBe('Matched')
    );

    // The stale canonical interpretation proposes a DIFFERENT authenticated food.
    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, 'Mystery, raw', ['mystery raw'], 3)]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    const row = rowElement('garlic');
    expect(row.textContent).toMatch(/9 g/);
    expect(row.textContent).not.toMatch(/Mystery, raw/);
  });

  it('TEST 4: a MID-FLIGHT household Clear is never resurrected', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['2 large tomatoes', '1 mystery'])}
        session={session}
        onResolveWithAi={canonicalHandler(network)}
      />
    );
    await openAndAnalyze();
    const tomatoRow = () => rowElement('large tomatoes');
    expect(tomatoRow().textContent).toMatch(/364 g/);

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(
      calls[0].body.ingredients.find((row) => /mystery/i.test(String(row.original_text ?? row.original ?? '')))?.line_ref ??
        calls[0].body.ingredients[0].line_ref
    );

    expandRow('large tomatoes');
    const panel = tomatoRow().querySelector('[data-testid="advanced-nutrition-household-portion"]');
    if (!panel) throw new Error('missing household panel');
    fireEvent.click(within(panel as HTMLElement).getByText('Clear'));
    await waitFor(() =>
      expect(
        (tomatoRow().querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()
      ).toBe('Needs amount')
    );

    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, 'Mystery, raw', ['mystery raw'], 1)]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    expect(tomatoRow().textContent).not.toMatch(/364 g/);
    expect(tomatoRow().textContent).not.toMatch(/household portion/);
  });

  it('TEST 5: a response arriving after the editor CLOSED is discarded whole', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    render(<AdvancedNutritionCard recipe={recipe(['1 mystery'])} session={session} onResolveWithAi={canonicalHandler(network)} />);
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    fireEvent.click(screen.getByTestId('advanced-nutrition-close-without-saving'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Advanced Nutrition' })).toBeNull());

    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, 'Mystery, raw', ['mystery raw'], 2)]));
      await Promise.resolve();
    });

    // Reopening shows the deterministic state only: nothing was applied.
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length).toBeGreaterThan(0)
    );
    expect(rowElement('mystery').textContent).not.toMatch(/AI-assisted USDA match/i);
  });

  it('TEST 6: a response for a STALE RECIPE is not applied to the new recipe', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    const handler = canonicalHandler(network);
    const { rerender } = render(
      <AdvancedNutritionCard recipe={recipe(['1 mystery'])} session={session} onResolveWithAi={handler} />
    );
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    // MID-FLIGHT: the recipe changes under the request.
    rerender(<AdvancedNutritionCard recipe={recipe(['1 cup Zzz'], 'r2')} session={session} onResolveWithAi={handler} />);
    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, 'Mystery, raw', ['mystery raw'], 1)]));
      await Promise.resolve();
    });

    // The new recipe is analyzed deterministically; the stale response contributed nothing.
    const dialog = screen.queryByRole('dialog', { name: 'Advanced Nutrition' });
    if (!dialog) {
      fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
      await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    }
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    await waitFor(() => expect(rowElement('Zzz')).toBeTruthy());
    expect(rowElement('Zzz').textContent).not.toMatch(/AI-assisted USDA match/i);
  });

  it('TEST 7: canonical requests are SERIALIZED, and the current response is the one that stands', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    render(<AdvancedNutritionCard recipe={recipe(['1 mystery'])} session={session} onResolveWithAi={canonicalHandler(network)} />);
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    // The card serializes canonical requests: while one is in flight the resolve
    // control is disabled, so a NEWER request cannot be issued behind an older
    // one (the fingerprint/authority guard remains the only mid-flight gate, and
    // it is exercised by TEST 1–TEST 4).
    const button = screen.getByTestId('advanced-nutrition-ai-resolve') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(calls).toHaveLength(1);

    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, 'Mystery, raw', ['mystery raw'], 1)]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    // Once the request settles the control reopens for a genuinely newer request.
    await waitFor(() =>
      expect((screen.getByTestId('advanced-nutrition-ai-resolve') as HTMLButtonElement).disabled).toBe(false)
    );
  });

});

/**
 * AUDIT REPAIR — CARD-LEVEL STALE AUTO-APPLY COVERAGE.
 *
 * The three tests above (TEST 1–TEST 7) prove the guards through payloads whose
 * AI result is WITHHELD from resolution, so they cannot show that the card's
 * stale-response gates are what stop an AUTO-APPLICABLE result. These tests use a
 * genuinely auto-applicable canonical response (`needs_match` row, unambiguous
 * reading, exact pinned catalog identity, amount echo compatible with the source)
 * and prove:
 *
 *   - CONTROL (TEST 8): when nothing changed, the SAME response DOES auto-apply;
 *   - TEST 9: a MID-FLIGHT working-choice change beats the stale auto-apply
 *     (`conflictedRefs`);
 *   - TEST 10/11: a whole-request staleness condition beats it (`stillCurrent`).
 */

/** Auto-applicable scenario: an unmatched line whose reading is a pinned record. */
const AUTO_LINE = '2 cups Zzz';
const AUTO_CLAIM = 'Mystery, raw';
const RIVAL_RECORD = 'Mystery, cooked';

/** Drives the REAL manual USDA search on a row and selects one pinned record. */
async function driveManualUsdaSelection(rowText: string, fdcId: number): Promise<void> {
  expandRow(rowText);
  fireEvent.click(screen.getByTestId('advanced-nutrition-search-usda'));
  const input = await screen.findByTestId('advanced-nutrition-search-input');
  fireEvent.change(input, { target: { value: 'mystery' } });
  fireEvent.click(screen.getByTestId('advanced-nutrition-search-run'));
  const useButton = await screen.findByTestId(`advanced-nutrition-use-usda-${fdcId}`);
  fireEvent.click(useButton);
}

describe('AI-1 canonical live — AUTO-APPLICABLE stale responses (audit repair)', () => {
  it('CONTROL (TEST 8): an auto-applicable needs_match response DOES auto-resolve when nothing changed', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    const onApply = vi.fn();
    render(
      <AdvancedNutritionCard
        recipe={recipe([AUTO_LINE])}
        session={session}
        onResolveWithAi={canonicalHandler(network)}
        onApplyAdvancedNutrition={onApply}
      />
    );
    await openAndAnalyze();
    // The row really is an actionable needs_match row before the request.
    expect(
      (rowElement('Zzz').querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()
    ).toBe('Needs match');

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].path).toBe(NUTRITION_INTERPRET_ENDPOINT);
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, AUTO_CLAIM, ['mystery raw'], 2)]));
      await Promise.resolve();
    });

    // PROOF OF AUTO-APPLICABILITY: the deterministic pipeline accepted the
    // reading and the CARD applied it automatically.
    await waitFor(() => expect(rowElement('Zzz').textContent).toMatch(/Mystery, raw/));
    const row = rowElement('Zzz');
    expect(row.textContent).toMatch(/AI-assisted USDA match/i);
    expect(row.textContent).not.toMatch(/needs match/i);
    expect(messageText()).toMatch(/resolved automatically/i);
    // Advisory only: nothing was persisted by the AI pass.
    expect(onApply).not.toHaveBeenCalled();
  });

  it('TEST 9: a MID-FLIGHT changed food match beats a stale AUTO-APPLICABLE response', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    const onApply = vi.fn();
    render(
      <AdvancedNutritionCard
        recipe={recipe([AUTO_LINE])}
        session={session}
        onResolveWithAi={canonicalHandler(network)}
        onApplyAdvancedNutrition={onApply}
      />
    );
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    // MID-FLIGHT: the user selects a DIFFERENT pinned record for that row.
    await driveManualUsdaSelection('Zzz', 8006);
    await waitFor(() => expect(foodSummary('Zzz').textContent).toMatch(/Mystery, cooked/));
    expect(foodSummary('Zzz').textContent).toMatch(/user-selected from USDA search/i);

    // The stale response would auto-apply the OTHER record if it were current.
    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, AUTO_CLAIM, ['mystery raw'], 2)]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    // The row's AUTHORITATIVE food summary (not the search-results list) proves
    // the user's newer choice survived and the stale AI match was not applied.
    const summary = foodSummary('Zzz');
    expect(summary.textContent).toMatch(/Mystery, cooked/);
    expect(summary.textContent).toMatch(/user-selected from USDA search/i);
    expect(summary.textContent).not.toMatch(/Mystery, raw/);
    expect(summary.textContent).not.toMatch(/AI-assisted USDA match/i);
    // The card reports that NOTHING was applied automatically for this pass.
    expect(messageText()).toMatch(/no additional ingredients could be resolved automatically/i);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('TEST 10: a stale AUTO-APPLICABLE response for a PREVIOUS RECIPE is discarded whole', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    const handler = canonicalHandler(network);
    const onApply = vi.fn();
    const { rerender } = render(
      <AdvancedNutritionCard
        recipe={recipe([AUTO_LINE])}
        session={session}
        onResolveWithAi={handler}
        onApplyAdvancedNutrition={onApply}
      />
    );
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    // MID-FLIGHT: the recipe identity changes (recipe key + content).
    rerender(
      <AdvancedNutritionCard
        recipe={recipe(['1 cup Zzz'], 'r2')}
        session={session}
        onResolveWithAi={handler}
        onApplyAdvancedNutrition={onApply}
      />
    );
    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, AUTO_CLAIM, ['mystery raw'], 2)]));
      await Promise.resolve();
    });

    // The stale response is discarded WHOLE: no AI message, no applied match.
    if (!screen.queryByRole('dialog', { name: 'Advanced Nutrition' })) {
      fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
      await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    }
    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
    const row = rowElement('Zzz');
    expect(row.textContent).not.toMatch(/AI-assisted USDA match/i);
    expect(row.textContent).not.toMatch(/Mystery, raw/);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('TEST 11: a SESSION-AUTHORITY change discards a stale AUTO-APPLICABLE response', async () => {
    const { network, calls } = deferredCanonicalNetwork();
    const handler = canonicalHandler(network);
    const onApply = vi.fn();
    const { rerender } = render(
      <AdvancedNutritionCard
        recipe={recipe([AUTO_LINE])}
        session={session}
        onResolveWithAi={handler}
        onApplyAdvancedNutrition={onApply}
      />
    );
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const lineRef = String(calls[0].body.ingredients[0].line_ref);

    // MID-FLIGHT: the pinned session authority is replaced with another session.
    rerender(
      <AdvancedNutritionCard
        recipe={recipe([AUTO_LINE])}
        session={altSession}
        onResolveWithAi={handler}
        onApplyAdvancedNutrition={onApply}
      />
    );
    await act(async () => {
      calls[0].resolve(canonicalResponse([interpretation(lineRef, AUTO_CLAIM, ['mystery raw'], 2)]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy());

    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
    const row = rowElement('Zzz');
    expect(row.textContent).not.toMatch(/AI-assisted USDA match/i);
    expect(row.textContent).not.toMatch(/Mystery, raw/);
    expect(onApply).not.toHaveBeenCalled();
  });
});