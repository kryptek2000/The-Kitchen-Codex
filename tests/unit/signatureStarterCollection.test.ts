import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getSignatureStarterCount,
  getStarterVaultRecipes,
  isBuiltInRecipe,
  personalRecipesOnly,
  STARTER_MEAL_PLAN,
  STARTER_SHOPPING_CATEGORIES,
} from '../../src/data/starterVault';
import {
  buildSavedStarterCopy,
  findSavedStarterCopy,
  saveStarterRecipeToVault,
  starterRecipeSavePath,
} from '../../src/application/starterCollection';
import type { VaultAdapter } from '../../src/application/adapters/VaultAdapter';
import { parseObsidianRecipeMarkdown } from '../../src/utils/markdownParser';

const EXPECTED_TITLES = [
  'Artisan Sourdough Boule',
  'Thai Green Coconut Curry',
  'Tonkotsu Shoyu Ramen',
  'Classic Roman Carbonara',
  'Pan-Seared Lemon Herb Salmon',
  'Avocado Green Goddess Quinoa Salad',
  'Lemon Ricotta Pancakes with Blueberry Compote',
  'Smoky Chicken Tinga Tacos',
  'Dark Chocolate Espresso Lava Cakes',
];

class MemoryVault implements VaultAdapter {
  readonly files = new Map<string, string>();
  writes = 0;

