// @vitest-environment jsdom
/**
 * The Kitchen Codex — Phase 7 AI household alignment: MID-FLIGHT USER AUTHORITY.
 *
 * An AI household request can be in flight while the user edits a targeted row.
 * The user's newer explicit decision (a total weight) is FINAL: the stale AI
 * household resolution must never overwrite it, while untouched rows in the
 * SAME response still receive their verified household result. A response that
 * arrives after the editor closed is discarded whole.
 *
 * The session is a SYNTHETIC fixture catalog whose FDC ids are bound by the REAL
 * verified household registry; the registry record, selection digest, and
 * calculator verification are the genuine Phase 6/7 paths.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { resolveHouseholdsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiHouseholdResolve';
import { buildHouseholdPortionChoice } from '../../src/core/nutritionV2/phase4/householdPortion';
import {
  conflictedWorkingLineRefs,
  mergeAiHouseholdPortions,
  workingChoiceFingerprint,
} from '../../src/core/nutritionV2/phase4/aiMidFlight';
import {
  buildCalculationRequest,
  ingredientEvidenceViews,
  phase4Reducer,
  projectLiveRows,
  summarizeLiveRows,
} from '../../src/core/nutritionV2/phase4';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  AiAmountResolveOutcome,
  AiHouseholdResolveOutcome,
  AiResolveOutcome,
  HouseholdPortionChoice,
  LiveRowState,
  Phase4Row,
  Phase4State,
} from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

/** FDC ids bound by the REAL verified household registry (tomato medium/butter stick). */
const SPECS = [
  {
    fdcId: 2709719,
    dataType: 'foundation' as const,
    description: 'Tomatoes, raw',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 180, sequence: 1 }],
  },
  {
    fdcId: 789828,
    dataType: 'sr_legacy' as const,
    description: 'Butter, stick, unsalted',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'stick', gram_weight: 113, sequence: 1 }],
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

