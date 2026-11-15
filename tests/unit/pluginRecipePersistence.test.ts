import { describe, expect, it, vi } from 'vitest';
import { saveValidatedRecipeWithVaultAdapter } from '../../src/application-ui/recipePersistence';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';
import type { AssetAdapter } from '../../src/application/adapters/AssetAdapter';
import type { ObsidianRecipe } from '../../src/types';

function fakeVault(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const writes: Array<{ path: string; content: string }> = [];
  const vault = {
    listMarkdownFiles: async () => [],
    readText: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    writeText: vi.fn(async (path: string, content: string) => {
      writes.push({ path, content });
      files.set(path, content);
    }),
    writeTextIfUnchanged: vi.fn(async (path: string, content: string, expected: string) => {
      if (files.get(path) !== expected) throw new Error('The recipe changed on disk since it was opened. The save was not applied.');
      writes.push({ path, content });
      files.set(path, content);
    }),
    exists: async (path: string) => files.has(path),
    delete: async (path: string) => {
      files.delete(path);
    },
  } as unknown as VaultAdapter;
  return { vault, files, writes };
}

function fakeAsset(existing: string[] = []) {
  const files = new Map(existing.map((path) => [path, new Uint8Array([1])]));
  const asset = {
    read: async (path: string) => files.get(path) ?? new Uint8Array(),
    write: async (path: string, bytes: Uint8Array) => {
      files.set(path, new Uint8Array(bytes));
    },
    exists: vi.fn(async (path: string) => files.has(path)),
    delete: async (path: string) => {
      files.delete(path);
    },
  } as unknown as AssetAdapter;
  return { asset, files };
}

function recipe(overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: 'plugin-recipe',
    fileName: 'Plugin Recipe.md',
    filePath: 'Plugin Recipe.md',
    title: 'Plugin Recipe',
    rawMarkdown: `---
title: Plugin Recipe
---
# Plugin Recipe

Custom plugin prose.

## Ingredients
- 1 cup stock

## Instructions
1. Simmer.
`,
    ingredients: [{ name: 'stock', original: '1 cup stock' }],
    instructions: [{ stepNumber: 1, text: 'Simmer.' }],
    tags: ['food/recipes'],
    ...overrides,
  } as ObsidianRecipe;
}

describe('R6 plugin recipe persistence boundary', () => {
  it('writes a normal plugin recipe with a valid local image', async () => {
    const { vault, writes, files } = fakeVault();
    const { asset } = fakeAsset(['Assets/plugin.png']);
    const target = recipe({
      image: 'Assets/plugin.png',
      description: 'Custom plugin prose.\n\n![plugin](Assets/plugin.png)',
    });
    await saveValidatedRecipeWithVaultAdapter(vault, target, { asset });
    expect(writes).toHaveLength(1);
    expect(files.get('Plugin Recipe.md')).toContain('image: Assets/plugin.png');
    expect(files.get('Plugin Recipe.md')).toContain('Custom plugin prose.');
    expect(files.get('Plugin Recipe.md')).toContain('## Ingredients');
  });

  it('rejects a plugin recipe with a foreign local image before writing', async () => {
    const { vault, writes } = fakeVault();
    const { asset } = fakeAsset([]);
    await expect(
      saveValidatedRecipeWithVaultAdapter(vault, recipe({ image: 'Assets/only-a.png' }), { asset })
    ).rejects.toThrow(/not present in the active Vault/i);
    expect(writes).toHaveLength(0);
  });

  it('rejects a plugin recipe with a case-variant blob image before writing', async () => {
    const { vault, writes } = fakeVault();
    const { asset } = fakeAsset([]);
    await expect(
      saveValidatedRecipeWithVaultAdapter(vault, recipe({ image: 'BLOB:foreign-preview' }), { asset })
    ).rejects.toThrow(/preview|owned/i);
    expect(writes).toHaveLength(0);
  });

  it('rejects a plugin recipe with an invalid raw Markdown body image before writing', async () => {
    const { vault, writes } = fakeVault();
    const { asset } = fakeAsset([]);
    const target = recipe({
      description: '![foreign](Assets/only-a.png)',
      rawMarkdown: `---
title: Plugin Recipe
---
# Plugin Recipe

![foreign](Assets/only-a.png)

## Ingredients
- 1 cup stock
`,
    });
    await expect(saveValidatedRecipeWithVaultAdapter(vault, target, { asset })).rejects.toThrow(
      /not present in the active Vault/i
    );
    expect(writes).toHaveLength(0);
  });

  it('refuses to overwrite an existing recipe that changed since it was opened', async () => {
    const { vault, files, writes } = fakeVault({ 'Plugin Recipe.md': 'different on-disk content' });
    const { asset } = fakeAsset([]);
    await expect(
      saveValidatedRecipeWithVaultAdapter(vault, recipe(), {
        asset,
        expectedMarkdown: 'original opened content',
      })
    ).rejects.toThrow(/changed on disk/i);
    expect(writes).toHaveLength(0);
    expect(files.get('Plugin Recipe.md')).toBe('different on-disk content');
  });

  it('refuses an unexpected overwrite when no expected content was supplied', async () => {
    const { vault, writes } = fakeVault({ 'Plugin Recipe.md': 'existing unrelated recipe' });
    const { asset } = fakeAsset([]);
    await expect(
      saveValidatedRecipeWithVaultAdapter(vault, recipe(), { asset })
    ).rejects.toThrow(/refusing to overwrite/i);
    expect(writes).toHaveLength(0);
  });

  it('rejects a plugin write when the captured session is no longer current', async () => {
    const { vault, writes } = fakeVault();
    const { asset } = fakeAsset([]);
    await expect(
      saveValidatedRecipeWithVaultAdapter(vault, recipe(), { asset, isCurrent: () => false })
    ).rejects.toThrow(/session changed/i);
    expect(writes).toHaveLength(0);
  });

  it('does not treat an existing selected recipe edit as a new-file overwrite', async () => {
    const original = recipe();
    const { vault, files, writes } = fakeVault({ 'Plugin Recipe.md': original.rawMarkdown });
    const { asset } = fakeAsset([]);
    await saveValidatedRecipeWithVaultAdapter(vault, recipe({ title: 'Renamed Plugin Recipe' }), {
      asset,
      expectedMarkdown: original.rawMarkdown,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('Plugin Recipe.md');
    expect(files.get('Plugin Recipe.md')).toContain('title: Renamed Plugin Recipe');
    expect(files.get('Plugin Recipe.md')).toContain('Custom plugin prose.');
  });
});
