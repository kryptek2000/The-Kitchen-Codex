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
export const MAX_REPRESENTATIVE_SUGGESTIONS = 3;

/** Generic course/category tokens that add no visual value to a search. */
const GENERIC_CATEGORY = new Set(['main course', 'main', 'dinner', 'lunch', 'course', 'entree']);

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

/** Global FRAGMENT matchers for free-form search input (remove, not reject-all). */
const URL_FRAGMENT = /(?:https?:\/\/|ftp:\/\/|file:\/\/|www\.)[^\s]+/gi;
const EMAIL_FRAGMENT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const SCRIPT_OR_STYLE_ELEMENT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Quantity-like ingredient tokens (e.g. "400g", "2tbsp") and bare unit words. */
const QUANTITY_UNIT_TOKEN =
  /^\d+(?:[.,]\d+)?(?:g|kg|mg|ml|l|oz|lb|lbs|tsp|tbsp|cup|cups|clove|cloves|slice|slices|piece|pieces|can|cans|bunch|bunches|sprig|sprigs|pinch|pinches|dash|dashes)$/;
const UNIT_ONLY_TOKEN =
  /^(?:g|kg|mg|ml|l|oz|lb|lbs|tsp|tbsp|cup|cups|clove|cloves|slice|slices|piece|pieces|can|cans|bunch|bunches|sprig|sprigs|pinch|pinches|dash|dashes)$/;

/**
 * Phrase-level unsafe sequences removed BEFORE tokenization. Token-by-token
 * filtering cannot see multi-token secrets such as "BEGIN OPENSSH PRIVATE KEY".
 */
const PEM_PRIVATE_KEY_MARKER = /-----BEGIN[^-]{0,80}PRIVATE KEY-----|-----END[^-]{0,80}PRIVATE KEY-----/gi;
const BARE_KEY_FOOTER = /\bEND(?: [A-Z]+)* PRIVATE KEY\b/gi;
/** A bare (undelimited) BEGIN header is an UNTERMINATED key block: drop the rest. */
const BARE_KEY_HEADER_TO_END = /\bBEGIN(?: [A-Z]+)* PRIVATE KEY\b[\s\S]*$/gi;
const BARE_KEY_PHRASE = /\b(?:api|secret|access|private|signing|ssh)\s+key\b/gi;
/**
 * Quantity phrases recognized BEFORE punctuation stripping. Both DOT and COMMA
 * decimals are matched as a whole so the comma can never be stripped first and
 * leave a misleading short dish number (e.g. "1,5 cups" -> "1").
 */
const MIXED_NUMBER_PHRASE = /\b\d+\s+\d+\s*\/\s*\d+\b/g;
const QUANTITY_WITH_UNIT_PHRASE =
  /\b\d+(?:[.,]\d+)?\s*(?:g|kg|mg|ml|l|oz|lb|lbs|tsp|tbsp|teaspoons?|tablespoons?|cups?|cloves?|slices?|pieces?|cans?|bunch(?:es)?|sprigs?|pinch(?:es)?|dash(?:es)?|balls?)\b/gi;

/**
 * Conservative scheme-less host/domain detection. True only for bounded
 * dot-separated labels whose FINAL label is a plausible alphabetic TLD (or a
 * dotted IPv4). Applied to the RAW/decoded token before punctuation stripping so
 * a private host can never be mangled into a searchable token.
 *
 * Trailing-dot abbreviations ("St.", "U.S.", "S.O.S.") have an empty final
 * label and are NOT host-like. A dotted abbreviation without a space and with an
 * alphabetic final label (e.g. "St.Louis") is conservatively treated as host-like
 * — a documented bounded recall tradeoff that favors privacy.
 */
