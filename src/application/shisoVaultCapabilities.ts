/**
 * SHISO application capability: bounded, read-only access to the active Vault.
 *
 * This module deliberately accepts only application-owned recipe snapshots. It
 * never opens a directory, reads a file, writes a file, or exposes raw
 * Markdown/frontmatter to the model. The App shell supplies the live snapshot
 * and the current Vault session identity; switching sessions invalidates the
 * retained selection automatically.
 */

import type { ObsidianRecipe } from '../types';
import { adaptRecipe } from '../core/nutritionV2/phase4';

export type ShisoVaultSource = 'personal' | 'imported' | 'starter';

export interface ShisoVaultIdentity {
  readonly id: string;
  readonly source: ShisoVaultSource;
}
export interface ShisoVaultStatus {
  readonly vault_id: string;
  readonly source: ShisoVaultSource;
  readonly recipe_count: number;
  readonly note_count: number;
  readonly connected: boolean;
}

export interface ShisoVaultRecipeSummary {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly cuisine: string;
  readonly tags: readonly string[];
  readonly servings: number | null;
  readonly difficulty: string;
  readonly matched_fields: readonly string[];
}

export interface ShisoVaultRecipeDetail extends ShisoVaultRecipeSummary {
  readonly file_name: string;
  readonly file_path: string;
  readonly description: string;
  readonly ingredients: readonly {
    readonly text: string;
    readonly name: string;
    readonly amount?: number | null;
    readonly unit?: string;
    readonly preparation?: string;
    readonly line_ref?: string;
  }[];
  readonly instructions: readonly { readonly text: string; readonly step_ref: string }[];
  readonly instructions_total: number;
  readonly instructions_truncated: boolean;
  readonly metadata: Readonly<Record<string, string>>;
  readonly prepTime?: string;
  readonly cookTime?: string;
  readonly totalTime?: string;
}

export interface ShisoVaultSearchRequest {
  readonly query: string;
  readonly field?: 'all' | 'title' | 'ingredient' | 'category' | 'metadata';
  readonly limit?: number;
}

export interface ShisoVaultSearchResult {
  readonly query: string;
  readonly field: 'all' | 'title' | 'ingredient' | 'category' | 'metadata';
  readonly results: readonly ShisoVaultRecipeSummary[];
  readonly total_matches: number;
  readonly truncated: boolean;
}

export interface ShisoVaultSelection {
  readonly vault_id: string;
  readonly recipe_id: string;
  readonly title: string;
}

export interface ShisoVaultCapability {
  readonly getStatus: () => ShisoVaultStatus;
  readonly searchRecipes: (request: ShisoVaultSearchRequest, signal?: AbortSignal) => ShisoVaultSearchResult;
  readonly getRecipe: (recipeId: string) => ShisoVaultRecipeDetail | null;
  readonly selectRecipe: (recipeId: string) => ShisoVaultSelection | null;
  readonly getSelectedRecipe: () => ShisoVaultRecipeDetail | null;
}

export interface ShisoVaultCapabilitySource {
  readonly getRecipes: () => readonly ObsidianRecipe[];
  readonly getNoteCount: () => number;
  readonly getIdentity: () => ShisoVaultIdentity;
  /** Optional shell handoff for later write/review ports. */
  readonly onSelectRecipe?: (recipe: ObsidianRecipe) => void;
}

const MAX_SEARCH_QUERY_CHARS = 160;
const MAX_RESULTS = 20;
const MAX_INGREDIENTS = 80;
const MAX_INSTRUCTIONS = 60;
const MAX_TEXT_CHARS = 400;
const MAX_METADATA_CHARS = 120;

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function parseServings(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return null;
}

