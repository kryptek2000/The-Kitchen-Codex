/**
 * The Kitchen Codex — stable recipe-detail route.
 *
 * PURE, platform-neutral. The recipe detail view is recoverable from the
 * browser location so a hard refresh restores the SAME recipe instead of
 * falling back to the gallery. The route encodes the canonical recipe
 * identifier (`ObsidianRecipe.id`, which is the vault file path or a stable
 * filename slug) — never a transient React state value and never a raw
 * filesystem path exposed for its own sake (it is percent-encoded and travels
 * in the fragment, which is not sent to any server).
 *
 * Route grammar:
 *   #/                 gallery
 *   #/recipe/<id>      recipe detail for the encoded canonical id
 */

export type ParsedRecipeRoute =
  | { readonly kind: 'recipe'; readonly id: string }
  | { readonly kind: 'gallery' };

const RECIPE_PREFIX = '#/recipe/';
const GALLERY_HASH = '#/';

/** Builds the fragment for one recipe detail route. */
export function buildRecipeRoute(id: string): string {
  return `${RECIPE_PREFIX}${encodeURIComponent(String(id))}`;
}

/** Builds the gallery fragment. */
export function buildGalleryRoute(): string {
  return GALLERY_HASH;
}

/**
 * Parses a location hash into a closed route. Anything that is not a
 * well-formed recipe route is the gallery route (never throws, never opens a
 * different recipe).
 */
export function parseRecipeRoute(hash: unknown): ParsedRecipeRoute {
  const raw = typeof hash === 'string' ? hash : '';
  if (!raw.startsWith(RECIPE_PREFIX)) return { kind: 'gallery' };
  const encoded = raw.slice(RECIPE_PREFIX.length);
  if (encoded.length === 0) return { kind: 'gallery' };
  let id: string;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    return { kind: 'gallery' };
  }
  if (id.length === 0) return { kind: 'gallery' };
  return { kind: 'recipe', id };
}
