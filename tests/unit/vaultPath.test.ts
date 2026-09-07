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
import { resolveRecipeVaultPath, resolveNewRecipeVaultPath, toVaultRelativePath } from '../../src/core/vaultPath';

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

  it('derives a fresh root-relative path when filePath is unsafe (traversal)', () => {
    const r = recipe({ filePath: 'Recipes/../evil.md', fileName: 'evil.md', title: 'Cake' });
    expect(resolveRecipeVaultPath(r)).toBe('Cake.md');
  });

  it('derives from the basename when filePath is absent but fileName exists', () => {
    const r = recipe({ fileName: 'Cupcakes.md', title: 'Cupcakes' });
    expect(resolveRecipeVaultPath(r)).toBe('Cupcakes.md');
  });

  it('derives a root-relative path from the title when neither filePath nor fileName is usable', () => {
    const r = recipe({ title: 'Sourdough Bread', fileName: '' });
    expect(resolveRecipeVaultPath(r)).toBe('Sourdough Bread.md');
  });

  it('normalizes backslashes and leading slashes to a clean vault-relative path', () => {
    const r = recipe({ filePath: '\\Recipes\\Japanese\\Ramen.md', fileName: 'Ramen.md', title: 'Ramen' });
    expect(resolveRecipeVaultPath(r)).toBe('Recipes/Japanese/Ramen.md');
    const abs = recipe({ filePath: '/Recipes/Pizza.md', fileName: 'Pizza.md', title: 'Pizza' });
    expect(resolveRecipeVaultPath(abs)).toBe('Recipes/Pizza.md');
  });
});

describe('resolveNewRecipeVaultPath (Phase 4C3C — new recipes land at the connected root)', () => {
  it('A: a grabbed/new recipe fileName yields a root-relative filePath', () => {
    expect(resolveNewRecipeVaultPath('Lasagna.md')).toBe('Lasagna.md');
  });

  it('keeps a clean title as a single root-relative file', () => {
    expect(resolveNewRecipeVaultPath('Chicken Parmesan')).toBe('Chicken Parmesan.md');
  });

  it('flattens an accidentally nested producer path to the root basename', () => {
    expect(resolveNewRecipeVaultPath('Recipes/Italian/Lasagna.md')).toBe('Lasagna.md');
    expect(resolveNewRecipeVaultPath('Food/Recipes/Lasagna.md')).toBe('Lasagna.md');
    expect(resolveNewRecipeVaultPath('6 - Full Notes/Food/Recipes/Lasagna.md')).toBe('Lasagna.md');
  });

  it('appends .md and sanitizes unsafe filename characters', () => {
    expect(resolveNewRecipeVaultPath('Sauce: Type|Extra')).toBe('Sauce- Type-Extra.md');
  });

  it('falls back to recipe.md for an empty/unsafe name', () => {
    expect(resolveNewRecipeVaultPath('')).toBe('recipe.md');
    expect(resolveNewRecipeVaultPath('Recipes/')).toBe('recipe.md');
  });
});

describe('toVaultRelativePath (Phase 4C3B — canonical vault-root-relative convention)', () => {
  it('REGRESSION: upload path with root prefix strips exactly one known root segment', () => {
    expect(toVaultRelativePath('MyVault/Recipes/Italian/Lasagna.md', 'MyVault')).toBe(
      'Recipes/Italian/Lasagna.md'
    );
  });

  it('scan-style already-relative path passes through unchanged', () => {
    expect(toVaultRelativePath('Recipes/Italian/Lasagna.md', 'MyVault')).toBe(
      'Recipes/Italian/Lasagna.md'
    );
  });

  it('dropped-folder path with root prefix normalizes to the inner path', () => {
    expect(toVaultRelativePath('DroppedFolder/Recipes/Pasta.md', 'DroppedFolder')).toBe(
      'Recipes/Pasta.md'
    );
  });

  it('dropped top-level file stays root-relative', () => {
    expect(toVaultRelativePath('DroppedFolder/Quick Recipe.md', 'DroppedFolder')).toBe(
      'Quick Recipe.md'
    );
  });

  it('is idempotent: applying twice yields the same result', () => {
    const once = toVaultRelativePath('MyVault/Recipes/Italian/Lasagna.md', 'MyVault');
    expect(once).toBe('Recipes/Italian/Lasagna.md');
    expect(toVaultRelativePath(once, 'MyVault')).toBe(once);
  });

  it('same root name appearing twice strips only ONE known root segment', () => {
    expect(toVaultRelativePath('MyVault/MyVault/Recipe.md', 'MyVault')).toBe(
      'MyVault/Recipe.md'
    );
  });

  it('supports a Unicode root name', () => {
    expect(toVaultRelativePath('Répertoire/Recipes/Curry.md', 'Répertoire')).toBe(
      'Recipes/Curry.md'
    );
  });

  it('supports a Unicode nested path with spaces preserved', () => {
    expect(toVaultRelativePath('MyVault/Recipes/Ünïçødé/Lasăgna.md', 'MyVault')).toBe(
      'Recipes/Ünïçødé/Lasăgna.md'
    );
  });

  it('preserves root-level files', () => {
    expect(toVaultRelativePath('Recipe.md', undefined)).toBe('Recipe.md');
    expect(toVaultRelativePath('MyVault/Recipe.md', 'MyVault')).toBe('Recipe.md');
  });

  it('rejects unsafe traversal segments by returning an empty string (no escape)', () => {
    expect(toVaultRelativePath('../etc/passwd')).toBe('');
    expect(toVaultRelativePath('Recipes/../Lasagna.md')).toBe('');
    expect(toVaultRelativePath('Recipes//Italian/Lasagna.md')).toBe('');
    expect(toVaultRelativePath('.')).toBe('');
    expect(toVaultRelativePath('')).toBe('');
  });

  it('normalizes backslashes and leading slashes', () => {
    expect(toVaultRelativePath('\\MyVault\\Recipes\\Ramen.md', 'MyVault')).toBe(
      'Recipes/Ramen.md'
    );
    expect(toVaultRelativePath('/MyVault/Recipes/Ramen.md', 'MyVault')).toBe(
      'Recipes/Ramen.md'
    );
  });

  it('does NOT strip when the first segment is not the rootName', () => {
    expect(toVaultRelativePath('OtherVault/Recipes/Ramen.md', 'MyVault')).toBe(
      'OtherVault/Recipes/Ramen.md'
    );
    // A legitimate first-level `Recipes` folder is preserved when the rootName
    // is NOT `Recipes`.
    expect(toVaultRelativePath('Recipes/Italian/Ramen.md', 'Italian')).toBe(
      'Recipes/Italian/Ramen.md'
    );
  });
});
