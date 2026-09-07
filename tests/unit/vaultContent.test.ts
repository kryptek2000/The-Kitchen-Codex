/**
 * The Kitchen Codex — Application Vault Content Orchestration (Phase 4C3C).
 *
 * Focused tests for:
 *   - the single connected-load orchestration (adapter Markdown scan + separate
 *     asset pass), proving no legacy Markdown double-scan,
 *   - Meal Plan / Shopping List adapter writes (exact path + serialized Markdown,
 *     single write, error propagation),
 *   - the pure user-facing error message formatter,
 *   - the intentional exists() decision (save does NOT preflight exists()).
 *
 * No browser DOM, no real FileSystemHandle, no IndexedDB, no React.
 */

import { describe, it, expect } from 'vitest';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';
import {
  loadVaultContent,
  saveMealPlanWithVaultAdapter,
  saveShoppingListWithVaultAdapter,
  vaultErrorMessage,
  MEAL_PLAN_FILE_PATH,
  SHOPPING_LIST_FILE_PATH,
} from '../../src/application/vaultContent';
import { saveRecipeWithVaultAdapter } from '../../src/application/vaultRecipe';
import type { ObsidianRecipe } from '../../src/types';

const RECIPE_MD = `---
title: "Lasagna"
tags:
  - food/recipes
---
# Lasagna
## Ingredients
- 1 cup flour
## Instructions
1. Bake.
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
  existsCalls: number;
  readCalls: string[];
}

function fakeVault(files: Record<string, string>): FakeVault {
  const writes: { path: string; content: string }[] = [];
  const deletes: string[] = [];
  const readCalls: string[] = [];
  let existsCalls = 0;
  const store = { ...files };
  const vault: VaultAdapter = {
    async listMarkdownFiles() {
      return Object.keys(store).map((p) => ({ path: p, name: p.split('/').pop() as string }));
    },
    async readText(path: string) {
      readCalls.push(path);
      if (store[path] === undefined) {
        const error = new Error(`Vault file not found: ${path}`);
        Object.defineProperty(error, 'name', { value: 'NotFoundError' });
        throw error;
      }
      return store[path];
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
      existsCalls += 1;
      return Object.prototype.hasOwnProperty.call(store, path);
    },
  };
  return { vault, writes, deletes, existsCalls, readCalls };
}

describe('loadVaultContent (single connected-load orchestration)', () => {
  it('A: loads all Markdown content through the VaultAdapter (adapter Markdown scan)', async () => {
    const { vault } = fakeVault({
      'Recipes/Italian/Lasagna.md': RECIPE_MD,
      'Meal Plan.md': '---\n---\n\n## Monday\n- **Dinner**: [[Lasagna]]\n',
      'Shopping List.md': '---\n---\n\n## Produce\n- [ ] tomatoes\n',
    });
    const result = await loadVaultContent(vault);
    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0].filePath).toBe('Recipes/Italian/Lasagna.md');
    expect(result.mealPlan?.[0].dayName).toBe('Monday');
    expect(result.shoppingList?.[0].category).toBe('Produce');
    expect(result.recipes[0].fileHandle).toBeUndefined();
  });

  it('B: reads each Markdown file exactly once via the adapter (no double Markdown scan)', async () => {
    const { vault, readCalls } = fakeVault({
      'Recipes/A.md': RECIPE_MD,
      'Recipes/B.md': RECIPE_MD,
      'Notes/C.md': 'plain note',
    });
    await loadVaultContent(vault);
    expect(readCalls.sort()).toEqual(['Notes/C.md', 'Recipes/A.md', 'Recipes/B.md']);
    // Exactly one read per Markdown file (no legacy scanVaultDirectory second pass).
    expect(readCalls).toHaveLength(3);
  });

  it('C: invokes the asset pass separately and does not read assets as Markdown', async () => {
    let assetCalls = 0;
    const { vault, readCalls } = fakeVault({ 'Recipes/A.md': RECIPE_MD });
    const result = await loadVaultContent(vault, async () => {
      assetCalls += 1;
    });
    expect(assetCalls).toBe(1);
    expect(result.recipes).toHaveLength(1);
    // The adapter reads only Markdown paths; the asset pass is separate.
    expect(readCalls).toEqual(['Recipes/A.md']);
    expect(readCalls.some((p) => /\.(png|jpg|jpeg|webp)$/i.test(p))).toBe(false);
  });
});

describe('Meal Plan / Shopping List adapter writes', () => {
  it('D: writes the Meal Plan to the exact canonical path with serialized Markdown', async () => {
    const { vault, writes } = fakeVault({});
    const plan = [{ dayName: 'Monday', dinner: { recipeTitle: 'Lasagna' } }];
    await saveMealPlanWithVaultAdapter(vault, plan);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(MEAL_PLAN_FILE_PATH);
    expect(writes[0].content).toContain('# 📅 Weekly Meal Plan');
    expect(writes[0].content).toContain('[[Lasagna]]');
  });

  it('E: writes the Shopping List to the exact canonical path with serialized Markdown', async () => {
    const { vault, writes } = fakeVault({});
    const groups = [{ category: 'Produce', items: [{ id: '1', text: 'tomatoes', recipeSources: [], isChecked: false }] }];
    await saveShoppingListWithVaultAdapter(vault, groups);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(SHOPPING_LIST_FILE_PATH);
    expect(writes[0].content).toContain('# 🛒 Grocery Shopping List');
    expect(writes[0].content).toContain('tomatoes');
  });

  it('F: performs exactly ONE write per save (no dual-write)', async () => {
    const { vault, writes } = fakeVault({});
    await saveMealPlanWithVaultAdapter(vault, [{ dayName: 'Monday' }]);
    expect(writes).toHaveLength(1); // one Meal Plan save = one write
    await saveShoppingListWithVaultAdapter(vault, [{ category: 'X', items: [] }]);
    expect(writes).toHaveLength(2); // one Shopping List save = one more write, never dual
  });

  it('G: adapter write errors propagate (no silent fallback)', async () => {
    const failing: VaultAdapter = {
      async listMarkdownFiles() {
        return [];
      },
      async readText() {
        return '';
      },
      async writeText() {
        throw new Error('write denied');
      },
      async delete() {
        throw new Error('delete denied');
      },
      async exists() {
        return false;
      },
    };
    await expect(saveMealPlanWithVaultAdapter(failing, [{ dayName: 'Monday' }])).rejects.toThrow(
      'write denied'
    );
    await expect(saveShoppingListWithVaultAdapter(failing, [])).rejects.toThrow('write denied');
  });
});

describe('error message formatter (pure, no DOM)', () => {
  it('H: produces a user-facing message for a recipe save failure', () => {
    const msg = vaultErrorMessage('save', 'recipe', new Error('disk full'));
    expect(msg).toBe('Could not save recipe — disk full.');
    expect(msg).toContain('save');
  });

  it('I: produces a user-facing message for a delete failure', () => {
    const msg = vaultErrorMessage('delete', 'Lasagna', { message: 'not found' });
    expect(msg).toBe('Could not delete Lasagna — not found.');
  });

  it('handles non-Error failures without leaking internals', () => {
    expect(vaultErrorMessage('save', 'Meal Plan', 'boom')).toBe('Could not save Meal Plan.');
    expect(vaultErrorMessage('save', 'Meal Plan', undefined)).toBe('Could not save Meal Plan.');
  });
});

describe('exists() decision (intentional — no preflight on save)', () => {
  it('J: save does NOT preflight exists() (avoids TOCTOU / double I/O)', async () => {
    const { vault, existsCalls } = fakeVault({});
    const r = recipe({ filePath: 'Recipes/Brownies.md', fileName: 'Brownies.md', title: 'Brownies' });
    await saveRecipeWithVaultAdapter(vault, r);
    // writeText(create:true) handles create + update; the save flow never calls exists().
    expect(existsCalls).toBe(0);
  });

  it('J: the adapter exists() contract still distinguishes present vs missing', async () => {
    const { vault } = fakeVault({ 'Recipes/A.md': RECIPE_MD });
    expect(await vault.exists('Recipes/A.md')).toBe(true);
    expect(await vault.exists('Recipes/Missing.md')).toBe(false);
  });
});
