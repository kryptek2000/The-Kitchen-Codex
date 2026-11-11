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

function headerText() {
  return document.getElementById('obsidian-vault-header')?.textContent || '';
}

function favoriteButtonFor(title: string) {
  const titleButton = screen.getByRole('button', { name: title });
  const card = titleButton.closest('article');
  expect(card).not.toBeNull();
  return within(card as HTMLElement).getByRole('button', { name: /add to favorites/i });
}

describe('Signature Collection navigation without a Vault', () => {
  it('shows the permanent built-in nine and a combined, ownership-distinct header', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    expect(galleryCount()).toBe(9);
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Recipe Vault');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 built-in · 0 saved');
    expect(document.querySelectorAll('[data-testid="builtin-card-badge"]').length).toBeGreaterThan(0);
  });

  it('states each active collection without stale or contradictory header text', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(document.getElementById('nav-signature-collection')!);
    await waitFor(() => expect(document.getElementById('vault-page-title')?.textContent).toBe('Signature Collection'));
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('Signature Collection');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 built-in recipes');
    expect(headerText()).not.toContain('My Saved Recipes');

    fireEvent.click(document.getElementById('nav-personal-recipes')!);
    await waitFor(() => expect(screen.getByText('No saved recipes yet')).toBeTruthy());
    expect(document.getElementById('vault-page-title')?.textContent).toBe('My Saved Recipes');
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Saved Recipes');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('0 saved recipes');
    expect(document.body.textContent).not.toContain('9 recipes');
    expect(headerText()).not.toContain('Signature Collection');

    fireEvent.click(document.getElementById('nav-recipe-vault')!);
    await waitFor(() => expect(document.getElementById('vault-page-title')?.textContent).toBe('My Recipe Vault'));
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Recipe Vault');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 built-in · 0 saved');
    expect(galleryCount()).toBe(9);
  });

  it('labels Favorites accurately and counts the favorite collection', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');

    fireEvent.click(favoriteButtonFor('Classic Roman Carbonara'));
    await waitFor(() => expect(screen.getByRole('button', { name: /remove from favorites/i })).toBeTruthy());

    fireEvent.click(document.getElementById('nav-favorites')!);
    await waitFor(() => expect(document.getElementById('vault-page-title')?.textContent).toBe('Favorites'));
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('Favorites');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('1 favorite');
    expect(headerText()).not.toContain('Signature Collection');
    expect(galleryCount()).toBe(1);
  });
});
