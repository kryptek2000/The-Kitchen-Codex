/**
 * The Kitchen Codex — Canonical Recipe Identity + Vault Snapshot (v0.7 integrity).
 *
 * The canonical source of truth is Obsidian Markdown. A recipe's canonical identity
 * is its VAULT-RELATIVE PATH, NOT its basename. Without this, two recipes in
 * different folders with the same basename (e.g. `A/Dish.md` and `B/Dish.md`) would
 * be treated as the same recipe, so an edit/delete could hit the WRONG record.
 *
 * POLICY (priority order):
 *   1. exact normalized vault-relative `filePath` when either side has one — a record
 *      that carries a path NEVER matches a different baseline name;
 *   2. `id` when neither side has a vault path (disconnected/generated pre-save);
 *   3. basename (fileName) ONLY as a last resort when no stronger identity exists and
 *      no path is present (cannot affect connected-vault records).
 *
 * THIS FACILITY NEVER COLLAPSES DIFFERENT DIRECTORIES. It is reused by the app for
 * update/delete and by generated-save insertion, and it is unit-testable.
 */

import type { ObsidianRecipe, VaultNote, MealPlanDay, ShoppingCategoryGroup } from '../types';

type RecipeIdentity = Pick<ObsidianRecipe, 'filePath' | 'fileName' | 'id'>;

