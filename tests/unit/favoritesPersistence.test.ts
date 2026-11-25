// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import type { ObsidianRecipe } from '../../src/types';
import { scanVaultMarkdown, saveRecipeWithVaultAdapter } from '../../src/application/vaultRecipe';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';

const BASE_MD = `---
title: "Carbonara"
cuisine: "Italian"
category: "Dinner"
tags:
  - food/recipes
  - italian
rating: 4
difficulty: Medium
servings: 4
prep_time: 10 mins
cook_time: 20 mins
source: "https://example.com/carbonara"
image: "cover.jpg"
isFavorite: true
---
# Carbonara
A classic.

## Ingredients
- 200g Pasta

## Instructions
1. Cook pasta.
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

function fakeVault(files: Record<string, string>) {
  const writes: { path: string; content: string }[] = [];
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
      delete store[path];
    },
    async exists(path: string) {
      return Object.prototype.hasOwnProperty.call(store, path);
    },
  };
  return { vault, writes, store };
}

describe('Favorites persistence (storage boundary)', () => {
  it('hydrates an existing persisted favorite (true)', () => {
    const parsed = parseObsidianRecipeMarkdown(BASE_MD, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.isFavorite).toBe(true);
  });

  it('hydrates an existing persisted non-favorite (false)', () => {
    const md = BASE_MD.replace('isFavorite: true', 'isFavorite: false');
    const parsed = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.isFavorite).toBe(false);
  });

  it('hydrates isFavorite near the end of a large YAML frontmatter block', () => {
    const largeTail = Array.from({ length: 200 }, (_, i) => `codex_field_${i}: value_${i}`).join('\n');
    const md = `---\ntitle: "Carbonara"\ncuisine: "Italian"\ncategory: "Dinner"\ntags:\n  - food/recipes\n${largeTail}\nisFavorite: true\n---\n# Carbonara\nClassic.\n\n## Ingredients\n- 200g Pasta\n\n## Instructions\n1. Cook pasta.\n`;
    const parsed = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.isFavorite).toBe(true);
  });

  it('hydrates legacy alias favorite: true', () => {
    const md = BASE_MD.replace('isFavorite: true', 'favorite: true');
    const parsed = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.isFavorite).toBe(true);
  });

  it('hydrates legacy alias starred: yes', () => {
    const md = BASE_MD.replace('isFavorite: true', 'starred: yes');
    const parsed = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.isFavorite).toBe(true);
  });

  it('round-trips favorite ON through serialize -> parse', () => {
    const parsed = parseObsidianRecipeMarkdown(BASE_MD, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.isFavorite).toBe(true);
    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    expect(serialized).toContain('isFavorite: true');
    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reparsed.isFavorite).toBe(true);
  });

  it('round-trips favorite OFF through serialize -> parse', () => {
    const md = BASE_MD.replace('isFavorite: true', 'isFavorite: false');
    const parsed = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reparsed.isFavorite).toBe(false);
  });

  it('preserves unrelated recipe fields across a favorite save', () => {
    const parsed = parseObsidianRecipeMarkdown(BASE_MD, 'Carbonara.md', 'Recipes/Carbonara.md');
    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reparsed.title).toBe('Carbonara');
    expect(reparsed.cuisine).toBe('Italian');
    expect(reparsed.category).toBe('Dinner');
    expect(reparsed.tags).toEqual(expect.arrayContaining(['food/recipes', 'italian']));
    expect(reparsed.rating).toBe(4);
    expect(reparsed.difficulty).toBe('Medium');
    expect(reparsed.servings).toBe(4);
    expect(reparsed.prepTime).toBe('10 mins');
    expect(reparsed.cookTime).toBe('20 mins');
    expect(reparsed.source).toBe('https://example.com/carbonara');
    expect(reparsed.image).toBe('cover.jpg');
    expect(reparsed.ingredients).toHaveLength(1);
    expect(reparsed.instructions).toHaveLength(1);
  });

  it('cleans legacy alias keys on write (single authoritative field)', () => {
    const md = BASE_MD.replace('isFavorite: true', 'favorite: true\nisFavorite: true');
    const parsed = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    // alias key should not be duplicated as a separate favorite field
    const favoriteKeys = serialized.match(/^favorite:/gm) || [];
    expect(favoriteKeys).toHaveLength(0);
    expect(serialized).toContain('isFavorite: true');
  });

  it('persists and reloads favorite through the vault adapter', async () => {
    const parsed = parseObsidianRecipeMarkdown(BASE_MD, 'Carbonara.md', 'Recipes/Carbonara.md');
    const r = recipe({ ...parsed, filePath: 'Recipes/Carbonara.md', fileName: 'Carbonara.md' });

    // Favorite ON
    const { vault, store } = fakeVault({});
    await saveRecipeWithVaultAdapter(vault, { ...r, isFavorite: true });
    const onReload = await scanVaultMarkdown(vault);
    expect(onReload.recipes[0].isFavorite).toBe(true);

    // Favorite OFF
    await saveRecipeWithVaultAdapter(vault, { ...r, isFavorite: false });
    const offReload = await scanVaultMarkdown(vault);
    expect(offReload.recipes[0].isFavorite).toBe(false);
  });

  it('preserves unrelated fields through vault adapter save/reload', async () => {
    const parsed = parseObsidianRecipeMarkdown(BASE_MD, 'Carbonara.md', 'Recipes/Carbonara.md');
    const r = recipe({ ...parsed, filePath: 'Recipes/Carbonara.md', fileName: 'Carbonara.md' });
    const { vault } = fakeVault({});
    await saveRecipeWithVaultAdapter(vault, r);
    const reloaded = await scanVaultMarkdown(vault);
    const rr = reloaded.recipes[0];
    expect(rr.title).toBe('Carbonara');
    expect(rr.cuisine).toBe('Italian');
    expect(rr.rating).toBe(4);
    expect(rr.servings).toBe(4);
    expect(rr.prepTime).toBe('10 mins');
    expect(rr.source).toBe('https://example.com/carbonara');
    expect(rr.ingredients).toHaveLength(1);
  });

  it('propagates write failures (no silent success)', async () => {
    const parsed = parseObsidianRecipeMarkdown(BASE_MD, 'Carbonara.md', 'Recipes/Carbonara.md');
    const r = recipe({ ...parsed, filePath: 'Recipes/Carbonara.md', fileName: 'Carbonara.md' });
    const failing: VaultAdapter = {
      async listMarkdownFiles() { return []; },
      async readText() { return ''; },
      async writeText() { throw new Error('disk full'); },
      async delete() { throw new Error('disk full'); },
      async exists() { return false; },
    };
    await expect(saveRecipeWithVaultAdapter(failing, r)).rejects.toThrow('disk full');
  });

  it('rapid toggles end in the final persisted state', async () => {
    const parsed = parseObsidianRecipeMarkdown(BASE_MD, 'Carbonara.md', 'Recipes/Carbonara.md');
    const r = recipe({ ...parsed, filePath: 'Recipes/Carbonara.md', fileName: 'Carbonara.md', isFavorite: false });
    const { vault } = fakeVault({});
    // simulate rapid ON then OFF
    await saveRecipeWithVaultAdapter(vault, { ...r, isFavorite: true });
    await saveRecipeWithVaultAdapter(vault, { ...r, isFavorite: false });
    const reloaded = await scanVaultMarkdown(vault);
    expect(reloaded.recipes[0].isFavorite).toBe(false);
  });
});
