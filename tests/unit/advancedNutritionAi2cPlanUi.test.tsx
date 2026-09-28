// @vitest-environment jsdom
/**
 * The Kitchen Codex - AI-2C (Slice D): UI integration.
 *
 * Proves the plan action is EXPLICIT, its accepted results flow through the
 * existing working-state path, its offers are NEVER preselected, a mid-flight
 * user decision wins, no Apply side effect is reachable, and the reported
 * counts are honest.
 *
 * The fixture is a genuine two-record ambiguous family (identical descriptions),
 * whose deterministic review is `review_required` with a STRICT automatic pick
 * (2001) plus a same-family sibling (2002). That is exactly the shape the AI-2C
 * bridge distinguishes: an accept-eligible automatic and a best-effort-only
 * offer.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { selectAutomaticMatch } from '../../src/core/nutritionV2/matching/confidence';
import type { AdvancedNutritionSession, Phase4Row } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const SPECS = [
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

async function openAndAnalyze(): Promise<void> {
  fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
  await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
  await waitFor(() =>
    expect(document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length).toBeGreaterThan(0)
  );
  fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
  await waitFor(() => expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy());
}

const ROW = 'berries';

function rowElement(): HTMLElement {
  const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) =>
    (node.textContent ?? '').includes(ROW)
  );
  if (!row) throw new Error('missing row');
  return row as HTMLElement;
}

function expandEdit(): void {
  const button = rowElement().querySelector('[data-testid="advanced-nutrition-edit"]') as HTMLButtonElement;
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
}

function rowStatus(): string {
  return (rowElement().querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim();
}

function messageText(): string {
  return screen.getByTestId('advanced-nutrition-ai-message').textContent ?? '';
}

function foodRadios(): HTMLInputElement[] {
  return Array.from(rowElement().querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
}

function foodRadio(fdcId: number): HTMLInputElement {
  const radio = foodRadios().find((entry) => (entry.closest('label')?.textContent ?? '').includes(String(fdcId)));
  if (!radio) throw new Error(`missing food radio ${fdcId}`);
  return radio;
}

function checkedFoodLabel(): string {
  const checked = foodRadios().find((entry) => entry.checked);
  return checked ? (checked.closest('label')?.textContent ?? '') : '';
}

/**
 * The row's genuine review, read from the session. This fixture is a REAL
 * production exception: the deterministic analyzer surfaces it as
 * `review_suggested` because no candidate carries automatic authority under the
 * confidence contract, while both candidates stay confirmable.
 */
function candidateIds(): { readonly first: number; readonly second: number } {
  const review = session.reviewIngredient({ name: 'berries' }) as unknown as {
    readonly outcome: string;
    readonly candidates: ReadonlyArray<{ readonly fdc_id: number }>;
  };
  expect(review.outcome).toBe('review_required');
  const ids = review.candidates.map((candidate) => candidate.fdc_id);
  if (ids.length < 2) throw new Error('fixture needs two candidates');
  // No automatic authority exists for this review (that is WHY it is an exception).
  expect(selectAutomaticMatch(review as never)).toBeUndefined();
  return { first: ids[0], second: ids[1] };
}

/** Display text, deliberately distinct so assertions can tell the records apart. */
const LABEL: Record<number, string> = {
  5030: 'Berries, dried',
  5031: 'Berries, frozen',
};

function deferredPlanHandler() {
  const calls: Array<{ args: any; resolve: (value: unknown) => void }> = [];
  const handler = vi.fn(
    (args: any) =>
      new Promise<any>((resolve) => {
        calls.push({ args, resolve });
      })
  );
  return { handler, calls };
}

function confirmedSelection(
  lineRef: string,
  fdcId: number,
  reviewDigest: string,
  automatic: boolean
) {
  return {
    line_ref: lineRef,
    fdc_id: fdcId,
    choice: {
      kind: 'candidate' as const,
      fdc_id: fdcId,
      review_digest: reviewDigest,
      ...(automatic ? { automatic: true } : {}),
      aiAssisted: true,
      aiAccepted: true,
    },
  };
}