function recipe(lines: ReadonlyArray<string>, id = 'r7'): ObsidianRecipe {
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
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly liveRows: ReadonlyArray<LiveRowState>;
  readonly state: Phase4State;
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

/** Runs the genuine Phase 7 household resolver for the captured handler args. */
function householdOutcome(
  call: DeferredCall,
  hints: ReadonlyArray<{
    line_ref: string;
    household_unit_hint?: string;
    household_size_hint?: string;
  }>
): AiHouseholdResolveOutcome {
  const suggestions = hints.map((hint) => ({
    line_ref: hint.line_ref,
    interpreted_food_name: 'probe',
    suggested_usda_queries: [] as ReadonlyArray<string>,
    ...hint,
  }));
  return resolveHouseholdsFromAiSuggestions({
    session: call.args.session,
    rows: call.args.rows,
    adapted: call.args.adapted,
    liveRows: call.args.liveRows,
    state: call.args.state,
    suggestions,
  });
}

/**
 * Builds ONE genuine verified household choice for a line from the CAPTURED
 * request snapshot, through the REAL Phase 6 builder + registry. Used to model a
 * response that carries a verified household resolution for a line the ordinary
 * resolver would not target (the card must still protect the user's newer
 * working decision at the merge boundary).
 */
function verifiedChoice(
  call: DeferredCall,
  lineRef: string,
  hint: { unit?: string | null; size?: string | null; state?: string | null }
): HouseholdPortionChoice {
  const row = call.args.state.rows.find((entry) => entry.line_ref === lineRef);
  const entry = call.args.adapted.find((candidate) => candidate.line_ref === lineRef);
  const live = call.args.liveRows.find((candidate) => candidate.line_ref === lineRef);
  if (!row || !entry || !live || live.selected_fdc_id === undefined) {
    throw new Error(`cannot build household choice for ${lineRef}`);
  }
  const match = call.args.state.matches[lineRef];
  const built = buildHouseholdPortionChoice(call.args.session, {
    lineRef,
    ingredient: entry.ingredient,
    ...(row.outcome === 'review_required' ? { review: row.review } : {}),
    ...(match !== undefined
      ? { selection: selectionInputFor(match, lineRef) }
      : {}),
    ...(match?.automatic === true ? { automaticSelection: true } : {}),
    fdcId: live.selected_fdc_id,
    householdRequirementHint: {
      unit: hint.unit ?? null,
      size: hint.size ?? null,
      state: hint.state ?? null,
    },
  });
  if (!built.ok) {
    throw new Error(`verified household build failed for ${lineRef}`);
  }
  return built.choice;
}

/** The explicit Phase 3 selection object for one captured match choice. */
function selectionInputFor(
  choice: NonNullable<Phase4State['matches'][string]>,
  lineRef: string
): unknown {
  if (choice.kind === 'candidate') {
    return { kind: 'candidate', fdc_id: choice.fdc_id, review_digest: choice.review_digest };
  }
  if (choice.kind === 'manual') {
    return {
      kind: 'manual',
      fdc_id: choice.fdc_id,
      record_digest: choice.record_digest,
      catalog_digest: choice.catalog_digest,
      line_ref: lineRef,
      review_digest: choice.review_digest,
      ...(choice.aiAccepted === true ? { ai_assisted: true } : {}),
    };
  }
  return { kind: 'none', review_digest: choice.review_digest };
}

/** Wraps one verified choice as the AI port's household outcome entry. */
function householdEntry(lineRef: string, choice: HouseholdPortionChoice) {
  return Object.freeze({
    line_ref: lineRef,
    fdc_id: choice.fdc_id,
    record_key: choice.record_key,
    authority_class: choice.authority_class,
    resolved_grams: choice.resolved_grams,
    choice,
  });
}

/**
 * An AI-shaped verified household resolution: the genuine builder output plus
 * the resolver's `aiAssisted` display marker and canonical bounded hint. Used
 * to model a response that carries a verified household resolution for a line
 * the ordinary resolver would not target.
 */
function aiHouseholdEntry(
  call: DeferredCall,
  lineRef: string,
  hint: { unit?: string | null; size?: string | null; state?: string | null }
) {
  const choice = verifiedChoice(call, lineRef, hint);
  const aiChoice = Object.freeze({
    ...choice,
    aiAssisted: true,
    householdRequirementHint: Object.freeze({
      unit: hint.unit ?? null,
      size: hint.size ?? null,
      state: hint.state ?? null,
    }),
  });
  return householdEntry(lineRef, aiChoice as HouseholdPortionChoice);
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

function messageText(): string {
  return screen.getByTestId('advanced-nutrition-ai-message').textContent ?? '';
}

describe('phase 7 — mid-flight household authority', () => {
  it('preserves a mid-flight user total mass and resolves ONLY the untouched row', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['2 tomatoes', '2 unsalted butter'])}
        session={session}
        onResolveWithAi={handler}
      />
    );
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].args.rows).toHaveLength(2);

    // MID-FLIGHT: the user explicitly enters a total weight for the tomato row.
    expandRow('tomatoes');
    const weightInput = screen.getByLabelText(
      'Total weight for this ingredient line',
      { selector: 'input' }
    ) as HTMLInputElement;
    fireEvent.change(weightInput, { target: { value: '500' } });
    fireEvent.click(screen.getByText('Use this weight'));
    await waitFor(() => expect(rowElement('tomatoes').textContent).toMatch(/500 g/));

    const tomatoRow = calls[0].args.rows.find((row) => /tomatoes/.test(row.original_text)) as Phase4Row;
    const butterRow = calls[0].args.rows.find((row) => /butter/.test(row.original_text)) as Phase4Row;
    const households = householdOutcome(calls[0], [
      { line_ref: tomatoRow.line_ref, household_size_hint: 'medium' },
      { line_ref: butterRow.line_ref, household_unit_hint: 'stick' },
    ]);
    expect(households.resolved).toHaveLength(2);
    expect(households.resolved[0].record_key).toBe('tomato|item|medium|null');
    expect(households.resolved[1].record_key).toBe('unsalted butter|stick|null|null');

    await act(async () => {
      calls[0].resolve({
        ok: true,
        interpretedCount: 2,
        outcome: EMPTY_FOOD,
        amounts: EMPTY_AMOUNTS,
        households,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    // The user's newer mass is final; the stale AI household result was skipped
    // for that line and credited to nobody.
    const tomatoes = rowElement('tomatoes');
    expect(tomatoes.textContent).toMatch(/500 g/);
    expect(tomatoes.textContent).toMatch(/user-entered/);
    expect(tomatoes.textContent).not.toMatch(/household portion/);
    expect(messageText()).toMatch(/1 resolved automatically from verified local data/i);

    // The untouched row receives its verified household resolution.
    const butter = rowElement('butter');
    expect(butter.textContent).toMatch(/Matched/);
    expect(butter.textContent).toMatch(/vetted household portion/);
    expect(butter.textContent).toMatch(/AI-interpreted wording/);
    expect(butter.textContent).toMatch(/226 g/);
  });

  it('discards a household response that arrives after the editor closed', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard recipe={recipe(['2 tomatoes'])} session={session} onResolveWithAi={handler} />
    );
    await openAndAnalyze();

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));

    // The editor closes while the response is still in flight.
    fireEvent.click(screen.getByTestId('advanced-nutrition-close-without-saving'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Advanced Nutrition' })).toBeNull()
    );

    const households = householdOutcome(calls[0], [
      { line_ref: calls[0].args.rows[0].line_ref, household_size_hint: 'medium' },
    ]);
    expect(households.resolved).toHaveLength(1);

    await act(async () => {
      calls[0].resolve({
        ok: true,
        interpretedCount: 1,
        outcome: EMPTY_FOOD,
        amounts: EMPTY_AMOUNTS,
        households,
      });
      await Promise.resolve();
    });

    // Nothing was applied or claimed after close; reopening starts from the
    // unchanged working state (still needs amount, no household mass).
    expect(screen.queryByTestId('advanced-nutrition-ai-message')).toBeNull();
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-live-summary')).toBeTruthy());
    expect(screen.getByTestId('advanced-nutrition-live-summary').textContent).toMatch(/1 need amount/);
  });
});

