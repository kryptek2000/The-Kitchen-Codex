/**
 * The Kitchen Codex — Application Vault Content Orchestration (Phase 4C3C).
 *
 * Platform-neutral orchestration for vault CONTENT that is not a recipe:
 *   - loading all Markdown content via ONE adapter scan + an optional separate
 *     asset pass (so the connected runtime never runs a second Markdown scanner),
 *   - writing the Meal Plan and Shopping List special files through the adapter,
 *   - a tiny pure helper that turns an adapter failure into a user-facing message.
 *
 * No UI, no platform/FileSystemHandle, no browser global, no React work. The
 * caller (App bootstrap) supplies a concrete `VaultAdapter`; assets are an
 * injected callback so this module never imports a platform asset implementation.
 */

import type { VaultAdapter } from './adapters/VaultAdapter';
import type { MealPlanDay, ShoppingCategoryGroup } from '../types';
import { scanVaultMarkdown } from './vaultRecipe';
import type { VaultScanResult } from './vaultRecipe';
import { serializeMealPlanToMarkdown, serializeShoppingListToMarkdown } from '../utils/markdownParser';

/** Canonical vault-root-relative path of the Meal Plan special file (verified from legacy code). */
export const MEAL_PLAN_FILE_PATH = 'Meal Plan.md';

/** Canonical vault-root-relative path of the Shopping List special file (verified from legacy code). */
export const SHOPPING_LIST_FILE_PATH = 'Shopping List.md';

/**
 * The single connected-load orchestration: ONE adapter Markdown scan, then an
 * OPTIONAL separate asset-only pass. This is the same code path used by initial
 * connect, IndexedDB restore, window-focus refresh, and manual refresh — so the
 * connected runtime has exactly ONE Markdown scanner (`scanVaultMarkdown`).
 */
export async function loadVaultContent(
  vault: VaultAdapter,
  assetPass?: () => Promise<unknown>
): Promise<VaultScanResult> {
  const scan = await scanVaultMarkdown(vault);
  if (assetPass) await assetPass();
  return scan;
}

/**
 * Writes the Weekly Meal Plan to its canonical vault-root-relative path through
 * the adapter. Runs the EXACT path + serializer the legacy flow used (no new
 * name/location, no fallback hidden inside).
 */
export async function saveMealPlanWithVaultAdapter(
  vault: VaultAdapter,
  mealPlan: MealPlanDay[]
): Promise<void> {
  await vault.writeText(MEAL_PLAN_FILE_PATH, serializeMealPlanToMarkdown(mealPlan));
}

/**
 * Writes the Shopping List to its canonical vault-root-relative path through the
 * adapter (exact path + serializer the legacy flow used).
 */
export async function saveShoppingListWithVaultAdapter(
  vault: VaultAdapter,
  groups: ShoppingCategoryGroup[]
): Promise<void> {
  await vault.writeText(SHOPPING_LIST_FILE_PATH, serializeShoppingListToMarkdown(groups));
}

/**
 * Pure mapper from an adapter failure to a concise, user-facing message for the
 * lightweight in-app error surface. Never leaks the raw stack; keeps the detail
 * when the error carries a useful message.
 */
export function vaultErrorMessage(
  operation: 'save' | 'delete',
  label: string,
  err: unknown
): string {
  const detail =
    err && typeof (err as { message?: unknown }).message === 'string'
      ? ` — ${(err as { message: string }).message}`
      : '';
  return `Could not ${operation} ${label}${detail}.`;
}
