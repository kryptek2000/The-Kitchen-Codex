// @vitest-environment jsdom
/**
 * AI-5C — REAL UI BEHAVIOUR: three genuinely different reasons, one unchanged
 * deterministic foundation.
 *
 * Before AI-5C the UI collapsed "this deployment is Basic", "no provider is
 * configured" and "the status could not be verified" into one generic
 * "not configured in this build" line. This drives the REAL card + REAL modal in
 * jsdom and proves:
 *
 *   - each of the three states shows its OWN truthful reason;
 *   - AI controls are genuinely disabled (not merely styled) in all three;
 *   - NO state produces billing, upgrade, paywall, trial or purchase language;
 *   - the Basic deterministic/manual nutrition surface is NEVER removed — only the
 *     AI assistance layer is gated;
 *   - the fully-available case keeps the existing controls working.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import {
  AdvancedNutritionCard,
  type AdvancedNutritionAiResolveHandler,
} from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import {
  composeNutritionAiClientState,
  nutritionAiUnavailableMessage,
  type NutritionAiAvailabilityReason,
} from '../../src/application/nutritionAiClientState';
import {
  AI_ADVANCED_NUTRITION_PRODUCT_ACCESS,
  BASIC_NUTRITION_PRODUCT_ACCESS,
} from '../../src/core/nutritionV2/nutritionProductAccess';
import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';

/**
 * A small catalog with a genuine deterministic matcher behind it, so the fixture
 * below produces a REAL `needs_match` exception and the AI panel actually renders.
 */
const SPECS = [
  {
    fdcId: 7001,
    dataType: 'sr_legacy' as const,
    description: 'Garlic, raw',
    proteinAmount: 5,
    portions: [
      { usda_portion_id: 1, amount: 1, measure: 'clove', gram_weight: 3, sequence: 1 },
    ],
  },
];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

function genuineSession(): AdvancedNutritionSession {
  return session;
}

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

/** '1 cup Zzz' deterministically fails to match, which is what surfaces the AI panel. */
function recipe(): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'AI-5C probe',
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

const READY = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });
const UNREADY = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: false });

/**
 * The presentation state the SHELL would pass for a given reason, built through the
 * real composition so the test cannot assert copy the product does not produce.
 */
function presentationFor(reason: NutritionAiAvailabilityReason) {
  const productAccess =
    reason === 'product_not_enabled'
      ? ({ status: 'resolved', access: BASIC_NUTRITION_PRODUCT_ACCESS } as const)
      : reason === 'available' || reason === 'provider_unavailable'
        ? ({ status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS } as const)
        : ({ status: 'unavailable' } as const);
  const operational = reason === 'available' ? READY : reason === 'provider_unavailable' ? UNREADY : null;
  const state = composeNutritionAiClientState({ productAccess, operational });
  expect(state.availability).toBe(reason);
  return {
    available: state.available,
    reason: nutritionAiUnavailableMessage(state.availability),
  };
}

async function openEditor(): Promise<HTMLElement> {
  const opener = screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i });
  fireEvent.click(opener);
  return screen.findByRole('dialog', { name: 'Advanced Nutrition' });
}

/** A wired-but-never-to-be-called AI resolve port. */
function unusedPort() {
  // Typed against the real handler signature so the port can never drift from the
  // component contract, and so a click would be a genuine call if one were made.
  const handler: AdvancedNutritionAiResolveHandler = async () => ({
      ok: false,
    outcome: { candidates: [], unresolved: [], auto_count: 0 },
    amounts: { resolved: [], offers: [], unresolved: [], inconsistent: [], auto_count: 0 },
    households: { resolved: [], unresolved: [], inconsistent: [], auto_count: 0 },
  });
  return vi.fn(handler);
}

afterEach(() => cleanup());

describe('AI-5C UI — the deterministic foundation is never gated', () => {
  it.each([
    ['product_not_enabled'],
    ['provider_unavailable'],
    ['product_access_unverified'],
  ] as const)('%s keeps deterministic/manual Advanced Nutrition usable', async (reason) => {
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={genuineSession()}
        onResolveWithAi={unusedPort()}
        advancedNutritionAiAvailability={presentationFor(reason)}
      />,
    );
    await openEditor();
    // The manual analysis path — the Basic product — is present in every state.
    const analyzer = screen.getByRole('button', { name: /Analyze/i });
    expect(analyzer).toBeTruthy();
    expect((analyzer as HTMLButtonElement).disabled).toBe(false);
    // The dialog itself is fully rendered: AI-5C never locks the card or modal.
    expect(screen.getByRole('dialog', { name: 'Advanced Nutrition' })).toBeTruthy();
  });
});

