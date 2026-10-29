// @vitest-environment jsdom
/**
 * Favorites navigation regression coverage.
 *
 * These tests exercise the real App navigation path, not a test-local mock of
 * the desired logic. They protect the UD-3P.2A-F2 fix: Favorites is an explicit
 * collection view, returning to My Recipe Vault restores the full collection,
 * and manual filters are not silently erased.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import App from '../../src/App';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '#/');
});

function recipeCount() {
  return (
    document.querySelectorAll('#featured-recipe').length +
    document.querySelectorAll('[id^="recipe-card-"]').length +
    document.querySelectorAll('[id^="recipe-row-"]').length
  );
}

function favoriteButtonFor(title: string) {
  const card = screen.getByText(title).closest('article');
  expect(card).not.toBeNull();
  return within(card as HTMLElement).getByRole('button', { name: /add to favorites/i });
}

function removeFavoriteButton() {
  return screen.getByRole('button', { name: /remove from favorites/i });
}

describe('Favorites navigation', () => {
  it('shows only favorited recipes after clicking Favorites', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    expect(recipeCount()).toBe(9);

    fireEvent.click(favoriteButtonFor('Classic Roman Carbonara'));
    await waitFor(() => expect(removeFavoriteButton()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(recipeCount()).toBe(1));
    expect(screen.getByText('Classic Roman Carbonara')).toBeTruthy();
    expect(document.getElementById('nav-favorites')?.getAttribute('aria-current')).toBe('page');
  });

  it('returns the complete collection when clicking My Recipe Vault again', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(favoriteButtonFor('Classic Roman Carbonara'));
    await waitFor(() => expect(removeFavoriteButton()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(recipeCount()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /My Recipe Vault/i }));
    await waitFor(() => expect(recipeCount()).toBe(9));
    expect(screen.getByText('Artisan Sourdough Boule')).toBeTruthy();
    expect(screen.getByText('Skillet Cornmeal Porridge')).toBeTruthy();
    expect(document.getElementById('nav-recipe-vault')?.getAttribute('aria-current')).toBe('page');
  });

  it('preserves a manual search when navigating Favorites and back', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    const search = screen.getByRole('textbox', { name: /search recipes/i }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'curry' } });
    await waitFor(() => expect(screen.getByText('Authentic Thai Green Coconut Curry')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(search.value).toBe('curry'));

    fireEvent.click(screen.getByRole('button', { name: /My Recipe Vault/i }));
    await waitFor(() => expect(search.value).toBe('curry'));
    expect(screen.getByText('Authentic Thai Green Coconut Curry')).toBeTruthy();
  });

  it('shows a Favorites-specific empty state when nothing is favorited', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(screen.getByText('No favorite recipes yet')).toBeTruthy());
    expect(screen.queryByText('No matching recipes found')).toBeNull();
  });

  it('keeps Favorites navigation and the manual Favorites Only filter independent', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(favoriteButtonFor('Classic Roman Carbonara'));
    await waitFor(() => expect(removeFavoriteButton()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(document.getElementById('nav-favorites')?.getAttribute('aria-current')).toBe('page'));

    fireEvent.click(screen.getByRole('button', { name: /Filters/i }));
    const favoritesOnly = await screen.findByRole('button', { name: /Favorites Only/i });
    fireEvent.click(favoritesOnly);
    await waitFor(() => expect(favoritesOnly.className).toContain('bg-amber-500/10'));

    // The manual filter can be disabled without leaving the Favorites view.
    fireEvent.click(favoritesOnly);
    await waitFor(() => expect(favoritesOnly.className).not.toContain('bg-amber-500/10'));
    expect(document.getElementById('nav-favorites')?.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Classic Roman Carbonara')).toBeTruthy();

    // Re-enable the manual filter, then return to All Recipes. The navigation
    // restriction is removed, but the manually enabled filter remains active.
    fireEvent.click(favoritesOnly);
    await waitFor(() => expect(favoritesOnly.className).toContain('bg-amber-500/10'));

    fireEvent.click(screen.getByRole('button', { name: /My Recipe Vault/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /My Recipe Vault/i }).getAttribute('aria-current')).toBe('page'));
    expect(favoritesOnly.className).toContain('bg-amber-500/10');
    expect(screen.getByText('Classic Roman Carbonara')).toBeTruthy();
  });

  it('updates the Favorites view when a favorite is removed', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(favoriteButtonFor('Classic Roman Carbonara'));
    await waitFor(() => expect(removeFavoriteButton()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(recipeCount()).toBe(1));

    fireEvent.click(removeFavoriteButton());
    await waitFor(() => expect(screen.getByText('No favorite recipes yet')).toBeTruthy());
    expect(recipeCount()).toBe(0);
  });

  it('shows a newly favorited recipe after navigating to Favorites', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(favoriteButtonFor('Classic Roman Carbonara'));
    await waitFor(() => expect(removeFavoriteButton()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Filters/i }));
    const favoritesOnly = await screen.findByRole('button', { name: /Favorites Only/i });
    if (favoritesOnly.className.includes('bg-amber-500/10')) fireEvent.click(favoritesOnly);

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(recipeCount()).toBe(1));
    expect(screen.getByText('Classic Roman Carbonara')).toBeTruthy();
  });
});