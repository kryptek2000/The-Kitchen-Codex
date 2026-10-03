// @vitest-environment jsdom
/**
 * AI-5D — REAL UI BEHAVIOUR: refresh, recovery, and never-gated Basic Nutrition.
 *
 * AI-5C gave the UI three truthful reasons. AI-5D adds the lifecycle that makes them
 * recoverable without a page reload:
 *
 *   - a provider outage offers an explicit "Retry AI availability";
 *   - an unverified product status offers the same retry;
 *   - a definitive Basic product answer does NOT (policy, not a transient failure);
 *   - while a refresh is in flight the copy is NEUTRAL and every AI control is
 *     disabled — the UI must never claim Basic or "provider unavailable" while the
 *     answer is genuinely still being checked;
 *   - and through every one of those states the deterministic/manual nutrition
 *     surface stays fully usable.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import type { AdvancedNutritionAiResolveHandler } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import { NUTRITION_AI_REFRESHING_MESSAGE } from '../../src/application/nutritionAiClientState';
import type { AdvancedNutritionAiAvailability } from '../../src/components/AdvancedNutritionCard';

const SPECS = [
  {
    fdcId: 7001,
    dataType: 'sr_legacy' as const,
    description: 'Garlic, raw',
    proteinAmount: 5,
    portions: [{ usda_portion_id: 1, amount: 1, measure: 'clove', gram_weight: 3, sequence: 1 }],
  },
];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

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

/** '1 cup Zzz' deterministically fails to match, which surfaces the AI panel. */
function recipe(): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'AI-5D probe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [structured('1 cup Zzz')] as never,
    instructions: [{ stepNumber: 1, text: 'Mix.' }],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as unknown as ObsidianRecipe;
}

function unusedPort() {
  const handler: AdvancedNutritionAiResolveHandler = async () => ({
    ok: false,
    outcome: { candidates: [], unresolved: [], auto_count: 0 },
    amounts: { resolved: [], offers: [], unresolved: [], inconsistent: [], auto_count: 0 },
    households: { resolved: [], unresolved: [], inconsistent: [], auto_count: 0 },
  });
  return vi.fn(handler);
}

const BASIC_REASON =
  "AI Advanced Nutrition isn't enabled for this deployment. Basic manual review and correction are still available.";
const PROVIDER_REASON =
  'AI Advanced Nutrition is enabled, but no compatible AI provider is currently available. Basic manual review and correction are still available.';
const UNKNOWN_REASON =
  "AI Advanced Nutrition access couldn't be verified. Basic manual review and correction are still available.";

async function openEditor(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i }));
  await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
}

function renderCard(availability: AdvancedNutritionAiAvailability) {
  return render(
    <AdvancedNutritionCard
      recipe={recipe()}
      session={session}
      onResolveWithAi={unusedPort()}
      advancedNutritionAiAvailability={availability}
    />,
  );
}

afterEach(() => cleanup());

