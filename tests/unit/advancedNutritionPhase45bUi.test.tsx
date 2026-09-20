// @vitest-environment jsdom
/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: React loading states.
 *
 * Proves the Advanced Nutrition card renders idle / loading / ready / failed /
 * unsupported states truthfully, offers keyboard-operable and accessible
 * controls, loads only on explicit user intent, and keeps calculation explicit
 * and advisory with no Apply/Save/persistence control.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { useAdvancedNutritionBundle } from '../../src/application-ui/useAdvancedNutritionBundle';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import {
  PHASE4_BUNDLE_FAILED_MESSAGE,
  PHASE4_IDLE_MESSAGE,
  PHASE4_LOADING_MESSAGE,
  PHASE4_UNAVAILABLE_MESSAGE,
  PHASE4_UNSUPPORTED_MESSAGE,
} from '../../src/core/nutritionV2/phase4/types';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { RuntimeBundleResult } from '../../src/core/nutritionV2/runtime';
import type { ObsidianRecipe } from '../../src/types';
import { buildCalculationBundle, CALC_FOODS } from '../fixtures/usdaCalculationFixtures';

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
    title: 'Test Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: [
      { original: '100 g Flour, wheat, white', amount: 100, unit: 'g', name: 'Flour, wheat, white' },
      { original: '2 cups Flour, wheat, white', amount: 2, unit: 'cups', name: 'Flour, wheat, white' },
      { original: 'Butter', name: 'Butter' },
    ],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...overrides,
  };
}

function successResult(): RuntimeBundleResult {
  const session = genuineSession();
  return { ok: true, session, metadata: session.metadata(), attribution: 'attr' };
}

function Harness({ loader }: { loader: () => Promise<RuntimeBundleResult> }) {
  const bundle = useAdvancedNutritionBundle(loader);
  return (
    <AdvancedNutritionCard
      recipe={recipe()}
      session={bundle.session}
      bundleStatus={bundle.status}
      onLoadBundle={bundle.load}
    />
  );
}

afterEach(() => cleanup());

describe('phase 4.5B card — lazy load states', () => {
  it('renders the idle state with an enabled, keyboard-operable Open control', () => {
    const load = vi.fn();
    render(<AdvancedNutritionCard recipe={recipe()} session={null} bundleStatus="idle" onLoadBundle={load} />);
    expect(screen.getByText(PHASE4_IDLE_MESSAGE)).toBeTruthy();
    const button = screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('renders the loading state with a disabled control and announced status', () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={null} bundleStatus="loading" onLoadBundle={() => {}} />);
    expect(screen.getByText(PHASE4_LOADING_MESSAGE)).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    const buttons = screen.getAllByRole('button');
    for (const button of buttons) expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('renders the failed state with an explicit Retry control', () => {
    const load = vi.fn();
    render(<AdvancedNutritionCard recipe={recipe()} session={null} bundleStatus="failed" onLoadBundle={load} />);
    expect(screen.getByText(PHASE4_BUNDLE_FAILED_MESSAGE)).toBeTruthy();
    const retry = screen.getByRole('button', { name: /Retry/i });
    fireEvent.click(retry);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('renders the unsupported state without offering a load control', () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={null} bundleStatus="unsupported" onLoadBundle={() => {}} />);
    expect(screen.getByText(PHASE4_UNSUPPORTED_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
  });

  it('keeps the honest unavailable state when no loader is wired', () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={null} />);
    expect(screen.getByText(PHASE4_UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i }).hasAttribute('disabled')).toBe(true);
  });

  it('does not load on mount and opens the review UI only after explicit load succeeds', async () => {
    const loader = vi.fn(async () => successResult());
    render(<Harness loader={loader} />);
    expect(loader).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    expect(dialog).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit action before calculating and never offers Apply/Save', async () => {
    const loader = vi.fn(async () => successResult());
    render(<Harness loader={loader} />);
    fireEvent.click(screen.getByRole('button', { name: /Generate Nutrition|Open Advanced Nutrition/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Advanced Nutrition' });

    // No preview until the explicit Calculate action.
    expect(screen.queryByText('Advisory nutrition preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Calculate Preview/i }));
    expect(await screen.findByText('Advisory nutrition preview')).toBeTruthy();

    const labels = Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent ?? '');
    for (const label of labels) expect(label).not.toMatch(/\bApply\b|\bSave\b|\bPersist\b|\bUpdate Recipe\b|\bWrite to Vault\b/i);
    expect(dialog.textContent).not.toMatch(/codex_nutrition/);
    expect(dialog.textContent).toMatch(/not medical advice/i);
  });
});
