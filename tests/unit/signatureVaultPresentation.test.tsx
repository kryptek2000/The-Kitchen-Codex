// @vitest-environment jsdom
/**
 * Signature Edition Vault presentation regressions.
 *
 * These tests protect the composition contract, not pixel snapshots:
 * the featured spread uses real saved recipe data, never invents a
 * description, keeps every action and accessible name, and the shelf cards
 * keep 44px controls, wrapping titles and the honest photo fallback.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ObsidianRecipe } from '../../src/types';
import { FeaturedRecipe } from '../../src/components/FeaturedRecipe';
import { RecipeCard } from '../../src/components/RecipeCard';
import { MobileRecipeRow } from '../../src/components/MobileRecipeRow';
import { storedRecipeDescription, visibleRecipeTags } from '../../src/utils/recipePresentation';
import { describeVaultConnection } from '../../src/core/vaultConnection';

afterEach(() => cleanup());

function recipe(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: 'recipe-1',
    fileName: 'recipe.md',
    filePath: 'recipe.md',
    rawMarkdown: '# Recipe',
    title: 'A Very Long Recipe Name That Should Wrap Naturally Rather Than Truncate',
    tags: ['food/recipes', 'dinner', 'italian', 'high-protein', 'quick'],
    category: 'Main Course',
    cuisine: 'Italian',
    prepTime: '10 mins',
    cookTime: '20 mins',
    servings: 4,
    difficulty: 'Easy',
    rating: 5,
    ingredients: [],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...overrides,
  };
}

function renderFeatured(overrides: Partial<ObsidianRecipe> = {}, actions = {}) {
  const onSelectRecipe = vi.fn();
  const onStartCooking = vi.fn();
  const onToggleFavorite = vi.fn();
  const onAddToMealPlan = vi.fn();
  render(
    <FeaturedRecipe
      recipe={recipe(overrides)}
      index={1}
      total={9}
      onSelectRecipe={onSelectRecipe}
      onStartCooking={onStartCooking}
      onToggleFavorite={onToggleFavorite}
      onAddToMealPlan={onAddToMealPlan}
      {...actions}
    />
  );
  return { onSelectRecipe, onStartCooking, onToggleFavorite, onAddToMealPlan };
}

describe('Featured Signature spread', () => {
  it('uses the saved cuisine, category, tags and metadata without fabrication', () => {
    renderFeatured();
    expect(screen.getByText(/Italian/)).toBeTruthy();
    expect(screen.getByText(/Main Course/)).toBeTruthy();
    expect(screen.getByText('10 mins')).toBeTruthy();
    expect(screen.getByText('20 mins')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('#dinner')).toBeTruthy();
    expect(screen.queryByText('#food/recipes')).toBeNull();
  });

  it('does not invent a description when the note has none', () => {
    renderFeatured();
    expect(screen.queryByTestId('featured-description')).toBeNull();
  });

  it('shows a description only when one is actually stored', () => {
    renderFeatured({ description: 'A saved note about this recipe.' });
    expect(screen.getByTestId('featured-description').textContent).toBe('A saved note about this recipe.');
  });

  it('keeps the honest photograph fallback', () => {
    renderFeatured();
    expect(screen.getByText('No photograph saved.')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('preserves actions, accessible names and 44px+ target classes', () => {
    const actions = renderFeatured();
    fireEvent.click(screen.getByRole('button', { name: 'Cook Mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to meal plan' }));
    expect(actions.onStartCooking).toHaveBeenCalledTimes(1);
    expect(actions.onSelectRecipe).toHaveBeenCalledTimes(1);
    expect(actions.onAddToMealPlan).toHaveBeenCalledTimes(1);
    for (const name of ['Cook Mode', 'Details', 'Add to meal plan']) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toMatch(/min-h-\[(44|48)px\]/);
    }
  });

  it('toggles the saved favorite state with an accessible pressed state', () => {
    const actions = renderFeatured({ isFavorite: true });
    const favorite = screen.getByRole('button', { name: 'Remove from favorites' });
    expect(favorite.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(favorite);
    expect(actions.onToggleFavorite).toHaveBeenCalledWith('recipe-1');
  });

  it('opens the same recipe from the editorial title', () => {
    const actions = renderFeatured();
    fireEvent.click(screen.getByRole('button', { name: /A Very Long Recipe Name/ }));
    expect(actions.onSelectRecipe).toHaveBeenCalledTimes(1);
  });
});

describe('Signature shelf card', () => {
  function renderCard(overrides: Partial<ObsidianRecipe> = {}) {
    const onSelectRecipe = vi.fn();
    const onStartCooking = vi.fn();
    const onToggleFavorite = vi.fn();
    const onAddToMealPlan = vi.fn();
    render(
      <RecipeCard
        recipe={recipe(overrides)}
        onSelectRecipe={onSelectRecipe}
        onStartCooking={onStartCooking}
        onToggleFavorite={onToggleFavorite}
        onAddToMealPlan={onAddToMealPlan}
      />
    );
    return { onSelectRecipe, onStartCooking, onToggleFavorite, onAddToMealPlan };
  }

  it('keeps details, cooking mode, meal plan and favorites operable', () => {
    const actions = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Cook Mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to meal plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    expect(actions.onStartCooking).toHaveBeenCalledTimes(1);
    expect(actions.onSelectRecipe).toHaveBeenCalledTimes(1);
    expect(actions.onAddToMealPlan).toHaveBeenCalledTimes(1);
    expect(actions.onToggleFavorite).toHaveBeenCalledWith('recipe-1');
  });

  it('wraps long titles and keeps 44px action targets', () => {
    renderCard();
    const title = screen.getByRole('button', { name: /A Very Long Recipe Name/ });
    expect(title.className).toContain('break-words');
    expect(title.className).toContain('min-h-[44px]');
    expect(screen.getByRole('button', { name: 'Cook Mode' }).className).toContain('min-h-[44px]');
    expect(screen.getByRole('button', { name: 'Add to meal plan' }).className).toContain('h-11');
  });

  it('renders the honest fallback for a note with no saved image', () => {
    renderCard();
    expect(screen.getByText('No photo added.')).toBeTruthy();
  });
});

describe('Mobile Signature shelf row', () => {
  it('keeps favorite, details, meal plan and cooking entry available', () => {
    const onSelectRecipe = vi.fn();
    const onStartCooking = vi.fn();
    const onToggleFavorite = vi.fn();
    const onAddToMealPlan = vi.fn();
    render(
      <MobileRecipeRow
        recipe={recipe()}
        onSelectRecipe={onSelectRecipe}
        onStartCooking={onStartCooking}
        onToggleFavorite={onToggleFavorite}
        onAddToMealPlan={onAddToMealPlan}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to weekly meal plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cook' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    expect(onAddToMealPlan).toHaveBeenCalledTimes(1);
    expect(onSelectRecipe).toHaveBeenCalledTimes(1);
    expect(onStartCooking).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No photo added.')).toBeTruthy();
  });
});

describe('Presentation helpers', () => {
  it('quiets the storage namespace without dropping the only real tag', () => {
    expect(visibleRecipeTags(['food/recipes', 'dinner', 'italian']).tags).toEqual(['dinner', 'italian']);
    expect(visibleRecipeTags(['food/recipes']).tags).toEqual(['food/recipes']);
    expect(visibleRecipeTags(['a', 'b', 'c', 'd', 'e'], 3).remaining).toBe(2);
  });

  it('uses only stored description fields', () => {
    expect(storedRecipeDescription(recipe())).toBe('');
    expect(storedRecipeDescription(recipe({ description: 'Saved description' }))).toBe('Saved description');
    expect(
      storedRecipeDescription(recipe({ dataviewFields: { description: 'Dataview description' } }))
    ).toBe('Dataview description');
    expect(storedRecipeDescription(recipe({ notes: 'Chef note only' }))).toBe('');
  });
});

describe('Remembered-Vault safety copy', () => {
  it('labels the visible collection as a Starter Vault preview when access is unavailable', () => {
    for (const state of ['reauthorization_required', 'permission_denied'] as const) {
      const described = describeVaultConnection({
        state,
        recipeCount: 9,
        noteCount: 0,
        rememberedVaultName: 'My Recipe Vault',
      });
      expect(described.label).toContain('sample recipes');
      expect(described.label).not.toContain('Vault linked');
      expect(described.detail).toMatch(/Starter Vault preview/);
      expect(described.detail).toMatch(/not/i);
    }
  });
});
