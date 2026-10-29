// @vitest-environment jsdom
/**
 * F6 — Recipe Detail Notes Markdown rendering regressions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { RecipeDetailView } from '../../src/components/RecipeDetailView';
import { getStarterVaultRecipes } from '../../src/data/starterVault';
import type { ObsidianRecipe } from '../../src/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

afterEach(() => cleanup());

function network(): NetworkAdapter {
  return { request: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as NetworkAdapter;
}

function makeRecipe(notes: string, extra: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: 'notes-test.md',
    fileName: 'notes-test.md',
    filePath: 'notes-test.md',
    rawMarkdown: '',
    title: 'Notes Test',
    tags: ['food/recipes'],
    category: 'Dinner',
    cuisine: 'General',
    difficulty: 'Medium',
    rating: 5,
    ingredients: [{ original: '1 cup Water', name: 'Water' }],
    instructions: [{ stepNumber: 1, text: 'Cook.' }],
    callouts: [],
    notes,
    dataviewFields: {},
    wikilinks: [],
    ...extra,
  } as unknown as ObsidianRecipe;
}

function renderNotes(notes: string, extra: Partial<ObsidianRecipe> = {}) {
  return render(
    <RecipeDetailView
      recipe={makeRecipe(notes, extra)}
      allRecipes={[]}
      allNotes={[]}
      onBack={vi.fn()}
      onStartCooking={vi.fn()}
      onEditRecipe={vi.fn()}
      onAddToMealPlan={vi.fn()}
      onAddToShoppingList={vi.fn()}
      onStartTimer={vi.fn()}
      onFilterByWikilink={vi.fn()}
      network={network()}
    />
  );
}

describe('Recipe Detail Notes Markdown', () => {
  it('renders the Thai Green Coconut Curry Vegetarian/Vegan bullet without raw markers', () => {
    const thai = getStarterVaultRecipes().find((r) => r.title === 'Authentic Thai Green Coconut Curry');
    expect(thai).toBeTruthy();
    renderNotes(thai!.notes || '');
    const strong = screen.getByText('Vegetarian/Vegan');
    expect(strong.tagName).toBe('STRONG');
    expect(document.body.textContent).not.toContain('**Vegetarian/Vegan**');
    expect(document.body.textContent).toContain('Swap chicken with extra-firm tofu');
  });

  it('renders paragraphs, unordered and ordered lists', () => {
    renderNotes('First paragraph.\n\n- Bullet one\n- Bullet two\n\n1. First step\n2. Second step');
    const notes = document.getElementById('recipe-notes') as HTMLElement;
    expect(notes.querySelectorAll('p').length).toBe(1);
    expect(notes.querySelectorAll('ul li').length).toBe(2);
    expect(notes.querySelectorAll('ol li').length).toBe(2);
    expect(screen.getByText('Bullet one')).toBeTruthy();
    expect(screen.getByText('Second step')).toBeTruthy();
  });

  it('renders bold, italic, inline code and line breaks', () => {
    const { container } = renderNotes('A **bold** and *italic* with `code`.\nSecond line.');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.querySelectorAll('br').length).toBe(1);
  });

  it('keeps plain notes readable', () => {
    renderNotes('Store sliced bread well.');
    expect(screen.getByText('Store sliced bread well.')).toBeTruthy();
  });

  it('renders Obsidian wikilinks as working cross-reference controls', () => {
    renderNotes('Serve with [[Tomatoes|fresh tomatoes]] and [[Basil]].');
    const aliasButton = screen.getByRole('button', { name: 'fresh tomatoes' });
    const targetButton = screen.getByRole('button', { name: 'Basil' });
    expect(aliasButton).toBeTruthy();
    expect(targetButton).toBeTruthy();
    fireEvent.click(aliasButton);
    expect(document.getElementById('wikilink-preview-modal')).toBeTruthy();
    expect(document.body.textContent).toContain('[[Tomatoes]]');
  });

  it('does not execute HTML or Markdown-embedded HTML', () => {
    const { container } = renderNotes(
      '<script>window.__notesXss = true</script>\n\n**<img src=x onerror="window.__notesXss = true">**'
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as any).__notesXss).toBeUndefined();
    expect(container.textContent).toContain('<script>');
  });

  it('preserves original notes Markdown on the recipe object', () => {
    const notes = '- **Vegetarian/Vegan**: Swap chicken.\n\nSee [[Tofu]].';
    const recipe = makeRecipe(notes);
    render(
      <RecipeDetailView
        recipe={recipe}
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
    expect(recipe.notes).toBe(notes);
  });
});
