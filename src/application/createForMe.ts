/**
 * The Kitchen Codex — Create for Me save adaptation (v0.7 Phase 2A).
 *
 * The ONLY place a GeneratedRecipeDraft becomes a saveable `ObsidianRecipe`. It
 * is platform-neutral (application layer) and:
 *   - assigns identity/filename/path at SAVE time (the model never chooses a
 *     vault path, file id, or canonical id),
 *   - keeps invention separate from vet: provenance is namespaced
 *     (`codex_generated*`), NOT ambiguous keys like `generated`/`ai`/`source`,
 *   - never stores the generation prompt,
 *   - never adds a fake source URL / author URL / imported-from metadata,
 *   - never generates ingredient wikilinks (no auto-linking).
 *
 * Saving still routes through the EXISTING canonical serialize + vault-write path
 * (there is no second Markdown serializer or write implementation).
 */

import type { ObsidianRecipe } from '../types';
import type { VaultAdapter } from './adapters/VaultAdapter';
import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from '../schema/generatedRecipe';
import { normalizeCanonicalRecipe } from '../schema/recipeValidator';
import { canonicalToObsidianRecipe } from '../schema/legacyAdapter';
import { resolveNewRecipeVaultPath, resolveRecipeVaultPath, toVaultRelativePath } from '../core/vaultPath';
import { serializeRecipeToObsidianMarkdown } from '../utils/markdownParser';
import { saveRecipeWithVaultAdapter } from './vaultRecipe';

export interface GeneratedRecipeSaveInput {
  draft: GeneratedRecipeDraft;
  provenance: GeneratedRecipeProvenance;
  /** Timestamp applied to provenance; isolated for determinism in tests. */
  now?: () => Date;
}

/** Stable, user-facing collision message (single source for UI + tests). */
export const GENERATED_RECIPE_COLLISION_MESSAGE =
  'A recipe with that name already exists. Choose a different title before saving.';

/**
 * A local save conflict: the generated recipe's target path already exists in the
 * vault. Thrown by `saveGeneratedRecipeToVault` BEFORE any write, so the existing
 * file is never overwritten, auto-renamed, or modified. This is a local save
 * conflict, NOT an AI/provider error — it deliberately carries only the target
 * path (safe) and never a prompt, secret, provider error, or raw draft.
 */
export class GeneratedRecipePathCollisionError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(GENERATED_RECIPE_COLLISION_MESSAGE);
    this.name = 'GeneratedRecipePathCollisionError';
    this.path = path;
  }
}

/**
 * Adapts a generated draft into a saveable ObsidianRecipe. Identity/path come from
 * the application (title-derived filename at the connected vault root); provenance
 * is namespaced `codex_generated*`; the prompt is never carried into the draft.
 */
export function generatedDraftToObsidianRecipe(input: GeneratedRecipeSaveInput): ObsidianRecipe {
  const { draft } = input;
  const provenance = input.provenance;
  const now = (input.now ?? (() => new Date()))();

  const canonical = normalizeCanonicalRecipe({
    title: draft.title,
    description: draft.description,
    prepTime: draft.prepTime,
    cookTime: draft.cookTime,
    totalTime: draft.totalTime,
    servings: draft.servings,
    cuisine: draft.cuisine,
    difficulty: draft.difficulty,
    notes: draft.notes,
    ingredients: draft.ingredients.map((ing) => {
      const amount = ing.amount ?? null;
      const hasAmount = amount !== null;
      const parts = [
        hasAmount ? String(amount) : '',
        ing.unit || '',
        ing.name,
        ing.preparation || '',
      ].filter(Boolean).join(' ');
      return {
        raw: parts.trim() || ing.name,
        amount,
        amountDisplay: hasAmount ? String(amount) : undefined,
        unit: ing.unit,
        name: ing.name,
        preparation: ing.preparation,
        optional: ing.optional ? true : undefined,
      };
    }),
    instructions: draft.steps.map((step) => ({
      text: step.text,
      timerMinutes: step.timerMinutes ?? undefined,
    })),
  });

  const recipe = canonicalToObsidianRecipe(canonical);
  if (draft.tags && draft.tags.length) {
    recipe.tags = draft.tags;
  }

  // Identity/path are application-owned: a NEW generated recipe lives at the
  // connected vault root as `<SafeTitle>.md`. The model never chooses this.
  const fileName = resolveNewRecipeVaultPath(draft.title);
  recipe.fileName = fileName;
  recipe.filePath = fileName;
  // Align the canonical id with the parser's path-derived convention (the parser
  // sets `id = filePath` when a vault-relative path is present), so a generated
  // recipe's in-memory identity matches what a later scan/reparse will derive.
  recipe.id = fileName;

  // Namespaced provenance. Never `generated`/`ai`/`source`; prompt never stored.
  recipe.frontmatter = {
    ...(recipe.frontmatter || {}),
    ...(draft.course ? { course: draft.course } : {}),
    codex_generated: true,
    codex_generated_provider: provenance.providerId,
    codex_generated_model: provenance.model,
    codex_generated_at: now.toISOString(),
  };

  recipe.rawMarkdown = serializeRecipeToObsidianMarkdown(recipe);
  return recipe;
}

