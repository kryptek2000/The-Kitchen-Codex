import { syncResolveVaultAssetUrl, cleanImageReference, isImageFile } from './vaultAssets';

/**
 * The Kitchen Codex — Recipe image display helper (Phase 1).
 *
 * A repository-owned, self-contained neutral placeholder is used whenever a
 * recipe has NO explicit image. It makes ZERO third-party requests, depicts no
 * misleading specific food, and contains no scripts or external references.
 */

/**
 * Neutral, repository-owned placeholder (inline SVG data URL). A simple
 * plate-and-utensils glyph — deliberately generic, no text, no script, no
 * external reference. Used by cards, details, exports, tables, meal plans and
 * previews.
 */
export const LOCAL_RECIPE_IMAGE_PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
      '<rect width="64" height="64" fill="#1b1b1b"/>' +
      '<circle cx="32" cy="34" r="16" fill="none" stroke="#5b5b5b" stroke-width="2"/>' +
      '<circle cx="32" cy="34" r="9" fill="none" stroke="#4a4a4a" stroke-width="2"/>' +
      '<rect x="10" y="12" width="2.5" height="18" rx="1" fill="#5b5b5b"/>' +
      '<rect x="15" y="12" width="2.5" height="18" rx="1" fill="#5b5b5b"/>' +
      '<rect x="12.5" y="28" width="2.5" height="20" rx="1" fill="#5b5b5b"/>' +
      '<path d="M51 12c-3 0-4 6-4 10s1 6 4 6v18" fill="none" stroke="#5b5b5b" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg>'
  );

/** Back-compat shape: only the neutral placeholder remains (no stock photos). */
export const DEFAULT_FOOD_IMAGES: Record<string, string> = {
  default: LOCAL_RECIPE_IMAGE_PLACEHOLDER,
};

/**
 * Returns the display image for a recipe.
 *
 * TRUTHFUL BEHAVIOR (Phase 1): only an EXPLICIT recipe image (or a Markdown
 * image embed) is used. When a recipe has no image, the repository-owned local
 * placeholder is returned. This function NEVER keyword-matches the title/tags to
 * a stock photo and NEVER returns an HTTP(S) placeholder.
 */
export function getRecipeImage(recipe: {
  image?: string;
  title?: string;
  category?: string;
  cuisine?: string;
  tags?: string[];
  rawMarkdown?: string;
}): string {
  // 1. Direct explicit image or vault asset path
  if (recipe.image && typeof recipe.image === 'string') {
    const clean = cleanImageReference(recipe.image);
    if (clean && clean !== 'undefined' && clean !== 'null') {
      // If it's already an absolute URL or Blob URL, use directly
      if (
        clean.startsWith('http://') ||
        clean.startsWith('https://') ||
        clean.startsWith('data:') ||
        clean.startsWith('blob:')
      ) {
        return clean;
      }

      // Check if it resolves in the local Obsidian vault asset cache (e.g. Assets/Breakfast Burritos.jpg)
      const vaultBlobUrl = syncResolveVaultAssetUrl(clean);
      if (vaultBlobUrl) {
        return vaultBlobUrl;
      }

      // If it has an image extension or is in Assets folder, return the cleaned reference
      if (isImageFile(clean) || clean.toLowerCase().startsWith('assets/')) {
        return clean;
      }
    }
  }

  // 2. Search for markdown image embed in rawMarkdown
  if (recipe.rawMarkdown) {
    // Obsidian wikilink embed: ![[Assets/Breakfast Burritos.jpg]] or ![[Breakfast Burritos.jpg]]
    const wikilinkImgMatch = recipe.rawMarkdown.match(/!\[\[([^\]]+\.(?:jpg|jpeg|png|webp|avif|gif|svg))\]\]/i);
    if (wikilinkImgMatch && wikilinkImgMatch[1]) {
      const targetRef = cleanImageReference(wikilinkImgMatch[1]);
      const resolved = syncResolveVaultAssetUrl(targetRef);
      if (resolved) return resolved;
    }

    // Standard markdown image: ![alt](url)
    const mdImgMatch = recipe.rawMarkdown.match(/!\[.*?\]\((https?:\/\/[^\s\)]+|[^\s\)]+\.(?:jpg|jpeg|png|webp|avif|gif|svg))\)/i);
    if (mdImgMatch && mdImgMatch[1]) {
      const src = mdImgMatch[1].trim();
      if (src.startsWith('http://') || src.startsWith('https://')) {
        return src;
      }
      const resolved = syncResolveVaultAssetUrl(src);
      if (resolved) return resolved;
    }

    // HTML image: <img src="..." />
    const htmlImgMatch = recipe.rawMarkdown.match(/<img\s+[^>]*src=["']([^"']+)["']/i);
    if (htmlImgMatch && htmlImgMatch[1]) {
      const src = htmlImgMatch[1].trim();
      if (src.startsWith('http://') || src.startsWith('https://')) {
        return src;
      }
      const resolved = syncResolveVaultAssetUrl(src);
      if (resolved) return resolved;
    }
  }

  // 3. No explicit image: repository-owned local placeholder. NEVER keyword-match
  // the title/tags to a stock photo, and never return an HTTP(S) placeholder.
  return LOCAL_RECIPE_IMAGE_PLACEHOLDER;
}