function offeredSelection(lineRef: string, fdcId: number, reviewDigest: string) {
  return {
    line_ref: lineRef,
    fdc_id: fdcId,
    description: LABEL[fdcId] ?? '',
    // OFFER shape: no acceptance marker, no automatic claim.
    choice: {
      kind: 'candidate' as const,
      fdc_id: fdcId,
      review_digest: reviewDigest,
      aiAssisted: true,
    },
  };
}

function outcome(overrides: Record<string, unknown>) {
  return {
    ok: true,
    accepted: [],
    offers: [],
    acceptedCount: 0,
    offerCount: 0,
    preservedCount: 0,
    conflictCount: 0,
    unchangedCount: 0,
    ...overrides,
  };
}

type CardProps = Parameters<typeof AdvancedNutritionCard>[0];

function card(handler: unknown, extra: Record<string, unknown> = {}) {
  const props = {
    recipe: recipe(['1 cup berries']),
    session,
    onResolveWithAi: vi.fn(),
    onPlanWithAi: handler,
    ...extra,
  } as unknown as CardProps;
  return <AdvancedNutritionCard {...props} />;
}

describe('AI-2C plan action (UI)', () => {
  it('TEST 1: the plan action does not exist unless a plan port is wired', async () => {
    render(<AdvancedNutritionCard recipe={recipe(['1 cup berries'])} session={session} onResolveWithAi={vi.fn()} />);
    await openAndAnalyze();
    expect(screen.queryByTestId('advanced-nutrition-ai-plan')).toBeNull();
  });

  it('TEST 2: one deliberate click invokes the port once and reports honest counts', async () => {
    const { handler, calls } = deferredPlanHandler();
    render(card(handler));
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-plan'));
    await waitFor(() => expect(calls.length).toBe(1));
    // Bounded, deterministic request identity (no clock, no randomness).
    expect(String(calls[0].args.requestId)).toMatch(/^plan-/);
    expect(String(calls[0].args.requestId).length).toBeLessThanOrEqual(120);
    // The mid-flight snapshot covers every row the card can see.
    expect(Object.keys(calls[0].args.capturedFingerprints).length).toBe(calls[0].args.state.rows.length);
    // While a plan is in flight the action is disabled: no retry/spend loop.
    await waitFor(() =>
      expect((screen.getByTestId('advanced-nutrition-ai-plan') as HTMLButtonElement).disabled).toBe(true)
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-plan'));
    expect(handler).toHaveBeenCalledTimes(1);
    await act(async () => {
      calls[0].resolve(outcome({ preservedCount: 1 }));
    });
    await waitFor(() => expect(messageText()).toContain('1 still need review'));
    expect(messageText()).toContain('0 accepted from verified local data');
  });

  it('TEST 3: an unverifiable automatic claim is REFUSED fail-closed', async () => {
    const { handler, calls } = deferredPlanHandler();
    render(card(handler));
    await openAndAnalyze();
    const before = rowStatus();
    const beforeText = rowElement().textContent ?? '';
    const ids = candidateIds();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-plan'));
    await waitFor(() => expect(calls.length).toBe(1));
    const row = calls[0].args.rows[0] as Phase4Row;
    // A smuggled automatic claim: this review grants NO automatic authority, so
    // the card's calculator must refuse it rather than apply a literal choice.
    await act(async () => {
      calls[0].resolve(
        outcome({
          accepted: [confirmedSelection(row.line_ref, ids.first, String(row.review_digest), true)],
          acceptedCount: 1,
        })
      );
    });
    await waitFor(() => expect(messageText()).toContain('Nothing was applied'));
    expect(rowStatus()).toBe(before);
    expect(rowElement().textContent).toBe(beforeText);
    expandEdit();
    expect(checkedFoodLabel()).toBe('');
  });

  it('TEST 4: a confirmed selection is applied through the existing working-state path', async () => {
    const { handler, calls } = deferredPlanHandler();
    render(card(handler));
    await openAndAnalyze();
    const before = rowStatus();
    const ids = candidateIds();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-plan'));
    await waitFor(() => expect(calls.length).toBe(1));
    const row = calls[0].args.rows[0] as Phase4Row;
    await act(async () => {
      calls[0].resolve(
        outcome({
          accepted: [confirmedSelection(row.line_ref, ids.first, String(row.review_digest), false)],
          acceptedCount: 1,
        })
      );
    });
    await waitFor(() => expect(rowStatus()).not.toBe(before));
    // The row now shows the confirmed record (the other candidate is gone).
    expect(rowElement().textContent).toContain(LABEL[ids.first]);
    expect(rowElement().textContent).not.toContain(LABEL[ids.second]);
    expect(messageText()).toContain('1 accepted from verified local data');
  });

  it('TEST 5: an offer is surfaced but NEVER preselected', async () => {
    const { handler, calls } = deferredPlanHandler();
    render(card(handler));
    await openAndAnalyze();
    const before = rowStatus();
    const beforeText = rowElement().textContent ?? '';
    const ids = candidateIds();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-plan'));
    await waitFor(() => expect(calls.length).toBe(1));
    const row = calls[0].args.rows[0] as Phase4Row;
    await act(async () => {
      calls[0].resolve(
        outcome({
          offers: [offeredSelection(row.line_ref, ids.second, String(row.review_digest))],
          offerCount: 1,
        })
      );
    });
    // NOT APPLIED: the row is byte-for-byte where it was, nothing is selected.
    await waitFor(() => expect(messageText()).toContain('1 offered for your review'));
    expect(rowStatus()).toBe(before);
    expect(rowElement().textContent).toBe(beforeText);
    expandEdit();
    expect(checkedFoodLabel()).toBe('');
    // Visible ONLY as a suggestion with an explicit confirmation button.
    await waitFor(() =>
      expect(screen.getByTestId('advanced-nutrition-ai-suggestion').textContent).toContain(LABEL[ids.second])
    );
    expect(checkedFoodLabel()).toBe('');
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-use'));
    await waitFor(() => expect(rowStatus()).not.toBe(before));
    expect(rowElement().textContent).toContain(LABEL[ids.second]);
  });

  it('TEST 6: a mid-flight user decision wins over the plan result', async () => {
    const { handler, calls } = deferredPlanHandler();
    render(card(handler));
    await openAndAnalyze();
    const ids = candidateIds();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-plan'));
    await waitFor(() => expect(calls.length).toBe(1));
    const row = calls[0].args.rows[0] as Phase4Row;
    // The user acts WHILE the plan is in flight.
    expandEdit();
    fireEvent.click(foodRadio(ids.second));
    await waitFor(() => expect(rowElement().textContent).toContain(LABEL[ids.second]));
    await act(async () => {
      calls[0].resolve(
        outcome({
          accepted: [confirmedSelection(row.line_ref, ids.first, String(row.review_digest), false)],
          acceptedCount: 1,
        })
      );
    });
    await waitFor(() => expect(messageText()).toContain('left untouched'));
    // The USER's newer decision stands and the refused result is not credited.
    expect(rowElement().textContent).toContain(LABEL[ids.second]);
    expect(rowElement().textContent).not.toContain(LABEL[ids.first]);
    expect(messageText()).toContain('0 accepted from verified local data');
  });

  it('TEST 7: the plan action never reaches Apply', async () => {
    const { handler, calls } = deferredPlanHandler();
    const applySpy = vi.fn();
    render(card(handler, { onApplyAdvancedNutrition: applySpy }));
    await openAndAnalyze();
    const before = rowStatus();
    const ids = candidateIds();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-plan'));
    await waitFor(() => expect(calls.length).toBe(1));
    const row = calls[0].args.rows[0] as Phase4Row;
    await act(async () => {
      calls[0].resolve(
        outcome({
          accepted: [confirmedSelection(row.line_ref, ids.first, String(row.review_digest), false)],
          acceptedCount: 1,
        })
      );
    });
    await waitFor(() => expect(rowStatus()).not.toBe(before));
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('TEST 8: a failing plan reports the failure and mutates nothing', async () => {
    const { handler, calls } = deferredPlanHandler();
    render(card(handler));
    await openAndAnalyze();
    const before = rowStatus();
    const beforeText = rowElement().textContent ?? '';
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-plan'));
    await waitFor(() => expect(calls.length).toBe(1));
    await act(async () => {
      calls[0].resolve({ ...outcome({}), ok: false, message: 'AI planning is unavailable.' });
    });
    await waitFor(() => expect(messageText()).toContain('AI planning is unavailable.'));
    expect(rowStatus()).toBe(before);
    expect(rowElement().textContent).toBe(beforeText);
    expandEdit();
    expect(checkedFoodLabel()).toBe('');
  });
});
