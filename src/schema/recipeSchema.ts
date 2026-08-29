/**
 * The Kitchen Codex — Canonical Recipe Schema v1
 *
 * Defines the strict, validated canonical data contract for recipes while
 * preserving Obsidian local-first plain Markdown as the canonical storage truth.
 */

export const CURRENT_RECIPE_SCHEMA_VERSION = 1 as const;

export interface SchemaVersion {
  schemaVersion: 1;
}

export interface RecipeIdentity {
  /** Deterministic identifier (vault path or slug derived) */
  id: string;
  /** Primary human-readable title */
  title: string;
  /** Filename in vault with extension (e.g. "Tonkotsu Ramen.md") */
  fileName: string;
  /** Relative path within the Obsidian vault (e.g. "Recipes/Japanese/Tonkotsu Ramen.md") */
  filePath: string;
  /** Original provenance link if imported from web */
  sourceUrl?: string;
  /** Original recipe author / chef / publisher */
  author?: string;
  /** Freeform introductory prose / recipe summary */
  description?: string;
  /** ISO 8601 creation timestamp */
  createdAt?: string;
  /** ISO 8601 last modified timestamp */
  updatedAt?: string;
}

export interface RecipeTimings {
  /** Parsed prep time in integer minutes */
  prepMinutes: number | null;
  /** Parsed cook time in integer minutes */
  cookMinutes: number | null;
  /** Parsed total time in integer minutes */
  totalMinutes: number | null;
  /** Canonical display prep string (e.g. "15 mins") */
  prepTimeDisplay?: string;
  /** Canonical display cook string (e.g. "1 hr 15 mins") */
  cookTimeDisplay?: string;
  /** Canonical display total string (e.g. "1 hr 30 mins") */
  totalTimeDisplay?: string;
}

export interface StructuredIngredient {
  /** Full verbatim original ingredient string */
  raw: string;
  /** Normalized numeric amount (float or null) */
  amount: number | null;
  /** Canonical display string (e.g. "1 ½", "0.75", "2") */
  amountDisplay?: string;
  /** Standardized unit abbreviation (e.g. "tbsp", "tsp", "cup", "g", "ml", "oz", "pinch") */
  unit?: string;
  /** Normalized clean ingredient name */
  name: string;
  /** Preparation note/modifier (e.g. "diced", "sifted", "room temperature") */
  preparation?: string;
  /** Full raw Obsidian wikilink text if present (e.g. "[[Bread Flour|AP Flour]]") */
  wikilink?: string;
  /** Target note name in vault (e.g. "Bread Flour") */
  wikilinkTarget?: string;
  /** Custom alias in wikilink (e.g. "AP Flour") */
  wikilinkAlias?: string;
  /** Whether the ingredient is explicitly marked as optional */
  optional?: boolean;
  /** Checklist completion state in Markdown */
  isChecked?: boolean;
}

export interface StructuredStep {
  /** 1-based sequential step index */
  stepNumber: number;
  /** Step instruction markdown text */
  text: string;
  /** Extracted timer duration in minutes */
  timerMinutes?: number | null;
  /** Extracted timer label if detected */
  timerLabel?: string;
  /** Step-level callouts */
  callouts?: RecipeCallout[];
  /** Completed checkbox state */
  isCompleted?: boolean;
}

export type RecipeDifficulty = 'Easy' | 'Medium' | 'Hard' | 'Unspecified';

export interface RecipeMetadata {
  /** Normalized tag strings without leading '#' */
  tags: string[];
  /** Primary category / taxonomy */
  category: string;
  /** Cuisine tradition / region */
  cuisine: string;
  /** Meal course (e.g. "Dinner", "Dessert", "Breakfast") */
  course?: string;
  /** Cooking difficulty level */
  difficulty: RecipeDifficulty;
  /** User rating from 0 to 5 */
  rating: number;
  /** User favorite flag */
  isFavorite: boolean;
  /** Parsed yield count */
  servings: number | null;
  /** Yield descriptor (e.g. "servings", "cookies", "portions") */
  yieldUnit?: string;
  /** Hero image URL or local vault attachment path */
  image?: string;
}

export interface RecipeNutritionData {
  calories?: number | null;
  proteinGrams?: number | null;
  carbsGrams?: number | null;
  fatGrams?: number | null;
  fiberGrams?: number | null;
  sodiumMg?: number | null;
  servingSize?: string;
  source?: 'ai_estimate' | 'source_metadata' | 'user_defined';
  confidenceNote?: string;
}

export interface RecipeCallout {
  type: 'tip' | 'warning' | 'info' | 'note' | 'quote' | 'important';
  title?: string;
  content: string;
}

/**
 * Complete Canonical Recipe Document (Schema v1)
 */
export interface CanonicalRecipe extends SchemaVersion {
  identity: RecipeIdentity;
  metadata: RecipeMetadata;
  timings: RecipeTimings;
  ingredients: StructuredIngredient[];
  instructions: StructuredStep[];
  nutrition?: RecipeNutritionData;
  /** Freeform introductory body prose or recipe description */
  description?: string;
  /** Chef notes / tips section text */
  notes?: string;
  /** All document callouts */
  callouts: RecipeCallout[];
  /** Key-value pairs extracted from Obsidian Dataview inline annotations (`key:: value`) */
  dataviewFields: Record<string, string>;
  /** Preserved raw YAML frontmatter fields */
  frontmatter?: Record<string, any>;
  /** All extracted wikilinks in document */
  wikilinks: string[];
  /** Exact verbatim raw Markdown from disk */
  rawMarkdown: string;
}
