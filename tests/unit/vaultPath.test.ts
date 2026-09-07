/**
 * The Kitchen Codex — Vault Path Policy (Phase 4C3A).
 *
 * Tests the invariant that an EXISTING recipe's logical location is owned by its
 * vault-relative `filePath` — not by `fileName` (basename) and not by an optional
 * `fileHandle`. This is the regression test for the bug phase 4C3A exists to
 * prevent: a nested recipe must never be silently re-rooted to the vault root.
 */

import { describe, it, expect } from 'vitest';
import type { ObsidianRecipe } from '../../src/types';
import { resolveRecipeVaultPath } from '../../src/core/vaultPath';

function recipe(partial: Partial<ObsidianRecipe>): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'Untitled Recipe.md',
    filePath: '',
    title: 'Untitled Recipe',
    tags: [],
    category: 'Main Course',
    cuisine: 'General',
    difficulty: 'Medium',
    rating: 5,
    ingredients: [],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    rawMarkdown: '',
    ...partial,
  } as ObsidianRecipe;
}

describe('resolveRecipeVaultPath (Phase 4C3A)', () => {
  it('SUBFOILDER REGRESSION: nested recipe keeps its folder even without fileHandle', () => {
    const r = recipe({
      filePath: 'Recipes/Italian/Lasagna.md',
      fileName: 'Lasagna.md',
      title: 'Lasagna',
    });
    // fileHandle is deliberately undefined (as with the adapter read path).
    expect(r.fileHandle).toBeUndefined();
    expect(resolveRecipeVaultPath(r)).toBe('Recipes/Italian/Lasagna.md');
  });

  it('a root recipe keeps its root path via filePath', () => {
    const r = recipe({ filePath: 'Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    expect(resolveRecipeVaultPath(r)).toBe('Lasagna.md');
  });

  it('a new recipe with filePath keeps the derived Recipes/ path', () => {
    const r = recipe({ filePath: 'Recipes/Brownies.md', fileName: 'Brownies.md', title: 'Brownies' });
    expect(resolveRecipeVaultPath(r)).toBe('Recipes/Brownies.md');
  });

  it('derives a fresh Recipes/<SafeTitle>.md path when filePath is unsafe (traversal)', () => {
    const r = recipe({ filePath: 'Recipes/../evil.md', fileName: 'evil.md', title: 'Cake' });
    expect(resolveRecipeVaultPath(r)).toBe('Recipes/Cake.md');
  });

  it('derives from the basename when filePath is absent but fileName exists', () => {
    const r = recipe({ fileName: 'Cupcakes.md', title: 'Cupcakes' });
    expect(resolveRecipeVaultPath(r)).toBe('Cupcakes.md');
  });

  it('derives from the title when neither filePath nor fileName is usable', () => {
    const r = recipe({ title: 'Sourdough Bread', fileName: '' });
    expect(resolveRecipeVaultPath(r)).toBe('Recipes/Sourdough Bread.md');
  });

  it('normalizes backslashes and leading slashes to a clean vault-relative path', () => {
    const r = recipe({ filePath: '\\Recipes\\Japanese\\Ramen.md', fileName: 'Ramen.md', title: 'Ramen' });
    expect(resolveRecipeVaultPath(r)).toBe('Recipes/Japanese/Ramen.md');
    const abs = recipe({ filePath: '/Recipes/Pizza.md', fileName: 'Pizza.md', title: 'Pizza' });
    expect(resolveRecipeVaultPath(abs)).toBe('Recipes/Pizza.md');
  });
});