/**
 * Resolves the exact vault-relative save path for a generated recipe (the same
 * rule `saveRecipeWithVaultAdapter` writes to). Used so the collision check and
 * the eventual write target are guaranteed to be identical.
 */
export function resolveGeneratedRecipeSavePath(recipe: ObsidianRecipe): string {
  return resolveRecipeVaultPath(recipe);
}

/**
 * In-process, per-path async lock for generated Create-for-Me saves. Prevents two
 * overlapping saves to the SAME target path from both passing the exists() gate
 * and racing writes (the second would silently replace the first). It is entirely
 * application-local and scoped to the generated-save path — it does NOT change the
 * generic VaultAdapter, Grab Recipe, Recipe Editor, or paste-import behavior.
 *
 * TRUTHFUL SCOPE: this only serializes concurrent Create-for-Me writes inside ONE
 * app instance. It does NOT eliminate the race against another process/instance,
 * an external Obsidian writer, or a browser tab that writes directly, because the
 * VaultAdapter contract has no atomic create-if-absent primitive. That residual
 * external exists()→write TOCTOU remains a NOTE (see saveGeneratedRecipeToVault).
 */
const generatedSaveLocks = new Map<string, Promise<void>>();

/**
 * Resolves the LOCK KEY for a vault-relative save path. REUSES the canonical
 * vault-path normalization policy from `vaultPath.ts` (`toVaultRelativePath`:
 * trim, backslashes -> '/', leading '/' stripped, `''`/`.`/`..` segments
 * REJECTED) plus the `resolveRecipeVaultPath` `.md` convention, so equivalent
 * spellings of the SAME canonical file share ONE lock:
 *
 *   Recipes/Foo.md  |  /Recipes/Foo.md  |  Recipes\Foo.md  ->  Recipes/Foo.md
 *
 * UNSAFE paths (`./x`, `..`, empty segments) are NOT silently converted into a
 * valid lock key: they keep their RAW string as a distinct key (never sharing
 * the canonical key), matching vaultPath semantics exactly. Read/write targets
 * are untouched — this key is used ONLY for lock bookkeeping.
 */
function normalizedSaveLockKey(path: string): string {
  const normalized = toVaultRelativePath(path);
  if (!normalized) return path;
  const MD_EXTENSION = /\.md$/i;
  return MD_EXTENSION.test(normalized) ? normalized : `${normalized}.md`;
}

/**
 * Runs `operation` while holding a per-path lock (FIFO). Concurrent calls for the
 * SAME canonical path serialize; different paths do not block each other. The
 * lock key is NORMALIZED INSIDE this function (never trusted from the caller).
 */
export function withGeneratedSaveLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockKey = normalizedSaveLockKey(path);
  const previous = generatedSaveLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  generatedSaveLocks.set(lockKey, tail);
  const result = previous.then(() => operation());
  // The rejection is intentionally observed through the returned `guarded`
  // promise; the inner chain must not ALSO surface as an unhandled rejection
  // when the caller attaches its handler later (e.g. after awaiting something).
  const guarded = result.finally(() => {
    release();
    if (generatedSaveLocks.get(lockKey) === tail) {
      generatedSaveLocks.delete(lockKey);
    }
  });
  result.catch(() => {});
  return guarded;
}

/** Test-only: clears the in-process per-path lock map between tests. */
export function resetGeneratedSaveLocks(): void {
  generatedSaveLocks.clear();
}

/** Test-only: whether a pending lock exists for the (normalized) key. */
export function hasPendingGeneratedSaveLock(path: string): boolean {
  return generatedSaveLocks.has(normalizedSaveLockKey(path));
}

/**
 * Collision-safe, concurrency-guarded generated save. Resolves the FINAL path from
 * the (already-edited) recipe title and, INSIDE a per-path lock, refuses a write
 * when that path already exists — an overlapping second save to the same target
 * will observe the path as existing after the first completes and refuse. On a
 * free path it writes through the existing canonical serializer + vault write path.
 *
 * NOTE (external TOCTOU): this application-local lock protects only concurrent
 * Create-for-Me writes in this instance. It does not guarantee filesystem
 * atomicity against an external writer (another process/app/browser instance or an
 * external Obsidian editor) because the VaultAdapter contract has no atomic
 * create-if-absent primitive. That residual race is out of Phase 2A scope.
 */
export async function saveGeneratedRecipeToVault(
  vault: VaultAdapter,
  recipe: ObsidianRecipe
): Promise<void> {
  const path = resolveGeneratedRecipeSavePath(recipe);
  await withGeneratedSaveLock(path, async () => {
    // The exists() check MUST run inside the same per-path critical section as the
    // write so an overlapping save to this path cannot slip past the collision gate.
    if (await vault.exists(path)) {
      throw new GeneratedRecipePathCollisionError(path);
    }
    await saveRecipeWithVaultAdapter(vault, recipe);
  });
}