describe('AI-5C UI — three distinct truthful reasons', () => {
  it('Known Basic says the deployment has not enabled it, and keeps Basic available', async () => {
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={genuineSession()}
        onResolveWithAi={unusedPort()}
        advancedNutritionAiAvailability={presentationFor('product_not_enabled')}
      />,
    );
    await openEditor();
    const notice = screen.getByTestId('advanced-nutrition-ai-unavailable');
    expect(notice.textContent).toContain("isn't enabled for this deployment");
    expect(notice.textContent).toContain('Basic manual review and correction are still available');
  });

  it('AI Advanced + unavailable provider says ENABLED, and never claims not entitled', async () => {
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={genuineSession()}
        onResolveWithAi={unusedPort()}
        advancedNutritionAiAvailability={presentationFor('provider_unavailable')}
      />,
    );
    await openEditor();
    const notice = screen.getByTestId('advanced-nutrition-ai-unavailable');
    expect(notice.textContent).toContain('is enabled');
    expect(notice.textContent).toContain('no compatible AI provider is currently available');
    // The user IS entitled in this state, so the copy must not imply otherwise.
    expect(notice.textContent).not.toContain("isn't enabled for this deployment");
  });

  it('Unknown status says access could NOT be verified, and blames nothing', async () => {
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={genuineSession()}
        onResolveWithAi={unusedPort()}
        advancedNutritionAiAvailability={presentationFor('product_access_unverified')}
      />,
    );
    await openEditor();
    const notice = screen.getByTestId('advanced-nutrition-ai-unavailable');
    expect(notice.textContent).toContain("couldn't be verified");
    // It must NOT claim Basic, and must NOT blame the provider, a subscription or a
    // payment — the client knows none of those.
    expect(notice.textContent).not.toContain("isn't enabled for this deployment");
    expect(notice.textContent).not.toContain('provider');
    expect(notice.textContent).not.toContain('subscription');
    expect(notice.textContent).not.toContain('expired');
  });

  it('no state emits billing, upgrade, paywall or product-sales language', async () => {
    for (const reason of [
      'product_not_enabled',
      'provider_unavailable',
      'product_access_unverified',
    ] as const) {
      const presentation = presentationFor(reason);
      const text = (presentation.reason ?? '').toLowerCase();
      for (const banned of [
        'subscribe',
        'subscription',
        'upgrade',
        'pay',
        'purchase',
        'premium',
        'trial',
        'checkout',
        'billing',
        'unlock',
        'license',
      ]) {
        expect(text, `${reason} copy must not contain "${banned}"`).not.toContain(banned);
      }
    }
  });
});

describe('AI-5C UI — AI controls cannot execute when unavailable', () => {
  it.each([
    ['product_not_enabled'],
    ['provider_unavailable'],
    ['product_access_unverified'],
  ] as const)('%s leaves the AI resolve control disabled', async (reason) => {
    const port = unusedPort();
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={genuineSession()}
        onResolveWithAi={port}
        advancedNutritionAiAvailability={presentationFor(reason)}
      />,
    );
    await openEditor();
    const control = screen.getByTestId('advanced-nutrition-ai-resolve');
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(control.getAttribute('aria-disabled')).toBe('true');
    // A visually disabled control must not secretly invoke a paid route.
    fireEvent.click(control);
    expect(port).not.toHaveBeenCalled();
  });

  it('AI Advanced + ready leaves the AI controls enabled', async () => {
    const port = unusedPort();
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={genuineSession()}
        onResolveWithAi={port}
        advancedNutritionAiAvailability={presentationFor('available')}
      />,
    );
    await openEditor();
    const control = screen.getByTestId('advanced-nutrition-ai-resolve');
    expect((control as HTMLButtonElement).disabled).toBe(false);
    // No reason copy when AI is available.
    expect(screen.queryByTestId('advanced-nutrition-ai-unavailable')).toBeNull();
  });

  it('the recipe-context review control is disabled in every unavailable state', async () => {
    for (const reason of [
      'product_not_enabled',
      'provider_unavailable',
      'product_access_unverified',
    ] as const) {
      render(
        <AdvancedNutritionCard
          recipe={recipe()}
          session={genuineSession()}
          onReviewRecipeContextWithAi={vi.fn(async () => ({ ok: false, message: 'x' }))}
          advancedNutritionAiAvailability={presentationFor(reason)}
        />,
      );
      await openEditor();
      const control = screen.getByTestId('advanced-nutrition-recipe-context-review');
      expect((control as HTMLButtonElement).disabled).toBe(true);
      // And it carries the same truthful reason, not a generic build message.
      const notice = screen.getByTestId('advanced-nutrition-recipe-context-unavailable');
      expect(notice.textContent).not.toContain('not configured in this build');
      cleanup();
    }
  });
});

describe('AI-5C UI — the shell owns every decision', () => {
  it('a component given only `available` cannot re-derive the reason', async () => {
    // Components receive two primitives. With no `reason` supplied, the modal
    // falls back to the safe unknown wording and cannot invent a product claim.
    render(
      <AdvancedNutritionCard
        recipe={recipe()}
        session={genuineSession()}
        onResolveWithAi={unusedPort()}
        advancedNutritionAiAvailability={{ available: false, reason: null }}
      />,
    );
    await openEditor();
    const notice = screen.getByTestId('advanced-nutrition-ai-unavailable');
    expect(notice.textContent).toContain("couldn't be verified");
  });

  it('an absent availability prop renders the AI surface without reason copy', async () => {
    // Purely additive: an embedder that supplies no AI-5C state keeps the previous
    // available-surface behaviour rather than being forced to claim a tier.
    render(
      <AdvancedNutritionCard recipe={recipe()} session={genuineSession()} onResolveWithAi={unusedPort()} />,
    );
    await openEditor();
    expect(screen.queryByTestId('advanced-nutrition-ai-unavailable')).toBeNull();
    const control = screen.getByTestId('advanced-nutrition-ai-resolve');
    expect((control as HTMLButtonElement).disabled).toBe(false);
  });
});