/**
 * The Kitchen Codex — Application Recipe Vault Orchestration (Phase 4C3B).
 *
 * Tests the application seam (`scanVaultMarkdown`, `saveRecipeWithVaultAdapter`,
 * `deleteRecipeWithVaultAdapter`) against a fake `VaultAdapter`. No browser DOM,
 * no real FileSystemHandle, no IndexedDB, no React.
 *
 * Proves:
 *   - read/list of all Markdown goes through the VaultAdapter port,
 *   - recipe / note / Meal Plan / Shopping List classification aggregates correctly,
 *   - nested paths + custom frontmatter + wikilinks are preserved on the record,
 *   - recipe writes use `resolveRecipeVaultPath` so nested recipes write nested,
 *   - no FileSystemHandle is required (or attached) for adapter reads/writes,
 *   - exactly ONE write per save (no dual-write),
 *   - adapter errors propagate,
 *   - delete targets the vault-relative nested path.
 */

import { describe, it, expect } from 'vitest';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';
import {
  scanVaultMarkdown,
  saveRecipeWithVaultAdapter,
  deleteRecipeWithVaultAdapter,
} from '../../src/application/vaultRecipe';
import type { ObsidianRecipe } from '../../src/types';

const RECIPE_MD = `---
title: "Lasagna"
cuisine: "Italian"
category: "Dinner"
tags:
  - food/recipes
  - italian
rating: 4
author: "Chef Anna"
x_custom_metadata: "kept-verbatim"
---
# Lasagna
Serve with [[Tomatoes]] and [[Fresh Basil]].
## Ingredients
- [ ] 1 cup [[Flour]]
## Instructions
1. Bake at 350.
`;

const NOTE_MD = `---
title: "Garlic Guide"
tags:
  - technique
---
# Garlic Guide
A reference note.
`;

const MEAL_PLAN_MD = `---
type: meal-plan
---
## Monday
- **Dinner**: [[Lasagna]]
`;

const SHOPPING_LIST_MD = `---
type: shopping-list
---
## Produce
- [ ] tomatoes
`;

function recipe(partial: Partial<ObsidianRecipe>): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'Untitled Recipe.md',
    filePath: '',
    rawMarkdown: '',
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
    ...partial,
  } as ObsidianRecipe;
}

interface FakeVault {
  vault: VaultAdapter;
  writes: { path: string; content: string }[];
  deletes: string[];
}

function fakeVault(files: Record<string, string>): FakeVault {
  const writes: { path: string; content: string }[] = [];
  const deletes: string[] = [];
  const store = { ...files };
  const vault: VaultAdapter = {
    async listMarkdownFiles() {
      return Object.keys(store).map((p) => ({ path: p, name: p.split('/').pop() as string }));
    },
    async readText(path: string) {
      const content = store[path];
      if (content === undefined) {
        const error = new Error(`Vault file not found: ${path}`);
        Object.defineProperty(error, 'name', { value: 'NotFoundError' });
        throw error;
      }
      return content;
    },
    async writeText(path: string, content: string) {
      writes.push({ path, content });
      store[path] = content;
    },
    async delete(path: string) {
      deletes.push(path);
      delete store[path];
    },
    async exists(path: string) {
      return Object.prototype.hasOwnProperty.call(store, path);
    },
  };
  return { vault, writes, deletes };
}

