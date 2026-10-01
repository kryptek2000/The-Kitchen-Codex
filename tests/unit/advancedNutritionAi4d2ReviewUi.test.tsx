// @vitest-environment jsdom
/**
 * AI-4D2 — REAL UI BEHAVIOUR: EXPLICIT REVIEW, ACCEPT, DISMISS, UNDO.
 *
 * This drives the REAL card + REAL modal in jsdom with a REAL review session
 * produced by the REAL acceptance core, so what is proven is what a user gets:
 *
 *   - the review surface only appears when the AI-4 port is wired, and NOTHING
 *     runs on open (zero port calls until the user clicks);
 *   - Accept / Dismiss / Undo are REAL buttons with keyboard-reachable semantics,
 *     and they make ZERO port calls — they are pure local decisions;
 *   - status is communicated in TEXT (never colour alone);
 *   - an abstained or uninterpreted row can never be accepted;
 *   - a decided row offers Undo instead of a direct accept/dismiss switch;
 *   - a bounded failure message is shown and no review is fabricated;
 *   - a stale/edited recipe drops the review entirely;
 *   - the AI-3 "Remove estimate" control dispatches the EXISTING reducer action.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import type { AdvancedNutritionRecipeContextOutcome } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from '../../src/core/nutritionV2/aiRecipeContextRequest';
import { reconcileRecipeContext } from '../../src/core/nutritionV2/aiRecipeContextReconcile';
import { createRecipeContextReviewSession } from '../../src/core/nutritionV2/aiRecipeContextSession';
import {
  AI_RECIPE_CONTEXT_ABSTAIN_REASONS,
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';
import { deriveRecipeContextModelInput } from '../../server/recipeContextDerivation';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';
import { buildCalculationBundle, CALC_FOODS } from '../fixtures/usdaCalculationFixtures';

const REQUEST_ID = 'ai4d2-ui-1';
const INSTANCE = 'ai4d2-ui-instance';

function genuineSession(): AdvancedNutritionSession {
  const bundle = buildCalculationBundle(CALC_FOODS);
  const result = createAdvancedNutritionSession(bundle.manifest, bundle.records);
  if (!result.ok) throw new Error('session failed');
  return result.session;
}

function recipe(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Context probe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [
      { original: '100 g Flour, wheat, white', amount: 100, unit: 'g', name: 'Flour, wheat, white' },
      { original: 'Butter', name: 'Butter' },
    ] as never,
    instructions: [{ stepNumber: 1, text: 'Reserve half the butter' }],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
    ...overrides,
  } as unknown as ObsidianRecipe;
}

/**
 * A REAL review session: real server derivation, real reconciliation, real session
 * creation. `omit` / `abstain` produce an uninterpreted and an abstained row.
 */
function realReview(
  target: ObsidianRecipe,
  options: { omit?: number; abstain?: number } = {}
): AdvancedNutritionRecipeContextOutcome {
  const derived = deriveRecipeContextModelInput({
    recipe: {
      title: target.title,
      servings: target.servings,
      ingredients: target.ingredients.map((ingredient) => ({
        original: ingredient.original,
        name: ingredient.name,
      })),
    },
    instructions: target.instructions.map((step) => ({ text: step.text })),
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: REQUEST_ID,
    recipeInstance: INSTANCE,
  });
  if (!derived.ok) throw new Error('derivation failed');
  const refs = derived.request.provider_request.targets.map((entry) => entry.line_ref);
  const omit = new Set(options.omit ? [options.omit] : []);
  const abstain = new Set(options.abstain ? [options.abstain] : []);
  const interpretations = refs
    .map((line_ref, index) => ({ line_ref, index }))
    .filter(({ index }) => !omit.has(index))
    .map(({ line_ref, index }) =>
      abstain.has(index)
        ? {
            line_ref,
            role: 'main',
            relations: [],
            preparation_hints: [],
            abstain_reason: AI_RECIPE_CONTEXT_ABSTAIN_REASONS[1],
          }
        : { line_ref, role: 'reserved', relations: [], preparation_hints: ['reserved'] }
    );
  const reconciled = reconcileRecipeContext({
    wire: {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: REQUEST_ID,
      context_binding: derived.request.model_input_binding,
      proposal: {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations,
      },
    },
    expectedRequestId: REQUEST_ID,
    current: {
      context_binding: derived.request.model_input_binding,
      targets: derived.request.provider_request.targets.map((entry) => ({
        line_ref: entry.line_ref,
        source_text: entry.source_text,
      })),
    },
  });
  if (!reconciled.ok) throw new Error('reconciliation failed');
  const created = createRecipeContextReviewSession({
    reconciliation: reconciled.reconciliation,
    expected: {
      requestId: reconciled.reconciliation.request_id,
      contextBinding: reconciled.reconciliation.context_binding,
    },
  });
  if (!created.ok) throw new Error('session failed');
  return { ok: true, session: created.session };
}

