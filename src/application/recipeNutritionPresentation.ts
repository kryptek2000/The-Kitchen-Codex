/** Read-only nutrition presentation for the recipe editor. */
import { resolveRecipeNutritionPresentation } from '../core/nutritionV2/phase5c/presentation';
import type { ObsidianRecipe } from '../types';

export function hasPreferredAdvancedNutrition(recipe: ObsidianRecipe): boolean {
  return resolveRecipeNutritionPresentation(recipe).advanced_preferred;
}