/** Normalizes a path to clean, vault-relative form (forward slashes, no leading '/'). */
export function normalizeCanonicalPath(path: string | undefined): string {
  return (path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

/**
 * True when two recipes are THE SAME canonical record. Prefers exact vault-relative
 * path equality; never collapses equal basenames in different directories.
 */
export function sameCanonicalRecipeIdentity(a: RecipeIdentity, b: RecipeIdentity): boolean {
  const aPath = normalizeCanonicalPath(a.filePath);
  const bPath = normalizeCanonicalPath(b.filePath);
  if (aPath || bPath) {
    // A path-bearing record is only itself an exact-path match. A basename match
    // between two different paths (A/Dish.md vs B/Dish.md) is NOT a match.
    return aPath !== '' && aPath === bPath;
  }
  if (a.id && b.id) {
    return a.id === b.id;
  }
  return Boolean(a.fileName && b.fileName) && normalizeCanonicalPath(a.fileName) === normalizeCanonicalPath(b.fileName);
}

/** Finds the recipe in `list` that is the SAME canonical record as `recipe`. */
export function findCanonicalRecipe(list: ObsidianRecipe[], recipe: RecipeIdentity): ObsidianRecipe | undefined {
  return list.find((r) => sameCanonicalRecipeIdentity(r, recipe));
}

/** Replaces the matching canonical record in `list` (by identity) or prepends it. */
export function upsertCanonicalRecipe(list: ObsidianRecipe[], recipe: ObsidianRecipe): ObsidianRecipe[] {
  const index = list.findIndex((r) => sameCanonicalRecipeIdentity(r, recipe));
  if (index >= 0) {
    const next = [...list];
    next[index] = recipe;
    return next;
  }
  return [recipe, ...list];
}

/** Removes the matching canonical record (by identity) from `list`. */
export function removeCanonicalRecipe(list: ObsidianRecipe[], recipe: RecipeIdentity): ObsidianRecipe[] {
  return list.filter((r) => !sameCanonicalRecipeIdentity(r, recipe));
}

/**
 * Reconciles an active canonical reference (selected/detail/cooking/editing base)
 * against a fresh canonical snapshot. Returns the fresh canonical object when the
 * record is still present, or `null` when it has been removed (clear the reference).
 */
export function reconcileActiveRecipe<T extends RecipeIdentity>(
  active: T | null | undefined,
  snapshot: ObsidianRecipe[]
): ObsidianRecipe | null {
  if (!active) return null;
  return findCanonicalRecipe(snapshot, active) ?? null;
}

/** Active canonical references that must be reconciled against a fresh snapshot. */
export interface VaultActiveRefs {
  selectedRecipe: ObsidianRecipe | null;
  cookingRecipe: { recipe: ObsidianRecipe; servings: number } | null;
  editingRecipe: ObsidianRecipe | null;
}

/** A successful canonical vault scan result (recipes/notes are authoritative). */
export interface ScannedVaultSnapshot {
  recipes: ObsidianRecipe[];
  notes: VaultNote[];
  mealPlan?: MealPlanDay[];
  shoppingList?: ShoppingCategoryGroup[];
}

/** The fully derived state after applying a successful canonical snapshot. */
export interface DerivedVaultSnapshotState {
  recipes: ObsidianRecipe[];
  notes: VaultNote[];
  mealPlan: MealPlanDay[];
  shoppingList: ShoppingCategoryGroup[];
  selectedRecipe: ObsidianRecipe | null;
  cookingRecipe: { recipe: ObsidianRecipe; servings: number } | null;
  editingRecipe: ObsidianRecipe | null;
}

/**
 * Derives the post-snapshot state from a SUCCESSFUL canonical vault scan.
 *
 * Canonical-truth rules:
 *   - a successful scan is authoritative: recipes/notes are REPLACED even when the
 *     result is empty (an empty scan means "the vault is empty", NOT "keep the old
 *     list");
 *   - absence of `Meal Plan.md` / `Shopping List.md` in the scan is authoritative ->
 *     clean empty state (never the previous vault's values);
 *   - every active canonical reference (selected/cooking/editing) is reconciled to
 *     the fresh record by vault-path identity, or cleared when it no longer exists.
 */
export function deriveVaultSnapshotState(
  scan: ScannedVaultSnapshot,
  active: VaultActiveRefs
): DerivedVaultSnapshotState {
  return {
    recipes: scan.recipes,
    notes: scan.notes,
    mealPlan: scan.mealPlan ?? [],
    shoppingList: scan.shoppingList ?? [],
    selectedRecipe: active.selectedRecipe ? reconcileActiveRecipe(active.selectedRecipe, scan.recipes) : null,
    cookingRecipe: active.cookingRecipe
      ? (() => {
          const fresh = reconcileActiveRecipe(active.cookingRecipe.recipe, scan.recipes);
          return fresh ? { recipe: fresh, servings: active.cookingRecipe.servings } : null;
        })()
      : null,
    editingRecipe: active.editingRecipe ? reconcileActiveRecipe(active.editingRecipe, scan.recipes) : null,
  };
}

/**
 * A minimal scan/connection generation guard (the same proven pattern as the
 * provider-status refresh and Create-for-Me session guard). Each canonical scan is
 * tagged with the generation active when it STARTED; a result is only applied if its
 * generation is STILL current. A slower older scan can never overwrite a newer
 * vault connection/scan (defect E). Truthful semantics: the stale result is ignored;
 * the underlying filesystem reads may still complete.
 */
export interface ScanGenerationGuard {
  /** Begins a new scan and returns its generation id (latest id wins). */
  begin(): number;
  /** True only when `generation` is the most recently begun scan. */
  isCurrent(generation: number): boolean;
}

export function createScanGenerationGuard(): ScanGenerationGuard {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    isCurrent(generation: number): boolean {
      return generation === current;
    },
  };
}

/** The result of an attempted accepted-snapshot persistence. */
export interface VaultAcceptedOutcome<T = void> {
  accepted: boolean;
  value?: T;
}

/**
 * Runs the accepted-snapshot commit, and only then the `persist` side effect, WHEN
 * AND ONLY WHEN the scan's generation is still current. A stale (superseded) scan is
 * never persisted; a failed scan never reaches here (the caller throws before).
 * Used by the connect flow so the indexDB active-vault handle is stored only after a
 * successfully accepted canonical snapshot.
 */
export async function applyAcceptedVaultSnapshot<T>(
  guard: ScanGenerationGuard,
  generation: number,
  commit: () => T,
  persist: () => Promise<void>
): Promise<VaultAcceptedOutcome<T>> {
  if (!guard.isCurrent(generation)) return { accepted: false };
  const value = commit();
  await persist();
  return { accepted: true, value };
}