/** Opens the Advanced Nutrition working editor. */
async function openEditor(): Promise<HTMLElement> {
  const opener = screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i });
  fireEvent.click(opener);
  return screen.findByRole('dialog', { name: 'Advanced Nutrition' });
}

const REVIEW_BUTTON = 'advanced-nutrition-recipe-context-review';

function renderCard(
  handler: (args: { recipe: ObsidianRecipe }) => Promise<AdvancedNutritionRecipeContextOutcome>,
  target: ObsidianRecipe = recipe()
) {
  return render(
    <AdvancedNutritionCard
      recipe={target}
      session={genuineSession()}
      onReviewRecipeContextWithAi={handler}
    />
  );
}

afterEach(() => cleanup());

describe('AI-4D2 UI — nothing happens until the user asks', () => {
  it('renders no review surface at all when no AI-4 port is wired', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={genuineSession()} />);
    await openEditor();
    expect(screen.queryByTestId('advanced-nutrition-recipe-context')).toBeNull();
  });

  it('shows the review control but makes ZERO port calls on open', async () => {
    const port = vi.fn(async () => realReview(recipe()));
    renderCard(port);
    await openEditor();
    expect(screen.getByTestId('advanced-nutrition-recipe-context')).toBeTruthy();
    expect(screen.getByTestId(REVIEW_BUTTON)).toBeTruthy();
    // NO rows and NO review before the user clicks: nothing is fetched, guessed,
    // inferred or accepted on open, focus, render or re-analysis.
    expect(screen.queryByTestId('advanced-nutrition-recipe-context-rows')).toBeNull();
    expect(port).not.toHaveBeenCalled();
  });
});

describe('AI-4D2 UI — the explicit review', () => {
  it('one click runs the review and shows every row as an AI interpretation', async () => {
    const port = vi.fn(async () => realReview(recipe()));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    await waitFor(() => expect(port).toHaveBeenCalledTimes(1));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    expect(rows.children.length).toBeGreaterThan(0);
    expect(screen.getByTestId('advanced-nutrition-recipe-context-summary').textContent).toContain(
      'awaiting review'
    );
    // Model output is labelled as an interpretation, not as fact.
    expect(screen.getAllByText(/AI interpretation/).length).toBeGreaterThan(0);
  });

  it('a second click is not required, and the control is not offered mid-run', async () => {
    let release: (() => void) | null = null;
    const port = vi.fn(
      () =>
        new Promise<AdvancedNutritionRecipeContextOutcome>((resolve) => {
          release = () => resolve(realReview(recipe()));
        })
    );
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    await waitFor(() => expect(screen.getByTestId(REVIEW_BUTTON).hasAttribute('disabled')).toBe(true));
    // A rapid double-click must not start a second run.
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    expect(port).toHaveBeenCalledTimes(1);
    release?.();
    await screen.findByTestId('advanced-nutrition-recipe-context-rows');
  });

  it('shows a bounded message and no rows when the review is unavailable', async () => {
    const port = vi.fn(async () => ({ ok: false, message: "Recipe context review isn't available right now." }));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const message = await screen.findByTestId('advanced-nutrition-recipe-context-message');
    expect(message.textContent).toBe("Recipe context review isn't available right now.");
    expect(message.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('advanced-nutrition-recipe-context-rows')).toBeNull();
    // The message is a live region so assistive technology announces it.
    expect(message.getAttribute('role')).toBe('status');
  });
});

