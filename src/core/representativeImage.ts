/**
 * The Kitchen Codex — Licensed Representative Recipe Image (Phase 1, pure core).
 *
 * Platform-neutral, dependency-free building blocks for the EXPLICIT
 * representative-image flow:
 *   - a CLOSED, normalized license allowlist (no NC/ND/unknown);
 *   - a deterministic, PRIVACY-HARDENED, bounded search-query builder;
 *   - candidate + provenance shapes with strict sanitization/validation.
 *
 * There is NO network I/O here and NO AI. A searched image is a REPRESENTATIVE
 * image: it may resemble the recipe but is never guaranteed to depict the exact
 * generated dish.
 */

/** The only approved public, license-aware sources in Phase 1. */
export const REPRESENTATIVE_IMAGE_SOURCES = ['openverse', 'wikimedia_commons'] as const;
export type RepresentativeImageSource = (typeof REPRESENTATIVE_IMAGE_SOURCES)[number];

/** The closed internal license allowlist (reusable for an open-source app). */
export const REPRESENTATIVE_LICENSE_IDS = ['cc0', 'public_domain', 'cc_by', 'cc_by_sa'] as const;
export type RepresentativeLicenseId = (typeof REPRESENTATIVE_LICENSE_IDS)[number];

/**
 * Canonical license families and their canonical links. A version is retained
 * ONLY when it can be safely established from the upstream value; an unknown
 * version is marked `unknown` (never invented as 4.0).
 */
export interface RepresentativeLicense {
  id: RepresentativeLicenseId;
  /** Canonical family URL (never arbitrary upstream HTML). */
  url: string;
  /** Established version (e.g. "1.0", "3.0", "4.0") or "unknown". */
  version: string;
}

const LICENSE_FAMILY_URLS: Record<RepresentativeLicenseId, string> = {
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  public_domain: 'https://creativecommons.org/publicdomain/mark/1.0/',
  cc_by: 'https://creativecommons.org/licenses/by/4.0/',
  cc_by_sa: 'https://creativecommons.org/licenses/by-sa/4.0/',
};

/**
 * Version-NEUTRAL family URLs used when the version cannot be safely
 * established. These never invent a version (no `/4.0/`).
 */
const LICENSE_NEUTRAL_URLS: Record<RepresentativeLicenseId, string> = {
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  public_domain: 'https://creativecommons.org/publicdomain/mark/1.0/',
  cc_by: 'https://creativecommons.org/licenses/by/',
  cc_by_sa: 'https://creativecommons.org/licenses/by-sa/',
};

/** Builds a canonical license with a version-aware URL (only safe versions). */
function license(id: RepresentativeLicenseId, version: string): RepresentativeLicense {
  const known = version === '1.0' || version === '2.0' || version === '2.5' || version === '3.0' || version === '4.0';
  if (id === 'cc0') return { id, url: LICENSE_FAMILY_URLS.cc0, version: '1.0' };
  if (id === 'public_domain') return { id, url: LICENSE_FAMILY_URLS.public_domain, version: 'unknown' };
  if (!known) {
    // Truthful version-neutral family link: never silently invent 4.0.
    return { id, url: LICENSE_NEUTRAL_URLS[id], version: 'unknown' };
  }
  const url = `https://creativecommons.org/licenses/${id === 'cc_by_sa' ? 'by-sa' : 'by'}/${version}/`;
  return { id, url, version };
}

/**
 * Normalizes a source-specific license string/URL into the closed allowlist, or
 * returns null for missing/unknown/ambiguous/NC/ND/unsupported licenses.
 * NC (noncommercial) and ND (no-derivatives) are rejected unconditionally.
 */
export function normalizeRepresentativeLicense(raw: unknown): RepresentativeLicense | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;

  // Accept the closed internal ids verbatim (version unknown).
  if ((REPRESENTATIVE_LICENSE_IDS as readonly string[]).includes(text)) {
    return license(text as RepresentativeLicenseId, 'unknown');
  }

  // Reject NC / ND / sampling / unknown-license markers before allowlisting.
  if (/(^|[^a-z])nc([^a-z]|$)|non-?commercial|noderiv|no-?deriv|(^|[^a-z])nd([^a-z]|$)|sampling/.test(text)) {
    return null;
  }

  const versionMatch = text.match(/(\d+(?:\.\d+)?)/);
  const version = versionMatch ? versionMatch[1] : 'unknown';

  // Public domain (mark) is distinct from CC0 (zero).
  if (/publicdomain\/mark|public domain|\bpdm\b|\bpdd\b/.test(text)) {
    return license('public_domain', 'unknown');
  }
  if (/publicdomain\/zero|\bcc0\b/.test(text)) {
    return license('cc0', '1.0');
  }
  // CC BY-SA (check BEFORE BY so "by-sa" is not misread as "by").
  if (/\bby[-\s]?sa\b|attribution[-\s]?sharealike|share-?alike/.test(text)) {
    return license('cc_by_sa', version);
  }
  // CC BY.
  if (/\bby\b|attribution/.test(text)) {
    return license('cc_by', version);
  }
  return null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

