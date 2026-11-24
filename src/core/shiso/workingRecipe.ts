/**
 * The Kitchen Codex — SHISO H-2 working-recipe state (core).
 *
 * PURE, offline. The small, testable bookkeeping for Shiso's UNSAVED recipe
 * changes:
 *
 *   - `extendWorkingRecipe` folds a batch of applied edits into the working
 *     copy, accumulating the bounded change account and the per-edit undo
 *     ledger;
 *   - `undoLastWorkingEdit` restores the ingredient the LAST edit replaced.
 *
 * It holds no authority of its own: it never writes, never persists, never
 * talks to a model or a vault. The application shell owns the state and the
 * canonical save path.
 */

/** One undo record: which ingredient index changed, and what it was before. */
export interface ShisoWorkingRecipeHistoryEntry<TIngredient> {
  readonly index: number;
  readonly previous: TIngredient;
}

/** The bounded working-copy value the shell renders and publishes. */
export interface ShisoWorkingRecipeCore<TRecipe, TIngredient> {
  readonly base: TRecipe;
  readonly working: TRecipe;
  /** Human-readable "before → after" lines, oldest first (bounded by caller). */
  readonly changes: readonly string[];
  readonly history: readonly ShisoWorkingRecipeHistoryEntry<TIngredient>[];
}

/** The ledger shape the core edit engine returns for one applied edit. */
export interface ShisoWorkingRecipeLedgerEntry<TIngredient> {
  readonly index: number;
  readonly previous: TIngredient;
}

/**
 * Folds one applied batch into the (possibly absent) working copy.
 *
 * `current` is the existing working state when it belongs to the SAME base
 * recipe, or null when this batch starts a fresh working copy.
 */
export function extendWorkingRecipe<TRecipe, TIngredient>(input: {
  readonly current: ShisoWorkingRecipeCore<TRecipe, TIngredient> | null;
  readonly base: TRecipe;
  readonly working: TRecipe;
  readonly ledger: readonly ShisoWorkingRecipeLedgerEntry<TIngredient>[];
  /** One display line per applied edit (caller bounds length). */
  readonly changeLines: readonly string[];
  /** Maximum display lines retained (oldest dropped first). */
  readonly maxChanges: number;
}): ShisoWorkingRecipeCore<TRecipe, TIngredient> {
  const history = [
    ...(input.current?.history ?? []),
    ...input.ledger.map((entry) => ({ index: entry.index, previous: entry.previous })),
  ];
  const changes = [...(input.current?.changes ?? []), ...input.changeLines].slice(-input.maxChanges);
  return Object.freeze({
    base: input.current?.base ?? input.base,
    working: input.working,
    changes: Object.freeze(changes),
    history: Object.freeze(history),
  });
}

/**
 * Restores the ingredient replaced by the LAST edit.
 *
 * The caller supplies `setIngredient`, which returns the working recipe with
 * that one ingredient index restored — the only recipe-shape knowledge this
 * module deliberately does not hold. Returns null when there is nothing to
 * undo; the caller then keeps the state untouched.
 */
export function undoLastWorkingEdit<TRecipe, TIngredient>(
  current: ShisoWorkingRecipeCore<TRecipe, TIngredient>,
  setIngredient: (
    working: TRecipe,
    index: number,
    previous: TIngredient,
  ) => TRecipe | null,
): ShisoWorkingRecipeCore<TRecipe, TIngredient> | null {
  const last = current.history[current.history.length - 1];
  if (last === undefined) return null;
  const working = setIngredient(current.working, last.index, last.previous);
  if (working === null) return null;
  return Object.freeze({
    base: current.base,
    working,
    changes: Object.freeze(current.changes.slice(0, Math.max(0, current.changes.length - 1))),
    history: Object.freeze(current.history.slice(0, current.history.length - 1)),
  });
}