describe('application vault orchestration (Phase 4C3B)', () => {
  it('A: reads and classifies every Markdown file through the VaultAdapter', async () => {
    const { vault } = fakeVault({
      'Recipes/Italian/Lasagna.md': RECIPE_MD,
      'Notes/Garlic Guide.md': NOTE_MD,
      'Meal Plan.md': MEAL_PLAN_MD,
      'Shopping List.md': SHOPPING_LIST_MD,
    });
    const result = await scanVaultMarkdown(vault);
    expect(result.recipes).toHaveLength(1);
    expect(result.notes).toHaveLength(1);
  });

  it('B: classifies a recipe and preserves its logical identity', async () => {
    const { vault } = fakeVault({ 'Recipes/Italian/Lasagna.md': RECIPE_MD });
    const result = await scanVaultMarkdown(vault);
    expect(result.recipes[0].title).toBe('Lasagna');
    expect(result.recipes[0].filePath).toBe('Recipes/Italian/Lasagna.md');
    expect(result.recipes[0].fileName).toBe('Lasagna.md');
  });

  it('C: classifies an ordinary note', async () => {
    const { vault } = fakeVault({ 'Notes/Garlic Guide.md': NOTE_MD });
    const result = await scanVaultMarkdown(vault);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].title).toBe('Garlic Guide');
    expect(result.recipes).toHaveLength(0);
  });

  it('D: classifies Meal Plan.md as a meal plan', async () => {
    const { vault } = fakeVault({ 'Meal Plan.md': MEAL_PLAN_MD });
    const result = await scanVaultMarkdown(vault);
    expect(result.mealPlan?.[0].dayName).toBe('Monday');
    expect(result.mealPlan?.[0].dinner?.recipeTitle).toBe('Lasagna');
    expect(result.recipes).toHaveLength(0);
  });

  it('E: classifies Shopping List.md as a shopping list', async () => {
    const { vault } = fakeVault({ 'Shopping List.md': SHOPPING_LIST_MD });
    const result = await scanVaultMarkdown(vault);
    expect(result.shoppingList?.[0].category).toBe('Produce');
    expect(result.recipes).toHaveLength(0);
  });

  it('F: nested path is preserved on the adapter-read recipe', async () => {
    const { vault } = fakeVault({ 'Food/Recipes/Desserts/Brownie.md': RECIPE_MD });
    const result = await scanVaultMarkdown(vault);
    expect(result.recipes[0].filePath).toBe('Food/Recipes/Desserts/Brownie.md');
  });

  it('G: custom frontmatter is preserved', async () => {
    const { vault } = fakeVault({ 'Recipes/Lasagna.md': RECIPE_MD });
    const result = await scanVaultMarkdown(vault);
    expect(result.recipes[0].frontmatter?.['x_custom_metadata']).toBe('kept-verbatim');
    expect(result.recipes[0].frontmatter?.['author']).toBe('Chef Anna');
  });

  it('H: wikilinks are preserved', async () => {
    const { vault } = fakeVault({ 'Recipes/Lasagna.md': RECIPE_MD });
    const result = await scanVaultMarkdown(vault);
    expect(result.recipes[0].wikilinks).toEqual(
      expect.arrayContaining(['Tomatoes', 'Fresh Basil'])
    );
  });

  it('I: save uses resolveRecipeVaultPath for the target', async () => {
    const { vault, writes } = fakeVault({});
    const r = recipe({ filePath: 'Recipes/Italian/Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    await saveRecipeWithVaultAdapter(vault, r);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('Recipes/Italian/Lasagna.md');
  });

  it('J: nested recipe writes back to its nested path (never a root basename)', async () => {
    const { vault, writes } = fakeVault({});
    const r = recipe({ filePath: 'Recipes/Italian/Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    await saveRecipeWithVaultAdapter(vault, r);
    expect(writes[0].path).toBe('Recipes/Italian/Lasagna.md');
    expect(writes[0].path).not.toBe('Lasagna.md');
  });

  it('K: adapter reads carry no fileHandle and saves never require one', async () => {
    const { vault } = fakeVault({ 'Recipes/Italian/Lasagna.md': RECIPE_MD });
    const result = await scanVaultMarkdown(vault);
    expect(result.recipes[0].fileHandle).toBeUndefined();

    const writes: string[] = [];
    const noHandleVault: VaultAdapter = {
      ...vault,
      async writeText(path: string) {
        writes.push(path);
      },
    };
    await saveRecipeWithVaultAdapter(noHandleVault, result.recipes[0]);
    expect(writes).toEqual(['Recipes/Italian/Lasagna.md']);
  });

  it('L: save performs exactly ONE write (no dual-write)', async () => {
    const { vault, writes } = fakeVault({});
    const r = recipe({ filePath: 'Recipes/Brownies.md', fileName: 'Brownies.md', title: 'Brownies' });
    await saveRecipeWithVaultAdapter(vault, r);
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toContain('# Brownies');
  });

  it('M: adapter errors propagate (no silent fallback)', async () => {
    const failing: VaultAdapter = {
      async listMarkdownFiles() {
        return [];
      },
      async readText() {
        return '';
      },
      async writeText() {
        throw new Error('disk full');
      },
      async delete() {
        throw new Error('disk full');
      },
      async exists() {
        return false;
      },
    };
    const r = recipe({ filePath: 'Recipes/Brownies.md', fileName: 'Brownies.md', title: 'Brownies' });
    await expect(saveRecipeWithVaultAdapter(failing, r)).rejects.toThrow('disk full');
    await expect(
      deleteRecipeWithVaultAdapter(failing, recipe({ filePath: 'Recipes/Brownies.md', fileName: 'Brownies.md', title: 'Brownies' }))
    ).rejects.toThrow('disk full');
  });

  it('N: an ingestion-normalized (root-relative) recipe saves root-relative via the adapter', async () => {
    const { vault, writes } = fakeVault({});
    // Mimics the filePath produced by upload/drop ingestion normalization.
    const r = recipe({ filePath: 'Recipes/Italian/Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    await saveRecipeWithVaultAdapter(vault, r);
    expect(writes[0].path).toBe('Recipes/Italian/Lasagna.md');
  });

  it('O: delete targets the vault-relative nested path (never root basename)', async () => {
    const store = { 'Recipes/Italian/Lasagna.md': RECIPE_MD };
    const { vault, deletes } = fakeVault(store);
    const r = recipe({ filePath: 'Recipes/Italian/Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    await deleteRecipeWithVaultAdapter(vault, r);
    expect(deletes).toEqual(['Recipes/Italian/Lasagna.md']);
    expect(deletes).not.toEqual(['Lasagna.md']);
    expect(await vault.exists('Recipes/Italian/Lasagna.md')).toBe(false);
  });
});

describe('new vs existing recipe persistence path (Phase 4C3C)', () => {
  it('G: a NEW root-relative recipe saves exactly at the connected root (no nested dir)', async () => {
    const { vault, writes } = fakeVault({});
    // `resolveNewRecipeVaultPath('Lasagna.md')` => 'Lasagna.md'
    const r = recipe({ filePath: 'Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    await saveRecipeWithVaultAdapter(vault, r);
    expect(writes[0].path).toBe('Lasagna.md');
    expect(writes[0].path).not.toBe('Food/Recipes/Lasagna.md');
    expect(writes[0].path).not.toBe('Recipes/Lasagna.md');
    expect(writes[0].path).not.toBe('6 - Full Notes/Food/Recipes/Lasagna.md');
  });

  it('E: an existing nested recipe saves back to its nested filePath', async () => {
    const { vault, writes } = fakeVault({});
    const r = recipe({ filePath: 'Italian/Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    await saveRecipeWithVaultAdapter(vault, r);
    expect(writes[0].path).toBe('Italian/Lasagna.md');
  });

  it('F: an existing deeply nested recipe saves back unchanged', async () => {
    const { vault, writes } = fakeVault({});
    const r = recipe({ filePath: 'Regional/Italian/Pasta/Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    await saveRecipeWithVaultAdapter(vault, r);
    expect(writes[0].path).toBe('Regional/Italian/Pasta/Lasagna.md');
  });

  it('H: saving produces no Food/Recipes path', async () => {
    const { vault, writes } = fakeVault({});
    const r = recipe({ filePath: 'Lasagna.md', fileName: 'Lasagna.md', title: 'Lasagna' });
    await saveRecipeWithVaultAdapter(vault, r);
    expect(writes[0].path.startsWith('Food/Recipes/')).toBe(false);
    expect(writes[0].path.startsWith('6 - Full Notes/Food/Recipes/')).toBe(false);
  });
});
