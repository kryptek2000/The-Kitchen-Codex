import { describe, expect, it } from 'vitest';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import type { ObsidianRecipe } from '../../src/types';
import {
  rebaseRecipeOntoLatest,
  enqueueRecipeWrite,
  normalizeRecipeWriteKey,
} from '../../src/application/recipeWriteCoordination';

function recipe(partial: Partial<ObsidianRecipe>): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'Carbonara.md',
    filePath: 'Recipes/Carbonara.md',
    rawMarkdown: '',
    title: 'Carbonara',
    tags: ['food/recipes'],
    category: 'Dinner',
    cuisine: 'Italian',
    difficulty: 'Medium',
    rating: 4,
    servings: 4,
    ingredients: [{ original: '200g Pasta', name: 'Pasta', amount: 200, unit: 'g' }],
    instructions: [{ stepNumber: 1, text: 'Cook pasta.', timerMinutes: null, isCompleted: false }],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...partial,
  } as ObsidianRecipe;
}

const ORIGINAL_MD = `---
title: "Carbonara"
cuisine: "Italian"
category: "Dinner"
tags:
  - food/recipes
rating: 4
difficulty: Medium
servings: 4
---
# Carbonara
Classic.

## Ingredients
- 200g Pasta

## Instructions
1. Cook pasta.
`;

describe('recipe write coordination (deterministic)', () => {
  it('Test A: nutrition in-flight then favorite preserves both', async () => {
    const original = recipe({});
    const nutritionUpdated = recipe({
      nutrition: { calories: 500, protein: 20, carbohydrates: 60, fat: 15, servings: 4, source: 'user_defined', confidence: 'high' },
      calories: 500,
    });

    const chains = new Map<string, Promise<void>>();
    let committed = original;

    // Deferred nutrition write
    let releaseNutrition: () => void = () => {};
    const nutritionGate = new Promise<void>((res) => { releaseNutrition = res; });

    const favoriteBase = original; // favorite toggled before nutrition completes in UI? base has no nutrition
    const favoriteDesired = recipe({ isFavorite: true });

    const nutritionOp = enqueueRecipeWrite(chains, nutritionUpdated, async () => {
      await nutritionGate; // held
      const latest = committed;
      const toWrite = rebaseRecipeOntoLatest(latest, original, nutritionUpdated);
      committed = toWrite;
    });

    // Favorite queued while nutrition held
    const favoriteOp = enqueueRecipeWrite(chains, favoriteDesired, async () => {
      const latest = committed;
      const toWrite = rebaseRecipeOntoLatest(latest, favoriteBase, favoriteDesired);
      committed = toWrite;
    });

    releaseNutrition();
    await Promise.all([nutritionOp, favoriteOp]);

    const md = serializeRecipeToObsidianMarkdown(committed);
    const reloaded = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reloaded.isFavorite).toBe(true);
    expect(reloaded.nutrition?.calories).toBe(500);
    expect(reloaded.nutrition?.source).toBe('user_defined');
    expect(reloaded.rating).toBe(4);
    expect(reloaded.cuisine).toBe('Italian');
  });

  it('Test B: favorite in-flight then nutrition preserves both', async () => {
    const original = recipe({});
    const favoriteDesired = recipe({ isFavorite: true });

    const chains = new Map<string, Promise<void>>();
    let committed = original;

    let releaseFav: () => void = () => {};
    const favGate = new Promise<void>((res) => { releaseFav = res; });

    const nutritionUpdated = recipe({
      nutrition: { calories: 600, protein: 25, carbohydrates: 70, fat: 18, servings: 4, source: 'ai_estimate', confidence: 'medium' },
      calories: 600,
    });

    const favOp = enqueueRecipeWrite(chains, favoriteDesired, async () => {
      await favGate;
      const latest = committed;
      const toWrite = rebaseRecipeOntoLatest(latest, original, favoriteDesired);
      committed = toWrite;
    });

    const nutOp = enqueueRecipeWrite(chains, nutritionUpdated, async () => {
      const latest = committed;
      const toWrite = rebaseRecipeOntoLatest(latest, original, nutritionUpdated);
      committed = toWrite;
    });

    releaseFav();
    await Promise.all([favOp, nutOp]);

    const md = serializeRecipeToObsidianMarkdown(committed);
    const reloaded = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reloaded.isFavorite).toBe(true);
    expect(reloaded.nutrition?.calories).toBe(600);
    expect(reloaded.nutrition?.source).toBe('ai_estimate');
    expect(reloaded.rating).toBe(4);
  });

  it('Test C: failed older favorite does not erase newer OFF intent', async () => {
    const original = recipe({ isFavorite: false });

    const chains = new Map<string, Promise<void>>();
    let committed = original;

    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((res) => { releaseFirst = res; });

    const firstDesired = recipe({ isFavorite: true }); // ON
    const secondDesired = recipe({ isFavorite: false }); // OFF newer

    const errors: string[] = [];

    const firstOp = enqueueRecipeWrite(chains, firstDesired, async () => {
      await firstGate;
      try {
        throw new Error('disk full');
      } catch (e) {
        errors.push((e as Error).message);
        // simulate failed write: do NOT update committed
      }
    });

    const secondOp = enqueueRecipeWrite(chains, secondDesired, async () => {
      const latest = committed;
      const toWrite = rebaseRecipeOntoLatest(latest, original, secondDesired);
      committed = toWrite;
    });

    releaseFirst();
    await firstOp.catch(() => {});
    await secondOp;

    const md = serializeRecipeToObsidianMarkdown(committed);
    const reloaded = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reloaded.isFavorite).toBe(false);
    expect(errors).toEqual(['disk full']);
  });

  it('rebase preserves unrelated fields and applies intended changes', () => {
    const latest = recipe({ isFavorite: true, rating: 5, nutrition: { calories: 700, source: 'user_defined', confidence: 'high' } });
    const base = recipe({ isFavorite: false, rating: 4 });
    const desired = recipe({ isFavorite: true, rating: 4, cuisine: 'French' });
    const rebased = rebaseRecipeOntoLatest(latest, base, desired);
    expect(rebased.isFavorite).toBe(true);
    expect(rebased.rating).toBe(5); // preserved from latest (not changed by desired)
    expect(rebased.cuisine).toBe('French'); // applied
    expect(rebased.nutrition?.calories).toBe(700); // preserved
  });

  it('separate recipes use independent queues', async () => {
    const r1 = recipe({ id: 'a', filePath: 'Recipes/A.md', fileName: 'A.md', title: 'A' });
    const r2 = recipe({ id: 'b', filePath: 'Recipes/B.md', fileName: 'B.md', title: 'B' });
    expect(normalizeRecipeWriteKey(r1)).not.toBe(normalizeRecipeWriteKey(r2));
    const chains = new Map<string, Promise<void>>();
    let order: string[] = [];
    const p1 = enqueueRecipeWrite(chains, r1, async () => { order.push('A'); });
    const p2 = enqueueRecipeWrite(chains, r2, async () => { order.push('B'); });
    await Promise.all([p1, p2]);
    expect(order).toContain('A');
    expect(order).toContain('B');
  });
});