  async listMarkdownFiles() {
    return [...this.files.keys()].map((path) => ({ path, name: path.split('/').pop() || path }));
  }
  async readText(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw new Error('missing');
    return value;
  }
  async writeText(path: string, content: string) {
    this.writes += 1;
    this.files.set(path, content);
  }
  async delete(path: string) {
    this.files.delete(path);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
}

function starters() {
  return getStarterVaultRecipes();
}

function starter(title: string) {
  const recipe = starters().find((item) => item.title === title);
  if (!recipe) throw new Error(`missing starter ${title}`);
  return recipe;
}

describe('Signature Nine collection membership', () => {
  it('contains exactly the approved nine titles in collection order', () => {
    const recipes = starters();
    expect(getSignatureStarterCount()).toBe(9);
    expect(recipes).toHaveLength(9);
    expect(recipes.map((recipe) => recipe.title)).toEqual(EXPECTED_TITLES);
    expect(new Set(recipes.map((recipe) => recipe.id)).size).toBe(9);
    expect(new Set(recipes.map((recipe) => recipe.builtInId)).size).toBe(9);
  });

  it('parses every recipe as a complete, usable Markdown note', () => {
    for (const recipe of starters()) {
      expect(recipe.isBuiltIn, recipe.title).toBe(true);
      expect(recipe.builtInId, recipe.title).toBeTruthy();
      expect(recipe.starterId, recipe.title).toBe(recipe.builtInId);
      expect(recipe.fileName.endsWith('.md'), recipe.title).toBe(true);
      expect(recipe.ingredients.length, recipe.title).toBeGreaterThan(3);
      expect(recipe.instructions.length, recipe.title).toBeGreaterThan(3);
      expect(recipe.servings, recipe.title).toBeGreaterThan(0);
      expect(recipe.prepTime, recipe.title).toBeTruthy();
      expect(recipe.cookTime, recipe.title).toBeTruthy();
      expect(recipe.difficulty, recipe.title).toMatch(/^(Easy|Medium|Hard)$/);
      expect(recipe.category, recipe.title).not.toBe('General');
      expect(recipe.cuisine, recipe.title).not.toBe('General');
      expect(recipe.image, recipe.title).toMatch(/^https:\/\/images\.unsplash\.com\//);
      expect(recipe.frontmatter?.image_license, recipe.title).toBe('Unsplash License');
      expect(recipe.frontmatter?.starter_collection, recipe.title).toBe('signature-nine');
      expect(recipe.nutrition, recipe.title).toBeUndefined();
      expect(recipe.calories, recipe.title).toBeUndefined();
    }
  });

  it('keeps the built-in collection available without a Vault and distinct from personal recipes', () => {
    const builtIns = starters();
    expect(personalRecipesOnly(builtIns)).toEqual([]);
    const copy = buildSavedStarterCopy(builtIns[0]);
    expect(copy.isBuiltIn).toBe(false);
    expect(copy.starterId).toBe(builtIns[0].builtInId);
    expect(personalRecipesOnly([...builtIns, copy])).toEqual([copy]);
  });
});

describe('Save to My Vault — explicit copy and duplicate protection', () => {
  it('copies exactly one recipe to the private Signature Collection folder', async () => {
    const vault = new MemoryVault();
    const builtIn = starter('Artisan Sourdough Boule');
    const result = await saveStarterRecipeToVault({ vault, builtIn, personalRecipes: [] });

    expect(result.status).toBe('saved');
    expect(result.recipe?.isBuiltIn).toBe(false);
    expect(result.recipe?.starterId).toBe(builtIn.builtInId);
    expect(result.recipe?.filePath).toBe(starterRecipeSavePath(builtIn));
    expect(result.recipe?.title).toBe(builtIn.title);
    expect(result.recipe?.image).toBe(builtIn.image);
    expect(result.recipe?.tags).toEqual(builtIn.tags);
    expect(result.recipe?.ingredients.length).toBe(builtIn.ingredients.length);
    expect(result.recipe?.instructions.length).toBe(builtIn.instructions.length);
    expect(vault.writes).toBe(1);
    expect(vault.files.has(starterRecipeSavePath(builtIn))).toBe(true);
    expect(vault.files.get(starterRecipeSavePath(builtIn))).toContain(`starter_id: ${builtIn.builtInId}`);
  });

  it('does not write a second copy when the provenance copy already exists', async () => {
    const vault = new MemoryVault();
    const builtIn = starter('Classic Roman Carbonara');
    const first = await saveStarterRecipeToVault({ vault, builtIn, personalRecipes: [] });
    expect(first.status).toBe('saved');
    const second = await saveStarterRecipeToVault({
      vault,
      builtIn,
      personalRecipes: first.recipe ? [first.recipe] : [],
    });
    expect(second.status).toBe('already_saved');
    expect(second.recipe?.filePath).toBe(first.recipe?.filePath);
    expect(vault.writes).toBe(1);
  });

  it('detects a manual same-title copy before writing', async () => {
    const vault = new MemoryVault();
    const builtIn = starter('Smoky Chicken Tinga Tacos');
    const manual = parseObsidianRecipeMarkdown('# Smoky Chicken Tinga Tacos\n', 'My Tacos.md', 'My Tacos.md');
    manual.title = 'Smoky Chicken Tinga Tacos';
    const result = await saveStarterRecipeToVault({ vault, builtIn, personalRecipes: [manual] });
    expect(result.status).toBe('already_saved');
    expect(vault.writes).toBe(0);
  });

  it('refuses to overwrite an unrelated file already at the target path', async () => {
    const vault = new MemoryVault();
    const builtIn = starter('Thai Green Coconut Curry');
    const target = starterRecipeSavePath(builtIn);
    vault.files.set(target, '---\ntitle: Not the starter\n---\n');
    const result = await saveStarterRecipeToVault({ vault, builtIn, personalRecipes: [] });
    expect(result.status).toBe('path_conflict');
    expect(vault.writes).toBe(0);
    expect(vault.files.get(target)).toContain('Not the starter');
  });

  it('reports unavailable when no writable Vault is connected', async () => {
    const builtIn = starter('Pan-Seared Lemon Herb Salmon');
    const result = await saveStarterRecipeToVault({ vault: null, builtIn, personalRecipes: [] });
    expect(result.status).toBe('unavailable');
    expect(result.message).toMatch(/connect a writable vault/i);
  });
});

describe('Saved copy lifecycle and data protection', () => {
  it('round-trips a customized saved copy without touching the built-in original', async () => {
    const vault = new MemoryVault();
    const builtIn = starter('Dark Chocolate Espresso Lava Cakes');
    const built = buildSavedStarterCopy(builtIn);
    const customized = { ...built, title: 'My Espresso Lava Cakes', rating: 4, notes: 'Bake 11 minutes.' };
    vault.files.set(customized.filePath, 'placeholder');
    // The saved copy's own serializer output is what a later edit would write.
    const markdown = (await import('../../src/utils/markdownParser')).serializeRecipeToObsidianMarkdown(customized);
    const reopened = parseObsidianRecipeMarkdown(markdown, customized.fileName, customized.filePath);

    expect(reopened.title).toBe('My Espresso Lava Cakes');
    expect(reopened.starterId).toBe(builtIn.builtInId);
    expect(reopened.isBuiltIn).toBeUndefined();
    expect(reopened.rating).toBe(4);
    // The built-in source is freshly parsed and never mirrors the customization.
    const freshBuiltIn = starter('Dark Chocolate Espresso Lava Cakes');
    expect(freshBuiltIn.title).toBe('Dark Chocolate Espresso Lava Cakes');
    expect(freshBuiltIn.notes).not.toContain('Bake 11 minutes.');
  });

  it('does not recreate a deleted personal copy automatically', async () => {
    const vault = new MemoryVault();
    const builtIn = starter('Avocado Green Goddess Quinoa Salad');
    const result = await saveStarterRecipeToVault({ vault, builtIn, personalRecipes: [] });
    expect(result.status).toBe('saved');
    await vault.delete(result.recipe!.filePath);
    expect(await vault.exists(result.recipe!.filePath)).toBe(false);
    const freshBuiltIns = starters();
    expect(freshBuiltIns).toHaveLength(9);
    expect(findSavedStarterCopy(freshBuiltIns, builtIn)).toBeUndefined();
  });

  it('keeps the starter demo meal plan and shopping list internally coherent', () => {
    const titles = new Set(starters().map((recipe) => recipe.title));
    for (const day of STARTER_MEAL_PLAN) {
      if (day.dinner?.recipeTitle) expect(titles.has(day.dinner.recipeTitle), day.dinner.recipeTitle).toBe(true);
    }
    for (const category of STARTER_SHOPPING_CATEGORIES) {
      for (const source of category.items.flatMap((item) => item.recipeSources || [])) {
        expect(titles.has(source), source).toBe(true);
      }
    }
  });

  it('keeps the shipped collection Markdown complete on disk', () => {
    const contents = readFileSync(join(__dirname, '../../src/data/signatureStarterCollection.ts'), 'utf8');
    expect(contents).toContain('SIGNATURE_STARTER_COLLECTION_VERSION');
    for (const title of EXPECTED_TITLES) expect(contents).toContain(`title: ${title}`);
  });
});
