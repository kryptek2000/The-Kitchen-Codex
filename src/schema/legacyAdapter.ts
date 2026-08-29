/**
 * The Kitchen Codex — Legacy Compatibility Adapter
 *
 * Provides bidirectional lossless conversion between the legacy ObsidianRecipe
 * application model and the Schema v1 CanonicalRecipe standard.
 */

import { ObsidianRecipe, ParsedIngredient, RecipeStep, ObsidianCallout } from '../types';
import { CanonicalRecipe, StructuredIngredient, StructuredStep, RecipeCallout } from './recipeSchema';
import { normalizeCanonicalRecipe } from './recipeValidator';

/**
 * Converts a CanonicalRecipe into the legacy ObsidianRecipe format used by UI components.
 */
export function canonicalToObsidianRecipe(
  canonical: CanonicalRecipe,
  fileHandle?: any
): ObsidianRecipe {
  const ingredients: ParsedIngredient[] = canonical.ingredients.map((ing) => ({
    original: ing.raw,
    amount: ing.amount,
    unit: ing.unit,
    name: ing.name,
    wikilink: ing.wikilink,
    wikilinkTarget: ing.wikilinkTarget,
    wikilinkAlias: ing.wikilinkAlias,
    note: ing.preparation,
    isChecked: ing.isChecked,
  }));

  const instructions: RecipeStep[] = canonical.instructions.map((step) => ({
    stepNumber: step.stepNumber,
    text: step.text,
    timerMinutes: step.timerMinutes,
    isCompleted: step.isCompleted,
  }));

  const callouts: ObsidianCallout[] = canonical.callouts.map((c) => ({
    type: c.type,
    title: c.title,
    content: c.content,
  }));

  // Difficulty conversion: if Unspecified, fallback to Medium for legacy type compat
  const difficulty: 'Easy' | 'Medium' | 'Hard' =
    canonical.metadata.difficulty === 'Unspecified' ? 'Medium' : canonical.metadata.difficulty;

  return {
    id: canonical.identity.id,
    fileName: canonical.identity.fileName,
    filePath: canonical.identity.filePath,
    rawMarkdown: canonical.rawMarkdown,
    title: canonical.identity.title,
    tags: canonical.metadata.tags,
    category: canonical.metadata.category,
    cuisine: canonical.metadata.cuisine,
    prepTime: canonical.timings.prepTimeDisplay,
    cookTime: canonical.timings.cookTimeDisplay,
    totalTime: canonical.timings.totalTimeDisplay,
    servings: canonical.metadata.servings ?? undefined,
    difficulty,
    rating: canonical.metadata.rating,
    calories: canonical.nutrition?.calories ?? undefined,
    nutrition: canonical.nutrition
      ? {
          calories: canonical.nutrition.calories ?? undefined,
          protein: canonical.nutrition.proteinGrams ?? undefined,
          carbohydrates: canonical.nutrition.carbsGrams ?? undefined,
          fat: canonical.nutrition.fatGrams ?? undefined,
          fiber: canonical.nutrition.fiberGrams ?? undefined,
          sodium: canonical.nutrition.sodiumMg ?? undefined,
          confidenceNote: canonical.nutrition.confidenceNote,
        }
      : undefined,
    source: canonical.identity.sourceUrl,
    image: canonical.metadata.image,
    ingredients,
    instructions,
    notes: canonical.notes,
    callouts,
    dataviewFields: canonical.dataviewFields,
    wikilinks: canonical.wikilinks,
    frontmatter: canonical.frontmatter,
    lastModified: canonical.identity.updatedAt,
    fileHandle,
    isFavorite: canonical.metadata.isFavorite,
  };
}

/**
 * Converts a legacy ObsidianRecipe into the strict Schema v1 CanonicalRecipe format.
 */
export function obsidianToCanonicalRecipe(legacy: ObsidianRecipe): CanonicalRecipe {
  const caloriesVal =
    typeof legacy.calories === 'number'
      ? legacy.calories
      : typeof legacy.calories === 'string'
      ? parseFloat(legacy.calories) || undefined
      : undefined;

  const nutrition = legacy.nutrition
    ? {
        calories: legacy.nutrition.calories ?? caloriesVal,
        proteinGrams: legacy.nutrition.protein,
        carbsGrams: legacy.nutrition.carbohydrates,
        fatGrams: legacy.nutrition.fat,
        fiberGrams: legacy.nutrition.fiber,
        sodiumMg: legacy.nutrition.sodium,
        confidenceNote: legacy.nutrition.confidenceNote,
      }
    : caloriesVal !== undefined
    ? {
        calories: caloriesVal,
      }
    : undefined;

  return normalizeCanonicalRecipe({
    identity: {
      id: legacy.id,
      title: legacy.title,
      fileName: legacy.fileName,
      filePath: legacy.filePath,
      sourceUrl: legacy.source,
      updatedAt: legacy.lastModified,
    },
    metadata: {
      tags: legacy.tags,
      category: legacy.category,
      cuisine: legacy.cuisine,
      difficulty: legacy.difficulty,
      rating: legacy.rating,
      isFavorite: Boolean(legacy.isFavorite),
      servings: legacy.servings ?? null,
      image: legacy.image,
    },
    prepTime: legacy.prepTime,
    cookTime: legacy.cookTime,
    totalTime: legacy.totalTime,
    ingredients: legacy.ingredients.map((ing) => ({
      raw: ing.original,
      amount: ing.amount ?? null,
      unit: ing.unit,
      name: ing.name,
      preparation: ing.note,
      wikilink: ing.wikilink,
      wikilinkTarget: ing.wikilinkTarget,
      wikilinkAlias: ing.wikilinkAlias,
      isChecked: ing.isChecked,
    })),
    instructions: legacy.instructions.map((step) => ({
      stepNumber: step.stepNumber,
      text: step.text,
      timerMinutes: step.timerMinutes ?? null,
      isCompleted: step.isCompleted,
    })),
    notes: legacy.notes,
    callouts: legacy.callouts,
    dataviewFields: legacy.dataviewFields,
    frontmatter: legacy.frontmatter,
    wikilinks: legacy.wikilinks,
    rawMarkdown: legacy.rawMarkdown,
    nutrition,
  });
}