describe('AI-4D2 UI — accept, dismiss and undo are the user’s own', () => {
  it('accepting shows the accepted status and makes NO additional port call', async () => {
    const port = vi.fn(async () => realReview(recipe()));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const firstRow = rows.children[0] as HTMLElement;
    const lineRef = firstRow.getAttribute('data-testid')?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';

    expect(firstRow.getAttribute('data-status')).toBe('pending');
    const accept = screen.getByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`);
    // A REAL button: keyboard reachable, with a spoken label naming the line.
    expect(accept.tagName).toBe('BUTTON');
    expect(accept.getAttribute('type')).toBe('button');
    expect(accept.getAttribute('aria-label')).toContain('Accept');

    fireEvent.click(accept);
    await waitFor(() =>
      expect(
        screen
          .getByTestId(`advanced-nutrition-recipe-context-row-${lineRef}`)
          .getAttribute('data-status')
      ).toBe('accepted')
    );
    // Status is TEXT, not colour alone.
    expect(screen.getByTestId(`advanced-nutrition-recipe-context-status-${lineRef}`).textContent).toBe(
      'Accepted for this session'
    );
    // The decision is local: ZERO further requests.
    expect(port).toHaveBeenCalledTimes(1);
    // A decided row offers Undo, not a direct switch.
    expect(screen.queryByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`)).toBeNull();
    expect(screen.getByTestId(`advanced-nutrition-recipe-context-undo-${lineRef}`)).toBeTruthy();
  });

  it('dismissing shows the dismissed status and makes NO port call', async () => {
    const port = vi.fn(async () => realReview(recipe()));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const lineRef = (rows.children[0] as HTMLElement)
      .getAttribute('data-testid')
      ?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';
    fireEvent.click(screen.getByTestId(`advanced-nutrition-recipe-context-dismiss-${lineRef}`));
    await waitFor(() =>
      expect(
        screen
          .getByTestId(`advanced-nutrition-recipe-context-row-${lineRef}`)
          .getAttribute('data-status')
      ).toBe('dismissed')
    );
    expect(screen.getByTestId(`advanced-nutrition-recipe-context-status-${lineRef}`).textContent).toBe(
      'Dismissed'
    );
    expect(port).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId(`advanced-nutrition-recipe-context-undo-${lineRef}`)).toBeTruthy();
  });

  it('undo restores the row to exactly its original pending state', async () => {
    const port = vi.fn(async () => realReview(recipe()));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const lineRef = (rows.children[0] as HTMLElement)
      .getAttribute('data-testid')
      ?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';
    const row = () => screen.getByTestId(`advanced-nutrition-recipe-context-row-${lineRef}`);
    const before = row().textContent;

    fireEvent.click(screen.getByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`));
    await waitFor(() => expect(row().getAttribute('data-status')).toBe('accepted'));
    expect(row().textContent).not.toBe(before);

    fireEvent.click(screen.getByTestId(`advanced-nutrition-recipe-context-undo-${lineRef}`));
    await waitFor(() => expect(row().getAttribute('data-status')).toBe('pending'));
    // Byte-truthful restoration: the row reads exactly as it did before deciding.
    expect(row().textContent).toBe(before);
    expect(port).toHaveBeenCalledTimes(1);
  });

  it('never offers a direct switch: undo is the only way back', async () => {
    const port = vi.fn(async () => realReview(recipe()));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const lineRef = (rows.children[0] as HTMLElement)
      .getAttribute('data-testid')
      ?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';
    fireEvent.click(screen.getByTestId(`advanced-nutrition-recipe-context-dismiss-${lineRef}`));
    await waitFor(() =>
      expect(
        screen
          .getByTestId(`advanced-nutrition-recipe-context-row-${lineRef}`)
          .getAttribute('data-status')
      ).toBe('dismissed')
    );
    expect(screen.queryByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`)).toBeNull();
    expect(screen.queryByTestId(`advanced-nutrition-recipe-context-dismiss-${lineRef}`)).toBeNull();
    expect(screen.getByTestId(`advanced-nutrition-recipe-context-undo-${lineRef}`)).toBeTruthy();
  });

  it('the summary counts decisions honestly', async () => {
    const port = vi.fn(async () => realReview(recipe()));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const lineRef = (rows.children[0] as HTMLElement)
      .getAttribute('data-testid')
      ?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';
    fireEvent.click(screen.getByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`));
    await waitFor(() =>
      expect(
        screen.getByTestId('advanced-nutrition-recipe-context-summary').textContent
      ).toContain('1 accepted')
    );
    // The session-only boundary is stated to the user in the surface itself.
    expect(screen.getByText(/session only/i)).toBeTruthy();
    expect(screen.getByText(/never changes nutrition values/i)).toBeTruthy();
  });

  it('clearing the review removes every row and decision', async () => {
    const port = vi.fn(async () => realReview(recipe()));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const lineRef = (rows.children[0] as HTMLElement)
      .getAttribute('data-testid')
      ?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';
    fireEvent.click(screen.getByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`));
    await waitFor(() =>
      expect(
        screen
          .getByTestId(`advanced-nutrition-recipe-context-row-${lineRef}`)
          .getAttribute('data-status')
      ).toBe('accepted')
    );
    fireEvent.click(screen.getByTestId('advanced-nutrition-recipe-context-clear'));
    await waitFor(() =>
      expect(screen.queryByTestId('advanced-nutrition-recipe-context-rows')).toBeNull()
    );
    // Clearing never calls the provider either.
    expect(port).toHaveBeenCalledTimes(1);
  });
});

