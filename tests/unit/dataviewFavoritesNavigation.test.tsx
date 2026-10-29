// @vitest-environment jsdom
/**
 * UD-3P.2A-F4 cross-view navigation regression coverage.
 *
 * Favorites, My Recipe Vault, and Dataview Table are independent destinations.
 * These tests exercise the real App navigation/data flow.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import App from '../../src/App';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
});

function dataviewRowCount() {
  return document.querySelectorAll('[id^="dataview-row-"]').length;
}

function favoriteButtonFor(title: string) {
  const titleNode = screen.getByText(title);
  let node: HTMLElement | null = titleNode.parentElement;
  while (node && !node.querySelector('button[aria-label^="Add to favorites"]')) {
    node = node.parentElement;
  }
  expect(node).not.toBeNull();
  const btn = node!.querySelector('button[aria-label^="Add to favorites"]');
  expect(btn).not.toBeNull();
  return btn as HTMLButtonElement;
}

function removeFavoriteButton() {
  return screen.getByRole('button', { name: /remove from favorites/i });
}

describe('Dataview / Favorites cross-view navigation', () => {
  it('A: zero favorites -> Dataview Table shows all nine recipes', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(screen.getByText('No favorite recipes yet')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Dataview Table/i }));
    await waitFor(() => expect(dataviewRowCount()).toBe(9));
    expect(document.getElementById('nav-dataview-table')?.getAttribute('aria-current')).toBe('page');
    expect(document.getElementById('nav-favorites')?.getAttribute('aria-current')).toBeNull();
  });

  it('B: one favorite -> Dataview Table still shows all nine recipes', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    const favBtn = favoriteButtonFor('Classic Roman Carbonara');
    fireEvent.click(favBtn);

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(screen.getByText('Classic Roman Carbonara')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Dataview Table/i }));
    await waitFor(() => expect(dataviewRowCount()).toBe(9));
  });

  it('C: Dataview Table -> Favorites -> My Recipe Vault restores collection', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(screen.getByRole('button', { name: /Dataview Table/i }));
    await waitFor(() => expect(dataviewRowCount()).toBe(9));

    fireEvent.click(screen.getByRole('button', { name: /^Favorites$/i }));
    await waitFor(() => expect(screen.getByText('No favorite recipes yet')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /My Recipe Vault/i }));
    await waitFor(() => expect(screen.getByText('Artisan Sourdough Boule')).toBeTruthy());
    expect(document.getElementById('nav-recipe-vault')?.getAttribute('aria-current')).toBe('page');
  });

  it('D: exactly one primary navigation destination is highlighted', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(screen.getByRole('button', { name: /Dataview Table/i }));
    await waitFor(() => expect(dataviewRowCount()).toBe(9));

    const navIds = ['nav-recipe-vault', 'nav-favorites', 'nav-dataview-table'];
    const active = navIds.filter((id) => document.getElementById(id)?.getAttribute('aria-current') === 'page');
    expect(active).toEqual(['nav-dataview-table']);
  });

  it('E: manual search is preserved across Dataview navigation', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    const search = screen.getByRole('textbox', { name: /search recipes/i }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'curry' } });
    await waitFor(() => expect(screen.getByText('Authentic Thai Green Coconut Curry')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Dataview Table/i }));
    await waitFor(() => expect(dataviewRowCount()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /My Recipe Vault/i }));
    await waitFor(() => expect(search.value).toBe('curry'));
  });

  it('F: explicit manual Favorites Only filter still filters Dataview', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    const favBtn = favoriteButtonFor('Classic Roman Carbonara');
    fireEvent.click(favBtn);
    await waitFor(() => expect(removeFavoriteButton()).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Filters/i }));
    const favoritesOnly = await screen.findByRole('button', { name: /Favorites Only/i });
    fireEvent.click(favoritesOnly);
    await waitFor(() => expect(favoritesOnly.className).toContain('bg-amber-500/10'));

    fireEvent.click(screen.getByRole('button', { name: /Dataview Table/i }));
    await waitFor(() => expect(dataviewRowCount()).toBe(1));
  });

  it('G: mobile Favorites then Dataview shows all recipes', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    const moreButton = screen.getByText('More').closest('button') as HTMLButtonElement;
    fireEvent.click(moreButton);
    fireEvent.click(await screen.findByRole('button', { name: /^Favorites$/i }));
    // close not needed; More sheet closes on action

    fireEvent.click(moreButton);
    fireEvent.click(await screen.findByRole('button', { name: /Dataview Table/i }));
    await waitFor(() => expect(dataviewRowCount()).toBe(9));
  });

  it('H: Dataview Table opened directly shows all nine recipes', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(screen.getByRole('button', { name: /Dataview Table/i }));
    await waitFor(() => expect(dataviewRowCount()).toBe(9));
    expect(document.getElementById('nav-dataview-table')?.getAttribute('aria-current')).toBe('page');
  });
});