function recipeMetadata(recipe: ObsidianRecipe): Readonly<Record<string, string>> {
  return Object.freeze({
    category: boundedText(recipe.category, MAX_METADATA_CHARS),
    cuisine: boundedText(recipe.cuisine, MAX_METADATA_CHARS),
    difficulty: boundedText(recipe.difficulty, MAX_METADATA_CHARS),
    prep_time: boundedText(recipe.prepTime, MAX_METADATA_CHARS),
    cook_time: boundedText(recipe.cookTime, MAX_METADATA_CHARS),
    total_time: boundedText(recipe.totalTime, MAX_METADATA_CHARS),
    tags: recipe.tags.slice(0, 20).map((tag) => boundedText(tag, 60)).filter(Boolean).join(', '),
    rating: Number.isFinite(recipe.rating) ? String(recipe.rating) : '',
  });
}

function summaryOf(recipe: ObsidianRecipe, matchedFields: readonly string[] = []): ShisoVaultRecipeSummary {
  return Object.freeze({
    id: boundedText(recipe.id, 240),
    title: boundedText(recipe.title, 200),
    category: boundedText(recipe.category, MAX_METADATA_CHARS),
    cuisine: boundedText(recipe.cuisine, MAX_METADATA_CHARS),
    tags: Object.freeze(recipe.tags.slice(0, 20).map((tag) => boundedText(tag, 60)).filter(Boolean)),
    servings: parseServings(recipe.servings),
    difficulty: boundedText(recipe.difficulty, MAX_METADATA_CHARS),
    matched_fields: Object.freeze([...matchedFields]),
  });
}

function lineRefsOf(recipe: ObsidianRecipe): readonly string[] {
  try {
    const adaptation = adaptRecipe(recipe);
    return adaptation.ok ? adaptation.recipe.adapted.map((entry) => entry.line_ref) : [];
  } catch {
    return [];
  }
}

function detailOf(recipe: ObsidianRecipe, matchedFields: readonly string[] = []): ShisoVaultRecipeDetail {
  const lineRefs = lineRefsOf(recipe);
  return Object.freeze({
    ...summaryOf(recipe, matchedFields),
    file_name: boundedText(recipe.fileName, 240),
    file_path: boundedText(recipe.filePath, 500),
    description: boundedText(recipe.description, MAX_TEXT_CHARS),
    ingredients: Object.freeze(recipe.ingredients.slice(0, MAX_INGREDIENTS).map((ingredient, index) => Object.freeze({
      text: boundedText(ingredient.original || [ingredient.amount, ingredient.unit, ingredient.name].filter(Boolean).join(' '), MAX_TEXT_CHARS),
      name: boundedText(ingredient.name, 160),
      ...(typeof ingredient.amount === 'number' || ingredient.amount === null ? { amount: ingredient.amount } : {}),
      ...(typeof ingredient.unit === 'string' ? { unit: boundedText(ingredient.unit, 40) } : {}),
      ...(typeof ingredient.note === 'string' && ingredient.note.trim() ? { preparation: boundedText(ingredient.note, 160) } : {}),
      ...(typeof lineRefs[index] === 'string' ? { line_ref: lineRefs[index] } : {}),
    }))),
    instructions: Object.freeze(recipe.instructions.slice(0, MAX_INSTRUCTIONS).map((step, index) => Object.freeze({
      text: boundedText(step.text, MAX_TEXT_CHARS),
      step_ref: `step:${index}`,
    }))),
    instructions_total: recipe.instructions.length,
    instructions_truncated: recipe.instructions.length > MAX_INSTRUCTIONS || recipe.instructions.some((step) => step.text.length > MAX_TEXT_CHARS),
    metadata: recipeMetadata(recipe),
    ...(boundedText(recipe.prepTime, 40) ? { prepTime: boundedText(recipe.prepTime, 40) } : {}),
    ...(boundedText(recipe.cookTime, 40) ? { cookTime: boundedText(recipe.cookTime, 40) } : {}),
    ...(boundedText(recipe.totalTime, 40) ? { totalTime: boundedText(recipe.totalTime, 40) } : {}),
  });
}