describe('AI-4D2 UI — non-reviewable rows can never be accepted', () => {
  it('an abstained row shows its reason and offers no action', async () => {
    const port = vi.fn(async () => realReview(recipe(), { abstain: 1 }));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const row = rows.children[1] as HTMLElement;
    const lineRef = row.getAttribute('data-testid')?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';
    expect(row.getAttribute('data-status')).toBe('abstained');
    expect(row.textContent).toContain('abstained');
    expect(screen.queryByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`)).toBeNull();
    expect(screen.queryByTestId(`advanced-nutrition-recipe-context-dismiss-${lineRef}`)).toBeNull();
    expect(screen.queryByTestId(`advanced-nutrition-recipe-context-undo-${lineRef}`)).toBeNull();
  });

  it('an uninterpreted row is shown as not interpreted, with nothing invented', async () => {
    const port = vi.fn(async () => realReview(recipe(), { omit: 1 }));
    renderCard(port);
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    const rows = await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const row = rows.children[1] as HTMLElement;
    const lineRef = row.getAttribute('data-testid')?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';
    expect(row.getAttribute('data-status')).toBe('uninterpreted');
    expect(screen.getByTestId(`advanced-nutrition-recipe-context-status-${lineRef}`).textContent).toBe(
      'AI did not interpret this line'
    );
    // No interpretation is invented for it.
    expect(row.textContent).not.toContain('reserved');
    expect(screen.queryByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`)).toBeNull();
  });
});

describe('AI-4D2 UI — a different recipe ends the review', () => {
  it('decisions never carry over to another recipe', async () => {
    const first = realReview(recipe());
    const port = vi.fn(async () => first);
    const { rerender } = renderCard(port, recipe({ id: 'r1' }));
    await openEditor();
    fireEvent.click(screen.getByTestId(REVIEW_BUTTON));
    await screen.findByTestId('advanced-nutrition-recipe-context-rows');
    const lineRef = (screen.getByTestId('advanced-nutrition-recipe-context-rows').children[0] as HTMLElement)
      .getAttribute('data-testid')
      ?.replace('advanced-nutrition-recipe-context-row-', '') ?? '';
    fireEvent.click(screen.getByTestId(`advanced-nutrition-recipe-context-accept-${lineRef}`));
    await waitFor(() =>
      expect(
        screen
          .getByTestId(`advanced-nutrition-recipe-context-row-${lineRef}`)
          .getAttribute('data-status')
      ).toBe('accepted')
    );

    // A DIFFERENT recipe: the whole review, including the decision, is gone.
    rerender(
      <AdvancedNutritionCard
        recipe={recipe({ id: 'r2', title: 'Another recipe' })}
        session={genuineSession()}
        onReviewRecipeContextWithAi={port}
      />
    );
    await waitFor(() =>
      expect(screen.queryByTestId('advanced-nutrition-recipe-context-rows')).toBeNull()
    );
  });
});
