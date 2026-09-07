/**
 * The Kitchen Codex — Application Recipe Vault Orchestration (Phase 4C3B).
 *
 * Small, platform-neutral orchestration helpers that sit on the `VaultAdapter`
 * port plus the core path/classification policies. These are the LIVE seam the
 * UI/bootstrap edge uses for recipe read/list, write, and delete.
 *
 * Each helper performs NO UI, NO platform/FileSystemHandle, NO browser global,
 * and NO React work. The caller (App.tsx bootstrap) supplies a concrete
 * `VaultAdapter`; everything here is expressed purely in the adapter contract +
 * core policies.
 *
 * These are the SINGLE sites where:
 *   - Markdown reading/classification is orchestrated (no duplication of
 *     scanVaultDirectory classification),
 *   - recipe path policy (`resolveRecipeVaultPath`) is applied on write/delete,
 *   - recipe serialization is invoked.
 */

import type { VaultAdapter } from './adapters/VaultAdapter';
import type { ObsidianRecipe, VaultNote, MealPlanDay, ShoppingCategoryGroup } from '../types';
import { classifyVaultMarkdown } from '../core/vaultClassification';
import { resolveRecipeVaultPath } from '../core/vaultPath';
import { serializeRecipeToObsidianMarkdown } from '../utils/markdownParser';

/** The aggregated result of reading + classifying every vault Markdown file. */
export interface VaultScanResult {
  recipes: ObsidianRecipe[];
  notes: VaultNote[];
  mealPlan?: MealPlanDay[];
  shoppingList?: ShoppingCategoryGroup[];
}

/**
 * Reads and classifies every Markdown file in the vault through the adapter.
 * Returns the aggregated recipes / notes / meal plan / shopping list. Recipes
 * carry `filePath` (vault-relative) but NO FileSystemHandle — that is intentional.
 */
export async function scanVaultMarkdown(vault: VaultAdapter): Promise<VaultScanResult> {
  const files = await vault.listMarkdownFiles();
  const recipes: ObsidianRecipe[] = [];
  const notes: VaultNote[] = [];
  let mealPlan: MealPlanDay[] | undefined;
  let shoppingList: ShoppingCategoryGroup[] | undefined;

  for (const file of files) {
    const markdown = await vault.readText(file.path);
    const classified = classifyVaultMarkdown({ path: file.path, name: file.name, markdown });
    if (classified.kind === 'recipe') {
      recipes.push(classified.recipe);
    } else if (classified.kind === 'note') {
      notes.push(classified.note);
    } else if (classified.kind === 'mealPlan') {
      mealPlan = classified.mealPlan;
    } else if (classified.kind === 'shoppingList') {
      shoppingList = classified.shoppingList;
    }
  }

  return { recipes, notes, mealPlan, shoppingList };
}

/**
 * Writes a recipe back to the vault through the adapter. The logical location is
 * `resolveRecipeVaultPath(recipe)` (vault-relative `filePath`), so a nested
 * recipe always writes back to its nested folder — never a root basename.
 */
export async function saveRecipeWithVaultAdapter(
  vault: VaultAdapter,
  recipe: ObsidianRecipe
): Promise<void> {
  const path = resolveRecipeVaultPath(recipe);
  const markdown = serializeRecipeToObsidianMarkdown(recipe);
  await vault.writeText(path, markdown);
}

/**
 * Deletes a recipe from the vault through the adapter at its vault-relative
 * `filePath`. A nested recipe is deleted at its nested path, never by basename.
 */
export async function deleteRecipeWithVaultAdapter(
  vault: VaultAdapter,
  recipe: ObsidianRecipe
): Promise<void> {
  await vault.delete(resolveRecipeVaultPath(recipe));
}
