/**
 * The Kitchen Codex — Vault Path Policy (Phase 4C3A).
 *
 * Establishes ONE invariant: the logical location of an EXISTING recipe is owned
 * by its vault-relative `filePath`, NOT by `fileName` (basename) and NOT by an
 * optional browser `fileHandle`.
 *
 * Why: the legacy save path falls back to `recipe.fileName` at the vault ROOT when
 * no `fileHandle` is present, which would silently re-root a nested recipe
 * (e.g. `Recipes/Italian/Lasagna.md` -> `Lasagna.md`). A future platform adapter
 * cutover must preserve subfolder locations through `filePath`.
 *
 * This helper is PURE (no filesystem/handle/window). It is NOT wired into the live
 * save path yet (that is the runtime cutover); it formalizes + tests the invariant.
 * It never silently replaces an existing nested `filePath` with a basename.
 */

import type { ObsidianRecipe } from '../types';

const MD_EXTENSION = /\.md$/i;

/** Normalizes a path to a clean, vault-relative form (no leading slash, forward slashes). */
function normalizeVaultPath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

/** True when the path has no empty / `.` / `..` segments (never escapes the vault). */
function isSafeRelativePath(path: string): boolean {
  if (!path) return false;
  return !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

/**
 * Resolves the canonical vault-relative persistence path for a recipe.
 *
 * Precedence (matches current new-recipe semantics but protects existing paths):
 *  1. an existing `filePath` (vault-relative) is authoritative and returned as-is;
 *  2. otherwise the `fileName` basename is used if present;
 *  3. otherwise a fresh `Recipes/<SafeTitle>.md` path is derived.
 *
 * The return is always a clean vault-relative path ending in `.md`. It never turns
 * an existing nested `filePath` into a root basename.
 */
export function resolveRecipeVaultPath(recipe: ObsidianRecipe): string {
  const candidate = (recipe.filePath || recipe.fileName || '').trim();
  if (candidate) {
    const normalized = normalizeVaultPath(candidate);
    if (isSafeRelativePath(normalized)) {
      return MD_EXTENSION.test(normalized) ? normalized : `${normalized}.md`;
    }
  }

  const safeTitle = (recipe.title || recipe.fileName || 'Untitled Recipe')
    .replace(MD_EXTENSION, '')
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .trim();
  const name = `${safeTitle || 'recipe'}.md`;
  return `Recipes/${name}`;
}
