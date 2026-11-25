import { describe, expect, it } from 'vitest';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import type { ObsidianRecipe } from '../../src/types';
import { rebaseRecipeOntoLatest } from '../../src/application/recipeWriteCoordination';

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
    ingredients: [],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...partial,
  } as ObsidianRecipe;
}

const MD_RATED = `---
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
`;

describe('Ratings persistence (storage boundary)', () => {
  it('hydrates an existing rating', () => {
    const parsed = parseObsidianRecipeMarkdown(MD_RATED, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.rating).toBe(4);
  });

  it('hydrates an unrated recipe as 0 when rating: 0 is persisted', () => {
    const md = MD_RATED.replace('rating: 4', 'rating: 0');
    const parsed = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.rating).toBe(0);
  });

  it('treats legacy recipes without a rating field as unrated (0)', () => {
    const md = MD_RATED.replace('rating: 4\n', '');
    const parsed = parseObsidianRecipeMarkdown(md, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(parsed.rating).toBe(0);
  });

  it('round-trips a cleared rating (0) through serialize -> parse', () => {
    const parsed = parseObsidianRecipeMarkdown(MD_RATED, 'Carbonara.md', 'Recipes/Carbonara.md');
    const cleared = { ...parsed, rating: 0 };
    const serialized = serializeRecipeToObsidianMarkdown(cleared);
    expect(serialized).toContain('rating: 0');
    const reloaded = parseObsidianRecipeMarkdown(serialized, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reloaded.rating).toBe(0);
  });

  it('round-trips an updated rating', () => {
    const parsed = parseObsidianRecipeMarkdown(MD_RATED, 'Carbonara.md', 'Recipes/Carbonara.md');
    const updated = { ...parsed, rating: 2 };
    const serialized = serializeRecipeToObsidianMarkdown(updated);
    const reloaded = parseObsidianRecipeMarkdown(serialized, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reloaded.rating).toBe(2);
  });

  it('preserves unrelated fields across a rating save', () => {
    const parsed = parseObsidianRecipeMarkdown(MD_RATED, 'Carbonara.md', 'Recipes/Carbonara.md');
    const updated = { ...parsed, rating: 1 };
    const serialized = serializeRecipeToObsidianMarkdown(updated);
    const reloaded = parseObsidianRecipeMarkdown(serialized, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reloaded.title).toBe('Carbonara');
    expect(reloaded.cuisine).toBe('Italian');
    expect(reloaded.rating).toBe(1);
    expect(reloaded.servings).toBe(4);
  });

  it('serializes an explicitly selected five-star rating', () => {
    const parsed = parseObsidianRecipeMarkdown(MD_RATED.replace('rating: 4', ''), 'Carbonara.md', 'Recipes/Carbonara.md');
    // MD_RATED without rating defaults to 0/unrated; simulate explicit user selection.
    const selected = { ...parsed, rating: 5, ratingExplicit: true } as any;
    const serialized = serializeRecipeToObsidianMarkdown(selected);
    expect(serialized).toContain('rating: 5');
    const reloaded = parseObsidianRecipeMarkdown(serialized, 'Carbonara.md', 'Recipes/Carbonara.md');
    expect(reloaded.rating).toBe(5);
  });

  it('does not materialize a fabricated five on an unrelated save', () => {
    const parsed = parseObsidianRecipeMarkdown(MD_RATED.replace('rating: 4', ''), 'Carbonara.md', 'Recipes/Carbonara.md');
    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    expect(serialized).not.toContain('rating: 5');
  });

  it('rebase preserves a concurrent favorite when rating changes', () => {
    const latest = recipe({ isFavorite: true, rating: 4 });
    const base = recipe({ isFavorite: false, rating: 4 });
    const desired = recipe({ isFavorite: false, rating: 2 });
    const rebased = rebaseRecipeOntoLatest(latest, base, desired);
    expect(rebased.rating).toBe(2);
    expect(rebased.isFavorite).toBe(true);
  });

  it('rebase preserves a concurrent rating when favorite changes', () => {
    const latest = recipe({ isFavorite: false, rating: 5 });
    const base = recipe({ isFavorite: false, rating: 4 });
    const desired = recipe({ isFavorite: true, rating: 4 });
    const rebased = rebaseRecipeOntoLatest(latest, base, desired);
    expect(rebased.isFavorite).toBe(true);
    expect(rebased.rating).toBe(5);
  });
});