// ---------------------------------------------------------------------------
// I-2: household-vs-household conflict and Clear resurrection
//
// There is deliberately NO household-size selector in the working UI: the
// deterministic analyzer creates source-derived household choices, and the AI
// pass may fill only SOURCE-MISSING dimensions. A "user selects a different
// verified household choice" therefore enters the working state exactly as the
// working state itself does — a newer verified choice for the same line. The
// tests below drive the REAL builder/registry to produce those verified choices
// and then exercise the component's two independent protection layers (the
// per-line working-choice fingerprint and the independent merge guard).
// ---------------------------------------------------------------------------

describe('phase 7 — household mid-flight conflict (I-2A)', () => {
  it('the fingerprint makes a mid-flight household selection final and resolves only untouched rows', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['2 tomatoes', '2 unsalted butter'])}
        session={session}
        onResolveWithAi={handler}
      />
    );
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    const tomatoRow = call.args.state.rows.find((row) => /tomatoes/.test(row.original_text));
    const butterRow = call.args.rows.find((row) => /butter/.test(row.original_text));
    if (!tomatoRow || !butterRow) throw new Error('missing captured rows');

    // Request-start fingerprint: the tomato line has no household choice yet.
    const captured = new Map<string, string>([
      [tomatoRow.line_ref, workingChoiceFingerprint(call.args.state, tomatoRow.line_ref)],
    ]);

    // MID-FLIGHT: the user's newer verified household choice (large, 364 g).
    const userChoice = verifiedChoice(call, tomatoRow.line_ref, { size: 'large' });
    const stateWithUserChoice = phase4Reducer(call.args.state, {
      type: 'select_household_portion',
      lineRef: tomatoRow.line_ref,
      choice: userChoice,
    });

    // The stale response proposes a DIFFERENT verified choice (medium, 246 g)
    // plus a genuine resolution for the untouched butter row.
    const staleChoice = aiHouseholdEntry(call, tomatoRow.line_ref, { size: 'medium' });
    const butter = householdOutcome(call, [
      { line_ref: butterRow.line_ref, household_unit_hint: 'stick' },
    ]).resolved[0];
    expect(butter).toBeDefined();

    const conflicted = conflictedWorkingLineRefs(stateWithUserChoice, captured);
    expect(conflicted.has(tomatoRow.line_ref)).toBe(true);

    const merged = mergeAiHouseholdPortions({
      base: stateWithUserChoice,
      countPortions: stateWithUserChoice.countPortions,
      resolved: [staleChoice, butter],
      conflicted,
    });

    // The user's newer choice is preserved EXACTLY: same object, same bindings.
    expect(merged[tomatoRow.line_ref]).toBe(userChoice);
    expect(merged[tomatoRow.line_ref]?.resolved_grams).toBe(364);
    expect(merged[tomatoRow.line_ref]?.record_key).toBe('tomato|item|large|null');
    expect(merged[tomatoRow.line_ref]?.aiAssisted).toBeUndefined();
    // The untouched line receives its verified household resolution.
    expect(merged[butterRow.line_ref]?.resolved_grams).toBe(226);

    // Project the authoritative live rows from the merged working state.
    const mergedState = { ...stateWithUserChoice, householdPortions: merged } as Phase4State;
    const calculated = call.args.session.calculate(
      buildCalculationRequest(call.args.adapted, mergedState)
    );
    if (!calculated.ok) throw new Error('merged calculation failed');
    const live = projectLiveRows(
      mergedState,
      new Map(),
      call.args.adapted,
      call.args.session,
      ingredientEvidenceViews(calculated.preview)
    );
    const tomatoLive = live.find((row) => row.line_ref === tomatoRow.line_ref) as LiveRowState;
    const butterLive = live.find((row) => row.line_ref === butterRow.line_ref) as LiveRowState;
    expect(tomatoLive.status).toBe('matched');
    expect(tomatoLive.mass_source).toBe('household_portion');
    expect(tomatoLive.resolved_grams).toBe(364);
    expect(tomatoLive.household_size_class).toBe('large');
    expect(tomatoLive.household_ai_assisted).toBeUndefined();
    expect((userChoice.selection as { selection_digest: string }).selection_digest).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(butterLive.status).toBe('matched');
    expect(butterLive.mass_source).toBe('household_portion');
    expect(butterLive.resolved_grams).toBe(226);
    expect(butterLive.household_ai_assisted).toBe(true);
    const summary = summarizeLiveRows(live);
    expect(summary.matched).toBe(2);
    expect(summary.needs_amount).toBe(0);
  });

  it('the independent merge guard refuses a stale AI choice over an existing verified household choice', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard recipe={recipe(['2 tomatoes'])} session={session} onResolveWithAi={handler} />
    );
    await openAndAnalyze();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    const tomatoRow = call.args.state.rows.find((row) => /tomatoes/.test(row.original_text));
    if (!tomatoRow) throw new Error('missing captured row');

    const existing = verifiedChoice(call, tomatoRow.line_ref, { size: 'medium' });
    const base = phase4Reducer(call.args.state, {
      type: 'select_household_portion',
      lineRef: tomatoRow.line_ref,
      choice: existing,
    });
    // The fingerprint is UNCHANGED (the existing choice was present at capture),
    // so the independent merge guard is the only protection left here.
    const captured = new Map<string, string>([
      [tomatoRow.line_ref, workingChoiceFingerprint(base, tomatoRow.line_ref)],
    ]);
    expect(conflictedWorkingLineRefs(base, captured).size).toBe(0);

    const stale = aiHouseholdEntry(call, tomatoRow.line_ref, { size: 'large' });
    const merged = mergeAiHouseholdPortions({
      base,
      countPortions: base.countPortions,
      resolved: [stale],
      conflicted: new Set<string>(),
    });
    // The merge guard keeps the existing verified choice (the stale response
    // can never overwrite it, even with an unchanged fingerprint).
    expect(merged[tomatoRow.line_ref]).toBe(existing);
    expect(merged[tomatoRow.line_ref]?.resolved_grams).toBe(246);
    expect(merged[tomatoRow.line_ref]?.record_key).toBe('tomato|item|medium|null');

    // Fingerprint coverage itself: household choices and their Clear are part
    // of the captured working authority.
    const cleared = phase4Reducer(base, {
      type: 'clear_household_portion',
      lineRef: tomatoRow.line_ref,
    });
    expect(workingChoiceFingerprint(cleared, tomatoRow.line_ref)).not.toBe(
      workingChoiceFingerprint(base, tomatoRow.line_ref)
    );
    expect(workingChoiceFingerprint(base, tomatoRow.line_ref)).not.toBe(
      workingChoiceFingerprint(call.args.state, tomatoRow.line_ref)
    );
  });
});

