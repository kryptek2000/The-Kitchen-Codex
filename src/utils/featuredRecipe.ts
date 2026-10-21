/**
 * Deterministic featured-recipe selection for the Recipe Vault gallery.
 *
 * Rule (documented, no recommendation engine, no persisted pin):
 *   1. Prefer the first recipe (in the current sorted/filtered order) that is
 *      an eligible favorite (`isFavorite === true`).
 *   2. If no eligible favorite exists, fall back to the first recipe in the
 *      current sorted/filtered order (a stable existing recipe).
 *
 * Returns `undefined` when the collection is empty.
 */
export function selectFeaturedRecipe<T extends { id: string; isFavorite?: boolean }>(
  recipes: readonly T[]
): T | undefined {
  if (!recipes || recipes.length === 0) return undefined;
  const favorite = recipes.find((r) => r.isFavorite === true);
  return favorite ?? recipes[0];
}

export function splitFeatured<T extends { id: string; isFavorite?: boolean }>(
  recipes: readonly T[]
): { featured: T | undefined; rest: T[] } {
  const featured = selectFeaturedRecipe(recipes);
  if (!featured) return { featured: undefined, rest: [...recipes] };
  // Exclude only the selected instance, not every recipe sharing its id.
  const idx = recipes.indexOf(featured);
  const rest = recipes.filter((_, i) => i !== (idx >= 0 ? idx : 0));
  return { featured, rest };
}
