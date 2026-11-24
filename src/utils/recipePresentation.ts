import type { ObsidianRecipe } from '../types';

/**
 * Presentation-only helpers shared by the featured spread and the recipe shelf.
 * They never add content that is not already stored on the recipe.
 */

const SYSTEM_TAG = 'food/recipes';

export interface VisibleRecipeTags {
  tags: string[];
  remaining: number;
}

export function visibleRecipeTags(tags: string[] | undefined, limit = 4): VisibleRecipeTags {
  const all = (tags || []).filter(Boolean);
  // `food/recipes` is a storage namespace, not a culinary descriptor. Keep it
  // only when it is the sole tag so the recipe still reports its real tags.
  const meaningful = all.filter((tag) => tag !== SYSTEM_TAG);
  const source = meaningful.length > 0 ? meaningful : all;
  return {
    tags: source.slice(0, limit),
    remaining: Math.max(0, source.length - limit),
  };
}

/**
 * The saved description, if the note actually has one. Notes, chef callouts and
 * other prose are deliberately NOT promoted into a description: that would
 * fabricate editorial copy the owner never wrote for this field.
 */
export function storedRecipeDescription(recipe: ObsidianRecipe): string {
  const canonical = typeof recipe.description === 'string' ? recipe.description.trim() : '';
  if (canonical) return canonical;
  const dataview = recipe.dataviewFields?.description || recipe.dataviewFields?.summary || '';
  return typeof dataview === 'string' ? dataview.trim() : '';
}