describe('phase 7 — household Clear resurrection (I-2B)', () => {
  it('a mid-flight household Clear is never resurrected by a stale AI response', async () => {
    const { handler, calls } = deferredHandler();
    render(
      <AdvancedNutritionCard
        recipe={recipe(['2 large tomatoes', '2 unsalted butter'])}
        session={session}
        onResolveWithAi={handler}
      />
    );
    await openAndAnalyze();

    // Baseline: the line BEGINS with a verified household choice (large, 364 g).
    const tomatoRow = () => rowElement('large tomatoes');
    expect(tomatoRow().textContent).toMatch(/vetted household portion/);
    expect(tomatoRow().textContent).toMatch(/364 g/);

    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-resolve'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const butterRow = calls[0].args.rows.find((row) => /butter/.test(row.original_text));
    expect(butterRow).toBeDefined();
    if (!butterRow) return;

    // MID-FLIGHT: the user clears the household choice.
    expandRow('large tomatoes');
    const householdPanel = tomatoRow().querySelector(
      '[data-testid="advanced-nutrition-household-portion"]'
    );
    if (!householdPanel) throw new Error('missing household panel');
    fireEvent.click(within(householdPanel as HTMLElement).getByText('Clear'));
    await waitFor(() =>
      expect(
        (tomatoRow().querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()
      ).toBe('Needs amount')
    );
    expect(tomatoRow().textContent).not.toMatch(/364 g/);
    expect(tomatoRow().textContent).not.toMatch(/household portion/);

    // The STALE response still carries the genuine (captured) household choice
    // for the cleared line, and a genuine resolution for the untouched row.
    const butterOutcome = householdOutcome(calls[0], [
      { line_ref: butterRow.line_ref, household_unit_hint: 'stick' },
    ]);
    expect(butterOutcome.resolved).toHaveLength(1);
    const households = Object.freeze({
      ...butterOutcome,
      resolved: Object.freeze([
        ...butterOutcome.resolved,
        aiHouseholdEntry(calls[0], calls[0].args.state.rows.find((row) => /large tomatoes/.test(row.original_text))?.line_ref as string, {
          size: 'large',
        }),
      ]),
    });

    await act(async () => {
      calls[0].resolve({
        ok: true,
        interpretedCount: 2,
        outcome: EMPTY_FOOD,
        amounts: EMPTY_AMOUNTS,
        households,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('advanced-nutrition-ai-message')).toBeTruthy());

    // The cleared choice is NOT resurrected: the line stays truthfully unresolved.
    expect(
      (tomatoRow().querySelector('[data-testid="advanced-nutrition-row-status"]')?.textContent ?? '').trim()
    ).toBe('Needs amount');
    expect(tomatoRow().textContent).not.toMatch(/364 g/);
    expect(tomatoRow().textContent).not.toMatch(/household portion/);
    expect(tomatoRow().textContent).not.toMatch(/household estimate/);

    // The unaffected row still receives its verified household resolution.
    expect(rowElement('butter').textContent).toMatch(/Matched/);
    expect(rowElement('butter').textContent).toMatch(/226 g/);
    expect(rowElement('butter').textContent).toMatch(/AI-interpreted wording/);

    // Truthful summary counts: only the untouched row is credited.
    expect(messageText()).toMatch(/1 resolved automatically from verified local data/i);
    const summary = screen.getByTestId('advanced-nutrition-live-summary').textContent ?? '';
    expect(summary).toMatch(/1 matched/);
    expect(summary).toMatch(/1 need amount/);
  });
});
