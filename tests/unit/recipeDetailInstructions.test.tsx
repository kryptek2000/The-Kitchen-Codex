// @vitest-environment jsdom
/**
 * Recipe Detail instruction rendering and layout regressions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';

import { RecipeDetailView } from '../../src/components/RecipeDetailView';
import type { ObsidianRecipe } from '../../src/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

afterEach(() => cleanup());

function network(): NetworkAdapter {
  return { request: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as NetworkAdapter;
}

function recipe(): ObsidianRecipe {
  return {
    id: 'sourdough.md',
    fileName: 'sourdough.md',
    filePath: 'sourdough.md',
    rawMarkdown: '',
    title: 'Artisan Sourdough Boule',
    tags: ['food/recipes', 'baking'],
    category: 'Baking & Breads',
    cuisine: 'French',
    prepTime: '45 mins',
    cookTime: '40 mins',
    servings: 8,
    difficulty: 'Hard',
    rating: 5,
    ingredients: [{ original: '450 g Bread Flour', name: 'Bread Flour' }],
    instructions: [
      { stepNumber: 1, text: '**Autolyse**: In a large mixing bowl, combine flour and water.', timerMinutes: 45 },
      { stepNumber: 2, text: 'Fold the dough and let it rest.' },
    ],
    callouts: [],
    notes: 'Store sliced bread well.',
    dataviewFields: {},
    wikilinks: [],
  } as unknown as ObsidianRecipe;
}

function renderDetail() {
  return render(
    <RecipeDetailView
      recipe={recipe()}
      allRecipes={[]}
      allNotes={[]}
      onBack={vi.fn()}
      onStartCooking={vi.fn()}
      onEditRecipe={vi.fn()}
      onAddToMealPlan={vi.fn()}
      onAddToShoppingList={vi.fn()}
      onStartTimer={vi.fn()}
      network={network()}
    />
  );
}

describe('Recipe Detail instructions', () => {
  it('renders bold Markdown without literal markers', () => {
    const { container } = renderDetail();
    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('Autolyse');
    expect(container.textContent).toContain('In a large mixing bowl');
    expect(container.textContent).not.toContain('**Autolyse**');
  });

  it('keeps plain-text instructions readable', () => {
    renderDetail();
    expect(screen.getByText('Fold the dough and let it rest.')).toBeTruthy();
  });

  it('keeps timer buttons associated with their steps', () => {
    const { container } = renderDetail();
    const button = container.querySelector('#step-timer-btn-0');
    expect(button?.textContent).toContain('Start 45 min Timer');
    expect(button?.closest('li')?.textContent).toContain('Autolyse');
  });

  it('preserves original instruction text and duration data', () => {
    const { container } = renderDetail();
    const text = container.textContent || '';
    expect(text).toContain('In a large mixing bowl, combine flour and water.');
    expect(text).toContain('Start 45 min Timer');
    expect(text).not.toContain('**');
  });

  it('uses a readable measure for instructions', () => {
    const { container } = renderDetail();
    const list = container.querySelector('ol');
    expect(list?.className).toContain('max-w-3xl');
  });

  it('keeps ingredients before instructions in reading order', () => {
    const { container } = renderDetail();
    const text = container.textContent || '';
    expect(text.indexOf('Ingredients')).toBeLessThan(text.indexOf('Instructions & Timers'));
  });
});