/**
 * Sanitizes an upstream metadata string: strips HTML/control characters,
 * collapses whitespace, and bounds length. Never returns markup.
 */
export function sanitizeRepresentativeText(value: unknown, max = MAX_REPRESENTATIVE_TEXT_LENGTH): string {
  if (typeof value !== 'string') return '';
  return stripHtml(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** True only for an absolute http(s) URL (no credentials, bounded length). */
export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (!url.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

/** The PUBLIC candidate shape. The browser receives NO external URL. */
export interface RepresentativeImageCandidate {
  /** Opaque server-owned candidate id (never a URL). */
  id: string;
  source: RepresentativeImageSource;
  title: string;
  /**
   * App-local thumbnail route (e.g.
   * `/api/recipes/image/representative-thumbnail/<id>`). The browser never
   * receives or renders an external thumbnail host.
   */
  thumbnailPath: string;
  /** Original source page URL (attribution link; safe http(s) only). */
  sourcePageUrl: string;
  creator?: string;
  license: RepresentativeLicenseId;
  licenseUrl: string;
  licenseVersion: string;
}

/** Server-owned stored candidate (never returned to the browser). */
export interface StoredRepresentativeCandidate {
  id: string;
  /** Server-derived requester identity this candidate belongs to. */
  requesterId: string;
  source: RepresentativeImageSource;
  title: string;
  /** EXACT external thumbnail URL (server-side only). */
  thumbnailUrl: string;
  /** EXACT external full-resolution URL (server-side only). */
  remoteUrl: string;
  sourcePageUrl: string;
  creator?: string;
  license: RepresentativeLicenseId;
  licenseUrl: string;
  licenseVersion: string;
  query: string;
  expiresAt: number;
}

export interface RepresentativeImageProvenance {
  kind: 'representative';
  provenanceVersion: 'representative_v1';
  source: RepresentativeImageSource;
  sourcePageUrl: string;
  creator?: string;
  license: RepresentativeLicenseId;
  licenseUrl: string;
  /** Canonical family version ("1.0"/"3.0"/"4.0") or "unknown". */
  licenseVersion?: string;
  /** Local vault-relative asset path (set only after a successful save). */
  localAssetPath?: string;
  /** ISO timestamp when the user selected the image. */
  selectedAt?: string;
}

/** Validates a persisted provenance object (used by parser/UI; fails closed). */
export function isRepresentativeImageProvenance(value: unknown): value is RepresentativeImageProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row['kind'] !== 'representative') return false;
  if (row['provenanceVersion'] !== 'representative_v1') return false;
  if (!REPRESENTATIVE_IMAGE_SOURCES.includes(row['source'] as RepresentativeImageSource)) return false;
  if (!REPRESENTATIVE_LICENSE_IDS.includes(row['license'] as RepresentativeLicenseId)) return false;
  if (!isSafeHttpUrl(row['sourcePageUrl'])) return false;
  if (typeof row['licenseUrl'] !== 'string' || !isSafeHttpUrl(row['licenseUrl'])) return false;
  if (row['creator'] !== undefined && typeof row['creator'] !== 'string') return false;
  if (row['licenseVersion'] !== undefined && typeof row['licenseVersion'] !== 'string') return false;
  if (row['localAssetPath'] !== undefined && typeof row['localAssetPath'] !== 'string') return false;
  if (row['selectedAt'] !== undefined && typeof row['selectedAt'] !== 'string') return false;
  return true;
}

/** The app-local thumbnail route for a candidate (never an external URL). */
export function representativeThumbnailPath(candidateId: string): string {
  return `/api/recipes/image/representative-thumbnail/${encodeURIComponent(candidateId)}`;
}

// ---------------------------------------------------------------------------
// Deterministic, privacy-hardened search-query construction
// ---------------------------------------------------------------------------

/** Bounds (shared by server + UI). */
export const MAX_REPRESENTATIVE_QUERY_LENGTH = 120;
export const MAX_REPRESENTATIVE_QUERY_INGREDIENTS = 3;
export const MAX_REPRESENTATIVE_RESULTS = 6;
export const MAX_REPRESENTATIVE_TEXT_LENGTH = 120;

const GENERIC_PANTRY = new Set([
  'salt', 'sea salt', 'kosher salt', 'fine sea salt', 'table salt', 'pepper', 'black pepper',
  'white pepper', 'water', 'oil', 'neutral oil', 'olive oil', 'vegetable oil', 'butter',
  'unsalted butter', 'salted butter', 'sugar', 'flour', 'all-purpose flour', 'all purpose flour',
  'baking powder', 'baking soda', 'yeast', 'garlic', 'onion', 'garlic powder', 'onion powder',
  'vanilla', 'vanilla extract', 'soy sauce', 'vinegar', 'salt and pepper',
]);

const PREP_WORDS = /\b(chopped|diced|minced|sliced|slivered|julienned|grated|shredded|crumbled|softened|melted|divided|halved|quartered|peeled|rinsed|drained|trimmed|fresh|freshly|ground|beaten|whisked|combined|mixed|optional|plus more|to taste|as needed|for serving|room temperature|kept cold|loose)\b/gi;
const QUANTITY_TOKENS = /\b\d+([./]\d+)?\b|\b(one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(g|kg|ml|l|oz|lb|lbs|tsp|tbsp|cup|cups|clove|cloves|slice|slices|piece|pieces|can|cans|bunch|bunches|sprig|sprigs|pinch|pinches|dash|dashes|ball|balls)\b/gi;

/** Credential/secret-shaped tokens and private identifiers (case-insensitive). */
const FORBIDDEN_TERM = /(sk-[a-z0-9_-]{6,}|api[_-]?key|apikey|authorization|bearer|token|secret|password|passwd|credential|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY)/i;
/** URLs, filesystem/vault paths, emails (whole-term rejection). */
const URL_OR_PATH = /(https?:\/\/|www\.|ftp:\/\/|file:\/\/|[a-z]:\\|\.\.\/|\/home\/|\/users\/|\/etc\/|\/var\/|\/root\/|assets\/|vault\/|\\\\)/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
/** HTML tags (rejected whole-term; wikilinks are stripped instead). */
const HTML_TAG = /<[^>]*>/;
/** Excessive identifiers/numbers in a term. */
const EXCESSIVE_DIGITS = /\d{3,}/;

/**
 * Cleans and validates ONE visual term. Returns '' when the term is unsafe or
 * non-visual (credentials, URLs, paths, emails, HTML, control chars, etc.).
 */
export function sanitizeRepresentativeTerm(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value;
  // Whole-term rejection for credentials, URLs/paths, emails, and HTML.
  if (FORBIDDEN_TERM.test(raw) || URL_OR_PATH.test(raw) || EMAIL.test(raw) || HTML_TAG.test(raw)) return '';

  let term = raw
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\([^)]*\)/g, ' ')
    .split(',')[0]
    .replace(QUANTITY_TOKENS, ' ')
    .replace(PREP_WORDS, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!term) return '';
  // Drop terms that still look like identifiers/keys/paths after cleaning.
  if (FORBIDDEN_TERM.test(term) || EMAIL.test(term) || EXCESSIVE_DIGITS.test(term)) return '';
  if (/[_@:/\\]/.test(term)) return '';
  if (/\d/.test(term)) return '';
  if (term.length > 40) return '';
  return term;
}

