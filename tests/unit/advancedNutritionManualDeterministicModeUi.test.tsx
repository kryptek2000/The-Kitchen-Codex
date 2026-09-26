// @vitest-environment jsdom
/**
 * The Kitchen Codex — Advanced Nutrition: manual mode UI (AI-0).
 *
 * Points 1 and 11 of the manual deterministic mode regression contract at the
 * UI seam: Advanced Nutrition opens and works with NO AI provider/capability,
 * and the AI-assisted path is labeled "AI Advanced Nutrition" while manual
 * review/correction remains present and available.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { AdvancedNutritionCard } from '../../src/components/AdvancedNutritionCard';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import {
  AI_ADVANCED_NUTRITION_LABEL,
  BASIC_NUTRITION_CAPABILITIES,
} from '../../src/core/nutritionV2/nutritionCapabilities';
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

function recipe(): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Manual UI Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: [structured('1 cup Zzz')] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

describe('AI-0 manual deterministic mode UI', () => {
  it('opens and works with no AI provider injected (capability Basic)', async () => {
    expect(BASIC_NUTRITION_CAPABILITIES.aiInterpretation).toBe(false);
    expect(BASIC_NUTRITION_CAPABILITIES.manualEditing).toBe(true);

    render(<AdvancedNutritionCard recipe={recipe()} session={session} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });

    // No AI panel at all; deterministic analysis and explicit controls remain.
    expect(screen.queryByTestId('advanced-nutrition-ai')).toBeNull();
    expect(screen.getByTestId('advanced-nutrition-analyze')).toBeTruthy();
    expect(screen.getByTestId('advanced-nutrition-close-without-saving')).toBeTruthy();

    // Deterministic analysis + manual editing seam stays available.
    fireEvent.click(screen.getByTestId('advanced-nutrition-analyze'));
    await screen.findByTestId('advanced-nutrition-live-summary');
    expect(screen.getByTestId('advanced-nutrition-edit')).toBeTruthy();
    expect(screen.queryByTestId('advanced-nutrition-ai')).toBeNull();
  });

  it('labels the AI-assisted path AI Advanced Nutrition with manual correction wording', async () => {
    render(<AdvancedNutritionCard recipe={recipe()} session={session} onResolveWithAi={async () => ({
      ok: false,
      message: 'AI assistance is unavailable. You can continue with USDA search manually.',
      outcome: { candidates: [], unresolved: [], auto_count: 0 },
      amounts: { resolved: [], offers: [], unresolved: [], inconsistent: [], auto_count: 0 },
    })} />);
    fireEvent.click(screen.getByTestId('advanced-nutrition-open'));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });

    const tier = await screen.findByTestId('advanced-nutrition-ai-tier');
    expect(tier.textContent).toContain(AI_ADVANCED_NUTRITION_LABEL);
    expect(tier.textContent).toContain('AI Advanced Nutrition');
    const panel = screen.getByTestId('advanced-nutrition-ai');
    expect(panel.textContent).toContain('AI never supplies grams');
    expect(panel.textContent).toContain('Basic manual review and correction are always available');
  });
});
