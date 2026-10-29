// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { RecipeDetailView } from '../../src/components/RecipeDetailView';
import type { ObsidianRecipe } from '../../src/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

afterEach(() => cleanup());

function network(): NetworkAdapter {
  return { request: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as NetworkAdapter;
}

function recipe(rating = 0): ObsidianRecipe {
  return {
    id: 'rating-test.md',
    fileName: 'rating-test.md',
    filePath: 'rating-test.md',
    rawMarkdown: '',
    title: 'Rating Test',
    tags: ['food/recipes'],
    category: 'Dinner',
    cuisine: 'General',
    difficulty: 'Medium',
    rating,
    ingredients: [{ original: '1 cup Water', name: 'Water' }],
    instructions: [{ stepNumber: 1, text: 'Cook.' }],
    callouts: [],
    notes: '',
    dataviewFields: {},
    wikilinks: [],
  } as unknown as ObsidianRecipe;
}

function heroRecipe(rating = 0, onRateRecipe = vi.fn()): ObsidianRecipe {
  return {
    id: 'hero-rating.md',
    fileName: 'hero-rating.md',
    filePath: 'hero-rating.md',
    rawMarkdown: '',
    title: 'Hero Rating',
    tags: ['food/recipes'],
    category: 'Dinner',
    cuisine: 'General',
    difficulty: 'Medium',
    rating,
    image: 'https://example.com/hero.jpg',
    ingredients: [{ original: '1 cup Water', name: 'Water' }],
    instructions: [{ stepNumber: 1, text: 'Cook.' }],
    callouts: [],
    notes: 'A note.',
    dataviewFields: {},
    wikilinks: [],
  } as unknown as ObsidianRecipe;
}

function renderHeroDetail(rating = 0, onRateRecipe = vi.fn()) {
  return render(
    <RecipeDetailView
      recipe={heroRecipe(rating, onRateRecipe)}
      allRecipes={[]}
      allNotes={[]}
      onBack={vi.fn()}
      onStartCooking={vi.fn()}
      onEditRecipe={vi.fn()}
      onAddToMealPlan={vi.fn()}
      onAddToShoppingList={vi.fn()}
      onStartTimer={vi.fn()}
      onRateRecipe={onRateRecipe}
      network={network()}
    />
  );
}

function renderDetail(rating = 0, onRateRecipe = vi.fn()) {
  return render(
    <RecipeDetailView
      recipe={recipe(rating)}
      allRecipes={[]}
      allNotes={[]}
      onBack={vi.fn()}
      onStartCooking={vi.fn()}
      onEditRecipe={vi.fn()}
      onAddToMealPlan={vi.fn()}
      onAddToShoppingList={vi.fn()}
      onStartTimer={vi.fn()}
      onRateRecipe={onRateRecipe}
      network={network()}
    />
  );
}

describe('Recipe Detail interactive ratings', () => {
  it('shows an unrated recipe with five rateable stars', () => {
    renderDetail(0);
    expect(screen.getByRole('button', { name: 'Rate 1 out of 5 stars' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rate 5 out of 5 stars' })).toBeTruthy();
    expect(screen.getByText('Not rated')).toBeTruthy();
  });

  it('clicking 4 selects four stars and calls onRateRecipe(4)', () => {
    const onRate = vi.fn();
    const { container } = renderDetail(0, onRate);
    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 out of 5 stars' }));
    expect(onRate).toHaveBeenCalledWith('rating-test.md', 4);
  });

  it('changing 4 to 2 calls onRateRecipe(2)', () => {
    const onRate = vi.fn();
    renderDetail(4, onRate);
    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 out of 5 stars' }));
    expect(onRate).toHaveBeenCalledWith('rating-test.md', 2);
  });

  it('clear rating calls onRateRecipe(0)', () => {
    const onRate = vi.fn();
    renderDetail(4, onRate);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Rating' }));
    expect(onRate).toHaveBeenCalledWith('rating-test.md', 0);
  });

  it('disables Clear Rating when unrated', () => {
    renderDetail(0);
    expect((screen.getByRole('button', { name: 'Clear Rating' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders four filled stars when rating is 4', () => {
    const { container } = renderDetail(4);
    const filled = container.querySelectorAll('.fill-amber-400');
    expect(filled.length).toBeGreaterThanOrEqual(4);
  });

  it('accessible labels and status are present', () => {
    renderDetail(3);
    expect(screen.getByRole('group', { name: 'Personal recipe rating' })).toBeTruthy();
    expect(screen.getByText('Your rating: 3 out of 5')).toBeTruthy();
    expect(screen.getByText('Personal rating. Not a community average.')).toBeTruthy();
  });



});