export interface RepresentativeImageQueryInput {
  title?: string;
  cuisine?: string;
  category?: string;
  tags?: string[];
  ingredients?: Array<string | { name?: string | null }>;
}

/**
 * Builds a deterministic, bounded, PRIVACY-HARDENED, recipe-owned search query.
 *
 * Prefers the recipe title, then cuisine/course, then up to three visually
 * distinctive primary ingredients. EXCLUDES quantities, preparation prose,
 * generic pantry items, credentials/secrets, URLs, filesystem/vault paths,
 * emails, Markdown/HTML, control characters, and vault paths. Returns '' when no
 * safe visual term remains (caller then makes ZERO external calls). Never uses
 * an AI model.
 */
export function buildRepresentativeImageQuery(input: RepresentativeImageQueryInput): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  const push = (token: string): void => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    parts.push(token);
  };

  const title = sanitizeRepresentativeTerm(input.title);
  if (title) push(title);

  const cuisine = sanitizeRepresentativeTerm(input.cuisine);
  if (cuisine && cuisine !== 'general' && !title.includes(cuisine)) push(cuisine);

  const category = sanitizeRepresentativeTerm(input.category);
  if (category && !['main course', 'main', 'dinner', 'lunch', 'course'].includes(category) && !title.includes(category)) {
    push(category);
  }

  // Tags are optional visual descriptors (never identifiers/paths).
  if (Array.isArray(input.tags)) {
    for (const tag of input.tags.slice(0, 8)) {
      const term = sanitizeRepresentativeTerm(tag);
      if (!term) continue;
      if (term.includes(' ')) continue; // tags are usually single descriptors
      if (title.includes(term)) continue;
      push(term);
      if (parts.length >= 1 + MAX_REPRESENTATIVE_QUERY_INGREDIENTS) break;
    }
  }

  const ingredientNames: string[] = [];
  if (Array.isArray(input.ingredients)) {
    for (const item of input.ingredients) {
      const raw = typeof item === 'string' ? item : item?.name;
      const name = sanitizeRepresentativeTerm(raw);
      if (!name) continue;
      if (GENERIC_PANTRY.has(name)) continue;
      if (title.includes(name)) continue;
      if (ingredientNames.includes(name)) continue;
      ingredientNames.push(name);
    }
  }
  for (const name of ingredientNames.slice(0, MAX_REPRESENTATIVE_QUERY_INGREDIENTS)) {
    push(name);
  }

  return parts.join(' ').slice(0, MAX_REPRESENTATIVE_QUERY_LENGTH).trim();
}

/** Clamps a candidate list to the bounded result count. */
export function boundRepresentativeCandidates<T>(candidates: T[]): T[] {
  return candidates.slice(0, MAX_REPRESENTATIVE_RESULTS);
}
