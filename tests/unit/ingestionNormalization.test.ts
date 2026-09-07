/**
 * The Kitchen Codex — Ingestion Path Normalization (Phase 4C3B).
 *
 * Verifies that upload/drop ingestion canonicalizes every incoming `filePath` to
 * ONE vault-root-relative convention (the same the VaultAdapter contract uses),
 * and that the drop-variant harmonization from Phase 4C3A is retained:
 * a dropped `mealplan.md` / `shoppinglist.md` still classifies as Meal Plan /
 * Shopping List.
 *
 * Uses lightweight File/entry doubles (no real DOM picker, no IndexedDB, no
 * browser data-transfer). Runs under the existing Vitest Node environment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseUploadedFileList, parseDroppedFilesAndFolders } from '../../src/utils/vaultFileSystem';
import { vaultAssets } from '../../src/utils/vaultAssets';

const RECIPE_MD = `---
title: Lasagna
cuisine: Italian
tags:
  - food/recipes
---
# Lasagna
## 🥘 Ingredients
- 1 cup flour
## 🍳 Instructions
1. Bake.
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

function uploadFile(name: string, webkitRelativePath: string, content: string) {
  return {
    name,
    webkitRelativePath,
    text: async () => content,
  } as unknown as File;
}

function fileEntry(name: string, content: string) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (cb: (file: File) => void) =>
      cb({ name, text: async () => content } as unknown as File),
  };
}

function dirEntry(name: string, children: any[]) {
  let served = false;
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (cb: (entries: any[]) => void) => {
        if (!served) {
          served = true;
          cb(children);
        } else {
          cb([]);
        }
      },
    }),
  };
}

function droppedDataTransfer(entry: any) {
  return {
    items: [{ webkitGetAsEntry: () => entry }],
    files: [],
  } as unknown as DataTransfer;
}

describe('upload/drop ingestion path normalization (Phase 4C3B)', () => {
  beforeEach(() => vaultAssets.clear());
  afterEach(() => vaultAssets.clear());

  it('upload path strips the selected root folder name to a vault-relative filePath', async () => {
    const files = [uploadFile('Lasagna.md', 'MyVault/Recipes/Italian/Lasagna.md', RECIPE_MD)];
    const result = await parseUploadedFileList(files as unknown as FileList);
    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0].filePath).toBe('Recipes/Italian/Lasagna.md');
    expect(result.recipes[0].fileName).toBe('Lasagna.md');
  });

  it('upload of a bare file (no folder) keeps it root-relative', async () => {
    const files = [uploadFile('Root Level.md', 'Root Level.md', RECIPE_MD)];
    const result = await parseUploadedFileList(files as unknown as FileList);
    expect(result.recipes[0].filePath).toBe('Root Level.md');
  });

  it('upload strips a repeated root prefix exactly once', async () => {
    const files = [uploadFile('Recipe.md', 'MyVault/MyVault/Recipe.md', RECIPE_MD)];
    const result = await parseUploadedFileList(files as unknown as FileList);
    expect(result.recipes[0].filePath).toBe('MyVault/Recipe.md');
  });

  it('upload rejects unsafe traversal paths (skipped, not escaped)', async () => {
    const files = [uploadFile('Evil.md', '../../escape.md', RECIPE_MD)];
    const result = await parseUploadedFileList(files as unknown as FileList);
    expect(result.recipes).toHaveLength(0);
  });

  it('dropped folder path is normalized to the inner vault-relative filePath', async () => {
    const root = dirEntry('DroppedFolder', [fileEntry('Pasta.md', RECIPE_MD)]);
    const result = await parseDroppedFilesAndFolders(droppedDataTransfer(root));
    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0].filePath).toBe('Pasta.md');
  });

  it('dropped nested folder path preserves the legitimate first-level recipe folder', async () => {
    const recipes = dirEntry('Recipes', [fileEntry('Italian.md', RECIPE_MD)]);
    const root = dirEntry('DroppedFolder', [recipes]);
    const result = await parseDroppedFilesAndFolders(droppedDataTransfer(root));
    expect(result.recipes).toHaveLength(1);
    // The known dropped root is stripped; the legitimate `Recipes` folder is kept.
    expect(result.recipes[0].filePath).toBe('Recipes/Italian.md');
  });

  it('dropped top-level single file stays root-relative', async () => {
    const result = await parseDroppedFilesAndFolders(
      droppedDataTransfer(fileEntry('Standalone.md', RECIPE_MD))
    );
    expect(result.recipes[0].filePath).toBe('Standalone.md');
  });

  it('REGRESSION: dropped mealplan.md classifies as Meal Plan (not a recipe)', async () => {
    const root = dirEntry('DroppedFolder', [fileEntry('mealplan.md', MEAL_PLAN_MD)]);
    const result = await parseDroppedFilesAndFolders(droppedDataTransfer(root));
    expect(result.recipes).toHaveLength(0);
    expect(result.mealPlan).toBeDefined();
    expect(result.mealPlan?.[0].dayName).toBe('Monday');
    expect(result.mealPlan?.[0].dinner?.recipeTitle).toBe('Lasagna');
  });

  it('REGRESSION: dropped shoppinglist.md classifies as Shopping List', async () => {
    const root = dirEntry('DroppedFolder', [fileEntry('shoppinglist.md', SHOPPING_LIST_MD)]);
    const result = await parseDroppedFilesAndFolders(droppedDataTransfer(root));
    expect(result.recipes).toHaveLength(0);
    expect(result.shoppingList).toBeDefined();
    expect(result.shoppingList?.[0].category).toBe('Produce');
  });
});
