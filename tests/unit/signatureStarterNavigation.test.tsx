// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../../src/App';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '#/');
});

function galleryCount() {
  return (
    document.querySelectorAll('#featured-recipe').length +
    document.querySelectorAll('[id^="recipe-card-"]').length +
    document.querySelectorAll('[id^="recipe-row-"]').length
  );
}

function favoriteButtonFor(title: string) {
  const titleButton = screen.getByRole('button', { name: title });
  const card = titleButton.closest('article');
  expect(card).not.toBeNull();
  return within(card as HTMLElement).getByRole('button', { name: /add to favorites/i });
}

describe('ONE Recipe Vault — first-run starter cookbook', () => {
  it('shows the nine starter recipes in the only Vault destination', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    expect(galleryCount()).toBe(9);
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Recipe Vault');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 recipes');
    expect(document.getElementById('vault-page-title')?.textContent).toBe('My Recipe Vault');
    expect(document.querySelectorAll('[data-testid="builtin-card-badge"]').length).toBeGreaterThan(0);
    expect(document.getElementById('nav-recipe-vault')).toBeTruthy();
    expect(document.getElementById('nav-favorites')).toBeTruthy();
    expect(document.getElementById('nav-dataview-table')).toBeTruthy();
    expect(document.getElementById('nav-signature-collection')).toBeNull();
    expect(document.getElementById('nav-personal-recipes')).toBeNull();
    expect(document.body.textContent).not.toContain('Signature Collection');
    expect(document.body.textContent).not.toContain('My Saved Recipes');
  });

  it('keeps Favorites as an accurate filter of the one Vault', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(favoriteButtonFor('Classic Roman Carbonara'));
    await waitFor(() => expect(screen.getByRole('button', { name: /remove from favorites/i })).toBeTruthy());

    fireEvent.click(document.getElementById('nav-favorites')!);
    await waitFor(() => expect(document.getElementById('vault-page-title')?.textContent).toBe('Favorites'));
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('Favorites');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('1 favorite');
    expect(galleryCount()).toBe(1);
  });
});
