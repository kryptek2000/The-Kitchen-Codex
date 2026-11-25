/**
 * The Kitchen Codex — Vault Markdown Classification (Phase 4C3A).
 *
 * A PURE, platform-neutral helper that turns a single vault Markdown source into
 * an application vault record: recipe, ordinary note, meal plan, or shopping list.
 * It is the SINGLE source of truth for vault Markdown classification, extracted
 * from the inline logic previously duplicated across `scanVaultDirectory`,
 * `parseUploadedFileList`, and `parseDroppedFilesAndFolders`, so every consumer
 * classifies identically.
 *
 * It reuses the canonical markdown parser and performs NO filesystem, handle,
 * window, IndexedDB, vaultAssets, object-URL, React, server, or provider work.
 *
 * LOGICAL IDENTITY vs PLATFORM DETAIL:
 *   - The pure helper assigns the recipe/note's logical identity: `filePath`
 *     (vault-relative) and `fileName`. It NEVER attaches a `FileSystemHandle`
 *     (that is platform-specific, done separately by the browser scanner).
 *   - This separates logical recipe location from the browser handle optimization
 *     so a future runtime cutover can use VaultAdapter without losing subfolders.
 */

import type { ObsidianRecipe, VaultNote, MealPlanDay, ShoppingCategoryGroup } from '../types';
import {
  parseObsidianRecipeMarkdown,
  parseVaultNoteMarkdown,
  parseMealPlanFromMarkdown,
  parseShoppingListFromMarkdown,
} from '../utils/markdownParser';

/** A single vault Markdown source to classify. */
export interface VaultMarkdownSource {
  /** Vault-relative path (e.g. "Recipes/Italian/Lasagna.md"). */
  path: string;
  /** File name with extension (e.g. "Lasagna.md"). */
  name: string;
  /** Raw Markdown content. */
  markdown: string;
}

/** The classification result for a vault Markdown source. */
export type VaultMarkdownClassification =
  | { kind: 'recipe'; recipe: ObsidianRecipe }
  | { kind: 'note'; note: VaultNote }
  | { kind: 'mealPlan'; mealPlan: MealPlanDay[] }
  | { kind: 'shoppingList'; shoppingList: ShoppingCategoryGroup[] };

/** Meal Plan special filenames (lower-cased), matching the legacy scanner. */
const MEAL_PLAN_NAMES = ['meal plan.md', 'meal-plan.md', 'mealplan.md'] as const;

/** Shopping List special filenames (lower-cased), matching the legacy scanner. */
const SHOPPING_LIST_NAMES = [
  'shopping list.md',
  'shopping-list.md',
  'grocery list.md',
  'shoppinglist.md',
] as const;

/** Frontmatter fields that identify a recipe even before its sections are filled in. */
const RECIPE_FRONTMATTER_KEYS = [
  'cuisine',
  'category',
  'course',
  'servings',
  'difficulty',
  'prep_time',
  'prepTime',
  'cook_time',
  'cookTime',
  'total_time',
  'totalTime',
  'calories',
  'nutrition',
  'rating',
  'source',
  'url',
  'image',
  'cover',
  'thumbnail',
  'heroImage',
  'codex_nutrition',
  'starter_id',
  'starterId',
] as const;

function hasRecipeFrontmatter(recipe: ObsidianRecipe): boolean {
  const frontmatter = recipe.frontmatter ?? {};
  return RECIPE_FRONTMATTER_KEYS.some((key) => {
    const value = frontmatter[key];
    return value !== undefined && value !== null && value !== '';
  });
}

function hasTitleHeading(recipe: ObsidianRecipe): boolean {
  // A level-one title is the established minimal recipe form used by desktop
  // onboarding and existing title-only Vault files. H2+ section headings do
  // not qualify, so ordinary notes with no recipe shape stay notes.
  return /^#\s+\S.*$/m.test(recipe.rawMarkdown);
}

/**
 * Recipe-vs-note heuristic. The parser's `food/recipes` fallback is excluded
 * as a signal by itself, while minimal recipe documents retain their identity
 * through recipe frontmatter or a title heading.
 */
function isRecipe(recipe: ObsidianRecipe): boolean {
  // `food/recipes` is the parser's storage-namespace fallback when a note has
  // no tags. It must not turn every untagged Markdown note into a recipe.
  const semanticTags = recipe.tags.filter((tag) => tag.toLowerCase() !== 'food/recipes');
  const hasSyntheticFallbackTag =
    recipe.tags.length === 1 && recipe.tags[0].toLowerCase() === 'food/recipes';
  const hasMinimalRecipeShape =
    hasRecipeFrontmatter(recipe) || (hasSyntheticFallbackTag && hasTitleHeading(recipe));
  return (
    recipe.ingredients.length > 0 ||
    recipe.instructions.length > 0 ||
    semanticTags.some(
      (t) => t.toLowerCase().includes('recipe') || t.toLowerCase().includes('food')
    ) ||
    hasMinimalRecipeShape
  );
}

/**
 * Classifies a vault Markdown source. The result carries the canonical parsed
 * record (with `filePath`/`fileName` set) but NO platform handle.
 */
export function classifyVaultMarkdown(
  source: VaultMarkdownSource
): VaultMarkdownClassification {
  const lowerName = source.name.toLowerCase();

  if ((MEAL_PLAN_NAMES as readonly string[]).includes(lowerName)) {
    return { kind: 'mealPlan', mealPlan: parseMealPlanFromMarkdown(source.markdown) };
  }
  if ((SHOPPING_LIST_NAMES as readonly string[]).includes(lowerName)) {
    return { kind: 'shoppingList', shoppingList: parseShoppingListFromMarkdown(source.markdown) };
  }

  const recipe = parseObsidianRecipeMarkdown(source.markdown, source.name, source.path);
  if (isRecipe(recipe)) {
    return { kind: 'recipe', recipe };
  }

  const note = parseVaultNoteMarkdown(source.markdown, source.name, source.path);
  return { kind: 'note', note };
}