function searchableFields(recipe: ObsidianRecipe): Readonly<Record<'title' | 'ingredient' | 'category' | 'metadata', string>> {
  return {
    title: [recipe.title].join(' ').toLowerCase(),
    ingredient: recipe.ingredients.map((ingredient) => [ingredient.name, ingredient.original].filter(Boolean).join(' ')).join(' ').toLowerCase(),
    category: [recipe.category, recipe.cuisine].join(' ').toLowerCase(),
    metadata: [
      recipe.tags.join(' '),
      recipe.description,
      recipe.notes,
      recipe.difficulty,
      recipe.prepTime,
      recipe.cookTime,
      recipe.totalTime,
      recipe.fileName,
    ].filter(Boolean).join(' ').toLowerCase(),
  };
}

export function createShisoVaultCapability(source: ShisoVaultCapabilitySource): ShisoVaultCapability {
  let selected: { readonly vaultId: string; readonly vaultSource: ShisoVaultSource; readonly recipeId: string } | null = null;

  const currentIdentity = (): ShisoVaultIdentity => source.getIdentity();
  const currentRecipes = (): readonly ObsidianRecipe[] => source.getRecipes();

  const clearStaleSelection = (): void => {
    const identity = currentIdentity();
    if (selected !== null && (selected.vaultId !== identity.id || selected.vaultSource !== identity.source)) selected = null;
  };

  const findRecipe = (recipeId: string): ObsidianRecipe | null => {
    const normalized = boundedText(recipeId, 240);
    if (!normalized) return null;
    return currentRecipes().find((recipe) => recipe.id === normalized) ?? null;
  };

  return Object.freeze({
    getStatus: (): ShisoVaultStatus => {
      const identity = currentIdentity();
      return Object.freeze({
        vault_id: identity.id,
        source: identity.source,
        recipe_count: currentRecipes().length,
        note_count: Math.max(0, Math.floor(source.getNoteCount())),
        connected: identity.source !== 'starter',
      });
    },
    searchRecipes: (request: ShisoVaultSearchRequest, signal?: AbortSignal): ShisoVaultSearchResult => {
      const query = boundedText(request.query, MAX_SEARCH_QUERY_CHARS).toLowerCase();
      const field = request.field ?? 'all';
      const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(request.limit ?? MAX_RESULTS)));
      if (signal?.aborted) return Object.freeze({ query, field, results: [], total_matches: 0, truncated: false });
      if (!query) return Object.freeze({ query, field, results: [], total_matches: 0, truncated: false });
      const results: ShisoVaultRecipeSummary[] = [];
      for (const recipe of currentRecipes()) {
        if (signal?.aborted) break;
        const fields = searchableFields(recipe);
        const matched = (Object.keys(fields) as Array<keyof typeof fields>)
          .filter((key) => field === 'all' || field === key)
          .filter((key) => fields[key].includes(query));
        if (matched.length === 0) continue;
        results.push(summaryOf(recipe, matched));
      }
      return Object.freeze({
        query,
        field,
        results: Object.freeze(results.slice(0, limit)),
        total_matches: results.length,
        truncated: results.length > limit,
      });
    },
    getRecipe: (recipeId: string): ShisoVaultRecipeDetail | null => {
      const recipe = findRecipe(recipeId);
      return recipe === null ? null : detailOf(recipe);
    },
    selectRecipe: (recipeId: string): ShisoVaultSelection | null => {
      clearStaleSelection();
      const identity = currentIdentity();
      const recipe = findRecipe(recipeId);
      if (recipe === null) return null;
      selected = { vaultId: identity.id, vaultSource: identity.source, recipeId: recipe.id };
      source.onSelectRecipe?.(recipe);
      return Object.freeze({ vault_id: identity.id, recipe_id: recipe.id, title: boundedText(recipe.title, 200) });
    },
    getSelectedRecipe: (): ShisoVaultRecipeDetail | null => {
      clearStaleSelection();
      if (selected === null) return null;
      const recipe = findRecipe(selected.recipeId);
      return recipe === null ? null : detailOf(recipe);
    },
  });
}