function isRepresentativeHostLikeToken(raw: string): boolean {
  // Ignore a port/path/query/fragment suffix for detection.
  const hostPart = raw.split(/[/?#]/, 1)[0];
  const withoutPort = hostPart.replace(/:\d{1,5}$/, '');
  if (!withoutPort.includes('.')) return false;
  // Dotted IPv4 (e.g. 192.168.1.1).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(withoutPort)) return true;
  const labels = withoutPort.split('.');
  if (labels.length < 2 || labels.length > 6) return false;
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  if (!/^[a-z]{2,}$/i.test(labels[labels.length - 1])) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

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

/**
 * Conservative singularization of ONE lowercase token. Only strips a plain
 * trailing "s" (and the common "oes" -> "o" food plural) and leaves ambiguous
 * endings ("ss"/"us"/"is"/"ies") untouched so words like "cookies" or "fries"
 * are never mangled.
 */
function singularizeRepresentativeWord(word: string): string {
  if (word.length < 4) return word;
  if (/(ss|us|is|ies)$/.test(word)) return word;
  if (/oes$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Normalizes a dish phrase word-by-word (plural -> singular where safe). */
export function normalizeRepresentativeDishPhrase(phrase: string): string {
  return phrase
    .split(/\s+/)
    .filter(Boolean)
    .map(singularizeRepresentativeWord)
    .join(' ');
}

/** Removes duplicate whitespace-separated tokens while preserving order. */
function dedupeRepresentativePhrase(phrase: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of phrase.split(/\s+/)) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.join(' ');
}

/**
 * Bounded, non-recursive percent-decoding used ONLY for DETECTION. Decodes up to
 * two passes so double-encoded schemes are still recognized. Malformed escapes
 * are left untouched and never throw.
 */
function decodeRepresentativePercentEncoding(input: string, passes = 2): string {
  let out = input;
  for (let i = 0; i < passes; i += 1) {
    const next = out.replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : match;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Conservative heuristic for a plausible base64/key-body chunk: a long
 * base64-alphabet token (>=20 chars) with at least two character classes, or any
 * very long base64-alphabet token (>=40). Short ordinary words are never
 * rejected by this rule.
 */
function isPlausibleRepresentativeKeyBody(raw: string): boolean {
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) return false;
  if (raw.length >= 40) return true;
  if (raw.length < 20) return false;
  const hasUpper = /[A-Z]/.test(raw);
  const hasLower = /[a-z]/.test(raw);
  const hasDigit = /\d/.test(raw);
  return Number(hasUpper) + Number(hasLower) + Number(hasDigit) >= 2;
}

/**
 * Removes phrase-level unsafe material from free-form text BEFORE tokenization:
 * scripts/styles, PEM private-key markers, bare key headers/footers (a bare
 * header consumes the unterminated remainder), key-like phrases, decimal and
 * mixed-number quantity phrases, URLs, emails, control characters, and tags.
 * Safe surrounding food terms are preserved.
 */
function stripRepresentativeUnsafePhrases(value: string): string {
  return value
    .replace(SCRIPT_OR_STYLE_ELEMENT, ' ')
    .replace(PEM_PRIVATE_KEY_MARKER, ' ')
    .replace(BARE_KEY_FOOTER, ' ')
    .replace(BARE_KEY_HEADER_TO_END, ' ')
    .replace(BARE_KEY_PHRASE, ' ')
    .replace(MIXED_NUMBER_PHRASE, ' ')
    .replace(QUANTITY_WITH_UNIT_PHRASE, ' ')
    .replace(URL_FRAGMENT, ' ')
    .replace(EMAIL_FRAGMENT, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/**
 * Sanitizes ONE free-form search token. Preserves MEANINGFUL dish numbers
 * ("65", "7-layer", "2-ingredient", "5-spice") while dropping quantity-like
 * ingredient noise ("400g", "1.5"), bare units, percent-encoded URL/path
 * fragments, plausible base64/key-body chunks, long numeric
 * identifiers/timestamps, and credential/path/email/URL-shaped tokens. Returns
 * '' when unsafe.
 */
function sanitizeRepresentativeSearchToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';
  if (FORBIDDEN_TERM.test(raw)) return '';
  // Plausible key material / long base64 body (checked before punctuation stripping).
  if (isPlausibleRepresentativeKeyBody(raw)) return '';
  // Scheme-less dotted host/domain (checked BEFORE punctuation stripping so
  // "evil.example" can never degrade to "evilexample").
  if (isRepresentativeHostLikeToken(raw)) return '';
  let token = raw.toLowerCase();
  // Percent-encoded URL/path fragments must not survive as mangled tokens.
  if (token.includes('%')) return '';
  // Decimal/fractional quantities must be rejected BEFORE punctuation stripping
  // so "1.5" cannot become the dish number "15".
  if (/^\d+[.,]\d+/.test(token)) return '';
  // Paths, emails, URLs, identifiers (whole-token rejection).
  if (/[_@:/\\]/.test(token)) return '';
  token = token.replace(/[^\p{L}\p{N}'-]/gu, '').replace(/^[-']+|[-']+$/g, '');
  if (!token || token.length > 40) return '';
  if (FORBIDDEN_TERM.test(token)) return '';
  // Long numeric identifiers / timestamps / phone-like values.
  if ((token.match(/\d/g) || []).length >= 5) return '';
  // Quantity-like ingredient noise and bare unit words.
  if (QUANTITY_UNIT_TOKEN.test(token) || UNIT_ONLY_TOKEN.test(token)) return '';
  if (/\p{L}/u.test(token)) return token;
  // Pure numbers: keep ONLY short meaningful dish numbers (e.g. "65", "7").
  return /^\d{1,2}$/.test(token) ? token : '';
}

/**
 * Sanitizes free-form user-submitted search terms. Removes unsafe FRAGMENTS
 * (scripts/styles, URLs, emails, control characters, markup) and unsafe tokens,
 * PRESERVES safe visual terms, dedupes, and bounds length. Returns '' when no
 * meaningful alphanumeric term remains (caller then makes ZERO external calls).
 * Client sanitization is never authority — the server always re-runs this.
 */
export function sanitizeRepresentativeSearchTerms(
  value: unknown,
  max: number = MAX_REPRESENTATIVE_QUERY_LENGTH
): string {
  if (typeof value !== 'string') return '';
  const text = stripRepresentativeUnsafePhrases(value);
  const tokens: string[] = [];
  for (const rawToken of text.split(/\s+/)) {
    if (!rawToken) continue;
    if (rawToken.includes('%')) {
      // Percent-encoded URL/path fragment: drop the whole token. If it is NOT a
      // URL/path, use the bounded decoded form so an encoded space separates.
      const decoded = decodeRepresentativePercentEncoding(rawToken);
      if (URL_OR_PATH.test(decoded) || /^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) continue;
      for (const sub of decoded.split(/\s+/)) {
        const clean = sanitizeRepresentativeSearchToken(sub);
        if (clean) tokens.push(clean);
      }
      continue;
    }
    const clean = sanitizeRepresentativeSearchToken(rawToken);
    if (clean) tokens.push(clean);
  }
  const deduped = dedupeRepresentativePhrase(tokens.join(' '));
  // Require at least one meaningful alphanumeric token.
  if (!/[\p{L}\p{N}]/u.test(deduped)) return '';
  return deduped.slice(0, max).trim();
}

/**
 * Sanitizes a recipe TITLE while PRESERVING meaningful dish numbers (e.g.
 * "Chicken 65", "7-Layer Dip", "2-Ingredient Bread"). Strips markup/URLs/
 * emails/paths, parentheses, prep prose, and quantity-unit noise; unsafe-only
 * titles return ''. Used by the deterministic query + suggestion builders.
 */
export function sanitizeRepresentativeDishTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = stripRepresentativeUnsafePhrases(value)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\([^)]*\)/g, ' ')
    .split(',')[0]
    .replace(PREP_WORDS, ' ');
  const tokens = text
    .split(/\s+/)
    .map((token) => sanitizeRepresentativeSearchToken(token))
    .filter(Boolean);
  return dedupeRepresentativePhrase(tokens.join(' '));
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
  const title = sanitizeRepresentativeDishTitle(input.title);
  const titlePhrase = title ? normalizeRepresentativeDishPhrase(title) : '';
  const parts: string[] = [];

  if (titlePhrase) parts.push(titlePhrase);

  // A multi-word title already carries a strong dish identity (e.g. "blue
  // cheese smashburger"): do NOT append cuisine, tags, or every ingredient.
  const strongDishIdentity = titlePhrase.split(' ').filter(Boolean).length >= 2;

  if (!strongDishIdentity) {
    // Cuisine/category ONLY when visually useful, and at most one of them.
    for (const raw of [input.cuisine, input.category]) {
      const term = sanitizeRepresentativeTerm(raw);
      if (!term || term === 'general') continue;
      if (GENERIC_CATEGORY.has(term)) continue;
      if (titlePhrase.includes(term)) continue;
      parts.push(term);
      break;
    }
    // At most ONE distinctive visual ingredient.
    if (Array.isArray(input.ingredients)) {
      for (const item of input.ingredients) {
        const raw = typeof item === 'string' ? item : item?.name;
        const name = sanitizeRepresentativeTerm(raw);
        if (!name) continue;
        const normalized = normalizeRepresentativeDishPhrase(name);
        if (GENERIC_PANTRY.has(name) || GENERIC_PANTRY.has(normalized)) continue;
        if (titlePhrase.includes(normalized)) continue;
        parts.push(normalized);
        break;
      }
    }
  }

  return dedupeRepresentativePhrase(parts.join(' ')).slice(0, MAX_REPRESENTATIVE_QUERY_LENGTH).trim();
}

// ---------------------------------------------------------------------------
// Deterministic, privacy-sanitized broader search suggestions (no AI)
// ---------------------------------------------------------------------------

/** Common dish "family" head nouns used to broaden a search deterministically. */
const DISH_FAMILY_ROOTS = [
  'burger', 'sandwich', 'taco', 'pizza', 'salad', 'soup', 'pasta', 'noodle',
  'curry', 'stew', 'chili', 'cake', 'cookie', 'pie', 'bread', 'rice', 'bowl', 'wrap',
];

/** A deterministic generic fallback term per dish family (never AI-authored). */
const DISH_FAMILY_SUGGESTION: Record<string, string> = {
  burger: 'cheeseburger',
  taco: 'tacos',
  sandwich: 'sandwich',
  pizza: 'pizza',
  salad: 'salad',
  soup: 'soup',
  pasta: 'pasta',
  noodle: 'noodles',
  curry: 'curry',
  stew: 'stew',
  chili: 'chili',
  cake: 'cake',
  cookie: 'cookies',
  pie: 'pie',
  bread: 'bread',
  rice: 'rice',
  bowl: 'bowl',
  wrap: 'wrap',
};

/** Finds the trailing dish-family head noun in a phrase, if any. */
function findDishFamily(words: string[]): { root: string; head: string; index: number } | null {
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    for (const root of DISH_FAMILY_ROOTS) {
      if (word === root || word === `${root}s` || word.endsWith(root) || word.endsWith(`${root}s`)) {
        return { root, head: word, index: i };
      }
    }
  }
  return null;
}

/**
 * Builds up to MAX_REPRESENTATIVE_SUGGESTIONS deterministic, privacy-sanitized
 * broader search terms from recipe-owned text. Suggestions are DISPLAY-ONLY:
 * the caller must never search them automatically. No AI, no network.
 */
export function buildRepresentativeImageSuggestions(input: RepresentativeImageQueryInput): string[] {
  const title = sanitizeRepresentativeDishTitle(input.title);
  if (!title) return [];
  const words = normalizeRepresentativeDishPhrase(title).split(' ').filter(Boolean);
  if (words.length === 0) return [];

  const out: string[] = [];
  const push = (candidate: string): void => {
    const clean = sanitizeRepresentativeSearchTerms(candidate);
    if (!clean || out.includes(clean) || out.length >= MAX_REPRESENTATIVE_SUGGESTIONS) return;
    out.push(clean);
  };

  const family = findDishFamily(words);
  // 1. Broaden the dish head noun to its family root (smashburger -> burger).
  if (family && family.head !== family.root) {
    const broadened = [...words.slice(0, family.index), family.root, ...words.slice(family.index + 1)].join(' ');
    push(broadened);
  }
  // 2. The dish head noun alone.
  if (words.length > 1) push(words[words.length - 1]);
  // 3. A deterministic generic family term.
  if (family) push(DISH_FAMILY_SUGGESTION[family.root] ?? family.root);

  return out.slice(0, MAX_REPRESENTATIVE_SUGGESTIONS);
}

/** Clamps a candidate list to the bounded result count. */
export function boundRepresentativeCandidates<T>(candidates: T[]): T[] {
  return candidates.slice(0, MAX_REPRESENTATIVE_RESULTS);
}
