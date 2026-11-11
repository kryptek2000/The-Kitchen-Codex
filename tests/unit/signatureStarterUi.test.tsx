// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RecipeDetailView } from '../../src/components/RecipeDetailView';
import { RecipeCard } from '../../src/components/RecipeCard';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import { createVoiceCache } from '../../src/application/voiceCache';
import { getStarterVaultRecipes } from '../../src/data/starterVault';
import { buildSavedStarterCopy } from '../../src/application/starterCollection';

afterEach(() => cleanup());

function network(): NetworkAdapter {
  return { request: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as NetworkAdapter;
}

function detail(recipe: ReturnType<typeof getStarterVaultRecipes>[number], extra: Record<string, unknown> = {}) {
  return render(
    <RecipeDetailView
      recipe={recipe}
      allRecipes={[recipe]}
      allNotes={[]}
      onBack={vi.fn()}
      onStartCooking={vi.fn()}
      onEditRecipe={vi.fn()}
      onAddToMealPlan={vi.fn()}
      onAddToShoppingList={vi.fn()}
      onStartTimer={vi.fn()}
      onRateRecipe={vi.fn()}
      onDeleteRecipe={vi.fn()}
      onUpdateNutrition={vi.fn()}
      network={network()}
      voiceService={createVoiceCache(network())}
      {...extra}
    />
  );
}

describe('Signature built-in ownership UI', () => {
  it('marks a built-in recipe and offers the explicit Save to My Vault action', () => {
    const builtIn = getStarterVaultRecipes()[0];
    const onSaveToVault = vi.fn();
    detail(builtIn, { onSaveToVault });

    expect(screen.getByTestId('builtin-recipe-badge')).toBeTruthy();
    expect(screen.getByTestId('builtin-recipe-notice').textContent).toMatch(/read-only/i);
    expect(screen.getByTestId('save-starter-to-vault-btn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByTestId('builtin-nutrition-readonly')).toBeTruthy();

    fireEvent.click(screen.getByTestId('save-starter-to-vault-btn'));
    expect(onSaveToVault).toHaveBeenCalledWith(builtIn);
  });

  it('shows save progress and a bounded result message', () => {
    const builtIn = getStarterVaultRecipes()[1];
    detail(builtIn, {
      onSaveToVault: vi.fn(),
      starterSavePending: true,
      starterSaveState: {
        status: 'saved',
        message: '“Thai Green Coconut Curry” was saved to My Vault.',
      },
    });
    expect(screen.getByTestId('save-starter-to-vault-btn').textContent).toContain('Saving');
    expect(screen.getByTestId('starter-save-status').textContent).toContain('saved to My Vault');
  });

  it('restores ordinary Edit and Delete controls for a saved personal copy', () => {
    const builtIn = getStarterVaultRecipes()[2];
    const copy = buildSavedStarterCopy(builtIn);
    detail(copy);

    expect(screen.queryByTestId('builtin-recipe-badge')).toBeNull();
    expect(screen.queryByTestId('save-starter-to-vault-btn')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByTestId('builtin-nutrition-readonly')).toBeNull();
  });

  it('marks built-in cards while keeping normal cooking and favorite actions', () => {
    const builtIn = getStarterVaultRecipes()[3];
    const onToggleFavorite = vi.fn();
    render(
      <RecipeCard
        recipe={builtIn}
        onSelectRecipe={vi.fn()}
        onStartCooking={vi.fn()}
        onToggleFavorite={onToggleFavorite}
        onAddToMealPlan={vi.fn()}
      />
    );
    expect(screen.getByTestId('builtin-card-badge')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cook Mode' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    expect(onToggleFavorite).toHaveBeenCalledWith(builtIn.id);
  });
});