describe('AI-5D UI — explicit Retry is offered only where it can help', () => {
  it('offers Retry when the product is enabled but no provider is available', async () => {
    renderCard({ available: false, reason: PROVIDER_REASON, canRetry: true, onRetry: () => {} });
    await openEditor();
    expect(screen.getByTestId('advanced-nutrition-ai-unavailable').textContent).toContain(
      'is enabled',
    );
    expect(screen.getByTestId('advanced-nutrition-ai-retry')).toBeTruthy();
  });

  it('offers Retry when product access could not be verified', async () => {
    renderCard({ available: false, reason: UNKNOWN_REASON, canRetry: true, onRetry: () => {} });
    await openEditor();
    expect(screen.getByTestId('advanced-nutrition-ai-unavailable').textContent).toContain(
      "couldn't be verified",
    );
    expect(screen.getByTestId('advanced-nutrition-ai-retry')).toBeTruthy();
  });

  it('does NOT offer Retry for a definitive Basic product answer', async () => {
    // Basic is a genuine product-policy answer, not a temporary provider failure.
    renderCard({ available: false, reason: BASIC_REASON, canRetry: false });
    await openEditor();
    expect(screen.getByTestId('advanced-nutrition-ai-unavailable').textContent).toContain(
      "isn't enabled for this deployment",
    );
    expect(screen.queryByTestId('advanced-nutrition-ai-retry')).toBeNull();
  });

  it('invokes the retry handler exactly once per click', async () => {
    const onRetry = vi.fn();
    renderCard({ available: false, reason: PROVIDER_REASON, canRetry: true, onRetry });
    await openEditor();
    fireEvent.click(screen.getByTestId('advanced-nutrition-ai-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no Retry when AI is available', async () => {
    renderCard({ available: true, reason: null, canRetry: false });
    await openEditor();
    expect(screen.queryByTestId('advanced-nutrition-ai-retry')).toBeNull();
  });
});

describe('AI-5D UI — refreshing fails closed with NEUTRAL copy', () => {
  it('disables Retry and every AI control while refreshing', async () => {
    const port = unusedPort();
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={session}
        onResolveWithAi={port}
        advancedNutritionAiAvailability={{
          available: false,
          reason: NUTRITION_AI_REFRESHING_MESSAGE,
          refreshing: true,
          canRetry: true,
          onRetry: () => {},
        }}
      />,
    );
    await openEditor();
    const retry = screen.getByTestId('advanced-nutrition-ai-retry') as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    const resolve = screen.getByTestId('advanced-nutrition-ai-resolve') as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);
    // A disabled control must not launch a paid route.
    fireEvent.click(resolve);
    fireEvent.click(retry);
    expect(port).not.toHaveBeenCalled();
  });

  it('makes NO product or provider claim while refreshing', async () => {
    renderCard({
      available: false,
      reason: NUTRITION_AI_REFRESHING_MESSAGE,
      refreshing: true,
      canRetry: true,
      onRetry: () => {},
    });
    await openEditor();
    const notice = screen.getByTestId('advanced-nutrition-ai-unavailable').textContent ?? '';
    expect(notice).toContain('Checking AI availability');
    // While genuinely still checking, the UI must not invent a reason.
    expect(notice).not.toContain("isn't enabled for this deployment");
    expect(notice).not.toContain('no compatible AI provider');
    expect(notice).not.toContain("couldn't be verified");
  });

  it('shows the refreshing wording on the Retry control itself', async () => {
    renderCard({
      available: false,
      reason: NUTRITION_AI_REFRESHING_MESSAGE,
      refreshing: true,
      canRetry: true,
      onRetry: () => {},
    });
    await openEditor();
    expect(screen.getByTestId('advanced-nutrition-ai-retry').textContent).toContain(
      'Checking AI availability',
    );
  });

  it('recovers to the previous truthful reason when the refresh settles unavailable', async () => {
    // Recovery flow: refreshing -> confirmed provider-unavailable (not a fake Basic).
    const { rerender } = renderCard({
      available: false,
      reason: NUTRITION_AI_REFRESHING_MESSAGE,
      refreshing: true,
      canRetry: true,
      onRetry: () => {},
    });
    await openEditor();
    rerender(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={session}
        onResolveWithAi={unusedPort()}
        advancedNutritionAiAvailability={{
          available: false,
          reason: PROVIDER_REASON,
          refreshing: false,
          canRetry: true,
          onRetry: () => {},
        }}
      />,
    );
    expect(screen.getByTestId('advanced-nutrition-ai-unavailable').textContent).toContain(
      'is enabled',
    );
  });

  it('recovers to available controls without a reload', async () => {
    const port = unusedPort();
    const { rerender } = render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={session}
        onResolveWithAi={port}
        advancedNutritionAiAvailability={{
          available: false,
          reason: PROVIDER_REASON,
          canRetry: true,
          onRetry: () => {},
        }}
      />,
    );
    await openEditor();
    expect((screen.getByTestId('advanced-nutrition-ai-resolve') as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={session}
        onResolveWithAi={port}
        advancedNutritionAiAvailability={{ available: true, reason: null, refreshing: false, canRetry: false }}
      />,
    );
    const resolve = screen.getByTestId('advanced-nutrition-ai-resolve') as HTMLButtonElement;
    expect(resolve.disabled).toBe(false);
    expect(screen.queryByTestId('advanced-nutrition-ai-retry')).toBeNull();
  });
});

describe('AI-5D UI — Basic/manual Nutrition is never gated', () => {
  it.each([
    ['provider unavailable', PROVIDER_REASON],
    ['product unknown', UNKNOWN_REASON],
    ['definitive basic', BASIC_REASON],
  ] as const)('keeps deterministic analysis usable: %s', async (_label, reason) => {
    renderCard({ available: false, reason, canRetry: true, onRetry: () => {} });
    await openEditor();
    const analyzer = screen.getByRole('button', { name: /Analyze/i }) as HTMLButtonElement;
    expect(analyzer).toBeTruthy();
    expect(analyzer.disabled).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Advanced Nutrition' })).toBeTruthy();
  });

  it('keeps the manual correction path present while a refresh is in flight', async () => {
    renderCard({
      available: false,
      reason: NUTRITION_AI_REFRESHING_MESSAGE,
      refreshing: true,
      canRetry: true,
      onRetry: () => {},
    });
    await openEditor();
    // The whole deterministic working editor is still rendered and interactive.
    expect(screen.getByRole('button', { name: /Analyze/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Calculate|Recalculate/i })).toBeTruthy();
  });

  it('disables AI controls for a revoked-credential window with no stale execution', async () => {
    // Revocation UX: cached readiness invalidated -> AI disabled immediately.
    const port = unusedPort();
    renderCard({
      available: false,
      reason: PROVIDER_REASON,
      canRetry: true,
      onRetry: () => {},
    });
    await openEditor();
    const resolve = screen.getByTestId('advanced-nutrition-ai-resolve') as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);
    fireEvent.click(resolve);
    expect(port).not.toHaveBeenCalled();
  });

  it('emits no billing or upgrade language in any AI-5D state', async () => {
    const states: ReadonlyArray<AdvancedNutritionAiAvailability> = [
      { available: false, reason: BASIC_REASON, canRetry: false },
      { available: false, reason: PROVIDER_REASON, canRetry: true, onRetry: () => {} },
      { available: false, reason: UNKNOWN_REASON, canRetry: true, onRetry: () => {} },
      {
        available: false,
        reason: NUTRITION_AI_REFRESHING_MESSAGE,
        refreshing: true,
        canRetry: true,
        onRetry: () => {},
      },
    ];
    for (const state of states) {
      const { unmount } = renderCard(state);
      await openEditor();
      const text = (screen.getByRole('dialog', { name: 'Advanced Nutrition' }).textContent ?? '').toLowerCase();
      for (const banned of ['subscribe', 'upgrade', 'purchase', 'premium', 'trial', 'checkout', 'billing']) {
        expect(text, `state copy must not contain "${banned}"`).not.toContain(banned);
      }
      unmount();
      cleanup();
    }
  });
});