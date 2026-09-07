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
 * Canonicalizes an arbitrary vault path into ONE vault-root-relative form.
 *
 * This is the SINGLE ingestion/path helper for the entire product. Every path
 * that enters the app (directory scans, upload/drop ingestion) is normalized to
 * the same convention the `VaultAdapter` contract expects:
 *
 *   - backslashes -> '/'
 *   - leading '/' stripped
 *   - `''` / `.` / `..` segments rejected (returns `''`, the caller decides how
 *     to treat an unsafe path — typically by skipping the file)
 *   - UNREPEATED root prefix stripping: when `rootName` is supplied and it equals
 *     the FIRST segment, EXACTLY ONE leading root segment is removed. A root name
 *     appearing more than once is only stripped once.
 *   - already-relative paths (no matching root prefix) pass through unchanged
 *   - Unicode, internal spaces, root-level files, and non-`.md` extensions are
 *     preserved; no URL decoding, no basename collapse.
 *
 * It is PURE (no filesystem/handle/window/browser API) so it is usable from the
 * browser scans, upload/drop ingestion, and any future surface. Callers NEVER
 * duplicate this policy (no hand-rolled string slicing in App.tsx / the adapter /
 * resolveRecipeVaultPath).
 */
export function toVaultRelativePath(raw: string, rootName?: string): string {
  if (typeof raw !== 'string') return '';
  const normalized = normalizeVaultPath(raw);
  if (!isSafeRelativePath(normalized)) return '';

  let segments = normalized.split('/');
  const root = typeof rootName === 'string' ? normalizeVaultPath(rootName) : '';
  // Strip at most ONE leading root segment, and only when there is more than one
  // segment remaining (otherwise we would collapse a legitimate 1-segment path).
  if (root && segments.length > 1 && segments[0] === root) {
    segments = segments.slice(1);
  }

  return segments.join('/');
}

/**
 * Resolves the canonical vault-relative persistence path for a recipe.
 *
 * Precedence (protects existing paths; drives new-recipe placement at the
 * connected vault root):
 *  1. an existing `filePath` (vault-relative) is authoritative and returned as-is;
 *  2. otherwise the `fileName` basename is used if present;
 *  3. otherwise a root-relative `<SafeTitle>.md` path is derived (a genuinely
 *     pathless recipe is a NEW recipe, so it belongs at the connected root).
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
  return name;
}

/**
 * Resolves the default filePath for a BRAND-NEW recipe (grabbed, pasted, or
 * created in the editor) to a single root-relative file within the connected
 * vault root: `<SafeFileName>.md`.
 *
 * The concrete VaultAdapter root already represents the directory the user chose.
 * A new recipe must therefore default to that root — NEVER a nested folder. This
 * replaces the former per-producer hardcoded paths (`Food/Recipes/…`,
 * `Recipes/…`, `6 - Full Notes/Food/Recipes/…`) which, now that the adapter
 * honors full filePath, were silently creating nested directories in the vault.
 *
 * Pure, no filesystem/handle/window dependency.
 */
export function resolveNewRecipeVaultPath(nameOrTitle: string): string {
  const leaf = String(nameOrTitle ?? '').trim().split(/[\/\\]/).pop() || '';
  const safe = leaf.replace(/\.md$/i, '').replace(/[\/\\?%*:|"<>]/g, '-').trim();
  return `${safe || 'recipe'}.md`;
}
