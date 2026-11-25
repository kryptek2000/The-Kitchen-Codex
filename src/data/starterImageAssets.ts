/**
 * Canonical app-owned Starter image manifest.
 *
 * This is the single allowlist authority shared by the client image resolver,
 * image health, and the production static-file boundary. Only these exact
 * same-origin paths may be treated as app-owned images.
 */
export const STARTER_IMAGE_ASSETS = Object.freeze([
  {
    starterId: 'signature-artisan-sourdough-boule',
    fileName: 'artisan-sourdough-boule.jpg',
    path: '/app-images/starter/artisan-sourdough-boule.jpg',
  },
  {
    starterId: 'signature-thai-green-coconut-curry',
    fileName: 'thai-green-coconut-curry.jpg',
    path: '/app-images/starter/thai-green-coconut-curry.jpg',
  },
  {
    starterId: 'signature-tonkotsu-shoyu-ramen',
    fileName: 'tonkotsu-shoyu-ramen.jpg',
    path: '/app-images/starter/tonkotsu-shoyu-ramen.jpg',
  },
  {
    starterId: 'signature-classic-roman-carbonara',
    fileName: 'classic-roman-carbonara.jpg',
    path: '/app-images/starter/classic-roman-carbonara.jpg',
  },
  {
    starterId: 'signature-pan-seared-lemon-herb-salmon',
    fileName: 'pan-seared-lemon-herb-salmon.jpg',
    path: '/app-images/starter/pan-seared-lemon-herb-salmon.jpg',
  },
  {
    starterId: 'signature-avocado-green-goddess-quinoa-salad',
    fileName: 'avocado-green-goddess-quinoa-salad.jpg',
    path: '/app-images/starter/avocado-green-goddess-quinoa-salad.jpg',
  },
  {
    starterId: 'signature-lemon-ricotta-pancakes-blueberry-compote',
    fileName: 'lemon-ricotta-pancakes.jpg',
    path: '/app-images/starter/lemon-ricotta-pancakes.jpg',
  },
  {
    starterId: 'signature-smoky-chicken-tinga-tacos',
    fileName: 'smoky-chicken-tinga-tacos.jpg',
    path: '/app-images/starter/smoky-chicken-tinga-tacos.jpg',
  },
  {
    starterId: 'signature-dark-chocolate-espresso-lava-cakes',
    fileName: 'dark-chocolate-espresso-lava-cakes.jpg',
    path: '/app-images/starter/dark-chocolate-espresso-lava-cakes.jpg',
  },
] as const);

export type StarterImageStarterId = (typeof STARTER_IMAGE_ASSETS)[number]['starterId'];

export const STARTER_IMAGE_PATHS: Readonly<Record<StarterImageStarterId, string>> = Object.freeze(
  Object.fromEntries(STARTER_IMAGE_ASSETS.map((asset) => [asset.starterId, asset.path])) as Record<
    StarterImageStarterId,
    string
  >
);

export const STARTER_IMAGE_PATH_LIST: readonly string[] = Object.freeze(
  STARTER_IMAGE_ASSETS.map((asset) => asset.path)
);

const APPROVED_STARTER_IMAGE_PATHS = new Set<string>(STARTER_IMAGE_PATH_LIST);

/** True for the app-image namespace even when the exact path is not approved. */
export function isAppImagesNamespaceRef(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('/app-images/') || trimmed.startsWith('app-images/');
}

/**
 * True only for one exact, canonical Starter image path.
 *
 * Deliberately rejects whitespace, backslashes, percent encodings, query
 * strings, fragments, traversal aliases, unknown filenames, non-image files,
 * and any path that changes under WHATWG URL normalization. Set membership is
 * the final authority; a trusted prefix alone is never sufficient.
 */
export function isApprovedStarterImagePath(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  if (!value.startsWith('/app-images/starter/')) return false;
  if (/[\\%?#]/.test(value)) return false;
  if (!APPROVED_STARTER_IMAGE_PATHS.has(value)) return false;
  try {
    return new URL(value, 'http://127.0.0.1').pathname === value;
  } catch {
    return false;
  }
}
